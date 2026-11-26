import { enqueueTelemetry, type RunLog } from "../../run-log.ts";
import { CredentialJson } from "./credential-detectors.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  statSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { STORE_DIRECTORY_MODE, STORE_FILE_MODE } from "@neuve/records-core";
import { z } from "zod";
import { maskArtifact } from "./mask.ts";
import { isJsonObject } from "./json-walk.ts";
import {
  CAPTURE_VERSION,
  CAPTURE_LOSS_FILE,
  CaptureLoss,
  captureFileLimit,
  CaptureFailed,
  DEFAULT_LIMITS,
  type DumpLimits,
  CapturedEvent,
  JournalLine,
  JOURNAL_FILE,
  journalObjectFile,
  Json,
  OBJECTS_DIRECTORY,
  RAW_JOURNAL_FILE,
  type Capture,
  type CaptureEvent,
  type ModelCapture,
  type CaptureScope,
  type JournalMark,
  type CredentialCertificate,
} from "./types.ts";

/**
 * A run's capture journal: `events.jsonl`, one validated event per line in the order captured, and
 * `objects/<sha256>`, the bytes of artifacts and shared model content. It lives in the run folder beside
 * pi's database, unmasked like pi's own records, and is read by the capture before the run folder
 * is removed. Each line is one synchronous append, so a process crash keeps every line before it.
 *
 * Completeness is proved, never assumed: each process's session opens with `journal.open` and ends
 * with `journal.close`. Capture loss is kept separately so it can be recorded when this file
 * is full. An unclosed session also discloses interruption.
 */

export { JOURNAL_FILE, OBJECTS_DIRECTORY } from "./types.ts";
export const LOST_WRITE_PREFIX = "capture write lost: ";

export const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const journalLimit = (limits: DumpLimits) =>
  captureFileLimit(JOURNAL_FILE, limits);

class JournalFull extends Error {
  constructor(
    message: string,
    readonly journalFull = false,
  ) {
    super(message);
  }
}

const writeFailure = (event: string, error: unknown) =>
  new CaptureFailed({
    kind: error instanceof JournalFull ? "full" : "io",
    event,
    detail: message(error),
    ...(error instanceof JournalFull && error.journalFull
      ? { journalFull: true }
      : {}),
    ...(error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
      ? { writeCode: error.code }
      : {}),
  });

const DiskLine = JournalLine.extend({ refs: z.literal(true).optional() });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
type JsonObject = { readonly [key: string]: Json };
type ListField = "input" | "messages" | "sdkMessages";
const bodyLists = ["input", "messages"] as const;

const mapContent = (
  event: JournalLine["event"],
  map: (value: Json) => Json,
  list: (field: ListField, items: readonly Json[]) => Json[],
): JournalLine["event"] => {
  const fields = (value: JsonObject, keys: readonly string[]) => {
    const mapped = { ...value };
    for (const key of keys) {
      const item = value[key];
      if (item !== undefined) mapped[key] = map(item);
    }
    return mapped;
  };
  if (event.type === "model.request") {
    const { body, sdkContext } = event;
    let mappedBody = body;
    if (body.status === "sent" && isJsonObject(body.json)) {
      const json = fields(body.json, ["tools", "instructions", "system"]);
      for (const key of bodyLists) {
        const items = body.json[key];
        if (Array.isArray(items)) json[key] = list(key, items);
      }
      mappedBody = { ...body, json };
    }
    return {
      ...event,
      body: mappedBody,
      ...(sdkContext === undefined
        ? {}
        : {
            sdkContext: {
              ...sdkContext,
              messages: list("sdkMessages", sdkContext.messages),
            },
          }),
    };
  }
  if (
    event.type === "model.event" &&
    /^response\.(created|queued|in_progress|completed|failed|incomplete)$/.test(
      event.name,
    ) &&
    isJsonObject(event.data) &&
    event.data["response"] !== undefined &&
    isJsonObject(event.data["response"])
  )
    return {
      ...event,
      data: {
        ...event.data,
        response: fields(event.data["response"], ["instructions", "tools"]),
      },
    };
  return event;
};

const requestList = (
  event: JournalLine["event"] | undefined,
  field: ListField,
) => {
  if (event?.type !== "model.request") return undefined;
  if (field === "sdkMessages") return event.sdkContext?.messages;
  if (event.body.status !== "sent" || !isJsonObject(event.body.json))
    return undefined;
  const items = event.body.json[field];
  return Array.isArray(items) ? items : undefined;
};

/** How long a session holds `events.jsonl` open with no line appended before it lets it go. */
export const IDLE_RELEASE_MS = 1_000;

/** A file a tool wrote, such as pi's bash `full_output` spill, to keep as an artifact. */
export interface SpillFile {
  readonly scope: CaptureScope;
  readonly name: string;
  readonly mediaType: string;
  readonly path: string;
}

