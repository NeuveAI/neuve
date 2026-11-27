import { writeCaptureOwner } from "./staging.ts";
import type { InspectionProgress } from "./close-diagnostic.ts";
import { inspectInventory, type SourceProducer } from "./inspection-pool.ts";
import { Database } from "bun:sqlite";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { SourceOwnership } from "../source-ownership.ts";
import {
  CredentialDetectors,
  CredentialEpochId,
  type CredentialJson,
  InspectionBudget,
  type InspectionResult,
  type InspectionUnavailable,
  type CredentialSource,
  unavailable,
  inspectionFailure,
} from "./credential-detectors.ts";
import { openCaptureJournal, readCaptureJournal } from "./journal.ts";
import type { ArtifactSource } from "./representation.ts";
import { CaptureFailed } from "./types.ts";

const FILE = "authority.sqlite";
const MAX_STATE = 8 * 1024 * 1024;
const MAX_DATABASE = 32 * 1024 * 1024;
const Row = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  source: z.string(),
  key: z.instanceof(Uint8Array).refine((value) => value.byteLength === 32),
  state: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= MAX_STATE),
  mac: z.instanceof(Uint8Array).refine((value) => value.byteLength === 32),
});
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
export const NativeAuthorityReceipt = z.strictObject({
  version: z.literal(1),
  id: Digest,
  nativeSha256: Digest,
});
export type NativeAuthorityReceipt = z.infer<typeof NativeAuthorityReceipt>;
const Origin = z.strictObject({
  source: z.string(),
  runId: z.string().min(1),
  journal: z.string(),
  journalSha256: Digest,
  rawJournalSha256: Digest.optional(),
  nativeSha256: Digest,
});
const Provenance = z.strictObject({
  kind: z.enum([
    "external-seed",
    "detached-backup",
    "checkpoint",
    "inherited-native",
  ]),
  nativeSha256: Digest,
  ancestors: z.array(Origin).max(128),
  exposedEpochs: z.array(z.string()).max(100000),
});
type Provenance = z.infer<typeof Provenance>;
export type NativeSourceImportOrigin =
  | { readonly kind: "seed"; readonly file: string; readonly sha256: string }
  | {
      readonly kind: "backup";
      readonly nativeSha256: string;
      readonly receipt?: NativeAuthorityReceipt;
    };
export interface NativeSourceImportOptions extends PrivateInspectionOptions {
  readonly nativeDatabase: string;
  readonly runId: string;
  readonly origin: NativeSourceImportOrigin;
}
export interface PrivateInspectionOptions {
  readonly ownership: SourceOwnership;
  readonly source: string;
  readonly directory: string;
  /** Include every native, journal, spill, dataset and logging root used by the capture owner. */
  readonly excludedRoots: ReadonlyArray<string>;
}
export class NativeHistoryUncertified extends Error {
  constructor() {
    super("Imported native history is not export certified");
    this.name = "NativeHistoryUncertified";
  }
}
export class PrivateInspectionError extends Error {
  constructor(
    readonly check: string,
    readonly path: string,
    readonly code?: string,
    readonly kind: "io" | "uncertified" = "io",
  ) {
    super(
      `Private credential inspection unavailable: ${check} at ${JSON.stringify(path)}${code === undefined ? "" : ` (${code})`}`,
    );
    this.name = "PrivateInspectionError";
  }
}
/** Classification is shared by every close and sweep; unknown failures retry within the close bound. */
export const authorityFailureKind = (
  error: unknown,
): "transient" | "uncertified" => {
  if (error instanceof NativeHistoryUncertified) return "uncertified";
  if (error instanceof PrivateInspectionError) {
    if (error.kind === "uncertified") return "uncertified";
    if (
      error.code !== undefined &&
      /^(?:ENOENT|EACCES|EPERM|SQLITE_NOTADB|SQLITE_CORRUPT(?:_[A-Z]+)?|SQLITE_ERROR)$/.test(
        error.code,
      )
    )
      return "uncertified";
  }
  return "transient";
};

