import { createCaptureStaging, type CaptureStagingJob } from "./staging.ts";
import { ScanFailureKind } from "./scan-failure.ts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setPriority } from "node:os";
import { Clock, Context, Data, Effect } from "effect";
import { z } from "zod";
import { Worker, type StoreLocation } from "@neuve/records-core";
import {
  closeCeiling,
  withProgressWatchdog,
  joinedScan,
  NO_PROGRESS_REASON,
} from "./watchdog.ts";
import {
  scanMemoryGrant,
  readMachineInspectionInputs,
} from "./inspection-pool.ts";
import { publicCloseReason, PublicRefusal } from "./close-diagnostic.ts";
import { CaptureScanBasis, type CaptureFiled } from "@neuve/records-schema";

const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ScanReply = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), counter: Count }),
  z.strictObject({
    type: z.literal("verdict"),
    outcome: z.enum(["clean", "refused"]),
    basis: CaptureScanBasis.optional(),
    record: z.string().regex(/^[a-f0-9]{64}$/),
    reason: PublicRefusal.optional(),
    diagnostic: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    rss: Count,
  }),
  z.strictObject({
    type: z.literal("failure"),
    failureKind: ScanFailureKind,
    reason: PublicRefusal,
    retryable: z.boolean(),
  }),
]);
export type ScanVerdict = Extract<
  z.infer<typeof ScanReply>,
  { type: "verdict" }
>;
export class ScanAttemptFailed extends Data.TaggedError("ScanAttemptFailed")<{
  readonly reason: string;
  readonly retryable: boolean;
  readonly failureKind?: z.infer<typeof ScanFailureKind>;
  readonly memorySource?: "linux-memavailable" | "vm_stat" | "freemem-fallback";
  readonly availableBytes?: number;
  readonly reserveBytes?: number;
  readonly estimatedPeakBytes?: number;
  readonly width?: number;
}> {
  override get message() {
    return this.reason;
  }
}
export const ScanMachineBudget = Context.Reference(
  "@neuve/harness/ScanMachineBudget",
  {
    defaultValue:
      (): ((sizes: {
        total: number;
        largest: number;
      }) =>
        | ReturnType<typeof scanMemoryGrant>
        | Promise<ReturnType<typeof scanMemoryGrant>>) =>
      async (sizes) =>
        scanMemoryGrant(sizes, await readMachineInspectionInputs()),
  },
);

export type ScanResult = ScanVerdict & {
  machine: ReturnType<typeof scanMemoryGrant> & { elapsedMs: number };
};

