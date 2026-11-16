import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { judgedGrade } from "../../retrieval-bench/score/coverage.ts";
import type { HunkGold } from "../../retrieval-bench/score/types.ts";
import { ensureDir, sha256 } from "../common.ts";
import { DEFAULT_GOLD, loadViews } from "../score.ts";
import { FULL_TEST_RESULTS } from "./config.ts";
import { anchoredIn, harnessIdOf, referenceItem } from "./measures.ts";
import { loadScoringInputs } from "../../retrieval-bench/scoring-inputs.ts";
import {
  hunkViews,
  inCase1055,
  packetBatches,
  packetUnits,
  type PacketUnitLite,
  type StoredRun,
} from "./packets.ts";
import { isStored, readStored } from "./phases.ts";
import { readFullTestSelection } from "./select.ts";

/**
 * The owner's decide-then-reveal sheet (FT13, 10.71, 9.38). `sheet.json` is the canonical form,
 * described by `sheet.schema.json` (the `SheetFile` schema below): every item with a stable ID, the
 * question the owner decides from, the neutral-briefing slot, the reveal, and an empty answer the
 * owner-facing page fills (it records each first answer before it shows the reveal). `sheet.md` is
 * a fallback rendering only: raw Markdown shows the reveal, so it is never the owner's instrument.
 *
 * Each item shows only what the owner decides from (the unit's Facts, its owned lines, and a
 * neutral briefing from a separate context that never proposes an answer, written later by
 * headless Claude Code on the subscription and left as a slot here); the owner records a first
 * answer, then opens the reveal (the agent's lane, quadrant, rationale, verdict and findings), then
 * records the final answer and judges each finding. Nothing on the sheet comes from a model judge.
 *
 * Sample (from phase C's packets, the harness as shipped): every uncited request for changes, up
 * to 6 approvals without recorded proof, every forged-evidence defect and up to 2 test-bloat
 * warnings, every unit in 10.55's case, at most 20 units in that priority; one item per run that
 * timed out (what it published and disclosed); apart from H9's sheet, a labelled block of up to 6
 * phase-A units where A and A′ disagree on lane or verdict; 20 margin cards (a published context
 * reference against the gold's grade for its lines, drawn only from references whose lines the
 * gold has judged: a card measures the reference against that grade, so an unjudged one cannot do
 * its job, and the filter comes before the seeded order so the draw stays fixed by rule); and the
 * digest rubric sample (6 batch digests,
 * 10 unit digests with their Facts, Briefed and Explained stops). Sampling within a bucket is by
 * SHA-256 of the sheet seed and the unit, so it is fixed by rule, not picked.
 */

export const SHEET_SEED = "neuve-10.89-full-test-sheet";

/**
 * An item's ID from what it is about (the unit, run, reference or batch), never its position, so
 * an answer recorded against it survives a rebuild that adds or drops other items.
 */
/**
 * What the owner decides from must not carry the answer: lane, quadrant and verdict words in a
 * unit's title and Facts are masked before the first answer (Facts never name them by design, so
 * this guards the exceptions code flagged, 10.61). The reveal shows the unmasked text's verdict.
 */
const LANE_WORDS =
  /\b(?:static[- ]automation|agentic|human[- ]suggested|human[- ]required|(?:low|high)[- ](?:easy|hard)|request(?:s|ed|ing)? changes|approv(?:e|es|ed|al|ing))\b/gi;
export const maskLaneWords = (text: string) =>
  text.replace(LANE_WORDS, "[masked]");

export const stableId = (prefix: string, of: string) =>
  `${prefix}-${sha256(`${SHEET_SEED}:${prefix}:${of}`).slice(0, 10)}`;
export const SHEET_UNITS_MAX = 20;
const APPROVALS_WITHOUT_PROOF = 6;
const TEST_BLOAT = 2;
const PHASE_A_BLOCK = 6;
const MARGIN_CARDS = 20;
const BATCH_DIGESTS = 6;
const UNIT_DIGESTS = 10;

const byHash = <T>(items: ReadonlyArray<T>, key: (item: T) => string) =>
  [...items].sort((a, b) =>
    sha256(`${SHEET_SEED}:${key(a)}`) < sha256(`${SHEET_SEED}:${key(b)}`)
      ? -1
      : 1,
  );

