// Why: the queue must never send another request after a runtime has exhausted its own retries.
import { expect, spyOn, test } from "bun:test";
import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import {
  ContractContextDoc,
  ContractPartialsDoc,
} from "../src/pi/stages/docs.ts";
import { ContractState } from "../src/pi/stages/contract-state.ts";
import { readData } from "@neuve/records-core";
import { RunControlDoc } from "../src/pi/control.ts";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Clock,
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
} from "effect";
import { JOB_POLICIES, JobQueue, Log, Worker } from "@neuve/records-core";
import type { SignInState } from "@neuve/runtime/status";
import {
  AccountDirectory,
  AccountName,
  AccountStore,
  RuntimeRegistry,
  runtimeRegistryLayer,
} from "@neuve/runtime";
import {
  fakeRuntime as storeRuntime,
  provideRegistry,
  recordFile,
  scratch,
} from "../../runtime/tests/store/fixtures.ts";
import { piStatusRuntime } from "../src/pi/status-runtime.ts";
import { OPUS_ROUTE } from "../src/route.ts";
import * as settings from "../src/settings.ts";
import { admitReview, reviewRunHandler } from "../src/handler.ts";
import { requestReview } from "../src/request.ts";
import { openRunLog } from "../src/run-log.ts";
import { piDatabase, runFolder } from "../src/run-folder.ts";
import * as runtimes from "../src/runtimes.ts";
import * as integrations from "../src/integrations.ts";
import * as hosts from "../src/pi/host.ts";
import {
  fakeRuntime,
  route,
  probe,
  type Script,
} from "./pi/stages/contract-fixture.ts";
import { routeReadiness } from "../src/route-provider.ts";
import { world } from "./pi/stages/fixture.ts";
import { reviewRepository } from "./fixtures/review-repository.ts";

const signInHint = { kind: "settings", entry: "accounts" } as const;
const FutureControlDoc = defineDoc<{
  resumeNonce: string | null;
  held: Record<string, z.infer<ReturnType<typeof z.json>>>;
}>({
  kind: "neuve.run-control",
  version: 1,
  scope: "session",
  initial: () => ({ resumeNonce: null, held: {} }),
});
const scenarios = [
  ...[
    "during-turn",
    "before-admission",
    "attempt-open",
    "stage-open",
    "first-continuation",
  ].map((refusedAccount) => ({
    name: `refused account ${refusedAccount}`,
    refusedAccount,
    internalRetries: true,
    failure: {
      _tag: "TurnFailed" as const,
      account: route.account.name,
      reason: "provider-failed" as const,
    },
    signIn: { state: "signed-in" as const },
  })),
  {
    name: "refused account during sign-in hold",
    refusedAccount: "during-turn",
    internalRetries: true,
    failure: {
      _tag: "SignInRequired",
      account: route.account.name,
      hint: signInHint,
    },
    signIn: { state: "not-signed-in", hint: signInHint },
  },
  {
    name: "a refused active write",
    writeRefusal: true,
    internalRetries: true,
    failure: {
      _tag: "TurnFailed",
      account: route.account.name,
      reason: "provider-failed",
    },
    signIn: { state: "signed-in" },
  },
  ...[
    "kind",
    "tag",
    "turn-reason",
    "runtime-reason",
    "malformed",
    "bad-account-future-reason",
    "malformed-write-refused",
    "malformed-recovery-kind",
    "valid-write-refused",
  ].map((future) => ({
    name: `future contract ${future}`,
    future,
    internalRetries: true,
    failure: {
      _tag: "TurnFailed" as const,
      account: route.account.name,
      reason: "provider-failed" as const,
    },
    signIn: { state: "signed-in" as const },
  })),
  ...[true, false].map((internalRetries) => ({
    name: `internalRetries=${internalRetries}`,
    internalRetries,
    failure: {
      _tag: "TurnFailed" as const,
      account: route.account.name,
      reason: "provider-failed" as const,
    },
    signIn: { state: "signed-in" as const },
  })),
  ...[true, false].map((internalRetries) => ({
    name: `runtime process start-failed internalRetries=${internalRetries}`,
    internalRetries,
    failure: {
      _tag: "RuntimeUnavailable" as const,
      account: route.account.name,
      reason: "start-failed" as const,
    },
    signIn: { state: "signed-in" as const },
  })),
  {
    name: "provider-failed followed by not-signed-in",
    internalRetries: true,
    failure: {
      _tag: "TurnFailed",
      account: route.account.name,
      reason: "provider-failed",
    },
    signIn: { state: "not-signed-in", hint: signInHint },
  },
  {
    name: "provider-unavailable followed by credential-rejected",
    internalRetries: true,
    failure: {
      _tag: "TurnFailed",
      account: route.account.name,
      reason: "provider-unavailable",
    },
    signIn: { state: "credential-rejected" },
  },
  {
    name: "sign-in hold followed by not-signed-in",
    internalRetries: true,
    failure: {
      _tag: "SignInRequired",
      account: route.account.name,
      hint: signInHint,
    },
    signIn: { state: "not-signed-in", hint: signInHint },
  },
] as const;

// The queue fixture changes one section and has no defect claim to check.
const reviewTools = [
  "submit_frame",
  "submit_map",
  "submit_assess",
  "submit_review",
  "submit_briefing",
];

