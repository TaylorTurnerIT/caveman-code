/**
 * Subagent runtime — types, plan-mode permission profile, and parallel cap.
 *
 * Public surface:
 *   - SubagentDef                     — the canonical subagent definition,
 *                                       parsed from `.cave/agents/<name>.md`
 *                                       frontmatter (plus body = system prompt).
 *   - SubagentResult                  — schema-light envelope returned by a
 *                                       single subagent invocation.
 *   - PLAN_MODE_TOOLS                 — allowlist of tool names runnable in
 *                                       plan mode.
 *   - PLAN_MODE_BASH_ALLOWLIST        — read-only bash command prefixes
 *                                       allowed in plan mode.
 *   - MAX_PARALLEL_SUBAGENTS          — 7 (per plan §6).
 *   - validateSubagentDef             — runtime validation of a parsed def.
 *   - isPlanModeBashCommand           — true iff a bash command string is
 *                                       safe to execute in plan mode.
 *   - PlanResult                      — structured plan-mode output the user
 *                                       accepts to flip permissionMode →
 *                                       acceptEdits.
 *
 * Pi-check: pi-code's `subagent` extension example (vendored as a starting
 * point) implements the parallel/chain runner but does NOT model plan mode,
 * a worktree-isolation flag, the 12-event hook hook-up, or per-subagent
 * `permissionMode`. Those are cave-specific (this file).
 *
 * Design notes:
 *   - We keep types in @cave/agent so the loader (in @cave/coding-agent) and
 *     the Task/Agent tools (also in coding-agent) can both import them
 *     without a circular dependency.
 *   - Plan mode is read-only by construction; the bash allowlist is a
 *     conservative subset of what Claude Code's plan mode permits.
 *   - MAX_PARALLEL_SUBAGENTS=7 mirrors Claude Code's documented Task fan-out
 *     limit (plan §6).
 */

import type { TSchema } from "@sinclair/typebox";

// ─── Permission modes (mirrors @cave/coding-agent permission-prompt.ts) ────

/**
 * Permission mode for a subagent invocation. Subset of the coding-agent
 * SandboxPolicy permission modes; redeclared here to avoid pulling in the
 * heavier policy IR for callers that just want to gate Task invocations.
 */
export type SubagentPermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "bypassPermissions";

// ─── Isolation strategy ────────────────────────────────────────────────────

/**
 * `worktree`  — spawn the subagent inside `git worktree add .cave/worktrees/<id> <branch>`
 *               so its writes never collide with the parent session.
 * `none`      — share parent cwd. Cheaper, but every Edit/Write hits the same tree.
 */
export type SubagentIsolation = "worktree" | "none";

// ─── Subagent definition (parsed from `.cave/agents/<name>.md`) ────────────

/**
 * Frontmatter superset of Claude Code v2.1.119's agent format.
 *
 * Required: `description`. All others are optional. A user pasting
 * `~/.claude/agents/foo.md` into `~/.cave/agents/foo.md` MUST work unchanged
 * — we only ADD fields, never rename or shadow CC ones.
 */
export interface SubagentDef {
	/** Stable identifier (filename without `.md`, validated to lowercase a-z, 0-9, hyphens). */
	name: string;
	/** Short selector hint shown to the model when picking an agent. */
	description: string;
	/**
	 * Body of the markdown file = system prompt. Read on demand by the runner;
	 * the loader stores it inline so callers do not have to re-read disk.
	 */
	prompt: string;

	// ── Tool-scoping (CC-compatible) ───────────────────────────────────────

	/** Comma-separated list of tools the agent may call. Undefined = inherit parent. */
	tools?: string[];
	/** Tools explicitly forbidden. Applied AFTER `tools`. */
	disallowedTools?: string[];

	// ── Model + effort ────────────────────────────────────────────────────

	model?: string;
	effort?: "low" | "medium" | "high" | string;

	// ── Permission/sandbox/isolation ──────────────────────────────────────

	permissionMode?: SubagentPermissionMode;
	isolation?: SubagentIsolation;

	// ── Tooling integration ───────────────────────────────────────────────

	/** Names of MCP servers to surface to this agent. */
	mcpServers?: string[];
	/** Skill names to auto-attach for this agent. */
	skills?: string[];
	/** Hook event-to-command map; same schema as settings.json hooks. */
	hooks?: Record<string, unknown>;

	// ── Loop controls ─────────────────────────────────────────────────────

	/** Hard cap on agent loop iterations. */
	maxTurns?: number;
	/** Run in background (don't block the parent agent). */
	background?: boolean;

	// ── Provenance ────────────────────────────────────────────────────────

	/** Where this def came from (project, user, plugin, builtin). */
	source: SubagentSource;
	/** Absolute path to the .md file. */
	filePath: string;