export interface SheetUnit {
  readonly caseId: string;
  readonly batchId: string;
  readonly unit: PacketUnitLite;
}

type Bucket =
  | "uncited-request"
  | "forged-defect"
  | "case-10.55"
  | "test-bloat"
  | "approval-without-proof";
const PRIORITY: ReadonlyArray<Bucket> = [
  "uncited-request",
  "forged-defect",
  "case-10.55",
  "test-bloat",
  "approval-without-proof",
];

/** Which of FT13's buckets a unit falls in (a unit can fall in several; it is shown once). */
export const bucketsOf = (unit: PacketUnitLite): Array<Bucket> => {
  const out: Array<Bucket> = [];
  const verdict = unit.disposition?.payload.verdict;
  if (
    verdict === "request-changes" &&
    (unit.disposition?.payload.restsOn.length === 0 ||
      unit.content.guided?.review?.uncited === true)
  )
    out.push("uncited-request");
  if (unit.comments.some((c) => c.payload.finding?.signal === "forged"))
    out.push("forged-defect");
  if (unit.assessment !== undefined && inCase1055(unit.assessment.payload))
    out.push("case-10.55");
  if (unit.comments.some((c) => c.payload.finding?.signal === "test-bloat"))
    out.push("test-bloat");
  if (
    verdict === "approve" &&
    (unit.disposition?.payload.proof.length ?? 0) === 0
  )
    out.push("approval-without-proof");
  return out;
};

/** FT13's sample over the units given, bounded as 10.71 rules it; what was cut is returned too. */
export const sampleSheet = (units: ReadonlyArray<SheetUnit>) => {
  const caps: Record<Bucket, number> = {
    "uncited-request": Number.POSITIVE_INFINITY,
    "forged-defect": Number.POSITIVE_INFINITY,
    "case-10.55": Number.POSITIVE_INFINITY,
    "test-bloat": TEST_BLOAT,
    "approval-without-proof": APPROVALS_WITHOUT_PROOF,
  };
  const chosen: Array<SheetUnit & { readonly buckets: ReadonlyArray<Bucket> }> =
    [];
  const seen = new Set<string>();
  const cut: Array<{ unitId: string; bucket: Bucket }> = [];
  for (const bucket of PRIORITY) {
    const inBucket = byHash(
      units.filter((entry) => bucketsOf(entry.unit).includes(bucket)),
      (entry) => entry.unit.unitId,
    );
    let taken = 0;
    for (const entry of inBucket) {
      if (seen.has(entry.unit.unitId)) continue;
      if (taken >= caps[bucket] || chosen.length >= SHEET_UNITS_MAX) {
        cut.push({ unitId: entry.unit.unitId, bucket });
        continue;
      }
      seen.add(entry.unit.unitId);
      chosen.push({ ...entry, buckets: bucketsOf(entry.unit) });
      taken++;
    }
  }
  return { chosen, cut };
};

const ownedLines = (unit: PacketUnitLite) =>
  (unit.recorded?.payload.ownedRanges ?? []).map((r) =>
    r.kind === "lines"
      ? `${r.path} (${r.side}) ${r.startLine}-${r.endLine}`
      : `${r.path} (${r.side}, whole file)`,
  );

// The canonical file

/** A choice the owner records: one of `options`, or null until answered. */
const Choice = z.strictObject({
  label: z.string(),
  options: z.array(z.string()),
  value: z.string().nullable(),
});
const UnitDecision = z.strictObject({
  complexity: Choice,
  easeOfValidation: Choice,
  lane: Choice,
  verdict: Choice,
  note: z.string().nullable(),
});

const unitDecision = (): z.infer<typeof UnitDecision> => ({
  complexity: { label: "Complexity", options: ["low", "high"], value: null },
  easeOfValidation: {
    label: "Ease of validation",
    options: ["easy", "hard"],
    value: null,
  },
  lane: {
    label: "Lane",
    options: [
      "static-automation",
      "agentic",
      "human-suggested",
      "human-required",
    ],
    value: null,
  },
  verdict: {
    label: "Verdict",
    options: ["approve", "request-changes"],
    value: null,
  },
  note: null,
});

