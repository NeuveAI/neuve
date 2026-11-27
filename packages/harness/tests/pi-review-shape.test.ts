import { LaneReviewStored } from "../src/readings/steps.ts";
import { UnitSections } from "@neuve/records-schema";
// Run the production task graph and publisher on a committed range with a scripted model.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { AssembledBatch } from "../src/compose.ts";
import {
  runReview,
  textOf,
  toolTurn,
  type Answer,
} from "./fixtures/pi-review.ts";

const directory =
  process.env.SHAPE_EVIDENCE_DIRECTORY ??
  mkdtempSync(join(tmpdir(), "pi-review-shape-"));
afterAll(() => {
  if (!process.env.SHAPE_EVIDENCE_DIRECTORY)
    rmSync(directory, { recursive: true, force: true });
});
const base = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [
    `src/limit${i + 1}.ts`,
    `export const limit${i + 1} = 1;\n`,
  ]),
);
const head = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => [
    `src/limit${i + 1}.ts`,
    `export const limit${i + 1} = 2;\n`,
  ]),
);

const answerer = (): Answer => {
  const turns = new Map<string, number>();
  return (agent, _messages, hunks) => {
    const turn = (turns.get(agent) ?? 0) + 1;
    turns.set(agent, turn);
    const submit = (
      name: string,
      args: Parameters<typeof toolTurn>[0][number]["args"],
    ) => toolTurn([{ name, id: `${agent}-${turn}`, args }]);
    if (agent === "frame")
      return submit("submit_frame", {
        goal: "Raise the limits",
        stratum: "nothing",
        sourceIds: [],
        doneWhen: [
          { text: "The limits are two.", candidateId: null, sectionId: null },
        ],
      });
    if (agent === "map")
      return submit("submit_map", {
        groups: [
          {
            label: "Raise limits",
            why: "The changed constants raise the limits.",
            tier: "core",
            doneWhen: ["D1"],
            entries: hunks.map((_, i) => `f${i + 1}`),
          },
        ],
      });
    if (agent.startsWith("assess."))
      return submit("submit_assess", {
        classes: [],
        factors: [],
        requirements: [],
        impact: [],
      });
    if (agent.startsWith("lane-review."))
      return submit("submit_review", {
        files: [],
        sections: { a: [], r: [], u: [] },
        comments: [],
        unsure: [],
        notAsked: [],
        crossBatchClaims: [],
      });
    if (agent.startsWith("brief.")) return fauxAssistantMessage("No briefing.");
    throw new Error(`No fixture answer for ${agent}`);
  };
};
const run = (
  name: string,
  options: Partial<Parameters<typeof runReview>[0]> = {},
) =>
  runReview({
    directory: join(directory, name),
    base,
    head,
    message: "Raise limits to two",
    answer: answerer(),
    ...options,
  });

const coverage = async (
  result: Awaited<ReturnType<typeof runReview>>,
  pending = false,
) => {
  const linked = await result.lookup("harness.linked-batch");
  const outputs = await Promise.all(
    linked.map((r) => result.read(r.key, AssembledBatch)),
  );
  expect(
    [
      ...new Set(outputs.flatMap((o) => o.units.flatMap((u) => u.hunkIds))),
    ].sort(),
  ).toEqual(result.manifest.hunks.map((h) => h.hunkId).sort());
  if (pending) {
    expect(
      result.publicationHistory.some(
        ({ event }) =>
          event.kind === "packet.published@2" &&
          event.payload.counts.pending.sections > 0,
      ),
    ).toBe(true);
    return;
  }
  const recorded = (
    await Promise.all(
      result.publicationHistory.map(async ({ event }) => {
        if (event.kind === "unit.recorded@2") return event.payload.ownedRanges;
        if (event.kind !== "unit.recorded@3") return [];
        const unit = UnitSections.parse(
          await result.readBlob(event.refs[0].ref.slice(5)),
        );
        return unit.sections.flatMap((section) => section.ownedRanges);
      }),
    )
  ).flat();
  const key = (path: string, side: string, start: number, count: number) =>
    `${path}:${side}:${start}:${count}`;
  expect(
    recorded
      .map((range) =>
        range.kind === "lines"
          ? key(
              range.path,
              range.side,
              range.startLine,
              range.endLine - range.startLine + 1,
            )
          : `${range.path}:${range.side}:nontext`,
      )
      .sort(),
  ).toEqual(
    result.manifest.hunks
      .flatMap((hunk) =>
        hunk.ownedRanges.map((range) =>
          key(hunk.path, range.side, range.startLine, range.lineCount),
        ),
      )
      .sort(),
  );
  expect(
    result.publicationHistory.some(
      (e) =>
        e.event.kind === "packet.published@1" ||
        e.event.kind === "packet.published@2",
    ),
  ).toBe(true);
};

