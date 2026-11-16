// Why: a model step must be one run per key (record 0016). Each case says what it guards:
// 1. Two callers with one key, in two processes with their own store connections: exactly one
//    enters `compute`; the other gets its stored output and never enters. The duplicate model call
//    is the defect this module fixes.
// 2. The holder fails: the waiter receives the recorded failure with its tag, and its next `begin`
//    makes it the holder. A failure is shared, and a retry claims again.
// 3. The holder's process dies without settling: a waiter takes over. When the first caller begins
//    again later, it waits for the taker or gets its stored output, and never runs beside it. That
//    is takeover, and a resumed run must subscribe.
// 4. A waiter whose signal aborts stops waiting and leaves the holder's run untouched, across
//    processes and inside one. A run's cut-off must not cancel another run's work. And a holder's
//    own abort releases its claim, recorded, so its waiters are never left waiting.
// 5. `holds` is false until `compute` is entered: while waiting, after a shared failure, and when
//    the output was already stored. The table must never claim what the host did not grant.
// 6. The dispatch gate: a step's requests (`admitted`) and its phase (`granted`) go on only once
//    it holds. When its `begin` answers stored or failed, the phase is refused as an abort, and a
//    request keeps waiting until its own signal ends it (pi sends a request whose hook throws). A
//    resumed conversation must not run beside another holder.
// 7. A released claim (cut off, stopped, or held to resume) makes a waiter's next `begin` hold,
//    and its requests keep waiting meanwhile. Giving a claim up is no verdict on the work, so it
//    must not fail the waiter.
// 8. Retryability round-trips: a waiter gets the holder's own retryability, retryable and not,
//    whatever the tag. A waiter must not stop on a failure its holder would retry, nor retry one
//    it would stop on.
// 9. A `begin` with an aborted signal on a task that holds rejects and leaves the claim held. An
//    aborted caller must change nothing.
// 10. Inside one process, a first caller that stopped waiting releases when the key is later
//    granted to its `compute` by takeover, and the process's other subscriber then claims. A
//    stopped caller's leftover `compute` must not fail another caller.
//
// The store and the claim host are real: a Records store on disk and a budget host on its own
// socket in a directory under TMPDIR. The second process is this file, run as a child.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Exit, Layer, Logger, References, Scope } from "effect";
import { z } from "zod";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import { hostBudget } from "../src/budget/local.ts";
import {
  INTERRUPTED,
  stepClaims,
  type ClaimAnswer,
  type ClaimRunner,
} from "../src/pi/stages/step-claim.ts";

const CHILD = "NEUVE_STEP_CLAIM_CHILD";

const RoleLine = z.object({
  type: z.literal("shared-work.role"),
  role: z.string(),
});

/** The Records services one process opens over the store, as a worker's `ctx.records` holds them. */
const openRecords = (location: StoreLocation, scope: Scope.Closeable) =>
  Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: false })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );

/** The step's runner over those services; the store's role events go to `onRole`. */
const runnerOf =
  (
    records: Awaited<ReturnType<typeof openRecords>>,
    onRole: (role: string) => void = () => {},
  ): ClaimRunner =>
  (effect, signal) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(records),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              for (const item of [message].flat()) {
                const line = RoleLine.safeParse(item);
                if (line.success) onRole(line.data.role);
              }
            }),
          ]),
        ),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
      { signal },
    );

const output = (value: string) => ({
  bytes: new TextEncoder().encode(value),
  mediaType: "text/plain",
  model: "test-model",
});
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const Command = z.discriminatedUnion("op", [
  z.object({ op: z.literal("begin"), task: z.number() }),
  z.object({ op: z.literal("holds"), task: z.number() }),
  z.object({ op: z.literal("abort"), task: z.number() }),
  z.object({ op: z.literal("settle"), task: z.number(), value: z.string() }),
  z.object({
    op: z.literal("fail"),
    task: z.number(),
    tag: z.string(),
    message: z.string(),
    retryable: z.boolean().default(false),
    released: z.boolean().optional(),
  }),
]);
type Command = z.input<typeof Command>;

