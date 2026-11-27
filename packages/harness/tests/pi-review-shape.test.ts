import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CrossBatchClaimsDoc } from "../src/pi/cross-batch-claims.ts";
import type { AgentStepInput } from "../src/pi/stages/agent-step.ts";
import { childId } from "../src/pi/stages/children.ts";
import type { CrossBatchClaim } from "../src/readings/answers.ts";
import { ClaimStored } from "../src/readings/claims.ts";
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
import type { StageRecord } from "../src/pipeline.ts";
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
    if (agent.startsWith("brief.") || agent.startsWith("digest."))
      return fauxAssistantMessage("No briefing.");
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

const paths = ["src/first.ts", "src/second.ts"] as const;
const splitRange = {
  base: {
    [paths[0]]: "export const first = 1;\n",
    [paths[1]]: "export const second = 1;\n",
  },
  head: {
    [paths[0]]: "export const first = 0;\n",
    [paths[1]]: "export const second = 0;\n",
  },
  message: "Change the two constants",
};
const earlyText = "The second constant can now be zero.";
const lateText = "The first constant can now be zero.";
const claimOn = (path: string, text: string): CrossBatchClaim => ({
  path,
  side: "new",
  startLine: 1,
  endLine: 1,
  kind: "defect",
  text,
  fails: "A caller dividing by the constant divides by zero.",
  evidenceAnchors: [],
});
const submit = (
  agent: string,
  name: string,
  args: Parameters<typeof toolTurn>[0][number]["args"],
) => toolTurn([{ name, id: agent, args }]);
const reviewWithClaims = (
  agent: string,
  claims: CrossBatchClaim[],
  unanswered = false,
) =>
  submit(agent, "submit_review", {
    sections: { a: [], r: [], u: unanswered ? [] : [1] },
    files: [
      {
        f: 1,
        checked: "Checked the new value.",
        rows: [{ row: "D1", status: "no-evidence", reading: "", cites: [] }],
      },
    ],
    comments: [],
    unsure: unanswered ? [] : [{ s: 1, t: "The caller is unavailable." }],
    notAsked: [],
    crossBatchClaims: claims,
  });
const verify = (agent: string) =>
  submit(agent, "submit_verify", {
    decision: "keep",
    reason: "The pinned source shows the constant is zero.",
  });
const splitMap = (files: readonly string[] = paths) =>
  submit("map", "submit_map", {
    groups: files.map((path, i) => ({
      label: `Change ${path}`,
      why: "Change one constant.",
      tier: "core",
      doneWhen: ["D1"],
      entries: [`f${i + 1}`],
    })),
  });
const commentsOf = (result: Awaited<ReturnType<typeof runReview>>) =>
  result.publicationHistory.flatMap(({ event }) =>
    event.kind === "comment.recorded@3" ? [event.payload] : [],
  );

const sharedPath = "src/format.ts";
const callerPath = "src/change-facts.ts";
const unchangedPath = "src/labels.ts";
const previous =
  'const label = (count: number) => count === 1 ? "file" : "files";';
const replacement =
  'export const label = (count: number) => count <= 1 ? "file" : "files";';
const consolidationText = "The consolidation changes the label for zero files.";
const removedCopy = {
  path: callerPath,
  side: "old" as const,
  startLine: 10,
  endLine: 10,
};
const userText = (messages: Parameters<Answer>[1]) =>
  messages
    .flatMap((message) => {
      if (message.role !== "user") return [];
      return typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          );
    })
    .join("\n");

