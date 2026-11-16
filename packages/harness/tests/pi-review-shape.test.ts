// Why (12.41): the task cutover must preserve coverage through interruption and obey a fixed call
// budget. Run the production graph and publisher on a real range with only the model replaced.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { FINDERS, FindStored } from "../src/find.ts";
import type { StageRecord } from "../src/pipeline.ts";
import type { FinderResult } from "../src/pi/stages/finder-task.ts";
import { claimKeyOf, VerifyStored } from "../src/verify.ts";
import { AssembledBatch } from "../src/compose.ts";
import { ReviewMap } from "../src/review-map.ts";
import { runReview, toolTurn, type Answer } from "./fixtures/pi-review.ts";

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

const answerer = (fullBudget = false): Answer => {
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
    if (agent.startsWith("find.")) {
      if (fullBudget && turn <= 11)
        return submit("hunk", { id: hunks[0]!.hunkId, page: null });
      const output = {
        findings: fullBudget
          ? hunks.map((h) => ({
              claim: `The limit at ${h.path} is two.`,
              kind: "defect",
              about: "code",
              signal: null,
              critical: false,
              anchors: [
                { path: h.path, side: "new", startLine: 1, endLine: 1 },
              ],
              doneWhen: "D1",
              evidence: [h.hunkId],
            }))
          : [],
        notes: [],
        ...(agent === "find.scope-fit"
          ? {
              conditions: [
                {
                  doneWhen: "D1",
                  verdict: "needs-human",
                  anchors: [],
                  note: "Check the new limits.",
                },
              ],
            }
          : {}),
      };
      return fullBudget
        ? fauxAssistantMessage(JSON.stringify(output))
        : submit("submit_find", output);
    }
    if (agent.startsWith("verify."))
      return submit("submit_verify", {
        decision: "keep",
        reason: "The cited line sets the limit to two.",
      });
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

const coverage = async (result: Awaited<ReturnType<typeof runReview>>) => {
  const linked = await result.lookup("harness.linked-batch");
  const outputs = await Promise.all(
    linked.map((r) => result.read(r.key, AssembledBatch)),
  );
  expect(
    [
      ...new Set(outputs.flatMap((o) => o.units.flatMap((u) => u.hunkIds))),
    ].sort(),
  ).toEqual(result.manifest.hunks.map((h) => h.hunkId).sort());
  const recorded = result.publicationHistory.flatMap((entry) =>
    entry.event.kind === "unit.recorded@2"
      ? entry.event.payload.ownedRanges
      : [],
  );
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
      (e) => e.event.kind === "packet.published@1",
    ),
  ).toBe(true);
};

