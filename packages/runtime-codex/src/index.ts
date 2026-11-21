import { Effect } from "effect";
import { processLayer } from "./production.ts";
import {
  discoverCodex,
  makeRuntime,
  type CodexRuntimeConfig,
} from "./runtime.ts";
export * from "./client.ts";
export * from "./errors.ts";
export { CodexProcess, type CodexChild, type CodexExit } from "./services.ts";
export { processLayer } from "./production.ts";
export { RELEASE } from "./generated/methods.ts";
export {
  capabilities,
  openCodexSession,
  type CodexSessionOptions,
} from "./session.ts";
export { appendTo, type LogEntry } from "./log.ts";
export { judge, versionOf, type Verdict } from "./version.ts";
export {
  discoverCodex,
  makeRuntime,
  unavailable,
  type CodexRuntimeConfig,
} from "./runtime.ts";
export {
  appsLookedFor,
  discoveryCandidates,
  findCodex,
  inApps,
  onPath,
  PROGRAM,
  runtimeCandidates,
} from "./program.ts";

/** Builds the production runtime. Construction starts no program and makes no model request. */
export const codexRuntime = (config: CodexRuntimeConfig = {}) =>
  makeRuntime(config).pipe(Effect.provide(processLayer));

/** Discovery with the production process service: run once, when a person asks. */
export const findCodexProgram = (
  config: Parameters<typeof discoverCodex>[0] = {},
) => discoverCodex(config).pipe(Effect.provide(processLayer));
