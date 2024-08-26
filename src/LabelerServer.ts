import {
	ComAtprotoLabelDefs,
	ToolsOzoneModerationDefs,
	ToolsOzoneModerationEmitEvent,
} from "@atproto/api";
import { Keypair, Secp256k1Keypair } from "@atproto/crypto";
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
import Database, { type Database as SQLiteDatabase } from "better-sqlite3";
import express, { type RequestHandler } from "express";
import expressWs, { type Application, WebsocketRequestHandler } from "express-ws";
import { Server } from "node:http";
import { fromString as ui8FromString } from "uint8arrays";
import type { WebSocket } from "ws";
import { formatLabel, labelIsSigned, signLabel } from "./util/labels.js";
import { SignedLabel } from "./util/types.js";

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
	/** The Express application instance. */
	app: Application;

	/** The HTTP server instance. */
	server?: Server;

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
				cid TEXT NOT NULL,
				val TEXT NOT NULL,
				neg BOOLEAN NOT NULL,
				cts DATETIME NOT NULL,
				exp DATETIME,
				sig BLOB
			);
		`);

		this.app = expressWs(express().use(express.json())).app;
		this.app.get("/xrpc/com.atproto.label.queryLabels", this.queryLabelsHandler);
		this.app.ws("/xrpc/com.atproto.label.subscribeLabels", this.subscribeLabelsHandler);
		this.app.post("/xrpc/tools.ozone.moderation.emitEvent", this.emitEventHandler);
	}

	/**
	 * Start the server.
	 * @param port The port to listen on.
	 * @param callback A callback to run when the server is started.
	 */
	start(port = 443, callback?: () => void) {
		this.server = this.app.listen(port, callback);
	}

	/**
	 * Stop the server.
	 * @param callback A callback to run when the server is stopped.
	 */
	stop(callback?: () => void) {
		if (this.server?.listening) this.server?.close(callback);
	}

	/**
	 * Create and insert a label into the database, emitting it to subscribers.
	 * @param label The label to create.
	 */
	async createLabel(label: ComAtprotoLabelDefs.Label): Promise<SignedLabel> {
		const signed = labelIsSigned(label) ? label : await signLabel(label, this.signingKey);
		const stmt = this.db.prepare(`
			INSERT INTO labels (src, uri, cid, val, neg, cts, exp, sig)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const { src, uri, cid, val, neg, cts, exp, sig } = signed;
		const result = stmt.run(src, uri, cid, val, neg, cts, exp, sig);
		if (!result.changes) throw new Error("Failed to insert label");
		await this.emitLabel(signed);
		return signed;
	}

	async createLabels(
		subject: { uri: string; cid?: string | undefined },
		labels: { create?: Array<string>; negate?: Array<string> },
	) {
		const { uri, cid } = subject;
		const { create, negate } = labels;
		if (create) {
			await Promise.all(
				create.map((val) =>
					this.createLabel({
						src: this.did,
						uri,
						...(cid ? { cid } : {}),
						val,
						cts: new Date().toISOString(),
					})
				),
			);
		}
		if (negate) {
			await Promise.all(
				negate.map((val) =>
					this.createLabel({
						src: this.did,
						uri,
						...(cid ? { cid } : {}),
						val,
						neg: true,
						cts: new Date().toISOString(),
					})
				),
			);
		}
	}

	/**
	 * Ensure a label is signed, updating if necessary.
	 * @param label The label to ensure is signed.
	 */
	private async ensureSignedLabel(label: ComAtprotoLabelDefs.Label): Promise<SignedLabel> {
		if (!labelIsSigned(label)) {
			const signed = await signLabel(label, this.signingKey);
			const stmt = this.db.prepare(`
				UPDATE labels
				SET sig = ?
				WHERE id = ?
			`).run(signed.sig, label.id);
			if (!stmt.changes) throw new Error("Failed to update label with signature");
			return signed;
		}
		return formatLabel(label);
	}

	/**
	 * Emit a label to all subscribers.
	 * @param label The label to emit.
	 */
	private async emitLabel(label: ComAtprotoLabelDefs.Label) {
		const signed = await this.ensureSignedLabel(label);
		const frame = new MessageFrame({ seq: label.id, labels: [signed] }, { type: "#labels" });
		this.connections.get("com.atproto.label.subscribeLabels")?.forEach((ws) => {
			ws.send(frame.toBytes());
		});
	}

	/**
	 * Parse a user DID from an Authorization header JWT.
	 * @param req The Express request object.
	 */
	private async parseAuthHeaderDid(req: express.Request): Promise<string> {
		const authHeader = req.get("Authorization");
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
	 * Handler for com.atproto.label.queryLabels.
	 */
	queryLabelsHandler: RequestHandler = async (req, res) => {
		try {
			const {
				uriPatterns = [],
				sources = [],
				limit: limitStr = "50",
				cursor: cursorStr = "0",
			} = req.query as {
				uriPatterns?: Array<string>;
				sources?: Array<string>;
				limit?: string;
				cursor?: string;
			};

			const cursor = parseInt(cursorStr, 10);
			if (cursor !== undefined && Number.isNaN(cursor)) {
				throw new InvalidRequestError("Cursor must be an integer");
			}

			const limit = parseInt(limitStr, 10);
			if (Number.isNaN(limit) || limit < 1 || limit > 250) {
				throw new InvalidRequestError("Limit must be an integer between 1 and 250");
			}

			const patterns = uriPatterns.includes("*") ? [] : uriPatterns.map((pattern) => {
				if (pattern.indexOf("*") !== pattern.length - 1) {
					throw new InvalidRequestError(
						"Only trailing wildcards are supported in uriPatterns",
					);
				}
				return pattern.replaceAll(/%/g, "").replaceAll(/_/g, "\\_").slice(0, -1) + "%";
			});

			const stmt = this.db.prepare<unknown[], ComAtprotoLabelDefs.Label>(`
			SELECT * FROM labels
			WHERE 1 = 1
			${patterns.length ? "AND " + patterns.map(() => "uri LIKE ?").join(" OR ") : ""}
			${sources.length ? "AND src IN (?)" : ""}
			${cursor ? "AND id > ?" : ""}
			ORDER BY id ASC
			LIMIT ?
		`);

			const params = [];
			if (patterns.length) params.push(...patterns);
			if (sources.length) params.push(sources);
			if (cursor) params.push(cursor);
			params.push(limit);

			const rows = stmt.all(params);

			const labels = await Promise.all(rows.map((row) => this.ensureSignedLabel(row)));
			const nextCursor = rows[rows.length - 1]?.id ?? 0;

			res.json({ cursor: nextCursor, labels });
		} catch (e) {
			if (e instanceof XRPCError) {
				res.status(e.type).json(e.payload);
			} else {
				console.error(e);
				res.status(500).json({
					error: "InternalServerError",
					message: "An unknown error occurred",
				});
			}
		}
	};

	/**
	 * Handler for com.atproto.label.subscribeLabels.
	 */
	subscribeLabelsHandler: WebsocketRequestHandler = async (ws, req) => {
		const cursor = parseInt(req.params.cursor);

		if (cursor && !Number.isNaN(cursor)) {
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
					await this.ensureSignedLabel(row);
					const { id: seq, ...label } = row;
					const frame = new MessageFrame({ seq, labels: [label] }, { type: "#labels" });
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
	 * Handler for tools.ozone.moderation.emitEvent.
	 */
	emitEventHandler: RequestHandler = async (req, res) => {
		try {
			const actorDid = await this.parseAuthHeaderDid(req);
			const authed = await this.auth(actorDid);
			if (!authed) {
				throw new AuthRequiredError("Unauthorized");
			}

			const { event, subject, createdBy } = req
				.body as ToolsOzoneModerationEmitEvent.InputSchema;
			if (!event || !subject || !createdBy) {
				throw new InvalidRequestError("Missing required field(s)");
			}

			if (event.$type !== "tools.ozone.moderation.defs#modEventLabel") {
				throw new InvalidRequestError("Unsupported event type");
			}
			const labelEvent = event as ToolsOzoneModerationDefs.ModEventLabel;
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

			await this.createLabels({ uri, cid }, {
				create: labelEvent.createLabelVals,
				negate: labelEvent.negateLabelVals,
			});
		} catch (e) {
			if (e instanceof XRPCError) {
				res.status(e.type).json(e.payload);
			} else {
				console.error(e);
				res.status(500).json({
					error: "InternalServerError",
					message: "An unknown error occurred",
				});
			}
		}
	};

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
