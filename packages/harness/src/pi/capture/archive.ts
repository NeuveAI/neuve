import { safeRead } from "@neuve/records-schema";
import type { ScanFailureKind } from "./scan-failure.ts";
import { CaptureMarked } from "@neuve/records-schema";
import { ARTIFACT_TEXT_POLICY } from "./representation.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { Data } from "effect";
import { z } from "zod";
import { STORE_DIRECTORY_MODE, STORE_FILE_MODE } from "@neuve/records-core";
import { sha256Of } from "./journal.ts";
import { PORTABLE_WITHHELD } from "./mask.ts";
import {
  CAPTURE_VERSION,
  CREDENTIAL_INSPECTION_POLICY,
  RETAINED_SDK_ASSEMBLY_POLICY,
  RETAINED_SDK_PIN,
  DEFAULT_LIMITS,
  RunKind,
  type DumpLimits,
} from "./types.ts";

export { DEFAULT_LIMITS, type DumpLimits } from "./types.ts";

/**
 * A session dump's manifest and its folder form. The manifest names every file by a logical name
 * with its hash, size and media type; it carries no time, so the same state captured twice gives
 * the same manifest. The restricted manifest's hash is the snapshot's identity: in Records it names
 * the capture, and a held close, a reopen of the same run and its final close each get their own. A
 * dataset folder `<root>/<redaction>/<runKind>/<runId>/<snapshotId>/` holds a manifest byte for
 * byte, `objects/<sha256>` with each file's bytes, and `export.json` naming its source, redaction
 * and retention. Logical names are never paths, so nothing in a manifest can point outside the
 * dump. A folder is built in a staging folder beside its final place and renamed into it in one
 * step. Writing the same snapshot again verifies the folder and reuses it; a folder that does not
 * verify is refused, never replaced.
 */

export const DUMP_FORMAT = "neuve.session-dump";
export const MANIFEST_FILE = "manifest.json";
export const EXPORT_FILE = "export.json";
const OBJECTS = "objects";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const DumpFile = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/),
  mediaType: z.string().min(1),
  sha256: Sha256,
  size: z.int().nonnegative(),
});
export type DumpFile = z.infer<typeof DumpFile>;

export const DumpManifest = z
  .strictObject({
    format: z.literal(DUMP_FORMAT),
    version: z.literal(CAPTURE_VERSION),
    runId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    runKind: RunKind.nullable(),
    /** `restricted`: the owner-only capture, continuation and native backup kept. `portable`: derived from it for inspection only. */
    redaction: z.enum(["restricted", "portable"]),
    inspectionPolicy: z.literal(CREDENTIAL_INSPECTION_POLICY).optional(),
    retainedAssemblyPolicy: z.literal(RETAINED_SDK_ASSEMBLY_POLICY).optional(),
    retainedSdkPin: z.literal(RETAINED_SDK_PIN).optional(),
    retainedPrefixCalls: z
      .array(z.string())
      .refine((calls) => new Set(calls).size === calls.length)
      .optional(),
    scan: z
      .strictObject({
        policy: z.literal("capture-scan-v1"),
        rawCapture: Sha256,
        jobSeq: z.int().positive().optional(),
        attempt: z.int().positive().optional(),
      })
      .optional(),
    files: z.array(DumpFile),
  })
  .refine(
    (manifest) =>
      manifest.redaction !== "portable" ||
      manifest.inspectionPolicy === CREDENTIAL_INSPECTION_POLICY,
    "portable source lacks current artifact inspection policy",
  );
export type DumpManifest = z.infer<typeof DumpManifest>;
export type Redaction = DumpManifest["redaction"];

/**
 * A dataset's own retention, stated by whoever files it. It is not the 30-day raw-capture limit,
 * which keeps applying to the capture in Records; exporting never changes that capture's age.
 */
export const DatasetRetention = z.strictObject({
  policy: z.string().min(1),
  expiresAt: z.iso.datetime().optional(),
});
export type DatasetRetention = z.infer<typeof DatasetRetention>;

/**
 * What a folder's copy withholds. A restricted copy withholds nothing. A portable copy declares each
 * class it withholds, that it is for inspection only (it can never replay a conversation or restore
 * pi's state), and the restricted files it was derived from, whose hashes only the restricted
 * capture can recompute.
 */