const Event = z.object({
  event: z.string(),
  task: z.number().optional(),
  kind: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  value: z.union([z.string(), z.boolean()]).optional(),
  tag: z.string().optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
});
type Event = z.infer<typeof Event>;

const answerEvent = (task: number, answer: ClaimAnswer) => ({
  event: "answer",
  task,
  kind: answer.kind,
  ...(answer.kind === "stored"
    ? { status: answer.result.status, value: text(answer.result.output) }
    : {}),
  ...(answer.kind === "failed"
    ? { tag: answer.tag, message: answer.message, retryable: answer.retryable }
    : {}),
  ...(answer.kind === "released"
    ? { tag: answer.tag, message: answer.message }
    : {}),
});

/** The second process: its own store connection and claims, driven by commands on stdin. */
async function child(config: {
  readonly location: string;
  readonly spec: Computations.ComputationSpec;
}) {
  const emit = (event: object) => console.info(JSON.stringify(event));
  const scope = await Effect.runPromise(Scope.make());
  const records = await openRecords(storeLocationIn(config.location), scope);
  const claims = stepClaims(
    runnerOf(records, (role) => emit({ event: "role", role })),
  );
  const signals = new Map<number, AbortController>();
  const failure = (error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  });
  const run = (input: Command) => {
    const command = Command.parse(input);
    switch (command.op) {
      case "begin": {
        const controller = new AbortController();
        signals.set(command.task, controller);
        claims.begin(command.task, config.spec, controller.signal).then(
          (answer) => emit(answerEvent(command.task, answer)),
          (error: unknown) =>
            emit({ event: "rejected", task: command.task, ...failure(error) }),
        );
        return;
      }
      case "holds":
        return emit({
          event: "holds",
          task: command.task,
          value: claims.holds(command.task),
        });
      case "abort":
        return signals.get(command.task)?.abort(new Error("caller stopped"));
      case "settle":
        claims.settle(command.task, output(command.value)).then(
          (result) =>
            emit({
              event: "settled",
              task: command.task,
              status: result.status,
              value: text(result.output),
            }),
          (error: unknown) =>
            emit({ event: "error", task: command.task, ...failure(error) }),
        );
        return;
      case "fail":
        claims.fail(command.task, command).then(
          () => emit({ event: "ended", task: command.task }),
          (error: unknown) =>
            emit({ event: "error", task: command.task, ...failure(error) }),
        );
        return;
    }
  };
  emit({ event: "ready" });
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      run(JSON.parse(line));
    }
  }
}