const acceptedSubmission = (tool: string, prompt: string) => {
  switch (tool) {
    case "submit_frame":
      return {
        goal: "Review the value change",
        stratum: "nothing",
        sourceIds: [],
        doneWhen: [
          { text: "The value changes", candidateId: null, sectionId: null },
        ],
      };
    case "submit_map":
      return {
        groups: [
          {
            label: "Value change",
            why: "The value changes.",
            tier: "core",
            doneWhen: ["D1"],
            entries: ["f1"],
          },
        ],
      };
    case "submit_assess":
      return {
        factors: [],
        requirements: [],
        impact: [],
        classes: [
          { S: [1], c: "l", v: "e", F: [], R: [], person: null, gaps: null },
        ],
      };
    case "submit_review":
      return {
        files: [{ f: 1, checked: "Read the changed value.", rows: null }],
        sections: { a: [1], r: [], u: [] },
        comments: [],
        unsure: [],
        notAsked: [],
        crossBatchClaims: [],
      };
    case "submit_briefing": {
      const hunk = /hunks: (\S+) lines 1/.exec(prompt)?.[1];
      if (hunk === undefined)
        throw new Error("The briefing has no changed line");
      const text = `[The value rises to two](${hunk}@1).`;
      return {
        sections: [
          {
            n: 1,
            title: "Raise the value",
            briefed: text,
            explained: {
              before: "The value was one.",
              after: "The value is two.",
              terms: [],
              cites: [hunk],
            },
          },
        ],
        leads: [],
        digest: { digest: text, uncertainty: [], limitations: [] },
      };
    }
    default:
      throw new Error(`Unexpected submission ${tool}`);
  }
};

