import { Clock, Data, Effect } from "effect";
import { CAPTURE_NO_PROGRESS_REASON } from "@neuve/records-schema";
import { z } from "zod";

const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CloseInventory = z.strictObject({
  records: Count,
  bytes: Count,
  calls: Count,
  frames: Count,
});
export type CloseInventory = z.infer<typeof CloseInventory>;
// The outer machine and shutdown waits include this entire close allowance, plus their own drain.
export const MAX_CLOSE_MS = 30 * 60 * 1000;
export const SCAN_NO_PROGRESS_MS = 30_000;
export const NO_PROGRESS_REASON = CAPTURE_NO_PROGRESS_REASON;
export class ScanNoProgress extends Data.TaggedError("ScanNoProgress")<{}> {
  readonly retryable = true;
  override get message() {
    return NO_PROGRESS_REASON;
  }
}

/** The watcher lives on the caller's Effect clock, outside the work's event loop in production. */
export const withProgressWatchdog = <A, E, R>(
  work: (progress: () => void, signal: AbortSignal) => Effect.Effect<A, E, R>,
  windowMs = SCAN_NO_PROGRESS_MS,
) =>
  Effect.suspend(() => {
    const controller = new AbortController();
    let counter = 0;
    const watcher = Effect.gen(function* () {
      let observed = counter;
      let changedAt = yield* Clock.currentTimeMillis;
      for (;;) {
        yield* Effect.sleep(Math.max(1, windowMs / 4));
        const now = yield* Clock.currentTimeMillis;
        if (counter !== observed) {
          observed = counter;
          changedAt = now;
        } else if (now - changedAt >= windowMs) {
          const error = new ScanNoProgress();
          controller.abort(error);
          return yield* Effect.fail(error);
        }
      }
    });
    return Effect.raceFirst(
      work(() => {
        counter++;
      }, controller.signal),
      watcher.pipe(Effect.ensuring(Effect.sync(() => controller.abort()))),
    );
  });

/** Effect 4 callbacks await their canceller; tryPromise alone leaves the promise running. */
export const joinedScan = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Effect.callback<A, unknown>((resume, signal) => {
    let task: Promise<A>;
    try {
      task = work(signal);
    } catch (error) {
      resume(Effect.fail(error));
      return;
    }
    task.then(
      (value) => resume(Effect.succeed(value)),
      (error: unknown) => resume(Effect.fail(error)),
    );
    return Effect.promise(() =>
      task.then(
        () => {},
        () => {},
      ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.void,
      }),
    );
  });
export const checkedCount = (...values: number[]) => {
  const result = values.reduce((sum, value) => sum + Count.parse(value), 0);
  return Count.parse(result);
};
// Refit against all 15 full-sample-2 diagnostics after removing 64 MiB/call:
// 117,386–468,605 ms allowances, 6.00–17.34 times the partial elapsed work.
// The 3 ms term is per record, not per source; frames and bytes are separate terms.
// 250 ms/MiB is 1.6 times the measured single-view byte rate, not a multi-pass guarantee.
export const closeCeiling = (raw: CloseInventory): number => {
  const inventory = CloseInventory.parse(raw);
  return Math.min(
    MAX_CLOSE_MS,
    checkedCount(
      30_000,
      Count.parse(inventory.records * 3),
      Count.parse(Math.ceil(inventory.bytes / (1024 * 1024)) * 250),
      Count.parse(inventory.frames * 3),
    ),
  );
};

/** Long delays are chained, as in pi's scheduler, rather than overflowing the runtime timer. */
export const deadlineTimer = (deadline: number, expire: () => void) => {
  if (!Number.isFinite(deadline))
    throw new Error("Invalid inspection deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      timer = setTimeout(expire, 0);
      return;
    }
    timer = setTimeout(schedule, Math.min(2_147_483_647, Math.ceil(remaining)));
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