const consolidation = async (
  mode: "anchored" | "without" | "missing" | "incoming",
) => {
  const oldCaller = (implementation: string) =>
    [
      ...Array.from({ length: 9 }, (_, i) => `// Before ${i + 1}`),
      implementation,
      "export const noFiles = label(0);",
      ...Array.from({ length: 8 }, (_, i) => `// After ${i + 2}`),
    ].join("\n") + "\n";
  const anchors =
    mode === "without"
      ? undefined
      : mode === "missing"
        ? [{ ...removedCopy, path: sharedPath, startLine: 1, endLine: 1 }]
        : [
            removedCopy,
            {
              path: unchangedPath,
              side: "new" as const,
              startLine: 1,
              endLine: 1,
            },
          ];
  const failure = "A report with zero files prints the singular label.";
  const fallback = answerer();
  const checking = Promise.withResolvers<void>();
  const result = await runReview({
    directory: join(directory, `consolidation-${mode}`),
    base: {
      [callerPath]: oldCaller(previous),
      [unchangedPath]: 'import { noFiles } from "./change-facts";\n',
    },
    head: {
      [callerPath]: oldCaller('import { label } from "./format";'),
      [sharedPath]: replacement + "\n",
    },
    message: "Share the file label helper",
    answer: async (agent, messages, hunks) => {
      const task = userText(messages);
      if (agent === "map") return splitMap([callerPath, sharedPath]);
      if (agent.startsWith("verify.claim.")) {
        checking.resolve();
        return submit(agent, "submit_verify", {
          decision:
            task.includes(previous) && task.includes(replacement)
              ? "keep"
              : "drop",
          reason:
            "The regression needs both the former and the current implementation.",
        });
      }
      if (!agent.startsWith("lane-review."))
        return fallback(agent, messages, hunks);
      const reviewingHelper = task.includes(
        `kind="file">\npath: ${sharedPath}\n`,
      );
      if (mode === "incoming") {
        if (reviewingHelper) {
          await checking.promise;
          return reviewWithClaims(agent, []);
        }
        return reviewWithClaims(agent, [
          {
            ...claimOn(sharedPath, consolidationText),
            fails: failure,
            evidenceAnchors: anchors ?? [],
          },
        ]);
      }
      if (!reviewingHelper) return reviewWithClaims(agent, []);
      return submit(agent, "submit_review", {
        files: [{ f: 1, checked: "Checked the file label.", rows: null }],
        sections: { a: [], r: [1], u: [] },
        comments: [
          {
            s: 1,
            side: "new",
            start: 1,
            end: 1,
            kind: "defect",
            effect: null,
            t: consolidationText,
            cites: ["1n1"],
            fails: failure,
            row: null,
            evidenceAnchors: anchors ?? [],
          },
        ],
        unsure: [],
        notAsked: [],
        crossBatchClaims: [],
      });
    },
  });
  expect(result.outcome.status).toBe("completed");
  const requests = result.sent.filter(({ agent }) =>
    agent.startsWith("verify.claim."),
  );
  expect(requests).toHaveLength(1);
  const [check] = result.log
    .read()
    .filter(
      (row) =>
        row.type === "stage" &&
        String(row["agent"]).startsWith("verify.claim.") &&
        row["status"] === "computed",
    );
  const answer = await result.read(String(check?.["key"]), ClaimStored);
  return {
    task: userText(requests[0]!.messages),
    decision: answer.decision,
    units: result.publicationHistory.flatMap(({ event }) =>
      event.kind === "unit.recorded@3" && event.payload.path === sharedPath
        ? event.attribution.unitIds
        : [],
    ),
    comments: result.publicationHistory.flatMap(({ event }) =>
      event.kind === "comment.recorded@3" &&
      event.payload.body.includes(consolidationText)
        ? [event]
        : [],
    ),
  };
};

// A consolidation regression needs the removed copy as well as the replacement to reach the desk.
test.each(["anchored", "incoming"] as const)(
  "Verify uses both sides of a consolidation (%s)",
  async (mode) => {
    const { task, decision, comments, units } = await consolidation(mode);
    expect(task).toContain(replacement);
    expect(task).toContain(
      `${callerPath} (old) lines 10-10, context 8\n2: // Before 2`,
    );
    expect(task).toContain(`10: ${previous}`);
    expect(task).toContain("11: export const noFiles = label(0);");
    expect(task).toContain("18: // After 8");
    expect(task).not.toContain("1: // Before 1\n");
    expect(task).not.toContain("19: // After 9");
    expect(task).toContain('1: import { noFiles } from "./change-facts";');
    expect(decision).toBe("keep");
    expect(units).toHaveLength(1);
    expect(comments).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          anchor: expect.objectContaining({ path: sharedPath }),
          finding: expect.objectContaining({ kind: "defect" }),
        }),
        attribution: expect.objectContaining({ unitIds: units }),
      }),
    ]);
  },
  60_000,
);

