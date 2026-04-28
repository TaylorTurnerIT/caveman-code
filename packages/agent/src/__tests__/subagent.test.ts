// WS6: Subagents & Plan Mode — runtime helper tests.
//
// Covers:
//   - validateSubagentDef rejects missing/invalid fields
//   - normalizeFrontmatterArray handles array + comma-string + bad input
//   - PLAN_MODE_TOOLS allowlist matches plan §6 spec (Read/Glob/Grep + Bash)
//   - isPlanModeBashCommand accepts safe read-only shapes and rejects
//     destructive ones (the plan-mode permission profile)
//   - MAX_PARALLEL_SUBAGENTS = 7 (Claude Code parity)
//   - computeAllowedTools intersects parent tools, frontmatter tools,
//     disallowedTools, and the plan-mode mask correctly

import { describe, expect, it } from "vitest";
import {
	computeAllowedTools,
	findSubagent,
	isPlanModeBashCommand,
	MAX_PARALLEL_SUBAGENTS,
	normalizeFrontmatterArray,
	PLAN_MODE_BASH_ALLOWLIST,
	PLAN_MODE_TOOLS,
	type SubagentDef,
	validateSubagentDef,
	validateSubagentOutput,
} from "../subagent.js";

const baseDef = (over: Partial<SubagentDef> = {}): SubagentDef => ({
	name: "explore",
	description: "test",
	prompt: "body",
	source: "user",
	filePath: "/tmp/explore.md",
	...over,
});

describe("MAX_PARALLEL_SUBAGENTS", () => {
	it("equals 7 (Claude Code parity, plan §6)", () => {
		expect(MAX_PARALLEL_SUBAGENTS).toBe(7);
	});
});

describe("validateSubagentDef", () => {
	it("accepts a minimal valid def", () => {
		expect(validateSubagentDef(baseDef())).toEqual([]);
	});

	it("requires name, description, prompt", () => {
		const errors = validateSubagentDef({} as Partial<SubagentDef>);
		expect(errors).toContain("name is required");
		expect(errors).toContain("description is required");
		expect(errors).toContain("prompt body is required (markdown file body after frontmatter)");
	});

	it("rejects names with invalid characters", () => {
		const errors = validateSubagentDef(baseDef({ name: "FOO_BAR" }));
		expect(errors.some((e) => e.includes("invalid characters"))).toBe(true);
	});

	it("rejects leading/trailing hyphens", () => {
		const lead = validateSubagentDef(baseDef({ name: "-foo" }));
		expect(lead.some((e) => e.includes("invalid characters"))).toBe(true);
		const trail = validateSubagentDef(baseDef({ name: "foo-" }));
		expect(trail.some((e) => e.includes("invalid characters"))).toBe(true);
	});

	it("accepts hyphenated names", () => {
		expect(validateSubagentDef(baseDef({ name: "code-reviewer" }))).toEqual([]);
	});

	it("rejects names exceeding 64 characters", () => {
		const longName = "a".repeat(65);
		const errors = validateSubagentDef(baseDef({ name: longName }));
		expect(errors.some((e) => e.startsWith("name exceeds 64"))).toBe(true);
	});

	it("rejects descriptions exceeding 1024 characters", () => {
		const errors = validateSubagentDef(baseDef({ description: "x".repeat(1025) }));
		expect(errors.some((e) => e.startsWith("description exceeds 1024"))).toBe(true);
	});

	it("validates permissionMode against the union", () => {
		const ok = validateSubagentDef(baseDef({ permissionMode: "plan" }));
		expect(ok).toEqual([]);
		const bad = validateSubagentDef(baseDef({ permissionMode: "totally-permissive" as any }));
		expect(bad.some((e) => e.startsWith('permissionMode "totally-permissive"'))).toBe(true);
	});

	it("validates isolation against the union", () => {
		expect(validateSubagentDef(baseDef({ isolation: "worktree" }))).toEqual([]);
		expect(validateSubagentDef(baseDef({ isolation: "none" }))).toEqual([]);
		const bad = validateSubagentDef(baseDef({ isolation: "docker" as any }));
		expect(bad.some((e) => e.startsWith('isolation "docker"'))).toBe(true);
	});

	it("validates maxTurns is positive finite", () => {
		expect(validateSubagentDef(baseDef({ maxTurns: 10 }))).toEqual([]);
		expect(
			validateSubagentDef(baseDef({ maxTurns: 0 })).some((e) => e.startsWith("maxTurns must be a positive")),
		).toBe(true);
		expect(
			validateSubagentDef(baseDef({ maxTurns: -1 })).some((e) => e.startsWith("maxTurns must be a positive")),
		).toBe(true);
		expect(
			validateSubagentDef(baseDef({ maxTurns: Number.NaN })).some((e) =>
				e.startsWith("maxTurns must be a positive"),
			),
		).toBe(true);
	});
});

