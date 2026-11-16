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
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open, realpath, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { STORE_DIRECTORY_MODE, STORE_FILE_MODE } from "@neuve/records-core";
import { maskArtifact } from "./mask.ts";
import {
  CAPTURE_VERSION,
  CaptureFailed,
  DEFAULT_LIMITS,
  type DumpLimits,
  CapturedEvent,
  JournalLine,
  type Capture,
  type CaptureEvent,
  type CaptureScope,
  type JournalMark,
} from "./types.ts";

/**
 * A run's capture journal: `events.jsonl`, one validated event per line in the order captured, and
 * `objects/<sha256>`, the bytes of each artifact under its hash. It lives in the run folder beside
 * pi's database, unmasked like pi's own records, and is read by the capture before the run folder
 * is removed. Each line is one synchronous append, so a process crash keeps every line before it.
 *
 * Completeness is proved, never assumed: each process's session opens with `journal.open` and ends
 * with `journal.close` only while every capture in it succeeded. A failed capture writes nothing
 * further that its disclosure would depend on, so a full disk still leaves an unclosed session.
 */

export const JOURNAL_FILE = "events.jsonl";
export const OBJECTS_DIRECTORY = "objects";

export const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The journal file is carried whole in the restricted dump, so it is one object within both budgets. */
const journalLimit = (limits: DumpLimits) =>
  Math.min(limits.objectBytes, limits.totalBytes);

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
  /** The byte budgets: an artifact over `objectBytes` is refused, and the journal file may not outgrow `totalBytes`. */
  readonly limits?: DumpLimits | undefined;
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
   * Ends this process's session with `journal.close`. Throws `CaptureFailed` when a capture failed
   * earlier, which leaves the session unclosed and the run's dump incomplete, and fails the journal
   * when an `ingest` is still in flight: its artifact would land after the close and be missing
   * from a session marked whole. The runtime joins every callback before it closes. Every ending,
   * a failure included, lets go of `events.jsonl`; a descriptor that then fails to close is thrown
   * as `io` while the session stays closed, since its close mark is already written.
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
    throw new Error(
      `${JOURNAL_FILE} is ${size} bytes, over the ${limit}-byte limit`,
    );
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(readFileSync(path));
  const end = text.lastIndexOf("\n") + 1;
  const lines = text.slice(0, end).split("\n").length - 1;
  if (end < text.length) {
    writeFileSync(
      join(directory, `torn-${lines + 1}-${Date.now()}.partial`),
      text.slice(end),
      {
        mode: STORE_FILE_MODE,
        flag: "wx",
      },
    );
    truncateSync(path, Buffer.byteLength(text.slice(0, end)));
  }
  return { lines, bytes: Buffer.byteLength(text.slice(0, end)) };
};

/**
 * Keeps an artifact's bytes under their hash and reads them back: a file already there is trusted
 * only when its bytes hash to its name, and is replaced otherwise.
 */
