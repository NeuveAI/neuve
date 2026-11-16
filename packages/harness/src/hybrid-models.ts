import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setPriority } from "node:os";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { Worker } from "@neuve/records-core";
import {
  SemanticClient,
  type SemanticSpawn,
  WORKER_SHA256,
} from "@neuve/semantic-client";
import { HybridUnavailable, type HybridWorkers } from "./commit-hybrid.ts";
import type { E0Runtime } from "./e0.ts";
import {
  EncoderUnavailable,
  type ChunkEncoder,
  type EncodedChunk,
  type LocalDevice,
} from "./hybrid-vectors.ts";
import {
  BENCH_R_IDENTITY,
  RerankerUnavailable,
  type PairReranker,
} from "./hybrid.ts";
import type { HybridRuntime } from "./search-config.ts";

/**
 * The worker's model processes for hybrid leads (10.117, the overseer's call of 24 October 2026):
 * one chunk encoder (EmbeddingGemma 2 through the semantic client) and one reranker
 * (Qwen3-Reranker-0.6B, `reranker_worker.py`), each a long-lived Python process at nice 10 on this
 * machine's device, started on first need and closed after `MODEL_IDLE_MS` without a call. Calls
 * to one process queue behind each other. Each call's span carries its wait in that queue, the
 * model's own time, the process's memory, and its start and load when the call started it; a
 * process that exited idle is reported on the next job's span (`harness.hybrid.model.exited`).
 */

export const MODEL_IDLE_MS = 5 * 60_000;
/** The first call loads the model (about 10 s); a slow machine may take longer. */
const STARTUP_TIMEOUT_MS = 300_000;
/** One request: a batch of 16 chunks, or one hunk's 50 pairs on the CPU. */
const REQUEST_TIMEOUT_MS = 600_000;
const NICENESS = 10;
/** How long a closed reranker gets to exit on SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 2_000;
/**
 * Chunks per request on Apple's GPU: 16 long chunks took the driver to 14 GB of this Mac's 24,
 * and failed under memory pressure; 4 encode as many tokens a second in about 4.5 GB (measured
 * 24 October 2026).
 */
export const MPS_BATCH_ITEMS = 4;

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** A process's resident memory, in bytes, or undefined once it is gone. */
export const residentBytes = (pid: number | null | undefined) => {
  if (pid === null || pid === undefined) return undefined;
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  });
  // `ps` may be unavailable (a sandbox): the memory is then not known, never a failure.
  const kilobytes = Number((result.stdout ?? "").trim());
  return Number.isFinite(kilobytes) && kilobytes > 0
    ? kilobytes * 1024
    : undefined;
};

/** A process's CPU so far (user and system), in seconds, or 0 once it is gone. */
export const cpuSeconds = (pid: number | null | undefined) => {
  if (pid === null || pid === undefined) return 0;
  const text = (
    spawnSync("ps", ["-o", "cputime=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout ?? ""
  ).trim();
  if (text === "") return 0;
  // [[dd-]hh:]mm:ss.cc
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = (clock ?? "").split(":").map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part)))
    return 0;
  return (
    Number(days) * 86_400 + parts.reduce((total, part) => total * 60 + part, 0)
  );
};

/** What a process did before it exited: reported on the next job's span. */
interface Exited {
  readonly model: string;
  readonly device: LocalDevice;
  /** `room`: closed so the other model could start within the resident limit. */
  readonly reason: "idle" | "failed" | "room";
  readonly uptimeMs: number;
  readonly calls: number;
  readonly residentBytes: number | undefined;
}
const exits: Array<Exited> = [];

/**
 * The processes one setup holds. Each starts on its first call and restarts on the next call after
 * it was closed, so a job never holds a closed process. Calls in flight are counted: the idle timer
 * runs only while none is, and closes both processes `MODEL_IDLE_MS` after the last call ends. A
 * process that fails is closed alone; its next call starts a fresh one.
 */