export const RedactionRecord = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("restricted") }),
  z.strictObject({
    mode: z.literal("portable"),
    inspectionOnly: z.literal(true),
    withheld: z
      .array(z.enum(PORTABLE_WITHHELD))
      .refine(
        (withheld) =>
          withheld.length === PORTABLE_WITHHELD.length &&
          new Set(withheld).size === PORTABLE_WITHHELD.length,
        "portable omission declaration disagrees with policy",
      ),
    restrictedFiles: z.array(DumpFile),
  }),
]);
export type RedactionRecord = z.infer<typeof RedactionRecord>;

const ExportSource = z.union([
  z.string().regex(/^records:[0-9a-f]{64}$/),
  z.literal("direct"),
]);

export const SOURCE_VALIDATION_FILE = "source/validation.json";
export const SourceValidation = z.strictObject({
  /** Includes retained pinned-SDK assembly inspection before portable projection. */
  version: z.literal(10),
  basis: z.literal(CREDENTIAL_INSPECTION_POLICY),
  restrictedSnapshot: Sha256,
  restrictedManifest: z.string(),
  source: ExportSource,
  unavailableProviderOutputCalls: z.array(z.string()),
  retainedPrefixCalls: z
    .array(z.string())
    .refine((calls) => new Set(calls).size === calls.length),
  projections: z.array(DumpFile),
});

export const ExportRecord = z.strictObject({
  format: z.literal(`${DUMP_FORMAT}.export`),
  /** The restricted manifest's hash; the folder's name. */
  snapshotId: Sha256,
  /** The hash of this folder's own manifest: the snapshot ID itself for a restricted copy. */
  manifest: Sha256,
  /** `records:<snapshot>` when copied from Records, `direct` when built straight from pi's storage. */
  source: ExportSource,
  exportedAt: z.iso.datetime(),
  retention: DatasetRetention,
  redaction: RedactionRecord,
  captureMark: CaptureMarked.optional(),
});
export type ExportRecord = z.infer<typeof ExportRecord>;

export class DumpRejected extends Data.TaggedError("DumpRejected")<{
  readonly source: string;
  readonly reason: string;
  readonly failureKind?: ScanFailureKind | undefined;
}> {
  override get message() {
    return this.reason;
  }
}

export const encodeManifest = (manifest: DumpManifest) =>
  new TextEncoder().encode(`${JSON.stringify(DumpManifest.parse(manifest))}\n`);

/** The manifest's bytes parsed, within the limits, or the reason they cannot be trusted. */
export const decodeManifest = (
  bytes: Uint8Array,
  limits: DumpLimits,
  source?: string,
): DumpManifest | string => {
  if (bytes.byteLength > limits.manifestBytes)
    return "manifest over its size limit";
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return `manifest is not JSON: ${String(error)}`;
  }
  const parsed = safeRead(
    DumpManifest,
    json,
    source === undefined ? {} : { source },
  );
  if (!parsed.success)
    return `manifest does not match its schema: ${parsed.error.issues[0]?.message ?? ""}`;
  const names = new Set<string>();
  let total = 0;
  for (const file of parsed.data.files) {
    if (names.has(file.name)) return `duplicate name ${file.name}`;
    names.add(file.name);
    if (file.size > limits.objectBytes)
      return `${file.name} over the object size limit`;
    total += file.size;
    if (total > limits.totalBytes) return "dump over its total size limit";
  }
  return parsed.data;
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/**
 * `<root>/<redaction>/<runKind>/<runId>/`, created as needed: the root must be a real directory and
 * no folder below it a link.
 */