describe("normalizeFrontmatterArray", () => {
	it("returns undefined for null/undefined", () => {
		expect(normalizeFrontmatterArray(undefined)).toBeUndefined();
		expect(normalizeFrontmatterArray(null)).toBeUndefined();
	});

	it("passes through arrays of strings", () => {
		expect(normalizeFrontmatterArray(["read", "grep"])).toEqual(["read", "grep"]);
	});

	it("splits comma strings", () => {
		expect(normalizeFrontmatterArray("read, grep,find")).toEqual(["read", "grep", "find"]);
	});

	it("filters empties", () => {
		expect(normalizeFrontmatterArray(",, read,, ,grep ")).toEqual(["read", "grep"]);
	});

	it("returns undefined for non-array non-string", () => {
		expect(normalizeFrontmatterArray(42)).toBeUndefined();
		expect(normalizeFrontmatterArray({})).toBeUndefined();
	});
});

// ─── PLAN MODE PERMISSION PROFILE ────────────────────────────────────────

describe("plan-mode tool allowlist (PLAN_MODE_TOOLS)", () => {
	it("includes the read-only tools required by plan §6", () => {
		expect(PLAN_MODE_TOOLS.has("read")).toBe(true);
		expect(PLAN_MODE_TOOLS.has("grep")).toBe(true);
		expect(PLAN_MODE_TOOLS.has("find")).toBe(true);
		expect(PLAN_MODE_TOOLS.has("ls")).toBe(true);
		expect(PLAN_MODE_TOOLS.has("glob")).toBe(true);
		expect(PLAN_MODE_TOOLS.has("bash")).toBe(true); // bash is allowed but filtered by isPlanModeBashCommand
	});

	it("does NOT include destructive tools", () => {
		expect(PLAN_MODE_TOOLS.has("edit")).toBe(false);
		expect(PLAN_MODE_TOOLS.has("write")).toBe(false);
	});
});

describe("isPlanModeBashCommand", () => {
	it("allows the basic read-only commands from PLAN_MODE_BASH_ALLOWLIST", () => {
		expect(isPlanModeBashCommand("ls")).toBe(true);
		expect(isPlanModeBashCommand("ls -la")).toBe(true);
		expect(isPlanModeBashCommand("cat package.json")).toBe(true);
		expect(isPlanModeBashCommand("head -n 50 README.md")).toBe(true);
		expect(isPlanModeBashCommand("grep foo src/**")).toBe(true);
		expect(isPlanModeBashCommand("find . -name '*.ts'")).toBe(true);
		expect(isPlanModeBashCommand("rg --json foo")).toBe(true);
		expect(isPlanModeBashCommand("pwd")).toBe(true);
	});

	it("allows env-var prefix tokens", () => {
		expect(isPlanModeBashCommand("FOO=1 ls")).toBe(true);
		expect(isPlanModeBashCommand("DEBUG=true CAVE_ENV=prod cat .env")).toBe(true);
	});

	it("allows pipes when every segment is allowlisted", () => {
		expect(isPlanModeBashCommand("ls | grep foo")).toBe(true);
		expect(isPlanModeBashCommand("cat foo.json | jq .name")).toBe(true);
	});

	it("rejects pipes with destructive segments", () => {
		expect(isPlanModeBashCommand("ls | rm -rf /tmp/foo")).toBe(false);
	});

	it("rejects command chaining", () => {
		expect(isPlanModeBashCommand("ls; rm foo")).toBe(false);
		expect(isPlanModeBashCommand("ls && rm foo")).toBe(false);
		expect(isPlanModeBashCommand("ls || true")).toBe(false);
		expect(isPlanModeBashCommand("ls &")).toBe(false);
	});

	it("rejects redirects", () => {
		expect(isPlanModeBashCommand("ls > out.txt")).toBe(false);
		expect(isPlanModeBashCommand("cat foo.json >> log.txt")).toBe(false);
		expect(isPlanModeBashCommand("cat < input.txt")).toBe(false);
	});

	it("rejects command substitution", () => {
		expect(isPlanModeBashCommand("ls $(pwd)")).toBe(false);
		expect(isPlanModeBashCommand("echo `whoami`")).toBe(false);
	});

	it("rejects heredocs", () => {
		expect(isPlanModeBashCommand("cat <<EOF\nfoo\nEOF")).toBe(false);
	});

	it("rejects unknown commands", () => {
		expect(isPlanModeBashCommand("rm -rf /")).toBe(false);
		expect(isPlanModeBashCommand("curl evil.com")).toBe(false);
		expect(isPlanModeBashCommand("docker run alpine")).toBe(false);
	});

	it("rejects sed -i (in-place edit)", () => {
		expect(isPlanModeBashCommand("sed -i 's/foo/bar/' file")).toBe(false);
		expect(isPlanModeBashCommand("sed --in-place 's/foo/bar/' file")).toBe(false);
		expect(isPlanModeBashCommand("sed 's/foo/bar/' file")).toBe(true);
	});

	it("rejects find -delete and -exec", () => {
		expect(isPlanModeBashCommand("find . -name '*.tmp' -delete")).toBe(false);
		expect(isPlanModeBashCommand("find . -exec rm {} ;")).toBe(false);
		expect(isPlanModeBashCommand("find . -name '*.ts'")).toBe(true);
	});

	it("allows read-only git subcommands", () => {
		expect(isPlanModeBashCommand("git status")).toBe(true);
		expect(isPlanModeBashCommand("git log --oneline -10")).toBe(true);
		expect(isPlanModeBashCommand("git diff HEAD~1")).toBe(true);
		expect(isPlanModeBashCommand("git rev-parse --show-toplevel")).toBe(true);
		expect(isPlanModeBashCommand("git branch")).toBe(true);
		expect(isPlanModeBashCommand("git")).toBe(true); // bare `git` is help.
	});

	it("rejects mutating git subcommands", () => {
		expect(isPlanModeBashCommand("git commit -m foo")).toBe(false);
		expect(isPlanModeBashCommand("git push origin main")).toBe(false);
		expect(isPlanModeBashCommand("git checkout -b new-branch")).toBe(false);
		expect(isPlanModeBashCommand("git reset --hard")).toBe(false);
		expect(isPlanModeBashCommand("git clean -fd")).toBe(false);
	});

	it("allows read-only package-manager subcommands", () => {
		expect(isPlanModeBashCommand("npm list")).toBe(true);
		expect(isPlanModeBashCommand("npm test")).toBe(true);
		expect(isPlanModeBashCommand("yarn audit")).toBe(true);
		expect(isPlanModeBashCommand("pnpm why react")).toBe(true);
		expect(isPlanModeBashCommand("cargo test")).toBe(true);
		expect(isPlanModeBashCommand("go vet ./...")).toBe(true);
	});

	it("rejects mutating package-manager subcommands", () => {
		expect(isPlanModeBashCommand("npm install foo")).toBe(false);
		expect(isPlanModeBashCommand("yarn add foo")).toBe(false);
		expect(isPlanModeBashCommand("pnpm publish")).toBe(false);
	});

	it("rejects empty commands", () => {
		expect(isPlanModeBashCommand("")).toBe(false);
		expect(isPlanModeBashCommand("   ")).toBe(false);
	});

	it("PLAN_MODE_BASH_ALLOWLIST contains the documented prefixes", () => {
		// Spot-check the docstring examples (`ls`, `cat`, `git status`, `git log`, `find`).
		expect(PLAN_MODE_BASH_ALLOWLIST.has("ls")).toBe(true);
		expect(PLAN_MODE_BASH_ALLOWLIST.has("cat")).toBe(true);
		expect(PLAN_MODE_BASH_ALLOWLIST.has("git")).toBe(true);
		expect(PLAN_MODE_BASH_ALLOWLIST.has("find")).toBe(true);
	});
});