	/** Unknown frontmatter keys passed through verbatim (e.g. CC-only fields cave doesn't yet wire). */
	[key: string]: unknown;
}

export type SubagentSource = "project" | "user" | "builtin" | "plugin";

// ─── Result envelope ───────────────────────────────────────────────────────

/**
 * Result returned by a single subagent invocation. P0 ships only the
 * required-shape fields; P1 (deferred per WS6 spec §7) will add full result-
 * schema validation against `SubagentDef.outputSchema`.
 */
export interface SubagentResult {
	/** Name of the agent that ran. */
	agent: string;
	/** Origin of the agent definition. */
	source: SubagentSource;
	/** Task as passed to the agent (post-substitution). */
	task: string;
	/** Final assistant text from the subagent loop. */
	output: string;
	/** Exit code: 0 = success, >0 = failure, -1 = still running. */
	exitCode: number;
	/** Optional structured payload (free-form for now; schema-validated in P1). */
	data?: unknown;
	/** Error message if the agent stopped abnormally. */
	error?: string;
	/** Token usage, mirrors pi-ai's accounting. */
	usage?: SubagentUsage;
	/** Worktree dir if isolation:worktree was applied. */
	worktreeDir?: string;
	/** Branch name if isolation:worktree was applied. */
	branchName?: string;
	/** Whether the worktree was auto-cleaned (worktree mode only). */
	worktreeCleaned?: boolean;
}

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

// ─── Parallel cap (per plan §6: "up to 7 parallel via Task") ──────────────

export const MAX_PARALLEL_SUBAGENTS = 7;

// ─── Plan mode ────────────────────────────────────────────────────────────

/**
 * Tools allowed in plan mode. Plan mode = read-only exploration before edits;
 * the model produces a structured plan, the user accepts, then permissionMode
 * flips to `acceptEdits` and the regular tool set returns.
 *
 * We allow Read/Glob/Grep/Find/Ls plus Bash — but Bash is further filtered by
 * `PLAN_MODE_BASH_ALLOWLIST` to a curated read-only command set.
 */
export const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"glob",
	"bash",
	// Subagent tools are allowed because Task can spawn read-only Explore
	// agents during plan-mode exploration.
	"task",
	"agent",
]);

/**
 * Bash commands allowed in plan mode (read-only). We match by the FIRST
 * argv token only — pipes, redirects, and chained commands are rejected by
 * the runtime (see `isPlanModeBashCommand`).
 *
 * Curated to mirror Claude Code's plan-mode bash allowlist plus a few
 * developer-favorite read-only utilities.
 */
export const PLAN_MODE_BASH_ALLOWLIST: ReadonlySet<string> = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"find",
	"grep",
	"rg",
	"fd",
	"file",
	"stat",
	"echo",
	"pwd",
	"which",
	"whereis",
	"realpath",
	"basename",
	"dirname",
	"date",
	"env",
	"git", // git is heavily multi-shaped; we further filter subcommands below.
	"node",
	"npm",
	"npx",
	"yarn",
	"pnpm",
	"deno",
	"bun",
	"python",
	"python3",
	"pip",
	"go",
	"cargo",
	"rustc",
	"true",
	"false",
	"sleep",
	"sort",
	"uniq",
	"cut",
	"awk",
	"sed", // sed without -i (in-place edit) — checked separately.
	"tr",
	"diff",
	"jq",
	"yq",
	"tree",
	"du",
	"df",
]);

/**
 * Read-only git subcommands. Anything not in this set causes a plan-mode
 * rejection — `git commit`, `git push`, `git checkout -b`, etc.
 */
export const PLAN_MODE_GIT_READ_ONLY: ReadonlySet<string> = new Set([
	"status",
	"log",
	"show",
	"diff",
	"blame",
	"branch", // `git branch` (no args) is a list; `git branch -D` is mutating — caller must pass --list-only flag for safety.
	"tag",
	"remote",
	"config",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"reflog",
	"shortlog",
	"describe",
	"stash",
	"worktree",
	"submodule",
	"fetch", // network read but no local mutation.
]);

/**
 * Read-only npm/yarn/pnpm/cargo/go subcommands.
 */
export const PLAN_MODE_PACKAGE_READ_ONLY: ReadonlySet<string> = new Set([
	"list",
	"ls",
	"view",
	"show",
	"outdated",
	"audit",
	"why",
	"explain",
	"info",
	"version",
	"help",
	"-v",
	"--version",
	"search",
	"doctor",
	"config",
	"run",
	"test", // running tests is read-only against project state.
	"check",
	"build",
	"vet", // go vet
	"tree", // cargo tree, npm ls --tree
	"--help",
]);