// The same claim is unsupported when Lane review sends only its primary anchor.
test("Verify drops a consolidation claim without evidence anchors", async () => {
  const { task, decision, comments } = await consolidation("without");
  expect(task).toContain(replacement);
  expect(task).not.toContain(previous);
  expect(decision).toBe("drop");
  expect(comments).toEqual([]);
}, 60_000);

// A file added at head has no old blob. Verify must report the missing source, as on main.
test("Verify reports evidence missing at the cited revision", async () => {
  const { task, decision, comments } = await consolidation("missing");
  expect(task).toContain(
    `${sharedPath} (old) lines 1-1, context 8\nUnavailable at the cited revision.`,
  );
  expect(task).not.toContain(previous);
  expect(decision).toBe("drop");
  expect(comments).toEqual([]);
}, 60_000);

// Both files share a directory. Map must separate their readings. Hold the second reviewer
// until the first batch reaches Records to prove the outgoing claim can't reopen it.
test("batch reviewers verify claims and leave published batches unchanged", async () => {
  const { promise: firstPublished, resolve: openSecond } =
    Promise.withResolvers<void>();
  const laneViews: string[] = [];
  const verifyViews: string[] = [];
  const fallback = answerer();
  const result = await runReview({
    directory: join(directory, "cross-batch"),
    ...splitRange,
    afterBatchPublished: (index) => {
      if (index === 0) openSecond();
    },
    answer: async (agent, messages, hunks) => {
      if (agent === "map") return splitMap();
      if (agent.startsWith("lane-review.")) {
        const text = textOf(messages);
        laneViews.push(text);
        const readsFirst = text.includes("export const first");
        if (!readsFirst) await firstPublished;
        return reviewWithClaims(agent, [
          readsFirst
            ? claimOn(paths[1], earlyText)
            : claimOn(paths[0], lateText),
        ]);
      }
      if (agent.startsWith("verify.claim.")) {
        verifyViews.push(textOf(messages));
        return verify(agent);
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
  const comments = commentsOf(result);
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

// A new attempt uses the same session registry and stored Lane review answer. Stopping the first
// attempt while one Verify is running must replace that check and reuse another that finished.
test("a retried review replaces an aborted check and reuses a stored check", async () => {
  const firstVerify = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const fallback = answerer();
  const storedText = "Callers now receive a zero second constant.";
  let checks = 0;
  let storedChecks = 0;
  const result = await runReview({
    directory: join(directory, "retried-check"),
    ...splitRange,
    runAttempts: async (harness, start) => {
      const first = await start();
      await firstVerify.promise;
      const registered = await harness.snapshot(CrossBatchClaimsDoc, context);
      const held = Object.values(registered?.claims ?? {});
      const oldTask = held.find(
        ({ comment }) => comment.text === earlyText,
      )?.task;
      const storedTask = held.find(
        ({ comment }) => comment.text === storedText,
      )?.task;
      if (oldTask == null || storedTask == null)
        throw new Error("Claims were not registered");
      expect(
        (await harness.waitForTask(childId<StageRecord>(storedTask), context))
          .state.outcome,
      ).toMatchObject({
        status: "completed",
        result: { status: "computed", key: expect.any(String) },
      });
      const graph = await harness.watchTaskGraph(context);
      graph.start(async ({ tasks }) => {
        const check = tasks[String(oldTask)];
        if (check === undefined || check.abortRequested) reply.resolve();
      });
      try {
        await harness.abortTask(first, context);
        await reply.promise;
      } finally {
        await graph.stop();
      }
      expect(
        (await harness.waitForTask(first, context)).state.outcome.status,
      ).toBe("aborted");
      expect(
        (await harness.waitForTask(childId(oldTask), context)).state.outcome
          .status,
      ).toBe("aborted");
      return start();
    },
    answer: async (agent, messages, hunks) => {
      if (agent === "map") return splitMap();
      if (agent.startsWith("lane-review."))
        return reviewWithClaims(
          agent,
          textOf(messages).includes("export const first")
            ? [claimOn(paths[1], earlyText), claimOn(paths[1], storedText)]
            : [],
        );
      if (agent.startsWith("verify.claim.")) {
        if (textOf(messages).includes(storedText)) {
          storedChecks++;
          return verify(agent);
        }
        if (++checks === 1) {
          firstVerify.resolve();
          await reply.promise;
          return fauxAssistantMessage("The check was interrupted.");
        }
        return verify(agent);
      }
      return fallback(agent, messages, hunks);
    },
  });
  expect(result.outcome.status).toBe("completed");
  expect(checks).toBe(2);
  expect(storedChecks).toBe(1);
  expect(
    result.sent.filter(
      ({ agent, messages }) =>
        agent.startsWith("lane-review.") &&
        textOf(messages).includes("export const first"),
    ),
  ).toHaveLength(1);
  expect(
    commentsOf(result).filter(({ body }) => body.includes(earlyText)),
  ).toHaveLength(1);
  expect(
    commentsOf(result).filter(({ body }) => body.includes(storedText)),
  ).toHaveLength(1);
}, 60_000);

// Once Lane review stores its answer, the cut-off can prevent Verify from ever starting.
test("a claim whose Verify never starts at the cut-off stays in the run log", async () => {
  const fallback = answerer();
  const result = await runReview({
    directory: join(directory, "cutoff-claim"),
    ...splitRange,
    readingMaxFiles: 1,
    onLog: (row, reachCutoff) => {
      if (
        row.type === "stage" &&
        String(row["agent"]).startsWith("lane-review.") &&
        row["status"] === "computed"
      )
        reachCutoff();
    },
    answer: (agent, messages, hunks) =>
      agent.startsWith("lane-review.")
        ? reviewWithClaims(agent, [claimOn(paths[1], earlyText)])
        : fallback(agent, messages, hunks),
  });
  expect(result.outcome.status).toBe("completed");
  expect(
    result.sent.filter(({ agent }) => agent.startsWith("verify.claim.")),
  ).toHaveLength(0);
  const claims = result.log
    .read()
    .filter(({ type }) => type === "review.claim-unpublished");
  expect(claims).toEqual([
    expect.objectContaining({
      reason: "check-not-completed",
      anchor: { path: paths[1], side: "new", startLine: 1, endLine: 1 },
      verify: null,
    }),
  ]);
  const held = await result.read(
    String(claims[0]?.["answer"]),
    LaneReviewStored,
  );
  expect(held.answer.crossBatchClaims).toEqual([claimOn(paths[1], earlyText)]);
}, 60_000);

// Stop a reading while its re-read is pending. Its stored first answer's claim must still be kept.
test("a reading stopped before checking claims retains its incoming claim", async () => {
  const rereading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fallback = answerer();
  const result = await runReview({
    directory: join(directory, "stopped-reading-claim"),
    ...splitRange,
    runAttempts: async (harness, start) => {
      const review = await start();
      await rereading.promise;
      try {
        const reread = await harness.commit(
          async (tx) =>
            (await tx.scanTasks({}, 1000)).items.find(({ kind, input }) => {
              if (kind !== "neuve.agent-step") return false;
              const step = input as AgentStepInput;
              return (
                step.kind === "lane-review" &&
                (step.params as { part?: string }).part === "reread"
              );
            }),
          context,
        );
        if (reread?.owner == null)
          throw new Error("The re-read has no owning task");
        const reading = childId(reread.owner);
        await harness.abortTask(reading, context);
        release.resolve();
        expect(
          (await harness.waitForTask(reading, context)).state.outcome.status,
        ).toBe("aborted");
        const registered = await harness.snapshot(CrossBatchClaimsDoc, context);
        expect(Object.values(registered?.claims ?? {})).toEqual([
          expect.objectContaining({
            comment: claimOn(paths[1], earlyText),
            task: null,
          }),
        ]);
        return review;
      } finally {
        release.resolve();
      }
    },
    answer: async (agent, messages, hunks) => {
      if (agent === "map") return splitMap();
      if (!agent.startsWith("lane-review."))
        return fallback(agent, messages, hunks);
      if (!textOf(messages).includes("export const first"))
        return reviewWithClaims(agent, []);
      if (!agent.endsWith(".reread"))
        return reviewWithClaims(agent, [claimOn(paths[1], earlyText)], true);
      rereading.resolve();
      await release.promise;
      return reviewWithClaims(agent, []);
    },
  });
  expect(result.outcome.status).toBe("completed");
  expect(
    result.sent.filter(({ agent }) => agent.startsWith("verify.claim.")),
  ).toHaveLength(0);
  expect(
    result.log.read().filter(({ type }) => type === "review.claim-unpublished"),
  ).toEqual([
    expect.objectContaining({ reason: "check-not-completed", verify: null }),
  ]);
}, 60_000);

// A batch can need more than one reading group. A section outside the source group can still
// receive a confirmed claim on its own changed line.
test("a claim on another reading group reaches the same batch", async () => {
  const fallback = answerer();
  const result = await runReview({
    directory: join(directory, "same-batch"),
    ...splitRange,
    readingMaxFiles: 1,
    answer: (agent, messages, hunks) => {
      if (agent.startsWith("lane-review."))
        return reviewWithClaims(
          agent,
          textOf(messages).includes("export const first")
            ? [claimOn(paths[1], earlyText)]
            : [],
        );
      if (agent.startsWith("verify.claim.")) return verify(agent);
      return fallback(agent, messages, hunks);
    },
  });
  expect(result.outcome.status).toBe("completed");
  expect(
    result.sent.filter(({ agent }) => agent.startsWith("verify.claim.")),
  ).toHaveLength(1);
  expect(
    commentsOf(result).filter(({ body }) => body.includes(earlyText)),
  ).toEqual([
    expect.objectContaining({
      anchor: expect.objectContaining({ path: paths[1] }),
    }),
  ]);
}, 60_000);

// A Lane review can ask for its changed file and an unchanged caller in one read_many.
// The file fits that tool's cap but previously consumed the review's whole budget.
test("Lane review reads the caller after a large range in one tool call", async () => {
  const path = "src/retries.ts";
  const caller = "src/schedule.ts";
  const padding = Array.from(
    { length: 280 },
    (_, n) => `// ${n} ${"context ".repeat(12)}\n`,
  ).join("");
  const callerText = "export const schedule = () => retryLimit * 2;";
  const untouched = {
    [caller]: `import { retryLimit } from "./retries.ts";\n${callerText}\n`,
  };
  const fallback = answerer();
  let sawCaller = false;
  const result = await runReview({
    directory: join(directory, "multi-range-caller"),
    base: { [path]: `${padding}export const retryLimit = 1;\n`, ...untouched },
    head: { [path]: `${padding}export const retryLimit = 2;\n`, ...untouched },
    message: "Raise the retry limit",
    answer: (agent, messages, hunks) => {
      if (!agent.startsWith("lane-review."))
        return fallback(agent, messages, hunks);
      const toolReply = messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "read_many",
      );
      if (toolReply === undefined)
        return submit(agent, "read_many", {
          entries: [
            { path, startLine: 1, endLine: 281 },
            { path: caller, startLine: 2, endLine: 2 },
          ],
        });
      sawCaller = textOf([toolReply]).includes(callerText);
      return reviewWithClaims(agent, []);
    },
  });
  expect(result.outcome.status).toBe("completed");
  expect(sawCaller).toBe(true);
}, 60_000);

// The ending packet is already stored when retention appends the run-log row.
test("a run-log write failure cannot fail a published review", async () => {
  const fallback = answerer();
  const firstPublished = Promise.withResolvers<void>();
  let failedWrites = 0;
  const result = await runReview({
    directory: join(directory, "retention-failure"),
    ...splitRange,
    afterBatchPublished: (index) => {
      if (index === 0) firstPublished.resolve();
    },
    onLog: (row) => {
      if (row.type === "review.claim-unpublished") {
        failedWrites++;
        throw new Error("run log write refused");
      }
    },
    answer: async (agent, messages, hunks) => {
      if (agent === "map") return splitMap();
      if (agent.startsWith("verify.claim.")) return verify(agent);
      if (agent.startsWith("lane-review.")) {
        if (textOf(messages).includes("export const first"))
          return reviewWithClaims(agent, []);
        await firstPublished.promise;
        return reviewWithClaims(agent, [claimOn(paths[0], lateText)]);
      }
      return fallback(agent, messages, hunks);
    },
  });
  expect(failedWrites).toBe(1);
  expect(result.outcome.status).toBe("completed");
  expect(
    result.publicationHistory.some(
      ({ event }) =>
        event.kind === "packet.published@2" && event.payload.complete,
    ),
  ).toBe(true);
}, 60_000);
