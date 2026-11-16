// Why: one refused reading call ended a real review. A step whose spec says `unanswered: "fail"`
// must end failed on a model call the provider could not answer, so its caller records its part
// as not done, and must still hold when the account itself failed. Each case says what it guards.
// The production agent step runs on a real pi harness over SQLite (`pi/stages/fixture.ts`).
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import type { StageRecord } from "../src/pipeline.ts";
import {
  routeFailureDiagnostic,
  schedulerText,
  type RouteFailureKind,
} from "../src/pi/providers/failure.ts";
import { RunControlDoc } from "../src/pi/control.ts";
import type { AgentStepCheckpoint } from "../src/pi/stages/agent-step.ts";
import type { AgentStep } from "../src/pi/stages/agent.ts";
import { world } from "./pi/stages/fixture.ts";

/** Words only the provider wrote: they must never reach the failed outcome. */
const PROVIDER_WORDS = "PROVIDER-WORDS-5e1";

const failing =
  (kind: RouteFailureKind, status?: number) => (): AssistantMessage => ({
    ...fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: schedulerText("Route", {
        kind,
        ...(status === undefined ? {} : { status }),
      }),
    }),
    diagnostics: [
      routeFailureDiagnostic(
        {
          kind,
          ...(status === undefined ? {} : { status }),
          code: "invalid_json_schema",
          detail: PROVIDER_WORDS,
        },
        Date.now(),
      ),
    ],
  });

const failOption = (step: AgentStep<unknown, unknown>) => ({
  ...step,
  spec: { ...step.spec, unanswered: "fail" as const },
});

/** A pi-engine world whose step sets the option, or not. */
const piWorld = (name: string, option: boolean, turnLimit = 6) =>
  world(
    name,
    turnLimit,
    false,
    false,
    "faux",
    undefined,
    false,
    {},
    {
      ...(option ? { configure: failOption } : {}),
    },
  );

const outcomeOf = async (harness: Harness, id: TaskId<StageRecord>) =>
  (await harness.waitForTask(id, context)).state.outcome;

/** Resolves with the step's held checkpoint once it is provider-held. */
const heldIn = async (harness: Harness, id: TaskId<StageRecord>) => {
  const watch = await harness.watchTaskGraph(context);
  try {
    await new Promise<void>((resolve) => {
      const check = () => {
        const state = watch.value?.tasks[String(id)]?.state;
        if (
          state !== undefined &&
          "phase" in state &&
          state.phase === "provider-held"
        )
          resolve();
      };
      check();
      watch.start(async () => check());
    });
  } finally {
    await watch.stop();
  }
  const task = await harness.getTask(id, context);
  return task?.state.status === "running" ? task.state.checkpoint : undefined;
};

const heldPhases = (run: Awaited<ReturnType<typeof piWorld>>) =>
  run.ctx.log
    .read()
    .filter(
      (entry) =>
        entry.type === "span" &&
        entry["name"] === "harness.pi.phase" &&
        JSON.stringify(entry["attributes"]).includes("provider-held"),
    );

const REFUSED = {
  kind: "invalid_request",
  status: 400,
  message: "Route (HTTP 400): the provider refused the request as invalid",
  // What the hold would have recorded (`heldFailure`): a refused request is not retried.
  retryable: false,
} as const;

/**
 * What a failed step's outcome must show: the kind, the retryability its hold would have
 * recorded, no hold, no provider words.
 */
const expectFailedWithKind = async (
  run: Awaited<ReturnType<typeof piWorld>>,
  harness: Harness,
  id: TaskId<StageRecord>,
  expected: {
    readonly kind: RouteFailureKind;
    readonly status: number;
    readonly message: string;
    readonly retryable: boolean;
  } = REFUSED,
) => {
  const outcome = await outcomeOf(harness, id);
  expect(outcome.status).toBe("failed");
  if (outcome.status !== "failed") return;
  expect(outcome.error.detail).toEqual({
    failure: { kind: expected.kind, status: expected.status },
    tag: "ModelError",
    message: expected.message,
    retryable: expected.retryable,
  });
  expect(JSON.stringify(outcome)).not.toContain(PROVIDER_WORDS);
  expect(JSON.stringify(outcome)).not.toContain("invalid_json_schema");
  expect((await harness.snapshot(RunControlDoc, context))?.held ?? {}).toEqual(
    {},
  );
  expect(heldPhases(run)).toEqual([]);
  expect(
    run.events.flatMap((event) =>
      event.type === "stage.end" ? [event.status] : [],
    ),
  ).toEqual(["failed"]);
};

// Guards the running phase's branch: the option turns its hold into a failed outcome.
test("running: a refused call with the option ends the step failed, naming the kind, with no hold", async () => {
  const run = await piWorld("unanswered-running", true);
  run.script.push(failing("invalid_request", 400));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    opened.harness.resume();
    await expectFailedWithKind(run, opened.harness, id);
    expect(run.sent).toHaveLength(1);
    expect(run.sent[0]!.mode.kind).toBe("normal");
  } finally {
    await opened.harness.close(context);
  }
});