// Why: a finder with no returned result cannot count as a completed search.

test("aborting the review publishes nothing", async () => {
  const result = await run("abort", { abortReview: true });
  expect(result.outcome.status).toBe("aborted");
  expect(result.timeline.map((t) => t.event)).not.toContain("publish");
  expect(
    result.publicationHistory.filter(
      (e) => e.event.kind === "packet.published@1",
    ),
  ).toHaveLength(0);
}, 60_000);

test("reaching C before front uses code fallbacks and still records the inline fill", async () => {
  const result = await run("front-cutoff", { cutoffAfterMs: 0 });
  expect(result.outcome.status).toBe("completed");
  expect(result.sent).toHaveLength(0);
  expect(
    result.outcome.status === "completed"
      ? result.outcome.result.stages.some((r) => r.agent === "link.fill")
      : false,
  ).toBe(true);
  await coverage(result, true);
}, 60_000);

// Why (NEU-148): no review step reads the leads, so Frame, Map and Publish must all run while they
// are still being searched; and the review owns that work, so it must not end before it does, or
// the leads would stop being stored.
test("Frame, Map and Publish run while the range's leads are held, and the review ends only after them", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let leadsStored = false;
  let storedAtPublish: boolean | undefined;
  const seen: Array<{ agent: string; leadsStored: boolean }> = [];
  const answer = answerer();
  const result = await run("leads-held", {
    answer: (agent, messages, hunks) => {
      seen.push({ agent, leadsStored });
      return answer(agent, messages, hunks);
    },
    onPublish: () => {
      storedAtPublish = leadsStored;
      release();
    },
    leads: (compute) =>
      Effect.andThen(
        Effect.promise(() => held),
        Effect.tap(compute, () =>
          Effect.sync(() => {
            leadsStored = true;
          }),
        ),
      ),
  });
  expect(result.outcome.status).toBe("completed");
  expect(seen.filter((s) => s.agent === "frame" || s.agent === "map")).toEqual([
    { agent: "frame", leadsStored: false },
    { agent: "map", leadsStored: false },
  ]);
  // Publish started while the leads were still held: it waited for nothing they do.
  expect(storedAtPublish).toBe(false);
  // The review's end (the fixture waits for it to be terminal) came after the leads were stored.
  expect(leadsStored).toBe(true);
  const review = result.tasks.find((t) => t.kind === "neuve.review")!;
  const leads = result.tasks.filter((t) => t.kind === "neuve.leads");
  expect(leads).toHaveLength(1);
  expect(Number(leads[0]!.owner)).toBe(Number(review.id));
  expect(leads[0]!.state.status).toBe("terminal");
  const records = result.log.read();
  const at = (match: (record: (typeof records)[number]) => boolean) =>
    records.findIndex(match);
  expect(
    at((r) => r.type === "progress" && r["message"] === "publish: started"),
  ).toBeLessThan(
    at((r) => r.type === "range.leads" && r["status"] === "computed"),
  );
  await coverage(result);
}, 60_000);

