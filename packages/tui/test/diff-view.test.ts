/**
 * Tests for diff view layout switch + side-by-side pairing.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { type DiffLine, DiffView, pairUpHunks, pickLayout, SIDE_BY_SIDE_MIN_WIDTH } from "../src/index.js";

describe("pickLayout / SIDE_BY_SIDE_MIN_WIDTH", () => {
	it("uses unified below the threshold", () => {
		assert.strictEqual(pickLayout(SIDE_BY_SIDE_MIN_WIDTH - 1), "unified");
		assert.strictEqual(pickLayout(80), "unified");
		assert.strictEqual(pickLayout(40), "unified");
	});

	it("uses side-by-side at and above the threshold", () => {
		assert.strictEqual(pickLayout(SIDE_BY_SIDE_MIN_WIDTH), "side-by-side");
		assert.strictEqual(pickLayout(120), "side-by-side");
		assert.strictEqual(pickLayout(200), "side-by-side");
	});
});

describe("pairUpHunks", () => {
	it("pairs equal del/add runs", () => {
		const lines: DiffLine[] = [
			{ kind: "del", text: "old1" },
			{ kind: "del", text: "old2" },
			{ kind: "add", text: "new1" },
			{ kind: "add", text: "new2" },
		];
		const pairs = pairUpHunks(lines);
		assert.strictEqual(pairs.length, 2);
		assert.strictEqual(pairs[0].left?.text, "old1");
		assert.strictEqual(pairs[0].right?.text, "new1");
		assert.strictEqual(pairs[1].left?.text, "old2");
		assert.strictEqual(pairs[1].right?.text, "new2");
	});

	it("pads when add and del runs have different lengths", () => {
		const lines: DiffLine[] = [
			{ kind: "del", text: "old1" },
			{ kind: "add", text: "new1" },
			{ kind: "add", text: "new2" },
		];
		const pairs = pairUpHunks(lines);
		assert.strictEqual(pairs.length, 2);
		assert.strictEqual(pairs[0].left?.text, "old1");
		assert.strictEqual(pairs[0].right?.text, "new1");
		assert.strictEqual(pairs[1].left, undefined);
		assert.strictEqual(pairs[1].right?.text, "new2");
	});

	it("emits context lines as both halves", () => {
		const pairs = pairUpHunks([{ kind: "context", text: "ctx" }]);
		assert.strictEqual(pairs[0].left?.text, "ctx");
		assert.strictEqual(pairs[0].right?.text, "ctx");
	});

	it("preserves headers and hunk markers untouched", () => {
		const pairs = pairUpHunks([
			{ kind: "header", text: "--- a/file" },
			{ kind: "hunk", text: "@@ -1,3 +1,3 @@" },
		]);
		assert.strictEqual(pairs[0].kind, "header");
		assert.strictEqual(pairs[1].kind, "hunk");
	});
});

describe("DiffView render", () => {
	const lines: DiffLine[] = [
		{ kind: "header", text: "--- a/x.ts" },
		{ kind: "hunk", text: "@@ -1,3 +1,3 @@" },
		{ kind: "context", text: "const a = 1;", oldLine: 1, newLine: 1 },
		{ kind: "del", text: "const b = 2;", oldLine: 2 },
		{ kind: "add", text: "const b = 3;", newLine: 2 },
		{ kind: "context", text: "const c = 4;", oldLine: 3, newLine: 3 },
	];

	it("renders unified layout under 100 cols", () => {
		const view = new DiffView({ lines });
		const out = view.render(80);
		// Every row padded to width.
		for (const row of out) {
			assert.strictEqual(row.length, 80, `row: ${JSON.stringify(row)}`);
		}
		// Header passed through.
		assert.ok(out[0].startsWith("--- a/x.ts"));
		// Hunk row.
		assert.ok(out[1].startsWith("@@ -1,3 +1,3 @@"));
	});

	it("renders side-by-side at 120 cols", () => {
		const view = new DiffView({ lines });
		const out = view.render(120);
		// Side-by-side pairs consecutive del+add runs, so the row count is
		// shorter than the unified row count.
		assert.ok(out.length >= 5);
		// Each non-header/hunk row should contain the column separator.
		const ctxRow = out[2];
		assert.ok(ctxRow.includes("│"), `expected separator in side-by-side row: ${ctxRow}`);
	});

	it("forceLayout overrides the width-based decision", () => {
		const view = new DiffView({ lines, forceLayout: "unified" });
		const out = view.render(200);
		for (const row of out) {
			assert.ok(!row.includes("│"), `unified row should not have side-by-side separator: ${row}`);
		}
	});
});
