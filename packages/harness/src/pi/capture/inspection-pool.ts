import { validProgress } from "./progress-relay.ts";
import type { InspectionProgress } from "./close-diagnostic.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { Worker } from "node:worker_threads";
import { Effect } from "effect";
import {
  CredentialDetectors,
  InspectionBudget,
  unavailable,
  type CredentialSource,
  type CredentialEpochId,
  type InspectionResult,
} from "./credential-detectors.ts";
import { Job, Reply, type WireSource } from "./inspection-protocol.ts";
import { deadlineTimer, MAX_CLOSE_MS } from "./watchdog.ts";

const MiB = 1024 * 1024;
export const QUEUED_BYTES = 64 * MiB;
const usageKinds = [
  "units",
  "fullChecks",
  "fullBytes",
  "matches",
  "parseUnits",
  "decodeUnits",
] as const;
const cgroup = (file: string) => {
  try {
    return readFileSync(`/sys/fs/cgroup/${file}`, "utf8").trim();
  } catch {
    return undefined;
  }
};
export const inspectionWidth = (cpus: number, memory: number) =>
  Math.max(
    1,
    Math.min(
      4,
      Math.floor(cpus),
      Math.floor((memory - 512 * MiB - QUEUED_BYTES) / (256 * MiB)),
    ),
  );
export type MemorySource =
  "linux-memavailable" | "vm_stat" | "freemem-fallback";
const linuxAvailableMemory = () => {
  try {
    const kb = Number(
      readFileSync("/proc/meminfo", "utf8").match(
        /^MemAvailable:\s+(\d+) kB$/m,
      )?.[1],
    );
    if (Number.isSafeInteger(kb) && kb >= 0 && Number.isSafeInteger(kb * 1024))
      return { available: kb * 1024, source: "linux-memavailable" as const };
  } catch {
    /* Non-Linux hosts use the operating system's free-memory observation. */
  }
  return { available: freemem(), source: "freemem-fallback" as const };
};
export const macAvailableMemory = (text: string) => {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (name: string) =>
    Number(text.match(new RegExp(`^${name}:\\s+(\\d+)\\.`, "m"))?.[1]);
  const free = pages("Pages free"),
    speculative = pages("Pages speculative"),
    purgeable = pages("Pages purgeable");
  const reclaimable = Math.min(
    pages("Pages inactive"),
    pages("File-backed pages"),
  );
  const available = (free + speculative + purgeable + reclaimable) * pageSize;
  if (!Number.isSafeInteger(available) || available <= 0)
    throw new Error("invalid memory observation");
  return available;
};

