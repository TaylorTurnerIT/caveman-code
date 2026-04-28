/**
 * WS9 Daemon — public surface.
 *
 * Re-exports the server, client, and protocol shapes. The CLI subcommands
 * (`cave serve`, `cave attach`, `cave list`, `cave worker`) consume from
 * here.
 */

export * from "./protocol.js";
export { type SessionStore, openStore, SqliteSessionStore } from "./store.js";
export {
	type AgentRunner,
	type DaemonHandle,
	type DaemonOptions,
	type RunnerEmitter,
	type RunnerEvent,
	type RunnerFactory,
	startDaemon,
} from "./server.js";
export { AttachedSession, CaveClient, type ClientOptions } from "./client.js";
export { createDefaultRunnerFactory } from "./runner.js";