// Why (NEU-148): the leads task exists so Frame waits for neither the leads nor the head tree's
// index. Release the index at Map, since the later readings can need it, and hold the leads until
// Publish. A Frame or Map that waited for either would never be sent.
test("Frame and Map are sent while the head-index prefetch and the leads are both held", async () => {
  let releaseIndex = () => {};
  const indexHeld = new Promise<void>((resolve) => {
    releaseIndex = resolve;
  });
  let releaseLeads = () => {};
  const leadsHeld = new Promise<void>((resolve) => {
    releaseLeads = resolve;
  });
  let chunksEntered = 0;
  let chunksDone = 0;
  let leadsStoredAtPublish: boolean | undefined;
  let doneAtLeads: number | undefined;
  let leadsStored = false;
  const seen: Array<{
    agent: string;
    chunksDone: number;
    leadsStored: boolean;
  }> = [];
  const answer = answerer();
  // A file no other test in this file has, so the head tree's index is not already in memory.
  const unique = { "notes/prefetch-held.txt": "held until Map\n" };
  const result = await run("prefetch-held", {
    base: { ...base, ...unique },
    head: { ...head, ...unique },
    answer: (agent, messages, hunks) => {
      seen.push({ agent, chunksDone, leadsStored });
      if (agent === "map") releaseIndex();
      return answer(agent, messages, hunks);
    },
    onPublish: () => {
      leadsStoredAtPublish = leadsStored;
      releaseLeads();
    },
    chunks: {
      paths: Object.keys(unique),
      wrap: (compute) =>
        Effect.andThen(
          Effect.sync(() => {
            chunksEntered++;
          }),
          Effect.andThen(
            Effect.promise(() => indexHeld),
            Effect.tap(compute, () =>
              Effect.sync(() => {
                chunksDone++;
              }),
            ),
          ),
        ),
    },
    leads: (compute) =>
      Effect.andThen(
        Effect.sync(() => {
          doneAtLeads = chunksDone;
        }),
        Effect.andThen(
          Effect.promise(() => leadsHeld),
          Effect.tap(compute, () =>
            Effect.sync(() => {
              leadsStored = true;
            }),
          ),
        ),
      ),
  });
  expect(result.outcome.status).toBe("completed");
  expect(seen.filter((s) => s.agent === "frame" || s.agent === "map")).toEqual([
    { agent: "frame", chunksDone: 0, leadsStored: false },
    { agent: "map", chunksDone: 0, leadsStored: false },
  ]);
  expect(leadsStoredAtPublish).toBe(false);
  // The head index goes first (NEU-148): the leads computation starts only once the prefetch has
  // ended, so the held blob was already chunked when it started. Started beside the prefetch, it
  // would have started while the blob was still held.
  expect(doneAtLeads).toBeGreaterThan(0);
  // The hold was real: the held blob was chunked only after Map, and the prefetch built
  // the head tree's index (not from memory), so it needed that blob and was held with it.
  expect(chunksEntered).toBeGreaterThan(0);
  expect(chunksDone).toBeGreaterThan(0);
  expect(leadsStored).toBe(true);
  const records = result.log.read();
  expect(
    records.some((r) => r.type === "index.prefetch" && r["ok"] === false),
  ).toBe(false);
  expect(
    records
      .filter(
        (r) => r.type === "span" && r["name"] === "harness.index.prefetch",
      )
      .map((r) => r["attributes"]),
  ).toEqual([
    expect.objectContaining({
      "harness.revision": "head",
      "harness.outcome": "ready",
      "harness.index.from_memory": false,
    }),
  ]);
}, 60_000);