type ScanChild = Bun.Subprocess<"ignore", "pipe", "pipe">;
const stopScanChild = async (child: ScanChild) => {
  if (child.exitCode !== null) {
    await child.exited;
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([child.exited, Bun.sleep(1000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await child.exited;
};
const watchChild = (child: ScanChild, progress: () => void) =>
  Effect.callback<ScanVerdict, ScanAttemptFailed>((resume) => {
    let stopping: Promise<void> | undefined;
    const stop = () => (stopping ??= stopScanChild(child));
    const task = (async () => {
      let verdict: ScanVerdict | undefined;
      let failure:
        Extract<z.infer<typeof ScanReply>, { type: "failure" }> | undefined;
      let counter = -1;
      const drain = async () => {
        for await (const _ of child.stderr) {
          /* Never relay private child stderr. */
        }
      };
      const read = async () => {
        let buffer = "";
        for await (const chunk of child.stdout) {
          buffer += new TextDecoder().decode(chunk);
          if (buffer.length > 65_536)
            throw new Error("invalid capture scan reply");
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            const reply = ScanReply.parse(JSON.parse(line));
            if (reply.type === "progress") {
              if (reply.counter <= counter)
                throw new Error("invalid scan progress");
              counter = reply.counter;
              progress();
            } else if (reply.type === "verdict") {
              if (verdict !== undefined || failure !== undefined)
                throw new Error("duplicate scan result");
              verdict = reply;
            } else {
              failure = reply;
            }
          }
        }
        if (buffer.length !== 0) throw new Error("torn scan result");
      };
      try {
        await Promise.all([read(), drain()]);
        const exit = await child.exited;
        if (failure !== undefined)
          throw new ScanAttemptFailed({
            reason: failure.reason,
            retryable: failure.retryable,
            failureKind: failure.failureKind,
          });
        if (exit !== 0 || verdict === undefined)
          throw new Error("capture scan child exited without a verdict");
        resume(Effect.succeed(verdict));
      } catch (error) {
        await stop();
        resume(
          Effect.fail(
            error instanceof ScanAttemptFailed
              ? error
              : new ScanAttemptFailed({
                  reason: "capture scan child exited without a valid verdict",
                  retryable: true,
                }),
          ),
        );
      }
    })();
    return joinedScan(async () => {
      await stop();
      await task;
    }).pipe(Effect.orElseSucceed(() => {}));
  });

/** The gate owns the final latch check and synchronous process creation. */
export const runScanProcess = <E = never, R = never>(input: {
  location: StoreLocation;
  event: z.infer<typeof CaptureFiled>;
  command: ReadonlyArray<string>;
  observe?: boolean;
  job?: CaptureStagingJob;
  seal?: (result: ScanResult) => Effect.Effect<void, E, R>;
}) =>
  Effect.gen(function* () {
    yield* (yield* Worker.HandlerLifetime).retain;
    const gate = yield* Worker.HeavyWork;
    const ceilingMs = yield* Effect.try({
      try: () => closeCeiling(input.event.payload.counts),
      catch: () =>
        new ScanAttemptFailed({
          reason: "invalid capture scan counts; export refused",
          retryable: false,
        }),
    });
    const observe = yield* ScanMachineBudget;
    let grant = yield* Effect.promise(() =>
      Promise.resolve(observe(input.event.payload.sizes)),
    );
    const admissionStarted = yield* Clock.currentTimeMillis;
    while (!grant.admitted) {
      if ((yield* Clock.currentTimeMillis) - admissionStarted >= 60_000)
        return yield* Effect.fail(
          new ScanAttemptFailed({
            reason: "capture scan memory admission timed out; retry later",
            memorySource: grant.memorySource,
            availableBytes: grant.available,
            reserveBytes: grant.reserve,
            estimatedPeakBytes: grant.estimatedPeak,
            width: grant.width,
            retryable: true,
          }),
        );
      yield* Effect.sleep("5 seconds");
      grant = yield* Effect.promise(() =>
        Promise.resolve(observe(input.event.payload.sizes)),
      );
    }

    const root = join(input.location.directory, "capture-jobs");
    yield* Effect.tryPromise(() =>
      mkdir(root, { recursive: true, mode: 0o700 }),
    );
    return yield* Effect.acquireUseRelease(
      Effect.try(() => createCaptureStaging(join(root, "job-"), input.job)),
      (work) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* gate
              .child(
                Effect.gen(function* () {
                  grant = yield* Effect.promise(() =>
                    Promise.resolve(observe(input.event.payload.sizes)),
                  );
                  if (!grant.admitted)
                    return yield* Effect.fail(
                      new ScanAttemptFailed({
                        reason:
                          "capture scan memory admission changed before scan; retry later",
                        retryable: true,
                        memorySource: grant.memorySource,
                        availableBytes: grant.available,
                        reserveBytes: grant.reserve,
                        estimatedPeakBytes: grant.estimatedPeak,
                        width: grant.width,
                      }),
                    );
                  return grant;
                }),
                (fresh) => {
                  const child = Bun.spawn(
                    [
                      ...input.command,
                      "worker",
                      "capture-scan",
                      "--store",
                      input.location.directory,
                      "--capture",
                      input.event.payload.rawCapture,
                      ...(input.observe === true ? ["--observe"] : []),
                      "--scan-parent",
                      String(process.pid),
                      "--work",
                      work,
                    ],
                    {
                      cwd: work,
                      stdin: "ignore",
                      stdout: "pipe",
                      stderr: "pipe",
                      detached: true,
                      env: {
                        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                        HOME: work,
                        TMPDIR: work,
                        NEUVE_CAPTURE_WIDTH: String(fresh.width),
                        NEUVE_MODE: process.env["NEUVE_MODE"] ?? "",
                      },
                    },
                  );
                  try {
                    setPriority(child.pid, 10);
                  } catch {}
                  return child;
                },
                (child) => Effect.promise(() => stopScanChild(child)),
              )
              .pipe(
                Effect.catchDefect(() =>
                  Effect.fail(
                    new ScanAttemptFailed({
                      reason: "capture scan child could not start",
                      retryable: true,
                    }),
                  ),
                ),
              );
            return yield* Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis;
              return yield* Effect.gen(function* () {
                const result = yield* withProgressWatchdog((progress) =>
                  watchChild(child, progress),
                );
                const completed: ScanResult = {
                  ...result,
                  machine: {
                    ...grant,
                    elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
                  },
                };
                if (input.seal !== undefined) yield* input.seal(completed);
                return completed;
              }).pipe(
                Effect.timeoutOrElse({
                  duration: ceilingMs,
                  orElse: () =>
                    Effect.fail(
                      new ScanAttemptFailed({
                        reason: `capture scan exceeded its ${ceilingMs}-millisecond ceiling`,
                        retryable: true,
                      }),
                    ),
                }),
              );
            });
          }),
        ),
      (work) =>
        Effect.promise(() => rm(work, { recursive: true, force: true })),
    );
  });
