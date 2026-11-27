// Why (NEU-148, WP8, the publisher's input): with the redesigned review the default, every review
// publishes through the records lane's `publishSettled`, batch by batch, from what the readings'
// port hands it (`batches`, `settle`). A batch the publisher's checks refuse is not published, and
// the publisher writes exactly what it is handed; so these build each batch of a real review (a real
// Git repository, its manifest and plan by the real engine) and hold it to the publisher's own
// checks and to its true values, hold a missing judgement out of every published decision, hold the
// units and dispositions to the code rule (a test is never evidence, decision 14.19), and hold
// `collect`, the probe's path, to what it gave before this round.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Context, Effect, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  PublishedPackets,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { defaultConfig, type ReadingsConfig } from "../src/config.ts";
import { applyLane } from "../src/disposition.ts";
import type { OwnedRange } from "@neuve/records-schema";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { defaultManifestSettings, frontManifest } from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { storedOutput, type StageRecord } from "../src/pipeline.ts";
import { agentKinds } from "../src/pi/stages/kinds.ts";
import {
  ReadingsRunDoc,
  readingName,
  readingTask,
  structuresOf,
  type ReadingTaskResult,
} from "../src/pi/stages/reading-task.ts";
import { stageRunner, type StageServices } from "../src/pi/stages/services.ts";
import type { CheckedCrossBatchClaim } from "../src/pi/cross-batch-claims.ts";
import { publishSettled } from "../src/publish-sections.ts";
import {
  SettledBatch as PublisherBatch,
  batchKeyOf,
  checkBatch,
  rangeCounts,
  unitSections,
} from "../src/publish-sections-input.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { ClaimStored, claimKey, commentKey } from "../src/readings/claims.ts";
import {
  decisionKeyOf,
  readingsPort,
  settledOf,
  storePlan,
} from "../src/readings/collect.ts";
import { EVIDENCE_RECIPE } from "../src/readings/evidence.ts";
import { READING_RECIPE, ReadingPlan } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import { summaryOf } from "../src/readings/settled.ts";
import {
  AssessStored,
  LaneReviewStored,
  assessStep,
  laneReviewStep,
} from "../src/readings/steps.ts";
import type { AgentResult } from "../src/pi/stages/agent.ts";
import type {
  AssessAnswer,
  LaneReviewAnswer,
} from "../src/readings/answers.ts";
import { ReviewMap, buildMapManifest } from "../src/review-map.ts";
import type { RunLog, RunLogRecord } from "../src/run-log.ts";
import { zeroUsage } from "../src/route.ts";
import { frame } from "./fixtures/link.ts";
import { eventsOf, inputOf, scratch } from "./publish-sections-fixtures.ts";
import { testRuntimes } from "./pi/stages/fixture.ts";

const ENGINE = "NEUVE_GRAPH_OUTLINE_EXECUTABLE";
const source = captureOutlineSource();
const graph = graphTestPrerequisite({
  available: "sha256" in source.key,
  message:
    "The Graph engine at NEUVE_GRAPH_OUTLINE_EXECUTABLE (or apps/neuve-graph/entire-graph) is missing: build it, or point the variable at one.",
});

const directory = mkdtempSync(join(tmpdir(), "readings-publish-input-"));
const scopes: Array<Scope.Closeable> = [];
afterAll(async () => {
  for (const scope of scopes)
    await Effect.runPromise(Scope.close(scope, {} as never)).catch(() => {});
  rmSync(directory, { recursive: true, force: true });
});

const PROBE: ReadingsConfig = {
  mode: "probe",
  bounds: { ...DEFAULT_READING_BOUNDS, maxFiles: 1 },
  recipe: READING_RECIPE,
};

const MARKS = {
  impact: "IMPACT-MARK callers now count only the filled items",
  defect: "DEFECT-MARK an empty string is no longer counted",
  risk: "RISK-MARK a caller may rely on the old count",
  incoming: "INCOMING-MARK the plural rule misses zero",
};

const COUNT_BASE =
  "export function count(items: Array<string>) {\n  return items.length;\n}\n";
const COUNT_HEAD =
  "export function count(items: Array<string>) {\n  return items.filter(Boolean).length;\n}\n";
const LABEL_BASE = "export const label = (n: number) => `${n} items`;\n";
const LABEL_HEAD =
  'export const label = (n: number) => `${n} item${n === 1 ? "" : "s"}`;\n';
const TEST_HEAD =
  'import { count } from "../src/count";\ntest("count", () => expect(count(["a", ""])).toBe(1));\n';

/** A small real repository: two code files, optionally a test file, a lockfile and a binary file. */
/** Two declarations whose changed lines are close enough to share one hunk. */
const PAIR_BASE =
  "export function one() {\n  return 1;\n}\nexport function two() {\n  return 2;\n}\n";
const PAIR_HEAD =
  "export function one() {\n  return 10;\n}\nexport function two() {\n  return 20;\n}\n";

/** A file whose second declaration the change removes whole. */
const GONE_BASE =
  "export function keep() {\n  return 1;\n}\n\nexport function drop(x: number) {\n  const y = x * 2;\n  return y + 1;\n}\n";
const GONE_HEAD = "export function keep() {\n  return 1;\n}\n";
/**
 * The two shapes NEU-446 plants, each removing a declaration whose replacement is elsewhere in the
 * range: `shout` moves from text.ts to its own file under the same name, and `Panel`'s file is
 * deleted while its caller, page.ts, now renders `List` from a new file.
 */
