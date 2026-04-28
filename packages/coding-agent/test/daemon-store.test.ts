/**
 * WS9 — SQLite session store unit tests.
 *
 * Faster + tighter than the full server tests; exercises the schema directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionStore } from "../src/core/daemon/index.js";
import { openStore } from "../src/core/daemon/index.js";

let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cave-store-test-"));
	store = openStore(join(tmpDir, "sessions.db"));
});

afterEach(() => {
	store.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteSessionStore", () => {
	it("create + get + update round-trip", () => {
		const created = store.createSession({ id: "00000000-0000-4000-8000-000000000001", cwd: "/tmp", title: "x" });
		expect(created.state).toBe("idle");
		const fetched = store.getSession(created.id);
		expect(fetched?.title).toBe("x");

		const updated = store.updateSession(created.id, { state: "running", title: "y" });
		expect(updated?.state).toBe("running");
		expect(updated?.title).toBe("y");
		expect(updated?.createdAt).toBe(created.createdAt);
	});

	it("list filters by state and respects limit", () => {
		for (let i = 0; i < 5; i++) {
			store.createSession({ id: `00000000-0000-4000-8000-00000000000${i}`, cwd: "/tmp" });
		}
		store.updateSession("00000000-0000-4000-8000-000000000001", { state: "running" });
		const running = store.listSessions({ state: "running" });
		expect(running.length).toBe(1);
		const all = store.listSessions({ limit: 3 });
		expect(all.length).toBe(3);
	});

	it("appendMessage + getTranscript preserves order", () => {
		const s = store.createSession({ id: "00000000-0000-4000-8000-00000000aaaa", cwd: "/tmp" });
		store.appendMessage({
			id: "m1",
			sessionId: s.id,
			role: "user",
			text: "hi",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		store.appendMessage({
			id: "m2",
			sessionId: s.id,
			role: "assistant",
			text: "ok",
			createdAt: "2026-01-01T00:00:01.000Z",
		});
		const t = store.getTranscript(s.id);
		expect(t.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(t[1].text).toBe("ok");
	});

	it("delete cascades to messages", () => {
		const s = store.createSession({ id: "00000000-0000-4000-8000-00000000bbbb", cwd: "/tmp" });
		store.appendMessage({
			id: "m1",
			sessionId: s.id,
			role: "user",
			text: "hi",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		expect(store.deleteSession(s.id)).toBe(true);
		expect(store.getTranscript(s.id)).toEqual([]);
		expect(store.getSession(s.id)).toBeUndefined();
	});

	it("worker register/list/remove", () => {
		store.registerWorker({
			name: "w1",
			url: "http://a",
			registeredAt: "2026-01-01T00:00:00.000Z",
			labels: { gpu: "h100" },
		});
		expect(store.listWorkers().length).toBe(1);
		// upsert
		store.registerWorker({
			name: "w1",
			url: "http://b",
			registeredAt: "2026-01-02T00:00:00.000Z",
		});
		const single = store.getWorker("w1");
		expect(single?.url).toBe("http://b");
		expect(store.removeWorker("w1")).toBe(true);
		expect(store.listWorkers()).toEqual([]);
	});
});