/** The neutral briefing (9.38): written later by a separate context; it states context and proposes no answer. */
const Briefing = z.strictObject({
  text: z.string().nullable(),
  by: z.string().nullable(),
});
const emptyBriefing = () => ({ text: null, by: null });

const Finding = z.strictObject({
  commentId: z.string(),
  kind: z.string(),
  about: z.string().nullable(),
  signal: z.string().nullable(),
  anchor: z.string().nullable(),
  body: z.string(),
});

const UnitItem = z.strictObject({
  id: z.string(),
  kind: z.enum(["unit", "phase-a-unit"]),
  /** H9's sheet (phase C) or the phase-A block, reported apart and never counted as H9's. */
  block: z.enum(["h9", "phase-a"]),
  caseId: z.string(),
  unitId: z.string(),
  buckets: z.array(z.string()),
  question: z.strictObject({
    title: z.string(),
    ownedLines: z.array(z.string()),
    facts: z.string().nullable(),
  }),
  briefing: Briefing,
  reveal: z.strictObject({
    lane: z.string().nullable(),
    quadrant: z.string().nullable(),
    complexity: z.string().nullable(),
    easeOfValidation: z.string().nullable(),
    gaps: z.array(z.string()),
    rationale: z.string().nullable(),
    verdict: z.string().nullable(),
    findings: z.array(Finding),
  }),
  answer: z.strictObject({
    first: UnitDecision,
    final: UnitDecision,
    /** Each finding judged after the verdict is decided: valid, invalid or unsure. */
    findings: z.array(
      z.strictObject({
        commentId: z.string(),
        judged: z.enum(["valid", "invalid", "unsure"]).nullable(),
      }),
    ),
  }),
});

const TimedOutItem = z.strictObject({
  id: z.string(),
  kind: z.literal("timed-out-run"),
  caseId: z.string(),
  question: z.strictObject({
    published: z.string(),
    disclosed: z.array(z.string()),
  }),
  briefing: Briefing,
  reveal: z.null(),
  answer: z.strictObject({ judged: Choice, note: z.string().nullable() }),
});

const MarginItem = z.strictObject({
  id: z.string(),
  kind: z.literal("margin-card"),
  caseId: z.string(),
  unitId: z.string(),
  hunkId: z.string(),
  /**
   * What the owner decides from: the cited lines, the M4 hunk they are judged against, and the
   * citing unit's title and Facts (question-side, masked as a unit item's are).
   */
  question: z.strictObject({
    region: z.string(),
    hunk: z.string(),
    citingUnit: z.strictObject({
      title: z.string(),
      facts: z.string().nullable(),
    }),
  }),
  briefing: Briefing,
  /** The harness's published reference (its own grade apart from its text), then the gold's grade. */
  reveal: z.strictObject({
    harness: z.strictObject({
      handle: z.string().nullable(),
      grade: z.string().nullable(),
      summary: z.string(),
    }),
    goldGrade: z.string(),
  }),
  answer: z.strictObject({ first: Choice, note: z.string().nullable() }),
});

const Rubric = z.strictObject({
  accurate: Choice,
  complete: Choice,
  misleadingClaim: Choice,
  neutralBeforeVerdict: Choice,
  note: z.string().nullable(),
});
const rubric = (): z.infer<typeof Rubric> => ({
  accurate: { label: "Accurate", options: ["yes", "no"], value: null },
  complete: { label: "Complete", options: ["yes", "no"], value: null },
  misleadingClaim: {
    label: "Misleading claim",
    options: ["none", "some"],
    value: null,
  },
  neutralBeforeVerdict: {
    label: "Neutral before the verdict",
    options: ["yes", "no"],
    value: null,
  },
  note: null,
});

const DigestItem = z.strictObject({
  id: z.string(),
  kind: z.enum(["batch-digest", "unit-digest"]),
  caseId: z.string(),
  unitId: z.string().nullable(),
  question: z.strictObject({
    title: z.string(),
    digest: z.string().nullable(),
    facts: z.string().nullable(),
    briefed: z.string().nullable(),
    explained: z.string().nullable(),
  }),
  briefing: Briefing,
  reveal: z.null(),
  answer: Rubric,
});

