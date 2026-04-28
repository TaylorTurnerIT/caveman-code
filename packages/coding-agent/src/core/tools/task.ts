/**
 * `Task` built-in tool — fan-out subagent orchestration with parallel + chain
 * modes and worktree isolation.
 *
 * Provenance:
 *   - Borrowed from pi-code's `examples/extensions/subagent/index.ts`
 *     (vendored shape: spawn-cave-as-subprocess, JSON-mode parsing, parallel
 *     concurrency limit). Extended for WS6 with:
 *       * `.cave/agents/<name>.md` discovery (loader.ts)
 *       * `isolation: worktree` via `git worktree add .cave/worktrees/<id>`
 *       * 7 parallel cap (Claude Code parity)
 *       * permissionMode passthrough (plan mode wired)
 *       * structured `SubagentResult` envelope
 *
 * Modes (exactly one must be set per call):
 *   - single   { agent, task }                  → run one agent
 *   - parallel { tasks: [{agent, task}] }       → fan out, concurrency-limited
 *   - chain    { chain: [{agent, task}] }       → sequential, output → next
 *
 * Hard caps:
 *   - MAX_PARALLEL_SUBAGENTS = 7  (plan §6 — matches Claude Code)
 *   - MAX_CONCURRENCY = 4         (CPU safety)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	autoCleanupWorktree,
	type CreateWorktreeResult,
	createWorktree,
	detectRepoRoot,
	MAX_PARALLEL_SUBAGENTS,
	type SubagentDef,
	type SubagentResult,
	sanitizeId,
} from "@cave/agent";
import { Text } from "@cave/tui";
import { type Static, Type } from "@sinclair/typebox";
import { findAgentDef, formatAgentList, type LoadAgentDefsResult, loadAgentDefs } from "../agent-defs/loader.js";
import type { ToolDefinition } from "../extensions/types.js";

const MAX_CONCURRENCY = 4;

// ─── Schema ───────────────────────────────────────────────────────────────

const TaskItemSchema = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke (must exist in .cave/agents/)" }),
	task: Type.String({ description: "Task description handed to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Override working directory for this invocation" })),
});

const ChainItemSchema = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task; use {previous} to splice prior agent's output" }),
	cwd: Type.Optional(Type.String({ description: "Override working directory" })),
});

const TaskSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single-mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single-mode: task description" })),
	cwd: Type.Optional(Type.String({ description: "Single-mode: override working directory" })),
	tasks: Type.Optional(Type.Array(TaskItemSchema, { description: "Parallel mode: array of {agent,task}" })),
	chain: Type.Optional(
		Type.Array(ChainItemSchema, { description: "Chain mode: sequential {agent,task}, {previous} substituted" }),
	),
});

export type TaskToolInput = Static<typeof TaskSchema>;

// ─── Details (returned for renderer / observability) ──────────────────────

export interface TaskToolDetails {
	mode: "single" | "parallel" | "chain";
	results: SubagentResult[];
}

// ─── Spawning a child cave process for a subagent ─────────────────────────

interface SpawnOptions {
	cwd: string;
	agent: SubagentDef;
	task: string;
	signal?: AbortSignal;
	caveBin?: string;
	/** Inject a fake spawner for tests. */
	mockSpawn?: typeof spawn;
}

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	finalText: string;
}

/**
 * Resolve which cave executable to spawn. Mirrors pi-code's subagent
 * `getPiInvocation` pattern — prefer the current process binary (so tests
 * with tsx run with tsx; production runs with node + dist), falling back to
 * `cave` on PATH.
 */
function resolveCaveInvocation(args: string[], caveBin?: string): { command: string; args: string[] } {
	if (caveBin) return { command: caveBin, args };
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "cave", args };
}

/**
 * Spawn a single cave child process for `agent` with `task` as the prompt.
 * Returns aggregated stdout/stderr + the final assistant text from the
 * JSON-stream output.
 *
 * P0: relies on JSON-mode events. P1 (deferred): structured tool-call telemetry
 * with live updates back to the parent renderer.
 */