const PLANTED_BASE: Record<string, string> = {
  "text.ts":
    "export function whisper(s: string) {\n  return s.toLowerCase();\n}\n\nexport function shout(s: string) {\n  const loud = s.toUpperCase();\n  return `${loud}!`;\n}\n",
  "panel.ts":
    "export function Panel(title: string) {\n  const heading = `<h1>${title}</h1>`;\n  return `<section>${heading}</section>`;\n}\n",
  "page.ts":
    'import { Panel } from "./panel";\n\nexport const page = () => Panel("Home");\n',
};
const PLANTED_HEAD: Record<string, string | null> = {
  "text.ts":
    "export function whisper(s: string) {\n  return s.toLowerCase();\n}\n",
  "shout.ts":
    "export function shout(s: string) {\n  const loud = s.toUpperCase();\n  return `${loud}!`;\n}\n",
  "panel.ts": null,
  "list.ts":
    'export function List(items: string[]) {\n  const rows = items.map((item) => `<li>${item}</li>`);\n  return `<ul>${rows.join("")}</ul>`;\n}\n',
  "page.ts":
    'import { List } from "./list";\n\nexport const page = () => List(["Home"]);\n',
};

const repositoryOf = (
  name: string,
  withTest: boolean,
  pair = false,
  removal = false,
  planted = false,
) => {
  const repository = join(directory, name, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, "tests"), { recursive: true });
  mkdirSync(join(repository, "assets"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repository]);
  const git = (...args: Array<string>) =>
    Bun.spawnSync(["git", "-C", repository, ...args])
      .stdout.toString()
      .trim();
  const commit = (message: string) => {
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  writeFileSync(join(repository, "src", "count.ts"), COUNT_BASE);
  writeFileSync(join(repository, "src", "label.ts"), LABEL_BASE);
  if (pair) writeFileSync(join(repository, "src", "pair.ts"), PAIR_BASE);
  if (removal) writeFileSync(join(repository, "src", "gone.ts"), GONE_BASE);
  if (planted)
    for (const [file, text] of Object.entries(PLANTED_BASE))
      writeFileSync(join(repository, "src", file), text);
  // Bun's test runner, so a `.test.ts` file is declared a test by the repository's own rule.
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { test: "bun test" } }),
  );
  writeFileSync(join(repository, "bun.lock"), '{ "lockfileVersion": 1 }\n');
  writeFileSync(
    join(repository, "assets", "logo.png"),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0, 0]),
  );
  const base = commit("base");
  writeFileSync(join(repository, "src", "count.ts"), COUNT_HEAD);
  writeFileSync(join(repository, "src", "label.ts"), LABEL_HEAD);
  writeFileSync(join(repository, "bun.lock"), '{ "lockfileVersion": 2 }\n');
  writeFileSync(
    join(repository, "assets", "logo.png"),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9, 0, 0, 0]),
  );
  if (withTest)
    writeFileSync(join(repository, "tests", "count.test.ts"), TEST_HEAD);
  if (pair) writeFileSync(join(repository, "src", "pair.ts"), PAIR_HEAD);
  if (removal) writeFileSync(join(repository, "src", "gone.ts"), GONE_HEAD);
  if (planted)
    for (const [file, text] of Object.entries(PLANTED_HEAD))
      if (text === null) rmSync(join(repository, "src", file));
      else writeFileSync(join(repository, "src", file), text);
  const head = commit("count only filled items");
  return { repository, range: { baseOid: base, headOid: head } };
};

const result = <O>(output: O): AgentResult<O> => ({
  agent: "reading.test",
  stage: "verify",
  status: "submitted",
  output,
  endedBy: "submit",
  turnsUsed: 1,
  turnLimit: 1,
  finalGeneration: false,
  usage: zeroUsage,
  costUsd: null,
  resumedTurns: 0,
  restarted: false,
  modelCalls: 1,
});

const recordOf = (agent: string, key: string): StageRecord => ({
  stage: "verify",
  agent,
  status: "computed",
  key,
  wallMs: 1,
});

interface Options {
  /** A changed test file that calls `count`, declared test by the repository's conventions. */
  readonly withTest?: boolean;
  /** Each group's readings were shown a confirmed test row for every section, and no caller. */
  readonly testRows?: boolean;
  /** How `label.ts`'s Lane review ended. */
  readonly label?: "completed" | "failed" | "not-reached" | "not-ended";
  /**
   * `src/pair.ts`, one hunk over two declarations: two sections, Lane review approving the first and
   * unsure of the second, so they land in two units of one file.
   */
  readonly pair?: boolean;
  /** `src/gone.ts`, whose second function the change removes whole. */
  readonly removal?: boolean;
  /** NEU-446's planted shapes (`PLANTED_BASE`): a function moved, and a component replaced. */
  readonly planted?: boolean;
  readonly incomingClaim?: boolean;
}

/**
 * One review: the repository, its stored manifest (the real engine's), its stored plan (the real
 * engine's structures), a Map of two groups (the code; the test, binary and lockfile, the lockfile
 * leaving for the generated batch), stored answers for every reading group, one confirmed defect
 * claim on `count`, and the port. The fields case also supplies a confirmed incoming claim.
 */