export const SheetItem = z.discriminatedUnion("kind", [
  UnitItem.extend({ kind: z.literal("unit") }),
  UnitItem.extend({ kind: z.literal("phase-a-unit") }),
  TimedOutItem,
  MarginItem,
  DigestItem.extend({ kind: z.literal("batch-digest") }),
  DigestItem.extend({ kind: z.literal("unit-digest") }),
]);
export type SheetItem = z.infer<typeof SheetItem>;

export const SheetFile = z.strictObject({
  schemaVersion: z.literal(1),
  seed: z.string(),
  builtAt: z.string(),
  /** Units beyond 10.71's bounds, named so nothing is dropped silently. */
  cut: z.array(z.strictObject({ unitId: z.string(), bucket: z.string() })),
  /** The margin cards' pool: every candidate reference, and those whose lines the gold has judged. */
  marginPool: z.strictObject({
    candidates: z.int(),
    judged: z.int(),
    unjudged: z.int(),
  }),
  items: z.array(SheetItem),
});
export type SheetFile = z.infer<typeof SheetFile>;

export const unitSheetItem = (
  id: string,
  block: "h9" | "phase-a",
  entry: SheetUnit,
  buckets: ReadonlyArray<string>,
): SheetItem => {
  const a = entry.unit.assessment?.payload;
  const suggested = entry.unit.content.guided?.suggestion?.verdict;
  return {
    id,
    kind: block === "h9" ? "unit" : "phase-a-unit",
    block,
    caseId: entry.caseId,
    unitId: entry.unit.unitId,
    buckets: [...buckets],
    question: {
      title: maskLaneWords(
        entry.unit.recorded?.payload.title ?? entry.unit.unitId,
      ),
      ownedLines: ownedLines(entry.unit),
      facts:
        entry.unit.content.facts === undefined
          ? null
          : maskLaneWords(entry.unit.content.facts.text),
    },
    briefing: emptyBriefing(),
    reveal: {
      lane: a?.lane ?? null,
      quadrant: a?.quadrant ?? null,
      complexity: a?.complexity.level ?? null,
      easeOfValidation: a?.easeOfValidation.level ?? null,
      gaps: (a?.gaps ?? []).map((g) => `${g.axis}: ${g.kind}`),
      rationale: a?.rationale ?? null,
      verdict:
        entry.unit.disposition?.payload.verdict ??
        (suggested === undefined ? null : `suggested ${suggested}`),
      findings: entry.unit.comments.map((c) => ({
        commentId: c.id,
        kind: c.payload.finding?.kind ?? "comment",
        about: c.payload.finding?.about ?? null,
        signal: c.payload.finding?.signal ?? null,
        anchor:
          c.payload.anchor === undefined
            ? null
            : `${c.payload.anchor.path} (${c.payload.anchor.side}) ${c.payload.anchor.startLine}-${c.payload.anchor.endLine}`,
        body: c.payload.body,
      })),
    },
    answer: {
      first: unitDecision(),
      final: unitDecision(),
      findings: entry.unit.comments.map((c) => ({
        commentId: c.id,
        judged: null,
      })),
    },
  };
};

// The fallback rendering

const choiceLine = (choice: {
  label: string;
  options: ReadonlyArray<string>;
}) =>
  `- ${choice.label}: ${choice.options.map((option) => `[ ] ${option}`).join("  ")}`;

const decisionLines = (
  label: string,
  decision: z.infer<typeof UnitDecision>,
) => [
  `**${label}**`,
  "",
  choiceLine(decision.complexity),
  choiceLine(decision.easeOfValidation),
  choiceLine(decision.lane),
  choiceLine(decision.verdict),
  "- Note:",
  "",
];

