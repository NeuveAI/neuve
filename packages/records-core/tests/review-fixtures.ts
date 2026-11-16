import { mintUlid, sha256Hex } from "../src/index.ts";
import { Computations, canonicalJson } from "../src/index.ts";
import { agent, envelope, headOid, human } from "./support.ts";

const range = {
  baseRef: "refs/heads/main",
  baseOid: "b".repeat(40),
  headOid,
};
const computation = (label: string) => `computation:${sha256Hex(label)}`;
const usage = {
  input: 1_200,
  cacheWrite5m: 300,
  cacheWrite1h: 0,
  cacheRead: 900,
  output: 400,
};

/** A run receipt as the harness writes it, small enough for the payload cap. */
export const receipt = (runKey: string, stages: number) => ({
  runKey,
  generation: 0,
  jobSeq: 1,
  route: {
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "medium",
    maxOutputTokens: 128_000,
    contextCeiling: 500_000,
    callsInFlight: 8,
    credentialVariable: "ANTHROPIC_API_KEY",
    organization: null,
    price: {
      input: 4,
      output: 20,
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
      cacheRead: 0.05,
    },
  },
  outcome: "completed",
  timeout: {
    lifetimeMs: 600_000,
    cutoffAt: "2026-10-19T10:09:45.000Z",
    reached: false,
    published: ["precompute", "assemble"],
    disclosed: [],
  },
  timing: {
    enqueuedAt: "2026-10-19T09:59:58.000Z",
    startedAt: "2026-10-19T10:00:00.000Z",
    endedAt: "2026-10-19T10:01:00.000Z",
    wallMs: 60_000,
    queueWaitMs: 2_000,
    attempts: 1,
  },
  stages: Array.from({ length: stages }, (_, index) => ({
    stage: "investigate",
    agent: `investigate.p${index + 1}`,
    status: "computed",
    wallMs: 30_000,
    expectedMs: 105_000,
    turns: {
      turnsUsed: 4,
      turnLimit: 35,
      ruledLimit: "35 per agent",
      limitReached: false,
      finalGeneration: false,
      endedBy: "submit",
      resumedTurns: 0,
      restarted: false,
    },
    modelCalls: 4,
    usage,
    costUsd: 0.0123,
    note: "x".repeat(1_900),
  })),
  totals: { modelCalls: 4 * stages, retries: 0, usage, costUsd: 0.0123 },
  gaps: [{ stage: "run", kind: "history-not-consulted", detail: "M3 (10.3)" }],
  disclosures: ["History is not consulted in M3 (10.3)."],
  unitCounts: { at10: 4, at20: 3, at40: 2 },

  notMeasured: {},
});

/**
 * One cycle whose log holds version 1 and version 2 events side by side, plus every new kind of
 * M3: a unit recorded at version 1 and recorded again at version 2 after the agent merged it; a
 * version 2 unit assessed at 10.55's case (high complexity, a validation gap, human-suggested); a
 * human-required unit; v1 and v2 context references and comments, including a forged-evidence
 * defect and a test-bloat warning; dispositions at both versions, one resting on its defect comment;
 * delivery content, gaps, stage and run telemetry, and the packet. Minted in causal order.
 */
