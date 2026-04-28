/**
 * Tests for the F2 subagent overlay no-op shell.
 *
 * Until WS6 lands the Task tool + global registry, the overlay subscribes
 * to a NULL_SUBAGENT_REGISTRY and renders an empty-state message. These
 * tests pin both the empty-state behavior and the contract a real registry
 * must satisfy when WS6 wires it.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import {
	formatElapsed,
	NULL_SUBAGENT_REGISTRY,
	SubagentOverlay,
	type SubagentRegistry,
	type SubagentSnapshot,
} from "../src/index.js";

function makeRegistry(initial: SubagentSnapshot[]): SubagentRegistry & { update(s: SubagentSnapshot[]): void } {
	let snap = initial;
	const listeners = new Set<() => void>();
	return {
		list: () => snap,
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		update(s) {
			snap = s;
			for (const l of listeners) l();
		},
	};
}

describe("SubagentOverlay (no-op shell)", () => {
	it("renders an empty-state message with NULL_SUBAGENT_REGISTRY", () => {
		const overlay = new SubagentOverlay({ registry: NULL_SUBAGENT_REGISTRY });
		const lines = overlay.render(40);
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0].includes("Subagents"));
		assert.ok(lines[1].includes("none running"));
	});

	it("renders the live snapshot when a registry has entries", () => {
		const reg = makeRegistry([
			{
				id: "a1",
				name: "Explore",
				currentTool: "Glob",
				tokensIn: 120,
				tokensOut: 30,
				elapsedMs: 1500,
				status: "running",
			},
			{ id: "a2", name: "Tester", tokensIn: 0, tokensOut: 0, elapsedMs: 0, status: "queued" },
		]);
		const overlay = new SubagentOverlay({ registry: reg });
		const lines = overlay.render(60);
		assert.ok(lines[0].includes("Subagents (2)"));
		assert.ok(lines.some((l) => l.includes("Explore") && l.includes("[Glob]")));
		assert.ok(lines.some((l) => l.includes("Tester")));
	});

	it("notifies on registry changes via subscribe", () => {
		const reg = makeRegistry([]);
		const overlay = new SubagentOverlay({ registry: reg });
		let redraws = 0;
		overlay.bindRedraw(() => {
			redraws++;
		});
		reg.update([{ id: "x", name: "y", tokensIn: 0, tokensOut: 0, elapsedMs: 0, status: "running" }]);
		reg.update([]);
		assert.strictEqual(redraws, 2);
		overlay.dispose();
	});

	it("setRegistry replaces the active subscription", () => {
		const a = makeRegistry([]);
		const b = makeRegistry([{ id: "b", name: "B", tokensIn: 0, tokensOut: 0, elapsedMs: 0, status: "done" }]);
		const overlay = new SubagentOverlay({ registry: a });
		let redraws = 0;
		overlay.bindRedraw(() => {
			redraws++;
		});
		overlay.setRegistry(b);
		// Update a — overlay should NOT redraw because we swapped.
		a.update([{ id: "a", name: "A", tokensIn: 0, tokensOut: 0, elapsedMs: 0, status: "running" }]);
		assert.strictEqual(redraws, 0);
		// Update b — overlay should redraw.
		b.update([]);
		assert.strictEqual(redraws, 1);
	});

	it("truncates rows beyond maxRows and notes the overflow", () => {
		const many: SubagentSnapshot[] = Array.from({ length: 5 }, (_, i) => ({
			id: `s${i}`,
			name: `agent-${i}`,
			tokensIn: 0,
			tokensOut: 0,
			elapsedMs: 0,
			status: "running",
		}));
		const reg = makeRegistry(many);
		const overlay = new SubagentOverlay({ registry: reg, maxRows: 2 });
		const lines = overlay.render(60);
		// header + 2 rows + overflow indicator
		assert.strictEqual(lines.length, 4);
		assert.ok(lines[lines.length - 1].includes("+3 more"));
	});
});

describe("formatElapsed", () => {
	it("formats sub-second values in ms", () => {
		assert.strictEqual(formatElapsed(123), "123ms");
	});

	it("formats sub-minute values in seconds", () => {
		assert.strictEqual(formatElapsed(5_000), "5s");
	});

	it("formats minutes with zero-padded seconds", () => {
		assert.strictEqual(formatElapsed(125_000), "2m05s");
	});
});