export interface JournalOptions {
  readonly log?: RunLog | undefined;
  /** The folders tool-generated files are written to (the environment's temp folder); `ingest` reads nowhere else. */
  readonly spillRoots?: ReadonlyArray<string> | undefined;
  /** The largest file `ingest` keeps, within `limits.objectBytes`; a larger one is refused, never cut short. */
  readonly maxSpillBytes?: number | undefined;
  readonly limits?: DumpLimits | undefined;
  readonly allowCredentialLoss?: true;
  readonly onCaptureLoss?:
    ((loss: CaptureLoss, persisted: boolean) => void) | undefined;
}

export const DEFAULT_MAX_SPILL_BYTES = 256 * 1024 * 1024;

export interface CaptureJournal {
  readonly directory: string;
  readonly capture: Capture;
  /**
   * Streams one tool-generated file into `objects/`, hashing while it copies, and appends its
   * artifact event. The original is left in place: the model was told its path. Rejects with
   * `CaptureFailed` as `capture` throws: `invalid` for a path outside the spill roots, a link, or a
   * file over the limit; `io` when it cannot be read or kept.
   */
  readonly ingest: (file: SpillFile) => Promise<void>;
  /**
   * Ends this process's session with `journal.close`. An unresolved write or an ingest still in
   * flight leaves the session unclosed. Every ending releases the file. A descriptor close error
   * is reported as `io` even when the close mark is already written.
   */
  readonly close: () => void;
  readonly certifyAll: (
    count: number,
    prepare: (
      frames: ReadonlyArray<CredentialJson>,
    ) => Promise<
      ReadonlyArray<Extract<CapturedEvent, { type: "credential.inspection" }>>
    >,
    inspect: (frame: CredentialJson) => Promise<void>,
  ) => Promise<void>;
}

type JournalState =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Failed"; readonly failure: CaptureFailed }
  | { readonly _tag: "Closed" };

const TORN = /^torn-\d+-\d+\.partial$/;

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The complete lines of a journal a crashed process left behind. A line cut short mid-append is
 * moved aside to `torn-<seq>-<ms>.partial`, which the reader discloses, so the next append starts on a
 * fresh line instead of running into it.
 */
const completeLines = (path: string, directory: string, limit: number) => {
  if (!existsSync(path)) return { lines: 0, bytes: 0 };
  const size = statSync(path).size;
  if (size > limit)
    throw new JournalFull(
      `${JOURNAL_FILE} is ${size} bytes, over the ${limit}-byte limit`,
      true,
    );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let lines = 0;
  let end = 0;
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (let offset = 0; offset < size;) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, size - offset),
        offset,
      );
      if (count === 0) throw new Error(`${JOURNAL_FILE} changed while opening`);
      const bytes = chunk.subarray(0, count);
      decoder.decode(bytes, { stream: true });
      for (
        let index = bytes.indexOf(10);
        index !== -1;
        index = bytes.indexOf(10, index + 1)
      ) {
        lines++;
        end = offset + index + 1;
      }
      offset += count;
    }
    decoder.decode();
    if (end < size) {
      const torn = openSync(
        join(directory, `torn-${lines + 1}-${Date.now()}.partial`),
        "wx",
        STORE_FILE_MODE,
      );
      try {
        for (let offset = end; offset < size;) {
          const count = readSync(
            fd,
            chunk,
            0,
            Math.min(chunk.length, size - offset),
            offset,
          );
          if (count === 0)
            throw new Error(`${JOURNAL_FILE} changed while opening`);
          writeFileSync(torn, chunk.subarray(0, count));
          offset += count;
        }
      } finally {
        closeSync(torn);
      }
    }
  } finally {
    closeSync(fd);
  }
  if (end < size) truncateSync(path, end);
  return { lines, bytes: end };
};