const review = async (name: string, options: Options = {}) => {
  process.env[ENGINE] = source.executable;
  const { repository, range } = repositoryOf(
    name,
    options.withTest === true,
    options.pair === true,
    options.removal === true,
    options.planted === true,
  );
  const location = storeLocationIn(join(directory, name, "store"));
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const records = await Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(
        mcpClientsLayer({ status: "absent", path: "(none)" }),
        scope,
      ),
    ),
    McpClients,
  );
  const rows: Array<RunLogRecord> = [];
  const log: RunLog = {
    path: "(memory)",
    write: (row) => {
      rows.push(row);
    },
    read: () => rows,
  };
  const ctx = {
    location,
    repository,
    runId: mintUlid(),
    runKey: "f".repeat(64),
    range: { baseRef: "main", ...range },
    cycleId: mintUlid(),
    config: defaultConfig(),
    log,
    startedAt: Date.now(),
    reconciliationId: mintUlid(),
    records,
  };
  const run = stageRunner(ctx, clients);
  const storeValue = (op: string, value: unknown) =>
    run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return (yield* computations.run(
          { op, opVersion: 1, inputs: { name, op, at: mintUlid() } },
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify(value)),
            mediaType: "application/json",
          }),
        )).computation.key;
      }),
    );

  const manifest = await run(
    frontManifest(
      repository,
      range,
      defaultManifestSettings(1_000_000),
      source,
    ),
  );
  const planKey = await run(
    storePlan(ctx, {
      manifestKey: manifest.key,
      bounds: PROBE.bounds,
      manifest: manifest.value,
    }),
  );
  const plan = await run(storedOutput(ctx, planKey, ReadingPlan));
  const hunkList = manifest.value.hunks;
  const hunks = new Map(hunkList.map((hunk) => [hunk.hunkId, hunk]));
  const { structures } = await run(structuresOf(ctx, manifest.value));

  // The Map: the code files, then everything else it groups; the lockfile is on its excluded list
  // with code's reason, as the review's own Map is.
  const code = (path: string) => path.startsWith("src/");
  const groupOf = (id: string, label: string, pick: (p: string) => boolean) => {
    const own = hunkList.filter((hunk) => pick(hunk.path));
    return {
      id,
      label,
      why: `${label} changes.`,
      tier: "core" as const,
      doneWhen: [],
      files: [...new Set(own.map((hunk) => hunk.path))].map((path) => ({
        path,
        placedBy: "map" as const,
      })),
      hunkIds: own.map((hunk) => hunk.hunkId),
      changedLines: own.length,
    };
  };
  const excluded = buildMapManifest(manifest.value).excluded;
  const map = ReviewMap.parse({
    frame: "frame-key",
    source: "agent",
    groups: [
      groupOf("m1", "Counting", code),
      groupOf("m2", "Tests and assets", (path) => !code(path)),
    ],
    excluded,
    rolledUp: [],
    unlinkedDoneWhen: [],
    gaps: [],
  });
  const mapKey = await storeValue("test.map", map);
  // The Frame collect reads for each unit's Guided rows (round 25).
  const frameKey = await storeValue("test.frame", frame);

  // Every reading group's stored answers: Assess places each section low and easy (count's with
  // an impact entry); Lane review approves each, but requests changes on count with a defect its
  // check confirms, beside a risk.
  const sources = { hunks, structures };
  const sectionPath = (key: string) =>
    plan.sections.find((section) => section.key === key)!.path;
  const readings: Array<{
    name: string;
    outcome: TaskOutcome<unknown> | undefined;
  }> = [];
  let defectKey = "";
  for (const group of plan.groups) {
    const assess = assessStep({
      stage: "verify",
      reading: renderReading(plan, group.id, { for: "assess", ...sources }),
    });
    const laneReading = renderReading(plan, group.id, {
      for: "lane-review",
      ...sources,
    });
    const review = laneReviewStep({
      stage: "verify",
      reading: laneReading,
      goal: { goal: "Count only filled items.", doneWhen: [] },
      tools: [],
      keys: { frame: "frame-key", manifest: manifest.key },
    });
    const index = laneReading.index;
    const at = (s: number) => {
      const section = index.sections.find((x) => x.index === s)!;
      const owned = section.owned[0]!;
      return {
        key: section.key,
        side: owned.side,
        line: owned.startLine,
        cite: `${section.file}${owned.side === "new" ? "n" : "o"}${owned.startLine}`,
      };
    };
    const numbers = index.sections.map((s) => s.index);
    const isPair = group.keys.some((key) => sectionPath(key) === "src/pair.ts");
    const isCount = group.keys.some(
      (key) => sectionPath(key) === "src/count.ts",
    );
    const assessAnswer: AssessAnswer = {
      factors: [],
      requirements: [],
      impact: isCount
        ? [{ s: 1, effect: "narrowed", t: MARKS.impact, cites: [at(1).cite] }]
        : [],
      classes: [
        { S: numbers, c: "l", v: "e", F: [], R: [], person: null, gaps: null },
      ],
    };
    expect(assess.spec.check!(assessAnswer)).toEqual([]);
    const assessKey = await storeValue(
      "test.assess",
      AssessStored.parse(assess.compose(result(assessAnswer))),
    );
    const reviewAnswer: LaneReviewAnswer = {
      files: [...new Set(index.sections.map((s) => s.file))].map((f) => ({
        f,
        checked: "read the rows",
        rows: null,
      })),
      sections: isCount
        ? { a: numbers.filter((n) => n !== 1), r: [1], u: [] }
        : isPair
          ? { a: numbers.slice(0, 1), r: [], u: numbers.slice(1) }
          : { a: numbers, r: [], u: [] },
      comments: isCount
        ? [
            {
              s: 1,
              side: at(1).side,
              start: at(1).line,
              end: at(1).line,
              kind: "defect",
              effect: null,
              t: MARKS.defect,
              cites: [at(1).cite],
              fails: "An empty string drops out of the count.",
              row: null,
            },
            {
              s: 1,
              side: at(1).side,
              start: at(1).line,
              end: at(1).line,
              kind: "risk",
              effect: null,
              t: MARKS.risk,
              cites: [at(1).cite],
              fails: "",
              row: null,
            },
          ]
        : [],
      unsure: isPair
        ? numbers.slice(1).map((n) => ({ s: n, t: "UNSURE-MARK not shown" }))
        : [],
    };
    expect(review.spec.check!(reviewAnswer)).toEqual([]);
    const reviewKey = await storeValue(
      "test.lane-review",
      LaneReviewStored.parse(review.compose(result(reviewAnswer))),
    );
    // What each reading was shown: with `testRows`, a confirmed test row for every section and no
    // caller (a test names the code); otherwise nothing.
    const evidenceKey =
      options.testRows === true
        ? await storeValue("test.evidence", {
            recipe: EVIDENCE_RECIPE,
            group: group.id,
            outcome: "read",
            callLines: false,
            relations: { head: null, base: null },
            sections: group.keys.map((key) => ({
              key,
              relations: "partial",
              rows: [
                {
                  kind: "test",
                  symbol: "count",
                  path: "tests/count.test.ts",
                  line: 2,
                  text: 'test("count", () => expect(count(["a", ""])).toBe(1));',
                  from: null,
                  confirmed: true,
                },
              ],
            })),
          })
        : undefined;
    const claims: Array<ReadingTaskResult["claims"][number]> = [];
    if (isCount) {
      defectKey = claimKey({
        path: "src/count.ts",
        side: at(1).side,
        startLine: at(1).line,
        endLine: at(1).line,
        text: MARKS.defect,
      });
      const checked = await storeValue(
        "test.claim",
        ClaimStored.parse({
          decision: "keep",
          reason: "the filter drops the empty string",
          claim: defectKey,
          section: at(1).key,
          source: "agent",
        }),
      );
      claims.push({
        key: defectKey,
        section: at(1).key,
        verifyKey: checked,
        reached: true,
      });
    }
    const completed = (
      kind: "assess" | "lane-review",
      key: string,
    ): TaskOutcome<ReadingTaskResult> => ({
      status: "completed",
      result: {
        kind,
        group: group.id,
        steps: [key],
        claims: kind === "lane-review" ? claims : [],
        stages: [recordOf(readingName(kind, group.id), key)],
        notJudged: [],
        ...(evidenceKey === undefined ? {} : { evidence: evidenceKey }),
      },
    });
    const isLabel = group.keys.some(
      (key) => sectionPath(key) === "src/label.ts",
    );
    readings.push({
      name: readingName("assess", group.id),
      outcome: completed("assess", assessKey),
    });
    readings.push({
      name: readingName("lane-review", group.id),
      outcome:
        !isLabel || options.label === undefined || options.label === "completed"
          ? completed("lane-review", reviewKey)
          : options.label === "failed"
            ? ({
                status: "failed",
                error: { message: "the reading failed" },
              } as TaskOutcome<unknown>)
            : options.label === "not-reached"
              ? ({
                  status: "aborted",
                  reason: "cutoff",
                  result: {
                    kind: "lane-review",
                    group: group.id,
                    steps: [],
                    claims: [],
                    stages: [],
                    notJudged: group.keys.map((section) => ({
                      section,
                      cause: "not-reached",
                    })),
                  },
                } as TaskOutcome<unknown>)
              : undefined,
    });
  }

  const incoming: CheckedCrossBatchClaim[] = [];
  if (options.incomingClaim === true) {
    const label = plan.sections.find(
      (section) => section.path === "src/label.ts",
    )!;
    const line = label.owned.find((range) => range.side === "new")!.startLine;
    const comment = {
      path: label.path,
      side: "new" as const,
      startLine: line,
      endLine: line,
      kind: "risk" as const,
      text: MARKS.incoming,
      fails: "",
    };
    const key = commentKey(comment);
    const verifyKey = await storeValue(
      "test.claim",
      ClaimStored.parse({
        decision: "keep",
        reason: "The changed line changes the plural rule.",
        claim: key,
        section: label.key,
        source: "agent",
      }),
    );
    incoming.push({
      key,
      target: {
        batch: batchKeyOf(map.groups[0]!.files.map(({ path }) => path)),
        section: label.key,
      },
      comment,
      verifyKey,
      from: "lane-review.other",
      answer: verifyKey,
    });
  }
  const registry = createRegistry();
  const services: StageServices = {
    ctx,
    runtimes: testRuntimes().registry,
    routes: {
      bindAgentRoute: async () => {
        throw new Error("no model in this test");
      },
      prepareFinalGeneration: async () => {},
    },
    capture: () => {},
    registry,
    integrations: { status: "absent", path: "(none)" },
    clients,
    run,
    endRound: async () => {},
  };
  const kinds = agentKinds(services, {
    prepare: async () => {
      throw new Error("no step runs in this test");
    },
  });
  const task = readingTask(services, kinds.agentStep);
  registry.install(
    defineExtension({
      name: "test.stages",
      tasks: [kinds.agentStep, task],
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  await harness.commit(async (tx) => {
    (await tx.doc(ReadingsRunDoc)).plan = planKey;
    return undefined;
  }, context);
  const port = readingsPort(services, task, PROBE);
  const keys = { frameKey, mapKey, manifestKey: manifest.key };
  const signal = new AbortController().signal;
  const batches = () =>
    port.batches(
      { ...keys, readings: readings.map(({ name }) => ({ name })) },
      harness,
      context,
      signal,
    );
  const settle = (
    batch: string,
    last = false,
    ends: {
      readonly final?: boolean;
    } = {},
  ) =>
    port.settle(
      {
        ...keys,
        batch,
        readings,
        incoming,

        final: ends.final ?? false,
        last,
      },
      harness,
      context,
      signal,
    );
  const collect = () =>
    port.collect({ ...keys, readings }, harness, context, signal);
  return {
    ctx,
    run,
    rows,
    plan,
    planKey,
    map,
    manifest: manifest.value,
    readings,

    defectKey,
    harness,
    batches,

    settle,
    collect,
  };
};

type Review = Awaited<ReturnType<typeof review>>;

/** Every batch of the review, settled as one waiter after another would settle it. */
const settledAll = async (world: Review) => {
  const listed = await world.batches();
  const out = [];
  for (const batch of listed.batches) out.push(await world.settle(batch.key));
  return { listed, out };
};

/** The settled batches; a test that expects every batch settled fails here otherwise. */
const allSettled = async (world: Review) => {
  const { listed, out } = await settledAll(world);
  const batches = out.map((one) => {
    if (!one.settled) throw new Error(`not settled: ${one.gap.detail}`);
    return one.batch;
  });
  return { listed, batches };
};

test.skipIf(graph.skip)(
  "every batch of a real review passes the publisher's schema and checks, and the real publisher publishes them all with nothing refused",
  async () => {
    graph.require();
    const world = await review("checks");
    const { listed, batches } = await allSettled(world);
    // The Map's two groups and the generated batch, in the Map's order.
    expect(listed.batches).toHaveLength(3);
    expect(batches.map((b) => b.title)).toEqual([
      "Counting",
      "Tests and assets",
      "Lockfiles and generated files",
    ]);
    for (const batch of batches) {
      expect(PublisherBatch.safeParse(batch).success).toBe(true);
      expect(checkBatch(batch)).toBeUndefined();
      // Every section in exactly one unit; a unit's sections share its lane; `entry.key` is the
      // identity's key; every owned line owned once (the publisher's checks, stated again).
      const keys = batch.units.flatMap((unit) => unit.sectionKeys);
      expect([...keys].sort()).toEqual(
        batch.sections.map((s) => s.identity.key).sort(),
      );
      for (const unit of batch.units)
        for (const key of unit.sectionKeys) {
          const section = batch.sections.find((s) => s.identity.key === key)!;
          expect(section.entry.lane.applied).toBe(unit.lane);
          expect(section.entry.key).toBe(section.identity.key);
        }
      const owned = new Set<string>();
      for (const section of batch.sections)
        for (const range of section.ownedRanges)
          if (range.kind === "lines")
            for (let line = range.startLine; line <= range.endLine; line++) {
              const at = `${range.path}:${range.side}:${line}`;
              expect(owned.has(at)).toBe(false);
              owned.add(at);
            }
      // The batch's key is the publisher's: the hash of its files.
      expect(listed.batches.map((b) => b.key)).toContain(
        batchKeyOf(batch.paths),
      );
    }
    // The real publisher, on a real Records store: every batch published, none refused.
    const store = scratch();
    const summary = await store.run(
      Effect.gen(function* () {
        const ctx = store.ctx();
        const first = yield* publishSettled(
          ctx,
          inputOf(batches, { totals: listed.totals, gaps: [...listed.gaps] }),
        );
        const ending = yield* publishSettled(
          ctx,
          inputOf([], {
            ending: true,
            totals: listed.totals,
            gaps: [...listed.gaps],
          }),
        );
        return { first, ending };
      }),
    );
    expect(summary.first.refused).toEqual([]);
    expect(summary.first.packetEventId).not.toBeNull();
    expect(summary.first.pending).toEqual({ batches: 0, sections: 0 });
    expect(summary.ending.complete).toBe(true);
    // Each shown or rested-on comment published, none withheld for a rule it breaks.
    expect(
      summary.first.findings.filter(
        (fate) => fate.fate === "withheld" && fate.reason !== "below-the-cut",
      ),
    ).toEqual([]);
    await world.harness.close(context);
  },
  120_000,
);

// Reason: the publisher writes what it is handed, so each field must be its true value.
test.skipIf(graph.skip)(
  "each field arrives with its true value: identity whole, owned ranges with paths, a whole binary range, comment text and about, an impact's summary, an incoming claim on the unit its anchor falls in, evidence as citations",
  async () => {
    graph.require();
    const world = await review("fields", { incomingClaim: true });
    const { batches } = await allSettled(world);
    const [counting, rest, generated] = batches as [
      PublisherBatch,
      PublisherBatch,
      PublisherBatch,
    ];
    const plannedOf = (key: string) =>
      [...world.plan.sections, ...world.plan.unread].find(
        (s) => s.key === key,
      )!;
    // Identity whole and title, from the plan.
    for (const batch of batches)
      for (const section of batch.sections) {
        const planned = plannedOf(section.identity.key);
        expect(section.identity).toEqual(
          JSON.parse(JSON.stringify(planned.identity)),
        );
        expect(section.title).toBe(planned.title);
      }
    // Owned ranges: each line range with its file's path and side, exactly the section's own rows.
    const count = counting.sections.find(
      (s) => s.identity.parts.path === "src/count.ts",
    )!;
    const plannedCount = plannedOf(count.identity.key);
    expect(count.ownedRanges).toEqual(
      plannedCount.owned.map((range) => ({
        kind: "lines",
        path: "src/count.ts",
        side: range.side,
        startLine: range.startLine,
        endLine: range.endLine,
      })),
    );
    // The binary file: one whole non-text range, no agent's decision, human-required.
    const logo = rest.sections.find(
      (s) => s.identity.parts.path === "assets/logo.png",
    )!;
    expect(logo.ownedRanges).toEqual([
      { kind: "whole-nontext", path: "assets/logo.png", side: "new" },
    ]);
    expect(logo.entry.undecided?.cause).toBe("unreadable");
    expect(logo.entry.lane.applied).toBe("human-required");
    // The lockfile: in the generated batch, excluded with code's reason.
    expect(generated.paths).toEqual(["bun.lock"]);
    expect(generated.sections[0]!.entry.excluded).toEqual({
      reason: "lockfile",
    });
    // Comments on count's unit: the defect (confirmed, rested on), the risk and the impact, with
    // their text, about and anchors on count's own lines.
    const countUnit = counting.units.find((u) => u.path === "src/count.ts")!;
    expect(countUnit.verdict).toBe("request-changes");
    const byBody = (body: string) =>
      countUnit.comments.find((c) => c.body === body);
    const defect = byBody(MARKS.defect)!;
    expect(defect).toMatchObject({
      id: world.defectKey,
      section: count.identity.key,
      kind: "defect",
      about: "code",
      restedOn: true,
      shown: true,
    });
    expect(defect.anchor?.path).toBe("src/count.ts");
    expect(byBody(MARKS.risk)).toMatchObject({ kind: "risk", about: "code" });
    const impact = byBody(MARKS.impact)!;
    expect(impact).toMatchObject({
      kind: "impact",
      effect: "narrowed",
      summary: summaryOf(MARKS.impact),
      about: "code",
    });
    // Evidence in Citation form: the step that read it, with the line cite as the entry.
    for (const comment of [defect, impact])
      for (const cite of comment.evidence)
        expect(cite.ref).toMatch(/^computation:[0-9a-f]{64}$/);
    expect(defect.evidence[0]?.entry).toMatch(/^src\/count\.ts:new:\d+-\d+$/);
    const labelUnit = counting.units.find((u) => u.path === "src/label.ts")!;
    const claim = labelUnit.comments.find((c) => c.body === MARKS.incoming)!;
    expect(claim).toMatchObject({
      kind: "risk",
      about: "code",
    });
    expect(claim.anchor?.path).toBe("src/label.ts");
    expect(claim.evidence).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^computation:[0-9a-f]{64}$/),
      }),
      expect.objectContaining({
        ref: expect.stringMatching(/^computation:[0-9a-f]{64}$/),
        entry: expect.stringMatching(/^h[0-9a-f]+$/),
      }),
    ]);
    expect(
      rest.units
        .flatMap((u) => u.comments)
        .some((c) => c.body === MARKS.incoming),
    ).toBe(false);
    await world.harness.close(context);
  },
  120_000,
);