export class Holder {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight = 0;
  #client:
    { value: SemanticClient; startedAt: number; calls: number } | undefined;
  #reranker:
    { value: RerankerProcess; startedAt: number; calls: number } | undefined;
  constructor(
    readonly device: LocalDevice,
    private readonly makeClient: () => SemanticClient,
    private readonly makeReranker: () => RerankerProcess,
    private readonly idleMs = MODEL_IDLE_MS,
    /** Model processes resident at once (settings `search.hybrid.models`). */
    private readonly maxResident = 2,
  ) {}
  #busy = { client: 0, reranker: 0 };
  client() {
    // Within the limit: the reranker makes room unless a call is using it.
    if (
      this.maxResident < 2 &&
      this.#client === undefined &&
      this.#reranker !== undefined &&
      this.#busy.reranker === 0
    )
      void this.closeReranker("room");
    this.#client ??= {
      value: this.makeClient(),
      startedAt: Date.now(),
      calls: 0,
    };
    this.#client.calls++;
    return this.#client.value;
  }
  reranker() {
    if (this.#reranker?.value.failed === true)
      void this.closeReranker("failed");
    if (
      this.maxResident < 2 &&
      this.#reranker === undefined &&
      this.#client !== undefined &&
      this.#busy.client === 0
    )
      void this.closeClient("room");
    this.#reranker ??= {
      value: this.makeReranker(),
      startedAt: Date.now(),
      calls: 0,
    };
    this.#reranker.calls++;
    return this.#reranker.value;
  }
  get pids() {
    return {
      client: this.#client?.value.stats().pid ?? null,
      reranker: this.#reranker?.value.pid ?? null,
    };
  }
  /** Around every call: no idle exit while one runs. */
  begin(kind: "client" | "reranker") {
    this.#busy[kind]++;
    this.#inFlight++;
    clearTimeout(this.#timer);
  }
  end(kind: "client" | "reranker") {
    this.#busy[kind] = Math.max(0, this.#busy[kind] - 1);
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    if (this.#inFlight > 0) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#inFlight === 0) void this.close("idle");
    }, this.idleMs);
    // An idle model never keeps the worker alive.
    this.#timer.unref?.();
  }
  /** Closes the encoder; with `only`, only if it is still that one (a later call may have replaced it). */
  async closeClient(reason: Exited["reason"], only?: SemanticClient) {
    const held = this.#client;
    if (held === undefined || (only !== undefined && held.value !== only))
      return;
    this.#client = undefined;
    exits.push({
      model: "embeddinggemma-2",
      device: this.device,
      reason,
      uptimeMs: Date.now() - held.startedAt,
      calls: held.calls,
      residentBytes: residentBytes(held.value.stats().pid),
    });
    await held.value.close();
  }
  /** Closes the reranker; with `only`, only if it is still that one (a later call may have replaced it). */
  async closeReranker(reason: Exited["reason"], only?: RerankerProcess) {
    const held = this.#reranker;
    if (held === undefined || (only !== undefined && held.value !== only))
      return;
    this.#reranker = undefined;
    exits.push({
      model: "qwen3-reranker-0.6b",
      device: this.device,
      reason,
      uptimeMs: Date.now() - held.startedAt,
      calls: held.calls,
      residentBytes: residentBytes(held.value.pid),
    });
    await held.value.close();
  }
  async close(reason: Exited["reason"]) {
    clearTimeout(this.#timer);
    await Promise.all([this.closeClient(reason), this.closeReranker(reason)]);
  }
}

interface RerankReady {
  readonly identity: Record<string, unknown>;
  readonly loadMillis: number;
}

interface RerankAnswer {
  readonly scores: ReadonlyArray<number>;
  readonly truncated: ReadonlyArray<boolean>;
  readonly rerankMillis: number;
  readonly waitMs: number;
  readonly loadMillis: number | undefined;
  readonly residentBytes: number | undefined;
}

/**
 * The reranker process: JSON lines over stdin and stdout, one request at a time. Its identity is
 * checked before any score is trusted: the pinned revision and weights, this worker file's hash,
 * the benchmark's instruction and prompt (by hash) and the device asked for.
 */