test("precompute, front, four concurrent finders with fill, link and publish use at most 70 calls", async () => {
  const result = await run("full", { answer: answerer(true) });
  expect(result.outcome.status).toBe("completed");
  expect(result.reports).toEqual([]);
  expect(
    result.stageOutputs.lines.some((line) =>
      line.startsWith("Frame: 1 done-when"),
    ),
  ).toBe(true);
  expect(
    result.stageOutputs.lines.some((line) => line.startsWith("Map: 1 groups")),
  ).toBe(true);
  expect(
    result.stageOutputs.lines.filter((line) => line.startsWith("verify.")),
  ).toHaveLength(20);
  // Why: the stage lines judge a Verify used by keying each final finding's claim with the Frame
  // key Front recorded. In a whole review that must be the key the finders' Verifies were keyed
  // with, or every Verify would fall to the lines' fail-open rule unseen.
  const frontRecord = result.tasks.find((t) => t.kind === "neuve.front")!;
  const frontResult = (
    frontRecord.state as {
      outcome?: { result?: { frameKey?: string; stages?: StageRecord[] } };
    }
  ).outcome?.result;
  const frameKey = frontResult?.frameKey;
  expect(frameKey).toBeString();
  expect(
    frontResult?.stages?.some((s) => s.agent === "frame" && s.key === frameKey),
  ).toBe(true);
  let verdicts = 0;
  for (const task of result.tasks.filter((t) => t.kind === "neuve.finder")) {
    const finder = (task.state as { outcome?: { result?: FinderResult } })
      .outcome?.result;
    if (finder?.findKey == null) continue;
    const final = await result.read(finder.findKey, FindStored);
    for (const found of finder.findings) {
      const finding = final.findings.find((f) => f.id === found.id)!;
      const verdict = await result.read(found.verifyKey!, VerifyStored);
      expect(verdict.finding).toBe(claimKeyOf(frameKey!, finding));
      verdicts++;
    }
  }
  expect(verdicts).toBe(20);
  expect(
    result.stageOutputs.lines.filter((line) => line.includes("not used")),
  ).toEqual([]);
  const review = result.tasks.find((t) => t.kind === "neuve.review")!;
  const front = result.tasks.filter((t) => t.kind === "neuve.front");
  const finders = result.tasks.filter((t) => t.kind === "neuve.finder");
  expect(front).toHaveLength(1);
  expect(finders).toHaveLength(4);
  for (const child of [...front, ...finders])
    expect(Number(child.owner)).toBe(Number(review.id));
  expect(result.sent.filter((s) => s.agent === "frame")).toHaveLength(1);
  expect(result.sent.filter((s) => s.agent === "map")).toHaveLength(1);
  for (const lens of FINDERS)
    expect(result.sent.filter((s) => s.agent === `find.${lens}`)).toHaveLength(
      12,
    );
  expect(result.sent.filter((s) => s.agent.startsWith("verify."))).toHaveLength(
    20,
  );
  expect(result.sent).toHaveLength(1 + 1 + 4 * 12 + 20);
  expect(await result.lookup("harness.code-fill")).toHaveLength(1);
  expect(
    result.log.read().filter((r) => r.type === "finder.result"),
  ).toHaveLength(4);
  expect(result.log.read().filter((r) => r.type === "finding")).toHaveLength(
    20,
  );
  expect(
    result.log
      .read()
      .filter((r) => r.type === "span" && r["name"] === "harness.stage.verify"),
  ).toHaveLength(24); // Four code dedupes and twenty verify agents.
  const order = result.timeline.map((t) => t.event);
  expect(order.indexOf("frame")).toBeGreaterThan(order.indexOf("precompute"));
  expect(order.indexOf("map")).toBeGreaterThan(order.indexOf("frame"));
  expect(order.indexOf("fill.start")).toBeGreaterThan(order.indexOf("map"));
  expect(order.indexOf("link")).toBeGreaterThan(order.indexOf("fill.end"));
  expect(order.indexOf("publish")).toBeGreaterThan(order.indexOf("link"));
  for (const lens of FINDERS)
    expect(result.log.read()).toContainEqual(
      expect.objectContaining({
        type: "span",
        name: "harness.stage.find",
        attributes: expect.objectContaining({ "harness.batch": lens }),
      }),
    );
  await coverage(result);
}, 60_000);

test("finders interrupted at C still link and publish every hunk", async () => {
  const result = await run("cutoff", { interruptFinders: true });
  expect(result.outcome.status).toBe("completed");
  const finders = result.tasks.filter((t) => t.kind === "neuve.finder");
  expect(finders).toHaveLength(4);
  for (const finder of finders)
    expect(finder.state).toMatchObject({
      status: "terminal",
      outcome: { status: "aborted", reason: "cutoff" },
    });
  expect(result.sent).toHaveLength(6);
  expect(result.timeline.map((t) => t.event)).toContain("cutoff");
  await coverage(result);
}, 60_000);

test("less than 90 seconds before the verification reserve skips all finders and discloses it", async () => {
  const result = await run("skip", { cutoffAfterMs: 164_000 });
  expect(result.outcome.status).toBe("completed");
  expect(result.tasks.filter((t) => t.kind === "neuve.finder")).toHaveLength(0);
  expect(result.sent).toHaveLength(2);
  expect(
    result.publicationHistory.flatMap((row) =>
      row.event.kind === "packet.published@1"
        ? [row.event.payload.complete]
        : [],
    ),
  ).toEqual([false]);
  expect(
    result.outcome.status === "completed"
      ? result.outcome.result.stages
          .filter((stage) => stage.stage === "find")
          .map((stage) => ({ agent: stage.agent, status: stage.status }))
      : [],
  ).toEqual(
    FINDERS.map((lens) => ({ agent: `find.${lens}`, status: "skipped" })),
  );
  expect(result.log.read()).toContainEqual(
    expect.objectContaining({
      type: "review.schedule",
      finders: 0,
      skipped: true,
    }),
  );
  expect(result.publicationHistory).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({
        kind: "gap.disclosed@1",
        payload: expect.objectContaining({ kind: "finders-skipped" }),
      }),
    }),
  );
  await coverage(result);
}, 60_000);