/** macOS free pages alone exclude memory the kernel can reclaim. Read vm_stat asynchronously. */
export const hostAvailableMemory = async (): Promise<{
  available: number;
  source: MemorySource;
}> => {
  if (process.platform !== "darwin") return linuxAvailableMemory();
  let child: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
  try {
    child = Bun.spawn(["/usr/bin/vm_stat"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
    const timer = setTimeout(() => child?.kill(), 2000);
    try {
      const text = await new Response(child.stdout).text();
      if ((await child.exited) !== 0)
        throw new Error("memory observation failed");
      const available = macAvailableMemory(text);
      return { available, source: "vm_stat" };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { available: freemem(), source: "freemem-fallback" };
  }
};
export const readMachineInspectionInputs = async () => {
  const memory = await hostAvailableMemory();
  return machineInspectionInputs(memory.available, memory.source);
};
export const availableInspectionMemory = (
  host: number,
  maximum: number | null,
  current: number,
  inactiveFile: number,
) =>
  Math.min(
    host,
    maximum === null
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, maximum - Math.max(0, current - inactiveFile)),
  );

export const machineInspectionInputs = (
  hostAvailable = linuxAvailableMemory().available,
  memorySource: MemorySource = linuxAvailableMemory().source,
) => {
  const parallelism = availableParallelism();
  const cpuMax = cgroup("cpu.max") ?? null;
  const maximum =
    cgroup("memory.max") ?? cgroup("memory/memory.limit_in_bytes");
  const current =
    cgroup("memory.current") ?? cgroup("memory/memory.usage_in_bytes");
  const inactive = Number(
    cgroup("memory.stat")?.match(/^inactive_file (\d+)$/m)?.[1] ?? 0,
  );
  const memoryMax =
    maximum !== undefined &&
    maximum !== "max" &&
    Number.isSafeInteger(Number(maximum))
      ? Number(maximum)
      : null;
  const memoryCurrent =
    current !== undefined && Number.isSafeInteger(Number(current))
      ? Number(current)
      : 0;
  const inactiveFile = Number.isSafeInteger(inactive) ? inactive : 0;
  const available = availableInspectionMemory(
    hostAvailable,
    memoryMax,
    memoryCurrent,
    inactiveFile,
  );
  return {
    parallelism,
    cpuMax,
    memoryMax,
    memoryCurrent,
    inactiveFile,
    hostAvailable,
    memorySource,
    available,
  };
};
export const machineInspectionWidth = () => {
  const inputs = machineInspectionInputs();
  const reserved = Math.max(1, inputs.parallelism - 1);
  const configured = Number(process.env["NEUVE_CAPTURE_WIDTH"] ?? 4);
  return Math.min(
    process.env["NEUVE_CAPTURE_WIDTH"] === undefined
      ? inspectionWidth(reserved, inputs.available)
      : Math.min(4, reserved),
    Number.isInteger(configured) && configured >= 1 && configured <= 4
      ? configured
      : 1,
  );
};
export const scanMemoryGrant = (
  sizes: { total: number; largest: number },
  inputs = machineInspectionInputs(),
) => {
  const reserve = 1024 * MiB;
  const base = sizes.total * 3 + sizes.largest * 6 + QUEUED_BYTES * 2;
  let width = Math.min(4, Math.max(1, inputs.parallelism - 1));
  while (width > 1 && base + width * 256 * MiB > inputs.available - reserve)
    width--;
  const estimatedPeak = base + width * 256 * MiB;
  return {
    ...inputs,
    reserve,
    width,
    estimatedPeak,
    admitted: estimatedPeak <= inputs.available - reserve,
  };
};
export type SourceProducer = (
  consume: (source: CredentialSource) => Promise<void>,
) => Promise<void>;
const wire = (source: CredentialSource): WireSource =>
  source.kind === "json"
    ? { kind: "json", text: source.json.contents() }
    : source.kind === "text"
      ? source
      : {
          kind: "bytes",
          bytes: Uint8Array.from(source.bytes),
          mediaType: source.mediaType,
        };
const sizeOf = (source: CredentialSource) =>
  source.kind === "bytes"
    ? source.bytes.byteLength + source.mediaType.length * 2 + 512
    : (source.kind === "json"
        ? source.json.contents().length
        : source.text.length) *
        2 +
      512;
const identityOf = (source: WireSource) =>
  createHash("sha256")
    .update(source.kind)
    .update("\0")
    .update(source.kind === "bytes" ? source.mediaType : "")
    .update("\0")
    .update(
      source.kind === "bytes"
        ? source.bytes
        : Buffer.from(source.text, "utf16le"),
    )
    .digest("hex");

class Scanner {
  readonly worker: Worker;
  #next = 0;
  #closed = false;
  #joining: Promise<void> | undefined;
  constructor(key: Uint8Array, state: Uint8Array) {
    // Copy addressed views only, never a pooled backing buffer containing adjacent data.
    const keyCopy = Uint8Array.from(key);
    let stateCopy: Uint8Array | undefined;
    try {
      stateCopy = Uint8Array.from(state);
      this.worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./retained-sdk-worker.ts"
            : "./retained-sdk-worker.js",
          import.meta.url,
        ),
        {
          env: {},
          execArgv: [],
          workerData: { inspection: true, key: keyCopy, state: stateCopy },
          stdout: true,
          stderr: true,
        },
      );
    } finally {
      keyCopy.fill(0);
      stateCopy?.fill(0);
    }
    this.worker.stdout?.resume();
    this.worker.stderr?.resume();
    // An error between jobs must never become an unhandled process error.
    this.worker.on("error", () => {
      this.#closed = true;
    });
    this.worker.on("exit", () => {
      this.#closed = true;
    });
  }
  close(): Promise<void> {
    return (this.#joining ??= (async () => {
      this.#closed = true;
      await new Promise<void>((resolve) => {
        const finish = () => {
          stop();
          this.worker.off("message", message);
          this.worker.off("exit", finish);
          resolve();
        };
        const message = (raw: unknown) => {
          if (
            raw !== null &&
            typeof raw === "object" &&
            "type" in raw &&
            raw.type === "closed"
          )
            finish();
        };
        const stop = deadlineTimer(performance.now() + 1000, finish);
        this.worker.on("message", message);
        this.worker.on("exit", finish);
        try {
          this.worker.postMessage({ type: "close" });
        } catch {
          finish();
        }
      });
      await this.worker.terminate();
      this.worker.removeAllListeners();
    })());
  }
  async run(
    sources: readonly CredentialSource[],
    limits: InspectionBudget["limits"],
    deadline: number,
    epochs: ReadonlyArray<CredentialEpochId>,
    observe: (epoch: CredentialEpochId) => void,
    signal: AbortSignal,
    progress: () => void,
  ) {
    const job = Job.parse({
      id: ++this.#next,
      sources: sources.map((source) => {
        const value = wire(source);
        return { source: value, identity: identityOf(value) };
      }),
      limits,
      deadlineEpochMs: Date.now() + Math.max(0, deadline - performance.now()),
    });
    const observed = new Set<CredentialEpochId>();
    let progressed = -1;
    return await new Promise<{
      results: InspectionResult[];
      usage?: InspectionBudget["usage"];
      exhausted?: keyof InspectionBudget["usage"] | undefined;
    }>((resolve) => {
      let settled = false;
      const finish = (
        results: InspectionResult[],
        usage?: InspectionBudget["usage"],
        exhausted?: keyof InspectionBudget["usage"],
      ) => {
        if (settled) return;
        settled = true;
        stopTimer();
        signal.removeEventListener("abort", abort);
        this.worker.off("message", message);
        this.worker.off("error", fail);
        this.worker.off("exit", fail);
        resolve({
          ...(usage === undefined ? { results } : { results, usage }),
          exhausted,
        });
      };
      const fail = () =>
        finish(sources.map(() => unavailable("worker", [...observed])));
      const abort = () => {
        void this.close().then(() =>
          finish(sources.map(() => unavailable("cancelled", [...observed]))),
        );
      };
      const message = (raw: unknown) => {
        const parsed = Reply.safeParse(raw);
        if (!parsed.success || parsed.data.id !== job.id) {
          fail();
          return;
        }
        const reply = parsed.data;
        if (reply.type === "progress") {
          const maximum = Object.values(limits).reduce(
            (sum, value) => sum + value,
            0,
          );
          if (!validProgress(progressed, reply.units, maximum)) {
            fail();
            return;
          }
          progressed = reply.units;
          progress();
          return;
        }
        if (reply.type === "observed") {
          if (!epochs.includes(reply.epoch)) {
            fail();
            return;
          }
          observed.add(reply.epoch);
          observe(reply.epoch);
          return;
        }
        if (
          reply.results.length !== job.sources.length ||
          reply.results.some(
            (item, index) =>
              item.identity !== job.sources[index]?.identity ||
              (item.result.status === "complete" &&
                (item.result.epochs.length !== epochs.length ||
                  new Set(item.result.epochs).size !== epochs.length ||
                  item.result.epochs.some((epoch) => !epochs.includes(epoch)) ||
                  item.result.matches.some(
                    (match) =>
                      !epochs.includes(match.epoch) || match.start > match.end,
                  ))) ||
              (item.result.status === "unavailable" &&
                item.result.exposedEpochs.some(
                  (epoch) => !epochs.includes(epoch),
                )),
          ) ||
          usageKinds.some((kind) => reply.usage[kind] > limits[kind])
        ) {
          fail();
          return;
        }
        finish(
          reply.results.map((item) => item.result),
          reply.usage,
          reply.exhausted,
        );
      };
      const stopTimer = deadlineTimer(deadline, abort);
      signal.addEventListener("abort", abort, { once: true });
      this.worker.on("message", message);
      this.worker.on("error", fail);
      this.worker.on("exit", fail);
      if (signal.aborted) abort();
      else if (this.#closed) fail();
      else
        try {
          this.worker.postMessage(job);
        } catch {
          fail();
        }
    });
  }
}
export class StopInventory extends Error {}