export class PrivateInspectionBusy extends Error {
  readonly retryable = true;
  constructor(readonly code: "SQLITE_BUSY" | "SQLITE_LOCKED" = "SQLITE_BUSY") {
    super("credential authority is busy; retry later");
    this.name = "PrivateInspectionBusy";
  }
}
const rethrowBusy = (error: unknown) => {
  if (
    error instanceof PrivateInspectionBusy ||
    (error instanceof Error &&
      /SQLITE_(?:BUSY|LOCKED)|database is locked/.test(error.message))
  ) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    throw new PrivateInspectionBusy(
      code === "SQLITE_LOCKED" ||
        (error instanceof Error && /SQLITE_LOCKED/.test(error.message))
        ? "SQLITE_LOCKED"
        : "SQLITE_BUSY",
    );
  }
};
const fail = (check: string, path: string): never => {
  throw new PrivateInspectionError(check, path, undefined, "uncertified");
};
// Report only our check, its path and an error code. Driver errors can contain private state.
const checked = <T>(check: string, path: string, operation: () => T): T => {
  try {
    return operation();
  } catch (error) {
    rethrowBusy(error);
    if (error instanceof PrivateInspectionError) throw error;
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : undefined;
    throw new PrivateInspectionError(check, path, code);
  }
};
const within = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);
const identity = (path: string, directory: boolean) => {
  const stat = checked("lstat", path, () => lstatSync(path));
  if (stat.isSymbolicLink()) fail("no-symbolic-link", path);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail("file-type", path);
  if (stat.uid !== process.getuid?.()) fail("owner-uid", path);
  if ((stat.mode & 0o777) !== (directory ? 0o700 : 0o600))
    fail("private-mode", path);
  if (!directory && stat.nlink !== 1) fail("single-link", path);
  if (!directory && stat.size > MAX_DATABASE) fail("database-size", path);
  return { dev: stat.dev, ino: stat.ino };
};
const same = (
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
) => a.dev === b.dev && a.ino === b.ino;
const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    return checked("lstat", path, () => {
      throw error;
    });
  }
};
const canonical = (path: string): string =>
  existsSync(path)
    ? realpathSync(path)
    : join(canonical(dirname(path)), basename(path));
// Resolve the configured namespace once; the authority itself and every child must stay canonical.
const canonicalOptions = (
  options: PrivateInspectionOptions,
): PrivateInspectionOptions =>
  checked("canonical-root", dirname(options.directory), () => {
    if (!isAbsolute(options.directory))
      fail("absolute-directory", options.directory);
    if (resolve(options.directory) !== options.directory)
      fail("canonical-directory", options.directory);
    return {
      ...options,
      directory: join(
        canonical(dirname(options.directory)),
        basename(options.directory),
      ),
    };
  });
type PhysicalObservations = Map<
  string,
  { dev: number; ino: number } | undefined
>;
const physicalWithin = (
  root: string,
  target: string,
  observations: PhysicalObservations,
): boolean => {
  const physical = (path: string): { dev: number; ino: number } | undefined => {
    if (observations.has(path)) return observations.get(path);
    try {
      const stat = statSync(path);
      const result = { dev: stat.dev, ino: stat.ino };
      observations.set(path, result);
      return result;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        observations.set(path, undefined);
        return undefined;
      }
      return checked("stat-containment", path, () => {
        throw error;
      });
    }
  };
  const rootIdentity = physical(root);
  if (!rootIdentity) return false;
  let cursor = target;
  for (;;) {
    const candidate = physical(cursor);
    if (candidate && same(rootIdentity, candidate)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
};
const validateOptions = (options: PrivateInspectionOptions): string =>
  checked("validate-options", options.directory, () => {
    if (!(options.ownership instanceof SourceOwnership))
      fail("source-ownership", options.source);
    if (!isAbsolute(options.source)) fail("absolute-source", options.source);
    if (!isAbsolute(options.directory))
      fail("absolute-directory", options.directory);
    checked("source-ownership", options.source, () =>
      options.ownership.assertSource(options.source),
    );
    const source = checked("realpath-source", options.source, () =>
      realpathSync(options.source),
    );
    if (source !== options.ownership.source)
      fail("owned-source", options.source);
    if (
      resolve(options.directory) !== options.directory ||
      canonical(options.directory) !== options.directory
    )
      fail("canonical-directory", options.directory);
    const roots = [
      source,
      ...options.excludedRoots.map((root) => canonical(resolve(root))),
    ];
    // No observation survives this synchronous validation. Recheck every path
    // after a scan yields, but walk shared ancestors only once at each boundary.
    const observations: PhysicalObservations = new Map();
    for (const root of roots) {
      if (within(root, options.directory) || within(options.directory, root))
        fail(
          `excluded-root-overlap ${JSON.stringify(root)}`,
          options.directory,
        );
      if (
        physicalWithin(root, options.directory, observations) ||
        physicalWithin(options.directory, root, observations)
      )
        fail(
          `physical-root-overlap ${JSON.stringify(root)}`,
          options.directory,
        );
    }
    return source;
  });
const syncDirectory = (directory: string): void =>
  checked("fsync-directory", directory, () => {
    const fd = checked("open-directory", directory, () =>
      openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW),
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
const writeRegistration = <T>(write: () => T): T => {
  try {
    return write();
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (
      typeof code === "string" &&
      (/^SQLITE_(?:FULL|READONLY(?:_[A-Z]+)?|IOERR_(?:WRITE|FSYNC|DIR_FSYNC|TRUNCATE|SHMSIZE))$/.test(
        code,
      ) ||
        (error instanceof PrivateInspectionError &&
          error.check === "fsync-directory" &&
          /^(?:ENOSPC|EIO|EROFS|EACCES|EPERM)$/.test(code)))
    )
      throw new CaptureFailed({
        kind: "io",
        event: "credential.registration",
        detail: "private credential registration could not be written",
        writeCode: code,
      });
    throw error;
  }
};
const mac = (key: Uint8Array, source: string, state: Uint8Array) =>
  createHmac("sha256", key)
    .update("private-inspection-v1\0")
    .update(source)
    .update("\0")
    .update(state)
    .digest();
const provenanceMac = (
  key: Uint8Array,
  source: string,
  state: Uint8Array,
  provenance: string,
) =>
  createHmac("sha256", key)
    .update("private-inspection-v2\0")
    .update(source)
    .update("\0")
    .update(state)
    .update("\0")
    .update(provenance)
    .digest();
const readState = (
  database: Database,
  source: string,
  budget?: InspectionBudget,
) => {
  const row = Row.parse(
    database
      .query(
        "SELECT version, source, key, state, mac FROM authority WHERE id=1",
      )
      .get(),
  );
  budget?.charge("fullChecks", 1);
  budget?.charge("fullBytes", row.state.byteLength);
  const provenanceText =
    row.version === 2
      ? z
          .strictObject({ value: z.string() })
          .parse(
            database.query("SELECT value FROM provenance WHERE id=1").get(),
          ).value
      : undefined;
  const provenance =
    provenanceText === undefined
      ? undefined
      : Provenance.parse(JSON.parse(provenanceText));
  if (row.source !== source) fail("state-source", database.filename);
  if (
    !timingSafeEqual(
      provenanceText === undefined
        ? mac(row.key, source, row.state)
        : provenanceMac(row.key, source, row.state, provenanceText),
      row.mac,
    )
  )
    fail("state-authentication", database.filename);
  return { ...row, provenanceText, provenance };
};

const frozenDigest = (file: string, expected: string): string => {
  Digest.parse(expected);
  if (!isAbsolute(file) || canonical(file) !== file)
    fail("frozen-digest", file);
  const before = lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.()
  )
    fail("frozen-digest", file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, fstatSync(fd))) fail("frozen-digest", file);
    const digest = createHash("sha256").update(readFileSync(fd)).digest("hex");
    const after = fstatSync(fd);
    if (
      !same(before, after) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      digest !== expected
    )
      fail("frozen-digest", file);
    return digest;
  } finally {
    closeSync(fd);
  }
};