export const reviewEvents = () => {
  const cycleId = mintUlid();
  const batchId = mintUlid();
  const runId = mintUlid();
  const [u1, u2, u3] = [mintUlid(), mintUlid(), mintUlid()];
  const on = (unitId: string) => ({ cycleId, unitIds: [unitId] });
  const run = { cycleId, range, runId };
  const anchor = { path: "src/a.ts", side: "new", startLine: 3, endLine: 4 };
  const registration = envelope(
    "actor.registered@1",
    `actor:${agent}`,
    agent,
    undefined,
    { actorKind: "agent", harness: "neuve", sessionId: runId },
  );
  const humanRegistration = envelope(
    "actor.registered@1",
    `actor:${human}`,
    human,
    undefined,
    { actorKind: "human", harness: "git", email: "owner@example.com" },
  );
  const structure = [
    envelope(
      "cycle.opened@1",
      `cycle:${cycleId}`,
      agent,
      { cycleId, range },
      {},
    ),
    envelope(
      "batch.recorded@1",
      `batch:${batchId}`,
      agent,
      { cycleId, batchId },
      { title: "Batch", focus: "Focus" },
    ),
    envelope(
      "unit.recorded@1",
      `unit:${u1}:1`,
      agent,
      { cycleId, batchId, unitIds: [u1] },
      {
        title: "Unit one",
        ownedRanges: [{ path: "src/a.ts", startLine: 1, endLine: 9 }],
      },
    ),
    envelope(
      "unit.recorded@2",
      `unit:${u1}:2`,
      agent,
      { cycleId, batchId, unitIds: [u1] },
      {
        title: "Unit one, merged",
        ownedRanges: [
          {
            kind: "lines",
            path: "src/a.ts",
            side: "new",
            startLine: 1,
            endLine: 9,
          },
          {
            kind: "lines",
            path: "src/a.ts",
            side: "old",
            startLine: 2,
            endLine: 3,
          },
        ],
        grouping: {
          gapLines: 20,
          adjustment: {
            kind: "merge",
            reason: "A short helper separated two hunks.",
          },
        },
      },
    ),
    envelope(
      "unit.recorded@2",
      `unit:${u2}`,
      agent,
      { cycleId, batchId, unitIds: [u2] },
      {
        title: "Unit two",
        ownedRanges: [
          {
            kind: "lines",
            path: "src/b.ts",
            side: "new",
            startLine: 5,
            endLine: 30,
          },
        ],
        grouping: { gapLines: 20 },
      },
    ),
    envelope(
      "unit.recorded@2",
      `unit:${u3}`,
      agent,
      { cycleId, batchId, unitIds: [u3] },
      {
        title: "Unit three",
        ownedRanges: [{ kind: "whole-nontext", path: "logo.png", side: "new" }],
        grouping: { gapLines: 20 },
      },
    ),
    envelope("assessment.recorded@1", `assessment:${u1}`, agent, on(u1), {
      lane: "agentic",
      complexity: "low",
      easeOfValidation: "easy",
      rationale: "Small and contained.",
    }),
    envelope("assessment.recorded@2", `assessment:${u2}`, agent, on(u2), {
      lane: "human-suggested",
      quadrant: "high-easy",
      complexity: {
        level: "high",
        factors: [
          {
            factor: "connections",
            finding: "Twelve callers depend on it.",
            cites: [{ ref: computation("ledger"), entry: "e3" }],
          },
        ],
      },
      easeOfValidation: {
        level: "easy",
        requirements: [
          {
            requirement: "The retry stops after three attempts.",
            cites: [],
            coverage: "missing",
            proof: [],
          },
        ],
      },
      movement: [],
      gaps: [
        {
          axis: "ease-of-validation",
          kind: "scope-missing",
          detail: "The ticket was named but not fetched.",
        },
      ],
      rationale: "High complexity; the validation reading has a gap.",
    }),
    envelope("assessment.recorded@2", `assessment:${u3}`, agent, on(u3), {
      lane: "human-required",
      quadrant: "high-hard",
      complexity: { level: "high", factors: [] },
      easeOfValidation: { level: "hard", requirements: [] },
      movement: [
        {
          signal: "blast-radius",
          finding: "Shown on every page.",
          axis: "complexity",
          direction: "toward-human",
          cites: [{ ref: computation("ledger"), entry: "e9" }],
        },
      ],
      gaps: [],
      rationale: "Visible everywhere and hard to validate.",
    }),
    envelope(
      "context.referenced@1",
      `context:${cycleId}:1`,
      agent,
      { cycleId, unitIds: [u1, u2] },
      {
        markerKind: "same-batch",
        source: { kind: "range", locator: "b..a" },
        summary: "Shared context",
      },
    ),
    envelope(
      "context.referenced@2",
      `context:${cycleId}:2`,
      agent,
      { cycleId, batchId, unitIds: [u2] },
      {
        markerKind: "doc",
        source: { kind: "doc", locator: "docs/retry.md" },
        summary: "The retry policy",
        anchor,
        stance: "supports",
        origin: "committed",
        retrieval: {
          retriever: "bm25",
          query: "retry policy",
          rank: 1,
          score: 7.5,
        },
        provenance: {
          kind: "git",
          revision: headOid,
          path: "docs/retry.md",
          startLine: 1,
          endLine: 20,
        },
      },
    ),
  ];
  const comments = {
    plain: envelope("comment.recorded@1", `comment:${u1}`, human, on(u1), {
      body: "Looks fine.",
    }),
    defect: envelope(
      "comment.recorded@2",
      `comment:${u2}:defect`,
      agent,
      on(u2),
      {
        body: "The test mocks the retry away.",
        anchor,
        finding: {
          kind: "defect",
          about: "tests",
          signal: "forged",
          evidence: [{ ref: computation("diff"), entry: "tests/b.test.ts:12" }],
        },
      },
    ),
    bloat: envelope(
      "comment.recorded@2",
      `comment:${u2}:bloat`,
      agent,
      on(u2),
      {
        body: "Forty tests for one branch.",
        finding: {
          kind: "risk",
          about: "tests",
          signal: "test-bloat",
          evidence: [],
        },
      },
    ),
  };
  const dispositions = {
    approval: envelope(
      "disposition.recorded@1",
      `disposition:${u1}`,
      agent,
      on(u1),
      {
        verdict: "approve",
        reviewedHeadOid: headOid,
      },
    ),
    cited: envelope(
      "disposition.recorded@2",
      `disposition:${u2}`,
      agent,
      on(u2),
      {
        verdict: "request-changes",
        reviewedHeadOid: headOid,
        restsOn: [comments.defect.id],
        proof: [],
      },
    ),
    uncited: envelope(
      "disposition.recorded@2",
      `disposition:${u3}`,
      agent,
      on(u3),
      {
        verdict: "request-changes",
        reviewedHeadOid: headOid,
        restsOn: [],
        proof: [],
      },
    ),
  };
  const delivery = [
    envelope(
      "delivery.recorded@1",
      `delivery:${batchId}:digest`,
      agent,
      { cycleId, batchId },
      { content: "batch-digest" },
    ),
    envelope(
      "delivery.recorded@1",
      `delivery:${u2}:facts`,
      agent,
      { cycleId, batchId, unitIds: [u2] },
      { content: "facts", verdictWords: 0 },
    ),
  ].map((event) => ({
    ...event,
    refs: [{ ref: computation(event.idempotencyKey), role: "content" }],
  }));
  const runKey = sha256Hex(`run:${runId}`);
  const telemetry = [
    envelope(
      "gap.disclosed@1",
      `review:${runId}:gap:run:history-not-consulted`,
      agent,
      run,
      {
        kind: "history-not-consulted",
        detail: "History is not consulted in M3 (10.3).",
      },
    ),
    envelope(
      "gap.disclosed@1",
      `review:${runId}:gap:understand:0`,
      agent,
      { ...run, stage: "understand", unitIds: [u2] },
      {
        kind: "scope-missing",
        detail: "The ticket was named but not fetched.",
      },
    ),
    envelope(
      "stage.completed@1",
      `review:${runId}:stage:precompute`,
      agent,
      { ...run, stage: "precompute" },
      {
        stage: "precompute",
        agent: "precompute",
        status: "computed",
        wallMs: 120,
        expectedMs: 15_000,
        modelCalls: 0,
        usage: {
          input: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          output: 0,
        },
        costUsd: 0,
      },
    ),
    envelope(
      "stage.completed@1",
      `review:${runId}:stage:assemble.b1`,
      agent,
      { ...run, stage: "assemble", batchId },
      {
        stage: "assemble",
        agent: "assemble.b1",
        status: "computed",
        wallMs: 40_000,
        expectedMs: 90_000,
        turns: {
          turnsUsed: 12,
          turnLimit: 40,
          ruledLimit: "40 per batch",
          limitReached: false,
          finalGeneration: false,
          endedBy: "submit",
          resumedTurns: 0,
          restarted: false,
        },
        modelCalls: 12,
        usage,
        costUsd: 0.0421,
      },
    ),
    envelope(
      "run.completed@1",
      `review:${runId}:run.completed`,
      agent,
      run,
      receipt(runKey, 2),
    ),
  ];
  const packet = {
    ...envelope("packet.published@1", `review:${runId}:packet`, agent, run, {
      complete: true,
      counts: {
        batches: 1,
        units: 3,
        contextReferences: 2,
        assessments: 3,
        deliveries: 2,
        dispositions: 3,
        comments: 3,
        gaps: 2,
      },
    }),
    refs: [{ ref: `blob:${sha256Hex("manifest")}`, role: "manifest" }],
  };
  return {
    cycleId,
    batchId,
    runId,
    units: [u1, u2, u3] as const,
    registrations: [registration, humanRegistration],
    structure,
    comments,
    dispositions,
    delivery,
    telemetry,
    packet,
    /** Every event, in causal order. */
    all: [
      registration,
      humanRegistration,
      ...structure,
      comments.plain,
      comments.defect,
      comments.bloat,
      dispositions.approval,
      dispositions.cited,
      dispositions.uncited,
      ...delivery,
      ...telemetry,
      packet,
    ],
  };
};