// Reason: WP8's hazard: nobody may read a missing judgement as an agent's. A reading not reached,
// or not ended, holds its batch unpublished; a failed one is published only as no agent's decision.
test.skipIf(graph.skip)(
  "a reading not reached or not ended leaves its batch not settled with a gap; a failed one settles its sections only as human-required with no disposition and no agent's verdict",
  async () => {
    graph.require();
    for (const label of ["not-reached", "not-ended"] as const) {
      const world = await review(`held-${label}`, { label });
      const { listed, out } = await settledAll(world);
      const counting = out[0]!;
      expect(counting.settled).toBe(false);
      if (!counting.settled) {
        expect(counting.gap.kind).toBe("not-reached");
        expect(counting.gap.key).toMatch(/^batch-not-reached:b\.[0-9a-f]{16}$/);
      }
      // The other batches stand.
      expect(out[1]!.settled).toBe(true);
      expect(out[2]!.settled).toBe(true);
      // On the ending call of the last allowed run, the not-reached sections settle as
      // human-required, cause not-reached, with no disposition (2.4's table).
      if (label === "not-reached") {
        const last = await world.settle(listed.batches[0]!.key, true);
        expect(last.settled).toBe(true);
        if (last.settled) {
          const unit = last.batch.units.find((u) => u.path === "src/label.ts")!;
          expect(unit.lane).toBe("human-required");
          expect(unit.disposition).toBeUndefined();
          const section = last.batch.sections.find(
            (s) => s.identity.parts.path === "src/label.ts",
          )!;
          expect(section.entry.undecided).toEqual({
            cause: "not-reached",
            reading: "lane-review",
          });
        }
      }
      await world.harness.close(context);
    }
    const failed = await review("held-failed", { label: "failed" });
    const { batches } = await allSettled(failed);
    const unit = batches[0]!.units.find((u) => u.path === "src/label.ts")!;
    const section = batches[0]!.sections.find(
      (s) => s.identity.parts.path === "src/label.ts",
    )!;
    expect(section.entry.undecided).toEqual({
      cause: "failed",
      reading: "lane-review",
    });
    expect(section.entry.review).toBeNull();
    expect(unit.lane).toBe("human-required");
    expect(unit.verdict).toBeNull();
    expect(unit.disposition).toBeUndefined();
    expect(unit.proof).toEqual([]);
    expect(checkBatch(batches[0]!)).toBeUndefined();
    await failed.harness.close(context);
  },
  240_000,
);