async function spawnSubagent(opts: SpawnOptions): Promise<SpawnResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (opts.agent.model) args.push("--model", opts.agent.model);
	if (opts.agent.tools && opts.agent.tools.length > 0) args.push("--tools", opts.agent.tools.join(","));
	if (opts.agent.permissionMode) args.push("--permission-mode", opts.agent.permissionMode);

	let tmpDir: string | null = null;
	let promptPath: string | null = null;
	if (opts.agent.prompt && opts.agent.prompt.trim()) {
		tmpDir = mkdtempSync(join(tmpdir(), "cave-subagent-"));
		promptPath = join(tmpDir, `${opts.agent.name}.md`);
		writeFileSync(promptPath, opts.agent.prompt, { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", promptPath);
	}

	args.push(`Task: ${opts.task}`);

	const invocation = resolveCaveInvocation(args, opts.caveBin);
	const spawner = opts.mockSpawn ?? spawn;

	let stdout = "";
	let stderr = "";
	let finalText = "";

	const exitCode = await new Promise<number>((resolve) => {
		const child = spawner(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buf = "";
		const flushLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const content = event.message.content;
					if (Array.isArray(content)) {
						for (const part of content) {
							if (part?.type === "text" && typeof part.text === "string") {
								finalText = part.text;
							}
						}
					}
				}
			} catch {
				/* ignore non-JSON line */
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			const s = chunk.toString("utf-8");
			stdout += s;
			buf += s;
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const ln of lines) flushLine(ln);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("close", (code: number | null) => {
			if (buf.trim()) flushLine(buf);
			resolve(code ?? 0);
		});
		child.on("error", () => resolve(1));
		if (opts.signal) {
			const kill = () => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				setTimeout(() => {
					try {
						if (!child.killed) child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, 5000);
			};
			if (opts.signal.aborted) kill();
			else opts.signal.addEventListener("abort", kill, { once: true });
		}
	});

	if (promptPath) {
		try {
			rmSync(promptPath);
		} catch {
			/* ignore */
		}
	}
	if (tmpDir) {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	return { exitCode, stdout, stderr, finalText };
}

// ─── Worktree isolation orchestration ─────────────────────────────────────

async function maybeCreateWorktree(
	def: SubagentDef,
	parentCwd: string,
	id: string,
): Promise<{ cwd: string; worktree?: CreateWorktreeResult }> {
	if (def.isolation !== "worktree") return { cwd: parentCwd };
	const repoRoot = await detectRepoRoot(parentCwd);
	if (!repoRoot) {
		// Outside a git repo — silently fall back to shared cwd.
		return { cwd: parentCwd };
	}
	try {
		const wt = await createWorktree({ repoRoot, id });
		return { cwd: wt.worktreeDir, worktree: wt };
	} catch {
		// Fall back to shared cwd if worktree creation fails (e.g. offline mirror).
		return { cwd: parentCwd };
	}
}

async function maybeCleanupWorktree(
	parentCwd: string,
	worktree: CreateWorktreeResult | undefined,
): Promise<boolean | undefined> {
	if (!worktree) return undefined;
	const repoRoot = await detectRepoRoot(parentCwd);
	if (!repoRoot) return undefined;
	const result = await autoCleanupWorktree({
		repoRoot,
		worktreeDir: worktree.worktreeDir,
		branchName: worktree.branchName,
		baseRef: worktree.baseRef,
	});
	return result.cleaned;
}

// ─── Single agent invocation core (used by all 3 modes) ───────────────────

async function runOne(
	loaded: LoadAgentDefsResult,
	agentName: string,
	task: string,
	parentCwd: string,
	cwdOverride: string | undefined,
	signal: AbortSignal | undefined,
	options: { caveBin?: string; mockSpawn?: typeof spawn; idSuffix?: string } = {},
): Promise<SubagentResult> {
	const found = findAgentDef(loaded, agentName);
	if (!found) {
		return {
			agent: agentName,
			source: "user",
			task,
			output: "",
			exitCode: 1,
			error: `Unknown agent "${agentName}".\nAvailable:\n${formatAgentList(loaded)}`,
		};
	}
	const id = sanitizeId(`${agentName}-${Date.now().toString(36)}${options.idSuffix ? `-${options.idSuffix}` : ""}`);
	const wt = await maybeCreateWorktree(found.def, cwdOverride ?? parentCwd, id);
	const startCwd = wt.cwd;

	let spawnRes: SpawnResult;
	try {
		spawnRes = await spawnSubagent({
			cwd: startCwd,
			agent: found.def,
			task,
			signal,
			caveBin: options.caveBin,
			mockSpawn: options.mockSpawn,
		});
	} catch (err) {
		const cleaned = await maybeCleanupWorktree(parentCwd, wt.worktree);
		return {
			agent: agentName,
			source: found.def.source,
			task,
			output: "",
			exitCode: 1,
			error: (err as Error).message,
			worktreeDir: wt.worktree?.worktreeDir,
			branchName: wt.worktree?.branchName,
			worktreeCleaned: cleaned,
		};
	}

	const cleaned = await maybeCleanupWorktree(parentCwd, wt.worktree);
	return {
		agent: agentName,
		source: found.def.source,
		task,
		output: spawnRes.finalText,
		exitCode: spawnRes.exitCode,
		error: spawnRes.exitCode !== 0 ? spawnRes.stderr.trim() || `exit ${spawnRes.exitCode}` : undefined,
		worktreeDir: wt.worktree?.worktreeDir,
		branchName: wt.worktree?.branchName,
		worktreeCleaned: cleaned,
	};
}

// ─── Concurrency-limited mapper ───────────────────────────────────────────

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const cap = Math.max(1, Math.min(limit, items.length));
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = new Array(cap).fill(0).map(async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}

// ─── Tool factory ─────────────────────────────────────────────────────────

export interface TaskToolOptions {
	/** Override the cave binary used to spawn subagents. */
	caveBin?: string;
	/** Inject a fake spawner for tests. */
	mockSpawn?: typeof spawn;
	/** Override the loader (test injection). */
	loader?: () => LoadAgentDefsResult;
}

export function createTaskToolDefinition(
	cwd: string,
	options?: TaskToolOptions,
): ToolDefinition<typeof TaskSchema, TaskToolDetails | undefined> {
	const loader = options?.loader ?? (() => loadAgentDefs({ cwd }));
	return {
		name: "task",
		label: "Task",
		description: [
			"Delegate work to specialized subagents loaded from .cave/agents/<name>.md.",
			"Modes: single (agent + task), parallel (tasks: [{agent,task}]), chain (chain: [{agent,task}], {previous} substituted).",
			`Up to ${MAX_PARALLEL_SUBAGENTS} parallel subagents.`,
			"Subagents inherit cwd by default; agents with `isolation: worktree` get a fresh git worktree.",
			"Subagents run with their own permission mode (e.g. `plan` for read-only exploration).",
		].join(" "),
		promptSnippet: `Spawn up to ${MAX_PARALLEL_SUBAGENTS} parallel subagents`,
		parameters: TaskSchema,
		async execute(_id, params: TaskToolInput, signal) {
			const loaded = loader();
			const hasSingle = !!(params.agent && params.task);
			const hasParallel = !!(params.tasks && params.tasks.length > 0);
			const hasChain = !!(params.chain && params.chain.length > 0);
			const modeCount = (hasSingle ? 1 : 0) + (hasParallel ? 1 : 0) + (hasChain ? 1 : 0);
			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Task tool requires EXACTLY one of: agent+task / tasks / chain.\n` +
								`Available agents:\n${formatAgentList(loaded)}`,
						},
					],
					details: undefined,
				};
			}

			if (hasParallel && params.tasks!.length > MAX_PARALLEL_SUBAGENTS) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Task tool: too many parallel tasks (${params.tasks!.length}). Maximum is ${MAX_PARALLEL_SUBAGENTS}.`,
						},
					],
					details: { mode: "parallel" as const, results: [] },
				};
			}

			if (hasSingle) {
				const r = await runOne(loaded, params.agent!, params.task!, cwd, params.cwd, signal, {
					caveBin: options?.caveBin,
					mockSpawn: options?.mockSpawn,
				});
				const text =
					r.exitCode === 0
						? r.output || "(no output)"
						: `Subagent failed: ${r.error || r.output || "(no output)"}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { mode: "single" as const, results: [r] },
				};
			}

			if (hasParallel) {
				const results = await mapWithLimit(params.tasks!, MAX_CONCURRENCY, (t, idx) =>
					runOne(loaded, t.agent, t.task, cwd, t.cwd, signal, {
						caveBin: options?.caveBin,
						mockSpawn: options?.mockSpawn,
						idSuffix: String(idx),
					}),
				);
				const ok = results.filter((r) => r.exitCode === 0).length;
				const summary = results.map(
					(r) => `[${r.agent}] ${r.exitCode === 0 ? "OK" : "FAIL"}: ${r.output.slice(0, 80)}`,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Parallel: ${ok}/${results.length} succeeded\n\n${summary.join("\n")}`,
						},
					],
					details: { mode: "parallel" as const, results },
				};
			}

			// chain
			const results: SubagentResult[] = [];
			let prev = "";
			for (let i = 0; i < params.chain!.length; i++) {
				const step = params.chain![i];
				const taskWithPrev = step.task.replace(/\{previous\}/g, prev);
				const r = await runOne(loaded, step.agent, taskWithPrev, cwd, step.cwd, signal, {
					caveBin: options?.caveBin,
					mockSpawn: options?.mockSpawn,
					idSuffix: `chain-${i}`,
				});
				results.push(r);
				if (r.exitCode !== 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Chain stopped at step ${i + 1} (${step.agent}): ${r.error || r.output || "(no output)"}`,
							},
						],
						details: { mode: "chain" as const, results },
					};
				}
				prev = r.output;
			}
			const last = results[results.length - 1];
			return {
				content: [{ type: "text" as const, text: last?.output || "(no output)" }],
				details: { mode: "chain" as const, results },
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("task "));
			if (args.chain && args.chain.length > 0) {
				text += theme.fg("accent", `chain (${args.chain.length} steps)`);
			} else if (args.tasks && args.tasks.length > 0) {
				text += theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
			} else if (args.agent) {
				text += theme.fg("accent", args.agent);
				const preview = args.task ? args.task.slice(0, 60) : "...";
				text += theme.fg("dim", ` ${preview}`);
			} else {
				text += theme.fg("dim", "(invalid)");
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TaskToolDetails | undefined;
			if (!details || details.results.length === 0) {
				const c = result.content[0];
				return new Text(c?.type === "text" ? c.text : "(no output)", 0, 0);
			}
			const ok = details.results.filter((r) => r.exitCode === 0).length;
			const head = `${theme.fg(ok === details.results.length ? "success" : "error", "task")} ${theme.fg(
				"toolOutput",
				`${ok}/${details.results.length}`,
			)}`;
			const lines = details.results.map((r) => {
				const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
				return `${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", r.output.slice(0, 80))}`;
			});
			return new Text([head, ...lines].join("\n"), 0, 0);
		},
	};
}

export const taskToolDefinition = createTaskToolDefinition(process.cwd());

// Re-export the schema type for callers.
export { TaskSchema };
