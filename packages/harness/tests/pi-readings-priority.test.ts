// Why (NEU-148, the probe): the scheduler gives a free slot to a review's turn work first and takes
// readings by risk rank, so a reading's calls must reach it as a reading, with its group's rank, and
// a re-read as a continuation. This runs the real review host (its route bindings, call slots and
// scheduler) on a real pi Harness over SQLite, with pi-ai's faux provider as the model, and binds
// each conversation the way an agent step does: it prepares the step, then binds its route.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  type DocumentReader,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import {
  Scheduler,
  type Request as BudgetRequest,
} from "../src/budget/scheduler.ts";
import { callSlots } from "../src/pi/call-slots.ts";
import { openReviewHost } from "../src/pi/host.ts";
import type { ReviewStagesPort } from "../src/pi/review-task.ts";
import { SourceOwnership } from "../src/pi/source-ownership.ts";
import type { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import { readingBinds } from "../src/pi/stages/reading-task.ts";
import type { StageServices } from "../src/pi/stages/services.ts";
import type { ResolvedAgent } from "../src/pi/stages/tools.ts";
import type { StageRecord } from "../src/pipeline.ts";
import { SOL_ROUTE } from "../src/route.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-readings-priority-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const record = (stage: StageRecord["stage"], agent: string): StageRecord => ({
  stage,
  agent,
  status: "computed",
  wallMs: 1,
});

/** A review that ends at once: Precompute finds no manifest, so the review publishes nothing. */
const port: ReviewStagesPort = {
  front: async () => {
    throw new Error("no front in this test");
  },
  fill: async () => ({ record: record("link", "link.fill"), groups: [] }),
  link: async () => {
    throw new Error("no link in this test");
  },
  precompute: async () => ({
    record: { ...record("precompute", "precompute"), status: "skipped" },
  }),
  publish: async () => [record("publish", "publish")],
};

// Reason: readings must queue behind turn work and in risk order.
test("a reading step's calls reach the scheduler as its reading stage with its group's rank, and a re-read's as continued", async () => {
  const budget = new Scheduler(4, 4, 4);
  const admitted: Array<BudgetRequest> = [];
  const admit = budget.admit.bind(budget);
  budget.admit = (request, signal) => {
    admitted.push(request);
    return admit(request, signal);
  };
  const path = join(directory, "pi.sqlite");
  const ownership = SourceOwnership.acquire(path);
  const host = await openReviewHost(
    {
      storage: await openNodeSqliteStorage(path),
      ownership,
      models: createModels(),
      createRouteProvider: (binding) => {
        const faux = fauxProvider({
          api: "faux",
          provider: binding.logicalProvider,
          models: [{ id: binding.physicalModel }],
        });
        faux.setResponses(
          Array.from({ length: 4 }, () => () => fauxAssistantMessage("done")),
        );
        return faux.provider;
      },
      slots: callSlots(
        4,
        (work, signal) =>
          Effect.runPromise(work, signal === undefined ? {} : { signal }),
        {
          budget,
          account: "a".repeat(64),
          owner: "readings-run",
          priority: () => ({ class: "interactive", position: "new", stage: 0 }),
        },
      ),
      registry: createRegistry(),
      run: {
        runId: "run-1",
        runKey: "run-key",
        generation: 1,
        cycleId: "cycle-1",
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        config: {} as never,
        cutoffAt: Date.now() + 3_600_000,
      },
      claim: { jobSeq: 7, attempt: 1, claimedAt: "priority" },
      stages: () => ({
        port,
        extension: defineExtension({ name: "test.stages", tasks: [] }),
      }),
      onClose: async () => undefined,
      cutoffGraceMs: 50,
    },
    context,
  ).finally(() => ownership.release());
  try {
    await host.ended(context);
    // The agent step's own order: it prepares the step from its input, then binds its route.
    const bound = readingBinds(
      {
        routes: {
          bindAgentRoute: host.routes.bindAgentRoute,
          prepareFinalGeneration: host.routes.prepareFinalGeneration,
        },
      } as StageServices,
      {
        prepare: async (_taskId, input) =>
          ({
            step: {
              spec: {
                agent: `${input.kind}.g1${(input.params as { part: string }).part === "reread" ? ".reread" : ""}`,
              },
            },
          }) as ResolvedAgent,
      },
      true,
    );
    const steps: ReadonlyArray<AgentStepInput> = [
      {
        kind: "assess",
        params: { rank: 730_000, part: "read" },
        cutoffAt: Date.now() + 60_000,
      },
      {
        kind: "lane-review",
        params: { rank: 250_004, part: "reread" },
        cutoffAt: Date.now() + 60_000,
      },
    ];
    // And a finder turn, which is not a reading: it keeps its turn band.
    for (const [at, input] of [...steps, undefined].entries()) {
      const conversation = await host.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      const agent =
        input === undefined
          ? "find.correctness"
          : (
              await bound.prepare(
                at as TaskId,
                input,
                host.harness as DocumentReader,
                context,
              )
            ).step.spec.agent;
      const model = await bound.services.routes.bindAgentRoute(
        {
          conversationId: conversation.id,
          stage: input === undefined ? "find" : "verify",
          agent,
          route: SOL_ROUTE,
        },
        context,
      );
      await conversation.configure({ model }, context);
      for (const turn of [1, 2]) {
        const submission = await conversation.submit(
          {
            type: "input",
            content: `turn ${turn}`,
            requestId: `${at}-${turn}`,
          },
          context,
        );
        expect((await submission.wait(context)).status).toBe("done");
      }
    }
    expect(admitted.map((request) => request.priority)).toEqual([
      // Assess, read: a new reading at its rank, then its follow-up turn as continued.
      {
        class: "interactive",
        position: "new",
        stage: 40,
        reading: { rank: 730_000 },
      },
      {
        class: "interactive",
        position: "continuation",
        stage: 40,
        reading: { rank: 730_000 },
      },
      // Lane review, re-read: continued from its first call.
      {
        class: "interactive",
        position: "continuation",
        stage: 50,
        reading: { rank: 250_004 },
      },
      {
        class: "interactive",
        position: "continuation",
        stage: 50,
        reading: { rank: 250_004 },
      },
      // A finder's turns, unchanged.
      { class: "interactive", position: "new", stage: 30 },
      { class: "interactive", position: "continuation", stage: 30 },
    ]);
  } finally {
    await host.close("ended", context);
  }
}, 30_000);
