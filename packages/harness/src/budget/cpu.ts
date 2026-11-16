import { fstatSync } from "node:fs";
import { z } from "zod";
import type { OnBudgetYield, BudgetAdmissionFailed } from "./acquire.ts";
import { Context, Effect, Exit, Option, type Cause } from "effect";
import { jobBudget, withCpuEffect } from "./local.ts";
import type { Budget, Priority } from "./scheduler.ts";

/** Supply at the job boundary. A child already covered by its parent's grant sets inherited=true. */
export class CpuWork extends Context.Service<
  CpuWork,
  {
    readonly budget: Budget;
    readonly priority: Priority;
    readonly inherited: boolean;
    readonly permits?: number;
    readonly onYield?: OnBudgetYield;
    readonly owner?: string;
  }
>()("@neuve/harness/CpuWork") {}

export const cpuWork = <A, E, R>(
  owner: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | BudgetAdmissionFailed, R> =>
  Effect.gen(function* () {
    const configured = yield* Effect.serviceOption(CpuWork);
    if (Option.isSome(configured) && configured.value.inherited)
      return yield* work;
    const budget = Option.isSome(configured)
      ? configured.value.budget
      : yield* jobBudget;
    return yield* withCpuEffect(
      budget,
      {
        owner: Option.isSome(configured)
          ? (configured.value.owner ?? owner)
          : owner,
        priority: Option.isSome(configured)
          ? configured.value.priority
          : { class: "interactive", position: "new", stage: 0 },
        permits: 1,
      },
      () => work,
      Option.isSome(configured) ? configured.value.onYield : undefined,
    );
  });

/** One grant for a pool. Descendants inherit it, so inner computations never acquire twice. */
export const cpuPool = <A, E, R>(
  owner: string,
  requested: number,
  work: (permits: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | BudgetAdmissionFailed, R> =>
  Effect.gen(function* () {
    const configured = yield* Effect.serviceOption(CpuWork);
    if (Option.isSome(configured) && configured.value.inherited)
      return yield* work(Math.min(requested, configured.value.permits ?? 1));
    const budget = Option.isSome(configured)
      ? configured.value.budget
      : yield* jobBudget;
    const priority = Option.isSome(configured)
      ? configured.value.priority
      : ({ class: "interactive", position: "new", stage: 0 } as const);
    return yield* withCpuEffect(
      budget,
      { owner, priority, permits: requested },
      (permits) =>
        work(permits).pipe(
          Effect.provideService(CpuWork, {
            budget,
            priority,
            inherited: true,
            permits,
          }),
        ),
      Option.isSome(configured) ? configured.value.onYield : undefined,
    );
  });

/** A pool that can claim keys admits CPU only inside its individual compute callbacks. */
export const cpuKeyedPool = <A, E, R>(
  owner: string,
  requested: number,
  work: (permits: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const configured = yield* Effect.serviceOption(CpuWork);
    if (Option.isSome(configured) && configured.value.inherited)
      return yield* work(Math.min(requested, configured.value.permits ?? 1));
    const budget = Option.isSome(configured)
      ? configured.value.budget
      : yield* jobBudget;
    const priority = Option.isSome(configured)
      ? configured.value.priority
      : ({ class: "interactive", position: "new", stage: 0 } as const);
    const capacity = yield* Effect.promise(() => budget.capacity());
    const limit =
      priority.class === "interactive"
        ? Math.max(1, Math.ceil((capacity.threads ?? 1) / 2))
        : (capacity.backgroundCap ?? 1);
    return yield* work(Math.min(requested, limit)).pipe(
      Effect.provideService(CpuWork, {
        budget,
        priority,
        inherited: false,
        owner,
        ...(Option.isSome(configured) && configured.value.onYield
          ? { onYield: configured.value.onYield }
          : {}),
      }),
    );
  });

/** Batch already-owned synchronous work; collecting key claims never holds a CPU grant. */
export const cpuBatch = <Input, Output>(
  owner: string,
  compute: (input: Input) => Output,
) =>
  Effect.gen(function* () {
    const configured = yield* Effect.serviceOption(CpuWork);
    if (Option.isSome(configured) && configured.value.inherited)
      return (input: Input) => Effect.sync(() => compute(input));
    const context = yield* Effect.context<never>();
    type Task = {
      readonly signal: AbortSignal;
      readonly compute: () => Output;
      readonly succeed: (value: Output) => void;
      readonly fail: (cause: Cause.Cause<BudgetAdmissionFailed>) => void;
      cancelBatch?: () => void;
    };
    const pending = new Set<Task>();
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const tasks = [...pending];
      pending.clear();
      if (!tasks.length) return;
      const controller = new AbortController();
      const cancel = () => {
        if (tasks.every((task) => task.signal.aborted)) controller.abort();
      };
      for (const task of tasks) task.cancelBatch = cancel;
      void Effect.runPromiseExitWith(context)(
        cpuWork(
          owner,
          Effect.sync(() => {
            const completed: Array<{ task: Task; value: Output }> = [];
            const started = performance.now();
            let consumed = 0;
            for (const task of tasks) {
              consumed++;
              if (task.signal.aborted) continue;
              completed.push({ task, value: task.compute() });
              if (completed.length >= 32 || performance.now() - started >= 50)
                break;
            }
            return { completed, remaining: tasks.slice(consumed) };
          }),
        ),
        { signal: controller.signal },
      ).then((exit) => {
        for (const task of tasks) delete task.cancelBatch;
        if (Exit.isFailure(exit)) {
          for (const task of tasks) task.fail(exit.cause);
        } else {
          // Wake computations only after this batch's grant has been released.
          for (const { task, value } of exit.value.completed)
            task.succeed(value);
          for (const task of exit.value.remaining)
            if (!task.signal.aborted) pending.add(task);
          if (pending.size && !scheduled) {
            scheduled = true;
            setImmediate(flush);
          }
        }
      });
    };
    return (input: Input): Effect.Effect<Output, BudgetAdmissionFailed> =>
      Effect.callback((resume, signal) => {
        const task: Task = {
          signal,
          compute: () => compute(input),
          succeed: (value) => resume(Effect.succeed(value)),
          fail: (cause) => resume(Effect.failCause(cause)),
        };
        pending.add(task);
        if (!scheduled) {
          scheduled = true;
          setImmediate(flush);
        }
        return Effect.sync(() => {
          pending.delete(task);
          task.cancelBatch?.();
        });
      });
  });

/** Bind a job's class once. Tests and inherited children may already supply the service. */
export const cpuJob = <A, E, R>(
  priority: Priority,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(CpuWork))) return yield* work;
    const budget = yield* jobBudget;
    const inherited =
      process.env.NEUVE_CPU_GRANT_PERMITS === undefined
        ? undefined
        : z.coerce
            .number()
            .int()
            .min(1)
            .max(1024)
            .parse(process.env.NEUVE_CPU_GRANT_PERMITS);
    const floor = process.env.NEUVE_BUDGET_FLOOR === "1";
    if (inherited !== undefined && !fstatSync(3).isSocket())
      throw new Error(
        "Inherited CPU grant requires its budget socket at descriptor 3",
      );
    return yield* work.pipe(
      Effect.provideService(CpuWork, {
        budget,
        priority,
        inherited: floor || inherited !== undefined,
        ...(floor
          ? { permits: 1 }
          : inherited === undefined
            ? {}
            : { permits: inherited }),
      }),
    );
  });

export const cpuConcurrency = (requested: number) =>
  Effect.gen(function* () {
    const configured = yield* Effect.serviceOption(CpuWork);
    return Option.isSome(configured) && configured.value.inherited
      ? Math.min(requested, configured.value.permits ?? 1)
      : requested;
  });