/** sheet.md, from the canonical items: a fallback only, since raw Markdown shows every reveal. */
export const sheetMarkdown = (file: SheetFile) => {
  const md: Array<string> = [
    "# The full test: the owner's sheet (fallback rendering)",
    "",
    "sheet.json is the canonical sheet; this file shows every reveal in raw Markdown, so it is not the owner's instrument.",
    "",
    file.cut.length === 0
      ? "No unit was cut by the bounds."
      : `${file.cut.length} unit(s) beyond the bounds: ${file.cut.map((entry) => `${entry.unitId} (${entry.bucket})`).join(", ")}.`,
    "",
    `Margin cards are drawn from the ${file.marginPool.judged} of ${file.marginPool.candidates} candidate references whose lines the gold has judged; the ${file.marginPool.unjudged} unjudged ones are left out, since a card measures the reference against the gold's grade for its lines and cannot without one.`,
    "",
  ];
  for (const item of file.items) {
    if (item.kind === "unit" || item.kind === "phase-a-unit") {
      md.push(
        `## ${item.id}: ${item.question.title}${item.block === "phase-a" ? " (phase A block, reported apart)" : ""}`,
        "",
        `Range ${item.caseId}; unit ${item.unitId}; drawn because: ${item.buckets.join(", ") || "A and A′ disagree"}.`,
        "",
        `Owned lines: ${item.question.ownedLines.join("; ")}`,
        "",
        `Facts: ${item.question.facts ?? "(none)"}`,
        "",
        `Neutral briefing: ${item.briefing.text ?? "(not written yet)"}`,
        "",
        ...decisionLines("First answer", item.answer.first),
        "<details><summary>Reveal</summary>",
        "",
        `Lane ${item.reveal.lane ?? "not assessed"}, quadrant ${item.reveal.quadrant ?? "n/a"}; gaps: ${item.reveal.gaps.join(", ") || "none"}. Verdict: ${item.reveal.verdict ?? "none"}.`,
        "",
        `Rationale: ${item.reveal.rationale ?? "(none)"}`,
        "",
        ...item.reveal.findings.flatMap((f, index) => [
          `${index + 1}. ${f.kind}${f.about === null ? "" : ` about ${f.about}`}${f.signal === null ? "" : ` (${f.signal})`}${f.anchor === null ? "" : ` at ${f.anchor}`}: ${f.body.replace(/\s+/g, " ").slice(0, 600)}`,
          "   - Judged: [ ] valid  [ ] invalid  [ ] unsure",
        ]),
        "",
        "</details>",
        "",
        ...decisionLines("Final answer", item.answer.final),
      );
      continue;
    }
    if (item.kind === "timed-out-run") {
      md.push(
        `## ${item.id}: timed-out run, ${item.caseId}`,
        "",
        `Published: ${item.question.published}.`,
        "",
        "Disclosed:",
        ...item.question.disclosed.map((line) => `- ${line}`),
        "",
        choiceLine(item.answer.judged),
        "- Note:",
        "",
      );
      continue;
    }
    if (item.kind === "margin-card") {
      md.push(
        `## ${item.id}: ${item.question.region}`,
        "",
        `Range ${item.caseId}; judged against M4 hunk ${item.hunkId}, ${item.question.hunk}.`,
        "",
        `Cited by the unit "${item.question.citingUnit.title}". Facts: ${item.question.citingUnit.facts ?? "(none)"}`,
        "",
        `Neutral briefing: ${item.briefing.text ?? "(not written yet)"}`,
        "",
        choiceLine(item.answer.first),
        "",
        `<details><summary>Reveal the harness's reference and the gold's grade</summary>\n\nThe harness graded it ${item.reveal.harness.grade ?? "(no grade given)"}${item.reveal.harness.handle === null ? "" : ` (${item.reveal.harness.handle})`}: ${item.reveal.harness.summary}\n\nThe gold's grade: ${item.reveal.goldGrade}\n\n</details>`,
        "",
      );
      continue;
    }
    md.push(
      `## ${item.id}: ${item.question.title}`,
      "",
      ...(item.question.digest === null ? [] : [item.question.digest, ""]),
      ...(item.question.facts === null
        ? []
        : [`Facts: ${item.question.facts}`, ""]),
      ...(item.question.briefed === null
        ? []
        : [`Briefed: ${item.question.briefed}`, ""]),
      ...(item.question.explained === null
        ? []
        : [`Explained: ${item.question.explained}`, ""]),
      choiceLine(item.answer.accurate),
      choiceLine(item.answer.complete),
      choiceLine(item.answer.misleadingClaim),
      choiceLine(item.answer.neutralBeforeVerdict),
      "- Note:",
      "",
    );
  }
  return `${md.join("\n")}\n`;
};

/**
 * A published reference summary as the harness writes it, `<local handle> (<grade>): <text>`, split
 * so its grade is shown only in the reveal; any other form keeps the whole text with no grade.
 */