const runScenario = async (
  scenario: (typeof scenarios)[number],
  suffix = "",
  mode?: "after-close" | "held-race" | "fresh",
  folderAt?: "startup" | "after-open",
) => {
  const fresh = mode === "fresh";
  const recovery = fresh ? undefined : mode;
  const { internalRetries } = scenario;
  const writeRefusal = "writeRefusal" in scenario;
  const signInHold = scenario.failure._tag === "SignInRequired";
  const future = "future" in scenario ? scenario.future : undefined;
  const corrupt =
    future === "malformed" ||
    future === "bad-account-future-reason" ||
    future === "malformed-write-refused" ||
    future === "malformed-recovery-kind";
  const run = await world(`contract-queue-${scenario.name}${suffix}`);
  const repository = run.ctx.repository;
  reviewRepository(repository);
  const settingsSpy = spyOn(settings, "readSettings").mockReturnValue(
    Option.none(),
  );
  const refusedAccount =
    "refusedAccount" in scenario ? scenario.refusedAccount : undefined;
  const freshRefusal =
    refusedAccount === "attempt-open" ||
    refusedAccount === "stage-open" ||
    refusedAccount === "first-continuation";
  // Why: compatibility holds must survive more claims than would exhaust real failures.
  const claims =
    recovery !== undefined
      ? 1
      : refusedAccount !== undefined || signInHold
        ? JOB_POLICIES["review.run"].maxAttempts + 1
        : 1;
  const tempHome = scratch();
  let record: string | undefined;
  let readableBytes: string | undefined;
  let recovered = false;
  let continuationLookups = 0;
  let armedContinuationRefusal = false;
  let refusedBytes: string | undefined;
  const folder = AccountStore.neuveFolder(tempHome.home);
  const refusalMessage = `${folder} is writable by other users. Neuve needs it writable only by you.`;
  const repair = () => {
    if (folderAt !== undefined) chmodSync(folder, 0o755);
    else {
      if (record === undefined || readableBytes === undefined)
        throw new Error("No readable record");
      writeFileSync(record, readableBytes);
    }
    recovered = true;
  };
  const refuseAccount = () => {
    if (folderAt !== undefined) {
      chmodSync(folder, 0o775);
      return;
    }
    if (record === undefined) throw new Error("No account record");
    const raw = JSON.parse(readFileSync(record, "utf8"));
    raw.account.credential.kind = "future-folder";
    refusedBytes = JSON.stringify(raw);
    writeFileSync(record, refusedBytes);
  };
  let signIn: SignInState = { state: "signed-in" };
  let readinessReads = 0;
  let readsAtHold = 0;
  let savedHold: string | undefined;
  let activeHost: Awaited<ReturnType<typeof hosts.openReviewHost>> | undefined;
  let refusedTask: import("@earendil-works/pi-durable").TaskId | undefined;
  let unwatch = () => {};
  let savedContext: string | undefined;
  let savedPartials: string | undefined;
  const accept: Script = async (turn) => {
    const tool = turn.policy.tools.find((tool) =>
      tool.name.startsWith("submit_"),
    );
    if (tool === undefined) throw new Error("No submission tool");
    const input = acceptedSubmission(tool.name, turn.prompt);
    const call = {
      callId: `accepted-${turn.turnId}`,
      toolName: tool.name,
      input: z.json().parse(input),
    };
    await turn.message([call]);
    await turn.invoke(call, turn.signal);
  };
  const fake = fakeRuntime(
    fresh || recovery !== undefined
      ? reviewTools.map(() => accept)
      : [
          async (turn) => {
            if (writeRefusal) {
              const host = activeHost;
              if (host === undefined) throw new Error("No active host");
              const taskId = refusedTask;
              if (taskId === undefined) throw new Error("No agent task");
              await turn.send({
                type: "tool.started",
                turnId: turn.turnId,
                at: new Date().toISOString(),
                callId: "announced",
                toolName: "submit_frame",
                input: {},
              });
              const watch = await host.harness.watchDoc(
                ContractContextDoc,
                taskId,
                context,
              );
              if (watch === undefined) throw new Error("No context");
              try {
                await new Promise<void>((resolve) => {
                  const observe = (value: typeof watch.value) => {
                    if (
                      value?.data != null &&
                      readData(ContractState, value.data).rounds[0]?.announced
                        .announced !== undefined
                    )
                      resolve();
                  };
                  observe(watch.value);
                  watch.start(async (value) => observe(value));
                });
              } finally {
                await watch.stop();
              }
              await host.harness.commit(async (tx) => {
                const doc = await tx.doc(ContractContextDoc, taskId);
                const state = readData(ContractState, doc.data);
                const round = state.rounds[0];
                if (round === undefined) throw new Error("No round");
                doc.data = copyJson({
                  ...state,
                  rounds: [
                    {
                      ...round,
                      announced: {
                        announced: {
                          ...round.announced.announced,
                          futureAnnouncement: "keep-this",
                        },
                      },
                    },
                  ],
                });
                (await tx.doc(ContractPartialsDoc)).contexts.previous =
                  copyJson(state);
              }, context);
              savedContext = JSON.stringify(
                await host.harness.snapshot(
                  ContractContextDoc,
                  taskId,
                  context,
                ),
              );
              savedPartials = JSON.stringify(
                await host.harness.snapshot(ContractPartialsDoc, context),
              );
              await turn.message([
                { ...probe("announced", 1), toolName: "submit_frame" },
              ]);
              return;
            }
            if (refusedAccount === "during-turn") refuseAccount();
            signIn = scenario.signIn;
            return {
              status: "failed",
              disposition: "broken",
              failure: scenario.failure,
            };
          },
        ],
    false,
  );
  const fakeRegistry = {
    ...fake.registry,
    capabilities: (name: Parameters<typeof fake.registry.capabilities>[0]) =>
      fake.registry
        .capabilities(name)
        .pipe(Effect.map((caps) => ({ ...caps, internalRetries }))),
  };
  const registry =
    refusedAccount === undefined
      ? fakeRegistry
      : await Effect.runPromise(
          Effect.gen(function* () {
            const store = yield* AccountStore.make(tempHome.home);
            const account = yield* store.add("claude", route.account.name);
            record = recordFile(tempHome.home, account.name);
            readableBytes = readFileSync(record, "utf8");
            if (folderAt !== undefined) chmodSync(folder, 0o755);
            if (folderAt === "startup") refuseAccount();
            const directory =
              folderAt === "startup"
                ? // Built in the run's scope, as the worker keeps it for the process.
                  Context.get(
                    yield* Layer.build(
                      runtimes.workerRuntimeOptions(tempHome.home)
                        .accountDirectory,
                    ),
                    AccountDirectory,
                  )
                : store.directory;
            return yield* RuntimeRegistry.pipe(
              Effect.provide(
                provideRegistry({ ...store, directory }, [
                  {
                    kind: "claude-code",
                    capabilities: (account) =>
                      fakeRegistry.capabilities(account.name),
                    continuation: (account) =>
                      Effect.runSync(fakeRegistry.continuation(account.name)),
                    probe: (account) => fakeRegistry.probe(account.name),
                    signOut: (account) => fakeRegistry.signOut(account.name),
                    openSession: (account, policy, start) =>
                      fakeRegistry.openSession(account.name, policy, start),
                  },
                ]),
              ),
            );
          }).pipe(Effect.provideService(Scope.Scope, run.scope)),
        );
  const originalContinuation = registry.continuation;
  const runtimeRegistry = {
    ...registry,
    continuation: (name: Parameters<typeof registry.continuation>[0]) =>
      Effect.suspend(() => {
        if (armedContinuationRefusal) {
          continuationLookups++;
          if (continuationLookups === 2) refuseAccount();
        }
        return originalContinuation(name);
      }),
  };
  const registrySpy = spyOn(runtimes, "processRuntimes").mockResolvedValue(
    runtimeRegistry,
  );
  const statusesSpy = spyOn(
    runtimes,
    "processReadinessStatuses",
  ).mockReturnValue(
    Effect.succeed({
      scope: run.scope,
      service: {
        read: Effect.sync(() => {
          readinessReads++;
          return [
            {
              ...route.account,
              signIn,
              limits: [],
              checkedAt: new Date().toISOString(),
            },
          ];
        }),
        check: () => Effect.die("No probe should run"),
      },
    }),
  );
  const integrationSpy = spyOn(
    integrations,
    "readIntegrations",
  ).mockReturnValue({ status: "absent", path: "(fixture)" });
  const cleanup: Array<
    Parameters<Awaited<ReturnType<typeof hosts.openReviewHost>>["cleanup"]>[0]
  > = [];
  const openHost = hosts.openReviewHost;
  const hostSpy = spyOn(hosts, "openReviewHost").mockImplementation(
    async (...args) => {
      if (refusedAccount === "stage-open" && !recovered) refuseAccount();
      const host = await openHost(...args);
      activeHost = host;
      if (writeRefusal)
        unwatch = host.harness.subscribeCommits(({ changes }) => {
          for (const change of changes)
            if (
              change.type === "task" &&
              change.value.kind === "neuve.agent-step"
            )
              refusedTask = change.value.id;
        });
      return {
        ...host,
        ended: async (context) => {
          const end = await host.ended(context);
          if (writeRefusal && end.kind === "held") {
            readsAtHold = readinessReads;
            expect(end.steps).toContainEqual(
              expect.objectContaining({ writeRefused: true }),
            );
            return end;
          }
          if (refusedAccount !== undefined && end.kind === "held") {
            const held = JSON.stringify(
              (await host.harness.snapshot(RunControlDoc, context))?.held,
            );
            if (savedHold === undefined) savedHold = held;
            else expect(held).toBe(savedHold);
            for (const step of end.steps) {
              if (
                refusedAccount === "stage-open" ||
                refusedAccount === "first-continuation"
              ) {
                expect(step).toMatchObject({
                  engine: "contract",
                  failure: {
                    _tag:
                      folderAt === undefined
                        ? "AccountNeedsNewerBuild"
                        : "AccountStoreRefused",
                    account: route.account.name,
                  },
                  savedPhase: "open",
                  continuation: null,
                  native: null,
                });
              }
              const snapshot = await host.harness.snapshot(
                ContractContextDoc,
                step.taskId,
                context,
              );
              if (
                refusedAccount !== "stage-open" &&
                refusedAccount !== "first-continuation"
              ) {
                expect(snapshot?.data).toBeDefined();
                expect(snapshot?.data).not.toBeNull();
              }
            }
            readsAtHold = readinessReads;
            if (recovery === "held-race" && !recovered) {
              repair();
            }
          }
          if (future === undefined || end.kind !== "held") return end;
          // Seed the raw persisted value a newer build would leave, before the handler reads it.
          await host.harness.commit(async (tx) => {
            const doc = await tx.doc(FutureControlDoc);
            for (const step of end.steps) {
              const failure =
                future === "bad-account-future-reason"
                  ? { _tag: "TurnFailed", account: 17, reason: "future" }
                  : corrupt
                    ? { _tag: "AccountNotFound" }
                    : future === "tag"
                      ? { _tag: "FutureFailure", account: route.account.name }
                      : future === "turn-reason" || future === "runtime-reason"
                        ? {
                            _tag:
                              future === "turn-reason"
                                ? "TurnFailed"
                                : "RuntimeUnavailable",
                            account: route.account.name,
                            reason: "future-reason",
                          }
                        : step.failure;
              doc.held[String(step.taskId)] = z.json().parse({
                ...step,
                failure,
                ...(future === "malformed-write-refused" ||
                future === "valid-write-refused"
                  ? { writeRefused: true }
                  : {}),
                recovery: {
                  kind:
                    future === "kind" || future === "malformed-recovery-kind"
                      ? "explicit-person"
                      : "provider-policy",
                },
                futureHold: "keep",
              });
            }
            savedHold = JSON.stringify(doc.held);
          }, context);
          const control = await host.harness.snapshot(RunControlDoc, context);
          readsAtHold = readinessReads;
          return {
            kind: "held",
            steps: end.steps.map((step) => {
              const held = control?.held[String(step.taskId)];
              if (held === undefined) throw new Error("No saved future hold");
              return { ...held, taskId: step.taskId };
            }),
          };
        },
        cleanup: async (input, context) => {
          cleanup.push(input);
          if (writeRefusal) {
            if (
              refusedTask === undefined ||
              savedContext === undefined ||
              savedPartials === undefined
            )
              throw new Error("No refusal fixture");
            expect(
              JSON.stringify(
                await host.harness.snapshot(
                  ContractContextDoc,
                  refusedTask,
                  context,
                ),
              ),
            ).toBe(savedContext);
            expect(
              JSON.stringify(
                await host.harness.snapshot(ContractPartialsDoc, context),
              ),
            ).toBe(savedPartials);
            expect(
              (await host.harness.getTask(refusedTask, context))?.state.status,
            ).not.toBe("terminal");
          }
          if (
            future !== undefined ||
            (refusedAccount !== undefined && input.mode === "held")
          ) {
            if (savedHold === undefined)
              throw new Error("No saved future hold");
            const control = await host.harness.snapshot(RunControlDoc, context);
            expect(JSON.stringify(control?.held)).toBe(savedHold);
          }
          return host.cleanup(input, context);
        },
      };
    },
  );
  try {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* requestReview({
          location: run.ctx.location,
          repository,
          range: "HEAD^..HEAD",
          requester: { _tag: "Unresolved" },
          route,
          runtimes: folderAt === "startup" ? fakeRegistry : registry,
          search: {},
          stack: undefined,
        });
        const queue = yield* JobQueue.JobQueue;
        let job = Option.getOrThrow(yield* queue.take(["review.run@2"]));
        const countedBefore =
          refusedAccount === "first-continuation" || folderAt !== undefined
            ? JOB_POLICIES["review.run"].maxAttempts - 1
            : 0;
        for (let prior = 0; prior < countedBefore; prior++) {
          yield* queue.fail(job.seq, job.attempts, {
            tag: "SyntheticRetry",
            message: "No model work",
          });
          const clock = yield* Clock.Clock;
          const retryAt = Date.now() + 60_000 * (prior + 1);
          job = Option.getOrThrow(
            yield* queue.take(["review.run@2"]).pipe(
              Effect.provideService(Clock.Clock, {
                currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                currentTimeNanos: clock.currentTimeNanos,
                monotonicTimeNanosUnsafe: () =>
                  clock.monotonicTimeNanosUnsafe(),
                monotonicTimeNanos: clock.monotonicTimeNanos,
                sleep: (duration) => clock.sleep(duration),
                currentTimeMillisUnsafe: () => retryAt,
                currentTimeMillis: Effect.succeed(retryAt),
              }),
            ),
          );
        }
        if (refusedAccount === "first-continuation") {
          expect(job.attempts).toBe(3);
          expect(yield* admitReview(run.ctx.location, registry)(job)).toBe(
            true,
          );
          armedContinuationRefusal = true;
        } else if (recovery !== undefined) {
          expect(yield* admitReview(run.ctx.location, registry)(job)).toBe(
            folderAt !== "startup",
          );
        }
        if (refusedAccount === "before-admission") {
          refuseAccount();
          expect(yield* admitReview(run.ctx.location, registry)(job)).toBe(
            false,
          );
          expect(yield* queue.release(job.seq, job.attempts)).toMatchObject({
            state: "waiting",
            attempts: 0,
          });
          return { admissionHeld: true };
        }
        if (refusedAccount === "attempt-open") refuseAccount();
        const nativeBytes = () => {
          const path = piDatabase(run.ctx.location, job.eventId!);
          return existsSync(path) ? readFileSync(path) : undefined;
        };
        let firstNative: ReturnType<typeof nativeBytes>;
        const runClaim = () =>
          reviewRunHandler({ location: run.ctx.location, repository })(job);
        const exit = yield* Effect.exit(runClaim());
        if (fresh) {
          if (Exit.isFailure(exit)) {
            const failure = Option.getOrThrow(
              Cause.findErrorOption(exit.cause),
            );
            throw new Error(`Fresh review failed: ${JSON.stringify(failure)}`);
          }
          expect(exit.value).toMatchObject({
            stages: expect.arrayContaining([
              expect.objectContaining({ stage: "frame", status: "computed" }),
              expect.objectContaining({ stage: "map", status: "computed" }),
              expect.objectContaining({ stage: "publish", status: "computed" }),
            ]),
          });
          const publishEvents = (yield* Log.history({
            kind: "stage.completed@1",
          })).filter(
            ({ event }) =>
              event.attribution?.runId === job.eventId &&
              event.attribution?.stage === "publish",
          );
          expect(publishEvents).toHaveLength(1);
          const payload = publishEvents[0]?.event.payload;
          expect(payload).toBeDefined();
          expect(payload).not.toHaveProperty("failedModelCalls");
          expect(payload).not.toHaveProperty("abortedModelCalls");
          expect(yield* queue.complete(job.seq, job.attempts)).toMatchObject({
            state: "completed",
            attempts: 1,
          });
          const log = openRunLog(run.ctx.location, job.eventId!).read();
          expect(log).toContainEqual(
            expect.objectContaining({ type: "run.completed" }),
          );
          expect(log).not.toContainEqual(
            expect.objectContaining({ type: "run.held" }),
          );
          expect(log).not.toContainEqual(
            expect.objectContaining({ type: "run.failed" }),
          );
          return { fresh: true };
        }
        if (Exit.isSuccess(exit)) throw new Error("Expected a failed attempt");
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        if (
          signInHold ||
          (future !== undefined && !corrupt) ||
          writeRefusal ||
          refusedAccount !== undefined
        ) {
          const releaseHeld = (cause: typeof exit.cause) =>
            Effect.gen(function* () {
              expect(
                Option.getOrThrow(Cause.findErrorOption(cause)),
              ).toMatchObject({
                _tag: "JobHeld",
                hold: true,
              });
              expect(job.attempts).toBe(countedBefore + 1);
              // The worker releases errors carrying hold:true instead of calling queue.fail.
              const released = yield* queue.release(job.seq, job.attempts);
              expect(released).toMatchObject({
                state: "waiting",
                attempts: countedBefore,
              });
              expect(
                existsSync(runFolder(run.ctx.location, job.eventId!)),
              ).toBe(true);
              const current = nativeBytes();
              if (refusedAccount === "attempt-open")
                expect(current).toBeUndefined();
              else if (refusedAccount !== undefined) {
                expect(current).toBeDefined();
                if (firstNative === undefined) firstNative = current;
                else expect(current).toEqual(firstNative);
              }
              const log = openRunLog(run.ctx.location, job.eventId!).read();
              if (freshRefusal && refusedAccount !== "attempt-open")
                expect(
                  log.filter((entry) => entry.type === "run.snapshot").at(-1),
                ).toMatchObject({ mode: "held" });
              expect(log).not.toContainEqual(
                expect.objectContaining({ type: "run.failed" }),
              );
              expect(log).not.toContainEqual(
                expect.objectContaining({
                  type: "run.attempt-failed",
                  final: true,
                }),
              );
              return released;
            });
          let released = yield* releaseHeld(exit.cause);
          if (refusedAccount === "first-continuation") {
            expect(continuationLookups).toBe(2);
            expect(fake.opens()).toBe(0);
            expect(fake.turns).toHaveLength(0);
            armedContinuationRefusal = false;
          }
          if (recovery !== undefined) {
            expect(error).toMatchObject({
              _tag: "JobHeld",
              hold: true,
              message:
                recovery === "held-race"
                  ? "The job waits for the next claim."
                  : folderAt === undefined
                    ? "Account fake-claude needs a newer Neuve."
                    : refusalMessage,
            });
            repair();
            job = Option.getOrThrow(yield* queue.take(["review.run@2"]));
            expect(job.attempts).toBe(countedBefore + 1);
            expect(
              yield* routeReadiness(
                route,
                runtimeRegistry,
                runtimes.processReadinessStatuses(),
              ),
            ).toMatchObject({ ready: true });
            expect(
              yield* admitReview(run.ctx.location, runtimeRegistry)(job),
            ).toBe(true);
            const resumed = (yield* runClaim()) as {
              readonly stages: ReadonlyArray<unknown>;
            };
            expect(resumed.stages).toContainEqual(
              expect.objectContaining({
                stage: "frame",
                status: "computed",
                turns: expect.objectContaining({ turnsUsed: 1 }),
              }),
            );
            expect(yield* queue.complete(job.seq, job.attempts)).toMatchObject({
              state: "completed",
              attempts: countedBefore + 1,
            });
            expect(
              openRunLog(run.ctx.location, job.eventId!).read(),
            ).not.toContainEqual(
              expect.objectContaining({ type: "run.failed" }),
            );
            if (record === undefined || readableBytes === undefined)
              throw new Error("No readable record");
            expect(readFileSync(record, "utf8")).toBe(readableBytes);
            return { recovered: true, resumed };
          }
          for (let claim = 1; claim < claims; claim++) {
            const next = Option.getOrThrow(yield* queue.take(["review.run@2"]));
            expect(next.seq).toBe(job.seq);
            job = next;
            const retry = yield* Effect.exit(runClaim());
            if (Exit.isSuccess(retry))
              throw new Error("Expected a held attempt");
            released = yield* releaseHeld(retry.cause);
          }
          return { error, released, runId: job.eventId! };
        }
        const failed = yield* queue.fail(
          job.seq,
          job.attempts,
          Worker.describeFailure(exit.cause, JOB_POLICIES[job.kind]),
        );
        const clock = yield* Clock.Clock;
        const retryAt = Date.now() + 60_000;
        const reclaimed = yield* queue.take(["review.run@2"]).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: (duration) => clock.sleep(duration),
            currentTimeMillisUnsafe: () => retryAt,
            currentTimeMillis: Effect.succeed(retryAt),
          }),
        );
        return { error, failed, reclaimed, runId: job.eventId! };
      }).pipe(Effect.provide(JobQueue.layer), Effect.provide(run.ctx.records)),
    );
    if ("fresh" in observed) {
      expect(
        fake.turns
          .map(
            (turn) =>
              turn.policy.tools.find((tool) => tool.name.startsWith("submit_"))
                ?.name,
          )
          .sort(),
      ).toEqual([...reviewTools].sort());
      expect(fake.opens()).toBe(fake.closes());
      expect(fake.probes()).toBe(0);
      expect(cleanup).toMatchObject([{ mode: "ended", stop: false }]);
      return;
    }
    if ("recovered" in observed) {
      expect(
        fake.turns
          .map(
            (turn) =>
              turn.policy.tools.find((tool) => tool.name.startsWith("submit_"))
                ?.name,
          )
          .sort(),
      ).toEqual([...reviewTools].sort());
      expect(fake.opens()).toBe(fake.closes());
      expect(fake.probes()).toBe(0);
      expect(cleanup).toMatchObject(
        folderAt === "startup"
          ? [{ mode: "ended", stop: false }]
          : [
              { mode: "held", stop: false },
              { mode: "ended", stop: false },
            ],
      );
      return;
    }
    if ("admissionHeld" in observed) {
      expect(fake.turns).toHaveLength(0);
      expect(fake.opens()).toBe(0);
      expect(fake.probes()).toBe(0);
      expect(readinessReads).toBe(0);
      if (record === undefined || refusedBytes === undefined)
        throw new Error("No record");
      expect(readFileSync(record, "utf8")).toBe(refusedBytes);
      return;
    }
    if ("released" in observed) {
      expect(observed.error).toMatchObject({
        _tag: "JobHeld",
        hold: true,
        message:
          refusedAccount !== undefined
            ? "Account fake-claude needs a newer Neuve."
            : future === undefined && !writeRefusal
              ? "The Claude Code sign-in of account fake-claude is not-signed-in; run `neuve auth login fake-claude`"
              : "This hold is not understood; leave it to a newer build",
      });
      expect(observed.released).toMatchObject({
        state: "waiting",
        attempts:
          refusedAccount === "first-continuation"
            ? JOB_POLICIES["review.run"].maxAttempts - 1
            : 0,
      });
      expect(cleanup).toMatchObject(
        Array.from(
          {
            length:
              refusedAccount === undefined
                ? claims
                : refusedAccount === "attempt-open"
                  ? 0
                  : 1,
          },
          () => ({ mode: "held", stop: false }),
        ),
      );
      if (
        future !== undefined ||
        writeRefusal ||
        refusedAccount !== undefined
      ) {
        expect(readinessReads).toBe(readsAtHold);
        expect(fake.probes()).toBe(0);
        if (future !== undefined)
          expect(savedHold ?? "").toContain("futureHold");
      }
    } else {
      expect(observed.error).toMatchObject({
        _tag: "RunFailed",
        stageError: corrupt ? "CorruptRecord" : scenario.failure._tag,
        retryable: corrupt ? false : !internalRetries,
      });
      expect(observed.failed.state).toBe(
        internalRetries ? "failed" : "delayed",
      );
      expect(Option.isNone(observed.reclaimed)).toBe(internalRetries);
      expect(observed.failed.job.attempts).toBe(1);
      expect(cleanup).toMatchObject([
        internalRetries
          ? { mode: "ended", stop: true, stopCause: "held-failure" }
          : { mode: "interrupted", stop: false },
      ]);
    }
    if (future !== undefined) {
      expect(readinessReads).toBe(readsAtHold);
      expect(fake.probes()).toBe(0);
    }
    if (corrupt) {
      expect(
        openRunLog(run.ctx.location, observed.runId).read(),
      ).toContainEqual(
        expect.objectContaining({ type: "run.attempt-failed", final: true }),
      );
    }
    if (refusedAccount !== undefined) {
      if (record === undefined || refusedBytes === undefined)
        throw new Error("No record");
      expect(readFileSync(record, "utf8")).toBe(refusedBytes);
      if (refusedAccount !== "attempt-open") expect(savedHold).toBeDefined();
    }
    expect(fake.turns).toHaveLength(freshRefusal ? 0 : 1);
    expect(fake.opens()).toBe(freshRefusal ? 0 : 1);
    expect(fake.closes()).toBe(freshRefusal ? 0 : 1);
    if (refusedAccount !== "attempt-open")
      expect(
        openRunLog(run.ctx.location, observed.runId).read(),
      ).toContainEqual(expect.objectContaining({ type: "run.held" }));
  } finally {
    settingsSpy.mockRestore();
    unwatch();
    hostSpy.mockRestore();
    registrySpy.mockRestore();
    statusesSpy.mockRestore();
    integrationSpy.mockRestore();
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
    tempHome.close();
  }
};

