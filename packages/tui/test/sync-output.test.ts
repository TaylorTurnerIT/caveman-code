/**
 * Tests for DEC mode 2026 synchronized output capability detection + wrapping.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import {
	classifySyncOutputSupport,
	emitSyncOutputBegin,
	emitSyncOutputEnd,
	SYNC_OUTPUT_BEGIN,
	SYNC_OUTPUT_END,
	wrapSyncOutput,
} from "../src/sync-output.js";
import type { TerminalIdentity } from "../src/terminal-detect.js";

function id(overrides: Partial<TerminalIdentity> = {}): TerminalIdentity {
	return {
		program: "unknown",
		multiplexer: "none",
		isSsh: false,
		raw: {},
		...overrides,
	};
}

describe("classifySyncOutputSupport", () => {
	it("returns supported for kitty/iterm2/wezterm/alacritty/ghostty/windows-terminal", () => {
		for (const program of ["kitty", "iterm2", "wezterm", "alacritty", "ghostty", "windows-terminal"] as const) {
			assert.strictEqual(
				classifySyncOutputSupport({ identity: id({ program }) }),
				"supported",
				`${program} should be supported`,
			);
		}
	});

	it("returns unsupported for apple-terminal and linux-console", () => {
		assert.strictEqual(classifySyncOutputSupport({ identity: id({ program: "apple-terminal" }) }), "unsupported");
		assert.strictEqual(classifySyncOutputSupport({ identity: id({ program: "linux-console" }) }), "unsupported");
	});

	it("returns unsupported when running under tmux/screen by default", () => {
		const previous = process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER;
		delete process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER;
		try {
			assert.strictEqual(
				classifySyncOutputSupport({ identity: id({ program: "tmux", multiplexer: "tmux", hostProgram: "kitty" }) }),
				"unsupported",
			);
			assert.strictEqual(
				classifySyncOutputSupport({ identity: id({ program: "screen", multiplexer: "screen" }) }),
				"unsupported",
			);
		} finally {
			if (previous === undefined) delete process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER;
			else process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER = previous;
		}
	});

	it("opts in under tmux when CAVE_SYNC_OUTPUT_MULTIPLEXER=1 and host known", () => {
		const previous = process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER;
		process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER = "1";
		try {
			assert.strictEqual(
				classifySyncOutputSupport({ identity: id({ program: "tmux", multiplexer: "tmux", hostProgram: "kitty" }) }),
				"supported",
			);
		} finally {
			if (previous === undefined) delete process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER;
			else process.env.CAVE_SYNC_OUTPUT_MULTIPLEXER = previous;
		}
	});

	it("override 'on' forces supported regardless of program", () => {
		assert.strictEqual(
			classifySyncOutputSupport({ identity: id({ program: "linux-console" }), override: "on" }),
			"supported",
		);
	});

	it("override 'off' forces unsupported regardless of program", () => {
		assert.strictEqual(
			classifySyncOutputSupport({ identity: id({ program: "kitty" }), override: "off" }),
			"unsupported",
		);
	});

	it("returns unknown for genuinely unidentified terminals", () => {
		assert.strictEqual(classifySyncOutputSupport({ identity: id({ program: "unknown" }) }), "unknown");
	});
});

describe("wrapSyncOutput / emit gating", () => {
	it("wraps the buffer in begin+end when supported", () => {
		const wrapped = wrapSyncOutput("hello", "supported");
		assert.strictEqual(wrapped, `${SYNC_OUTPUT_BEGIN}hello${SYNC_OUTPUT_END}`);
	});

	it("returns the buffer unchanged when not supported", () => {
		assert.strictEqual(wrapSyncOutput("hello", "unsupported"), "hello");
		assert.strictEqual(wrapSyncOutput("hello", "unknown"), "hello");
	});

	it("emit helpers only write bytes when supported", () => {
		const calls: string[] = [];
		const w = (s: string): void => {
			calls.push(s);
		};
		emitSyncOutputBegin(w, "supported");
		emitSyncOutputEnd(w, "supported");
		emitSyncOutputBegin(w, "unsupported");
		emitSyncOutputEnd(w, "unsupported");
		emitSyncOutputBegin(w, "unknown");
		assert.deepStrictEqual(calls, [SYNC_OUTPUT_BEGIN, SYNC_OUTPUT_END]);
	});
});
