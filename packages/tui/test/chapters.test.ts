/**
 * Tests for chapter intent detection + grouping.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { detectIntent, groupTurnsIntoChapters, intentLabel, type Turn, toggleChapter } from "../src/index.js";

let nextId = 0;
function turn(role: Turn["role"], text: string, tools?: string[], tsBase = 1_700_000_000_000): Turn {
	nextId++;
	return { id: `t${nextId}`, role, text, tools, timestamp: tsBase + nextId };
}

describe("detectIntent", () => {
	it("classifies test-related turns", () => {
		assert.strictEqual(detectIntent(turn("user", "add a vitest spec for parser")), "test");
	});

	it("classifies debug turns by error keywords", () => {
		assert.strictEqual(detectIntent(turn("user", "got a TypeError on line 42, can you reproduce?")), "debug");
	});

	it("classifies refactor by keyword", () => {
		assert.strictEqual(detectIntent(turn("user", "rename the foo helper to fooBar")), "refactor");
	});

	it("classifies implement when adding/creating with Edit tool", () => {
		assert.strictEqual(detectIntent(turn("user", "add a sync output module", ["Edit"])), "implement");
	});

	it("falls back to 'other' when nothing matches", () => {
		assert.strictEqual(detectIntent(turn("user", "🌮")), "other");
	});

	it("recognises plan-related prompts", () => {
		assert.strictEqual(detectIntent(turn("user", "let's plan the migration approach")), "plan");
	});
});

describe("groupTurnsIntoChapters", () => {
	it("merges consecutive same-intent turns", () => {
		const turns = [
			turn("user", "add a test for the parser"),
			turn("assistant", "ok, writing the spec", ["Write"]),
			turn("user", "now add a coverage assertion"),
		];
		const chapters = groupTurnsIntoChapters(turns);
		assert.strictEqual(chapters.length, 1);
		assert.strictEqual(chapters[0].intent, "test");
		assert.strictEqual(chapters[0].turns.length, 3);
	});

	it("opens a new chapter on intent switch", () => {
		const turns = [
			turn("user", "add tests for parser"),
			turn("user", "rename helper foo"),
			turn("user", "explain how this works"),
		];
		const chapters = groupTurnsIntoChapters(turns);
		assert.strictEqual(chapters.length, 3);
		assert.deepStrictEqual(
			chapters.map((c) => c.intent),
			["test", "refactor", "explain"],
		);
	});

	it("inherits last non-tool intent for tool turns so chapters do not fragment", () => {
		const turns = [
			turn("user", "add a test for x"),
			turn("tool", "running vitest", ["Bash"]),
			turn("user", "debug the failing assertion"),
		];
		const chapters = groupTurnsIntoChapters(turns);
		// First two share 'test'; third opens a 'debug' chapter.
		assert.strictEqual(chapters.length, 2);
		assert.strictEqual(chapters[0].intent, "test");
		assert.strictEqual(chapters[0].turns.length, 2);
		assert.strictEqual(chapters[1].intent, "debug");
	});

	it("leaves the most recent chapter unfolded", () => {
		const turns = [turn("user", "add tests"), turn("user", "rename foo")];
		const chapters = groupTurnsIntoChapters(turns);
		assert.strictEqual(chapters[0].folded, true);
		assert.strictEqual(chapters[chapters.length - 1].folded, false);
	});
});

describe("toggleChapter", () => {
	it("toggles the folded flag immutably", () => {
		const turns = [turn("user", "add a test"), turn("user", "rename foo")];
		const chapters = groupTurnsIntoChapters(turns);
		const target = chapters[0];
		const next = toggleChapter(chapters, target.id);
		assert.notStrictEqual(next, chapters);
		assert.strictEqual(next.find((c) => c.id === target.id)?.folded, !target.folded);
	});
});

describe("intentLabel", () => {
	it("returns a human label for every intent", () => {
		assert.strictEqual(intentLabel("test"), "Test");
		assert.strictEqual(intentLabel("other"), "Notes");
	});
});