// Reason (round 18): a partial drop is disclosed too. One reading failing in a group of two leaves
// that group's section to a person, with the builder's note, and the batch says which reading
// failed by its files; the other group is published as decided, and no other batch names a reading.
test.skipIf(graph.skip)(
  "one failed reading of two groups: its section goes to a person with the note, the other is decided, and a gap names the group",
  async () => {
    graph.require();
    const world = await review("dropped-one", { label: "failed" });
    const { listed, batches } = await allSettled(world);
    const counting = batches[0]!;
    expect(counting.title).toBe("Counting");
    const unitOf = (path: string) =>
      counting.units.find((unit) => unit.path === path)!;
    const sectionOf = (path: string) =>
      counting.sections.find((s) => s.identity.parts.path === path)!;
    expect(unitOf("src/label.ts")).toMatchObject({
      lane: "human-required",
      verdict: null,
    });
    expect(unitOf("src/label.ts").disposition).toBeUndefined();
    expect(sectionOf("src/label.ts").entry.undecided?.cause).toBe("failed");
    // The other group: decided by its readings, its request for changes on the confirmed defect.
    expect(sectionOf("src/count.ts").entry.undecided).toBeUndefined();
    expect(unitOf("src/count.ts").verdict).toBe("request-changes");
    const named =
      "Section readings: a reading of src/label.ts failed, so a person decides its section in this batch.";
    expect(
      (counting.gaps ?? [])
        .filter((gap) => gap.kind === "section-readings")
        .map((gap) => gap.detail),
    ).toEqual([named]);
    for (const batch of batches.slice(1))
      expect(
        (batch.gaps ?? []).some((gap) => gap.kind === "section-readings"),
      ).toBe(false);
    // The real publisher, on a real Records store: the packet carries the gap and the note.
    const store = scratch();
    const packet = await store.run(
      Effect.gen(function* () {
        const ctx = store.ctx();
        yield* publishSettled(
          ctx,
          inputOf(batches, { totals: listed.totals, gaps: [...listed.gaps] }),
        );
        const ending = yield* publishSettled(
          ctx,
          inputOf([], {
            ending: true,
            totals: listed.totals,
            gaps: [...listed.gaps],
          }),
        );
        return yield* PublishedPackets.readExact(ending.packetEventId!);
      }),
    );
    const gaps = (packet?.gaps ?? []).map((gap) => gap.payload);
    expect(
      gaps
        .filter((gap) => gap.kind === "section-readings")
        .map((g) => g.detail),
    ).toEqual([named]);
    expect(
      gaps
        .filter((gap) => gap.kind === "undecided-failed")
        .map((g) => g.detail),
    ).toEqual([
      'No agent decided one of the section of "label.ts: label" in this run, so a person decides it.',
    ]);
    await world.harness.close(context);
  },
  120_000,
);

