import type {
	ComAtprotoLabelDefs,
	ComAtprotoLabelQueryLabels,
	ToolsOzoneModerationDefs,
	ToolsOzoneModerationEmitEvent,
} from "@atproto/api";
import { type Keypair, Secp256k1Keypair } from "@atproto/crypto";
import { IdResolver } from "@atproto/identity";
import {
	AuthRequiredError,
	ErrorFrame,
	InvalidRequestError,
	MessageFrame,
	parseReqNsid,
	verifyJwt,
	XRPCError,
} from "@atproto/xrpc-server";
import { fastifyWebsocket } from "@fastify/websocket";
import Database, { type Database as SQLiteDatabase } from "better-sqlite3";
import fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { fromString as ui8FromString } from "uint8arrays";
import type { WebSocket } from "ws";
import { formatLabel, labelIsSigned, signLabel } from "./util/labels.js";
import type {
	CreateLabelData,
	ProcedureHandler,
	QueryHandler,
	SavedLabel,
	SubscriptionHandler,
} from "./util/types.js";
import { excludeNullish } from "./util/util.js";

/**
 * Options for the {@link LabelerServer} class.
 */
export interface LabelerOptions {
	/** The DID of the labeler account. */
	did: string;

	/**
	 * The private signing key used for the labeler.
	 * If you don't have a key, generate and set one using {@link plcSetupLabeler}.
	 */
	signingKey: string;

	/**
	 * A function that returns whether a DID is authorized to create labels.
	 * By default, only the labeler account is authorized.
	 * @param did The DID to check.
	 */
	auth?: (did: string) => boolean | Promise<boolean>;
	/**
	 * The path to the SQLite `.db` database file.
	 * @default labels.db
	 */
	dbPath?: string;
}

export class LabelerServer {
	/** The Fastify application instance. */
	app: FastifyInstance;

	/** The SQLite database instance. */
	db: SQLiteDatabase;

	/** The DID of the labeler account. */
	did: string;

	/** A function that returns whether a DID is authorized to create labels. */
	private auth: (did: string) => boolean | Promise<boolean>;

	/** The signing key used for the labeler. */
	private signingKey: Keypair;

	/** The ID resolver instance. */
	private idResolver = new IdResolver();

	/** Open WebSocket connections, mapped by request NSID. */
	private connections = new Map<string, Set<WebSocket>>();

	/**
	 * Create a labeler server.
	 * @param options Configuration options.
	 */
	constructor(options: LabelerOptions) {
		this.did = options.did;
		this.signingKey = new Secp256k1Keypair(ui8FromString(options.signingKey, "hex"), false);
		this.auth = options.auth ?? ((did) => did === this.did);

		this.db = new Database(options.dbPath ?? "labels.db");
		this.db.pragma("journal_mode = WAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS labels (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				src TEXT NOT NULL,
				uri TEXT NOT NULL,
				cid TEXT,
				val TEXT NOT NULL,
				neg BOOLEAN DEFAULT FALSE,
				cts DATETIME NOT NULL,
				exp DATETIME,
				sig BLOB
			);
		`);

		this.app = fastify();
		void this.app.register(fastifyWebsocket).then(() => {
			this.app.get("/xrpc/com.atproto.label.queryLabels", this.queryLabelsHandler);
			this.app.post("/xrpc/tools.ozone.moderation.emitEvent", this.emitEventHandler);
			this.app.get(
				"/xrpc/com.atproto.label.subscribeLabels",
				{ websocket: true },
				this.subscribeLabelsHandler,
			);
			this.app.get("/xrpc/*", this.unknownMethodHandler);
		});
	}

	/**
	 * Start the server.
	 * @param port The port to listen on.
	 * @param callback A callback to run when the server is started.
	 */
	start(port: number, callback: (error: Error | null, address: string) => void = () => {}) {
		this.app.listen({ port }, callback);
	}

	/**
	 * Stop the server.
	 * @param callback A callback to run when the server is stopped.
	 */
	stop(callback: () => void = () => {}) {
		this.app.close(callback);
	}

	/**
	 * Insert a label into the database, emitting it to subscribers.
	 * @param label The label to insert.
	 * @returns The inserted label.
	 */
	private async saveLabel(label: ComAtprotoLabelDefs.Label): Promise<SavedLabel> {
		const signed = labelIsSigned(label) ? label : await signLabel(label, this.signingKey);

		const stmt = this.db.prepare(`
			INSERT INTO labels (src, uri, cid, val, neg, cts, exp, sig)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const { src, uri, cid, val, neg, cts, exp, sig } = signed;
		const result = stmt.run(src, uri, cid, val, neg ? 1 : 0, cts, exp, sig);
		if (!result.changes) throw new Error("Failed to insert label");

		const id = Number(result.lastInsertRowid);

		this.emitLabel(id, signed);
		return { id, ...signed };
	}