interface OwnerQueue {
  tail: Promise<void>;
}
const ownerQueues = new WeakMap<SourceOwnership, Map<string, OwnerQueue>>();

export interface CaptureCheckpointOptions {
  readonly directory: string;
  readonly receipt: NativeAuthorityReceipt;
  readonly runId: string;
  readonly journalSha256: string;
}
type AuthorityOptions = Omit<PrivateInspectionOptions, "ownership"> & {
  readonly ownership?: SourceOwnership;
};

export class PrivateInspection {
  #closed = false;
  #poisoned = false;
  readonly #fileIdentity: { dev: number; ino: number };
  readonly #directoryIdentity: { dev: number; ino: number };
  #queue: OwnerQueue;
  readonly #options: AuthorityOptions;
  #checkpoint: CaptureCheckpointOptions | undefined;
  readonly #source: string;
  readonly #database: Database;
  #pending = 0;
  #cached: { engine: CredentialDetectors; mac: Buffer } | undefined;
  private constructor(
    options: AuthorityOptions,
    source: string,
    database: Database,
  ) {
    this.#options = { ...options, excludedRoots: [...options.excludedRoots] };
    this.#source = source;
    this.#database = database;
    this.#fileIdentity = identity(join(options.directory, FILE), false);
    this.#directoryIdentity = identity(options.directory, true);
    if (options.ownership === undefined)
      this.#queue = { tail: Promise.resolve() };
    else {
      const queueKey = `${this.#directoryIdentity.dev}:${this.#directoryIdentity.ino}`;
      const queues =
        ownerQueues.get(options.ownership) ?? new Map<string, OwnerQueue>();
      ownerQueues.set(options.ownership, queues);
      this.#queue = queues.get(queueKey) ?? { tail: Promise.resolve() };
      queues.set(queueKey, this.#queue);
    }
  }
  static openCaptureCheckpoint(
    input: CaptureCheckpointOptions,
  ): PrivateInspection {
    const receipt = NativeAuthorityReceipt.parse(input.receipt);
    const directory = resolve(input.directory);
    if (
      canonical(directory) !== directory ||
      basename(directory) !== receipt.id
    )
      fail("checkpoint-provenance", directory);
    identity(directory, true);
    const file = join(directory, FILE);
    const before = identity(file, false);
    const database = new Database(file, {
      readonly: true,
      create: false,
      strict: true,
    });
    try {
      if (!same(before, identity(file, false))) fail("file-identity", file);
      const parent = z
        .strictObject({ source: z.string() })
        .parse(database.query("SELECT source FROM authority WHERE id=1").get());
      const authority = new PrivateInspection(
        { source: parent.source, directory, excludedRoots: [] },
        parent.source,
        database,
      );
      authority.#checkpoint = { ...input, directory, receipt };
      authority.#assert();
      return authority;
    } catch (error) {
      database.close();
      rethrowBusy(error);
      throw error;
    }
  }
  checkpointDirectory(receipt: NativeAuthorityReceipt): string {
    NativeAuthorityReceipt.parse(receipt);
    return join(dirname(this.#options.directory), "snapshots", receipt.id);
  }

  static create(input: PrivateInspectionOptions): PrivateInspection {
    const options = canonicalOptions(input);
    const key = randomBytes(32),
      engine = CredentialDetectors.empty(key);
    try {
      return PrivateInspection.#create(options, key, engine.encodePrivate());
    } finally {
      key.fill(0);
      engine.destroy();
    }
  }
  static #create(
    options: PrivateInspectionOptions,
    key: Uint8Array,
    state: Uint8Array,
    provenance?: Provenance,
  ): PrivateInspection {
    let database: Database | undefined;
    let created = false;
    try {
      const source = validateOptions(options);
      checked("mkdir-authority", options.directory, () =>
        mkdirSync(options.directory, { mode: 0o700 }),
      );
      created = true;
      if (provenance?.kind === "checkpoint")
        writeCaptureOwner(options.directory);
      identity(options.directory, true);
      validateOptions(options);
      syncDirectory(dirname(options.directory));
      const file = join(options.directory, FILE);
      const descriptor = checked("create-authority-file", file, () =>
        openSync(
          file,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        ),
      );
      try {
        checked("chmod-authority-file", file, () =>
          fchmodSync(descriptor, 0o600),
        );
        checked("fsync-authority-file", file, () => fsyncSync(descriptor));
      } finally {
        closeSync(descriptor);
      }
      database = checked(
        "open-sqlite",
        file,
        () => new Database(file, { create: false, strict: true }),
      );
      database.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON",
      );
      const provenanceText =
        provenance === undefined
          ? undefined
          : JSON.stringify(Provenance.parse(provenance));
      {
        database.exec("BEGIN IMMEDIATE");
        database.exec(
          "CREATE TABLE authority (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, source TEXT NOT NULL, key BLOB NOT NULL, state BLOB NOT NULL, mac BLOB NOT NULL)",
        );
        database
          .query("INSERT INTO authority VALUES (1, ?, ?, ?, ?, ?)")
          .run(
            provenanceText === undefined ? 1 : 2,
            source,
            key,
            state,
            provenanceText === undefined
              ? mac(key, source, state)
              : provenanceMac(key, source, state, provenanceText),
          );
        if (provenanceText !== undefined) {
          database.exec(
            "CREATE TABLE provenance (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
          );
          database
            .query("INSERT INTO provenance VALUES (1, ?)")
            .run(provenanceText);
        }
        database.exec("COMMIT");
        syncDirectory(options.directory);
        readState(database, source).key.fill(0);
      }
      const authority = new PrivateInspection(options, source, database);
      authority.#assert();
      return authority;
    } catch (error) {
      database?.close();
      if (created) rmSync(options.directory, { recursive: true, force: true });
      return checked("initialize-sqlite", join(options.directory, FILE), () => {
        throw error;
      });
    }
  }
  static open(input: PrivateInspectionOptions): PrivateInspection {
    const options = canonicalOptions(input);
    let database: Database | undefined;
    try {
      const source = validateOptions(options);
      identity(options.directory, true);
      const file = join(options.directory, FILE);
      const before = identity(file, false);
      const descriptor = checked("open-authority-file", file, () =>
        openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW),
      );
      try {
        if (!same(before, fstatSync(descriptor)))
          fail("opened-file-identity", file);
      } finally {
        closeSync(descriptor);
      }
      for (const suffix of ["-journal", "-wal", "-shm"])
        if (present(file + suffix)) identity(file + suffix, false);
      database = checked(
        "open-sqlite",
        file,
        () => new Database(file, { create: false, strict: true }),
      );
      if (!same(before, identity(file, false)))
        fail("opened-file-identity", file);
      database.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON",
      );
      const row = readState(database, source);
      const engine = CredentialDetectors.restorePrivate(row.key, row.state);
      engine.destroy();
      row.key.fill(0);
      const authority = new PrivateInspection(options, source, database);
      authority.#assert();
      return authority;
    } catch (error) {
      database?.close();
      return checked("read-sqlite", join(options.directory, FILE), () => {
        throw error;
      });
    }
  }
  exportState(): "fresh" | "uncertified-import" {
    this.#assert();
    const row = readState(this.#database, this.#source);
    try {
      return row.provenance === undefined ? "fresh" : "uncertified-import";
    } finally {
      row.key.fill(0);
    }
  }
  assertExportable(): void {
    if (this.#checkpoint !== undefined) {
      this.#assert();
      return;
    }
    if (this.exportState() !== "fresh") throw new NativeHistoryUncertified();
  }
  ownsCaptureJournal(input: {
    readonly journal: string;
    readonly runId: string;
    readonly bytes: Uint8Array | null;
  }): boolean {
    const checkpoint = this.#checkpoint;
    // A deferred scan stages the journal outside the original source.
    return checkpoint === undefined
      ? physicalWithin(this.#source, input.journal, new Map())
      : input.runId === checkpoint.runId &&
          input.bytes !== null &&
          createHash("sha256").update(input.bytes).digest("hex") ===
            checkpoint.journalSha256;
  }
  hasCredentialEpochs(): boolean {
    this.#assert();
    const row = readState(this.#database, this.#source);
    try {
      return this.#engineFor(row, new InspectionBudget()).epochIds.length > 0;
    } finally {
      row.key.fill(0);
    }
  }
  async snapshotForNative(input: {
    readonly nativeDatabase: string;
    readonly nativeSha256: string;
    readonly runId: string;
    readonly journal: string;
    readonly rawJournalSha256?: string;
  }): Promise<NativeAuthorityReceipt> {
    if (input.rawJournalSha256 !== undefined) this.assertExportable();
    const ownership = this.#options.ownership;
    if (ownership === undefined)
      throw new PrivateInspectionError(
        "source-ownership",
        this.#source,
        undefined,
        "uncertified",
      );
    if (within(this.#source, input.nativeDatabase))
      fail("detached-native-path", input.nativeDatabase);
    const nativeSha256 = frozenDigest(input.nativeDatabase, input.nativeSha256);
    if (
      resolve(input.journal) !== join(this.#source, "capture") ||
      input.runId.length === 0
    )
      fail("snapshot-journal-identity", input.journal);
    const journal = readCaptureJournal(input.journal);
    if (journal._tag !== "Read")
      throw new PrivateInspectionError("journal-read", input.journal);
    const { lines, frames } = journal;
    if (
      input.rawJournalSha256 !== undefined &&
      (journal.bytes === null ||
        createHash("sha256").update(journal.bytes).digest("hex") !==
          Digest.parse(input.rawJournalSha256))
    )
      fail("snapshot-journal-identity", input.journal);
    if (
      lines.some((line) => line.event.scope.runId !== input.runId) ||
      !lines.some(({ event }) => event.type === "run.start")
    )
      fail("snapshot-journal-run", input.journal);
    const journalHash = createHash("sha256");
    for (const [index, frame] of frames.entries()) {
      if (index > 0) journalHash.update("\n");
      journalHash.update(frame.contents());
    }
    const root = join(dirname(this.#options.directory), "snapshots");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    identity(root, true);
    const id = randomBytes(32).toString("hex");
    let completed = false;
    try {
      const result = await this.#exclusive(async () => {
        const row = readState(this.#database, this.#source);
        try {
          if (frozenDigest(input.nativeDatabase, nativeSha256) !== nativeSha256)
            fail("snapshot-native-digest", input.nativeDatabase);
          const checkpoint = PrivateInspection.#create(
            {
              ...this.#options,
              ownership,
              directory: join(root, id),
              excludedRoots: [
                ...this.#options.excludedRoots,
                dirname(input.nativeDatabase),
              ],
            },
            row.key,
            row.state,
            {
              kind: "checkpoint",
              nativeSha256,
              ancestors: [
                ...(row.provenance?.ancestors ?? []),
                {
                  source: this.#source,
                  ...(input.rawJournalSha256 === undefined
                    ? {}
                    : { rawJournalSha256: input.rawJournalSha256 }),
                  runId: input.runId,
                  journal: input.journal,
                  journalSha256: journalHash.digest("hex"),
                  nativeSha256,
                },
              ],
              exposedEpochs: [
                ...new Set([
                  ...(row.provenance?.exposedEpochs ?? []),
                  ...lines.flatMap(({ event }) =>
                    event.type === "credential.guard" &&
                    event.status === "exposed"
                      ? [event.callId]
                      : [],
                  ),
                ]),
              ],
            },
          );
          checkpoint.close();
          this.#assert();
          return NativeAuthorityReceipt.parse({ version: 1, id, nativeSha256 });
        } finally {
          row.key.fill(0);
        }
      }, true);
      if ("status" in result)
        throw new PrivateInspectionError(
          "snapshot-authority",
          this.#options.directory,
        );
      completed = true;
      return result;
    } finally {
      if (!completed) rmSync(join(root, id), { recursive: true, force: true });
    }
  }
  static async prepareNativeImport(
    input: NativeSourceImportOptions,
  ): Promise<PrivateInspection> {
    z.string().min(1).parse(input.runId);
    input = { ...input, ...canonicalOptions(input) };
    const authority = await PrivateInspection.#prepareNativeImport(input);
    try {
      const journal = openCaptureJournal(
        join(input.source, "capture"),
        input.runId,
      );
      try {
        journal.capture({
          type: "native.import",
          scope: { runId: input.runId },
          origin:
            input.origin.kind === "seed"
              ? "external-seed"
              : input.origin.receipt === undefined
                ? "detached-backup"
                : "inherited-native",
        });
      } finally {
        journal.close();
      }
      return authority;
    } catch (error) {
      authority.close();
      throw error;
    }
  }
  static async #prepareNativeImport(
    input: NativeSourceImportOptions,
  ): Promise<PrivateInspection> {
    const source = validateOptions(input);
    if (
      input.nativeDatabase !== join(source, "channel.sqlite") ||
      present(input.nativeDatabase) ||
      present(input.directory)
    )
      fail("fresh-import-paths", input.directory);
    const origin = input.origin;
    mkdirSync(dirname(input.directory), { recursive: true, mode: 0o700 });
    if (origin.kind === "seed") {
      const digest = frozenDigest(origin.file, origin.sha256);
      const key = randomBytes(32),
        engine = CredentialDetectors.empty(key);
      try {
        return PrivateInspection.#create(input, key, engine.encodePrivate(), {
          kind: "external-seed",
          nativeSha256: digest,
          ancestors: [],
          exposedEpochs: [],
        });
      } finally {
        key.fill(0);
        engine.destroy();
      }
    }
    const digest = Digest.parse(origin.nativeSha256);
    if (origin.receipt === undefined) {
      const key = randomBytes(32),
        engine = CredentialDetectors.empty(key);
      try {
        return PrivateInspection.#create(input, key, engine.encodePrivate(), {
          kind: "detached-backup",
          nativeSha256: digest,
          ancestors: [],
          exposedEpochs: [],
        });
      } finally {
        key.fill(0);
        engine.destroy();
      }
    }
    const receipt = NativeAuthorityReceipt.parse(origin.receipt);
    if (receipt.nativeSha256 !== digest)
      fail("receipt-native-digest", input.directory);
    const root = join(dirname(input.directory), "snapshots");
    identity(root, true);
    const directory = join(root, receipt.id);
    identity(directory, true);
    const path = join(directory, FILE);
    const before = identity(path, false);
    const database = new Database(path, { readonly: true, strict: true });
    try {
      if (!same(before, identity(path, false)))
        fail("opened-file-identity", path);
      const parent = z
        .strictObject({ source: z.string() })
        .parse(database.query("SELECT source FROM authority WHERE id=1").get());
      const row = readState(database, parent.source);
      try {
        const provenance = Provenance.parse(row.provenance);
        if (
          provenance.kind !== "checkpoint" ||
          provenance.nativeSha256 !== digest ||
          provenance.ancestors.at(-1)?.source !== parent.source
        )
          fail("checkpoint-provenance", path);
        const engine = CredentialDetectors.restorePrivate(row.key, row.state);
        engine.destroy();
        return PrivateInspection.#create(input, row.key, row.state, {
          ...provenance,
          kind: "inherited-native",
        });
      } finally {
        row.key.fill(0);
      }
    } finally {
      database.close();
    }
  }
  toJSON(): string {
    return "[Private credential inspection]";
  }
  [inspect.custom](): string {
    return this.toJSON();
  }
  #inspectionFailureCheck: string | undefined;
  get inspectionFailureCheck(): string | undefined {
    return this.#inspectionFailureCheck;
  }
  #assert(): void {
    if (this.#closed || this.#poisoned)
      fail("authority-open", this.#options.directory);
    if (this.#checkpoint === undefined) {
      const ownership = this.#options.ownership;
      if (ownership === undefined)
        throw new PrivateInspectionError(
          "source-ownership",
          this.#source,
          undefined,
          "uncertified",
        );
      validateOptions({ ...this.#options, ownership });
    } else {
      if (canonical(this.#options.directory) !== this.#options.directory)
        fail("canonical-directory", this.#options.directory);
      const row = readState(this.#database, this.#source);
      try {
        const origin = row.provenance?.ancestors.at(-1);
        if (
          row.provenance?.kind !== "checkpoint" ||
          row.provenance.nativeSha256 !==
            this.#checkpoint.receipt.nativeSha256 ||
          origin?.runId !== this.#checkpoint.runId ||
          origin.rawJournalSha256 !== this.#checkpoint.journalSha256
        )
          fail("checkpoint-provenance", this.#options.directory);
      } finally {
        row.key.fill(0);
      }
    }
    if (!same(this.#directoryIdentity, identity(this.#options.directory, true)))
      fail("directory-identity", this.#options.directory);
    const file = join(this.#options.directory, FILE);
    if (!same(this.#fileIdentity, identity(file, false)))
      fail("file-identity", file);
    for (const suffix of ["-journal", "-wal", "-shm"])
      if (present(file + suffix)) identity(file + suffix, false);
  }
  async #exclusive<T>(
    operation: () => Promise<T>,
    preserveFailure = false,
  ): Promise<T | InspectionUnavailable> {
    if (this.#closed) return unavailable("closed");
    this.#pending++;
    const prior = this.#queue.tail;
    let release = () => {};
    this.#queue.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      this.#assert();
      return await operation();
    } catch (error) {
      rethrowBusy(error);
      if (preserveFailure || error instanceof CaptureFailed) throw error;
      const failure = inspectionFailure(error);
      if (failure.reason === "budget" || failure.reason === "cancelled")
        return failure;
      this.#inspectionFailureCheck ??=
        error instanceof PrivateInspectionError
          ? error.check
          : "private-store-operation";
      this.#poisoned = true;
      this.#cached?.engine.destroy();
      this.#cached = undefined;
      return unavailable("private-store");
    } finally {
      this.#pending--;
      release();
    }
  }
  #engineFor(
    row: ReturnType<typeof readState>,
    budget: InspectionBudget,
  ): CredentialDetectors {
    if (this.#cached && timingSafeEqual(this.#cached.mac, row.mac))
      return this.#cached.engine;
    this.#cached?.engine.destroy();
    const engine = CredentialDetectors.restorePrivate(
      row.key,
      row.state,
      budget,
    );
    this.#cached = { engine, mac: Buffer.from(row.mac) };
    return engine;
  }
  async register(input: {
    readonly epoch: CredentialEpochId;
    readonly headers: Headers;
    readonly budget: InspectionBudget;
    readonly escapedUnits?: number;
    readonly deduplicate?: boolean;
    readonly deriveEpoch?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly status: "registered"; readonly epoch: CredentialEpochId }
    | InspectionUnavailable
  > {
    return this.#exclusive(async () => {
      this.#assert();
      let beginFailure: CaptureFailed | undefined;
      try {
        writeRegistration(() => this.#database.exec("BEGIN IMMEDIATE"));
      } catch (cause) {
        if (!input.deriveEpoch || !(cause instanceof CaptureFailed))
          throw cause;
        beginFailure = cause;
      }
      let engine: CredentialDetectors | undefined;
      let row: ReturnType<typeof readState> | undefined;
      let epochId: CredentialEpochId | undefined;
      let adopted = false;
      try {
        row = readState(this.#database, this.#source, input.budget);
        engine = this.#engineFor(row, input.budget).forkPrivate();
        const result = await engine.register(input);
        if (result.status === "registered" && input.deriveEpoch)
          epochId = result.epoch;
        if (beginFailure !== undefined) throw beginFailure;
        if (result.status !== "registered") return result;
        this.#assert();
        const state = engine.encodePrivate(input.budget);
        if (state.byteLength > MAX_STATE)
          fail("state-size", join(this.#options.directory, FILE));
        const update = this.#database.query(
          "UPDATE authority SET state=?, mac=? WHERE id=1",
        );
        const signature =
          row.provenanceText === undefined
            ? mac(row.key, this.#source, state)
            : provenanceMac(row.key, this.#source, state, row.provenanceText);
        writeRegistration(() => update.run(state, signature));
        writeRegistration(() => this.#database.exec("COMMIT"));
        writeRegistration(() => syncDirectory(this.#options.directory));
        this.#assert();
        const reread = readState(this.#database, this.#source, input.budget);
        if (!Buffer.from(state).equals(reread.state))
          fail("committed-state", join(this.#options.directory, FILE));
        this.#cached?.engine.destroy();
        this.#cached = { engine, mac: Buffer.from(reread.mac) };
        reread.key.fill(0);
        adopted = true;
        return result;
      } catch (cause) {
        if (epochId !== undefined && cause instanceof CaptureFailed)
          throw new CaptureFailed({ ...cause, epochId });
        throw cause;
      } finally {
        if (!adopted) engine?.destroy();
        row?.key.fill(0);
        if (this.#database.inTransaction) this.#database.exec("ROLLBACK");
      }
    });
  }
  /** One authenticated inventory, fenced against registration until every borrowed source is checked. */
  async inspectSources(input: {
    readonly sources: ReadonlyArray<CredentialSource> | SourceProducer;
    readonly shouldScan?: (epochs: ReadonlyArray<CredentialEpochId>) => boolean;
    readonly progress?: (value: InspectionProgress) => void;
    readonly requiredEpochs: ReadonlyArray<string>;
    readonly budget: InspectionBudget;
  }): Promise<
    | {
        readonly status: "inspected";
        readonly epochs: ReadonlyArray<CredentialEpochId>;
        readonly results: ReadonlyArray<InspectionResult>;
        readonly exposedEpochs: ReadonlyArray<CredentialEpochId>;
      }
    | (InspectionUnavailable & { readonly record: number })
  > {
    let record = 0;
    const observed = new Set<CredentialEpochId>();
    const outcome = await this.#exclusive<
      | {
          readonly status: "inspected";
          readonly epochs: ReadonlyArray<CredentialEpochId>;
          readonly results: ReadonlyArray<InspectionResult>;
          readonly exposedEpochs: ReadonlyArray<CredentialEpochId>;
        }
      | InspectionUnavailable
    >(async () => {
      this.#database.exec(
        this.#checkpoint === undefined ? "BEGIN IMMEDIATE" : "BEGIN",
      );
      let row: ReturnType<typeof readState> | undefined;
      let committed = false;
      try {
        row = readState(this.#database, this.#source, input.budget);
        const engine = this.#engineFor(row, input.budget);
        const epochs = engine.epochIds;
        const sources = input.sources;
        const produce: SourceProducer =
          typeof sources === "function"
            ? async (consume) =>
                sources(async (source) => {
                  record++;
                  await consume(source);
                })
            : async (consume) => {
                for (const source of sources) await consume(source);
              };
        const results =
          input.shouldScan?.(epochs) === false
            ? []
            : await inspectInventory({
                produce,
                ...(typeof sources !== "function" && sources.length < 256
                  ? { width: 1 }
                  : {}),
                engine,
                key: row.key,
                state: row.state,
                budget: input.budget,
                requiredEpochs: [
                  ...new Set([...input.requiredEpochs, ...epochs]),
                ],
                observe: (epoch) => observed.add(epoch),
                progress: input.progress,
              });
        record = results.length;
        this.#assert();
        this.#database.exec("COMMIT");
        committed = true;
        this.#assert();
        // Re-read outside the transaction so its pinned read view cannot hide a changed authority.
        const current = readState(this.#database, this.#source, input.budget);
        try {
          if (
            !Buffer.from(current.state).equals(row.state) ||
            !timingSafeEqual(current.key, row.key)
          )
            fail("unchanged-state", join(this.#options.directory, FILE));
        } finally {
          current.key.fill(0);
        }
        return {
          status: "inspected",
          epochs,
          results,
          exposedEpochs: [...observed],
        };
      } catch (error) {
        rethrowBusy(error);
        const failure = inspectionFailure(error, [...observed]);
        if (failure.reason === "budget" || failure.reason === "cancelled")
          return failure;
        this.#inspectionFailureCheck ??=
          error instanceof PrivateInspectionError
            ? error.check
            : "private-store-operation";
        this.#poisoned = true;
        this.#cached?.engine.destroy();
        this.#cached = undefined;
        return unavailable("private-store", [...observed]);
      } finally {
        row?.key.fill(0);
        if (!committed) this.#database.exec("ROLLBACK");
      }
    });
    return outcome.status === "unavailable"
      ? {
          ...outcome,
          exposedEpochs: [...new Set([...outcome.exposedEpochs, ...observed])],
          record,
        }
      : outcome;
  }
  async inspectText(input: {
    readonly text: string;
    readonly budget: InspectionBudget;
    readonly signal?: AbortSignal;
  }): Promise<InspectionResult> {
    return this.#inspect((engine) => engine.inspectText(input), input.budget);
  }
  async inspectJson(input: {
    readonly json: CredentialJson;
    readonly budget: InspectionBudget;
    readonly signal?: AbortSignal;
    /** A live call with a lost registration may have no historical epochs to observe. */
    readonly allowEmpty?: boolean;
  }): Promise<InspectionResult> {
    return this.#inspect(
      (engine) =>
        input.allowEmpty &&
        !input.signal?.aborted &&
        engine.epochIds.length === 0
          ? Promise.resolve({ status: "complete", epochs: [], matches: [] })
          : engine.inspectJson(input),
      input.budget,
    );
  }
  async inspectArtifact(
    input: ArtifactSource & {
      readonly budget: InspectionBudget;
      readonly signal?: AbortSignal;
    },
  ): Promise<InspectionResult> {
    return this.#inspect(
      (engine) => engine.inspectArtifact(input),
      input.budget,
    );
  }
  async #inspect(
    operation: (engine: CredentialDetectors) => Promise<InspectionResult>,
    budget: InspectionBudget,
  ): Promise<InspectionResult> {
    return this.#exclusive(async () => {
      const row = readState(this.#database, this.#source, budget);
      const engine = this.#engineFor(row, budget);
      let observed: ReadonlyArray<CredentialEpochId> = [];
      try {
        const result = await operation(engine);
        observed =
          result.status === "complete"
            ? [...new Set(result.matches.map((match) => match.epoch))]
            : result.exposedEpochs;
        this.#assert();
        const current = readState(this.#database, this.#source, budget);
        if (
          !Buffer.from(current.state).equals(row.state) ||
          !timingSafeEqual(current.key, row.key)
        )
          fail("unchanged-state", join(this.#options.directory, FILE));
        current.key.fill(0);
        return result;
      } catch (error) {
        const failure = inspectionFailure(error, observed);
        if (failure.reason === "budget" || failure.reason === "cancelled")
          return failure;
        this.#inspectionFailureCheck ??=
          error instanceof PrivateInspectionError
            ? error.check
            : "private-store-operation";
        this.#poisoned = true;
        this.#cached?.engine.destroy();
        this.#cached = undefined;
        return unavailable("private-store", observed);
      } finally {
        row.key.fill(0);
      }
    });
  }
  close(): void {
    if (this.#closed) return;
    if (this.#pending !== 0)
      fail("no-pending-inspections", this.#options.directory);
    this.#closed = true;
    this.#cached?.engine.destroy();
    this.#cached = undefined;
    this.#database.close();
  }
}
export const createPrivateInspection = (
  options: PrivateInspectionOptions,
): PrivateInspection => PrivateInspection.create(options);
export const openPrivateInspection = (
  options: PrivateInspectionOptions,
): PrivateInspection => PrivateInspection.open(options);