const keepBytes = (objects: string, bytes: Uint8Array) => {
  const sha256 = sha256Of(bytes);
  const target = join(objects, sha256);
  // A file of another size cannot hold these bytes, so it is replaced without being read.
  const held =
    existsSync(target) &&
    lstatSync(target).isFile() &&
    lstatSync(target).size === bytes.byteLength;
  if (!held || sha256Of(readFileSync(target)) !== sha256) {
    const staging = `${target}.${process.pid}.${Date.now()}.partial`;
    writeFileSync(staging, bytes, { mode: STORE_FILE_MODE, flag: "wx" });
    renameSync(staging, target);
  }
  if (sha256Of(readFileSync(target)) !== sha256)
    throw new Error(`artifact ${sha256} did not read back with its hash`);
  return { sha256, size: bytes.byteLength };
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
    await rename(staging, join(objects, sha256));
    return { sha256, size };
  } finally {
    await handle.close();
    await rm(staging, { force: true });
  }
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
  let seq: number;
  let journalBytes: number;
  try {
    mkdirSync(objects, { recursive: true, mode: STORE_DIRECTORY_MODE });
    ({ lines: seq, bytes: journalBytes } = completeLines(
      path,
      directory,
      limit,
    ));
  } catch (error) {
    throw new CaptureFailed({
      kind: "io",
      event: "journal.open",
      detail: message(error),
    });
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

  const append = (event: JournalLine["event"], at = Date.now()) => {
    const started = options.log === undefined ? 0 : performance.now();
    let succeeded = false;
    try {
      const line: JournalLine = {
        v: CAPTURE_VERSION,
        seq: seq + 1,
        at,
        event,
      };
      const text = `${JSON.stringify(line)}\n`;
      const bytes = Buffer.byteLength(text);
      serializedBytes += bytes;
      if (journalBytes + bytes > limit)
        throw new Error(
          `${JOURNAL_FILE} would grow over the ${limit}-byte limit`,
        );
      appendFileSync(descriptor(), text);
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
        if (!succeeded) {
          appendFailures += 1;
          summarize("error");
        }
      }
    }
  };

  const mark = (type: JournalMark["type"], reason?: string) =>
    append(
      type === "journal.failed"
        ? { type, scope: { runId }, reason: reason ?? "" }
        : { type, scope: { runId } },
    );

  const fail = (failure: CaptureFailed): never => {
    state = { _tag: "Failed", failure };
    // Only an emitter's defect leaves the file as it was; after a failed write nothing else is
    // written, and the unclosed session alone discloses the loss.
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

  const stored = (event: CaptureEvent) => {
    if (event.type !== "artifact") return event;
    if (event.bytes.byteLength > limits.objectBytes)
      return invalid(
        "artifact",
        `${event.name}: ${event.bytes.byteLength} bytes, over the ${limits.objectBytes}-byte object limit`,
      );
    const readable = maskArtifact(event.mediaType, event.bytes);
    try {
      const kept = keepBytes(objects, event.bytes);
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
        ...kept,
      };
    } catch (error) {
      if (error instanceof CaptureFailed) throw error;
      return fail(
        new CaptureFailed({
          kind: "io",
          event: "artifact",
          detail: message(error),
        }),
      );
    }
  };

  const admit = (type: string) => {
    if (state._tag !== "Open")
      throw new CaptureFailed({
        kind: "failed",
        event: type,
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
      append(kept);
      if (kept.type === "model.request") requested.add(kept.callId);
    } catch (error) {
      fail(
        new CaptureFailed({ kind: "io", event: type, detail: message(error) }),
      );
    }
  };

  const capture: Capture = (event) => {
    admit(event.type);
    accept(event.type, stored(event));
  };

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
      return fail(
        new CaptureFailed({
          kind: error instanceof SpillRefused ? "invalid" : "io",
          event: "artifact",
          detail: `${file.name}: ${message(error)}`,
        }),
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
    if (ingesting > 0)
      invalid(
        "journal.close",
        `${ingesting} artifact ingest(s) still in flight; the session is not whole`,
      );
    try {
      stillAtPath();
      mark("journal.close");
    } catch (error) {
      fail(
        new CaptureFailed({
          kind: "io",
          event: "journal.close",
          detail: message(error),
        }),
      );
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
  } catch (error) {
    try {
      release();
    } catch {}
    throw new CaptureFailed({
      kind: "io",
      event: "journal.open",
      detail: message(error),
    });
  }
  const certifyAll: CaptureJournal["certifyAll"] = async (
    count,
    prepare,
    inspect,
  ) => {
    admit("credential.inspection");
    try {
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
      if (seq !== expected)
        return invalid(
          "credential.inspection",
          "journal changed while preparing certificate administration",
        );
      try {
        stillAtPath();
        for (const row of rows) append(row.event, row.at);
      } catch (error) {
        return fail(
          new CaptureFailed({
            kind: "io",
            event: "credential.inspection",
            detail: message(error),
          }),
        );
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
  if (!existsSync(path))
    return {
      _tag: "Read",
      lines: [],
      frames: [],
      tornLines: moved,
      bytes: null,
    };
  if (!lstatSync(path).isFile())
    return {
      _tag: "Corrupt",
      line: 0,
      reason: `${JOURNAL_FILE} is not a regular file`,
    };
  const size = lstatSync(path).size;
  const limit = journalLimit(limits);
  if (size > limit) return { _tag: "TooLarge", size, limit };
  const bytes = new Uint8Array(readFileSync(path));
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return {
      _tag: "Corrupt",
      line: 0,
      reason: "journal is not exact valid UTF-8",
    };
  }
  const complete = text === "" || text.endsWith("\n");
  const lines: Array<JournalLine> = [];
  const frames: CredentialJson[] = [];
  for (const [index, line] of text.split("\n").slice(0, -1).entries()) {
    let json: unknown;
    let frame: CredentialJson;
    try {
      const parsed = CredentialJson.parse(line);
      json = parsed.value;
      frame = parsed.source;
    } catch (error) {
      return { _tag: "Corrupt", line: index + 1, reason: message(error) };
    }
    const parsed = JournalLine.safeParse(json);
    if (!parsed.success)
      return {
        _tag: "Corrupt",
        line: index + 1,
        reason: "journal frame schema is invalid",
      };
    if (parsed.data.seq !== lines.length + 1)
      return {
        _tag: "Corrupt",
        line: index + 1,
        reason: `sequence ${parsed.data.seq} where ${lines.length + 1} was expected`,
      };
    lines.push(parsed.data);
    frames.push(frame);
  }
  return {
    _tag: "Read",
    lines,
    frames,
    tornLines: moved + (complete ? 0 : 1),
    bytes,
  };
};

/**
 * The journal file's hash and size as it is now, streamed, or undefined when there is none: what a
 * close receipt's snapshot must have been built from for the run folder to go without loss.
 */
export const journalIdentity = async (directory: string) => {
  const path = join(directory, JOURNAL_FILE);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`${JOURNAL_FILE} is not a regular file`);
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