async function setup(name: string) {
  const root = mkdtempSync(join(tmpdir(), "step-claim-"));
  const directory = join(root, "budget");
  mkdirSync(directory, { mode: 0o700 });
  const git = join(root, "git");
  mkdirSync(git);
  const location = storeLocationIn(git);
  await Effect.runPromise(
    Store.prepareForWrite.pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  // This process's store transport finds the host through the variable, as a worker's does.
  const previous = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = directory;
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) throw new Error("budget host missing");
  await host.claims.ready;
  const spec: Computations.ComputationSpec = {
    op: "test.step-claim",
    opVersion: 1,
    inputs: { case: name },
  };
  const scope = await Effect.runPromise(Scope.make());
  const records = await openRecords(location, scope);
  const children: Array<{ readonly stop: () => Promise<void> }> = [];

  const spawn = () => {
    const events: Event[] = [];
    const listeners = new Set<() => void>();
    const process_ = Bun.spawn(
      [process.execPath, "--no-env-file", import.meta.path],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: root,
          TMPDIR: root,
          NEUVE_BUDGET_DIRECTORY: directory,
          [CHILD]: JSON.stringify({ location: git, spec }),
        },
      },
    );
    const reading = (async () => {
      let buffer = "";
      for await (const chunk of process_.stdout) {
        buffer += new TextDecoder().decode(chunk);
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const parsed = Event.safeParse(JSON.parse(line));
            if (parsed.success) events.push(parsed.data);
          } catch {}
          for (const listener of listeners) listener();
        }
      }
    })();
    const wait = (predicate: (event: Event) => boolean) =>
      new Promise<Event>((resolve, reject) => {
        const inspect = () => {
          const found = events.find(predicate);
          if (found) {
            listeners.delete(inspect);
            resolve(found);
          }
        };
        listeners.add(inspect);
        inspect();
        void process_.exited.then(async (code) => {
          await reading;
          if (listeners.delete(inspect))
            reject(
              new Error(
                `child exited ${code}; events ${JSON.stringify(events)}; ${await new Response(process_.stderr).text()}`,
              ),
            );
        });
      });
    const handle = {
      events,
      wait,
      ready: wait((event) => event.event === "ready"),
      role: (role: string) =>
        wait((event) => event.event === "role" && event.role === role),
      answer: (task = 1) =>
        wait((event) => event.event === "answer" && event.task === task),
      answered: (task = 1) =>
        events.some((event) => event.event === "answer" && event.task === task),
      send: (command: Command) => {
        process_.stdin.write(`${JSON.stringify(command)}\n`);
        process_.stdin.flush();
      },
      holds: async (task = 1) => {
        const before = events.length;
        handle.send({ op: "holds", task });
        return (
          await wait(
            (event) =>
              event.event === "holds" &&
              event.task === task &&
              events.indexOf(event) >= before,
          )
        ).value;
      },
      stop: async () => {
        process_.kill("SIGKILL");
        await process_.exited;
        await reading;
      },
    };
    children.push(handle);
    return handle;
  };

  const attempts = (of = spec) => {
    const database = new Database(location.database);
    database.run("PRAGMA busy_timeout = 5000");
    try {
      return database
        .query(
          "SELECT outcome, error_tag AS tag FROM computation_attempts WHERE key = ? ORDER BY n",
        )
        .all(Computations.computationKey(of).key);
    } finally {
      database.close();
    }
  };

  return {
    spec,
    records,
    spawn,
    attempts,
    close: async () => {
      await Promise.all(children.map((next) => next.stop()));
      // Every claim a case opened in this process has ended, so the store's finalizer returns.
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await host.close();
      if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
      else process.env.NEUVE_BUDGET_DIRECTORY = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A promise's state as it settles, read without awaiting it. */
const observe = (promise: Promise<unknown>) => {
  const seen: { state: "pending" | "resolved" | "rejected"; reason?: unknown } =
    { state: "pending" };
  promise.then(
    () => {
      seen.state = "resolved";
    },
    (reason: unknown) => {
      seen.state = "rejected";
      seen.reason = reason;
    },
  );
  return seen;
};
/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Resolves when `role` is reported, for a caller in this process. */
const roles = () => {
  const seen: string[] = [];
  const listeners = new Set<() => void>();
  return {
    onRole: (role: string) => {
      seen.push(role);
      for (const listener of listeners) listener();
    },
    reached: (role: string) =>
      new Promise<void>((resolve) => {
        const inspect = () => {
          if (seen.includes(role)) {
            listeners.delete(inspect);
            resolve();
          }
        };
        listeners.add(inspect);
        inspect();
      }),
  };
};

const tests = () => {
  test("two processes with one key: exactly one enters compute, the other gets its stored output", async () => {
    const s = await setup("one-run");
    try {
      const a = s.spawn();
      const b = s.spawn();
      await Promise.all([a.ready, b.ready]);
      a.send({ op: "begin", task: 1 });
      b.send({ op: "begin", task: 1 });
      const [holder, waiter] = await Promise.race([
        a.answer().then(() => [a, b] as const),
        b.answer().then(() => [b, a] as const),
      ]);
      expect((await holder.answer()).kind).toBe("holder");
      await waiter.role("waiter");
      expect(waiter.answered()).toBe(false);
      expect(await holder.holds()).toBe(true);
      expect(await waiter.holds()).toBe(false);
      expect(s.attempts()).toEqual([{ outcome: "running", tag: null }]);
      holder.send({ op: "settle", task: 1, value: "from the holder" });
      const settled = await holder.wait((event) => event.event === "settled");
      expect(settled).toMatchObject({
        status: "computed",
        value: "from the holder",
      });
      expect(await waiter.answer()).toMatchObject({
        kind: "stored",
        status: "shared",
        value: "from the holder",
      });
      expect(await waiter.holds()).toBe(false);
      // One attempt: the waiter's process never entered compute.
      expect(s.attempts()).toEqual([{ outcome: "succeeded", tag: null }]);
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a holder's failure reaches its waiter with its tag, and the waiter's next begin holds", async () => {
    const s = await setup("shared-failure");
    try {
      const a = s.spawn();
      const b = s.spawn();
      await Promise.all([a.ready, b.ready]);
      a.send({ op: "begin", task: 1 });
      expect((await a.answer()).kind).toBe("holder");
      b.send({ op: "begin", task: 1 });
      await b.role("waiter");
      a.send({
        op: "fail",
        task: 1,
        tag: "RateLimitError",
        message: "the provider's limit was reached",
        retryable: true,
      });
      await a.wait((event) => event.event === "ended");
      expect(await b.answer()).toMatchObject({
        kind: "failed",
        tag: "RateLimitError",
        message: "the provider's limit was reached",
        retryable: true,
      });
      expect(await a.holds()).toBe(false);
      expect(await b.holds()).toBe(false);
      const before = b.events.length;
      b.send({ op: "begin", task: 1 });
      const retried = await b.wait(
        (event) =>
          event.event === "answer" && b.events.indexOf(event) >= before,
      );
      expect(retried.kind).toBe("holder");
      expect(s.attempts()).toEqual([
        { outcome: "failed", tag: "RateLimitError" },
        { outcome: "running", tag: null },
      ]);
      b.send({ op: "settle", task: 1, value: "on retry" });
      expect(await b.wait((event) => event.event === "settled")).toMatchObject({
        status: "computed",
        value: "on retry",
      });
      expect(s.attempts()).toEqual([
        { outcome: "failed", tag: "RateLimitError" },
        { outcome: "succeeded", tag: null },
      ]);
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a dead holder's waiter takes over, and the first caller's resumed begin subscribes to it", async () => {
    const s = await setup("takeover");
    try {
      const a = s.spawn();
      const b = s.spawn();
      await Promise.all([a.ready, b.ready]);
      a.send({ op: "begin", task: 1 });
      expect((await a.answer()).kind).toBe("holder");
      b.send({ op: "begin", task: 1 });
      await b.role("waiter");
      // The holder's process dies mid-conversation: its connection, and so its claim, ends.
      await a.stop();
      expect((await b.answer()).kind).toBe("holder");
      await b.role("takeover");
      expect(s.attempts()).toEqual([
        { outcome: "abandoned", tag: "Abandoned" },
        { outcome: "running", tag: null },
      ]);
      // The first caller's run resumes in a new process and begins again.
      const resumed = s.spawn();
      await resumed.ready;
      resumed.send({ op: "begin", task: 1 });
      await resumed.role("waiter");
      expect(resumed.answered()).toBe(false);
      expect(await resumed.holds()).toBe(false);
      b.send({ op: "settle", task: 1, value: "from the taker" });
      expect(await b.wait((event) => event.event === "settled")).toMatchObject({
        status: "computed",
        value: "from the taker",
      });
      expect(await resumed.answer()).toMatchObject({
        kind: "stored",
        status: "shared",
        value: "from the taker",
      });
      // Begun later still, it finds the stored output without claiming.
      const later = s.spawn();
      await later.ready;
      later.send({ op: "begin", task: 1 });
      expect(await later.answer()).toMatchObject({
        kind: "stored",
        status: "reused",
        value: "from the taker",
      });
      expect(s.attempts()).toEqual([
        { outcome: "abandoned", tag: "Abandoned" },
        { outcome: "succeeded", tag: null },
      ]);
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a waiter's abort leaves the holder's run untouched; a holder's abort records its failure", async () => {
    const s = await setup("abort");
    try {
      // Across processes.
      const a = s.spawn();
      const b = s.spawn();
      await Promise.all([a.ready, b.ready]);
      a.send({ op: "begin", task: 1 });
      expect((await a.answer()).kind).toBe("holder");
      b.send({ op: "begin", task: 1 });
      await b.role("waiter");
      b.send({ op: "abort", task: 1 });
      expect(await b.wait((event) => event.event === "rejected")).toMatchObject(
        { message: "caller stopped" },
      );
      expect(await b.holds()).toBe(false);
      expect(await a.holds()).toBe(true);
      expect(s.attempts()).toEqual([{ outcome: "running", tag: null }]);
      a.send({ op: "settle", task: 1, value: "kept" });
      expect(await a.wait((event) => event.event === "settled")).toMatchObject({
        status: "computed",
        value: "kept",
      });
      expect(s.attempts()).toEqual([{ outcome: "succeeded", tag: null }]);

      // Inside one process: two step definitions (two runs' harnesses) share the process's claim.
      const local = { ...s.spec, inputs: { case: "abort-in-process" } };
      const first = stepClaims(runnerOf(s.records));
      const seen = roles();
      const second = stepClaims(runnerOf(s.records, seen.onRole));
      expect(
        (await first.begin(1, local, new AbortController().signal)).kind,
      ).toBe("holder");
      const stop = new AbortController();
      const waiting = second.begin(1, local, stop.signal);
      await seen.reached("waiter");
      stop.abort(new Error("cut off"));
      await expect(waiting).rejects.toThrow("cut off");
      expect(second.holds(1)).toBe(false);
      expect(first.holds(1)).toBe(true);
      const kept = await first.settle(1, output("kept in process"));
      expect(kept.status).toBe("computed");
      expect(text(kept.output)).toBe("kept in process");
      expect(s.attempts(local)).toEqual([{ outcome: "succeeded", tag: null }]);

      // A holder whose own signal aborts releases its claim: no verdict, so its waiter claims again.
      const interrupted = { ...s.spec, inputs: { case: "holder-abort" } };
      const owner = new AbortController();
      const holder = stepClaims(runnerOf(s.records));
      const watched = roles();
      const subscriber = stepClaims(runnerOf(s.records, watched.onRole));
      expect((await holder.begin(1, interrupted, owner.signal)).kind).toBe(
        "holder",
      );
      const subscribed = subscriber.begin(
        1,
        interrupted,
        new AbortController().signal,
      );
      await watched.reached("waiter");
      owner.abort(new Error("the holder's run was stopped"));
      expect(await subscribed).toMatchObject({
        kind: "released",
        tag: INTERRUPTED,
      });
      expect(holder.holds(1)).toBe(false);
      expect(s.attempts(interrupted)).toEqual([
        { outcome: "failed", tag: INTERRUPTED },
      ]);
      // Nothing is left open: the next begin claims the key.
      expect(
        (await subscriber.begin(1, interrupted, new AbortController().signal))
          .kind,
      ).toBe("holder");
      await subscriber.fail(1, {
        tag: "Cleanup",
        message: "case over",
        retryable: false,
      });
    } finally {
      await s.close();
    }
  }, 60_000);

  test("holds is false until compute is entered", async () => {
    const s = await setup("holds");
    try {
      const first = stepClaims(runnerOf(s.records));
      const seen = roles();
      const second = stepClaims(runnerOf(s.records, seen.onRole));
      expect(first.holds(1)).toBe(false);
      expect(
        (await first.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      expect(first.holds(1)).toBe(true);
      expect(second.holds(1)).toBe(false);
      const waiting = second.begin(1, s.spec, new AbortController().signal);
      await seen.reached("waiter");
      // Waiting on another caller's run is not holding.
      expect(second.holds(1)).toBe(false);
      await first.fail(1, {
        tag: "ToolsDiffer",
        message: "tools changed",
        retryable: false,
      });
      expect(first.holds(1)).toBe(false);
      expect(await waiting).toMatchObject({
        kind: "failed",
        tag: "ToolsDiffer",
        retryable: false,
      });
      expect(second.holds(1)).toBe(false);
      expect(
        (await second.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      expect(second.holds(1)).toBe(true);
      // A held task answers holder again at once, without a second claim.
      expect(
        (await second.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      expect((await second.settle(1, output("stored"))).status).toBe(
        "computed",
      );
      expect(second.holds(1)).toBe(false);
      // A stored output answers without entering compute, so nothing is held.
      const third = stepClaims(runnerOf(s.records));
      const stored = await third.begin(1, s.spec, new AbortController().signal);
      expect(stored.kind).toBe("stored");
      expect(third.holds(1)).toBe(false);
      await expect(third.settle(1, output("never"))).rejects.toThrow(
        "holds no claim",
      );
      expect(s.attempts()).toEqual([
        { outcome: "failed", tag: "ToolsDiffer" },
        { outcome: "succeeded", tag: null },
      ]);
    } finally {
      await s.close();
    }
  }, 60_000);

  test("the dispatch gate lets a step's requests out only while it holds", async () => {
    const s = await setup("gate");
    try {
      const holder = stepClaims(runnerOf(s.records));
      const seen = roles();
      const waiter = stepClaims(runnerOf(s.records, seen.onRole));
      // A request and a phase that ask before the step claims wait; the grant lets both out.
      const early = observe(holder.admitted(1, undefined));
      const grant = observe(holder.granted(1, new AbortController().signal));
      await settle();
      expect([early.state, grant.state]).toEqual(["pending", "pending"]);
      expect(
        (await holder.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      await settle();
      expect([early.state, grant.state]).toEqual(["resolved", "resolved"]);
      await expect(holder.admitted(1, undefined)).resolves.toBeUndefined();
      // A step waiting behind another holder lets nothing out. When it is answered, the phase's
      // grant is refused as an abort; a request still waits, until its own signal ends it.
      const stop = new AbortController();
      const blocked = observe(waiter.admitted(1, stop.signal));
      const waited = observe(waiter.granted(1, new AbortController().signal));
      const answer = waiter.begin(1, s.spec, new AbortController().signal);
      await seen.reached("waiter");
      await settle();
      expect([blocked.state, waited.state]).toEqual(["pending", "pending"]);
      await holder.settle(1, output("from the holder"));
      expect((await answer).kind).toBe("stored");
      await settle();
      expect([blocked.state, waited.state]).toEqual(["pending", "rejected"]);
      expect((waited.reason as DOMException).name).toBe("AbortError");
      stop.abort(new Error("conversation aborted"));
      await settle();
      expect(blocked.state).toBe("rejected");
      // Once the holder's claim ended, the gate is shut again.
      const late = observe(holder.granted(1, new AbortController().signal));
      const request = new AbortController();
      const lateRequest = observe(holder.admitted(1, request.signal));
      await settle();
      expect([late.state, lateRequest.state]).toEqual(["pending", "pending"]);
      request.abort(new Error("generation stopped"));
      await settle();
      expect(lateRequest.state).toBe("rejected");
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a released claim makes the waiter's next begin hold, its requests still waiting", async () => {
    const s = await setup("released");
    try {
      const holder = stepClaims(runnerOf(s.records));
      const seen = roles();
      const waiter = stepClaims(runnerOf(s.records, seen.onRole));
      expect(
        (await holder.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      const request = observe(waiter.admitted(1, undefined));
      const answer = waiter.begin(1, s.spec, new AbortController().signal);
      await seen.reached("waiter");
      await holder.fail(1, {
        tag: "ModelError",
        message: "held for the provider: model_error",
        retryable: true,
        released: true,
      });
      expect(await answer).toEqual({
        kind: "released",
        tag: "ModelError",
        message: "held for the provider: model_error",
      });
      await settle();
      expect(request.state).toBe("pending");
      expect(
        (await waiter.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      await settle();
      expect(request.state).toBe("resolved");
      expect((await waiter.settle(1, output("after release"))).status).toBe(
        "computed",
      );
      expect(s.attempts()).toEqual([
        { outcome: "failed", tag: "ModelError" },
        { outcome: "succeeded", tag: null },
      ]);
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a waiter gets the holder's own retryability, whatever the tag", async () => {
    const s = await setup("retryability");
    try {
      for (const [tag, retryable] of [
        ["ModelError", true],
        ["TurnFailed", true],
        ["QuotaExhaustedError", false],
        ["RateLimitError", false],
      ] as const) {
        const spec = { ...s.spec, inputs: { case: `retryable-${tag}` } };
        const holder = stepClaims(runnerOf(s.records));
        const seen = roles();
        const waiter = stepClaims(runnerOf(s.records, seen.onRole));
        expect(
          (await holder.begin(1, spec, new AbortController().signal)).kind,
        ).toBe("holder");
        const answer = waiter.begin(1, spec, new AbortController().signal);
        await seen.reached("waiter");
        await holder.fail(1, { tag, message: `${tag} recorded`, retryable });
        expect(await answer).toEqual({
          kind: "failed",
          tag,
          message: `${tag} recorded`,
          retryable,
        });
      }
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a begin with an aborted signal on a held task rejects and leaves the claim held", async () => {
    const s = await setup("aborted-begin");
    try {
      const claims = stepClaims(runnerOf(s.records));
      expect(
        (await claims.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      const stopped = new AbortController();
      stopped.abort(new Error("already stopped"));
      await expect(claims.begin(1, s.spec, stopped.signal)).rejects.toThrow(
        "already stopped",
      );
      expect(claims.holds(1)).toBe(true);
      expect(s.attempts()).toEqual([{ outcome: "running", tag: null }]);
      expect((await claims.settle(1, output("still held"))).status).toBe(
        "computed",
      );
    } finally {
      await s.close();
    }
  }, 60_000);

  test("a stopped first caller's compute, granted by takeover, releases to the process's other subscriber", async () => {
    const s = await setup("leftover-compute");
    try {
      const other = s.spawn();
      await other.ready;
      other.send({ op: "begin", task: 1 });
      expect((await other.answer()).kind).toBe("holder");
      const firstRoles = roles();
      const first = stepClaims(runnerOf(s.records, firstRoles.onRole));
      const secondRoles = roles();
      const second = stepClaims(runnerOf(s.records, secondRoles.onRole));
      const stop = new AbortController();
      const stopped = first.begin(1, s.spec, stop.signal);
      await firstRoles.reached("waiter");
      const answer = second.begin(1, s.spec, new AbortController().signal);
      await secondRoles.reached("waiter");
      stop.abort(new Error("first caller stopped"));
      await expect(stopped).rejects.toThrow("first caller stopped");
      // The holder's process dies; the host grants the key to this process's connection.
      await other.stop();
      expect(await answer).toMatchObject({
        kind: "released",
        tag: INTERRUPTED,
      });
      expect(first.holds(1)).toBe(false);
      expect(
        (await second.begin(1, s.spec, new AbortController().signal)).kind,
      ).toBe("holder");
      expect(s.attempts()).toEqual([
        { outcome: "abandoned", tag: "Abandoned" },
        { outcome: "failed", tag: INTERRUPTED },
        { outcome: "running", tag: null },
      ]);
      await second.settle(1, output("by the second subscriber"));
    } finally {
      await s.close();
    }
  }, 60_000);
};

const childConfig = process.env[CHILD];
if (childConfig === undefined) tests();
else
  await child(
    z
      .object({ location: z.string(), spec: Computations.ComputationSpec })
      .parse(JSON.parse(childConfig)),
  );