// Why (NEU-148): the leads wait for the head-index prefetch to end, and a failed one must not skip
// them: it is written and dropped, and the leads start after it. Nothing else would notice a change
// that starts them beside the prefetch again, or only after a ready one.
test("a failed head-index prefetch is written and dropped, and the leads start after it", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failed = 0;
  let failedAtLeads: number | undefined;
  // A file no other test in this file has, so the head tree's index is not already in memory.
  const unique = { "notes/prefetch-failed.txt": "fails once\n" };
  const result = await run("prefetch-failed", {
    base: { ...base, ...unique },
    head: { ...head, ...unique },
    answer: (() => {
      const answer = answerer();
      return (agent, messages, hunks) => {
        if (agent === "map") release();
        return answer(agent, messages, hunks);
      };
    })(),
    chunks: {
      paths: Object.keys(unique),
      // The first chunking of the blob is held until Map and then fails, so the head tree's
      // index fails; every later chunking (the base tree's index, in the leads) computes.
      wrap: <A, E, R>(compute: Effect.Effect<A, E, R>) =>
        Effect.suspend((): Effect.Effect<A, unknown, R> =>
          failed > 0
            ? compute
            : Effect.andThen(
                Effect.promise(() => held),
                Effect.suspend(() => {
                  failed++;
                  return Effect.fail(new Error("chunk fixture failure"));
                }),
              ),
        ),
    },
    leads: (compute) =>
      Effect.andThen(
        Effect.sync(() => {
          failedAtLeads = failed;
        }),
        compute,
      ),
  });
  expect(result.outcome.status).toBe("completed");
  expect(failed).toBe(1);
  // Started beside the prefetch, the leads would have started before the held chunking failed.
  expect(failedAtLeads).toBe(1);
  const records = result.log.read();
  expect(records).toContainEqual(
    expect.objectContaining({
      type: "index.prefetch",
      revision: "head",
      ok: false,
    }),
  );
  expect(
    records
      .filter(
        (r) => r.type === "span" && r["name"] === "harness.index.prefetch",
      )
      .map((r) => r["attributes"]),
  ).toEqual([
    expect.objectContaining({
      "harness.revision": "head",
      "harness.outcome": "failed",
    }),
  ]);
  expect(records).toContainEqual(
    expect.objectContaining({ type: "range.leads", status: "computed" }),
  );
  const leads = result.tasks.find((t) => t.kind === "neuve.leads")!;
  expect(leads.state.status === "terminal" && leads.state.outcome.status).toBe(
    "completed",
  );
  await coverage(result);
}, 60_000);

// Why (NEU-148): lead search has no reader in the review, so its failure must never fail it or
// change what it publishes; its end is in the run log, not on the reader's surface.
test("a failed lead search still publishes every hunk, and the packet says nothing of it", async () => {
  const result = await run("leads-failed", {
    leads: (compute) =>
      Effect.andThen(compute, Effect.fail(new Error("leads fixture failure"))),
  });
  expect(result.outcome.status).toBe("completed");
  expect(result.log.read()).toContainEqual(
    expect.objectContaining({ type: "range.leads", status: "failed" }),
  );
  expect(
    result.publicationHistory.some(
      (e) =>
        e.event.kind === "gap.disclosed@1" &&
        (e.event.payload as { kind?: string }).kind === "leads",
    ),
  ).toBe(false);
  await coverage(result);
}, 60_000);

// Why (NEU-148): stopping a review must end the leads work it owns, logged, and publish nothing.
test("stopping the review while its leads run aborts them and publishes nothing", async () => {
  const result = await run("leads-stopped", {
    abortReview: true,
    // Held for good: only the stop ends it.
    leads: (compute) =>
      Effect.andThen(
        Effect.promise(() => new Promise<void>(() => {})),
        compute,
      ),
  });
  expect(result.outcome.status).toBe("aborted");
  const leads = result.tasks.find((t) => t.kind === "neuve.leads")!;
  expect(leads.state.status).toBe("terminal");
  expect(
    leads.state.status === "terminal" ? leads.state.outcome.status : undefined,
  ).toBe("aborted");
  expect(result.log.read()).toContainEqual(
    expect.objectContaining({ type: "range.leads", status: "stopped" }),
  );
  expect(
    result.publicationHistory.filter(
      (e) => e.event.kind === "packet.published@1",
    ),
  ).toHaveLength(0);
}, 60_000);

// Why (NEU-148): the waits a review's timings are read from are these records and spans; nothing
// else asserts them. Counts, kinds, keys and task IDs only.

// Why: a replay between logging the schedule and committing children must not double-count it.