export const parseReferenceSummary = (summary: string) => {
  const match = /^(\S+) \(([a-z][a-z -]*)\):\s+([\s\S]*)$/.exec(summary);
  return match === null
    ? { handle: null, grade: null, summary }
    : { handle: match[1]!, grade: match[2]!, summary: match[3]! };
};

export interface MarginCard {
  readonly caseId: string;
  readonly unitId: string;
  /** The Records reference; one reference can be listed under several units of a range. */
  readonly referenceId: string;
  /** The citing unit's title and Facts, unmasked; the card masks them. */
  readonly unitTitle: string;
  readonly unitFacts: string | null;
  readonly summary: string;
  readonly region: {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  };
  readonly goldGrade: string;
  readonly hunkId: string;
  readonly hunk: {
    readonly path: string;
    readonly old: { readonly start: number; readonly lines: number };
    readonly new: { readonly start: number; readonly lines: number };
  };
}

/**
 * FT13's 20 margin cards: only references whose lines the gold has judged (filtered before the
 * seeded order, so the draw stays fixed by rule), in SHA-256 order of the seed and the card's key.
 */
export const drawMarginCards = (
  candidates: ReadonlyArray<
    Omit<MarginCard, "goldGrade"> & { readonly goldGrade: string | null }
  >,
) => {
  const judged = candidates.flatMap((card) =>
    card.goldGrade === null ? [] : [{ ...card, goldGrade: card.goldGrade }],
  );
  return {
    cards: byHash(judged, marginCardKey).slice(0, MARGIN_CARDS),
    pool: {
      candidates: candidates.length,
      judged: judged.length,
      unjudged: candidates.length - judged.length,
    },
  };
};

/** What a card is about, for its sampling order and its ID: the range, the unit and the reference. */
export const marginCardKey = (
  card: Pick<MarginCard, "caseId" | "unitId" | "referenceId">,
) => `${card.caseId}:${card.unitId}:${card.referenceId}`;

const span = (start: number, lines: number) =>
  lines === 0 ? "none" : `${start}-${start + lines - 1}`;

export const marginSheetItem = (card: MarginCard): SheetItem => ({
  id: stableId("M", marginCardKey(card)),
  kind: "margin-card",
  caseId: card.caseId,
  unitId: card.unitId,
  hunkId: card.hunkId,
  question: {
    region: `${card.region.path} ${card.region.startLine}-${card.region.endLine}`,
    hunk: `${card.hunk.path} old lines ${span(card.hunk.old.start, card.hunk.old.lines)}, new lines ${span(card.hunk.new.start, card.hunk.new.lines)}`,
    citingUnit: {
      title: maskLaneWords(card.unitTitle),
      facts: card.unitFacts === null ? null : maskLaneWords(card.unitFacts),
    },
  },
  briefing: emptyBriefing(),
  reveal: {
    harness: parseReferenceSummary(card.summary),
    goldGrade: card.goldGrade,
  },
  answer: {
    first: {
      label: "These lines are",
      options: ["necessary", "useful", "irrelevant", "misleading"],
      value: null,
    },
    note: null,
  },
});