/** Content the new-shape review references, to store before its events: durable blobs and computations. */
export interface StoredContent {
  readonly label: string;
  readonly text: string;
}
export interface StoredComputation extends StoredContent {
  readonly spec: {
    readonly op: string;
    readonly opVersion: number;
    readonly inputs: { readonly label: string };
  };
}

/** An `AssembledBatch` that decodes strictly, with the citation index given. */
const assembledBatch = (citations: Record<string, unknown>) => ({
  candidate: "candidate",
  confirmation: {
    decision: "confirm",
    reason: "fixture",
    source: "code",
    changes: [],
  },
  batches: [],
  units: [],
  references: [],
  proofs: [],
  pins: [],
  citations,
  counts: {
    at10: 0,
    at20: 0,
    at40: 0,
    defaultUnits: 0,
    units: 0,
    merges: 0,
    splits: 0,
    lanes: {},
    highComplexityValidationGap: 0,
    coverage: { missing: 0, shallow: 0, solid: 0 },
    checkpoints: {
      missing: 0,
      outOfDate: 0,
      conflicting: 0,
      proven: 0,
      thin: 0,
      wholeUnit: 0,
    },
    notAssessed: 0,
    uncited: 0,
    verdictWords: 0,
    laneWords: 0,
  },
  turns: {
    limit: 1,
    confirm: 0,
    groups: 0,
    groupTurns: 1,
    digests: 0,
    digestTurns: 1,
    overrun: false,
  },
  gaps: [],
});

/**
 * One cycle reviewed in the new shape (records design, step 2): two cumulative
 * `packet.published@2` of one run, the second superseding the first and adding a batch; a unit of
 * 1,100 owned ranges in two sections (its `unit.recorded@3` blob), assessed at version 4 with one
 * section the public-surface raise placed above its judged lane and one at 10.55's case; a second unit whose one section no agent
 * decided; an impact finding (`comment.recorded@3`); a `lineage.recorded@1` from an earlier unit;
 * a facts stop citing the large unit; gaps named only by the first packet, by a batch, and by the
 * second packet, which also names a gap Records does not hold. `mismatch` makes the large unit's
 * judgements name a section its blob does not hold and leave one of its sections unjudged;
 * `badCause` gives the small unit's undecided section a cause that is not a cause name;
 * `badContent` gives the large unit's second section a content that does not decode; `badSide`
 * gives its first section a side that is not one; `badJudgements` gives the large unit's judgements
 * entries that do not decode: `lane`, its first entry's applied lane a word this build does not
 * know; `numbers`, every entry a number. `excluded` adds a third batch, published with the second
 * packet, whose one unit holds one section of a lockfile the map excluded (no reading, no verdict,
 * no disposition, no comment). `carried` makes the small unit unchanged from an earlier unit and
 * carries a person's approval of it onto it. `floor` turns the removal floor on for the large
 * unit's second section, which removes a declaration, so a floor raises it in place of the
 * public-surface raise. `noFloorInputs` leaves the large unit's first entry without `floorInputs`,
 * as an entry written before them reads. `kinds` adds a fourth batch, published with the second
 * packet, holding one entry of each treatment for code rules and patterns (a pattern's
 * representative and member, a context change, a change given one reading beside a code rule, a
 * change a code rule decided alone); `lone-member` has the member name a representative the
 * review does not hold. `spans` puts one Assess class across both batches: the small unit's
 * section holds the large unit's first requirement on no line, and both hold one no section ties
 * to a line. Every other entry is what the readers lane's
 * `decideSection` stores: its lane trail is `recordedLane`'s, and its stored floors are what
 * `floorsOf` gives for its `floorInputs` (off in this build unless `floor`). Minted in causal
 * order; `blobs` and `computations` are what its refs name, to store first.
 */