// Reason: code decides lanes and dispositions, and a test is never evidence (14.19): the units'
// dispositions are `applyLane`'s on their own lanes and verdicts, and a test file in the change or a
// test row shown to the readings changes no lane, verdict or disposition of the code it names.
test.skipIf(graph.skip)(
  "dispositions are applyLane's on each unit's lane and verdict, and a test file or a test row changes none of the code's lanes or dispositions",
  async () => {
    graph.require();
    const plain = await review("rule-plain");
    const withTest = await review("rule-test", { withTest: true });
    const withRows = await review("rule-rows", { testRows: true });
    const decided = async (world: Review) => {
      const { batches } = await allSettled(world);
      await world.harness.close(context);
      return batches.flatMap((batch) => batch.units);
    };
    const units = {
      plain: await decided(plain),
      test: await decided(withTest),
      rows: await decided(withRows),
    };
    for (const unit of [...units.plain, ...units.test, ...units.rows])
      expect(unit.disposition).toBe(
        unit.verdict === null
          ? undefined
          : applyLane(unit.lane, unit.verdict).disposition,
      );
    const codeOf = (list: typeof units.plain) =>
      list
        .filter((unit) => unit.path.startsWith("src/"))
        .map((unit) => ({
          path: unit.path,
          lane: unit.lane,
          verdict: unit.verdict,
          disposition: unit.disposition ?? null,
        }));
    expect(codeOf(units.plain).length).toBeGreaterThan(0);
    expect(codeOf(units.test)).toEqual(codeOf(units.plain));
    expect(codeOf(units.rows)).toEqual(codeOf(units.plain));
    // The test file is in the change, declared a test by the repository, as its own unit.
    expect(units.test.some((unit) => unit.path === "tests/count.test.ts")).toBe(
      true,
    );
    expect(
      withTest.manifest.hunks
        .filter((hunk) => hunk.path === "tests/count.test.ts")
        .every((hunk) => hunk.declared.some((d) => d.kind === "test")),
    ).toBe(true);
  },
  240_000,
);