export const buildSheet = async (
  options: { readonly gold?: string | undefined } = {},
) => {
  const selection = readFullTestSelection();
  const { views } = await loadViews(options.gold ?? DEFAULT_GOLD);
  const unitsOf = (phase: "A" | "A2" | "C") =>
    selection.selected.flatMap((range) => {
      const run = readStored<StoredRun>(range.caseId, phase);
      return packetUnits(run?.packet ?? null).map(({ batchId, unit }) => ({
        caseId: range.caseId,
        batchId,
        unit,
      }));
    });
  const c = unitsOf("C");
  const { chosen, cut } = sampleSheet(c);
  // One item per C run that timed out in generation 0: what it published and what it disclosed.
  const timedOut = selection.selected.flatMap((range) => {
    const gen0 = isStored(range.caseId, "C")
      ? readStored<StoredRun>(range.caseId, "C", ".gen0")
      : undefined;
    return gen0 === undefined ? [] : [{ caseId: range.caseId, run: gen0 }];
  });
  // Phase A's block: units of A whose hunks A′ assessed or disposed differently.
  const disagreements = selection.selected.flatMap((range) => {
    const a = readStored<StoredRun>(range.caseId, "A");
    const a2 = readStored<StoredRun>(range.caseId, "A2");
    if (a === undefined || a2 === undefined) return [];
    const other = new Map(hunkViews(a2).map((view) => [view.hunkId, view]));
    const units = new Set(
      hunkViews(a).flatMap((view) => {
        const twin = other.get(view.hunkId);
        return twin !== undefined &&
          view.unitId !== null &&
          view.assessed &&
          twin.assessed &&
          (view.lane !== twin.lane ||
            (view.verdict !== null &&
              twin.verdict !== null &&
              view.verdict !== twin.verdict))
          ? [view.unitId]
          : [];
      }),
    );
    return packetUnits(a.packet)
      .filter(({ unit }) => units.has(unit.unitId))
      .map(({ batchId, unit }) => ({ caseId: range.caseId, batchId, unit }));
  });
  const phaseA = byHash(disagreements, (entry) => entry.unit.unitId).slice(
    0,
    PHASE_A_BLOCK,
  );
  // Margin cards: C's references on scored hunks, against the gold's grade for the referenced lines.
  const gold = views.get("all");
  const inputs = await loadScoringInputs();
  const m4Hunks = new Map(
    inputs.cases.flatMap((entry) =>
      entry.hunks.map((hunk) => [hunk.id, hunk] as const),
    ),
  );
  const candidates = selection.selected.flatMap((range) => {
    const run = readStored<StoredRun>(range.caseId, "C");
    if (run?.manifest == null) return [];
    return packetUnits(run.packet).flatMap(({ unit }) =>
      unit.references.flatMap((reference) => {
        const item = referenceItem(reference, run.manifest!.hunks, [
          range.base,
        ]);
        // The gold of the scored hunk the reference is anchored in, never another hunk's.
        const anchored = run.manifest!.hunks.find((hunk) =>
          anchoredIn(reference.payload.anchor, hunk),
        );
        const scoredId =
          anchored === undefined
            ? undefined
            : range.scoredHunks.find((id) => {
                const m4 = m4Hunks.get(id);
                return (
                  m4 !== undefined &&
                  harnessIdOf(m4, run.manifest!.hunks) === anchored.hunkId
                );
              });
        const hunkGold: HunkGold | undefined =
          scoredId === undefined ? undefined : gold?.get(scoredId);
        return item === null || hunkGold === undefined
          ? []
          : [
              {
                caseId: range.caseId,
                unitId: unit.unitId,
                referenceId: reference.id,
                unitTitle: unit.recorded?.payload.title ?? unit.unitId,
                unitFacts: unit.content.facts?.text ?? null,
                summary: reference.payload.summary,
                region: item,
                goldGrade: judgedGrade(hunkGold, item)?.grade ?? null,
                hunkId: hunkGold.hunkId,
                hunk: m4Hunks.get(hunkGold.hunkId)!,
              },
            ];
      }),
    );
  });
  const { cards, pool: marginPool } = drawMarginCards(candidates);
  const batchDigests = byHash(
    selection.selected.flatMap((range) =>
      packetBatches(readStored<StoredRun>(range.caseId, "C")?.packet, {
        where: `case ${range.caseId} (phase C)`,
      }).map((batch) => ({ caseId: range.caseId, batch })),
    ),
    (entry) => entry.batch.batchId,
  ).slice(0, BATCH_DIGESTS);
  const unitDigests = byHash(
    c.filter((entry) => entry.unit.content.facts !== undefined),
    (entry) => `digest:${entry.unit.unitId}`,
  ).slice(0, UNIT_DIGESTS);

  const items: Array<SheetItem> = [];
  chosen.forEach((entry) =>
    items.push(
      unitSheetItem(
        stableId("C", entry.unit.unitId),
        "h9",
        entry,
        entry.buckets,
      ),
    ),
  );
  timedOut.forEach((entry) =>
    items.push({
      id: stableId("T", entry.caseId),
      kind: "timed-out-run",
      caseId: entry.caseId,
      question: {
        published:
          entry.run.packet === null
            ? "nothing"
            : `${entry.run.packet.complete ? "a complete" : "an incomplete"} packet, ${JSON.stringify(entry.run.packet.counts ?? {})}`,
        disclosed: (entry.run.packet?.gaps ?? []).map(
          (gap) => `${gap.payload.kind}: ${gap.payload.detail}`,
        ),
      },
      briefing: emptyBriefing(),
      reveal: null,
      answer: {
        judged: {
          label: "What it published and disclosed is",
          options: [
            "accurate and enough",
            "accurate, not enough",
            "misleading",
          ],
          value: null,
        },
        note: null,
      },
    }),
  );
  phaseA.forEach((entry) =>
    items.push(
      unitSheetItem(stableId("A", entry.unit.unitId), "phase-a", entry, []),
    ),
  );
  cards.forEach((card) => items.push(marginSheetItem(card)));
  batchDigests.forEach((entry) =>
    items.push({
      id: stableId("D", entry.batch.batchId),
      kind: "batch-digest",
      caseId: entry.caseId,
      unitId: null,
      question: {
        title: `batch digest, ${entry.caseId}`,
        digest: entry.batch.digest?.digest ?? null,
        facts: null,
        briefed: null,
        explained: null,
      },
      briefing: emptyBriefing(),
      reveal: null,
      answer: rubric(),
    }),
  );
  unitDigests.forEach((entry) =>
    items.push({
      id: stableId("U", entry.unit.unitId),
      kind: "unit-digest",
      caseId: entry.caseId,
      unitId: entry.unit.unitId,
      question: {
        title: entry.unit.recorded?.payload.title ?? entry.unit.unitId,
        digest: null,
        facts: entry.unit.content.facts?.text ?? null,
        briefed: entry.unit.content.briefed?.text ?? null,
        explained:
          entry.unit.content.explained === undefined ||
          entry.unit.content.explained === null
            ? null
            : JSON.stringify(entry.unit.content.explained),
      },
      briefing: emptyBriefing(),
      reveal: null,
      answer: rubric(),
    }),
  );
  return SheetFile.parse({
    schemaVersion: 1,
    seed: SHEET_SEED,
    builtAt: new Date().toISOString(),
    cut,
    marginPool,
    items,
  });
};

