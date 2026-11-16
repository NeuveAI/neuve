import { Effect } from "effect";
import type { RuntimeShape } from "@neuve/runtime";
import { executableLayer, processLayer, sdkLayer } from "./production.ts";
import { makeRuntime, type ClaudeRuntimeConfig } from "./runtime.ts";

export type { ClaudeRuntimeConfig } from "./runtime.ts";
export { childEnvironment, REMOVED_ENVIRONMENT } from "./environment.ts";
/** Builds the production runtime. Construction starts no child and makes no model request. */
export const claudeRuntime = (
  config: ClaudeRuntimeConfig,
): Effect.Effect<RuntimeShape> =>
  makeRuntime(config).pipe(
    Effect.provide(sdkLayer),
    Effect.provide(executableLayer),
    Effect.provide(processLayer),
  );