	/**
	 * Create and insert a label into the database, emitting it to subscribers.
	 * @param label The label to create.
	 * @returns The created label.
	 */
	async createLabel(label: CreateLabelData): Promise<SavedLabel> {
		return this.saveLabel(
			excludeNullish({
				...label,
				src: label.src ?? this.did,
				cts: label.cts ?? new Date().toISOString(),
			}),
		);
	}

	/**
	 * Create and insert labels into the database, emitting them to subscribers.
	 * @param subject The subject of the labels.
	 * @param labels The labels to create.
	 * @returns The created labels.
	 */
	async createLabels(
		subject: { uri: string; cid?: string | undefined },
		labels: { create?: Array<string>; negate?: Array<string> },
	): Promise<Array<SavedLabel>> {
		const { uri, cid } = subject;
		const { create, negate } = labels;

		const createdLabels: Array<SavedLabel> = [];
		if (create) {
			for (const val of create) {
				const created = await this.createLabel({ uri, cid, val });
				createdLabels.push(created);
			}
		}
		if (negate) {
			for (const val of negate) {
				const negated = await this.createLabel({ uri, cid, val, neg: true });
				createdLabels.push(negated);
			}
		}
		return createdLabels;
	}

	/**
	 * Emit a label to all subscribers.
	 * @param seq The label's id.
	 * @param label The label to emit.
	 */
	private emitLabel(seq: number, label: ComAtprotoLabelDefs.Label) {
		const frame = new MessageFrame({ seq, labels: [formatLabel(label)] }, { type: "#labels" });
		this.connections.get("com.atproto.label.subscribeLabels")?.forEach((ws) => {
			ws.send(frame.toBytes());
		});
	}

	/**
	 * Parse a user DID from an Authorization header JWT.
	 * @param req The Express request object.
	 */
	private async parseAuthHeaderDid(req: FastifyRequest): Promise<string> {
		const authHeader = req.headers.authorization;
		if (!authHeader) throw new AuthRequiredError("Authorization header is required");

		const [type, token] = authHeader.split(" ");
		if (type !== "Bearer" || !token) {
			throw new InvalidRequestError("Missing or invalid bearer token", "MissingJwt");
		}

		const payload = await verifyJwt(
			token,
			this.did,
			parseReqNsid(req),
			async (did, forceRefresh) =>
				(await this.idResolver.did.resolveAtprotoData(did, forceRefresh)).signingKey,
		);

		return payload.iss;
	}