/**
 * A rebuilt sheet keeps each briefing whose item has the same ID, kind and question, so rebuilding
 * never discards briefings; a changed question is briefed again.
 */
export const carryBriefings = (
  previous: ReadonlyArray<SheetItem> | undefined,
  next: SheetFile,
): SheetFile => {
  if (previous === undefined) return next;
  const kept = new Map(
    previous
      .filter((item) => item.briefing.text !== null)
      .map((item) => [
        `${item.id}|${item.kind}|${JSON.stringify(item.question)}`,
        item.briefing,
      ]),
  );
  return {
    ...next,
    items: next.items.map((item) => {
      const briefing = kept.get(
        `${item.id}|${item.kind}|${JSON.stringify(item.question)}`,
      );
      return item.briefing.text === null && briefing !== undefined
        ? { ...item, briefing }
        : item;
    }),
  };
};

/**
 * The previous sheet's items that still match the current schema, one by one, so a schema change to
 * one kind of item (whose questions changed anyway) does not stop the others' briefings carrying.
 */
const readPreviousItems = (path: string) => {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
  return (Array.isArray(raw.items) ? raw.items : []).flatMap((item) => {
    const parsed = SheetItem.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
};

export const writeSheet = async (
  options: { readonly gold?: string | undefined } = {},
) => {
  ensureDir(FULL_TEST_RESULTS);
  const path = join(FULL_TEST_RESULTS, "sheet.json");
  const sheet = carryBriefings(
    existsSync(path) ? readPreviousItems(path) : undefined,
    await buildSheet(options),
  );
  writeFileSync(
    join(FULL_TEST_RESULTS, "sheet.json"),
    `${JSON.stringify(sheet, null, 2)}\n`,
  );
  writeFileSync(
    join(FULL_TEST_RESULTS, "sheet.schema.json"),
    `${JSON.stringify(z.toJSONSchema(SheetFile), null, 2)}\n`,
  );
  writeFileSync(join(FULL_TEST_RESULTS, "sheet.md"), sheetMarkdown(sheet));
  return sheet;
};