/**
 * Working words of the harness and the readings' fact sheet (`section-facts.ts`), which a person
 * must never read as a unit's description (decision 14.16).
 */
const HARNESS_WORDS = [
  /\bspan\b/i,
  /head span/i,
  /base span/i,
  /Graph's signature/i,
  /signature string/i,
  /declares no kind/i,
  /\bhunk/i,
  /\bold side\b/i,
  /\bnew side\b/i,
  /\bidentity key\b/i,
  /\bstructure\b/i,
];

// Reason: the desk leads a unit with its sections' facts, which a person reads as its description;
// they must be code's plain sentence of what changed (a removal first), never the readings' fact
// sheet, and nothing the publisher writes for the review may carry a harness word.
test.skipIf(graph.skip)(
  "each section's facts are code's plain sentence of its own lines, a removal first, and no published text holds a harness word",
  async () => {
    graph.require();
    const world = await review("facts", { removal: true });
    const { listed, batches } = await allSettled(world);
    const plural = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
    const count = (
      ranges: (typeof batches)[number]["sections"][number]["ownedRanges"],
      side: "old" | "new",
    ) =>
      ranges.reduce(
        (sum, r) =>
          r.kind === "lines" && r.side === side
            ? sum + r.endLine - r.startLine + 1
            : sum,
        0,
      );
    const texts: Array<string> = [];
    let removals = 0;
    for (const batch of batches) {
      texts.push(batch.digest.text, batch.title, batch.focus);
      for (const section of batch.sections) {
        const text = section.content!.facts.text;
        texts.push(text, section.title);
        const added = count(section.ownedRanges, "new");
        const removed = count(section.ownedRanges, "old");
        const what =
          added > 0 && removed > 0
            ? `${plural(added)} added and ${removed} removed`
            : added > 0
              ? `${plural(added)} added`
              : removed > 0
                ? `${plural(removed)} removed`
                : "a change with no text lines";
        const line = `${section.title}: ${what}.`;
        const planned = [...world.plan.sections, ...world.plan.unread].find(
          (s) => s.key === section.identity.key,
        )!;
        // The readings' fact sheet is there for the models, and none of it reaches the facts.
        for (const fact of planned.facts)
          expect(text).not.toContain(fact.statement);
        if (section.identity.parts.side === "old" && added === 0) {
          removals++;
          expect(text).toBe(
            `This change removes ${section.title} (${plural(removed)}).`,
          );
        } else expect(text).toBe(line);
        expect(section.content!.facts.cites).toEqual(
          planned.hunkIds.slice(0, 6),
        );
      }
    }
    // The removed function is one of them.
    expect(removals).toBe(1);
    // The texts the review's packet carries, as the real publisher writes them.
    const store = scratch();
    const events = await store.run(
      Effect.gen(function* () {
        const ctx = store.ctx();
        yield* publishSettled(
          ctx,
          inputOf(batches, {
            ending: true,
            totals: listed.totals,
            gaps: [...listed.gaps],
          }),
        );
        return yield* eventsOf(ctx.cycleId);
      }),
    );
    expect(events.length).toBeGreaterThan(0);
    for (const event of events)
      if (event.kind.startsWith("unit.recorded"))
        texts.push(JSON.stringify(event.payload));
    for (const text of texts)
      for (const word of HARNESS_WORDS) expect(text).not.toMatch(word);
    await world.harness.close(context);
  },
  120_000,
);