// Both files are in one directory, so only Map's batches keep their readings apart.
// Keep the second reviewer open until the first batch reaches Records.
test("batch reviewers verify claims and leave published batches unchanged", async () => {
  const paths = ["src/first.ts", "src/second.ts"];
  const earlyText = "The second constant can now be zero.";
  const lateText = "The first constant can now be zero.";
  const { promise: firstPublished, resolve: openSecond } =
    Promise.withResolvers<void>();
  const laneViews: string[] = [];
  const verifyViews: string[] = [];
  const fallback = answerer();
  const result = await runReview({
    directory: join(directory, "cross-batch"),
    base: {
      [paths[0]!]: "export const first = 1;\n",
      [paths[1]!]: "export const second = 1;\n",
    },
    head: {
      [paths[0]!]: "export const first = 0;\n",
      [paths[1]!]: "export const second = 0;\n",
    },
    message: "Split the two changes",
    afterBatchPublished: (index) => {
      if (index === 0) openSecond();
    },
    answer: async (agent, messages, hunks) => {
      if (agent === "map")
        return toolTurn([
          {
            name: "submit_map",
            id: "map",
            args: {
              groups: [
                {
                  label: "First limit",
                  why: "Change the first limit.",
                  tier: "core",
                  doneWhen: ["D1"],
                  entries: ["f1"],
                },
                {
                  label: "Second limit",
                  why: "Change the second limit.",
                  tier: "core",
                  doneWhen: ["D1"],
                  entries: ["f2"],
                },
              ],
            },
          },
        ]);
      if (agent.startsWith("lane-review.")) {
        const text = textOf(messages);
        laneViews.push(text);
        const readsFirst = text.includes("export const first");
        if (!readsFirst) await firstPublished;
        return toolTurn([
          {
            name: "submit_review",
            id: agent,
            args: {
              sections: { a: [], r: [], u: [1] },
              files: [
                {
                  f: 1,
                  checked: "Checked the new value.",
                  rows: [
                    {
                      row: "D1",
                      status: "no-evidence",
                      reading: "",
                      cites: [],
                    },
                  ],
                },
              ],
              comments: [],
              unsure: [{ s: 1, t: "The caller is unavailable." }],
              notAsked: [],
              crossBatchClaims: [
                {
                  path: (readsFirst ? paths[1] : paths[0])!,
                  side: "new",
                  startLine: 1,
                  endLine: 1,
                  kind: "defect",
                  text: readsFirst ? earlyText : lateText,
                  fails: "A caller dividing by the constant divides by zero.",
                },
              ],
            },
          },
        ]);
      }
      if (agent.startsWith("verify.claim.")) {
        verifyViews.push(textOf(messages));
        return toolTurn([
          {
            name: "submit_verify",
            id: agent,
            args: {
              decision: "keep",
              reason: "The pinned source shows the constant is zero.",
            },
          },
        ]);
      }
      return fallback(agent, messages, hunks);
    },
  });
  expect(result.outcome.status).toBe("completed");
  expect(result.sent.some(({ agent }) => agent.startsWith("find."))).toBe(
    false,
  );
  expect(
    laneViews.filter((view) => view.includes("export const first")),
  ).toHaveLength(1);
  expect(
    laneViews.filter((view) => view.includes("export const second")),
  ).toHaveLength(1);
  expect(
    laneViews.every(
      (view) =>
        view.includes("export const first") !==
        view.includes("export const second"),
    ),
  ).toBe(true);
  expect(verifyViews).toHaveLength(2);
  expect(
    verifyViews.some(
      (view) =>
        view.includes(earlyText) && view.includes("export const second = 0;"),
    ),
  ).toBe(true);
  expect(
    verifyViews.some(
      (view) =>
        view.includes(lateText) && view.includes("export const first = 0;"),
    ),
  ).toBe(true);
  const comments = result.publicationHistory.flatMap(({ event }) =>
    event.kind === "comment.recorded@3" ? [event.payload] : [],
  );
  expect(
    comments.filter((comment) => comment.body.includes(earlyText)),
  ).toHaveLength(1);
  expect(comments.some((comment) => comment.body.includes(lateText))).toBe(
    false,
  );
  const retained = result.log
    .read()
    .filter(({ type }) => type === "review.claim-unpublished");
  expect(retained).toEqual([
    expect.objectContaining({
      reason: "batch-published",
      anchor: expect.objectContaining({ path: paths[0] }),
      kind: "defect",
    }),
  ]);
  const lateAnswer = await result.read(
    String(retained[0]!["answer"]),
    LaneReviewStored,
  );
  expect(lateAnswer.answer.crossBatchClaims).toEqual([
    expect.objectContaining({
      path: paths[0],
      text: lateText,
    }),
  ]);
}, 60_000);