	/**
	 * Handler for [com.atproto.label.queryLabels](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/queryLabels.json).
	 */
	queryLabelsHandler: QueryHandler<
		{
			uriPatterns?: string | Array<string>;
			sources?: string | Array<string>;
			limit?: string;
			cursor?: string;
		}
	> = async (req, res) => {
		try {
			let uriPatterns: Array<string>;
			if (!req.query.uriPatterns) {
				uriPatterns = [];
			} else if (typeof req.query.uriPatterns === "string") {
				uriPatterns = [req.query.uriPatterns];
			} else {
				uriPatterns = req.query.uriPatterns || [];
			}

			let sources: Array<string>;
			if (!req.query.sources) {
				sources = [];
			} else if (typeof req.query.sources === "string") {
				sources = [req.query.sources];
			} else {
				sources = req.query.sources || [];
			}

			const cursor = parseInt(req.query.cursor || "0", 10);
			if (cursor !== undefined && Number.isNaN(cursor)) {
				throw new InvalidRequestError("Cursor must be an integer");
			}

			const limit = parseInt(req.query.limit || "50", 10);
			if (Number.isNaN(limit) || limit < 1 || limit > 250) {
				throw new InvalidRequestError("Limit must be an integer between 1 and 250");
			}

			const patterns = uriPatterns.includes("*") ? [] : uriPatterns.map((pattern) => {
				pattern = pattern.replaceAll(/%/g, "").replaceAll(/_/g, "\\_");

				const starIndex = pattern.indexOf("*");
				if (starIndex === -1) return pattern;

				if (starIndex !== pattern.length - 1) {
					throw new InvalidRequestError(
						"Only trailing wildcards are supported in uriPatterns",
					);
				}
				return pattern.slice(0, -1) + "%";
			});

			const stmt = this.db.prepare<unknown[], SavedLabel>(`
			SELECT * FROM labels
			WHERE 1 = 1
			${patterns.length ? "AND " + patterns.map(() => "uri LIKE ?").join(" OR ") : ""}
			${sources.length ? `AND src IN (${sources.map(() => "?").join(", ")})` : ""}
			${cursor ? "AND id > ?" : ""}
			ORDER BY id ASC
			LIMIT ?
		`);

			const params = [];
			if (patterns.length) params.push(...patterns);
			if (sources.length) params.push(...sources);
			if (cursor) params.push(cursor);
			params.push(limit);

			const rows = stmt.all(params);
			const labels = rows.map(formatLabel);

			const nextCursor = rows[rows.length - 1]?.id?.toString(10) || "0";

			await res.send(
				{ cursor: nextCursor, labels } satisfies ComAtprotoLabelQueryLabels.OutputSchema,
			);
		} catch (e) {
			if (e instanceof XRPCError) {
				await res.status(e.type).send(e.payload);
			} else {
				console.error(e);
				await res.status(500).send({
					error: "InternalServerError",
					message: "An unknown error occurred",
				});
			}
		}
	};

	/**
	 * Handler for [com.atproto.label.subscribeLabels](https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/label/subscribeLabels.json).
	 */
	subscribeLabelsHandler: SubscriptionHandler<{ cursor?: string }> = (ws, req) => {
		const cursor = parseInt(req.query.cursor ?? "NaN", 10);

		if (!Number.isNaN(cursor)) {
			const latest = this.db.prepare(`
				SELECT MAX(id) AS id FROM labels
			`).get() as { id: number };
			if (cursor > (latest.id ?? 0)) {
				const errorFrame = new ErrorFrame({
					error: "FutureCursor",
					message: "Cursor is in the future",
				});
				ws.send(errorFrame.toBytes());
				ws.terminate();
			}

			const stmt = this.db.prepare<[number], ComAtprotoLabelDefs.Label>(`
				SELECT * FROM labels
				WHERE id > ?
				ORDER BY id ASC
			`);

			try {
				for (const row of stmt.iterate(cursor)) {
					const { id: seq, ...label } = row;
					const frame = new MessageFrame({ seq, labels: [formatLabel(label)] }, {
						type: "#labels",
					});
					ws.send(frame.toBytes());
				}
			} catch (e) {
				console.error(e);
				const errorFrame = new ErrorFrame({
					error: "InternalServerError",
					message: "An unknown error occurred",
				});
				ws.send(errorFrame.toBytes());
				ws.terminate();
			}
		}

		this.addSubscription("com.atproto.label.subscribeLabels", ws);

		ws.on("close", () => {
			this.removeSubscription("com.atproto.label.subscribeLabels", ws);
		});
	};