const syncPath = (path: string) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const keepBytes = (objects: string, bytes: Uint8Array, sha256: string) => {
  const target = join(objects, sha256);
  const held = lstatSync(target, { throwIfNoEntry: false });
  if (
    held?.isFile() &&
    held.size === bytes.byteLength &&
    sha256Of(readFileSync(target)) === sha256
  ) {
    syncPath(target);
    return;
  }
  const staging = join(objects, `${randomUUID()}.partial`);
  try {
    writeFileSync(staging, bytes, { mode: STORE_FILE_MODE, flag: "wx" });
    syncPath(staging);
    if (sha256Of(readFileSync(staging)) !== sha256)
      throw new Error("capture object did not read back with its hash");
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
};

/** pi's bash tool names its spilled full output in a `full_output` diagnostic. */
export const fullOutputPath = (
  diagnostics: ReadonlyArray<{
    readonly code: string;
    readonly message: string;
  }>,
) => {
  const found = diagnostics.find((d) => d.code === "full_output");
  return found?.message.startsWith("Full output: ")
    ? found.message.slice("Full output: ".length)
    : undefined;
};

class SpillRefused extends Error {}

/**
 * The spill's real path, only when it lies inside one of the roots with no link anywhere below the
 * root: the path as given and as resolved must name the same place.
 */
const ownedSpill = async (path: string, roots: ReadonlyArray<string>) => {
  const given = resolve(path);
  for (const root of roots) {
    const base = resolve(root);
    if (!given.startsWith(`${base}${sep}`)) continue;
    const real = await realpath(given).catch(() => {
      throw new SpillRefused(`${path} does not exist`);
    });
    if (real !== join(await realpath(base), relative(base, given)))
      throw new SpillRefused(`${path} goes through a link`);
    return real;
  }
  throw new SpillRefused(`${path} is outside the tool-generated roots`);
};

/**
 * Copies a file into `objects/` under its hash without reading it whole: opened without following
 * a link, checked as a regular file within the limit, streamed through the hash into a staging
 * file, then renamed into place.
 */
const keepFile = async (objects: string, path: string, maxBytes: number) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const staging = join(objects, `${randomUUID()}.partial`);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SpillRefused(`${path} is not a regular file`);
    if (info.size > maxBytes)
      throw new SpillRefused(`${path} is over the ${maxBytes}-byte limit`);
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(
      createReadStream("", { fd: handle, autoClose: false }),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          size += chunk.byteLength;
          if (size > maxBytes)
            throw new SpillRefused(
              `${path} grew over the ${maxBytes}-byte limit`,
            );
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(staging, { flags: "wx", mode: STORE_FILE_MODE }),
    );
    const sha256 = hash.digest("hex");
    syncPath(staging);
    await rename(staging, join(objects, sha256));
    syncPath(objects);
    return { sha256, size };
  } finally {
    await handle.close();
    await rm(staging, { force: true });
  }
};

export const decodeCaptureLosses = (bytes: Uint8Array) =>
  z
    .array(CaptureLoss)
    .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));

export const readCaptureLosses = (
  directory: string,
  limits = DEFAULT_LIMITS,
) => {
  const path = join(directory, CAPTURE_LOSS_FILE);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > captureFileLimit(CAPTURE_LOSS_FILE, limits)
    )
      throw new Error("Capture loss file is outside its file or size limits");
    return decodeCaptureLosses(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
};

const captureLossRecorder = (
  directory: string,
  options: Pick<JournalOptions, "limits" | "onCaptureLoss"> = {},
): Required<Pick<ModelCapture, "recordLoss" | "journalFull">> => {
  const limits = options.limits ?? DEFAULT_LIMITS;
  let full = false;
  return {
    journalFull: () => full,
    recordLoss(loss, journalFull) {
      full ||= journalFull;
      let persisted = false;
      try {
        const losses = readCaptureLosses(directory, limits);
        if (!losses.some(({ callId }) => callId === loss.callId)) {
          const bytes = Buffer.from(
            JSON.stringify([...losses, CaptureLoss.parse(loss)]) + "\n",
          );
          if (bytes.byteLength > captureFileLimit(CAPTURE_LOSS_FILE, limits))
            throw new Error("Capture loss file reached its size limit");
          const staging = join(directory, `${randomUUID()}.partial`);
          try {
            writeFileSync(staging, bytes, {
              mode: STORE_FILE_MODE,
              flag: "wx",
            });
            syncPath(staging);
            renameSync(staging, join(directory, CAPTURE_LOSS_FILE));
            syncPath(directory);
          } finally {
            rmSync(staging, { force: true });
          }
        }
        persisted = true;
      } finally {
        options.onCaptureLoss?.(loss, persisted);
      }
    },
  };
};

/**
 * Opens or reopens the journal of run `runId` and starts this process's session. A reopened journal
 * continues its sequence. Throws `CaptureFailed` when the session cannot be started.
 */
