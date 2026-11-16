import { safeRead } from "@neuve/records-schema";
import {
  mkdtempSync,
  renameSync,
  rmSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { z } from "zod";
const Owner = z.strictObject({
  pid: z.int().positive().max(2147483647),
  job: z
    .strictObject({ seq: z.int().positive(), attempt: z.int().nonnegative() })
    .optional(),
});
export type CaptureStagingJob = NonNullable<z.infer<typeof Owner>["job"]>;
const OWNER_FILE = ".capture-owner.json";
export const writeCaptureOwner = (directory: string, job?: CaptureStagingJob) =>
  writeFileSync(
    join(directory, OWNER_FILE),
    JSON.stringify({ pid: process.pid, job }),
    { mode: 0o600, flag: "wx" },
  );
export const captureStagingOwner = (directory: string) => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      join(directory, OWNER_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 1024) return { kind: "newer" as const };
    const parsed = safeRead(
      Owner,
      JSON.parse(readFileSync(descriptor, "utf8")),
      { source: join(directory, OWNER_FILE) },
    );
    return parsed.success && parsed.droppedKeys.length === 0
      ? { kind: "known" as const, ...parsed.data }
      : { kind: "newer" as const };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    if (error instanceof SyntaxError) return { kind: "newer" as const };
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
export const captureStagingProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    return true;
  }
};

/** Publish ownership before a folder can receive raw bytes or be observed by a sweep. */
export const createCaptureStaging = (
  prefix: string,
  job?: CaptureStagingJob,
) => {
  const unpublished = mkdtempSync(join(dirname(prefix), ".capture-staging-"));
  const directory =
    prefix + basename(unpublished).slice(".capture-staging-".length);
  try {
    writeCaptureOwner(unpublished, job);
    renameSync(unpublished, directory);
    return directory;
  } catch (error) {
    rmSync(unpublished, { recursive: true, force: true });
    throw error;
  }
};