	/**
	 * Handler for [tools.ozone.moderation.emitEvent](https://github.com/bluesky-social/atproto/blob/main/lexicons/tools/ozone/moderation/emitEvent.json).
	 */
	emitEventHandler: ProcedureHandler<ToolsOzoneModerationEmitEvent.InputSchema> = async (
		req,
		res,
	) => {
		try {
			const actorDid = await this.parseAuthHeaderDid(req);
			const authed = await this.auth(actorDid);
			if (!authed) {
				throw new AuthRequiredError("Unauthorized");
			}

			const { event, subject, subjectBlobCids = [], createdBy } = req.body;
			if (!event || !subject || !createdBy) {
				throw new InvalidRequestError("Missing required field(s)");
			}

			if (event.$type !== "tools.ozone.moderation.defs#modEventLabel") {
				throw new InvalidRequestError("Unsupported event type");
			}
			const labelEvent = event as ToolsOzoneModerationDefs.ModEventLabel;

			if (!labelEvent.createLabelVals?.length && !labelEvent.negateLabelVals?.length) {
				throw new InvalidRequestError("Must provide at least one label value");
			}

			const uri =
				subject.$type === "com.atproto.admin.defs#repoRef"
					&& typeof subject.did === "string"
					? subject.did
					: (subject.$type === "com.atproto.repo.strongRef#main"
							|| subject.$type === "com.atproto.repo.strongRef")
							&& typeof subject.uri === "string"
					? subject.uri
					: null;
			const cid =
				subject.$type === "com.atproto.admin.defs#repoRef"
					&& typeof subject.cid === "string"
					? subject.cid
					: undefined;

			if (!uri) {
				throw new InvalidRequestError("Invalid subject");
			}

			const labels = await this.createLabels({ uri, cid }, {
				create: labelEvent.createLabelVals,
				negate: labelEvent.negateLabelVals,
			});

			if (!labels.length || !labels[0]?.id) {
				throw new Error(
					`No labels were created\nEvent:\n${JSON.stringify(labelEvent, null, 2)}`,
				);
			}

			await res.send(
				{
					id: labels[0].id,
					event: labelEvent,
					subject,
					subjectBlobCids,
					createdBy,
					createdAt: new Date().toISOString(),
				} satisfies ToolsOzoneModerationEmitEvent.OutputSchema,
			);
		} catch (e) {
			if (e instanceof XRPCError) {
				await res.status(e.type).send(e.payload);
			} else {
				console.error(e);
				await res.status(500).send({
					error: "InternalServerError",
					message: "An unknown error occurred",
				});
			}
		}
	};

	/**
	 * Catch-all handler for unknown XRPC methods.
	 */
	unknownMethodHandler: QueryHandler = async (_req, res) =>
		res.send({ error: "MethodNotImplemented", message: "Method Not Implemented" });

	/**
	 * Add a WebSocket connection to the list of subscribers for a given lexicon.
	 * @param nsid The NSID of the lexicon to subscribe to.
	 * @param ws The WebSocket connection to add.
	 */
	private addSubscription(nsid: string, ws: WebSocket) {
		const subs = this.connections.get(nsid) ?? new Set();
		subs.add(ws);
		this.connections.set(nsid, subs);
	}

	/**
	 * Remove a WebSocket connection from the list of subscribers for a given lexicon.
	 * @param nsid The NSID of the lexicon to unsubscribe from.
	 * @param ws The WebSocket connection to remove.
	 */
	private removeSubscription(nsid: string, ws: WebSocket) {
		const subs = this.connections.get(nsid);
		if (subs) {
			subs.delete(ws);
			if (!subs.size) this.connections.delete(nsid);
		}
	}
}