// Guards the retryability: a kind the hold would retry (`server`) ends failed retryable.
test("running: a server failure with the option ends the step failed and retryable", async () => {
  const run = await piWorld("unanswered-server", true);
  run.script.push(failing("server", 500));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    opened.harness.resume();
    await expectFailedWithKind(run, opened.harness, id, {
      kind: "server",
      status: 500,
      message: "Route (HTTP 500): server error",
      retryable: true,
    });
    expect(run.sent).toHaveLength(1);
  } finally {
    await opened.harness.close(context);
  }
});

// Guards the final phase's branch: the same from the final generation.
test("final: a refused final generation with the option ends the step failed, naming the kind, with no hold", async () => {
  const run = await piWorld("unanswered-final", true, 1);
  // The turn limit of one sends the step to its final generation after this reply.
  run.script.push(() => fauxAssistantMessage("read the evidence"));
  run.script.push(failing("invalid_request", 400));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    opened.harness.resume();
    await expectFailedWithKind(run, opened.harness, id);
    expect(run.sent.map((sent) => sent.mode.kind)).toEqual(["normal", "final"]);
  } finally {
    await opened.harness.close(context);
  }
});

/** A held step's checkpoint and run control entry, without the IDs a fresh world assigns. */
const holdOf = async (
  name: string,
  kind: RouteFailureKind,
  option: boolean,
) => {
  const run = await piWorld(name, option);
  run.script.push(failing(kind, kind === "plan_quota" ? 429 : 401));
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    opened.harness.resume();
    const checkpoint = (await heldIn(opened.harness, id)) as
      AgentStepCheckpoint | undefined;
    const control = await opened.harness.snapshot(RunControlDoc, context);
    const {
      conversationId: _conversation,
      failedSubmissionId: _submission,
      ...entry
    } = control?.held[String(id)] as Record<string, unknown>;
    return {
      sent: run.sent.length,
      checkpoint:
        checkpoint?.phase === "provider-held"
          ? {
              phase: checkpoint.phase,
              from: checkpoint.from.phase,
              failure: checkpoint.failure,
            }
          : checkpoint,
      held: Object.keys(control?.held ?? {}),
      entry,
      id: String(id),
    };
  } finally {
    await opened.harness.close(context);
  }
};

// Guards the account exception: the account's own failures hold with the option exactly as without.
for (const kind of ["auth", "sign_in", "binding", "plan_quota"] as const)
  test(`the account's own ${kind} still holds with the option, exactly as without it`, async () => {
    // An operation name takes no underscore.
    const name = `unanswered-${kind.replace("_", "-")}`;
    const without = await holdOf(`${name}-without`, kind, false);
    const withOption = await holdOf(`${name}-with`, kind, true);
    expect(withOption).toEqual(without);
    expect(withOption.checkpoint).toMatchObject({
      phase: "provider-held",
      from: "running",
      failure: { kind },
    });
    expect(withOption.held).toEqual([withOption.id]);
    expect(withOption.sent).toBe(1);
  }, 60_000);

// Guards today's behaviour: without the option, a refused request still holds. The rest of the
// unchanged hold is covered by `pi-stage-agent.test.ts` ("a call the provider refused holds the
// step with the route's typed failure through a close and reopen, …") and
// `pi-stage-agent-claim.test.ts` ("a waiter behind a holder that held claims again …").
test("without the option, a refused request still holds", async () => {
  const held = await holdOf("unanswered-default", "invalid_request", false);
  expect(held.checkpoint).toMatchObject({
    phase: "provider-held",
    failure: { kind: "invalid_request" },
  });
});

// Guards the claim: the failed step ends its claim failed, so a waiter on the same key gets that
// failure with its retryability and makes no model call of its own.
test("a second step waiting on the same key gets the first one's failure and makes no model call", async () => {
  const run = await piWorld("unanswered-claim", true);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refuse = failing("invalid_request", 400);
  run.script.push(async () => {
    await gate;
    return refuse();
  });
  const opened = await run.open();
  try {
    const first = await run.start(opened);
    const second = await run.start(opened);
    opened.harness.resume();
    // Both steps are up: one holds the key and its call is in flight, the other waits.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(run.sent).toHaveLength(1);
    release();
    const outcomes = await Promise.all([
      outcomeOf(opened.harness, first),
      outcomeOf(opened.harness, second),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "failed",
      "failed",
    ]);
    const details = outcomes.map((outcome) =>
      outcome.status === "failed" ? outcome.error.detail : undefined,
    );
    const holder = details.find(
      (detail) =>
        typeof detail === "object" && detail !== null && "failure" in detail,
    );
    const waiter = details.find((detail) => detail !== holder);
    expect(holder).toMatchObject({
      tag: "ModelError",
      retryable: false,
      failure: { kind: "invalid_request" },
    });
    // The waiter takes the holder's own retryability: it does not retry what the holder stops on.
    expect(waiter).toEqual({
      tag: "ModelError",
      message: REFUSED.message,
      retryable: false,
    });
    expect(run.sent).toHaveLength(1);
    expect(
      (await opened.harness.snapshot(RunControlDoc, context))?.held ?? {},
    ).toEqual({});
  } finally {
    await opened.harness.close(context);
  }
});