/** The producer pauses for each bounded batch. Only that batch spends the disjoint allowances. */
export const inspectInventory = async (input: {
  produce: SourceProducer;
  engine: CredentialDetectors;
  key: Uint8Array;
  state: Uint8Array;
  budget: InspectionBudget;
  requiredEpochs: ReadonlyArray<string>;
  observe: (epoch: CredentialEpochId) => void;
  width?: number;
  progress?: ((value: InspectionProgress) => void) | undefined;
}): Promise<InspectionResult[]> => {
  const width = input.width ?? machineInspectionWidth();
  if (!Number.isSafeInteger(width) || width < 1 || width > 4)
    throw new Error("Invalid inspection width");
  const statistics: InspectionProgress = {
    sources: 0,
    workers: 1,
    scanMs: 0,
    peakQueuedBytes: 0,
  };
  let scanMs = 0;
  const results: InspectionResult[] = [];
  const observeResult = (result: InspectionResult) => {
    for (const epoch of result.status === "complete"
      ? result.matches.map((match) => match.epoch)
      : result.exposedEpochs)
      input.observe(epoch);
  };
  const check = (batch: InspectionResult[]) => {
    for (const result of batch) {
      observeResult(result);
      results.push(result);
    }
    if (
      batch.some(
        (result) =>
          result.status !== "complete" ||
          result.matches.length > 0 ||
          input.requiredEpochs.some(
            (epoch) => !result.epochs.some((id) => id === epoch),
          ),
      )
    )
      throw new StopInventory();
  };
  const serial = async (source: CredentialSource) => {
    const started = performance.now();
    const result =
      source.kind === "json"
        ? await input.engine.inspectJson({
            json: source.json,
            budget: input.budget,
          })
        : source.kind === "text"
          ? await input.engine.inspectText({
              text: source.text,
              budget: input.budget,
            })
          : await input.engine.inspectArtifact({
              bytes: source.bytes,
              mediaType: source.mediaType,
              budget: input.budget,
            });
    input.budget.progress();
    statistics.sources++;
    scanMs += performance.now() - started;
    statistics.scanMs = Math.ceil(scanMs);
    input.progress?.({ ...statistics });
    check([result]);
  };
  const program = Effect.scoped(
    Effect.gen(function* () {
      let released = false;
      const workers = yield* Effect.acquireRelease(
        Effect.sync(() => new Array<Scanner>()),
        (pool) =>
          Effect.suspend(() => {
            released = true;
            return Effect.forEach(
              pool,
              (worker) => Effect.promise(() => worker.close()),
              { concurrency: width, discard: true },
            );
          }),
      );
      yield* Effect.tryPromise({
        try: async (signal) => {
          const assertActive = () => {
            if (released || signal.aborted)
              throw new Error("Credential inspection unavailable (cancelled)");
            input.budget.charge("units", 0);
          };
          let pending: CredentialSource[] = [],
            queued = 0;
          const flush = async () => {
            assertActive();
            if (pending.length === 0) return;
            const started = performance.now();
            const batch = pending;
            const bytes = queued;
            pending = [];
            queued = 0;
            if (
              input.width === undefined &&
              batch.length < 256 &&
              (batch.length < width || bytes < 8 * MiB)
            ) {
              for (const source of batch) {
                assertActive();
                await serial(source);
              }
              return;
            }
            if (workers.length === 0) {
              for (let index = 0; index < width; index++) {
                assertActive();
                workers.push(new Scanner(input.key, input.state));
              }
              statistics.workers = width;
            }
            const used = input.budget.usage;
            const count = Math.min(workers.length, batch.length);
            // Parent census is suspended until every reply is charged, including failures.
            const allowance = { ...input.budget.limits };
            for (const kind of usageKinds)
              allowance[kind] = Math.floor(
                (input.budget.limits[kind] - used[kind]) / count,
              );
            statistics.allowance = { ...allowance };
            input.progress?.({ ...statistics });
            const jobs = Array.from({ length: count }, () => ({
              bytes: 0,
              records: new Array<{
                index: number;
                source: CredentialSource;
                bytes: number;
              }>(),
            }));
            for (const record of batch
              .map((source, index) => ({
                source,
                index,
                bytes: sizeOf(source),
              }))
              .toSorted((a, b) => b.bytes - a.bytes)) {
              let owner = jobs[0];
              if (owner === undefined)
                throw new Error("Inspection pool has no owner");
              for (const candidate of jobs)
                if (candidate.bytes < owner.bytes) owner = candidate;
              owner.records.push(record);
              owner.bytes += record.bytes;
            }
            const outcome = await Effect.runPromise(
              Effect.result(
                Effect.forEach(
                  jobs,
                  (job, index) =>
                    Effect.tryPromise({
                      try: (jobSignal) => {
                        const worker = workers[index];
                        if (worker === undefined)
                          throw new Error("Inspection worker missing");
                        return worker
                          .run(
                            job.records.map((record) => record.source),
                            allowance,
                            input.budget.deadline ??
                              performance.now() + MAX_CLOSE_MS,
                            input.engine.epochIds,
                            input.observe,
                            jobSignal,
                            () => input.budget.progress(),
                          )
                          .then((reply) => {
                            input.budget.progress();
                            return reply;
                          });
                      },
                      catch: (error) => error,
                    }),
                  { concurrency: width },
                ),
              ),
              { signal },
            );
            assertActive();
            if (outcome._tag === "Failure") throw outcome.failure;
            const ordered: Array<{ index: number; result: InspectionResult }> =
              [];
            for (const reply of outcome.success)
              for (const result of reply.results) observeResult(result);
            for (const [jobIndex, reply] of outcome.success.entries()) {
              if (reply.exhausted !== undefined)
                statistics.exhausted ??= reply.exhausted;
              // A terminated worker's actual work is unknowable. Spend its full lease and refuse.
              for (const kind of usageKinds)
                input.budget.charge(
                  kind,
                  reply.usage?.[kind] ?? allowance[kind],
                );
              for (const [resultIndex, result] of reply.results.entries()) {
                const record = jobs[jobIndex]?.records[resultIndex];
                if (record === undefined)
                  throw new Error("Inspection reply ordering unavailable");
                ordered.push({ index: record.index, result });
              }
            }
            const all = ordered
              .toSorted((a, b) => a.index - b.index)
              .map((item) => item.result);
            statistics.sources += all.length;
            scanMs += performance.now() - started;
            statistics.scanMs = Math.ceil(scanMs);
            input.progress?.({ ...statistics });
            check(all);
          };
          try {
            await input.produce(async (source) => {
              assertActive();
              const bytes = sizeOf(source);
              if (width === 1) {
                await serial(source);
                return;
              }
              if (queued + bytes > QUEUED_BYTES || pending.length >= 256)
                await flush();
              if (bytes > QUEUED_BYTES) {
                await serial(source);
                return;
              }
              pending.push(source);
              queued += bytes;
              statistics.peakQueuedBytes = Math.max(
                statistics.peakQueuedBytes,
                queued,
              );
            });
            await flush();
          } catch (error) {
            if (!(error instanceof StopInventory)) throw error;
          }
        },
        catch: (error) => error,
      });
      return results;
    }),
  );
  let outcome;
  try {
    outcome = await Effect.runPromise(Effect.result(program), {
      signal: input.budget.signal,
    });
  } catch (error) {
    input.budget.charge("units", 0);
    throw error;
  }
  if (outcome._tag === "Failure") throw outcome.failure;
  return outcome.success;
};