const dumpParent = async (root: string, manifest: DumpManifest) => {
  if (manifest.runKind === null)
    throw new Error("a dump with no run kind is not filed");
  let parent = await realpath(root);
  if (!(await lstat(parent)).isDirectory())
    throw new Error(`dataset root ${root} is not a directory`);
  for (const segment of [
    manifest.redaction,
    manifest.runKind,
    manifest.runId,
  ]) {
    parent = join(parent, segment);
    await mkdir(parent, { mode: STORE_DIRECTORY_MODE }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    if (!(await lstat(parent)).isDirectory())
      throw new Error(`${parent} is not a directory inside the dataset root`);
  }
  return parent;
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && sha256Of(a) === sha256Of(b);

/**
 * Writes a dump folder from a manifest's exact bytes and each file's bytes, and returns where it is
 * and whether it was there already. A folder already holding this snapshot is read back whole and
 * reused when its manifest is these bytes; one that fails any check, or holds other bytes, is
 * refused with `DumpRejected` and left as it is.
 */
export const writeDump = async (input: {
  readonly root: string;
  readonly manifest: DumpManifest;
  readonly manifestBytes: Uint8Array;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly record: ExportRecord;
}): Promise<{ readonly directory: string; readonly reused: boolean }> => {
  const { manifest } = input;
  const parent = await dumpParent(input.root, manifest);
  const directory = join(parent, input.record.snapshotId);
  const reuse = async () => {
    const held = await readDump(directory);
    if (!sameBytes(held.manifestBytes, input.manifestBytes))
      throw new DumpRejected({
        source: directory,
        reason: "the folder holds another manifest for this snapshot",
      });
    const { exportedAt: _, ...filed } = held.record;
    const { exportedAt: __, ...wanted } = ExportRecord.parse(input.record);
    if (JSON.stringify(filed) !== JSON.stringify(wanted))
      throw new DumpRejected({
        source: directory,
        reason:
          "the folder was filed with another source, retention or redaction",
      });
    return { directory: held.directory, reused: true };
  };
  if (await exists(directory)) return reuse();
  const staging = join(parent, `.staging-${randomUUID()}`);
  try {
    await mkdir(join(staging, OBJECTS), {
      recursive: true,
      mode: STORE_DIRECTORY_MODE,
    });
    for (const file of manifest.files) {
      const bytes = input.files.get(file.name);
      if (bytes === undefined || sha256Of(bytes) !== file.sha256)
        throw new Error(`${file.name} does not match the manifest`);
      const path = join(staging, OBJECTS, file.sha256);
      if (!(await exists(path)))
        await writeFile(path, bytes, { mode: STORE_FILE_MODE, flag: "wx" });
    }
    await writeFile(join(staging, MANIFEST_FILE), input.manifestBytes, {
      mode: STORE_FILE_MODE,
      flag: "wx",
    });
    await writeFile(
      join(staging, EXPORT_FILE),
      `${JSON.stringify(ExportRecord.parse(input.record), null, 2)}\n`,
      { mode: STORE_FILE_MODE, flag: "wx" },
    );
    // A dump folder is never empty, so a rename that lost a race fails instead of replacing it.
    if (await exists(directory)) return await reuse();
    await rename(staging, directory);
    return { directory, reused: false };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

type Reject = (reason: string) => never;

/** A regular file, not a link, inside `root` once every link above it is resolved. */
const ownedFile = async (root: string, path: string, reject: Reject) => {
  const info = await lstat(path).catch(() => reject(`missing ${path}`));
  if (!info.isFile()) reject(`not a regular file: ${path}`);
  const resolved = await realpath(path);
  if (!resolved.startsWith(`${root}${sep}`))
    reject(`outside the dump: ${path}`);
  return info.size;
};

export interface ReadDump {
  readonly directory: string;
  readonly manifest: DumpManifest;
  readonly manifestBytes: Uint8Array;
  readonly record: ExportRecord;
  /** Each file's bytes by logical name, every one checked against its size and hash. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/**
 * Reads a dump folder and checks it whole before returning anything: the manifest against its
 * schema and against the capture `export.json` names, every object a regular file inside the dump,
 * within the limits, of the stated size and hash. Files in `objects/` the manifest does not name,
 * and any other entry in the folder, are refused too.
 */
export const readDump = async (
  directory: string,
  limits: DumpLimits = DEFAULT_LIMITS,
): Promise<ReadDump> => {
  const reject: Reject = (reason) => {
    throw new DumpRejected({ source: directory, reason });
  };
  const root = await realpath(directory).catch(() =>
    reject("no such directory"),
  );
  const present = (await readdir(root)).toSorted();
  if (
    JSON.stringify(present) !==
    JSON.stringify([EXPORT_FILE, MANIFEST_FILE, OBJECTS])
  )
    reject(`unexpected folder contents: ${present.join(", ")}`);
  const manifestPath = join(root, MANIFEST_FILE);
  if ((await ownedFile(root, manifestPath, reject)) > limits.manifestBytes)
    reject("manifest over its size limit");
  const manifestBytes = new Uint8Array(await readFile(manifestPath));
  const manifest = decodeManifest(manifestBytes, limits, manifestPath);
  if (typeof manifest === "string") return reject(manifest);
  const recordPath = join(root, EXPORT_FILE);
  if ((await ownedFile(root, recordPath, reject)) > limits.manifestBytes)
    reject("export record over its size limit");
  let recordJson: unknown;
  try {
    recordJson = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (error) {
    reject(`export record is not JSON: ${String(error)}`);
  }
  const record = safeRead(ExportRecord, recordJson, { source: recordPath });
  if (!record.success) return reject("export record does not match its schema");
  const manifestHash = sha256Of(manifestBytes);
  if (record.data.manifest !== manifestHash)
    reject("manifest is not the one its export record names");
  if (basename(root) !== record.data.snapshotId)
    reject("the folder is not named for the snapshot it holds");
  if (record.data.redaction.mode !== manifest.redaction)
    reject("the export record's redaction disagrees with the manifest");
  if (
    manifest.redaction === "restricted" &&
    record.data.snapshotId !== manifestHash
  )
    reject("a restricted folder's manifest is not its snapshot");
  if (
    record.data.source !== "direct" &&
    record.data.source !== `records:${record.data.snapshotId}`
  )
    reject("the export record names another capture as its source");
  const objects = join(root, OBJECTS);
  const objectsInfo = await lstat(objects);
  if (!objectsInfo.isDirectory()) reject("objects is not a directory");
  const named = new Set(manifest.files.map((file) => file.sha256));
  for (const name of await readdir(objects))
    if (!named.has(name)) reject(`unnamed object ${name}`);
  const files = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    const path = join(objects, file.sha256);
    const size = await ownedFile(root, path, reject);
    if (size !== file.size)
      reject(`${file.name}: size ${size} where ${file.size} was recorded`);
    const bytes = new Uint8Array(await readFile(path));
    if (sha256Of(bytes) !== file.sha256)
      reject(`${file.name}: checksum mismatch`);
    files.set(file.name, bytes);
  }
  validatePortableMetadata(manifest, record.data, files, limits, reject);
  return {
    directory: root,
    manifest,
    manifestBytes,
    record: record.data,
    files,
  };
};

export const validatePortableMetadata = (
  manifest: DumpManifest,
  record: ExportRecord,
  files: ReadonlyMap<string, Uint8Array>,
  limits: DumpLimits,
  reject: Reject,
) => {
  if (record.redaction.mode !== "portable") return;
  const bytes =
    files.get(SOURCE_VALIDATION_FILE) ??
    reject("portable source validation is unavailable");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return reject("portable source validation is not JSON");
  }
  const result = safeRead(SourceValidation, json, {
    source: SOURCE_VALIDATION_FILE,
  });
  if (!result.success)
    return reject(
      "portable source validation policy is insufficient for retained SDK assembly and public metadata binding",
    );
  const declaration = result.data;
  if (declaration.restrictedSnapshot !== record.snapshotId)
    reject("portable source validation names another restricted snapshot");
  const originalBytes = new TextEncoder().encode(
    declaration.restrictedManifest,
  );
  if (sha256Of(originalBytes) !== record.snapshotId)
    reject("portable original manifest is not its restricted snapshot");
  const original = decodeManifest(originalBytes, limits);
  if (typeof original === "string")
    return reject(`portable original manifest: ${original}`);
  if (
    original.retainedAssemblyPolicy !== RETAINED_SDK_ASSEMBLY_POLICY ||
    original.retainedSdkPin !== RETAINED_SDK_PIN
  )
    reject(
      "portable original source lacks current retained SDK assembly policy",
    );
  if (
    original.redaction !== "restricted" ||
    original.runId !== manifest.runId ||
    original.runKind !== manifest.runKind
  )
    reject("portable identity disagrees with its restricted source");
  if (
    !isDeepStrictEqual(
      declaration.retainedPrefixCalls,
      original.retainedPrefixCalls ?? [],
    ) ||
    !isDeepStrictEqual(
      manifest.retainedPrefixCalls ?? [],
      original.retainedPrefixCalls ?? [],
    )
  )
    reject(
      "portable retained-prefix proof disagrees with its restricted source",
    );
  if (!isDeepStrictEqual(original.files, record.redaction.restrictedFiles))
    reject(
      "portable restricted file inventory disagrees with its original manifest",
    );
  if (declaration.source !== record.source)
    reject("portable source declaration disagrees with its export record");
  const projections = manifest.files
    .filter((file) => file.name !== SOURCE_VALIDATION_FILE)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(declaration.projections, projections))
    reject(
      "portable source validation declaration disagrees with carried projections",
    );
};