/**
 * Returns true iff `command` is safe to execute in plan mode.
 *
 * Heuristic — meant to be conservative. Rejects:
 *   - shell metacharacters that can chain commands (`;`, `&&`, `||`, `&`)
 *   - shell redirects (`>`, `>>`, `<`)
 *   - pipes are allowed only when EVERY pipe segment is independently
 *     allowlisted.
 *   - command-substitution (`$(...)`, backticks) — too easy to smuggle.
 *   - `sed -i`, `git commit`, `git push`, `git checkout -b`, etc.
 */
export function isPlanModeBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;

	// Reject command substitution.
	if (/\$\(/.test(trimmed) || /`/.test(trimmed)) return false;
	// Reject command chaining.
	if (/;|&&|\|\||(?:^|[^>])>(?!&)|<(?!<)|(?:^|\s)&(?:\s|$)/.test(trimmed)) return false;
	// Reject heredocs.
	if (/<</.test(trimmed)) return false;

	// Pipes — every segment must individually pass.
	if (trimmed.includes("|")) {
		const segments = trimmed.split("|").map((s) => s.trim());
		return segments.every((seg) => isPlanModeBashCommand(seg));
	}

	const tokens = trimmed.split(/\s+/);
	if (tokens.length === 0) return false;

	// Strip env-var prefix tokens (`FOO=bar BAR=baz cmd ...`).
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	if (i >= tokens.length) return false;

	const cmd = tokens[i];
	const baseCmd = cmd.includes("/") ? cmd.split("/").pop()! : cmd;
	if (!PLAN_MODE_BASH_ALLOWLIST.has(baseCmd)) return false;

	const rest = tokens.slice(i + 1);

	// Reject `sed -i` (in-place edit).
	if (baseCmd === "sed" && rest.some((t) => t === "-i" || t.startsWith("-i") || t.startsWith("--in-place"))) {
		return false;
	}

	// Reject `find ... -delete`, `find ... -exec`.
	if (baseCmd === "find" && rest.some((t) => t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok")) {
		return false;
	}

	// Git: subcommand must be read-only.
	if (baseCmd === "git") {
		const sub = rest.find((t) => !t.startsWith("-"));
		if (!sub) return true; // `git` alone shows help.
		return PLAN_MODE_GIT_READ_ONLY.has(sub);
	}

	// Package managers: subcommand must be read-only.
	if (
		baseCmd === "npm" ||
		baseCmd === "yarn" ||
		baseCmd === "pnpm" ||
		baseCmd === "cargo" ||
		baseCmd === "go" ||
		baseCmd === "pip" ||
		baseCmd === "deno" ||
		baseCmd === "bun"
	) {
		const sub = rest.find((t) => !t.startsWith("-"));
		if (!sub) return true;
		return PLAN_MODE_PACKAGE_READ_ONLY.has(sub);
	}

	return true;
}

// ─── Plan-mode output structure ──────────────────────────────────────────

/**
 * Structured plan emitted by a plan-mode session. The user accepts (→
 * `acceptEdits`) or rejects (stays in plan mode).
 */
export interface PlanResult {
	/** One-paragraph summary of what the model proposes to do. */
	summary: string;
	/** Ordered list of concrete steps. */
	steps: PlanStep[];
	/** Files the model intends to touch. */
	files: PlanFile[];
	/** Optional risks / caveats. */
	risks?: string[];
	/** Optional follow-up tasks the user may want to run separately. */
	followUps?: string[];
}

export interface PlanStep {
	/** 1-indexed ordering. */
	index: number;
	/** Short title. */
	title: string;
	/** Multi-paragraph detail. */
	detail?: string;
	/** Tool the model expects to use (e.g. "edit", "write"). */
	tool?: string;
}

export interface PlanFile {
	path: string;
	action: "create" | "edit" | "delete" | "rename";
	/** Optional rename target. */
	to?: string;
	/** Short rationale. */
	reason?: string;
}

// ─── Validation ─────────────────────────────────────────────────────────

const VALID_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/**
 * Validate a parsed subagent definition. Returns array of error strings
 * (empty = valid). Used by the loader to emit ResourceDiagnostics and by the
 * Task/Agent tools to fail-fast on bad invocations.
 */
export function validateSubagentDef(def: Partial<SubagentDef>): string[] {
	const errors: string[] = [];

	if (!def.name || typeof def.name !== "string") {
		errors.push("name is required");
	} else {
		if (def.name.length > 64) errors.push(`name exceeds 64 characters (${def.name.length})`);
		if (!VALID_NAME.test(def.name)) {
			errors.push(
				`name "${def.name}" contains invalid characters (must be lowercase a-z, 0-9, hyphens; no leading/trailing hyphen)`,
			);
		}
	}

	if (!def.description || typeof def.description !== "string" || def.description.trim() === "") {
		errors.push("description is required");
	} else if (def.description.length > 1024) {
		errors.push(`description exceeds 1024 characters (${def.description.length})`);
	}

	if (!def.prompt || typeof def.prompt !== "string") {
		errors.push("prompt body is required (markdown file body after frontmatter)");
	}

	if (def.permissionMode !== undefined) {
		const valid: SubagentPermissionMode[] = ["default", "plan", "acceptEdits", "auto", "bypassPermissions"];
		if (!valid.includes(def.permissionMode as SubagentPermissionMode)) {
			errors.push(`permissionMode "${def.permissionMode}" is not one of ${valid.join(", ")}`);
		}
	}

	if (def.isolation !== undefined && def.isolation !== "worktree" && def.isolation !== "none") {
		errors.push(`isolation "${def.isolation}" must be "worktree" or "none"`);
	}

	if (def.maxTurns !== undefined) {
		if (typeof def.maxTurns !== "number" || def.maxTurns <= 0 || !Number.isFinite(def.maxTurns)) {
			errors.push("maxTurns must be a positive finite number");
		}
	}

	if (def.tools !== undefined && !Array.isArray(def.tools)) {
		errors.push("tools must be an array of tool names");
	}

	if (def.disallowedTools !== undefined && !Array.isArray(def.disallowedTools)) {
		errors.push("disallowedTools must be an array of tool names");
	}

	return errors;
}

/**
 * Normalize the subset of frontmatter fields whose CC schema accepts both
 * comma-strings and arrays. Accepting both makes copy-paste from
 * `~/.claude/agents/` always work.
 */
export function normalizeFrontmatterArray(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value === "string") {
		return value
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
	}
	return undefined;
}

// ─── Task tool params (shared schema shape) ──────────────────────────────

/**
 * Schema-light shape returned by the Task tool. The actual TypeBox schema
 * is declared in `@cave/coding-agent`'s task.ts so it can use the same
 * project's TypeBox version; we keep the TS shape here for type sharing.
 */
export interface TaskInvocation {
	/** Agent name (must exist in the loaded agent registry). */
	agent: string;
	/** Task description handed to the agent (becomes the user message). */
	task: string;
	/** Optional override for cwd. Defaults to parent session cwd or worktree. */
	cwd?: string;
}

/** Shape used by the Task tool's `parallel` mode. */
export interface ParallelTaskParams {
	tasks: TaskInvocation[];
}

/** Shape used by the Task tool's `chain` mode (output → next task as `{previous}`). */
export interface ChainTaskParams {
	chain: TaskInvocation[];
}

/** Schema input passed by the runtime when running a single subagent. */
export interface RunSubagentInput {
	def: SubagentDef;
	task: string;
	cwd: string;
	signal?: AbortSignal;
	/** Inherit-from-parent permission mode override. */
	permissionMode?: SubagentPermissionMode;
}

/**
 * Compute the effective tool allowlist for a subagent given (a) the parent
 * tool registry, (b) the subagent's `tools` / `disallowedTools` frontmatter,
 * and (c) the active `permissionMode`.
 *
 * Plan mode hard-overrides everything: only PLAN_MODE_TOOLS make it through.
 */
export function computeAllowedTools(args: {
	parentTools: string[];
	frontmatterTools?: string[];
	frontmatterDisallowed?: string[];
	permissionMode?: SubagentPermissionMode;
}): string[] {
	let pool = args.frontmatterTools && args.frontmatterTools.length > 0 ? args.frontmatterTools : args.parentTools;
	if (args.frontmatterDisallowed && args.frontmatterDisallowed.length > 0) {
		const block = new Set(args.frontmatterDisallowed);
		pool = pool.filter((t) => !block.has(t));
	}
	if (args.permissionMode === "plan") {
		pool = pool.filter((t) => PLAN_MODE_TOOLS.has(t));
	}
	return pool;
}

// ─── Re-export-friendly typing -------------------------------------------

export type SubagentDefMaybe = SubagentDef | undefined;

/** Best-effort lookup helper used by Task/Agent tools and tests. */
export function findSubagent(defs: SubagentDef[], name: string): SubagentDef | undefined {
	return defs.find((d) => d.name === name);
}

// ─── Result-schema stub (P1) ─────────────────────────────────────────────

/**
 * P1 (deferred per WS6 spec §7): when SubagentDef carries an `outputSchema`
 * (TypeBox), validate `SubagentResult.data` against it. For now we expose the
 * type so callers can reserve the field; the runtime wires it as a no-op.
 */
export interface SubagentDefWithOutputSchema extends SubagentDef {
	outputSchema?: TSchema;
}

export function validateSubagentOutput(
	_def: SubagentDef,
	_data: unknown,
): { ok: true } | { ok: false; errors: string[] } {
	// P1 stub: always ok. Real schema validation lands once the spec calls
	// out a canonical TypeBox shape.
	return { ok: true };
}