// Why: a fresh Claude-route review must publish schema-valid telemetry and complete on its first claim.
test("a fresh Claude-route review publishes and completes through the handler and queue", async () => {
  const scenario = scenarios.find(
    (scenario) => scenario.name === "internalRetries=true",
  );
  if (scenario === undefined) throw new Error("No fresh-review scenario");
  await runScenario(scenario, "-fresh", "fresh");
}, 60000);

for (const scenario of scenarios.filter(
  (scenario) => !("future" in scenario && scenario.future === "malformed"),
)) {
  test(
    `the handler and queue preserve ${scenario.name}`,
    () => runScenario(scenario),
    "refusedAccount" in scenario || scenario.failure._tag === "SignInRequired"
      ? 60000
      : 20000,
  );
}

// Why: a corrupt held failure ends the attempt, and later unknown variants still hold without a retry or probe.
test("the handler and queue distinguish corrupt, unknown-tag and unknown-reason holds in sequence", async () => {
  for (const future of ["malformed", "tag", "turn-reason"]) {
    const scenario = scenarios.find(
      (scenario) => "future" in scenario && scenario.future === future,
    );
    if (scenario === undefined) throw new Error(`No scenario for ${future}`);
    await runScenario(scenario, "-sequence");
  }
}, 30000);

for (const recovery of ["after-close", "held-race"] as const) {
  // Why: a real held run must resume after repair, even if repair races with this claim's held result.
  test(`a stage-open refused account recovers ${recovery} through the handler and queue`, async () => {
    const scenario = scenarios.find(
      (scenario) =>
        "refusedAccount" in scenario &&
        scenario.refusedAccount === "stage-open",
    );
    if (scenario === undefined) throw new Error("No stage-open scenario");
    await runScenario(scenario, `-${recovery}`, recovery);
  }, 60000);
}

