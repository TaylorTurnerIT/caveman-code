/**
 * Tests for OSC-52 clipboard write primitive.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { encodeOsc52, OSC52_MAX_BYTES, writeOsc52 } from "../src/osc52.js";

describe("encodeOsc52", () => {
	it("emits the canonical sequence for short text", () => {
		const result = encodeOsc52("hello");
		assert.strictEqual(result.truncated, false);
		assert.ok(result.sequence.startsWith("\x1b]52;c;"));
		assert.ok(result.sequence.endsWith("\x07"));
		const payload = result.sequence.slice("\x1b]52;c;".length, -1);
		assert.strictEqual(Buffer.from(payload, "base64").toString("utf8"), "hello");
	});

	it("uses 'p' (primary selection) when requested", () => {
		const { sequence } = encodeOsc52("x", { primary: true });
		assert.ok(sequence.startsWith("\x1b]52;p;"));
	});

	it("preserves UTF-8 byte ordering", () => {
		const text = "café — 🌮 — naïve";
		const result = encodeOsc52(text);
		const payload = result.sequence.slice("\x1b]52;c;".length, -1);
		assert.strictEqual(Buffer.from(payload, "base64").toString("utf8"), text);
		assert.strictEqual(result.truncated, false);
	});

	it("truncates payloads above the terminal byte budget", () => {
		// 60_000 'a' encodes to 80_000 base64 chars — over OSC52_MAX_BYTES.
		const long = "a".repeat(60_000);
		const result = encodeOsc52(long);
		assert.strictEqual(result.truncated, true);
		assert.ok(result.bytes <= OSC52_MAX_BYTES, `bytes ${result.bytes} should not exceed OSC52_MAX_BYTES`);
		// Decoded length must be a prefix of the input.
		const payload = result.sequence.slice("\x1b]52;c;".length, -1);
		const decoded = Buffer.from(payload, "base64").toString("utf8");
		assert.ok(long.startsWith(decoded));
		assert.ok(decoded.length < long.length);
	});

	it("does not truncate when payload fits exactly within the budget", () => {
		// Build a text whose base64 length is at or just below OSC52_MAX_BYTES.
		// base64 of N raw bytes = ceil(N/3)*4. Pick N so the rounded base64
		// length is ≤ OSC52_MAX_BYTES with at least one byte of slack.
		const rawLen = Math.floor(OSC52_MAX_BYTES / 4) * 3 - 3;
		const text = "a".repeat(rawLen);
		const result = encodeOsc52(text);
		assert.strictEqual(result.truncated, false);
		assert.ok(result.bytes <= OSC52_MAX_BYTES);
	});
});

describe("writeOsc52", () => {
	it("invokes the writer with the sequence and returns metadata", () => {
		const calls: string[] = [];
		const result = writeOsc52((s) => calls.push(s), "hi");
		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0].startsWith("\x1b]52;c;"));
		assert.strictEqual(result.truncated, false);
	});
});