// Reason (NEU-446): code once said a removed declaration "adds nothing in its place" from the
// section's own lines, so a function moved to another file, or a component whose callers now render
// something else, read as a loss. On a real range planting both shapes beside a dead-code deletion,
// nothing published may claim an absence, and every removal must still be said, on its facts line
// and in code's removal comment, which is what the batch card and digest lead with (decision 13.20).
test.skipIf(graph.skip)(
  "a moved function and a replaced component claim no absence, and every removed declaration, a dead one too, still shows its removal",
  async () => {
    graph.require();
    const world = await review("planted", { removal: true, planted: true });
    const { batches } = await allSettled(world);
    expect(JSON.stringify(batches)).not.toContain("in its place");
    const removals = batches.flatMap((batch) =>
      batch.sections.filter(
        (section) =>
          section.identity.parts.side === "old" &&
          section.ownedRanges.every(
            (range) => range.kind === "lines" && range.side === "old",
          ),
      ),
    );
    expect(removals.map((section) => section.title).sort()).toEqual([
      "Panel in panel.ts",
      "drop in gone.ts",
      "shout in text.ts",
    ]);
    const lines = {
      "Panel in panel.ts": 4,
      "drop in gone.ts": 5,
      "shout in text.ts": 5,
    };
    for (const section of removals) {
      const sentence = `This change removes ${section.title} (${lines[section.title as keyof typeof lines]} lines).`;
      expect(section.content!.facts.text).toBe(sentence);
      const comments = batches.flatMap((batch) =>
        batch.units.flatMap((unit) =>
          unit.comments.filter(
            (comment) => comment.section === section.identity.key,
          ),
        ),
      );
      expect(
        comments
          .filter(
            (comment) =>
              comment.kind === "impact" && comment.effect === "removed",
          )
          .map((comment) => comment.body),
      ).toEqual([sentence]);
    }
    await world.harness.close(context);
  },
  120_000,
);

// Reason: one hunk can sit in two sections and two units (a function's section takes rows from a
// hunk that spans two declarations); a section's owned ranges must be its own rows, never the whole
// hunk, or a line is owned twice and the units' counts double it.
test.skipIf(graph.skip)(
  "a hunk over two declarations splits into two sections in two units, each owning only its own rows, every row of the hunk owned once",
  async () => {
    graph.require();
    const world = await review("pair", { pair: true });
    const { batches } = await allSettled(world);
    const hunks = world.manifest.hunks.filter((h) => h.path === "src/pair.ts");
    // The case itself: one hunk, two sections, two units of that one file.
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    const counting = batches[0]!;
    expect(checkBatch(counting)).toBeUndefined();
    const sections = counting.sections.filter(
      (s) => s.identity.parts.path === "src/pair.ts",
    );
    expect(sections).toHaveLength(2);
    const units = counting.units.filter((u) => u.path === "src/pair.ts");
    expect(units).toHaveLength(2);
    expect(new Set(units.map((u) => u.lane)).size).toBe(2);
    /** Each changed line of a set of line ranges on `src/pair.ts`, as `side:line`. */
    const linesOf = (
      ranges: ReadonlyArray<{
        readonly side: string;
        readonly startLine: number;
        readonly endLine: number;
      }>,
    ) =>
      ranges.flatMap((range) =>
        Array.from(
          { length: range.endLine - range.startLine + 1 },
          (_, at) => `${range.side}:${range.startLine + at}`,
        ),
      );
    const linesOfOwned = (ranges: ReadonlyArray<OwnedRange>) =>
      linesOf(
        ranges.flatMap((range) =>
          range.kind === "lines" && range.path === "src/pair.ts" ? [range] : [],
        ),
      );
    // The hunk's own changed ranges, as the review rules give them.
    const whole = linesOf(
      hunk.ownedRanges.map((range) => ({
        side: range.side,
        startLine: range.startLine,
        endLine: range.startLine + range.lineCount - 1,
      })),
    );
    expect(whole.length).toBeGreaterThan(2);
    // Each section owns only its own rows: some of the hunk's, never all of them, and exactly the
    // rows the plan gave it.
    for (const section of sections) {
      expect(section.ownedRanges.every((r) => r.kind === "lines")).toBe(true);
      const own = linesOfOwned(section.ownedRanges);
      expect(own.length).toBeGreaterThan(0);
      expect(own.length).toBeLessThan(whole.length);
      for (const line of own) expect(whole).toContain(line);
      const planned = world.plan.sections.find(
        (s) => s.key === section.identity.key,
      )!;
      expect(own).toEqual(linesOf(planned.owned));
    }
    // No row owned twice, and together they own every row of the hunk.
    const owned = sections.flatMap((section) =>
      linesOfOwned(section.ownedRanges),
    );
    expect(new Set(owned).size).toBe(owned.length);
    expect([...owned].sort()).toEqual([...whole].sort());
    // The units' line counts, as the publisher counts them (`unit.recorded@3`'s `ranges.lines`),
    // add up to the hunk's lines exactly once.
    const byKey = new Map(counting.sections.map((s) => [s.identity.key, s]));
    const counted = units.map(
      (unit) => rangeCounts(unitSections(unit, byKey)).lines,
    );
    expect(counted.every((n) => n > 0)).toBe(true);
    expect(counted.reduce((a, b) => a + b, 0)).toBe(whole.length);
    await world.harness.close(context);
  },
  120_000,
);

// Reason: the probe keeps what it stores and writes; `settle` and `batches` store nothing, write no
// row and give, for each batch, exactly what `collect` stores for it, and the run's gaps it finds
// (a verified finding no batch holds is disclosed on the ending call, never dropped).
test.skipIf(graph.skip)(
  "batches and settle write nothing and agree with what collect stores, its run gaps included; collect's decision is unchanged by them",
  async () => {
    graph.require();
    const world = await review("agree");
    const { batches } = await allSettled(world);
    expect(world.rows).toEqual([]);
    await world.collect();
    const decisionKey = decisionKeyOf(world.ctx.log);
    expect(decisionKey).not.toBeNull();
    const stored = await settledOf(
      { ctx: world.ctx as never, run: world.run },
      decisionKey!,
    );
    const strip = (batch: (typeof stored.batches)[number]) => {
      const { withheld: _withheld, ...rest } = batch;
      return JSON.parse(JSON.stringify(rest));
    };
    expect(batches).toEqual(stored.batches.map(strip));
    expect((await world.batches()).gaps).toEqual(stored.gaps);
    const rowCount = world.rows.length;
    // Settling again after collect writes nothing more and gives the same batches.
    expect((await allSettled(world)).batches).toEqual(batches);
    expect(world.rows.length).toBe(rowCount);
    await world.harness.close(context);
  },
  120_000,
);
