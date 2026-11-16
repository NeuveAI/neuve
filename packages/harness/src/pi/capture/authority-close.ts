import { preserveUnknown, safeRead } from "@neuve/records-schema";
import {
  openSync,
  existsSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  fsyncSync,
  fstatSync,
  constants,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorityFailureKind } from "./private-inspection.ts";

export const AUTHORITY_UNAVAILABLE =
  "historical credential authority is unavailable; source retained privately, export refused";
export type AuthorityRefusal = typeof AUTHORITY_UNAVAILABLE;
export interface AuthorityCloseFailure {
  readonly cause: unknown;
}
export const AUTHORITY_CLOSE_ATTEMPTS = 3;
export const AUTHORITY_CLOSE_MIN_AGE_MS = 10 * 60_000;
const Attempts = z.strictObject({
  capture: z.string().regex(/^capture\.filed:[a-f0-9]{64}$/),
  failures: z.int().min(1).max(AUTHORITY_CLOSE_ATTEMPTS),
  firstFailureAt: z.int().nonnegative(),
});
const retryPath = (source: string) =>
  join(source, ".capture-authority-failures.json");

export const clearAuthorityCloseFailures = (source: string) => {
  const path = retryPath(source);
  if (existsSync(path)) {
    try {
      const stored = safeRead(
        Attempts,
        JSON.parse(readFileSync(path, "utf8")),
        { source: path },
      );
      if (!stored.success || stored.droppedKeys.length > 0) return;
    } catch {
      return;
    }
  }
  rmSync(path, { force: true });
  const descriptor = openSync(source, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

/** Source ownership serializes closes; a brief burst never exhausts a capture's own retry window. */
export const authorityCloseRefusal = (
  source: string,
  capture: string,
  error: unknown,
  now: number,
): AuthorityRefusal => {
  if (authorityFailureKind(error) === "uncertified")
    return AUTHORITY_UNAVAILABLE;
  const path = retryPath(source);
  let previous: z.infer<typeof Attempts> | undefined;
  let stored: unknown;
  try {
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size > 1024)
        throw new Error("invalid capture retry state");
      stored = JSON.parse(readFileSync(descriptor, "utf8"));
      const parsed = safeRead(Attempts, stored, { source: path });
      if (!parsed.success) throw error;
      if (parsed.success && parsed.data.capture === capture)
        previous = parsed.data;
    } finally {
      closeSync(descriptor);
    }
  } catch (cause) {
    if (
      !(cause instanceof Error && "code" in cause && cause.code === "ENOENT") &&
      !(cause instanceof SyntaxError)
    )
      throw error;
  }
  const record = {
    capture,
    failures: Math.min(AUTHORITY_CLOSE_ATTEMPTS, (previous?.failures ?? 0) + 1),
    firstFailureAt: Math.min(previous?.firstFailureAt ?? now, now),
  };
  const exhausted =
    record.failures >= AUTHORITY_CLOSE_ATTEMPTS &&
    now - record.firstFailureAt >= AUTHORITY_CLOSE_MIN_AGE_MS;
  const temporary = path + "." + randomUUID();
  try {
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(
        descriptor,
        JSON.stringify(
          stored === undefined
            ? record
            : preserveUnknown(Attempts, stored, record, { source: path }),
        ),
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    const directory = openSync(source, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Unrecorded failures never authorize filing. Run-folder retention supplies the outer bound.
    throw error;
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {}
  }
  if (!exhausted) throw error;
  return AUTHORITY_UNAVAILABLE;
};