// Why: refusal on the first stage continuation must hold attempt 3 of 3 without deleting the run, then resume.
test("the last attempt holds at its first stage continuation and resumes after repair", async () => {
  const scenario = scenarios.find(
    (scenario) =>
      "refusedAccount" in scenario &&
      scenario.refusedAccount === "first-continuation",
  );
  if (scenario === undefined) throw new Error("No continuation scenario");
  await runScenario(scenario, "-recovery", "after-close");
}, 60000);

for (const site of ["first-continuation", "stage-open", "startup"] as const) {
  // Why: a folder refusal must preserve the last attempt and resume the same review after repair.
  test(`a ${site} folder refusal holds attempt 3 uncounted and recovers without restarting`, async () => {
    const scenario = scenarios.find(
      (s) =>
        "refusedAccount" in s &&
        s.refusedAccount === (site === "startup" ? "attempt-open" : site),
    );
    if (scenario === undefined) throw new Error("No folder refusal scenario");
    await runScenario(
      scenario,
      `-folder-${site}`,
      "after-close",
      site === "startup" ? "startup" : "after-open",
    );
  }, 60000);
}

// Anthropic Messages answers for an API-key review: each request submits its stage's tool once.
const anthropicEndpoint = (seen: string[]) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = await request.text();
    if (path === "/v1/messages/count_tokens") {
      seen.push("count_tokens");
      return Response.json(
        { input_tokens: 100 },
        { headers: { "request-id": "req_count" } },
      );
    }
    const body = JSON.parse(text) as {
      readonly tools?: ReadonlyArray<{ readonly name: string }>;
    };
    const tool = body.tools?.find((tool) => tool.name.startsWith("submit_"));
    if (path !== "/v1/messages" || tool === undefined)
      return new Response("unexpected request", { status: 500 });
    seen.push(tool.name);
    const id = `msg_${seen.length}`;
    const events = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: OPUS_ROUTE.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `toolu_${seen.length}`,
          name: tool.name,
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(acceptedSubmission(tool.name, text)),
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 20 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      {
        headers: { "content-type": "text/event-stream", "request-id": id },
      },
    );
  }) as typeof globalThis.fetch;

