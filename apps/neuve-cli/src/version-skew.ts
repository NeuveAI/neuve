import {
  appendFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isCompiled } from "@neuve/harness/compiled";

export { isCompiled } from "@neuve/harness/compiled";

/**
 * Version skew between a neuve build and a repository's store, as one sentence and a marker file.
 *
 * Only a process that opens the store can see the skew, and hooks never open SQLite (D18). So the
 * worker, when the version gate refuses it, and `records migrate`, when it leaves the installed copy
 * behind a breaking migration, write `<store>/version-skew.json`. Since 12.24 that is the only skew
 * that pauses capture: an older build uses a newer store in compatibility mode. Hooks read it: they keep spooling, write one line to the
 * worker log and hold off starting a worker that would refuse again, until the binary is replaced or
 * a retry window passes. `neuve jobs` and `neuve worker status` print it. A worker that passes the
 * gate removes it. This module loads no Records code, so the hook entry stays small.
 */

export const skewPath = (storeDirectory: string) =>
  join(storeDirectory, "version-skew.json");

/** How long hooks hold off starting a worker the marker says would refuse; then one retries. */
export const SKEW_RETRY_MS = 10 * 60_000;

const FileIdentity = z.object({
  dev: z.number(),
  ino: z.number(),
  size: z.number(),
  mtimeMs: z.number(),
});
type FileIdentity = z.infer<typeof FileIdentity>;

/** Non-strict, so a marker from a newer build still reads. */
export const SkewMarker = z.object({
  version: z.literal(1),
  /** `copy-older`: the build is older than the store; `store-older`: the store needs a migrate. */
  kind: z.enum(["copy-older", "store-older"]),
  at: z.string(),
  by: z.enum(["worker", "migrate"]),
  /** The real path of the executable the refusal is about: the compiled neuve, or bun. */
  binary: z.string(),
  identity: FileIdentity,
  message: z.string(),
});
export type SkewMarker = z.infer<typeof SkewMarker>;

export interface Refusal {
  readonly kind: SkewMarker["kind"];
  readonly message: string;
}

/** A refusal as a sentence on its own, for a command's error output. */
export const refusalSentence = (refusal: Refusal) =>
  `${refusal.message[0]!.toUpperCase()}${refusal.message.slice(1)}.`;

const numberField = (value: unknown, key: string) => {
  const field =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof field === "number" ? field : undefined;
};

/**
 * The version gate's refusals as one sentence naming the versions and what fixes it; anything else
 * is undefined. `installed` says whether this build is an installed copy. Since 12.24 the only
 * refusal is WriterTooOld: a breaking migration raised the store's minimum writer above this build,
 * and the fix is a build at that writer or newer. StoreNewer and MigrationRequired are kept for
 * errors raised elsewhere; their advice never asks for a step that would lock another build out.
 */
export const refusalFrom = (
  error: unknown,
  installed = isCompiled(),
): Refusal | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error))
    return undefined;
  const tagged = error as { _tag: unknown } & Record<string, unknown>;
  const who = installed ? "the installed neuve" : "this neuve checkout";
  const older = (label: string, have: number, needs: number): Refusal => ({
    kind: "copy-older",
    message: `${who} (${label} ${have}) is older than this store (needs ${label === "writer" ? "" : `${label} `}${needs}); ${
      installed
        ? `install a build with ${label} ${needs} or newer: run \`bun run install:cli --dry-run\`, then \`bun run install:cli\`, from a clean checkout of an integration branch that has it`
        : `use a build with ${label} ${needs} or newer: update this checkout, or use an installed neuve that has it`
    }`,
  });
  switch (tagged._tag) {
    case "WriterTooOld": {
      const have = numberField(tagged, "writerVersion");
      const needs = numberField(tagged, "minWriterVersion");
      return have === undefined || needs === undefined
        ? undefined
        : older("writer", have, needs);
    }
    case "StoreNewer": {
      const stored = tagged["stored"];
      const current = tagged["current"];
      const storedProjector = numberField(stored, "projectorVersion");
      const currentProjector = numberField(current, "projectorVersion");
      const storedSchema = numberField(stored, "schemaVersion");
      const currentSchema = numberField(current, "schemaVersion");
      if (
        storedProjector !== undefined &&
        currentProjector !== undefined &&
        storedProjector > currentProjector
      )
        return older("projector", currentProjector, storedProjector);
      return storedSchema === undefined || currentSchema === undefined
        ? undefined
        : older("schema", currentSchema, storedSchema);
    }
    case "MigrationRequired": {
      const stored = tagged["stored"];
      const current = tagged["current"];
      const storedSchema = numberField(stored, "schemaVersion");
      const currentSchema = numberField(current, "schemaVersion");
      // An unfinished initialization (no stored versions) is not skew.
      if (storedSchema === undefined || currentSchema === undefined)
        return undefined;
      // Migrating keeps the store open to older builds unless a migration declares them unsafe.
      return {
        kind: "store-older",
        message: `this store (schema ${storedSchema}, projector ${numberField(stored, "projectorVersion") ?? "?"}) is older than ${who} (schema ${currentSchema}, projector ${numberField(current, "projectorVersion") ?? "?"}); any \`neuve records\` command from ${installed ? "it" : "this checkout"} migrates it after a backup copy, as does \`neuve records migrate\``,
      };
    }
    default:
      return undefined;
  }
};