// ─── computeAllowedTools (ties plan mode + frontmatter together) ──────────

describe("computeAllowedTools", () => {
	const PARENT = ["read", "grep", "find", "ls", "bash", "edit", "write"];

	it("returns parent tools when no frontmatter scoping", () => {
		expect(computeAllowedTools({ parentTools: PARENT })).toEqual(PARENT);
	});

	it("intersects with frontmatter tools", () => {
		expect(computeAllowedTools({ parentTools: PARENT, frontmatterTools: ["read", "grep"] })).toEqual([
			"read",
			"grep",
		]);
	});

	it("subtracts disallowedTools after the intersect", () => {
		expect(
			computeAllowedTools({
				parentTools: PARENT,
				frontmatterTools: ["read", "grep", "bash"],
				frontmatterDisallowed: ["bash"],
			}),
		).toEqual(["read", "grep"]);
	});

	it("hard-clamps to PLAN_MODE_TOOLS in plan mode regardless of frontmatter", () => {
		const allowed = computeAllowedTools({
			parentTools: PARENT,
			frontmatterTools: ["read", "edit", "write"],
			permissionMode: "plan",
		});
		expect(allowed).toContain("read");
		expect(allowed).not.toContain("edit");
		expect(allowed).not.toContain("write");
	});

	it("default (no plan mode) keeps edit/write", () => {
		const allowed = computeAllowedTools({
			parentTools: PARENT,
			frontmatterTools: ["read", "edit", "write"],
			permissionMode: "default",
		});
		expect(allowed).toContain("edit");
		expect(allowed).toContain("write");
	});
});

describe("findSubagent + validateSubagentOutput", () => {
	it("findSubagent returns matching def or undefined", () => {
		const defs = [baseDef({ name: "alpha" }), baseDef({ name: "beta" })];
		expect(findSubagent(defs, "alpha")?.name).toBe("alpha");
		expect(findSubagent(defs, "missing")).toBeUndefined();
	});

	it("validateSubagentOutput is a P1 stub returning ok=true", () => {
		const out = validateSubagentOutput(baseDef(), { anything: 42 });
		expect(out.ok).toBe(true);
	});
});