// Why (ruling 48 addendum 9, Opus's final review 4 reproduction 2): the Neuve root turning
// group-writable under a live worker store must not hold, count or fail an API-key review. On
// main an API-key review never depends on the accounts folder check.
test("an API-key review commits on its first claim after the live store's root turns 0775", async () => {
  const run = await world("contract-queue-api-key-live-store-0775");
  const repository = run.ctx.repository;
  reviewRepository(repository);
  const tempHome = scratch();
  const folder = AccountStore.neuveFolder(tempHome.home);
  const variable = "ANTHROPIC_API_KEY";
  const previousKey = process.env[variable];
  process.env[variable] = "fake-anthropic-key-for-tests";
  const calls: string[] = [];
  const seen: string[] = [];
  const settingsSpy = spyOn(settings, "readSettings").mockReturnValue(
    Option.none(),
  );
  const integrationSpy = spyOn(
    integrations,
    "readIntegrations",
  ).mockReturnValue({ status: "absent", path: "(fixture)" });
  const statusesSpy = spyOn(
    runtimes,
    "processReadinessStatuses",
  ).mockReturnValue(Effect.die("An API-key route reads no account status"));
  let registrySpy: { mockRestore(): void } | undefined;
  try {
    const registry = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AccountStore.make(tempHome.home);
        yield* store.add("claude", route.account.name);
        chmodSync(folder, 0o755);
        // The worker's own directory, in the run's scope, opened on a live store at 0755.
        const directory = Context.get(
          yield* Layer.build(
            runtimes.workerRuntimeOptions(tempHome.home).accountDirectory,
          ),
          AccountDirectory,
        );
        expect(
          yield* directory.lookup(route.account.name, "use"),
        ).toMatchObject({ name: route.account.name });
        return yield* RuntimeRegistry.pipe(
          Effect.provide(
            runtimeRegistryLayer([
              piStatusRuntime(),
              storeRuntime({ calls }),
            ]).pipe(Layer.provide(Layer.succeed(AccountDirectory, directory))),
          ),
        );
      }).pipe(Effect.provideService(Scope.Scope, run.scope)),
    );
    registrySpy = spyOn(runtimes, "processRuntimes").mockResolvedValue(
      registry,
    );
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* requestReview({
          location: run.ctx.location,
          repository,
          range: "HEAD^..HEAD",
          requester: { _tag: "Unresolved" },
          route: OPUS_ROUTE,
          runtimes: registry,
          search: {},
          stack: undefined,
        });
        chmodSync(folder, 0o775);
        // Both pi defaults resolve from their declarations; their readiness reads no account file.
        for (const name of ["anthropic", "chatgpt"])
          expect(
            yield* registry.capabilities(AccountName.parse(name)),
          ).toMatchObject({ ownsLoop: false });
        expect(
          yield* routeReadiness(
            OPUS_ROUTE,
            registry,
            runtimes.processReadinessStatuses(),
          ),
        ).toMatchObject({ ready: true });
        // A named Claude account on the same live store still reads the refused-store condition.
        expect(
          yield* registry.capabilities(route.account.name).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "AccountStoreRefused",
          folder,
          problem: { kind: "writable-by-others" },
        });
        const queue = yield* JobQueue.JobQueue;
        const outcomes: string[] = [];
        let runId: string | undefined;
        for (
          let claim = 0;
          claim < JOB_POLICIES["review.run"].maxAttempts;
          claim++
        ) {
          const clock = yield* Clock.Clock;
          const retryAt = Date.now() + 60_000 * (claim + 1);
          const taken = yield* queue.take(["review.run@2"]).pipe(
            Effect.provideService(Clock.Clock, {
              currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
              currentTimeNanos: clock.currentTimeNanos,
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              sleep: (duration) => clock.sleep(duration),
              currentTimeMillisUnsafe: () => retryAt,
              currentTimeMillis: Effect.succeed(retryAt),
            }),
          );
          if (Option.isNone(taken)) break;
          const job = taken.value;
          runId = job.eventId!;
          expect(yield* admitReview(run.ctx.location, registry)(job)).toBe(
            true,
          );
          const exit = yield* Effect.exit(
            reviewRunHandler({
              location: run.ctx.location,
              repository,
              fetch: anthropicEndpoint(seen),
            })(job),
          );
          if (Exit.isSuccess(exit)) {
            expect(yield* queue.complete(job.seq, job.attempts)).toMatchObject({
              state: "completed",
              attempts: 1,
            });
            outcomes.push("completed");
            break;
          }
          const failed = yield* queue.fail(
            job.seq,
            job.attempts,
            Worker.describeFailure(exit.cause, JOB_POLICIES[job.kind]),
          );
          outcomes.push(failed.state);
        }
        return { outcomes, runId };
      }).pipe(Effect.provide(JobQueue.layer), Effect.provide(run.ctx.records)),
    );
    expect(observed.outcomes).toEqual(["completed"]);
    if (observed.runId === undefined) throw new Error("No claimed run");
    const log = openRunLog(run.ctx.location, observed.runId).read();
    expect(log).toContainEqual(
      expect.objectContaining({ type: "run.completed" }),
    );
    for (const type of ["run.attempt-failed", "run.failed", "run.held"])
      expect(log).not.toContainEqual(expect.objectContaining({ type }));
    expect(seen.filter((name) => name.startsWith("submit_")).sort()).toEqual(
      [...reviewTools].sort(),
    );
    // Neither the fake Claude runtime nor a status probe ran for the API-key review.
    expect(calls).toEqual([]);
  } finally {
    if (previousKey === undefined) delete process.env[variable];
    else process.env[variable] = previousKey;
    settingsSpy.mockRestore();
    integrationSpy.mockRestore();
    statusesSpy.mockRestore();
    registrySpy?.mockRestore();
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
    chmodSync(folder, 0o755);
    tempHome.close();
  }
}, 60000);