// Why: a finder with no returned result cannot count as a completed search.
test("a missing finder outcome makes the published packet partial", async () => {
  const result = await run("missing-finder", { missingFinderOutcome: true });
  expect(result.outcome.status).toBe("completed");
  expect(
    result.publicationHistory.flatMap((row) =>
      row.event.kind === "packet.published@1"
        ? [row.event.payload.complete]
        : [],
    ),
  ).toEqual([false]);
  expect(
    result.outcome.status === "completed"
      ? result.outcome.result.stages
          .filter((stage) => stage.stage === "find")
          .map((stage) => ({ agent: stage.agent, status: stage.status }))
      : [],
  ).toEqual(
    FINDERS.map((lens) => ({ agent: `find.${lens}`, status: "interrupted" })),
  );
  await coverage(result);
}, 60_000);

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
  await coverage(result);
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
// index. Both are held until Publish starts, so a Frame or Map that waited for either would never
// be sent and the review would never publish.
test("Frame and Map are sent while the head-index prefetch and the leads are both held", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let chunksEntered = 0;
  let chunksDone = 0;
  let doneAtPublish: number | undefined;
  let doneAtLeads: number | undefined;
  let leadsStored = false;
  const seen: Array<{
    agent: string;
    chunksDone: number;
    leadsStored: boolean;
  }> = [];
  const answer = answerer();
  // A file no other test in this file has, so the head tree's index is not already in memory.
  const unique = { "notes/prefetch-held.txt": "held until Publish\n" };
  const result = await run("prefetch-held", {
    base: { ...base, ...unique },
    head: { ...head, ...unique },
    answer: (agent, messages, hunks) => {
      seen.push({ agent, chunksDone, leadsStored });
      return answer(agent, messages, hunks);
    },
    onPublish: () => {
      doneAtPublish = chunksDone;
      release();
    },
    chunks: {
      paths: Object.keys(unique),
      wrap: (compute) =>
        Effect.andThen(
          Effect.sync(() => {
            chunksEntered++;
          }),
          Effect.andThen(
            Effect.promise(() => held),
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
          Effect.promise(() => held),
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
  expect(doneAtPublish).toBe(0);
  // The head index goes first (NEU-148): the leads computation starts only once the prefetch has
  // ended, so the held blob was already chunked when it started. Started beside the prefetch, it
  // would have started while the blob was still held.
  expect(doneAtLeads).toBeGreaterThan(0);
  // The hold was real: the held blob was chunked only after the release, and the prefetch built
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
    onPublish: () => release(),
    chunks: {
      paths: Object.keys(unique),
      // The first chunking of the blob is held until Publish and then fails, so the head tree's
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
test("the run log names the commit after Precompute, each wait with what it waited on, and each child's inputs", async () => {
  const result = await run("wait-telemetry");
  expect(result.outcome.status).toBe("completed");
  const records = result.log.read();
  const spans = (name: string) =>
    records.filter((r) => r.type === "span" && r["name"] === name);
  const attributes = (record: (typeof records)[number]) =>
    record["attributes"] as Record<string, unknown>;
  expect(spans("harness.pi.commit").map(attributes)).toContainEqual(
    expect.objectContaining({
      "harness.task_kind": "review",
      "harness.phase": "precompute",
      "harness.next_phase": "front",
    }),
  );
  for (const [kind, next] of [
    ["front", "terminal"],
    ["leads", "terminal"],
  ] as const)
    expect(spans("harness.pi.commit").map(attributes)).toContainEqual(
      expect.objectContaining({
        "harness.task_kind": kind,
        "harness.next_phase": next,
      }),
    );
  const front = result.tasks.find((t) => t.kind === "neuve.front")!;
  const waits = spans("harness.pi.wait").map(attributes);
  expect(waits).toContainEqual(
    expect.objectContaining({
      "harness.task_kind": "review",
      "harness.next_phase": "front",
      "harness.waiting_on": "front",
      "harness.waiting_on_ids": String(front.id),
    }),
  );
  expect(waits).toContainEqual(
    expect.objectContaining({
      "harness.task_kind": "front",
      "harness.waiting_on": "frame",
    }),
  );
  for (const wait of waits)
    expect(typeof wait["harness.waiting_on_ids"]).toBe("string");
  const inputs = records.filter((r) => r.type === "task.inputs");
  // Each finder's Find, and each Verify it or a record call started (finder-task.ts, tools.ts).
  const kinds = inputs.map((r) => String(r["kind"]));
  expect(
    kinds.filter((kind) => kind !== "find" && kind !== "verify").sort(),
  ).toEqual(
    [
      "front",
      "leads",
      "frame",
      "map",
      ...FINDERS.map((lens) => `finder.${lens}`),
    ].sort(),
  );
  expect(kinds.filter((kind) => kind === "find")).toHaveLength(FINDERS.length);
  expect(kinds.filter((kind) => kind === "verify")).toHaveLength(
    spans("harness.child.started").length,
  );
  for (const record of inputs)
    for (const key of Object.values(record["inputs"] as Record<string, string>))
      expect(key).toMatch(/^computation:/);
  // Readings are off in these runs, so the review starts no relations task (NEU-148 WP11).
  expect(result.tasks.filter((t) => t.kind === "neuve.relations")).toEqual([]);
}, 60_000);

// Why: a replay between logging the schedule and committing children must not double-count it.
test("replaying front scheduling writes one schedule and creates one set of finders", async () => {
  const result = await run("replay-schedule", { replaySchedule: true });
  expect(result.outcome.status).toBe("completed");
  expect(result.scheduleReplays).toBe(1);
  expect(
    result.log.read().filter((entry) => entry.type === "review.schedule"),
  ).toHaveLength(1);
  expect(
    result.tasks.filter((task) => task.kind === "neuve.finder"),
  ).toHaveLength(4);
  await coverage(result);
}, 60_000);

// Why (NEU-148): a kind's tools are frozen by its first agent and every later one must declare the
// same (RunToolsDoc); the four finders share one kind, so read_many must be offered to all four
// alike, beside read, and no finder may fail for declaring other tools.
test("all four finders are offered the same tools, read_many beside read", async () => {
  const result = await run("finder-tools");
  expect(result.outcome.status).toBe("completed");
  const offered = new Map<string, Array<string>>();
  for (const sent of result.sent) {
    if (!sent.agent.startsWith("find.") || offered.has(sent.agent)) continue;
    const system = sent.messages.find((m) => m.role === "system");
    offered.set(
      sent.agent,
      system?.role === "system"
        ? (system.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );
  }
  expect([...offered.keys()].sort()).toEqual(
    FINDERS.map((lens) => `find.${lens}`).sort(),
  );
  const lists = [...offered.values()];
  for (const list of lists) expect(list).toEqual(lists[0]!);
  expect(lists[0]!.slice(0, 2)).toEqual(["read", "read_many"]);
  expect(
    result.outcome.status === "completed"
      ? result.outcome.result.stages
          .filter((stage) => stage.stage === "find")
          .map((stage) => stage.status)
      : [],
  ).toEqual(FINDERS.map(() => "computed"));
}, 60_000);

// Why (NEU-148 slice B): the finders start when Frame lands, in the front task's commit that starts
// Map, owned by the review; Map then gates only Fill, Link and Publish. In the run log the finders'
// inputs come before Map's own stage record, and each names the front task it waits on for Map.
test("finders are created when Frame lands, before Map ends, owned by the review", async () => {
  const result = await run("finders-at-frame", { answer: answerer(true) });
  expect(result.outcome.status).toBe("completed");
  const records = result.log.read();
  const front = result.tasks.find((t) => t.kind === "neuve.front")!;
  const review = result.tasks.find((t) => t.kind === "neuve.review")!;
  const finders = result.tasks.filter((t) => t.kind === "neuve.finder");
  expect(finders).toHaveLength(4);
  for (const finder of finders) {
    expect(Number(finder.owner)).toBe(Number(review.id));
    expect((finder.input as { front: number }).front).toBe(Number(front.id));
  }
  const mapEnded = records.findIndex(
    (r) => r.type === "stage" && r["agent"] === "map",
  );
  const created = records.flatMap((r, index) =>
    r.type === "task.inputs" && String(r["kind"]).startsWith("finder.")
      ? [index]
      : [],
  );
  expect(created).toHaveLength(4);
  expect(mapEnded).toBeGreaterThan(-1);
  for (const index of created) expect(index).toBeLessThan(mapEnded);
  // The start rule was decided once, at that commit, by the front task.
  expect(records.filter((r) => r.type === "review.schedule")).toEqual([
    expect.objectContaining({
      taskId: Number(review.id),
      front: Number(front.id),
      finders: 4,
      skipped: false,
    }),
  ]);
}, 60_000);

// Why (NEU-148 slice B): the schedule and the finders' inputs are written after the commit that
// starts the finders, so a crash between the two would lose them for good; the front task's next
// phase writes what the log lacks, from its checkpoint and the inputs the finders were given.
test("the schedule and the finders' inputs lost after the starting commit are written by the next phase", async () => {
  const result = await run("finder-log-lost", { loseFinderLog: true });
  expect(result.outcome.status).toBe("completed");
  const records = result.log.read();
  const front = result.tasks.find((t) => t.kind === "neuve.front")!;
  const review = result.tasks.find((t) => t.kind === "neuve.review")!;
  const finders = result.tasks.filter((t) => t.kind === "neuve.finder");
  expect(finders).toHaveLength(4);
  expect(records.filter((r) => r.type === "review.schedule")).toEqual([
    expect.objectContaining({
      taskId: Number(review.id),
      front: Number(front.id),
      finders: 4,
      skipped: false,
    }),
  ]);
  const inputs = records.filter(
    (r) => r.type === "task.inputs" && String(r["kind"]).startsWith("finder."),
  );
  expect(inputs.map((r) => Number(r["taskId"])).sort()).toEqual(
    finders.map((f) => Number(f.id)).sort(),
  );
  for (const row of inputs) {
    const given = finders.find((f) => Number(f.id) === Number(row["taskId"]))!
      .input as { frameKey: string; manifestKey: string };
    expect(row["inputs"]).toEqual({
      frame: `computation:${given.frameKey}`,
      manifest: `computation:${given.manifestKey}`,
    });
  }
}, 60_000);

// Why: Map falling back after the finders started must not hang or lose them: the review still
// publishes, and each finder groups its findings by the fallback Map the front task returns.
test("a Map that falls back after the finders started still groups their findings and publishes", async () => {
  const base = answerer(true);
  const result = await run("map-fallback", {
    answer: (agent, messages, hunks) =>
      agent === "map"
        ? toolTurn([
            {
              name: "submit_map",
              id: `map-${Math.random()}`,
              args: {
                groups: [
                  {
                    label: "Nothing real",
                    why: "Names an entry that does not exist.",
                    tier: "core",
                    doneWhen: ["D1"],
                    entries: ["f999"],
                  },
                ],
              },
            },
          ])
        : base(agent, messages, hunks),
  });
  expect(result.outcome.status).toBe("completed");
  const front = result.tasks.find((t) => t.kind === "neuve.front")!;
  const mapKey = (front.state as { outcome?: { result?: { mapKey?: string } } })
    .outcome?.result?.mapKey;
  expect(mapKey).toBeString();
  expect((await result.read(mapKey!, ReviewMap)).source).toBe("fallback");
  let kept = 0;
  for (const task of result.tasks.filter((t) => t.kind === "neuve.finder")) {
    const finder = (task.state as { outcome?: { result?: FinderResult } })
      .outcome?.result;
    expect(finder?.reason).toBeUndefined();
    if (finder?.findKey == null) continue;
    const final = await result.read(finder.findKey, FindStored);
    for (const f of final.findings) expect(f.group).toMatch(/^g\d+$/);
    kept += finder.findings.filter((f) => f.status === "kept").length;
  }
  expect(kept).toBeGreaterThan(0);
  expect(
    result.publicationHistory.some(
      (e) => e.event.kind === "packet.published@1",
    ),
  ).toBe(true);
}, 60_000);
