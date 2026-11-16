import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setPriority } from "node:os";
import { isolatedGitReadEnvironment } from "./git-read-qualification.ts";

// The 512 MiB covers 448 MiB retained plus 64 MiB for one object in flight.
// Each call also caps its unretained object bodies at the same 64 MiB allowance.
// This allowance is per call, so concurrent calls can together hold more than 512 MiB.
// Native command stdout in flight is outside it, as on main; its size is unknown
// until completion. A command result counts only once retained.
export const GIT_READ_TOTAL_BYTES = 512 * 1024 * 1024;
export const GIT_READ_RETAINED_BYTES = 448 * 1024 * 1024;
export const GIT_READ_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
const PIPELINE_BYTES = 16 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export type GitReadCounter =
  | "requests"
  | "hits"
  | "uniqueObjectsRead"
  | "repeatReads"
  | "unretained"
  | "oversized"
  | "nativeFallback"
  | "foreignRepository"
  | "sourceRestarts"
  | "peakRetainedBytes";
export type GitReadCount = (kind: GitReadCounter, value: number) => void;

/** A source returns only bodies verified against their requested object ids. */
export interface GitObjectSource {
  read(
    oids: readonly string[],
    headBytes: number | undefined,
    receive: (oid: string, bytes: Uint8Array, full: boolean) => void,
    count: GitReadCount,
    onRead: (oid: string) => void,
    accept?: (oid: string, keptBytes: number) => number | undefined,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Strict framing shared by metadata and body reads. Headers never grow past 160 bytes. */
export class GitObjectProtocol {
  private bytes: Uint8Array = new Uint8Array(0);
  private at = 0;
  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}
  private async fill() {
    while (this.at >= this.bytes.length) {
      const next = await this.reader.read();
      if (next.done) throw new Error("Truncated Git object response");
      this.bytes = next.value;
      this.at = 0;
    }
  }
  async body(
    size: number,
    retained = size,
    consume?: (bytes: Uint8Array) => void,
  ) {
    const bytes = new Uint8Array(retained);
    let consumed = 0;
    while (consumed < size) {
      await this.fill();
      const take = Math.min(size - consumed, this.bytes.length - this.at);
      consume?.(this.bytes.subarray(this.at, this.at + take));
      const keep = Math.min(take, Math.max(0, retained - consumed));
      if (keep > 0)
        bytes.set(this.bytes.subarray(this.at, this.at + keep), consumed);
      consumed += take;
      this.at += take;
    }
    return bytes;
  }
  async header(oid: string) {
    const bytes: number[] = [];
    while (true) {
      await this.fill();
      const byte = this.bytes[this.at++];
      if (byte === 10) break;
      if (byte === undefined || bytes.length >= 160)
        throw new Error("Invalid Git object header");
      bytes.push(byte);
    }
    const text = new TextDecoder().decode(Uint8Array.from(bytes));
    if (text === `${oid} missing`) return undefined;
    const match = /^(\w+) (blob|tree|commit|tag) (0|[1-9][0-9]*)$/.exec(text);
    const size = Number(match?.[3]);
    if (!match || match[1] !== oid || !Number.isSafeInteger(size) || size < 0)
      throw new Error("Invalid Git object metadata");
    return { type: match[2], size };
  }
  async separator() {
    if ((await this.body(1))[0] !== 10)
      throw new Error("Invalid Git object separator");
  }
  async close() {
    await this.reader.cancel();
  }
}

/** The protocol source owns its child; the snapshot owns verified objects independently. */
export class GitBatchObjectSource implements GitObjectSource {
  private child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  private wire: GitObjectProtocol | undefined;
  private drain: Promise<void> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly repository: string,
    private readonly trusted: Promise<void>,
    private readonly prefixFullBytes: number,
  ) {}
  private async start() {
    if (this.closed) throw new Error("Closed Git object source");
    await this.trusted;
    if (this.closed) throw new Error("Closed Git object source");
    if (this.child !== undefined) return;
    const executable = Bun.which("git");
    if (executable === null) throw new Error("Git executable unavailable");
    const child = Bun.spawn(
      [
        executable,
        "--no-lazy-fetch",
        "--no-replace-objects",
        "--no-optional-locks",
        "--no-pager",
        "-C",
        this.repository,
        "-c",
        `safe.directory=${this.repository}`,
        "-c",
        "grep.threads=2",
        "cat-file",
        "--batch-command",
      ],
      {
        env: isolatedGitReadEnvironment(executable, this.repository),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    this.child = child;
    try {
      setPriority(child.pid, 10);
    } catch {
      /* A sandbox may deny priority changes. */
    }
    this.wire = new GitObjectProtocol(child.stdout.getReader());
    this.drain = (async () => {
      for await (const _chunk of child.stderr) {
        /* drain without retention */
      }
    })();
    void this.drain.catch(() => this.close());
  }
  async read(
    oids: readonly string[],
    headBytes: number | undefined,
    receive: (oid: string, bytes: Uint8Array, full: boolean) => void,
    count: GitReadCount,
    onRead: (oid: string) => void,
    accept?: (oid: string, keptBytes: number) => number | undefined,
  ) {
    await this.start();
    const child = this.child,
      wire = this.wire;
    if (this.closed || child === undefined || wire === undefined)
      throw new Error("Git object source unavailable");
    for (let at = 0; at < oids.length; at += 256) {
      const group = oids.slice(at, at + 256);
      child.stdin.write(group.map((oid) => `info ${oid}\n`).join(""));
      const written = Promise.resolve(child.stdin.flush());
      void written.catch(() => this.close());
      const entries: { oid: string; size: number }[] = [];
      for (const oid of group) {
        const info = await wire.header(oid);
        if (info?.type !== "blob") continue;
        if (headBytes === undefined && info.size > GIT_READ_IN_FLIGHT_BYTES) {
          count("oversized", 1);
          continue;
        }
        entries.push({ oid, size: info.size });
      }
      await written;
      for (let index = 0; index < entries.length;) {
        const batch: { oid: string; size: number; kept: number }[] = [];
        let bytes = 0;
        while (index < entries.length) {
          const entry = entries[index];
          if (
            entry === undefined ||
            (batch.length > 0 && bytes + entry.size > PIPELINE_BYTES)
          )
            break;
          index++;
          const preferred =
            headBytes === undefined || entry.size <= this.prefixFullBytes
              ? entry.size
              : Math.min(entry.size, headBytes);
          const kept =
            accept === undefined ? preferred : accept(entry.oid, preferred);
          if (kept === undefined) {
            count("oversized", 1);
            continue;
          }
          batch.push({ ...entry, kept });
          bytes += entry.size;
        }
        if (batch.length === 0) continue;
        child.stdin.write(
          batch.map((entry) => `contents ${entry.oid}\n`).join(""),
        );
        const flushed = Promise.resolve(child.stdin.flush());
        void flushed.catch(() => this.close());
        for (const entry of batch) {
          const info = await wire.header(entry.oid);
          if (info?.type !== "blob" || info.size !== entry.size)
            throw new Error("Git object changed during read");
          onRead(entry.oid);
          const hash = createHash(
            entry.oid.length === 40 ? "sha1" : "sha256",
          ).update(`blob ${info.size}\0`);
          const body = await wire.body(info.size, entry.kept, (bytes) => {
            hash.update(bytes);
          });
          await wire.separator();
          if (hash.digest("hex") !== entry.oid)
            throw new Error("Git blob identity mismatch");
          receive(entry.oid, body, entry.kept === info.size);
        }
        await flushed;
      }
    }
  }
  close() {
    this.closed = true;
    return (this.closing ??= (async () => {
      const child = this.child;
      if (child === undefined) return;
      child.kill("SIGKILL");
      await Promise.allSettled([child.exited, this.wire?.close(), this.drain]);
    })());
  }
}

type BlobEntry = { readonly bytes: Uint8Array; readonly full: boolean };
type CommandLoad = {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
};

/** One review's map. Source failures replace the source and preserve verified entries. */
export class GitReadSession {
  private readonly objects = new Map<string, BlobEntry>();
  private readonly commands = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, CommandLoad>();
  private readonly loads = new Set<CommandLoad>();
  private readonly seen = new Set<string>();
  private retained = 0;
  private reserved = 0;
  private peak = 0;
  private source: GitObjectSource | undefined;
  private restartPending = false;
  private tail = Promise.resolve();
  private readonly queued = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | undefined;
  private trust: Promise<void> | undefined;
  private capability: Promise<boolean> | undefined;
  private trustChild: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  readonly counters: Record<GitReadCounter, number> = {
    requests: 0,
    hits: 0,
    uniqueObjectsRead: 0,
    repeatReads: 0,
    unretained: 0,
    oversized: 0,
    nativeFallback: 0,
    foreignRepository: 0,
    sourceRestarts: 0,
    peakRetainedBytes: 0,
  };
  private constructor(
    readonly repository: string,
    private readonly options: {
      retainedBytes?: number;
      prefixFullBytes?: number;
      count?: GitReadCount;
      source?: () => GitObjectSource;
    },
  ) {}
  static async open(
    repository: string,
    options: {
      retainedBytes?: number;
      prefixFullBytes?: number;
      count?: GitReadCount;
      source?: () => GitObjectSource;
    } = {},
  ) {
    return new GitReadSession(await realpath(repository), options);
  }
  get isClosed() {
    return this.closed;
  }
  get retainedBytes() {
    return this.retained;
  }
  count: GitReadCount = (kind, value) => {
    this.counters[kind] += value;
    this.options.count?.(kind, value);
  };
  private assertLive() {
    if (this.closed) throw new Error("Closed Git read snapshot");
  }
  private trusted() {
    if (this.trust !== undefined) return this.trust;
    const checking = (async () => {
      this.assertLive();
      const env = { ...process.env };
      // Hooks can supply a different repository. Judge the path the isolated reader opens.
      delete env.GIT_DIR;
      delete env.GIT_WORK_TREE;
      delete env.GIT_COMMON_DIR;
      const child = Bun.spawn(
        ["git", "-C", this.repository, "rev-parse", "--git-dir"],
        { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      this.trustChild = child;
      const [, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) throw new Error(stderr.trim());
      this.assertLive();
    })();
    this.trust = checking;
    void checking.catch(() => {
      if (this.trust === checking) this.trust = undefined;
    });
    return checking;
  }
  async prepare() {
    await this.trusted();
    return (this.capability ??= (async () => {
      this.assertLive();
      try {
        const executable = Bun.which("git");
        if (executable === null) return false;
        const child = Bun.spawn([executable, "--no-lazy-fetch", "version"], {
          env: isolatedGitReadEnvironment(executable, this.repository),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        this.trustChild = child;
        const [, , exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        // Old Git and wrappers unable to run in isolation keep main's lazy fetching.
        return exit === 0;
      } catch {
        return false;
      }
    })());
  }
  private fits(key: string, size: number, previous = 0) {
    return (
      this.retained +
        this.reserved -
        previous +
        size +
        Buffer.byteLength(key) <=
      (this.options.retainedBytes ?? GIT_READ_RETAINED_BYTES)
    );
  }
  private retain(key: string, bytes: Uint8Array, previous = 0) {
    if (this.closed) return false;
    const weight = bytes.byteLength + Buffer.byteLength(key);
    const next = this.retained - previous + weight;
    if (!this.fits(key, bytes.byteLength, previous)) {
      this.count("unretained", 1);
      return false;
    }
    this.retained = next;
    if (next > this.peak) {
      this.count("peakRetainedBytes", next - this.peak);
      this.peak = next;
    }
    return true;
  }
  async blobs(
    oids: readonly string[],
    headBytes: number | undefined,
    signal: AbortSignal,
  ) {
    if (
      oids.some((oid) => !OID.test(oid)) ||
      (headBytes !== undefined &&
        (!Number.isSafeInteger(headBytes) ||
          headBytes < 0 ||
          headBytes > GIT_READ_IN_FLIGHT_BYTES))
    )
      throw new Error("Invalid Git object request");
    while (this.queued.size >= 64)
      await waitForGitRead(Promise.race(this.queued), signal);
    signal.throwIfAborted();
    const operation = this.tail.then(async () => {
      signal.throwIfAborted();
      this.assertLive();
      if (!(await this.prepare())) throw new Error("Native Git reads required");
      const unique = [...new Set(oids)];
      this.count("requests", oids.length);
      const out = new Map<string, Uint8Array>();
      const missing: string[] = [];
      for (const oid of unique) {
        const entry = this.objects.get(oid);
        if (
          entry !== undefined &&
          (entry.full ||
            (headBytes !== undefined && entry.bytes.length >= headBytes))
        ) {
          this.count("hits", 1);
          out.set(oid, entry.bytes.subarray(0, headBytes));
        } else missing.push(oid);
      }
      let unretainedBytes = 0;
      let receivedUnretainedBytes = 0;
      const reservations = new Map<string, number>();
      for (let attempt = 0; missing.length > 0; attempt++) {
        this.assertLive();
        const wanted = missing.filter((oid) => !out.has(oid));
        if (wanted.length === 0) break;
        if (this.source === undefined && this.restartPending) {
          this.count("sourceRestarts", 1);
          this.restartPending = false;
        }
        this.source ??=
          this.options.source?.() ??
          new GitBatchObjectSource(
            this.repository,
            this.trusted(),
            this.options.prefixFullBytes ?? 1024 * 1024,
          );
        try {
          await this.source.read(
            wanted,
            headBytes,
            (oid, bytes, full) => {
              this.assertLive();
              const reserved = reservations.get(oid) ?? 0;
              this.reserved -= reserved;
              reservations.delete(oid);
              const old = this.objects.get(oid);
              if (
                this.retain(
                  oid,
                  bytes,
                  old === undefined
                    ? 0
                    : old.bytes.byteLength + Buffer.byteLength(oid),
                )
              )
                this.objects.set(oid, { bytes, full });
              else receivedUnretainedBytes += bytes.byteLength;
              out.set(oid, bytes.subarray(0, headBytes));
            },
            this.count,
            (oid) => {
              if (this.seen.has(oid)) this.count("repeatReads", 1);
              else {
                this.seen.add(oid);
                this.count("uniqueObjectsRead", 1);
              }
            },
            (oid, preferred) => {
              // A prefix probe keeps a small full body only if it can be retained.
              const size = this.fits(oid, preferred)
                ? preferred
                : Math.min(preferred, headBytes ?? preferred);
              // An upgraded prefix stays live until its replacement is verified.
              // Reserve the whole incoming allocation while that old entry still exists.
              if (this.fits(oid, size)) {
                const weight = size + Buffer.byteLength(oid);
                reservations.set(oid, weight);
                this.reserved += weight;
                return size;
              }
              if (unretainedBytes + size > GIT_READ_IN_FLIGHT_BYTES)
                return undefined;
              unretainedBytes += size;
              return size;
            },
          );
          break;
        } catch (error) {
          await this.source.close();
          this.source = undefined;
          this.restartPending = true;
          unretainedBytes = receivedUnretainedBytes;
          if (this.closed || signal.aborted || attempt >= 1) throw error;
        } finally {
          for (const weight of reservations.values()) this.reserved -= weight;
          reservations.clear();
        }
      }
      return new Map(
        unique.flatMap((oid) => {
          const bytes = out.get(oid);
          return bytes === undefined ? [] : [[oid, bytes] as const];
        }),
      );
    });
    this.tail = operation.then(
      () => {},
      () => {},
    );
    const settled = this.tail;
    this.queued.add(settled);
    void settled.then(() => this.queued.delete(settled));
    return waitForGitRead(operation, signal);
  }
  async command(
    key: string,
    load: (signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ) {
    this.assertLive();
    const hit = this.commands.get(key);
    if (hit !== undefined) return new TextDecoder().decode(hit);
    while (
      (!this.pending.has(key) ||
        this.pending.get(key)?.controller.signal.aborted) &&
      this.loads.size >= 64
    )
      await waitForGitRead(
        Promise.race(
          [...this.loads].map((item) => item.promise.catch(() => {})),
        ),
        signal,
      );
    signal.throwIfAborted();
    this.assertLive();
    let held = this.pending.get(key);
    if (held === undefined || held.controller.signal.aborted) {
      const controller = new AbortController();
      const item: CommandLoad = {
        controller,
        waiters: 0,
        promise: Promise.resolve(""),
      };
      item.promise = load(controller.signal)
        .then((stdout) => {
          if (!this.closed) {
            if (this.fits(key, Buffer.byteLength(stdout))) {
              const bytes = new TextEncoder().encode(stdout);
              if (this.retain(key, bytes)) this.commands.set(key, bytes);
            } else this.count("unretained", 1);
          }
          return stdout;
        })
        .finally(() => {
          if (this.pending.get(key) === item) this.pending.delete(key);
          this.loads.delete(item);
        });
      this.loads.add(item);
      this.pending.set(key, item);
      held = item;
    }
    held.waiters++;
    try {
      return await waitForGitRead(held.promise, signal);
    } finally {
      held.waiters--;
      if (held.waiters === 0) held.controller.abort();
    }
  }
  close() {
    this.closed = true;
    return (this.closing ??= (async () => {
      const loads = [...this.loads];
      for (const load of loads) load.controller.abort();
      this.trustChild?.kill("SIGKILL");
      await Promise.allSettled([
        this.source?.close(),
        this.trust,
        this.capability,
        ...loads.map((load) => load.promise),
      ]);
      this.objects.clear();
      this.commands.clear();
      this.retained = 0;
    })());
  }
}

/** Abandon this caller while the shared operation keeps its own lifetime. */
export const waitForGitRead = <A>(
  operation: Promise<A>,
  signal: AbortSignal,
): Promise<A> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Git request cancelled"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