const identityOf = (path: string): FileIdentity | undefined => {
  try {
    const stats = statSync(path);
    return {
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return undefined;
  }
};

const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** The executable this process runs as: the compiled neuve, or bun for a checkout. */
export const currentBinary = () =>
  realPath(process.execPath) ?? process.execPath;

export const readSkew = (storeDirectory: string): SkewMarker | undefined => {
  try {
    const parsed = SkewMarker.safeParse(
      JSON.parse(readFileSync(skewPath(storeDirectory), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** Writes the marker beside the store, atomically. Never throws: a marker must not add a failure. */
export const writeSkew = (
  storeDirectory: string,
  input: Readonly<{
    refusal: Refusal;
    by: SkewMarker["by"];
    binary: string;
  }>,
): SkewMarker | undefined => {
  const binary = realPath(input.binary) ?? input.binary;
  const identity = identityOf(binary);
  if (identity === undefined) return undefined;
  const marker: SkewMarker = {
    version: 1,
    kind: input.refusal.kind,
    at: new Date().toISOString(),
    by: input.by,
    binary,
    identity,
    message: input.refusal.message,
  };
  const path = skewPath(storeDirectory);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
    return marker;
  } catch {
    rmSync(temporary, { force: true });
    return undefined;
  }
};

/** Removes the marker when it is about `binary`, which has just passed the version gate. */
export const clearSkew = (storeDirectory: string, binary = currentBinary()) => {
  const marker = readSkew(storeDirectory);
  if (marker === undefined || marker.binary !== (realPath(binary) ?? binary))
    return false;
  rmSync(skewPath(storeDirectory), { force: true });
  return true;
};

export type SkewState =
  /** The marker's binary is still the one on disk, so it would refuse again. */
  | "current"
  /** The binary at that path was replaced since (a reinstall), so it may now pass. */
  | "replaced";

export const skewState = (marker: SkewMarker): SkewState => {
  const now = identityOf(marker.binary);
  return now !== undefined &&
    now.dev === marker.identity.dev &&
    now.ino === marker.identity.ino &&
    now.size === marker.identity.size &&
    now.mtimeMs === marker.identity.mtimeMs
    ? "current"
    : "replaced";
};

const spooledCount = (spool: string) => {
  try {
    return readdirSync(spool).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

/**
 * For a hook that has just spooled its events: whether to hold off starting the worker `command`
 * would run, because the marker says that binary refuses this store and it has not been replaced,
 * and the marker is younger than the retry window. When it holds, it writes one line to the worker
 * log. It never throws.
 */
export const holdWorkerStart = (
  location: Readonly<{ directory: string; spool: string }>,
  command: ReadonlyArray<string>,
  workerLog: string,
  now = Date.now(),
): boolean => {
  try {
    const marker = readSkew(location.directory);
    const executable = command[0];
    if (marker === undefined || executable === undefined) return false;
    if ((realPath(executable) ?? executable) !== marker.binary) return false;
    if (skewState(marker) !== "current") return false;
    // A time that does not parse, or lies in the future, counts as expired, so a bad clock or a
    // damaged marker can never hold the worker off for good.
    const at = Date.parse(marker.at);
    if (!Number.isFinite(at) || at > now || now - at >= SKEW_RETRY_MS)
      return false;
    appendFileSync(
      workerLog,
      `${new Date(now).toISOString()} hook[${process.pid}] WARN    capture paused: ${marker.message}; ${spooledCount(location.spool)} event(s) wait in the spool\n`,
    );
    return true;
  } catch {
    return false;
  }
};

/** Whether this repository's `<store>/capture.json` starts its worker with `binary`. */
const captureRuns = (storeDirectory: string, binary: string) => {
  try {
    const config = JSON.parse(
      readFileSync(join(storeDirectory, "capture.json"), "utf8"),
    ) as { command?: unknown };
    const executable = Array.isArray(config.command)
      ? config.command[0]
      : undefined;
    return (
      typeof executable === "string" &&
      (realPath(executable) ?? executable) === binary
    );
  } catch {
    return false;
  }
};

/**
 * The line `neuve jobs` and `neuve worker status` print for the marker, if there is one. It speaks
 * of paused capture only when this repository's capture starts its worker with the marker's binary.
 */
export const describeSkew = (
  location: Readonly<{ directory: string; spool: string }>,
): string | undefined => {
  const marker = readSkew(location.directory);
  if (marker === undefined) return undefined;
  const current = skewState(marker) === "current";
  if (!captureRuns(location.directory, marker.binary))
    return current
      ? `${marker.binary} refuses this store since ${marker.at}: ${marker.message}.`
      : `${marker.binary} refused this store at ${marker.at} (${marker.message}), but has been replaced since.`;
  const waiting = spooledCount(location.spool);
  return current
    ? `capture is paused since ${marker.at}: ${marker.message}. ${waiting} event(s) wait in the spool; hooks keep spooling.`
    : `capture was paused at ${marker.at} (${marker.message}), but ${marker.binary} has been replaced since; the next hook or \`neuve worker start\` resumes it. ${waiting} event(s) wait in the spool.`;
};