export const openCaptureJournal = (
  directory: string,
  runId: string,
  options: JournalOptions = {},
): CaptureJournal => {
  const path = join(directory, JOURNAL_FILE);
  const objects = join(directory, OBJECTS_DIRECTORY);
  const limits = options.limits ?? DEFAULT_LIMITS;
  const limit = journalLimit(limits);
  const closeReserve = options.allowCredentialLoss
    ? Buffer.byteLength(
        JSON.stringify({
          v: CAPTURE_VERSION,
          seq: Number.MAX_SAFE_INTEGER,
          at: Number.MAX_SAFE_INTEGER,
          event: { type: "journal.close", scope: { runId } },
        }),
      ) + 1
    : 0;
  let seq: number;
  let journalBytes: number;
  try {
    mkdirSync(objects, { recursive: true, mode: STORE_DIRECTORY_MODE });
    syncPath(directory);
    ({ lines: seq, bytes: journalBytes } = completeLines(
      path,
      directory,
      limit,
    ));
  } catch (error) {
    throw writeFailure("journal.open", error);
  }
  // The session appends through one descriptor, opened by its first line after a torn tail is cut,
  // instead of opening and closing the file per line (0.9-1.9 ms a line on a busy disk against
  // 24-36 µs). Each line is still one complete write that reaches the file before `capture` returns,
  // so a crash keeps every line before it. Every ending lets the descriptor go, and so does a quiet
  // spell, so a session its caller abandons holds nothing for long; its next line opens it again.
  let fd: number | undefined;
  // The file the session opened. A later open, and the close mark, must find this same file.
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let appendedSinceSweep = false;
  const watchIdle = () => {
    idle = setTimeout(sweep, IDLE_RELEASE_MS);
    idle.unref();
  };
  const sweep = () => {
    idle = undefined;
    if (fd === undefined) return;
    if (!appendedSinceSweep) return letGo();
    appendedSinceSweep = false;
    watchIdle();
  };
  const descriptor = () => {
    if (fd !== undefined) {
      // A write by path failed once the run folder was gone; a held descriptor would write on into
      // the removed file, so a file no longer linked anywhere is refused the same way.
      if (fstatSync(fd).nlink === 0)
        throw new Error(
          `${JOURNAL_FILE} was removed while its session was open`,
        );
      return fd;
    }
    // Only the session's first open may create the file.
    const opened = openSync(
      path,
      identity === undefined ? "a" : constants.O_WRONLY | constants.O_APPEND,
      STORE_FILE_MODE,
    );
    try {
      const { dev, ino } = fstatSync(opened);
      identity ??= { dev, ino };
      if (dev !== identity.dev || ino !== identity.ino)
        throw new Error(
          `${JOURNAL_FILE} was replaced while its session was open`,
        );
    } catch (error) {
      closeSync(opened);
      throw error;
    }
    fd = opened;
    watchIdle();
    return opened;
  };
  /** A descriptor follows a moved file, so a session is marked whole only where its path still names it. */
  const stillAtPath = () => {
    const at = lstatSync(path);
    if (at.dev !== identity?.dev || at.ino !== identity.ino)
      throw new Error(
        `${JOURNAL_FILE} was moved or replaced while its session was open`,
      );
  };
  const release = () => {
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
    if (fd === undefined) return;
    const held = fd;
    fd = undefined;
    closeSync(held);
  };
  let state: JournalState = { _tag: "Open" };
  const keptHashes = new Set<string>();
  const keep = (bytes: Uint8Array, sha256: string) => {
    if (bytes.byteLength > limits.objectBytes)
      throw new JournalFull(
        `capture object exceeds the ${limits.objectBytes}-byte limit`,
      );
    keepBytes(objects, bytes, sha256);
  };
  const priorLists = new Map<string, { seq: number; hashes: string[] }>();
  // A call lives in one process, so this session's requests are every call its events may name.
  const requested = new Set<string>();
  let appendCount = 0;
  let appendMs = 0;
  let maxAppendMs = 0;
  let serializedBytes = 0;
  let appendFailures = 0;
  let summarized = false;
  const summarize = (status: "ok" | "error") => {
    if (summarized || options.log === undefined) return;
    summarized = true;
    enqueueTelemetry(options.log, {
      type: "metric",
      name: "harness.journal.append",
      kind: "Summary",
      status,
      state: { count: appendCount, sum: appendMs, max: maxAppendMs },
      attributes: {
        "harness.serialized_bytes": serializedBytes,
        "harness.append_failures": appendFailures,
      },
    });
  };
  // Lets the descriptor go while the session stays open. A close that fails may have lost a write,
  // so the session may no longer be marked whole: it fails, and its missing close mark says so.
  const letGo = () => {
    try {
      release();
    } catch (error) {
      if (state._tag !== "Open") return;
      state = {
        _tag: "Failed",
        failure: new CaptureFailed({
          kind: "io",
          event: "journal.release",
          detail: message(error),
        }),
      };
      summarize("error");
    }
  };
  // After the close mark a reader judges the session whole, and it is: every line was one complete
  // write. So it stays closed when its descriptor then fails to close, and the caller still hears.
  const closedUnreleased = (error: unknown) =>
    new CaptureFailed({
      kind: "io",
      event: "journal.close",
      detail: `the session is closed whole, but ${JOURNAL_FILE} did not close: ${message(error)}`,
    });

  let torn = false;
  // A loss without a call ID cannot be cleared by a call retry or a loss record.
  const pendingLosses = new Map<string, CaptureFailed>();
  const pendingNonCallWrites = new Map<string, CaptureFailed>();
  const rejectWrite = (failure: CaptureFailed, callId?: string): never => {
    if (callId === undefined) pendingNonCallWrites.set(failure.event, failure);
    else pendingLosses.set(callId, failure);
    letGo();
    throw failure;
  };
  const append = (event: JournalLine["event"], at = Date.now()) => {
    const started = options.log === undefined ? 0 : performance.now();
    let succeeded = false;
    try {
      const pending = new Map<string, Uint8Array>();
      let references = false;
      const lists = new Map<string, { seq: number; hashes: string[] }>();
      const reference = (value: Json) => {
        references = true;
        const bytes = Buffer.from(JSON.stringify(value));
        const sha256 = sha256Of(bytes);
        if (!keptHashes.has(sha256) && !pending.has(sha256))
          pending.set(sha256, bytes);
        return sha256;
      };
      const compact = mapContent(event, reference, (field, items) => {
        const hashes = items.map(reference);
        if (hashes.length === 0) return hashes;
        const key = `${field}:${hashes[0]}`;
        const prior = priorLists.get(key);
        lists.set(key, { seq: seq + 1, hashes });
        if (prior === undefined) return hashes;
        let count = 0;
        while (count < hashes.length && hashes[count] === prior.hashes[count])
          count++;
        return [prior.seq, count, ...hashes.slice(count)];
      });
      const line: z.infer<typeof DiskLine> = {
        v: CAPTURE_VERSION,
        seq: seq + 1,
        at,
        event: compact,
        ...(references ? { refs: true } : {}),
      };
      const text = `${JSON.stringify(line)}\n`;
      const bytes = Buffer.byteLength(text);
      serializedBytes += bytes;
      if (
        journalBytes +
          bytes +
          (event.type === "journal.close" ? 0 : closeReserve) >
        limit
      )
        throw new JournalFull(
          `${JOURNAL_FILE} would grow over the ${limit}-byte limit`,
          true,
        );
      for (const [sha256, bytes] of pending) keep(bytes, sha256);
      if (pending.size > 0) {
        syncPath(objects);
        for (const sha256 of pending.keys()) keptHashes.add(sha256);
      }
      const fd = descriptor();
      if (torn) ftruncateSync(fd, journalBytes);
      torn = true;
      appendFileSync(fd, text);
      torn = false;
      for (const [key, list] of lists) priorLists.set(key, list);
      appendedSinceSweep = true;
      journalBytes += bytes;
      seq += 1;
      succeeded = true;
    } finally {
      if (options.log !== undefined) {
        const elapsed = performance.now() - started;
        appendCount += 1;
        appendMs += elapsed;
        maxAppendMs = Math.max(maxAppendMs, elapsed);
        if (!succeeded) appendFailures += 1;
      }
    }
  };

  const mark = (type: JournalMark["type"], reason?: string) =>
    append(
      type === "journal.failed"
        ? { type, scope: { runId }, reason: reason ?? "" }
        : type === "journal.open" && options.allowCredentialLoss
          ? { type, scope: { runId }, allowCredentialLoss: true }
          : { type, scope: { runId } },
    );

  const fail = (failure: CaptureFailed): never => {
    state = { _tag: "Failed", failure };
    if (failure.kind === "invalid")
      try {
        mark("journal.failed", `${failure.event}: ${failure.detail}`);
      } catch {}
    try {
      release();
    } catch {}
    summarize("error");
    throw failure;
  };

  const invalid = (event: string, detail: string) =>
    fail(new CaptureFailed({ kind: "invalid", event, detail }));

  const failIfPending = () => {
    const pending =
      pendingNonCallWrites.values().next().value ??
      pendingLosses.values().next().value;
    if (pendingNonCallWrites.size > 0)
      try {
        stillAtPath();
        mark(
          "journal.failed",
          LOST_WRITE_PREFIX + [...pendingNonCallWrites.keys()].join(", "),
        );
      } catch {
        // A journal that still cannot be written remains visibly unclosed.
      }
    if (pending !== undefined) fail(pending);
  };

  const stored = (event: CaptureEvent) => {
    if (event.type !== "artifact") return event;
    if (event.bytes.byteLength > limits.objectBytes)
      return invalid(
        "artifact",
        `${event.name}: ${event.bytes.byteLength} bytes, over the ${limits.objectBytes}-byte object limit`,
      );
    const readable = maskArtifact(event.mediaType, event.bytes);
    try {
      const sha256 = sha256Of(event.bytes);
      if (!keptHashes.has(sha256)) {
        keep(event.bytes, sha256);
        syncPath(objects);
        keptHashes.add(sha256);
      }
      if (readable._tag === "Malformed")
        return invalid(
          "artifact",
          `${event.name} (${event.mediaType}): ${readable.reason}`,
        );
      return {
        type: event.type,
        scope: event.scope,
        name: event.name,
        mediaType: event.mediaType,
        sha256,
        size: event.bytes.byteLength,
      };
    } catch (error) {
      if (error instanceof CaptureFailed) throw error;
      return rejectWrite(writeFailure("artifact", error));
    }
  };

  const admit = (type: string) => {
    if (state._tag === "Failed" && state.failure.kind === "io")
      throw state.failure;
    if (state._tag !== "Open")
      throw new CaptureFailed({
        kind:
          state._tag === "Failed" && state.failure.kind === "full"
            ? "full"
            : "failed",
        event: type,
        ...(state._tag === "Failed" && state.failure.journalFull
          ? { journalFull: true }
          : {}),
        detail:
          state._tag === "Closed"
            ? "the journal's session is closed"
            : `an earlier capture failed (${state.failure.event}: ${state.failure.detail})`,
      });
  };

  const accept = (type: string, candidate: unknown) => {
    const parsed = CapturedEvent.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return invalid(
        type,
        `${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid"}`,
      );
    }
    const kept = parsed.data;
    if (kept.scope.runId !== runId)
      return invalid(type, `belongs to run ${kept.scope.runId}, not ${runId}`);
    if (kept.type === "model.request" && requested.has(kept.callId))
      return invalid(type, `call ${kept.callId} was already requested`);
    if (
      (kept.type === "model.response" ||
        kept.type === "model.event" ||
        kept.type === "model.end") &&
      !requested.has(kept.callId)
    )
      return invalid(type, `call ${kept.callId} was never requested`);
    try {
      if (
        (type.startsWith("model.") || type === "credential.registration") &&
        loss.journalFull()
      )
        throw new JournalFull(
          `${JOURNAL_FILE} reached its ${limit}-byte limit`,
          true,
        );
      append(kept);
      if (kept.type === "model.request") requested.add(kept.callId);
      if ("callId" in kept && pendingLosses.get(kept.callId)?.event === type)
        pendingLosses.delete(kept.callId);
    } catch (error) {
      const failure = writeFailure(type, error);
      if (!("callId" in kept)) return rejectWrite(failure);
      if (type.startsWith("model.") || type === "credential.registration")
        return rejectWrite(failure, kept.callId);
      fail(failure);
    }
  };

  const loss = captureLossRecorder(directory, {
    limits: options.limits,
    onCaptureLoss(record, persisted) {
      if (persisted) pendingLosses.delete(record.callId);
      else if (
        options.allowCredentialLoss &&
        record.event === "credential.registration"
      )
        pendingLosses.set(
          record.callId,
          new CaptureFailed({
            kind: record.kind,
            event: record.event,
            detail: "credential registration loss could not be recorded",
          }),
        );
      options.log?.write({
        type: "capture.loss",
        runId,
        ...record,
        persisted,
      });
      options.onCaptureLoss?.(record, persisted);
    },
  });
  const capture: Capture = Object.assign(
    (event: CaptureEvent) => {
      admit(event.type);
      accept(event.type, stored(event));
    },
    loss,
    {
      allowCredentialLoss: () =>
        options.allowCredentialLoss === true && state._tag === "Open",
    },
  );

  const roots = options.spillRoots ?? [];
  const maxSpillBytes = Math.min(
    options.maxSpillBytes ?? DEFAULT_MAX_SPILL_BYTES,
    limits.objectBytes,
  );
  let ingesting = 0;
  const ingest = async (file: SpillFile) => {
    admit("artifact");
    ingesting += 1;
    try {
      await keepSpill(file);
    } finally {
      ingesting -= 1;
    }
  };
  const keepSpill = async (file: SpillFile) => {
    let kept: { sha256: string; size: number };
    try {
      kept = await keepFile(
        objects,
        await ownedSpill(file.path, roots),
        maxSpillBytes,
      );
    } catch (error) {
      // Another capture may have failed while the file streamed; its failure stands.
      admit("artifact");
      const detail = `${file.name}: ${message(error)}`;
      if (error instanceof SpillRefused) return invalid("artifact", detail);
      return rejectWrite(
        new CaptureFailed({ kind: "io", event: "artifact", detail }),
      );
    }
    admit("artifact");
    accept("artifact", {
      type: "artifact",
      scope: file.scope,
      name: file.name,
      mediaType: file.mediaType,
      ...kept,
    });
  };

  const close = () => {
    if (state._tag === "Failed") throw state.failure;
    if (state._tag === "Closed") return;
    failIfPending();
    if (ingesting > 0)
      invalid(
        "journal.close",
        `${ingesting} artifact ingest(s) still in flight; the session is not whole`,
      );
    try {
      stillAtPath();
      mark("journal.close");
    } catch (error) {
      fail(writeFailure("journal.close", error));
    }
    state = { _tag: "Closed" };
    summarize("ok");
    try {
      release();
    } catch (error) {
      throw closedUnreleased(error);
    }
  };

  try {
    mark("journal.open");
    // An unclosed session must hold exports even if no later write reaches disk.
    if (options.allowCredentialLoss) {
      fsyncSync(descriptor());
      syncPath(directory);
      syncPath(dirname(directory));
    }
  } catch (error) {
    try {
      release();
    } catch {}
    throw writeFailure("journal.open", error);
  }
  const certifyAll: CaptureJournal["certifyAll"] = async (
    count,
    prepare,
    inspect,
  ) => {
    admit("credential.inspection");
    try {
      failIfPending();
      if (!Number.isSafeInteger(count) || count < 1)
        return invalid(
          "credential.inspection",
          "certificate count must be positive",
        );
      const expected = seq,
        at = Date.now();
      const closing = {
        v: CAPTURE_VERSION,
        seq: expected + count + 1,
        at,
        event: { type: "journal.close" as const, scope: { runId } },
      };
      const completed = await prepare([CredentialJson.serialize(closing)]);
      if (completed.length !== count)
        return invalid(
          "credential.inspection",
          "certificate preparation changed its frame count",
        );
      const rows = [
        ...completed.map((event, index) => ({
          v: CAPTURE_VERSION,
          seq: expected + index + 1,
          at,
          event: CapturedEvent.parse(event),
        })),
        closing,
      ];
      for (const row of rows) await inspect(CredentialJson.serialize(row));
      // The session may have failed or closed while certificates were prepared and inspected.
      admit("credential.inspection");
      failIfPending();
      if (seq !== expected)
        return invalid(
          "credential.inspection",
          "journal changed while preparing certificate administration",
        );
      try {
        stillAtPath();
        for (const row of rows) append(row.event, row.at);
      } catch (error) {
        return fail(writeFailure("credential.inspection", error));
      }
      state = { _tag: "Closed" };
      summarize("ok");
      try {
        release();
      } catch (error) {
        throw closedUnreleased(error);
      }
    } finally {
      // Preparation or inspection threw (an interrupted export among them): the session stays open
      // for its caller, as before, without holding the file.
      if (state._tag === "Open") letGo();
    }
  };
  return { directory, capture, ingest, close, certifyAll };
};

