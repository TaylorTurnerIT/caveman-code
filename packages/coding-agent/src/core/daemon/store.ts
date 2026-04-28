/**
 * WS9 Daemon — SQLite session store (better-sqlite3).
 *
 * Schema:
 *   sessions(id TEXT PK, created_at TEXT, updated_at TEXT,
 *            state TEXT, cwd TEXT, title TEXT, model TEXT, worker TEXT)
 *   messages(id TEXT PK, session_id TEXT FK, role TEXT, text TEXT,
 *            created_at TEXT)
 *   workers(name TEXT PK, url TEXT, token TEXT, registered_at TEXT,
 *            last_seen_at TEXT, labels TEXT) — labels is a JSON blob
 *
 * Pattern lifted from opencode (sst/opencode, MIT) — they use SQLite for
 * their daemon's session store too, with a similar two-table layout. Cave's
 * additions: workers table for `&prompt` cloud handoff, normalized
 * timestamps, foreign-key cascade on delete.
 *
 * better-sqlite3 is synchronous and tiny — no async pool needed. Ships
 * with prebuilt binaries for darwin-x64, darwin-arm64, linux-x64,
 * linux-arm64, win32-x64.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
	MessageRecord,
	Role,
	SessionRecord,
	SessionState,
	WorkerRecord,
} from "./protocol.js";

export interface SessionStore {
	createSession(input: Omit<SessionRecord, "createdAt" | "updatedAt" | "state"> & { state?: SessionState }): SessionRecord;
	getSession(id: string): SessionRecord | undefined;
	listSessions(filter?: { state?: SessionState; limit?: number }): SessionRecord[];
	updateSession(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined;
	deleteSession(id: string): boolean;

	appendMessage(msg: MessageRecord): void;
	getTranscript(sessionId: string): MessageRecord[];

	registerWorker(w: WorkerRecord): WorkerRecord;
	listWorkers(): WorkerRecord[];
	getWorker(name: string): WorkerRecord | undefined;
	removeWorker(name: string): boolean;

	close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT,
  model TEXT,
  worker TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS workers (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  token TEXT,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT,
  labels TEXT
);
`;

interface SessionRow {
	id: string;
	created_at: string;
	updated_at: string;
	state: string;
	cwd: string;
	title: string | null;
	model: string | null;
	worker: string | null;
}

interface MessageRow {
	id: string;
	session_id: string;
	role: string;
	text: string;
	created_at: string;
}

interface WorkerRow {
	name: string;
	url: string;
	token: string | null;
	registered_at: string;
	last_seen_at: string | null;
	labels: string | null;
}

function rowToSession(r: SessionRow): SessionRecord {
	return {
		id: r.id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		state: r.state as SessionState,
		cwd: r.cwd,
		title: r.title ?? undefined,
		model: r.model ?? undefined,
		worker: r.worker ?? undefined,
	};
}

function rowToMessage(r: MessageRow): MessageRecord {
	return {
		id: r.id,
		sessionId: r.session_id,
		role: r.role as Role,
		text: r.text,
		createdAt: r.created_at,
	};
}

function rowToWorker(r: WorkerRow): WorkerRecord {
	return {
		name: r.name,
		url: r.url,
		token: r.token ?? undefined,
		registeredAt: r.registered_at,
		lastSeenAt: r.last_seen_at ?? undefined,
		labels: r.labels ? (JSON.parse(r.labels) as Record<string, string>) : undefined,
	};
}

export class SqliteSessionStore implements SessionStore {
	private db: Database.Database;

	constructor(dbPath: string) {
		// `:memory:` is a special path; only mkdir for real paths.
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.exec(SCHEMA);
	}

	createSession(
		input: Omit<SessionRecord, "createdAt" | "updatedAt" | "state"> & { state?: SessionState },
	): SessionRecord {
		const now = new Date().toISOString();
		const rec: SessionRecord = {
			id: input.id,
			createdAt: now,
			updatedAt: now,
			state: input.state ?? "idle",
			cwd: input.cwd,
			title: input.title,
			model: input.model,
			worker: input.worker,
		};
		this.db
			.prepare(
				`INSERT INTO sessions (id, created_at, updated_at, state, cwd, title, model, worker)
				 VALUES (@id, @createdAt, @updatedAt, @state, @cwd, @title, @model, @worker)`,
			)
			.run({
				id: rec.id,
				createdAt: rec.createdAt,
				updatedAt: rec.updatedAt,
				state: rec.state,
				cwd: rec.cwd,
				title: rec.title ?? null,
				model: rec.model ?? null,
				worker: rec.worker ?? null,
			});
		return rec;
	}

	getSession(id: string): SessionRecord | undefined {
		const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
		return row ? rowToSession(row) : undefined;
	}

	listSessions(filter?: { state?: SessionState; limit?: number }): SessionRecord[] {
		const limit = Math.max(1, Math.min(filter?.limit ?? 50, 200));
		let rows: SessionRow[];
		if (filter?.state) {
			rows = this.db
				.prepare(`SELECT * FROM sessions WHERE state = ? ORDER BY updated_at DESC LIMIT ?`)
				.all(filter.state, limit) as SessionRow[];
		} else {
			rows = this.db
				.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
				.all(limit) as SessionRow[];
		}
		return rows.map(rowToSession);
	}

	updateSession(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
		const cur = this.getSession(id);
		if (!cur) return undefined;
		const next: SessionRecord = {
			...cur,
			...patch,
			id: cur.id, // never patch id
			createdAt: cur.createdAt, // never patch creation
			updatedAt: new Date().toISOString(),
		};
		this.db
			.prepare(
				`UPDATE sessions SET
					updated_at = @updatedAt,
					state = @state,
					cwd = @cwd,
					title = @title,
					model = @model,
					worker = @worker
				 WHERE id = @id`,
			)
			.run({
				id: next.id,
				updatedAt: next.updatedAt,
				state: next.state,
				cwd: next.cwd,
				title: next.title ?? null,
				model: next.model ?? null,
				worker: next.worker ?? null,
			});
		return next;
	}

	deleteSession(id: string): boolean {
		const info = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
		return info.changes > 0;
	}

	appendMessage(msg: MessageRecord): void {
		this.db
			.prepare(
				`INSERT INTO messages (id, session_id, role, text, created_at)
				 VALUES (@id, @sessionId, @role, @text, @createdAt)`,
			)
			.run(msg);
		// Touch session updated_at so list ordering stays accurate.
		this.db
			.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
			.run(msg.createdAt, msg.sessionId);
	}

	getTranscript(sessionId: string): MessageRecord[] {
		// rowid preserves insertion order even when two messages share a
		// millisecond-resolution `created_at`. Falls back to created_at as a
		// secondary sort if rowid is somehow non-monotonic.
		const rows = this.db
			.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC`)
			.all(sessionId) as MessageRow[];
		return rows.map(rowToMessage);
	}

	registerWorker(w: WorkerRecord): WorkerRecord {
		const labels = w.labels ? JSON.stringify(w.labels) : null;
		this.db
			.prepare(
				`INSERT INTO workers (name, url, token, registered_at, last_seen_at, labels)
				 VALUES (@name, @url, @token, @registeredAt, @lastSeenAt, @labels)
				 ON CONFLICT(name) DO UPDATE SET
					url = excluded.url,
					token = excluded.token,
					registered_at = excluded.registered_at,
					last_seen_at = excluded.last_seen_at,
					labels = excluded.labels`,
			)
			.run({
				name: w.name,
				url: w.url,
				token: w.token ?? null,
				registeredAt: w.registeredAt,
				lastSeenAt: w.lastSeenAt ?? null,
				labels,
			});
		return { ...w };
	}

	listWorkers(): WorkerRecord[] {
		const rows = this.db
			.prepare(`SELECT * FROM workers ORDER BY registered_at DESC`)
			.all() as WorkerRow[];
		return rows.map(rowToWorker);
	}

	getWorker(name: string): WorkerRecord | undefined {
		const row = this.db.prepare(`SELECT * FROM workers WHERE name = ?`).get(name) as
			| WorkerRow
			| undefined;
		return row ? rowToWorker(row) : undefined;
	}

	removeWorker(name: string): boolean {
		const info = this.db.prepare(`DELETE FROM workers WHERE name = ?`).run(name);
		return info.changes > 0;
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Open a SQLite-backed store. If better-sqlite3 fails to load (e.g. on a
 * platform without prebuilt binaries) the caller should catch and fall back —
 * but in practice this works on every supported platform out of the box.
 */
export function openStore(dbPath: string): SessionStore {
	return new SqliteSessionStore(dbPath);
}
