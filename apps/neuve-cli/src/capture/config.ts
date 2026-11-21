import { join } from "node:path";
import { z } from "zod";
import { Identity, type StoreLocation } from "@neuve/records-core/capture";

/**
 * `<store>/capture.json`, written by `neuve setup hooks`. Its presence is what enables capture in a
 * repository: agent hooks are installed once per user, so they fire in every repository and exit at
 * once wherever this file is absent. That keeps capture to the repositories set up for it.
 */
export const CaptureConfig = z.strictObject({
  version: z.literal(1),
  /** The CLI, as argv, that starts the worker (`<command> worker run`). */
  command: z.array(z.string().min(1)).min(1),
  /** What hooks run, as argv, ahead of `<harness> <event>`. */
  hookCommand: z.array(z.string().min(1)).min(1),
  gitHooks: z.array(z.string().min(1)),
  agents: z.array(z.enum(Identity.AGENT_HARNESSES)),
  /** Opt-in `Neuve-Session` commit trailer; off by default and refused in this repository (8.1). */
  sessionTrailer: z.boolean(),
});
export type CaptureConfig = z.infer<typeof CaptureConfig>;

export const captureConfigPath = (location: StoreLocation) =>
  join(location.directory, "capture.json");

export const readCaptureConfig = async (
  location: StoreLocation,
): Promise<CaptureConfig | undefined> => {
  const file = Bun.file(captureConfigPath(location));
  if (!(await file.exists())) return undefined;
  // A file that isn't JSON is read as one that doesn't match: no config, never a throw.
  const parsed = CaptureConfig.safeParse(
    await file.json().catch(() => undefined),
  );
  return parsed.success ? parsed.data : undefined;
};

/** Hook failures go here: hooks exit 0 so an agent or a commit is never blocked, but nothing is silent. */
export const hookLogPath = (location: StoreLocation) =>
  join(location.directory, "hooks.log");