export type JournalRead =
  | {
      readonly _tag: "Read";
      readonly lines: ReadonlyArray<JournalLine>;
      readonly frames: ReadonlyArray<CredentialJson>;
      readonly compacted: ReadonlyArray<{ line: JournalLine; size: number }>;
      readonly objects: ReadonlyMap<string, JournalObject>;
      /** Lines cut short by a crash mid-append: the last line now, or ones a reopen moved aside. */
      readonly tornLines: number;
      /** The file's exact bytes, the ones parsed; null when the run kept no journal file. */
      readonly bytes: Uint8Array | null;
    }
  | {
      readonly _tag: "Corrupt";
      readonly line: number;
      readonly reason: string;
    }
  /** Larger than a whole dump may be: refused from its size, never read. */
  | {
      readonly _tag: "TooLarge";
      readonly size: number;
      readonly limit: number;
    };

/**
 * Reads a journal strictly. Only the last line may be incomplete, and is then counted as torn; any
 * other line that fails to parse, or a journal file that is not a regular file, makes the journal
 * corrupt, and nothing is repaired.
 */
export const readCaptureJournal = (
  directory: string,
  limits: DumpLimits = DEFAULT_LIMITS,
): JournalRead => {
  const path = join(directory, JOURNAL_FILE);
  const moved = existsSync(directory)
    ? readdirSync(directory).filter((name) => TORN.test(name)).length
    : 0;
  const limit = journalLimit(limits);
  let bytes: Uint8Array | null = null;
  try {
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = fstatSync(fd);
      if (!info.isFile())
        throw new Error(`${JOURNAL_FILE} is not a regular file`);
      if (info.size > limit)
        return { _tag: "TooLarge", size: info.size, limit };
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      return { _tag: "Corrupt", line: 0, reason: message(error) };
  }
  const objects = join(directory, OBJECTS_DIRECTORY);
  return decodeCaptureJournal(
    bytes,
    (sha256, limit) => {
      if (!lstatSync(objects).isDirectory())
        throw new Error("capture objects is not a directory");
      const fd = openSync(
        join(objects, sha256),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > limit)
          throw new Error(
            "capture object is not a regular file within the byte limit",
          );
        return readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    limits,
    moved,
  );
};

interface JournalObject {
  readonly bytes: Uint8Array;
  readonly frame: CredentialJson;
}

export const decodeCaptureJournal = (
  bytes: Uint8Array | null,
  load: (sha256: string, limit: number) => Uint8Array | undefined,
  limits: DumpLimits,
  moved = 0,
): JournalRead => {
  const limit = journalLimit(limits);
  if (bytes !== null && bytes.byteLength > limit)
    return { _tag: "TooLarge", size: bytes.byteLength, limit };
  const lines: JournalLine[] = [];
  const frames: CredentialJson[] = [];
  const compacted: Array<{ line: JournalLine; size: number }> = [];
  const objects = new Map<string, JournalObject>();
  const values = new Map<string, Json>();
  let total = bytes?.byteLength ?? 0;
  let listItems = Math.floor(
    Math.min(limits.totalBytes, 128 * 1024 * 1024) / 8,
  );
  const resolveObject = (reference: Json): Json => {
    const digest = Digest.safeParse(reference);
    if (!digest.success) throw new Error("invalid capture object reference");
    const sha256 = digest.data;
    const found = values.get(sha256);
    if (found !== undefined) return found;
    const remaining = Math.min(limits.objectBytes, limits.totalBytes - total);
    const object = load(sha256, remaining);
    if (
      object === undefined ||
      object.byteLength > remaining ||
      sha256Of(object) !== sha256
    )
      throw new Error(
        "capture object missing, changed, or over the byte limit",
      );
    const parsed = CredentialJson.parse(object);
    const value = Json.safeParse(parsed.value);
    if (!value.success) throw new Error("invalid capture object JSON");
    total += object.byteLength;
    objects.set(sha256, { bytes: object, frame: parsed.source });
    values.set(sha256, value.data);
    return value.data;
  };
  let offset = 0;
  const buffer =
    bytes === null
      ? Buffer.alloc(0)
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (
    let end = buffer.indexOf(10);
    end !== -1;
    end = buffer.indexOf(10, offset)
  ) {
    try {
      const parsed = CredentialJson.parse(buffer.subarray(offset, end));
      const { refs, ...line } = DiskLine.parse(parsed.value);
      if (line.seq !== lines.length + 1)
        throw new Error(
          `sequence ${line.seq} where ${lines.length + 1} was expected`,
        );
      if (refs)
        line.event = mapContent(line.event, resolveObject, (field, items) => {
          const from = items[0];
          if (typeof from !== "number") return items.map(resolveObject);
          const [, count, ...suffix] = items;
          const prior = requestList(lines[from - 1]?.event, field);
          if (
            !Number.isSafeInteger(from) ||
            typeof count !== "number" ||
            !Number.isSafeInteger(count) ||
            count < 1 ||
            prior === undefined ||
            count > prior.length
          )
            throw new Error("invalid capture list prefix");
          if (count === prior.length && suffix.length === 0) return prior;
          listItems -= count;
          if (listItems < 0)
            throw new Error(
              "capture list prefixes exceed the reader byte limit",
            );
          return prior.slice(0, count).concat(suffix.map(resolveObject));
        });
      lines.push(line);
      frames.push(parsed.source);
      if (refs) compacted.push({ line, size: end - offset });
    } catch (error) {
      return {
        _tag: "Corrupt",
        line: lines.length + 1,
        reason:
          error instanceof z.ZodError
            ? "journal frame schema is invalid"
            : message(error),
      };
    }
    offset = end + 1;
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (let start = offset; start < buffer.length; start += 65536)
      decoder.decode(buffer.subarray(start, start + 65536), { stream: true });
    decoder.decode();
  } catch {
    return {
      _tag: "Corrupt",
      line: lines.length + 1,
      reason: "journal is not exact valid UTF-8",
    };
  }
  return {
    _tag: "Read",
    lines,
    frames,
    compacted,
    objects,
    tornLines: moved + (offset < buffer.length ? 1 : 0),
    bytes,
  };
};

export const journalObjectFrames = (
  objects: ReadonlyMap<string, JournalObject>,
) => Array.from(objects.values(), ({ frame }) => frame);

export const decodeDumpJournal = (
  files: ReadonlyMap<string, Uint8Array>,
  limits = DEFAULT_LIMITS,
) =>
  decodeCaptureJournal(
    files.get(RAW_JOURNAL_FILE) ?? null,
    (hash) => files.get(journalObjectFile(hash)),
    limits,
  );

export const retainedPrefixProof = (
  lines: readonly JournalLine[],
  certificates: readonly CredentialCertificate[] = [],
) => {
  const calls = new Set<string>();
  for (const event of [...lines.map(({ event }) => event), ...certificates])
    if (event.type === "credential.inspection" && event.version === 3)
      for (const call of event.retainedPrefixCalls) calls.add(call);
  return [...calls].toSorted();
};

/**
 * The journal file's hash and size as it is now, streamed, or undefined when there is none: what a
 * close receipt's snapshot must have been built from for the run folder to go without loss.
 */
export const journalIdentity = (directory: string) =>
  captureFileIdentity(join(directory, JOURNAL_FILE));

export const captureFileIdentity = async (path: string) => {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("capture file is not an unaliased regular file");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream("", {
      fd: handle,
      autoClose: false,
    }) as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      hash.update(chunk);
    }
    return { sha256: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
};