export const newShapeReview = (
  options: {
    readonly earlier?: { readonly unitId: string; readonly cycleId: string };
    readonly mismatch?: boolean;
    readonly badCause?: boolean;
    readonly badContent?: boolean;
    readonly badSide?: boolean;
    readonly badJudgements?: "lane" | "numbers";
    readonly excluded?: boolean;
    readonly carried?: boolean;
    readonly floor?: boolean;
    readonly noFloorInputs?: boolean;
    readonly kinds?: true | "lone-member";
    readonly spans?: boolean;
  } = {},
) => {
  const cycleId = mintUlid();
  const runId = mintUlid();
  const runKey = sha256Hex(`run:${runId}`);
  const [batchA, batchB] = [mintUlid(), mintUlid()];
  const [large, small] = [mintUlid(), mintUlid()];
  const earlier = options.earlier ?? {
    unitId: mintUlid(),
    cycleId: mintUlid(),
  };
  const run = { cycleId, range, runId };
  const blobs: Array<StoredContent> = [];
  const computations: Array<StoredComputation> = [];
  const blob = (label: string, value: unknown) => {
    const text = canonicalJson(value);
    blobs.push({ label, text });
    return `blob:${sha256Hex(text)}`;
  };
  const computed = (label: string, value: unknown) => {
    const spec = {
      op: "test.new-shape",
      opVersion: 1,
      inputs: { label: `${label}:${runId}` },
    };
    computations.push({ label, text: canonicalJson(value), spec });
    return `computation:${Computations.computationKey(spec).key}`;
  };
  const key = (label: string) => sha256Hex(`section:${label}:${runId}`);
  const [k1, k2, k3] = [key("k1"), key("k2"), key("k3")];
  const lines = (path: string, from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      kind: "lines",
      path,
      side: index % 2 === 0 ? "new" : "old",
      startLine: from + index * 2,
      endLine: from + index * 2,
    }));
  const largeSections = {
    sections: [
      {
        key: k1,
        parts: {
          path: "src/large.ts",
          side: options.badSide === true ? "both" : "new",
          kind: "function",
          name: "retry",
          future: "kept",
        },
        where: { startLine: 1, endLine: 1_300 },
        renamedFrom: null,
        title: "The retry loop",
        ownedRanges: lines("src/large.ts", 1, 600),
        // The section's own briefing, as its group wrote it; the second section has none.
        content: {
          facts: { text: "The retry loop stops sooner.", cites: ["p1.e3"] },
          briefed: "The [retry loop](u.large) now gives up after two attempts.",
          explained: {
            before: "It retried five times.",
            after: "It retries twice.",
            terms: [],
            cites: ["p1.e3"],
          },
        },
      },
      {
        key: k2,
        parts: { path: "src/large.ts", kind: "function", name: "export" },
        where: { startLine: 1_400, endLine: 2_500 },
        renamedFrom: "src/old-large.ts",
        title: "The exported entry point",
        ownedRanges: lines("src/large.ts", 1_401, 500),
        ...(options.badContent === true
          ? { content: { facts: { text: 7 }, briefed: null, explained: null } }
          : {}),
      },
    ],
  };
  const smallSections = {
    sections: [
      {
        key: k3,
        parts: {
          path: "src/small.ts",
          side: "none",
          kind: "block",
          name: null,
        },
        where: null,
        renamedFrom: null,
        title: "A guard",
        ownedRanges: [
          {
            kind: "lines",
            path: "src/small.ts",
            side: "new",
            startLine: 4,
            endLine: 6,
          },
        ],
      },
    ],
  };
  const namedProof = mintUlid();
  /**
   * What the readers lane's floor rule reads for a section: no removal the code facts show, the
   * effects its impact entries name, and the removal floor off, as in this build, or on under
   * `floor`, since one run reads every section under the same options; `floorsOf` gives no floor
   * for it.
   */
  const floorInputs = (effects: ReadonlyArray<string>) => ({
    facts: {
      removesDeclaration: false,
      removesPublicName: false,
      effects: [...effects],
    },
    options: { removal: options.floor === true },
  });
  const assessed = (
    sectionKey: string,
    high: boolean,
    lane: Record<string, unknown>,
    /** What the floors read; null leaves the key out, as an entry written before it reads. */
    inputs: unknown = floorInputs(high ? ["narrowed"] : []),
  ) => ({
    key: sectionKey,
    facts: { changed: 3 },
    assess: {
      complexity: {
        level: high ? "high" : "low",
        factors: [
          {
            factor: "connections",
            finding: "Twelve callers.",
            cites: ["p1.e3"],
            uncited: false,
          },
        ],
      },
      easeOfValidation: {
        level: "easy",
        requirements: [
          {
            requirement: `The ${sectionKey.slice(0, 4)} change keeps retrying.`,
            cites: ["p1.e4"],
            coverage: "solid",
            proof: [namedProof],
            kinds: ["test-run", "log"],
            agree: true,
            testable: true,
            anchors: [
              {
                path: "src/large.ts",
                side: "new",
                startLine: high ? 3 : 1_401,
                endLine: high ? 5 : 1_403,
              },
            ],
            sources: [],
            // What the lane rule saw; the reader sets the state again from the records.
            proofState: "proven",
            proofNote: "As the rule saw it.",
          },
        ],
      },
      movement: [],
      lean: null,
      gaps: high
        ? [
            {
              axis: "ease-of-validation",
              kind: "scope-missing",
              detail: "Not fetched.",
            },
          ]
        : [],
    },
    review: { verdict: "approve" },
    lane,
    lineage: "fresh",
    impact: high
      ? [{ effect: "narrowed", text: "Retries stop sooner.", cites: [] }]
      : [],
    verdict: "approve",
    restsOn: [],
    // What the floors read, as the readers lane stores it: its impact effects among the facts.
    ...(inputs === null ? {} : { floorInputs: inputs }),
  });
  const largeJudgements = {
    rule: 3,
    sections: [
      assessed(
        k1,
        true,
        {
          judged: "human-suggested",
          surfaced: "human-suggested",
          floors: [],
          applied: "human-suggested",
        },
        options.noFloorInputs === true ? null : undefined,
      ),
      ...(options.mismatch === true
        ? [
            assessed(sha256Hex("stray"), false, {
              judged: "agentic",
              surfaced: "agentic",
              floors: [],
              applied: "agentic",
            }),
          ]
        : [
            // Low complexity, easy, every requirement solid: the lane rule gives static automation,
            // and the public-surface raise (an exported entry point) takes it to human-suggested.
            // The raise is the trail's `surfaced`, never a floor. Under `floor`, its added lines
            // export nothing and it removes a declaration with the removal floor on: `floorsOf`
            // gives the removal floor, which raises it past `surfaced`, so the trail stores it.
            options.floor === true
              ? assessed(
                  k2,
                  false,
                  {
                    judged: "static-automation",
                    surfaced: "static-automation",
                    floors: [{ rule: "removal", to: "human-suggested" }],
                    applied: "human-suggested",
                  },
                  {
                    facts: {
                      removesDeclaration: true,
                      removesPublicName: false,
                      effects: [],
                    },
                    options: { removal: true },
                  },
                )
              : assessed(k2, false, {
                  judged: "static-automation",
                  surfaced: "human-suggested",
                  floors: [],
                  applied: "human-suggested",
                }),
          ]),
    ],
  };
  const smallJudgements = {
    rule: 3,
    sections: [
      {
        key: k3,
        assess: null,
        review: null,
        lane: {
          judged: null,
          surfaced: null,
          floors: [],
          applied: "human-required",
        },
        undecided: {
          cause: options.badCause === true ? "Not Reached!" : "failed",
          reading: "assess",
        },
        lineage: "fresh",
        floorInputs: floorInputs([]),
      },
    ],
  };
  // `spans`: one Assess class across both batches, as reading groups follow directories, not Map
  // groups. The small unit's section holds the large unit's first requirement on no line, and both
  // units' first sections hold a requirement no section ties to a line.
  if (options.spans === true) {
    const guide = {
      requirement: "The guide names the retry flag.",
      cites: ["p1.e4"],
      coverage: "missing",
      proof: [],
      kinds: ["log"],
      agree: true,
      testable: false,
      untested: "It is prose.",
      anchors: [],
      sources: [],
    };
    const first = largeJudgements.sections[0]!.assess.easeOfValidation
      .requirements as Array<unknown>;
    first.push(guide);
    (smallJudgements.sections as Array<unknown>)[0] = {
      key: k3,
      assess: {
        complexity: { level: "low", factors: [] },
        easeOfValidation: {
          level: "hard",
          requirements: [{ ...(first[0] as object), anchors: [] }, guide],
        },
        movement: [],
        lean: null,
        gaps: [],
      },
      review: { verdict: "approve" },
      lane: {
        judged: "human-suggested",
        surfaced: "human-suggested",
        floors: [],
        applied: "human-suggested",
      },
      lineage: "fresh",
      floorInputs: floorInputs([]),
    };
  }
  // A lockfile the map excluded: one section in its own unit and batch, which no reading reads.
  const [batchC, lockUnit, k4] = [mintUlid(), mintUlid(), key("k4")];
  const lockSections: typeof smallSections = {
    sections: [
      {
        key: k4,
        parts: { path: "bun.lock", side: "none", kind: "block", name: null },
        where: null,
        renamedFrom: null,
        title: "bun.lock",
        ownedRanges: [
          {
            kind: "lines",
            path: "bun.lock",
            side: "new",
            startLine: 2,
            endLine: 2,
          },
        ],
      },
    ],
  };
  const lockJudgements = {
    rule: 3,
    sections: [
      {
        key: k4,
        facts: {
          kind: "block",
          declared: null,
          boundaries: "fallback",
          characters: 12,
        },
        assess: null,
        review: null,
        lane: {
          judged: null,
          surfaced: null,
          floors: [],
          applied: "human-suggested",
        },
        excluded: { reason: "lockfile" },
        impact: [],
        verdict: null,
        restsOn: [],
        lineage: "fresh",
        floorInputs: floorInputs([]),
      },
    ],
  };
  // One entry of each kind the readers lane writes for code rules and patterns, under `kinds`, in a
  // batch of two files published with the second packet. `src/kinds.ts`, agentic: a pattern's
  // representative (two readings) and its member, which carries the representative's judgement
  // whole, and an import-only change kept as its context at a lower lane. `src/kinds.test.ts`,
  // static automation: a test change given one reading beside a code rule, and a whitespace-only
  // change a code rule decided with no reading. `lone-member` names a representative this review
  // does not hold, as one published in another review would be.
  const [batchD, kindsUnit, testsUnit] = [mintUlid(), mintUlid(), mintUlid()];
  const [k5, k6, k7, k8, k9] = ["k5", "k6", "k7", "k8", "k9"].map(key) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const kindsSection = (
    sectionKey: string,
    path: string,
    name: string | null,
    title: string,
    startLine: number,
  ) => ({
    key: sectionKey,
    parts: {
      path,
      side: "new",
      kind: name === null ? "block" : "function",
      name,
    },
    where: { startLine, endLine: startLine + 9 },
    renamedFrom: null,
    title,
    ownedRanges: [
      { kind: "lines", path, side: "new", startLine, endLine: startLine + 1 },
    ],
  });
  const kindsSections = {
    sections: [
      kindsSection(k5, "src/kinds.ts", "parse", "The parse helper", 1),
      kindsSection(k6, "src/kinds.ts", "format", "The format helper", 20),
      kindsSection(k7, "src/kinds.ts", null, "The imports", 40),
    ],
  };
  const testsSections = {
    sections: [
      kindsSection(k8, "src/kinds.test.ts", "parses", "The parse test", 1),
      kindsSection(k9, "src/kinds.test.ts", null, "The test's spacing", 30),
    ],
  };
  const trail = (lane: string) => ({
    judged: lane,
    surfaced: lane,
    floors: [],
    applied: lane,
  });
  /** The levels a code rule sets, or a model's when it found nothing to cite. */
  const levels = {
    complexity: { level: "low", factors: [] },
    easeOfValidation: { level: "easy", requirements: [] },
    movement: [],
    lean: null,
    gaps: [],
  };
  const rule = (name: string, statement: string, inputs: unknown) => ({
    rule: name,
    version: 1,
    inputs,
    result: "holds",
    reason: `The rule ${name} holds.`,
    statement,
  });
  const family = {
    key: sha256Hex(`family:parse:${runId}`),
    reading: `computation:${sha256Hex(`reading:k5:${runId}`)}`,
  };
  const kindsJudgements = {
    rule: 3,
    sections: [
      {
        key: k5,
        facts: { changed: 2 },
        assess: levels,
        review: { verdict: "approve" },
        lane: trail("agentic"),
        lineage: "fresh",
        impact: [],
        verdict: "approve",
        restsOn: [],
        floorInputs: floorInputs([]),
        origin: { assess: "model", review: "model" },
        family: { ...family, representative: k5, members: 2 },
      },
      {
        key: k6,
        facts: { changed: 2 },
        // The representative's judgement, copied whole; its own facts and trail.
        assess: levels,
        review: { verdict: "approve" },
        lane: trail("agentic"),
        lineage: "fresh",
        impact: [],
        verdict: "approve",
        restsOn: [],
        floorInputs: floorInputs([]),
        origin: { assess: "model", review: "family" },
        family: {
          ...family,
          representative:
            options.kinds === "lone-member"
              ? sha256Hex(`section:elsewhere:${runId}`)
              : k5,
        },
      },
      {
        key: k7,
        facts: { changed: 2 },
        assess: null,
        review: null,
        lane: trail("static-automation"),
        lineage: "fresh",
        impact: [],
        verdict: null,
        restsOn: [],
        floorInputs: floorInputs([]),
        rules: [rule("imports-only", "imports only", { imports: 2 })],
        context: true,
      },
    ],
  };
  const testsJudgements = {
    rule: 3,
    sections: [
      {
        key: k8,
        facts: { changed: 2 },
        assess: levels,
        review: { verdict: "approve" },
        lane: trail("static-automation"),
        lineage: "fresh",
        impact: [],
        verdict: "approve",
        restsOn: [],
        floorInputs: floorInputs([]),
        origin: { assess: "rule", review: "model" },
        rules: [rule("test-only", "a test", { kind: "test" })],
      },
      {
        key: k9,
        facts: { changed: 2 },
        assess: levels,
        review: null,
        lane: trail("static-automation"),
        lineage: "fresh",
        impact: [],
        verdict: null,
        restsOn: [],
        floorInputs: floorInputs([]),
        origin: { assess: "rule", review: "none" },
        rules: [
          rule("whitespace-only", "whitespace only", { tokensEqual: true }),
        ],
      },
    ],
  };
  type Blob = {
    readonly sections: ReadonlyArray<{
      readonly key: string;
      readonly parts: { readonly path: string };
      readonly ownedRanges: ReadonlyArray<{
        readonly startLine: number;
        readonly endLine: number;
      }>;
    }>;
  };
  const unitKey = (sections: Blob) =>
    sha256Hex(sections.sections.map((section) => section.key).join(","));
  const unitEvent = (
    unitId: string,
    batchId: string,
    sections: Blob,
    title: string,
  ) => ({
    ...envelope(
      "unit.recorded@3",
      `unit:${unitId}`,
      agent,
      { cycleId, batchId, unitIds: [unitId] },
      {
        title,
        titleBy: "code",
        path: sections.sections[0]!.parts.path,
        key: unitKey(sections),
        sections: { count: sections.sections.length },
        ranges: {
          count: sections.sections.reduce(
            (n, section) => n + section.ownedRanges.length,
            0,
          ),
          lines: sections.sections.reduce(
            (n, section) =>
              n +
              section.ownedRanges.reduce(
                (m, r) => m + (r.endLine - r.startLine + 1),
                0,
              ),
            0,
          ),
        },
      },
    ),
    refs: [{ ref: blob(`sections:${title}`, sections), role: "sections" }],
  });
  const registration = envelope(
    "actor.registered@1",
    `actor:${agent}`,
    agent,
    undefined,
    {
      actorKind: "agent",
      harness: "neuve",
      sessionId: runId,
    },
  );
  const humanRegistration = envelope(
    "actor.registered@1",
    `actor:${human}`,
    human,
    undefined,
    {
      actorKind: "human",
      harness: "git",
      email: "owner@example.com",
    },
  );
  const cycle = envelope(
    "cycle.opened@1",
    `cycle:${cycleId}`,
    agent,
    { cycleId, range },
    {},
  );
  const batchEvents = [
    batchA,
    batchB,
    ...(options.excluded === true ? [batchC] : []),
    ...(options.kinds === undefined ? [] : [batchD]),
  ].map((batchId, index) =>
    envelope(
      "batch.recorded@1",
      `batch:${batchId}`,
      agent,
      { cycleId, batchId },
      {
        title: `Batch ${index + 1}`,
        focus: "Focus",
      },
    ),
  );
  const units = {
    large: unitEvent(large, batchA, largeSections, "Large file"),
    small: unitEvent(small, batchB, smallSections, "Small file"),
  };
  const assessments = {
    large: {
      ...envelope(
        "assessment.recorded@4",
        `assessment:${large}`,
        agent,
        { cycleId, unitIds: [large] },
        {
          lane: "human-suggested",
          laneRule: 3,
          sections: { count: 2, raised: 1, undecided: {} },
        },
      ),
      refs: [
        {
          ref: computed(
            "judgements:large",
            options.badJudgements === "numbers"
              ? {
                  ...largeJudgements,
                  sections: largeJudgements.sections.map((_, n) => n),
                }
              : options.badJudgements === "lane"
                ? {
                    ...largeJudgements,
                    sections: largeJudgements.sections.map((entry, n) =>
                      n === 0
                        ? {
                            ...entry,
                            lane: { ...entry.lane, applied: "bogus" },
                          }
                        : entry,
                    ),
                  }
                : largeJudgements,
          ),
          role: "judgements",
        },
      ],
    },
    small: {
      ...envelope(
        "assessment.recorded@4",
        `assessment:${small}`,
        agent,
        { cycleId, unitIds: [small] },
        {
          lane: "human-required",
          laneRule: 3,
          sections: { count: 1, raised: 0, undecided: { failed: 1 } },
        },
      ),
      refs: [
        {
          ref: computed("judgements:small", smallJudgements),
          role: "judgements",
        },
      ],
    },
  };
  const impact = envelope(
    "comment.recorded@3",
    `comment:${large}:impact`,
    agent,
    { cycleId, unitIds: [large] },
    {
      body: "Retries now stop after two attempts.",
      anchor: { path: "src/large.ts", side: "new", startLine: 3, endLine: 3 },
      finding: {
        kind: "impact",
        about: "code",
        effect: "narrowed",
        summary: "Retries stop after two attempts instead of five.",
        evidence: [],
      },
    },
  );
  const lineage = envelope(
    "lineage.recorded@1",
    `lineage:${large}`,
    agent,
    { cycleId, unitIds: [large, earlier.unitId] },
    {
      from: [
        {
          unitId: earlier.unitId,
          cycleId: earlier.cycleId,
          relation: "changed",
          unchanged: 1,
          changed: 1,
          lane: "agentic",
        },
      ],
    },
  );
  const facts = {
    ...envelope(
      "delivery.recorded@1",
      `delivery:${large}:facts`,
      agent,
      { cycleId, batchId: batchA, unitIds: [large] },
      {
        content: "facts",
        verdictWords: 0,
      },
    ),
    refs: [
      {
        ref: computed("facts:large", {
          text: "The [retry loop](u.large) changes.",
          cites: ["u.large"],
        }),
        role: "content",
      },
    ],
  };
  // The lockfile's unit and its assessment: human-suggested, as today's review gives such a file.
  const lock =
    options.excluded === true
      ? {
          unit: unitEvent(lockUnit, batchC, lockSections, "Lockfile"),
          assessment: {
            ...envelope(
              "assessment.recorded@4",
              `assessment:${lockUnit}`,
              agent,
              { cycleId, unitIds: [lockUnit] },
              {
                lane: "human-suggested",
                laneRule: 3,
                sections: { count: 1, raised: 0, undecided: {} },
              },
            ),
            refs: [
              {
                ref: computed("judgements:lock", lockJudgements),
                role: "judgements",
              },
            ],
          },
        }
      : undefined;
  // The two units of the kinds batch and their assessments. A context change counts among its
  // unit's changes and is not raised: its own trail places it where it is.
  const kindsAssessment = (
    unitId: string,
    lane: string,
    count: number,
    label: string,
    judgements: unknown,
  ) => ({
    ...envelope(
      "assessment.recorded@4",
      `assessment:${unitId}`,
      agent,
      { cycleId, unitIds: [unitId] },
      { lane, laneRule: 3, sections: { count, raised: 0, undecided: {} } },
    ),
    refs: [{ ref: computed(label, judgements), role: "judgements" }],
  });
  const kinds =
    options.kinds === undefined
      ? undefined
      : {
          units: [
            unitEvent(kindsUnit, batchD, kindsSections, "Kinds file"),
            unitEvent(testsUnit, batchD, testsSections, "Kinds test file"),
          ],
          assessments: [
            kindsAssessment(
              kindsUnit,
              "agentic",
              3,
              "judgements:kinds",
              kindsJudgements,
            ),
            kindsAssessment(
              testsUnit,
              "static-automation",
              2,
              "judgements:kinds-test",
              testsJudgements,
            ),
          ],
        };
  // A person's approval of an earlier human-required unit the small unit is unchanged from, carried
  // onto it as the publisher carries it: by the person, citing the earlier decision and the lineage.
  const earlierSmall = mintUlid();
  const smallLineage =
    options.carried === true
      ? envelope(
          "lineage.recorded@1",
          `lineage:${small}`,
          agent,
          { cycleId, unitIds: [small, earlierSmall] },
          {
            from: [
              {
                unitId: earlierSmall,
                cycleId: earlier.cycleId,
                relation: "unchanged",
                unchanged: 1,
                changed: 0,
                lane: "human-required",
              },
            ],
          },
        )
      : undefined;
  const earlierDecision = mintUlid();
  const carried =
    smallLineage === undefined
      ? undefined
      : envelope(
          "disposition.carried@1",
          `review:${runId}:carried:${earlierDecision}`,
          human,
          { cycleId, unitIds: [small] },
          {
            verdict: "approve",
            reviewedHeadOid: headOid,
            restsOn: [],
            proof: [],
            lineage: "carried",
            from: {
              review: mintUlid(),
              cycle: earlier.cycleId,
              head: "a".repeat(40),
              judgement: earlierDecision,
              output: smallLineage.id,
              savedMs: 0,
            },
          },
        );
  const gap = (
    label: string,
    kind: string,
    unitIds?: ReadonlyArray<string>,
  ) => ({
    ...envelope(
      "gap.disclosed@1",
      `review:${runId}:gap:${label}`,
      agent,
      unitIds === undefined ? run : { ...run, unitIds: [...unitIds] },
      {
        kind,
        detail: `The ${label} gap.`,
      },
    ),
    kind: "gap.disclosed@1" as const,
    payload: { kind, detail: `The ${label} gap.` },
  });
  const gaps = {
    firstOnly: gap("first-only", "stage-interrupted"),
    batch: gap("batch", "scope-missing"),
    // The one gap per unit that says a section of it no agent decided, naming that unit.
    second: gap("second", "undecided-failed", [small]),
  };
  const notHeld = mintUlid();
  const assembled = computed(
    "assembled",
    assembledBatch({ "u.large": { kind: "unit", ref: null, entry: "b1.u1" } }),
  );
  const entryA = {
    batch: "b1",
    batchId: batchA,
    key: sha256Hex("src/large.ts"),
    assembled,
    units: [
      {
        unit: "b1.u1",
        unitId: large,
        path: "src/large.ts",
        key: unitKey(largeSections),
        events: [units.large, assessments.large, impact, lineage, facts].map(
          (e) => ({ kind: e.kind, id: e.id }),
        ),
      },
    ],
    events: [{ kind: "batch.recorded@1", id: batchEvents[0]!.id }],
    gaps: [{ id: gaps.batch.id, kind: gaps.batch.payload.kind }],
    publishedBy: { runId, ordinal: 1 },
  };
  const entryB = {
    batch: "b2",
    batchId: batchB,
    key: sha256Hex("src/small.ts"),
    assembled: computed("assembled:b2", assembledBatch({})),
    units: [
      {
        unit: "b2.u1",
        unitId: small,
        path: "src/small.ts",
        key: unitKey(smallSections),
        events: [
          units.small,
          assessments.small,
          ...(smallLineage === undefined ? [] : [smallLineage]),
          ...(carried === undefined ? [] : [carried]),
        ].map((e) => ({
          kind: e.kind,
          id: e.id,
        })),
      },
    ],
    events: [{ kind: "batch.recorded@1", id: batchEvents[1]!.id }],
    gaps: [],
    publishedBy: { runId, ordinal: 2 },
  };
  const entryC =
    lock === undefined
      ? undefined
      : {
          batch: "b3",
          batchId: batchC,
          key: sha256Hex("bun.lock"),
          assembled: computed("assembled:b3", assembledBatch({})),
          units: [
            {
              unit: "b3.u1",
              unitId: lockUnit,
              path: "bun.lock",
              key: unitKey(lockSections),
              events: [lock.unit, lock.assessment].map((e) => ({
                kind: e.kind,
                id: e.id,
              })),
            },
          ],
          events: [{ kind: "batch.recorded@1", id: batchEvents[2]!.id }],
          gaps: [],
          publishedBy: { runId, ordinal: 2 },
        };
  const entryD =
    kinds === undefined
      ? undefined
      : {
          batch: "b4",
          batchId: batchD,
          key: sha256Hex("src/kinds.test.ts,src/kinds.ts"),
          assembled: computed("assembled:b4", assembledBatch({})),
          units: [
            [kindsUnit, "src/kinds.ts", kindsSections] as const,
            [testsUnit, "src/kinds.test.ts", testsSections] as const,
          ].map(([unitId, path, sections], index) => ({
            unit: `b4.u${index + 1}`,
            unitId,
            path,
            key: unitKey(sections),
            events: [kinds.units[index]!, kinds.assessments[index]!].map(
              (e) => ({ kind: e.kind, id: e.id }),
            ),
          })),
          events: [{ kind: "batch.recorded@1", id: batchEvents.at(-1)!.id }],
          gaps: [],
          publishedBy: { runId, ordinal: 2 },
        };
  // The lockfile's and the kinds' batches, when there are any, are published with the second packet.
  const more = {
    batches: (entryC === undefined ? 0 : 1) + (entryD === undefined ? 0 : 1),
    units: (entryC === undefined ? 0 : 1) + (entryD === undefined ? 0 : 2),
    sections: (entryC === undefined ? 0 : 1) + (entryD === undefined ? 0 : 5),
  };
  const packet = (ordinal: number, manifest: unknown, supersedes?: string) => ({
    ...envelope(
      "packet.published@2",
      `review:${cycleId}:${runKey}:packet:${ordinal}`,
      agent,
      run,
      {
        complete: ordinal === 2,
        ordinal,
        counts: {
          batches: ordinal === 1 ? 1 : 2 + more.batches,
          units: ordinal === 1 ? 1 : 2 + more.units,
          sections: ordinal === 1 ? 2 : 3 + more.sections,
          contextReferences: 0,
          assessments: ordinal === 1 ? 1 : 2 + more.units,
          deliveries: 1,
          dispositions: 0,
          comments: 1,
          gaps: ordinal === 1 ? 2 : 3,
          pending:
            ordinal === 1
              ? {
                  batches: 1 + more.batches,
                  sections: 1 + more.sections,
                }
              : { batches: 0, sections: 0 },
          undecided: ordinal === 1 ? {} : { failed: 1 },
        },
        added: {
          batches: ordinal === 1 ? 1 : 1 + more.batches,
          units: ordinal === 1 ? 1 : 1 + more.units,
          sections: ordinal === 1 ? 2 : 1 + more.sections,
          undecided: ordinal === 1 ? {} : { failed: 1 },
        },
      },
      supersedes === undefined ? undefined : { supersedes },
    ),
    refs: [{ ref: blob(`manifest:${ordinal}`, manifest), role: "manifest" }],
  });
  const first = packet(1, {
    version: 8,
    run: { runId, runKey, cycleId },
    sequence: { runKey, ordinal: 1, base: null },
    batches: [entryA],
    gaps: [{ id: gaps.firstOnly.id, kind: gaps.firstOnly.payload.kind }],
  });
  const second = packet(
    2,
    {
      version: 8,
      run: { runId, runKey, cycleId },
      sequence: { runKey, ordinal: 2, base: first.id },
      batches: [
        entryA,
        entryB,
        ...(entryC === undefined ? [] : [entryC]),
        ...(entryD === undefined ? [] : [entryD]),
      ],
      gaps: [
        { id: gaps.second.id, kind: gaps.second.payload.kind },
        { id: notHeld, kind: "stage-interrupted" },
      ],
      unmatched: [mintUlid()],
    },
    first.id,
  );
  return {
    cycleId,
    runId,
    batches: [batchA, batchB] as const,
    units: { large, small },
    sectionKeys: { k1, k2, k3 },
    /** The lockfile's batch, unit and section key, when `excluded` asked for them. */
    lock:
      lock === undefined
        ? undefined
        : { batchId: batchC, unitId: lockUnit, sectionKey: k4 },
    /** The kinds batch, its units and its section keys, when `kinds` asked for them. */
    kinds:
      kinds === undefined
        ? undefined
        : {
            batchId: batchD,
            units: { kinds: kindsUnit, tests: testsUnit },
            sectionKeys: {
              representative: k5,
              member: k6,
              context: k7,
              oneReading: k8,
              ruled: k9,
            },
          },
    earlier,
    namedProof,
    notHeld,
    events: {
      registration,
      humanRegistration,
      cycle,
      batchEvents,
      units,
      assessments,
      impact,
      lineage,
      facts,
      gaps,
      first,
      second,
      lock,
      smallLineage,
      carried,
    },
    blobs,
    computations,
    /** Every event, in causal order. */
    all: [
      registration,
      humanRegistration,
      cycle,
      ...batchEvents,
      units.large,
      units.small,
      assessments.large,
      assessments.small,
      impact,
      lineage,
      facts,
      ...(lock === undefined ? [] : [lock.unit, lock.assessment]),
      ...(kinds === undefined ? [] : [...kinds.units, ...kinds.assessments]),
      ...(smallLineage === undefined ? [] : [smallLineage]),
      ...(carried === undefined ? [] : [carried]),
      gaps.firstOnly,
      gaps.batch,
      first,
      gaps.second,
      second,
    ],
  };
};