export class RerankerProcess {
  #child: ChildProcess | undefined;
  #ready: Promise<RerankReady> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #next = 1;
  #pending = new Map<
    number,
    {
      readonly resolve: (value: Record<string, unknown>) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  #failure: Error | undefined;

  constructor(
    private readonly config: {
      readonly python: string;
      readonly worker: string;
      readonly snapshot: string;
      readonly device: LocalDevice;
      readonly workerSha256: string;
      /** `STARTUP_TIMEOUT_MS` unless given (tests). */
      readonly startupTimeoutMs?: number;
    },
  ) {}

  /** Rejects a startup still under way: set while one is, so a close or failure settles it. */
  #abandonStartup: ((error: Error) => void) | undefined;

  get pid() {
    return this.#child?.pid;
  }

  get failed() {
    return this.#failure !== undefined;
  }

  #fail(error: Error) {
    this.#failure ??= error;
    this.#abandonStartup?.(this.#failure);
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    this.#child?.kill("SIGKILL");
  }

  async #start(
    signal?: AbortSignal,
    spawnProcess?: (launch: () => ChildProcess) => Promise<ChildProcess>,
  ): Promise<RerankReady> {
    if (this.#ready !== undefined) return this.#ready;
    const launch = () => {
      if (this.#failure !== undefined || signal?.aborted)
        throw new Error("reranker startup cancelled");
      const child = spawn(
        this.config.python,
        [
          "-u",
          this.config.worker,
          "--snapshot",
          this.config.snapshot,
          "--device",
          this.config.device,
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            TOKENIZERS_PARALLELISM: "false",
          },
        },
      );
      this.#child = child;
      return child;
    };
    const child =
      spawnProcess === undefined ? launch() : await spawnProcess(launch);
    if (child.pid !== undefined)
      try {
        setPriority(child.pid, NICENESS);
      } catch {
        // A process that already exited, or a priority the system refuses: it still runs.
      }
    // A write to a process that is gone fails the process, never the worker (EPIPE, ended input).
    child.stdin?.on("error", (error) => this.#fail(error));
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
    });
    this.#ready = new Promise<RerankReady>((resolve, reject) => {
      this.#abandonStartup = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      // A startup that times out is terminal: the process is failed, so the next call starts a
      // fresh one rather than failing on this rejected startup.
      const timer = setTimeout(
        () => this.#fail(new Error("the reranker did not load in time")),
        this.config.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      );
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return this.#fail(
            new Error("the reranker wrote a line that is not JSON"),
          );
        }
        if (message["kind"] === "ready") {
          clearTimeout(timer);
          const identity = (message["identity"] ?? {}) as Record<
            string,
            unknown
          >;
          const problem = this.#identityProblem(identity);
          if (problem !== undefined) {
            const error = new Error(
              `the reranker's identity does not match: ${problem}`,
            );
            reject(error);
            return this.#fail(error);
          }
          this.#abandonStartup = undefined;
          resolve({ identity, loadMillis: Number(message["loadMillis"]) });
          return;
        }
        if (message["kind"] === "fatal") {
          clearTimeout(timer);
          const error = new Error(
            `the reranker stopped: ${String(message["reason"])}`,
          );
          reject(error);
          return this.#fail(error);
        }
        const id = Number(message["id"]);
        const waiting = this.#pending.get(id);
        if (waiting === undefined) return;
        this.#pending.delete(id);
        if (message["kind"] === "reranked") waiting.resolve(message);
        else
          waiting.reject(
            new Error(`the reranker refused: ${String(message["reason"])}`),
          );
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        const error = new Error(
          `the reranker exited (${String(code)})${stderr === "" ? "" : `: ${stderr.trim().split("\n").at(-1)}`}`,
        );
        reject(error);
        this.#fail(error);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
        this.#fail(error);
      });
    });
    return this.#ready;
  }

  #identityProblem(identity: Record<string, unknown>) {
    const expected: Record<string, unknown> = {
      modelId: BENCH_R_IDENTITY.hfId,
      revision: BENCH_R_IDENTITY.revision,
      weightsSha256: BENCH_R_IDENTITY.weights["model.safetensors"],
      workerSha256: this.config.workerSha256,
      instructionSha256: sha256(BENCH_R_IDENTITY.rerank.instruction),
      prefixSha256: sha256(BENCH_R_IDENTITY.rerank.prefix),
      suffixSha256: sha256(BENCH_R_IDENTITY.rerank.suffix),
      device: this.config.device,
      dtype: "float32",
      maxTokens: BENCH_R_IDENTITY.maxTokens,
    };
    for (const [field, value] of Object.entries(expected))
      if (identity[field] !== value) return field;
    return undefined;
  }

  /** Scores documents against a query; calls queue behind each other. */
  score(
    query: string,
    documents: ReadonlyArray<string>,
    signal?: AbortSignal,
    spawnProcess?: (launch: () => ChildProcess) => Promise<ChildProcess>,
  ): Promise<RerankAnswer> {
    const asked = performance.now();
    const work = this.#tail.then(async () => {
      if (this.#failure !== undefined) throw this.#failure;
      const started = this.#ready === undefined;
      const ready = await this.#start(signal, spawnProcess);
      // Closed or failed while it started: nothing is written to its input.
      if (this.#failure !== undefined) throw this.#failure;
      const waitMs = performance.now() - asked;
      const id = this.#next++;
      const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error("the reranker did not answer in time");
          reject(error);
          this.#fail(error);
        }, REQUEST_TIMEOUT_MS);
        this.#pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
      this.#child!.stdin!.write(
        `${JSON.stringify({ op: "rerank", id, query, documents })}\n`,
      );
      const message = await answer;
      return {
        scores: message["scores"] as ReadonlyArray<number>,
        truncated: message["truncated"] as ReadonlyArray<boolean>,
        rerankMillis: Number(message["rerankMillis"]),
        waitMs,
        loadMillis: started ? ready.loadMillis : undefined,
        // The process's own peak when `ps` cannot say.
        residentBytes:
          residentBytes(this.pid) ??
          (Number.isFinite(Number(message["maxRssBytes"]))
            ? Number(message["maxRssBytes"])
            : undefined),
      } satisfies RerankAnswer;
    });
    this.#tail = work.catch(() => undefined);
    return work;
  }

  /**
   * Ends the process: its input closes and it is asked to stop, then killed after a short grace
   * if it has not (as graph-client's command runner does). Resolves once it has exited.
   */
  async close() {
    this.#failure ??= new Error("the reranker was closed");
    this.#abandonStartup?.(this.#failure);
    for (const { reject } of this.#pending.values()) reject(this.#failure);
    this.#pending.clear();
    const child = this.#child;
    // A process that never spawned (a missing interpreter, no processes or files left) emits
    // only "error", never "exit": there is nothing to wait for.
    if (child === undefined || child.pid === undefined) return;
    child.stdin?.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      // Only an exit, or the backstop after the kill, ends the wait with the kill timer cleared:
      // an "error" (a kill that failed for a live process) ends it but leaves the kill to come.
      const kill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      // However the process ends, or fails to report it, a close never waits past this.
      const backstop = setTimeout(resolve, KILL_GRACE_MS + 1_000);
      kill.unref?.();
      backstop.unref?.();
      child.once("exit", () => {
        clearTimeout(kill);
        clearTimeout(backstop);
        resolve();
      });
      child.once("error", () => {
        clearTimeout(backstop);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

/** Refusals about a query's text; any other means the encoder process is gone. */
const QUERY_REFUSALS = new Set([
  "invalid-text",
  "unexpected-title",
  "invalid-batch-size",
  "batch-too-large",
  "request-too-large",
  "token-limit-exceeded",
]);

/** Refusals about one input: that chunk is not encodable; any other means the process is gone. */
const ITEM_REFUSALS = new Set([
  "invalid-text",
  "invalid-title",
  "unexpected-title",
  "unsupported-role",
  "invalid-input",
  // The client's own bounds on a request, checked before it reaches the process.
  "invalid-batch-size",
  "batch-too-large",
  "request-too-large",
  "token-limit-exceeded",
]);

/** The worker's refusals of the model's output for a batch, which one input can cause. */
const MODEL_OUTPUT_REFUSALS = new Set([
  "invalid-model-output",
  "unnormalizable-model-output",
]);

/** A text any working model encodes: the control for one input's unusable output. */
const CONTROL = { path: "control.txt", text: "control text for the encoder" };
let controls = 0;

/** EmbeddingGemma 2 as the chunk encoder: the semantic client's document role, title = path. */
export const chunkEncoder = (
  holder: Holder,
  device: LocalDevice,
  workerSha256: string,
): ChunkEncoder => {
  const once = async (
    client: SemanticClient,
    items: ReadonlyArray<{ path: string; text: string }>,
    signal?: AbortSignal,
    spawnProcess?: SemanticSpawn,
  ): Promise<ReadonlyArray<EncodedChunk>> => {
    if (items.length === 0) return [];
    const result = await client.encodeBatch(
      items.map((item) => ({
        role: "document",
        title: item.path,
        text: item.text,
      })),
      signal,
      spawnProcess,
    );
    if (result.kind === "encoded")
      return result.items.map((item) => ({
        kind: "vector" as const,
        vector: Float32Array.from(item.values),
      }));
    // The model's output for one input can be unusable (not finite, not normalizable): each input
    // is asked alone and only those that fail are refused. When every input fails alone, the
    // model itself is broken, which is a process failure, never a chunk's refusal.
    if (MODEL_OUTPUT_REFUSALS.has(result.reason) && items.length > 1) {
      const out: Array<EncodedChunk> = [];
      let failedAlone = 0;
      for (const item of items) {
        const alone = await client.encodeBatch([
          { role: "document", title: item.path, text: item.text },
        ]);
        if (alone.kind === "encoded")
          out.push({
            kind: "vector",
            vector: Float32Array.from(alone.items[0]!.values),
          });
        else if (MODEL_OUTPUT_REFUSALS.has(alone.reason)) {
          failedAlone++;
          out.push({ kind: "refused", reason: alone.reason });
        } else if (ITEM_REFUSALS.has(alone.reason))
          out.push({ kind: "refused", reason: alone.reason });
        else throw new Error(`the encoder stopped: ${alone.reason}`);
      }
      if (failedAlone === items.length)
        throw new Error(
          `the encoder stopped: ${result.reason} for every input alone`,
        );
      return out;
    }
    // One input alone whose model output is unusable: a control text tells a bad input (refused)
    // from a broken model (a process failure), so one bad chunk cannot fail every later job.
    if (MODEL_OUTPUT_REFUSALS.has(result.reason) && items.length === 1) {
      // A text of its own each time, and only an answer the model produced counts: the client
      // serves a text it has encoded before from its cache, which would not test the model.
      const control = await client.encodeBatch([
        {
          role: "document",
          title: CONTROL.path,
          text: `${CONTROL.text} ${Date.now()}-${++controls}`,
        },
      ]);
      if (control.kind === "encoded" && control.usage.generated > 0)
        return [{ kind: "refused", reason: result.reason }];
      throw new Error(
        `the encoder stopped: ${result.reason}, and for a control text too`,
      );
    }
    if (!ITEM_REFUSALS.has(result.reason))
      throw new Error(`the encoder stopped: ${result.reason}`);
    // One input spoils its batch: each is asked alone, and only the one at fault is refused.
    if (items.length === 1) return [{ kind: "refused", reason: result.reason }];
    const out: Array<EncodedChunk> = [];
    for (const item of items)
      out.push(...(await once(client, [item], signal, spawnProcess)));
    return out;
  };
  return {
    device,
    workerSha256,
    batchItems: device === "mps" ? MPS_BATCH_ITEMS : undefined,
    encode: (items) =>
      Effect.acquireUseRelease(
        Effect.sync(() => holder.begin("client")),
        () =>
          Effect.gen(function* () {
            const client = holder.client();
            const starting = client.stats().pid === null;
            const started = performance.now();
            const gate = yield* Worker.HeavyWork;
            const encoded = yield* Effect.tryPromise({
              try: (signal) =>
                once(client, items, signal, (launch) =>
                  Effect.runPromise(gate.spawn(Effect.void, launch), {
                    signal,
                  }),
                ),
              catch: (cause) =>
                new EncoderUnavailable({
                  message:
                    cause instanceof Error ? cause.message : String(cause),
                }),
            }).pipe(
              // A process-level failure closes this encoder; the next call starts a fresh one.
              Effect.tapError(() =>
                Effect.promise(() => holder.closeClient("failed", client)),
              ),
              // A job stopped at its deadline mid-batch leaves no process busy for the next one.
              Effect.onInterrupt(() =>
                Effect.promise(() => holder.closeClient("failed", client)),
              ),
            );
            const stats = client.stats();
            const bytes = residentBytes(stats.pid);
            yield* Effect.annotateCurrentSpan({
              "harness.hybrid.model.ms": Math.round(
                performance.now() - started,
              ),
              ...(starting && stats.loadMillis !== null
                ? {
                    "harness.hybrid.model.started": true,
                    "harness.hybrid.model.load_ms": Math.round(
                      stats.loadMillis,
                    ),
                  }
                : {}),
              ...(bytes === undefined
                ? {}
                : { "harness.hybrid.model.memory_bytes": bytes }),
            });
            return encoded;
          }),
        () => Effect.sync(() => holder.end("client")),
      ),
  };
};

const reranker = (
  holder: Holder,
  device: LocalDevice,
  workerSha256: string,
): PairReranker => ({
  device,
  workerSha256,
  score: (query, documents) =>
    Effect.acquireUseRelease(
      Effect.sync(() => holder.begin("reranker")),
      () =>
        Effect.gen(function* () {
          const process = holder.reranker();
          const gate = yield* Worker.HeavyWork;
          const answer = yield* Effect.tryPromise({
            try: (signal) =>
              process.score(query, documents, signal, (launch) =>
                Effect.runPromise(gate.spawn(Effect.void, launch), { signal }),
              ),
            catch: (cause) =>
              new RerankerUnavailable({
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          }).pipe(
            // A refusal is about one request; only a failed process is closed (and restarts).
            Effect.tapError(() =>
              process.failed
                ? Effect.promise(() => holder.closeReranker("failed", process))
                : Effect.void,
            ),
            // A job stopped at its deadline mid-request leaves no process busy for the next one.
            Effect.onInterrupt(() =>
              Effect.promise(() => holder.closeReranker("failed", process)),
            ),
          );
          yield* Effect.annotateCurrentSpan({
            "harness.hybrid.queue_wait.ms": Math.round(answer.waitMs),
            "harness.hybrid.model.ms": Math.round(answer.rerankMillis),
            ...(answer.loadMillis === undefined
              ? {}
              : {
                  "harness.hybrid.model.started": true,
                  "harness.hybrid.model.load_ms": Math.round(answer.loadMillis),
                }),
            ...(answer.residentBytes === undefined
              ? {}
              : { "harness.hybrid.model.memory_bytes": answer.residentBytes }),
          });
          return { scores: answer.scores, truncated: answer.truncated };
        }),
      () => Effect.sync(() => holder.end("reranker")),
    ),
});

const held = new Map<
  string,
  { readonly workers: HybridWorkers; readonly holder: Holder }
>();

/** Reports, as spans of the current job, the model processes that exited since the last one. */
const reportExits = Effect.suspend(() =>
  Effect.forEach(
    exits.splice(0),
    (exit) =>
      Effect.void.pipe(
        Effect.withSpan("harness.hybrid.model.exited", {
          attributes: {
            "harness.hybrid.model": exit.model,
            "harness.device": exit.device,
            "harness.hybrid.model.exit_reason": exit.reason,
            "harness.hybrid.model.uptime_ms": exit.uptimeMs,
            "harness.hybrid.model.calls": exit.calls,
            ...(exit.residentBytes === undefined
              ? {}
              : { "harness.hybrid.model.memory_bytes": exit.residentBytes }),
          },
        }),
      ),
    { discard: true },
  ),
);

/**
 * The worker's model processes for a setup: the held ones, or new ones started on first call.
 * What it needs is checked first: the reranker's snapshot and worker on disk, so a misconfigured
 * machine says so at once rather than at the first hunk.
 */
export const hybridWorkers = (setup: {
  readonly runtime: HybridRuntime;
  readonly e0: E0Runtime;
}): Effect.Effect<HybridWorkers, HybridUnavailable> =>
  Effect.gen(function* () {
    yield* reportExits;
    const { runtime, e0 } = setup;
    const device = runtime.device;
    const key = [
      e0.python,
      e0.snapshot,
      e0.worker,
      runtime.reranker.snapshot,
      runtime.reranker.worker,
      device,
      runtime.models,
    ].join("\0");
    const gate = yield* Worker.HeavyWork;
    const bindQuery = (workers: HybridWorkers): HybridWorkers => ({
      ...workers,
      encodeQuery: async (text, signal) => {
        if (workers.encodeQuery === undefined)
          throw new Error("query encoder unavailable");
        return workers.encodeQuery(text, signal, (launch) =>
          Effect.runPromise(gate.spawn(Effect.void, launch), { signal }),
        );
      },
    });
    const existing = held.get(key);
    if (existing !== undefined) return bindQuery(existing.workers);
    const workerSha256 = yield* Effect.try({
      try: () => sha256(readFileSync(runtime.reranker.worker)),
      catch: (cause) =>
        new HybridUnavailable({
          message: `the reranker worker is unreadable: ${String(cause)}`,
        }),
    });
    if (workerSha256 !== runtime.reranker.workerSha256)
      return yield* new HybridUnavailable({
        message:
          "the reranker worker changed since the settings were read; restart the worker",
      });
    const holder = new Holder(
      device,
      () =>
        new SemanticClient({
          pythonExecutable: e0.python,
          snapshotPath: e0.snapshot,
          workerPath: e0.worker,
          variant: { kind: "base" },
          device,
          niceness: NICENESS,
          startupTimeoutMs: STARTUP_TIMEOUT_MS,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
        }),
      () =>
        new RerankerProcess({
          python: e0.python,
          worker: runtime.reranker.worker,
          snapshot: runtime.reranker.snapshot,
          device,
          workerSha256,
        }),
      MODEL_IDLE_MS,
      runtime.models,
    );
    const workers: HybridWorkers = {
      encoder: chunkEncoder(holder, device, WORKER_SHA256),
      reranker: reranker(holder, device, workerSha256),
      encodeQuery: async (text, signal, spawnProcess) => {
        holder.begin("client");
        try {
          const client = holder.client();
          const result = await client.encodeBatch(
            [{ role: "code-query", text }],
            signal,
            spawnProcess,
          );
          // A refusal that is not about the text means the process is gone: a fresh one next.
          if (result.kind === "refusal" && !QUERY_REFUSALS.has(result.reason))
            await holder.closeClient("failed", client);
          return result;
        } finally {
          holder.end("client");
        }
      },
      releaseEncoder: () => Effect.promise(() => holder.closeClient("room")),
      cpuSeconds: () =>
        cpuSeconds(holder.pids.client) + cpuSeconds(holder.pids.reranker),
    };
    held.set(key, { workers, holder });
    return bindQuery(workers);
  });

/** Closes every held model process (a foreground command ends with it). */
export const closeHybridWorkers = Effect.promise(() =>
  Promise.all([...held.values()].map(({ holder }) => holder.close("idle"))),
);
