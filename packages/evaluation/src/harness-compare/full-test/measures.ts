import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgedGrade } from "../../retrieval-bench/score/coverage.ts";
import {
  evaluateBudget,
  familyMean,
} from "../../retrieval-bench/score/metrics.ts";
import type { HunkGold } from "../../retrieval-bench/score/types.ts";
import {
  loadScoringInputs,
  type DevHunk,
} from "../../retrieval-bench/scoring-inputs.ts";
import {
  spanKey,
  type Item,
  type Ranking,
} from "../../retrieval-bench/ranking.ts";
import { ensureDir } from "../common.ts";
import { matchHunks } from "../harness-side.ts";
import {
  placeEntry,
  rankingFor,
  type LedgerEntryLite,
  type LedgerLite,
} from "../ledgers.ts";
import { DEFAULT_GOLD, loadViews, round } from "../score.ts";
import { shownLeads } from "../shown-leads.ts";
import {
  FULL_TEST_RESULTS,
  LEADS_ARMS,
  type LeadsArm,
  type PhaseId,
} from "./config.ts";
import { readKnownCases, readProofRanges } from "./known-cases.ts";
import { laterFixFindings } from "./later-fixes.ts";
import {
  leadDifferences,
  readLeads,
  servedTop3Differ,
  type LeadsRow,
} from "./leads-file.ts";
import {
  approvalCatch,
  caughtDefect,
  changedLines,
  digestChecks,
  dispositionChecks,
  hunkViews,
  laneChecks,
  ownedLineKeys,
  packetUnits,
  proofCoverage,
  referencesCover,
  verdictOf,
  type ManifestHunkFull,
  type StoredRun,
} from "./packets.ts";
import {
  isStored,
  latestRuns,
  readFullTestSpend,
  readStored,
  runsDir,
} from "./phases.ts";
import { readFullTestSelection, type SelectedRange } from "./select.ts";
import {
  adjustedRandIndex,
  agreement,
  matchGroups,
  matchObligations,
  deltaSummary,
  separability,
  type PairedValue,
  type Rated,
} from "./stats.ts";

/** A hunk's served leads as a stored run holds them: regions and their token counts. */
interface ServedLeads {
  readonly results: ReadonlyArray<{
    readonly identity: {
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    };
    readonly retrieval: { readonly tokens: number };
  }>;
}

/**
 * Every automatic measure of the full test (FT9–FT12, FT5's statistic), computed from what the runs
 * stored and the M4 scorer, at no model cost, and written to `measurements.json`; the hills report
 * (hills.ts) and the owner's sheet (sheet.ts) read it. Nothing here calls a model and no run agent
 * sees any of it (2.16).
 *
 * Gold is M4's dev gold through the harness comparison's `loadViews` (view `all`, and `cross-family`
 * by `keepCrossFamily`, the M4 scorer's one rule); coverage is B4's `evaluateBudget` at depth (all
 * of what was kept), with both overlap rules. A scored hunk is one of the selection's M4 hunks after
 * 9.47's exclusions, mapped to its harness hunk by the 9.57 runner's header-then-overlap rule.
 */

/** Where the runs depart from the proposal as ruled, disclosed in the plan and the hills report. */
export const DEVIATIONS: ReadonlyArray<string> = [
  "No token cap (10.89): runs stop only on the plan's usage limit and the proposal's other stop rules; every run's tokens are recorded.",
  "B carries no stub hold before Assemble (FT4 as amended by the coordinator, 21 October 2026): a stub setting is part of every stage's computation key, so a held B would share neither A's Understand nor, on continuation, its own Investigate. B runs as A does and the watcher stops it once every Investigate partition is done; Assemble and Dispose work a batch started before then is lost, and its tokens are counted (receipts.byPhase.B.lostAfterInvestigate).",
  "Ranges outside the 22 (the probe, the known cases, the proof ranges) run on the harness's BM25 leads, disclosed per run, until the labelling side adds their rows.",
  "Frozen leads reach the harness through the frozen-candidate seam (search.leads.frozen) by default. The BM25-key workaround (each hunk's leads stored as its leads computation under the BM25 key, every result naming its real retriever, each phase in its own store) remains as a disclosed fallback only; spend.json invocations and each run's measurement record which path a run took (`leadsVia`).",
];

export const METRICS = [
  "necessary",
  "relevant",
  "necessaryAny",
  "relevantAny",
] as const;
export type Metric = (typeof METRICS)[number];
export const SCORED_VIEWS = ["all", "cross-family"] as const;
export type ScoredView = (typeof SCORED_VIEWS)[number];
type Coverage = Record<Metric, number | null>;

const DEPTH = Number.MAX_SAFE_INTEGER;

export const coverage = (
  gold: HunkGold,
  items: ReadonlyArray<Item>,
  budget = DEPTH,
): Coverage => {
  const m = evaluateBudget(gold, { items: [...items], scores: [] }, budget);
  return {
    necessary: m.necessary.fractional,
    relevant: m.relevant.fractional,
    necessaryAny: m.necessary.anyLine,
    relevantAny: m.relevant.anyLine,
  };
};

const regionItems = (row: LeadsRow, k: number): Array<Item> =>
  row.regions
    .slice(0, k)
    .map(([path, startLine, endLine, chunkId, kind, tokens]) => ({
      key: spanKey(path, startLine, endLine),
      path,
      startLine,
      endLine,
      kind,
      tokens,
      chunkId,
      hash: null,
    }));

/** Judged-only precision (9.49): the share of judged retrieval-target tokens graded necessary or useful. */
export const judgedPrecision = (gold: HunkGold, items: ReadonlyArray<Item>) => {
  let judged = 0;
  let relevant = 0;
  let unjudged = 0;
  let tokens = 0;
  for (const item of items) {
    tokens += item.tokens;
    const label = judgedGrade(gold, item);
    if (label === undefined) unjudged += item.tokens;
    else if (label.target) {
      judged += item.tokens;
      if (label.grade === "necessary" || label.grade === "useful")
        relevant += item.tokens;
    }
  }
  return { tokens, judged, relevant, unjudged };
};

/**
 * A published context reference as a scorer item on the base revision: its git provenance, read at
 * base when its revision is the range's base, else carried through the diff as a head read
 * (ledgers.ts `placeEntry`). Null when it has no repository lines or they are lost (an added file).
 */
export const referenceItem = (
  reference: { readonly payload: { readonly provenance: unknown } },
  manifest: ReadonlyArray<ManifestHunkFull>,
  baseRevisions: ReadonlyArray<string>,
): Item | null => {
  const p = reference.payload.provenance as {
    kind: string;
    revision?: string;
    path?: string;
    startLine?: number;
    endLine?: number;
  };
  if (p.kind !== "git" || p.path === undefined || p.startLine === undefined)
    return null;
  const rev =
    p.revision !== undefined && baseRevisions.includes(p.revision)
      ? "base"
      : "head";
  const placed = placeEntry(
    {
      id: "r1",
      anchors: [],
      source: {
        origin: "repository",
        rev,
        path: p.path,
        startLine: p.startLine,
        endLine: p.endLine ?? p.startLine,
      },
      retrieval: { rank: null, retriever: null },
      lineage: { lookup: "reference" },
      grade: "useful",
      tokens: 0,
      ungraded: false,
    },
    manifest,
  ).region;
  return placed === undefined
    ? null
    : {
        key: spanKey(placed.path, placed.startLine, placed.endLine),
        path: placed.path,
        startLine: placed.startLine,
        endLine: placed.endLine,
        kind: "code",
        tokens: placed.endLine - placed.startLine + 1,
        chunkId: null,
        hash: null,
      };
};

/**
 * A phase's served top 3 per harness hunk, as harness chunks (harness-side.ts `servedChunkIds`,
 * written by the runner while the run's clone and its index were there), or undefined when the
 * phase has no such file for the range.
 */
export const readServed = (caseId: string, phase: PhaseId) => {
  const path = join(runsDir(caseId), `served-${phase}.json`);
  return existsSync(path)
    ? new Map(
        Object.entries(
          JSON.parse(readFileSync(path, "utf8")) as Record<
            string,
            ReadonlyArray<string> | null
          >,
        ),
      )
    : undefined;
};

// Inputs

interface ScoredHunk {
  readonly hunk: DevHunk;
  readonly range: SelectedRange;
  readonly m4: {
    path: string;
    oldPath: string;
    old: { start: number; lines: number };
    new: { start: number; lines: number };
  };
}

const PHASES_WITH_LEDGERS: ReadonlyArray<PhaseId> = ["A", "A2", "C", "B"];
const PACKET_PHASES: ReadonlyArray<PhaseId> = ["A", "A2", "C"];

/** An M4 hunk's harness hunk in a run's manifest, by the 9.57 runner's header-then-overlap rule. */
export const harnessIdOf = (
  m4: {
    readonly id: string;
    readonly path: string;
    readonly oldPath: string;
    readonly old: { readonly start: number; readonly lines: number };
    readonly new: { readonly start: number; readonly lines: number };
  },
  manifest: ReadonlyArray<ManifestHunkFull>,
) =>
  matchHunks(
    [
      {
        hunkId: m4.id,
        path: m4.path,
        oldPath: m4.oldPath,
        old: m4.old,
        new: m4.new,
        queryText: "",
        regions: [],
      },
    ],
    manifest.map((hunk) => ({
      ...hunk,
      kind: hunk.kind === "text" ? ("text" as const) : ("metadata" as const),
      text: "",
    })),
  )[0]?.harnessHunkId ?? null;

const harnessIdFor = (
  scored: ScoredHunk,
  manifest: ReadonlyArray<ManifestHunkFull>,
) => harnessIdOf({ ...scored.m4, id: scored.hunk.hunkId }, manifest);

/** Whether an anchor (lines on one side) falls in a harness hunk's changed lines. */
export const anchoredIn = (
  anchor: {
    readonly path: string;
    readonly side: "old" | "new";
    readonly startLine: number;
    readonly endLine: number;
  },
  hunk: ManifestHunkFull | undefined,
) =>
  hunk !== undefined &&
  anchor.path === (anchor.side === "new" ? hunk.newPath : hunk.oldPath) &&
  (anchor.side === "new"
    ? anchor.startLine <= hunk.newStart + Math.max(hunk.newLines, 1) - 1 &&
      hunk.newStart <= anchor.endLine
    : anchor.startLine <= hunk.oldStart + Math.max(hunk.oldLines, 1) - 1 &&
      hunk.oldStart <= anchor.endLine);

type Run = Omit<StoredRun, "ledgers"> & {
  readonly ledgers?: ReadonlyArray<LedgerLite>;
};
/** Investigate's look-alikes: entries kept for measurement, never shown as context. */
type LedgerWithLookAlikes = LedgerLite & {
  readonly lookAlikes?: ReadonlyArray<Omit<LedgerEntryLite, "grade">>;
};

/** A phase's stored run for a range: B's continuation when it ran, for every stage after Investigate. */
const runOf = (
  caseId: string,
  phase: PhaseId,
  after = false,
): Run | undefined =>
  (after && phase === "B"
    ? readStored<Run>(caseId, "B", ".continued")
    : undefined) ?? readStored<Run>(caseId, phase);

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;

// The measures

export const measureAll = async (
  options: { readonly gold?: string | undefined } = {},
) => {
  const { views, check } = await loadViews(options.gold ?? DEFAULT_GOLD);
  const selection = readFullTestSelection();
  const inputs = await loadScoringInputs();
  const caseHunks = new Map(
    inputs.cases.flatMap((entry) =>
      entry.hunks.map((hunk) => [hunk.id, hunk] as const),
    ),
  );
  const scored: Array<ScoredHunk> = selection.selected.flatMap((range) =>
    range.scoredHunks.flatMap((hunkId) => {
      const hunk = inputs.hunks.find((entry) => entry.hunkId === hunkId);
      const m4 = caseHunks.get(hunkId);
      return hunk === undefined || m4 === undefined
        ? []
        : [{ hunk, range, m4 }];
    }),
  );
  const named = new Set(
    selection.selected
      .filter((range) => range.named)
      .map((range) => range.caseId),
  );
  const leads = Object.fromEntries(
    LEADS_ARMS.map((arm) => [arm, readLeads(arm)]),
  ) as Record<LeadsArm, Map<string, Array<LeadsRow>> | undefined>;

  // Retrieval: the served leads at depth, the seeded top 3, and M4's own figures at the real shares.
  const retrieval = LEADS_ARMS.map((arm) => {
    const byCase = leads[arm];
    if (byCase === undefined) return { arm, present: false as const };
    const rows: Array<
      {
        hunkId: string;
        caseId: string;
        family: string;
        view: ScoredView;
        depth: string;
      } & Coverage
    > = [];
    for (const s of scored) {
      const row = (byCase.get(s.range.caseId) ?? []).find(
        (candidate) =>
          candidate.path === s.m4.path &&
          candidate.old.start === s.m4.old.start &&
          candidate.old.lines === s.m4.old.lines &&
          candidate.new.start === s.m4.new.start &&
          candidate.new.lines === s.m4.new.lines,
      );
      if (row === undefined) continue;
      for (const view of SCORED_VIEWS) {
        const gold = views.get(view)?.get(s.hunk.hunkId);
        if (gold === undefined) continue;
        const add = (
          depth: string,
          items: ReadonlyArray<Item>,
          budget = DEPTH,
        ) =>
          rows.push({
            hunkId: s.hunk.hunkId,
            caseId: s.range.caseId,
            family: s.hunk.family,
            view,
            depth,
            ...coverage(gold, items, budget),
          });
        add("top3", regionItems(row, 3));
        add("top10", regionItems(row, 10));
        add("opus-share", regionItems(row, 50), s.hunk.realShare.opus);
        add("sol-share", regionItems(row, 50), s.hunk.realShare.sol);
      }
    }
    return {
      arm,
      present: true as const,
      summary: summariseRows(rows, ["depth", "view"]),
      rows,
    };
  });
  const leadDiff =
    leads["R(H3-E0)"] !== undefined && leads["R(H1-E0)"] !== undefined
      ? (({ perHunk: _perHunk, ...rest }) => rest)(
          leadDifferences(leads["R(H3-E0)"], leads["R(H1-E0)"]),
        )
      : null;

  // Investigate's ledger and the context margin, per phase and scored hunk.
  type LedgerRow = {
    hunkId: string;
    caseId: string;
    family: string;
    phase: PhaseId;
    view: ScoredView;
    source: string;
  } & Coverage;
  const ledgerRows: Array<LedgerRow> = [];
  const attributionRows: Array<{
    hunkId: string;
    caseId: string;
    family: string;
    phase: PhaseId;
    view: ScoredView;
    source: string;
    judged: number;
    misleadingShare: number | null;
    irrelevantShare: number | null;
  }> = [];
  const lookAlikes: Record<
    string,
    {
      lookAlikes: Record<string, number>;
      misleadingDrops: Record<string, number>;
      keptMisleading: number;
      goldMisleadingTargets: number;
    }
  > = {};
  const kept = new Map<string, Array<Item>>();
  const ledgerCounts: Record<string, Record<string, number>> = {};
  const missingRuns: Array<string> = [];
  for (const phase of PHASES_WITH_LEDGERS) {
    const counts = (ledgerCounts[phase] = {
      entries: 0,
      fromLeads: 0,
      seeded: 0,
      dropped: 0,
      droppedSeeded: 0,
      ungraded: 0,
      references: 0,
      referencesOnChangedLines: 0,
    });
    for (const range of selection.selected) {
      const runPhase = runOf(range.caseId, phase);
      if (runPhase?.manifest === null || runPhase?.manifest === undefined) {
        missingRuns.push(`${phase} ${range.caseId}`);
        continue;
      }
      const manifest = runPhase.manifest.hunks;
      // A newer run's leads are their own computation beside the manifest; an older run's are inline.
      const leadsOf = shownLeads<ServedLeads>(
        runPhase as unknown as Parameters<typeof shownLeads<ServedLeads>>[0],
      );
      for (const ledger of runPhase.ledgers ?? []) {
        counts.entries! += ledger.entries.length;
        counts.dropped! += (ledger.dropped ?? []).length;
        counts.droppedSeeded! += (ledger.dropped ?? []).filter(
          (d) => d.seeded === true,
        ).length;
      }
      const published = runOf(range.caseId, phase, true);
      // B publishes only when its pre-registered rule sent it on (its continuation's packet).
      const hasPacket =
        phase !== "B" ||
        existsSync(join(runsDir(range.caseId), "B.continued.json.gz"));
      const pristinePath = join(runsDir(range.caseId), "pristine.json");
      const baseOid = existsSync(pristinePath)
        ? (
            JSON.parse(readFileSync(pristinePath, "utf8")) as {
              baseOid: string;
            }
          ).baseOid
        : range.base;
      if (hasPacket)
        for (const { unit } of packetUnits(published?.packet ?? null))
          for (const reference of unit.references) {
            counts.references!++;
            const anchor = reference.payload.anchor;
            const onChanged = manifest.some((hunk) => {
              const lines = changedLines(hunk);
              return (
                lines !== null &&
                lines.path === anchor.path &&
                lines.side === anchor.side &&
                lines.startLine <= anchor.endLine &&
                anchor.startLine <= lines.endLine
              );
            });
            if (onChanged) counts.referencesOnChangedLines!++;
          }
      for (const s of scored.filter(
        (entry) => entry.range.caseId === range.caseId,
      )) {
        const harnessId = harnessIdFor(s, manifest);
        const mapped =
          harnessId === null
            ? null
            : rankingFor(harnessId, runPhase.ledgers ?? [], manifest);
        counts.fromLeads! += mapped?.fromLeads ?? 0;
        counts.seeded! += mapped?.seeded ?? 0;
        counts.ungraded! += mapped?.ungraded ?? 0;
        const ledgerItems = [...(mapped?.ranking.items ?? [])];
        const owning = (runPhase.ledgers ?? []).filter(
          (ledger) =>
            harnessId !== null && ledger.partition.hunkIds.includes(harnessId),
        );
        const asItem = (
          region:
            { path: string; startLine: number; endLine: number } | undefined,
        ): Array<Item> =>
          region === undefined
            ? []
            : [
                {
                  key: spanKey(region.path, region.startLine, region.endLine),
                  path: region.path,
                  startLine: region.startLine,
                  endLine: region.endLine,
                  kind: "code" as const,
                  tokens: 0,
                  chunkId: null,
                  hash: null,
                },
              ];
        const lookAlikeItems = owning.flatMap((ledger) =>
          ((ledger as LedgerWithLookAlikes).lookAlikes ?? [])
            .filter((entry) =>
              entry.anchors.some((anchor) => anchor.hunk === harnessId),
            )
            .flatMap((entry) =>
              asItem(
                placeEntry({ ...entry, grade: "useful" }, manifest).region,
              ),
            ),
        );
        // A misleading drop names its region as `path:first-last@rev`; it counts for the scored
        // hunks of its partition, since a dropped entry keeps no anchors.
        const misleadingDropItems = owning.flatMap((ledger) =>
          (ledger.dropped ?? [])
            .filter((drop) => drop.reason === "misleading")
            .flatMap((drop) => {
              const m = /^(.*):(\d+)-(\d+)@(\S+)$/.exec(drop.region ?? "");
              if (m === null) return [];
              return asItem(
                placeEntry(
                  {
                    id: "d1",
                    anchors: [],
                    source: {
                      origin: "repository",
                      rev: m[4] === "head" ? "head" : "base",
                      path: m[1]!,
                      startLine: Number(m[2]),
                      endLine: Number(m[3]),
                    },
                    retrieval: { rank: null, retriever: null },
                    lineage: { lookup: "drop" },
                    grade: "useful",
                    tokens: 0,
                    ungraded: false,
                  },
                  manifest,
                ).region,
              );
            }),
        );
        kept.set(`${phase}\u0000${s.hunk.hunkId}`, ledgerItems);
        const leadItems: Array<Item> = (
          (harnessId === null ? null : leadsOf(harnessId))?.results ?? []
        )
          .slice(0, 3)
          .map((result) => ({
            key: spanKey(
              result.identity.path,
              result.identity.startLine,
              result.identity.endLine,
            ),
            path: result.identity.path,
            startLine: result.identity.startLine,
            endLine: result.identity.endLine,
            kind: "code" as const,
            tokens: result.retrieval.tokens,
            chunkId: null,
            hash: null,
          }));
        // The published context references anchored in this hunk, placed on the base.
        const referenceItems: Array<Item> = [];
        if (hasPacket) {
          const hunk = manifest.find((entry) => entry.hunkId === harnessId);
          for (const { unit } of packetUnits(published?.packet ?? null))
            for (const reference of unit.references) {
              const anchor = reference.payload.anchor;
              const inHunk = anchoredIn(anchor, hunk);
              if (!inHunk) continue;
              const item = referenceItem(reference, manifest, [
                baseOid,
                range.base,
              ]);
              if (item !== null) referenceItems.push(item);
            }
        }
        for (const view of SCORED_VIEWS) {
          const gold = views.get(view)?.get(s.hunk.hunkId);
          if (gold === undefined) continue;
          const add = (source: string, items: ReadonlyArray<Item>) =>
            ledgerRows.push({
              hunkId: s.hunk.hunkId,
              caseId: range.caseId,
              family: s.hunk.family,
              phase,
              view,
              source,
              ...coverage(gold, items),
            });
          add("ledger", ledgerItems);
          add("ledger+top3", [...ledgerItems, ...leadItems]);
          if (hasPacket) add("references", referenceItems);
          // The misleading share by item (9.42's guard, 9.9): what was kept as context, and what
          // was published as references, that the gold grades misleading among judged targets.
          const share = (source: string, items: ReadonlyArray<Item>) => {
            const a = evaluateBudget(
              gold,
              { items: [...items], scores: [] },
              DEPTH,
            ).attribution;
            attributionRows.push({
              hunkId: s.hunk.hunkId,
              caseId: range.caseId,
              family: s.hunk.family,
              phase,
              view,
              source,
              judged: a.judged,
              misleadingShare: a.misleadingShare,
              irrelevantShare: a.irrelevantShare,
            });
          };
          share("ledger", ledgerItems);
          if (hasPacket) share("references", referenceItems);
          // Look-alikes and misleading drops (9.9, 10.49) against the gold's grade for their lines.
          if (view === "all") {
            const tally = (lookAlikes[phase] ??= {
              lookAlikes: {
                total: 0,
                misleading: 0,
                irrelevant: 0,
                relevant: 0,
                unjudged: 0,
              },
              misleadingDrops: {
                total: 0,
                misleading: 0,
                irrelevant: 0,
                relevant: 0,
                unjudged: 0,
              },
              keptMisleading: 0,
              goldMisleadingTargets: 0,
            });
            const grade = (item: Item, into: Record<string, number>) => {
              into["total"]!++;
              const label = judgedGrade(gold, item);
              if (label === undefined || !label.target) into["unjudged"]!++;
              else if (label.grade === "misleading") into["misleading"]!++;
              else if (label.grade === "irrelevant") into["irrelevant"]!++;
              else into["relevant"]!++;
            };
            for (const item of lookAlikeItems) grade(item, tally.lookAlikes);
            for (const item of misleadingDropItems)
              grade(item, tally.misleadingDrops);
            tally.keptMisleading += ledgerItems.filter(
              (item) => judgedGrade(gold, item)?.grade === "misleading",
            ).length;
            tally.goldMisleadingTargets += [...gold.judged.values()].filter(
              (label) => label.target && label.grade === "misleading",
            ).length;
          }
        }
      }
    }
  }
  const ledgerSummary = summariseRows(ledgerRows, ["phase", "source", "view"]);

  // FT5: A against A′ (the noise floor), against C and against B, per measure, view and source.
  const pairsFor = (
    x: PhaseId,
    view: ScoredView,
    metric: Metric,
    source: string,
    subset?: ReadonlySet<string>,
  ): Array<PairedValue> =>
    scored.flatMap((s) => {
      if (subset !== undefined && !subset.has(s.range.caseId)) return [];
      const get = (phase: PhaseId) =>
        ledgerRows.find(
          (row) =>
            row.phase === phase &&
            row.view === view &&
            row.source === source &&
            row.hunkId === s.hunk.hunkId,
        )?.[metric] ?? null;
      const a = get("A");
      const other = get(x);
      return a === null || other === null
        ? []
        : [
            {
              hunkId: s.hunk.hunkId,
              family: s.hunk.family,
              caseId: s.range.caseId,
              a,
              x: other,
            },
          ];
    });
  const separabilityOf = (subset?: ReadonlySet<string>) =>
    (["C", "B"] as const)
      .flatMap((x) =>
        ["ledger", "references"].flatMap((source) =>
          SCORED_VIEWS.flatMap((view) =>
            METRICS.map((metric) => {
              if (
                x === "B" &&
                source === "references" &&
                !scored.some((s) =>
                  existsSync(
                    join(runsDir(s.range.caseId), "B.continued.json.gz"),
                  ),
                )
              )
                return null;
              const all = pairsFor(x, view, metric, source, subset);
              const noise = pairsFor("A2", view, metric, source, subset);
              // FT14 rule 7: where A′ covers fewer hunks, every comparison against the floor uses
              // only the hunks A′ covers; the others' differences are reported without a floor.
              const covered = new Set(noise.map((pair) => pair.hunkId));
              const pairs =
                noise.length === 0
                  ? all
                  : all.filter((pair) => covered.has(pair.hunkId));
              const uncovered =
                noise.length === 0
                  ? []
                  : all.filter((pair) => !covered.has(pair.hunkId));
              const result = separability(pairs, noise);
              return {
                comparison: `A-${x}`,
                source,
                view,
                metric,
                hunks: pairs.length,
                noiseHunks: noise.length,
                withoutFloor:
                  uncovered.length === 0
                    ? null
                    : {
                        hunks: uncovered.length,
                        ...deltaSummary(uncovered),
                      },
                familyWeighted: result.familyWeighted,
                hunkMean: result.hunkMean,
                delta: {
                  familyWeighted: result.comparison.familyWeighted,
                  hunkMean: result.comparison.hunkMean,
                },
                noise:
                  result.noise === null
                    ? null
                    : {
                        familyWeighted: result.noise.familyWeighted,
                        hunkMean: result.noise.hunkMean,
                      },
                restsOn: result.restsOn,
                leaveOneFamilyOut: result.leaveOneFamilyOut,
              };
            }),
          ),
        ),
      )
      .filter((entry) => entry !== null);
  // The noise floor of each source on its own: the published references' against A′'s references.
  const noiseFloor = ["ledger", "references"].flatMap((source) =>
    SCORED_VIEWS.flatMap((view) =>
      METRICS.map((metric) => {
        const pairs = pairsFor("A2", view, metric, source);
        const result = separability(pairs, null);
        return {
          source,
          view,
          metric,
          hunks: pairs.length,
          delta: result.comparison,
        };
      }),
    ),
  );

  // Equal size and judged-only precision, A against each other phase, view by view.
  const equalSize = (["A2", "C", "B"] as const).flatMap((x) =>
    SCORED_VIEWS.flatMap((view) => {
      const rows: Array<
        {
          hunkId: string;
          caseId: string;
          family: string;
          arm: string;
        } & Coverage
      > = [];
      for (const s of scored) {
        const gold = views.get(view)?.get(s.hunk.hunkId);
        const a = kept.get(`A\u0000${s.hunk.hunkId}`);
        const b = kept.get(`${x}\u0000${s.hunk.hunkId}`);
        if (gold === undefined || a === undefined || b === undefined) continue;
        const budget = Math.min(
          a.reduce((t, i) => t + i.tokens, 0),
          b.reduce((t, i) => t + i.tokens, 0),
        );
        rows.push({
          hunkId: s.hunk.hunkId,
          caseId: s.range.caseId,
          family: s.hunk.family,
          arm: "A",
          ...coverage(gold, a, budget),
        });
        rows.push({
          hunkId: s.hunk.hunkId,
          caseId: s.range.caseId,
          family: s.hunk.family,
          arm: x,
          ...coverage(gold, b, budget),
        });
      }
      return [
        { comparison: `A-${x}`, view, summary: summariseRows(rows, ["arm"]) },
      ];
    }),
  );
  const precision = PHASES_WITH_LEDGERS.flatMap((phase) =>
    SCORED_VIEWS.map((view) => {
      let tokens = 0,
        judged = 0,
        relevant = 0,
        unjudged = 0;
      for (const s of scored) {
        const gold = views.get(view)?.get(s.hunk.hunkId);
        const items = kept.get(`${phase}\u0000${s.hunk.hunkId}`);
        if (gold === undefined || items === undefined) continue;
        const p = judgedPrecision(gold, items);
        tokens += p.tokens;
        judged += p.judged;
        relevant += p.relevant;
        unjudged += p.unjudged;
      }
      return {
        phase,
        view,
        tokens,
        judged,
        relevant,
        precision: judged === 0 ? null : round(relevant / judged),
        unjudgedShare: tokens === 0 ? null : round(unjudged / tokens),
      };
    }),
  );

  // Lanes and dispositions: hunk-level agreement with kappa, rule checks, unit-level matching.
  const familyOf = new Map(
    selection.selected.map((range) => [range.caseId, range.family]),
  );
  const agreementOf = (
    x: PhaseId,
    pick: (view: ReturnType<typeof hunkViews>[number]) => string | null,
    needs: "assessed" | "disposed",
    subset?: ReadonlySet<string>,
  ) => {
    const pairs: Array<Rated> = [];
    let unpaired = 0;
    for (const range of selection.selected) {
      if (subset !== undefined && !subset.has(range.caseId)) continue;
      const a = runOf(range.caseId, "A");
      const b = runOf(range.caseId, x, true);
      if (a === undefined || b === undefined) continue;
      const left = new Map(hunkViews(a).map((view) => [view.hunkId, view]));
      for (const right of hunkViews(b)) {
        const l = left.get(right.hunkId);
        const lv = l === undefined ? null : pick(l);
        const rv = pick(right);
        const ok =
          needs === "assessed"
            ? l?.assessed === true && right.assessed
            : lv !== null && rv !== null;
        if (!ok || lv === null || rv === null) {
          unpaired++;
          continue;
        }
        pairs.push({
          family: familyOf.get(range.caseId) ?? range.caseId,
          caseId: range.caseId,
          x: lv,
          y: rv,
        });
      }
    }
    return { ...agreement(pairs), unpaired };
  };
  const agreements = (subset?: ReadonlySet<string>) =>
    (["A2", "C", "B"] as const).map((x) => ({
      comparison: `A-${x}`,
      lane: agreementOf(x, (v) => v.lane, "assessed", subset),
      complexity: agreementOf(x, (v) => v.complexity, "assessed", subset),
      ease: agreementOf(x, (v) => v.ease, "assessed", subset),
      verdict: agreementOf(x, (v) => v.verdict, "disposed", subset),
    }));
  const unitMatching = (["A2", "C"] as const).map((x) => {
    let matched = 0,
      left = 0,
      right = 0,
      laneAgree = 0,
      verdictAgree = 0,
      verdictPairs = 0;
    for (const range of selection.selected) {
      const a = runOf(range.caseId, "A");
      const b = runOf(range.caseId, x);
      if (a === undefined || b === undefined) continue;
      const au = packetUnits(a.packet).map(({ unit }) => unit);
      const bu = packetUnits(b.packet).map(({ unit }) => unit);
      const m = matchGroups(
        au.map((u) => ({ id: u.unitId, members: ownedLineKeys(u) })),
        bu.map((u) => ({ id: u.unitId, members: ownedLineKeys(u) })),
      );
      matched += m.pairs.length;
      left += au.length;
      right += bu.length;
      for (const pair of m.pairs) {
        const ua = au.find((u) => u.unitId === pair.left)!;
        const ub = bu.find((u) => u.unitId === pair.right)!;
        if (ua.assessment?.payload.lane === ub.assessment?.payload.lane)
          laneAgree++;
        const va = verdictOf(ua);
        const vb = verdictOf(ub);
        if (va !== null && vb !== null) {
          verdictPairs++;
          if (va === vb) verdictAgree++;
        }
      }
    }
    return {
      comparison: `A-${x}`,
      matched,
      unitsA: left,
      unitsOther: right,
      laneAgreement: matched === 0 ? null : round(laneAgree / matched),
      verdictAgreement:
        verdictPairs === 0 ? null : round(verdictAgree / verdictPairs),
    };
  });
  const rulesPerRun = PACKET_PHASES.flatMap((phase) =>
    selection.selected.flatMap((range) => {
      const r = runOf(range.caseId, phase);
      if (r === undefined) return [];
      return [
        {
          phase,
          caseId: range.caseId,
          lanes: laneChecks(r),
          dispositions: dispositionChecks(r),
          digests: digestChecks(r),
          proof: proofCoverage(r),
        },
      ];
    }),
  );

  // Known cases in A and A′: caught when Dispose requested changes citing the defect's lines.
  const knownCases = readKnownCases().flatMap((entry) =>
    (["A", "A2"] as const).map((phase) => {
      const r = runOf(entry.id, phase);
      if (r === undefined) return { caseId: entry.id, phase, ran: false };
      const defect = entry.defectLines;
      return {
        caseId: entry.id,
        phase,
        ran: true,
        kind: entry.planted ?? "real",
        inSample: entry.inSample,
        outcome: r.outcome ?? null,
        ...(defect.length === 0
          ? { caught: null, note: "defect lines not confirmed" }
          : entry.catch === "no-approval"
            ? approvalCatch(r, defect)
            : caughtDefect(r, defect)),
        referencesCoverDefect:
          defect.length === 0 ? null : referencesCover(r, defect),
        rules: { lanes: laneChecks(r), dispositions: dispositionChecks(r) },
        proof: (() => {
          // A case whose proof records were not copied has nothing to measure proof against.
          const path = join(runsDir(entry.id), "pristine.json");
          const proofs = existsSync(path)
            ? (
                JSON.parse(readFileSync(path, "utf8")) as {
                  proofs?: { copied?: boolean } | null;
                }
              ).proofs
            : null;
          return entry.copyProofs && proofs?.copied === false
            ? {
                measured: false,
                note: "not measured: the case ran without its proof records",
              }
            : { measured: true, ...proofCoverage(r) };
        })(),
      };
    }),
  );

  // Proof ranges (FT9, phase A only) and the planted cases: named by a separate authoring lane;
  // until they are, each says "not measured" rather than reading as zero.
  const proofRangesNamed = readProofRanges();
  const proofRanges =
    proofRangesNamed.length === 0
      ? {
          measured: false as const,
          note: "not measured: no proof ranges are named yet (proof-ranges.json)",
        }
      : {
          measured: true as const,
          ranges: proofRangesNamed.map((entry) => {
            const r = runOf(entry.id, "A");
            return r === undefined
              ? {
                  caseId: entry.id,
                  ran: false,
                  note: "not measured: phase A has not run on it",
                }
              : {
                  caseId: entry.id,
                  ran: true,
                  proof: proofCoverage(r),
                  rules: {
                    lanes: laneChecks(r),
                    dispositions: dispositionChecks(r),
                  },
                };
          }),
        };
  const plantedNamed = readKnownCases().filter(
    (entry) => entry.kind === "planted",
  );
  const plantedCases =
    plantedNamed.length === 0
      ? {
          measured: false as const,
          note: "not measured: the planted cases are not built yet (planted.ts, from the authoring lane's spec)",
        }
      : {
          measured: true as const,
          cases: plantedNamed.map((entry) => entry.id),
        };

  // U′: Understand's own variation against A, per range.
  const understand = selection.selected.flatMap((range) => {
    const a = runOf(range.caseId, "A");
    const u = runOf(range.caseId, "U2");
    if (a?.changeMap == null || u?.changeMap == null) return [];
    const labels = (map: NonNullable<StoredRun["changeMap"]>) =>
      new Map(
        map.behaviours.flatMap((b) => b.hunkIds.map((h) => [h, b.id] as const)),
      );
    const parts = (plan: StoredRun["plan"]) =>
      new Map(
        (plan?.partitions ?? []).flatMap((p) =>
          p.hunkIds.map((h) => [h, p.id] as const),
        ),
      );
    const behaviours = matchGroups(
      a.changeMap.behaviours.map((b) => ({
        id: b.id,
        members: new Set(b.hunkIds),
      })),
      u.changeMap.behaviours.map((b) => ({
        id: b.id,
        members: new Set(b.hunkIds),
      })),
    );
    const obligations = matchObligations(
      a.changeMap.behaviours.flatMap((b) =>
        b.obligations.map((o) => ({
          basis: JSON.stringify(o.basis),
          text: o.text,
        })),
      ),
      u.changeMap.behaviours.flatMap((b) =>
        b.obligations.map((o) => ({
          basis: JSON.stringify(o.basis),
          text: o.text,
        })),
      ),
    );
    return [
      {
        caseId: range.caseId,
        candidateBatchARI: adjustedRandIndex(
          labels(a.changeMap),
          labels(u.changeMap),
        ),
        partitionARI: adjustedRandIndex(parts(a.plan), parts(u.plan)),
        behaviours: {
          a: a.changeMap.behaviours.length,
          u: u.changeMap.behaviours.length,
          matched: behaviours.pairs.length,
          aMatched: behaviours.leftMatched,
          uMatched: behaviours.rightMatched,
        },
        obligations,
      },
    ];
  });
  const meanOf = (values: ReadonlyArray<number | null>) =>
    mean(values.filter((v): v is number => v !== null));
  const understandSummary = {
    ranges: understand.length,
    meanCandidateBatchARI: round(
      meanOf(understand.map((u) => u.candidateBatchARI.ari)),
    ),
    meanPartitionARI: round(meanOf(understand.map((u) => u.partitionARI.ari))),
    behavioursMatchedShare: {
      a: round(meanOf(understand.map((u) => u.behaviours.aMatched))),
      u: round(meanOf(understand.map((u) => u.behaviours.uMatched))),
    },
    obligationsMatchedShare: {
      a: round(meanOf(understand.map((u) => u.obligations.leftMatched))),
      u: round(meanOf(understand.map((u) => u.obligations.rightMatched))),
    },
  };

  // Receipts and tokens: every run, by phase and stage; generation-0 outcomes apart.
  const spend = readFullTestSpend();
  const byPhase = Object.fromEntries(
    ["A", "C", "A2", "U2", "B"].map((phase) => {
      const runs = latestRuns(spend.runs).filter(
        (entry) => entry.phase === phase,
      );
      const sum = (pick: (t: (typeof runs)[number]["tokens"]) => number) =>
        runs.reduce((total, entry) => total + pick(entry.tokens), 0);
      const stages: Record<string, { input: number; output: number }> = {};
      for (const entry of runs)
        for (const [stage, t] of Object.entries(entry.tokensByStage)) {
          const held = (stages[stage] ??= { input: 0, output: 0 });
          held.input += t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
          held.output += t.output;
        }
      const input = sum(
        (t) => t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
      );
      // B stops once Investigate is done (FT4 as amended): Assemble and Dispose work started for
      // early batches before that is lost, and counted here.
      const lost = runs
        .filter(
          (entry) => phase === "B" && entry.gen0Outcome !== "continuation",
        )
        .reduce(
          (total, entry) => {
            for (const stage of ["assemble", "dispose", "publish"]) {
              const t = entry.tokensByStage[stage];
              if (t === undefined) continue;
              total.input +=
                t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
              total.output += t.output;
            }
            return total;
          },
          { input: 0, output: 0 },
        );
      // Every attempt, aborted and superseded ones too: what the phase spent in all.
      const attempts = spend.runs.filter((entry) => entry.phase === phase);
      const allAttempts = attempts.reduce(
        (total, entry) => ({
          runs: total.runs + 1,
          input:
            total.input +
            entry.tokens.input +
            entry.tokens.cacheWrite5m +
            entry.tokens.cacheWrite1h +
            entry.tokens.cacheRead,
          output: total.output + entry.tokens.output,
        }),
        { runs: 0, input: 0, output: 0 },
      );
      return [
        phase,
        {
          ...(phase === "B" ? { lostAfterInvestigate: lost } : {}),
          allAttempts,
          runs: runs.length,
          stored: runs.filter((entry) => entry.stored).length,
          input,
          output: sum((t) => t.output),
          cacheReadShare:
            input === 0 ? null : round(sum((t) => t.cacheRead) / input),
          modelCalls: runs.reduce(
            (total, entry) => total + entry.modelCalls,
            0,
          ),
          generations: runs.reduce(
            (total, entry) => total + entry.runIds.length,
            0,
          ),
          gen0TimedOut: runs
            .filter((entry) => entry.gen0Outcome === "timed-out")
            .map((entry) => entry.caseId),
          stillIncomplete: runs
            .filter((entry) => !entry.stored)
            .map((entry) => `${entry.caseId}: ${entry.outcome}`),
          usageLimits: runs.flatMap((entry) =>
            entry.usageLimit === null ? [] : [entry.caseId],
          ),
          byStage: stages,
        },
      ];
    }),
  );
  const timedOut = PACKET_PHASES.flatMap((phase) =>
    selection.selected.flatMap((range) => {
      // Only the generation 0 of a stored run: an unfinished attempt is not reported.
      const gen0 = isStored(range.caseId, phase)
        ? readStored<StoredRun>(range.caseId, phase, ".gen0")
        : undefined;
      if (gen0 === undefined) return [];
      return [
        {
          phase,
          caseId: range.caseId,
          published: {
            complete: gen0.packet?.complete ?? null,
            counts: gen0.packet?.counts ?? null,
          },
          disclosed: (gen0.packet?.gaps ?? []).map(
            (gap) => `${gap.payload.kind}: ${gap.payload.detail}`,
          ),
          unassessedUnits: packetUnits(gen0.packet).filter(
            ({ unit }) => unit.assessment === undefined,
          ).length,
        },
      ];
    }),
  );

  // FT4: whether B goes on past Investigate.
  // FT4's rule is decided only on complete phases: A, A′ and B stored as whole runs on every
  // scored range. A seed report is written before B's worker starts, so it never counts alone.
  const incompleteForB = selection.selected.flatMap((range) => [
    ...(["A", "A2", "B"] as const)
      .filter((phase) => !isStored(range.caseId, phase))
      .map((phase) => `${phase} ${range.caseId}`),
    ...(["A", "B"] as const)
      .filter(
        (phase) =>
          isStored(range.caseId, phase) &&
          readServed(range.caseId, phase) === undefined,
      )
      .map((phase) => `served top 3 of ${phase} ${range.caseId}`),
  ]);
  const bStored = new Set(
    selection.selected
      .filter((range) => isStored(range.caseId, "B"))
      .map((range) => range.caseId),
  );
  // Each hunk's served top 3 from the stored runs' manifests (the leads Precompute stored), so
  // the rule reads the same thing on the seam and on the BM25-key path.
  const servedTop3 = (phase: PhaseId) => {
    const out = new Map<string, ReadonlyArray<string> | null>();
    for (const range of selection.selected) {
      if (!bStored.has(range.caseId)) continue;
      for (const [hunkId, top] of readServed(range.caseId, phase) ?? [])
        out.set(`${range.caseId}\u0000${hunkId}`, top);
    }
    return out;
  };
  const served = servedTop3Differ(servedTop3("A"), servedTop3("B"));
  const ledgerSeparates = (["necessary", "relevant"] as const).map((metric) => {
    const result = separability(
      pairsFor("B", "all", metric, "ledger"),
      pairsFor("A2", "all", metric, "ledger"),
    );
    return {
      metric,
      separable: result.familyWeighted.separable,
      delta: result.comparison.familyWeighted.delta,
    };
  });
  const sameDirection =
    ledgerSeparates.every((entry) => entry.separable) &&
    new Set(ledgerSeparates.map((entry) => Math.sign(entry.delta ?? 0)))
      .size === 1;
  const bContinuation = {
    rule: "B's later stages run only if the top 3 the harness serves differ on at least half of all harness hunks, or B's ledger separates from A's under FT5's rule on both necessary and relevant coverage (fractional, view all) in the same direction (FT4)",
    servedTop3: served,
    servedCondition: served.hunks > 0 && served.differ * 2 >= served.hunks,
    ledgerSeparates,
    ledgerCondition: sameDirection,
    go:
      (served.hunks > 0 && served.differ * 2 >= served.hunks) || sameDirection,
    /** True only when every scored range has A, A′ and B stored: the rule may be decided. */
    measured: incompleteForB.length === 0 && served.hunks > 0,
    incomplete: incompleteForB,
  };

  const subset = (set: ReadonlySet<string>) => ({
    ledger: summariseRows(
      ledgerRows.filter((row) => set.has(row.caseId)),
      ["phase", "source", "view"],
    ),
    separability: separabilityOf(set),
    agreement: agreements(set),
  });

  return {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    goldCheck: check,
    snapshot: spend.snapshotCommit,
    scoredHunks: scored.length,
    scoredFamilies: new Set(scored.map((s) => s.hunk.family)).size,
    missingRuns,
    retrieval: retrieval.map((entry) =>
      "rows" in entry
        ? { arm: entry.arm, present: true, summary: entry.summary }
        : entry,
    ),
    leadDifferences: leadDiff,
    ledger: {
      summary: ledgerSummary,
      counts: ledgerCounts,
      equalSize,
      precision,
    },
    noiseFloor,
    separability: separabilityOf(),
    agreement: agreements(),
    unitMatching,
    rules: rulesPerRun,
    ruleViolations: rulesPerRun.flatMap((entry) =>
      [...entry.lanes.violations, ...entry.dispositions.violations].map(
        (v) => ({ phase: entry.phase, caseId: entry.caseId, ...v }),
      ),
    ),
    misleadingShare: {
      summary: (() => {
        const groups = new Map<string, typeof attributionRows>();
        for (const row of attributionRows) {
          const key = `${row.phase}\u0000${row.source}\u0000${row.view}`;
          groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        return [...groups.entries()].map(([key, rows]) => {
          const [phase, source, view] = key.split("\u0000");
          const m = (pick: (row: (typeof rows)[number]) => number | null) =>
            familyMean(
              rows.map((row) => ({
                family: row.family,
                caseId: row.caseId,
                value: pick(row),
              })),
            );
          const misleading = m((row) => row.misleadingShare);
          const irrelevant = m((row) => row.irrelevantShare);
          return {
            phase,
            source,
            view,
            hunksWithJudgedItems: misleading.hunks,
            misleadingShare: {
              mean: round(misleading.mean),
              hunkMean: round(misleading.hunkMean),
            },
            irrelevantShare: {
              mean: round(irrelevant.mean),
              hunkMean: round(irrelevant.hunkMean),
            },
          };
        });
      })(),
    },
    lookAlikes,
    laterFixes: laterFixFindings(),
    searchAttribution: {
      measured: false as const,
      note: "not measured: FT17's search attribution waits for a source of the search results each agent saw (search-attribution.ts SearchExposureSource), due with the search tools",
    },
    deviations: DEVIATIONS,
    knownCases,
    plantedCases,
    proofRanges,
    understand: { summary: understandSummary, perRange: understand },
    receipts: {
      byPhase,
      timedOut,
      stops: spend.stops,
      invocations: spend.invocations,
    },
    bContinuation,
    named12: subset(named),
    perHunk: { ledger: ledgerRows },
  };
};

export type Measurements = Awaited<ReturnType<typeof measureAll>>;

/** Family-weighted and plain means of each metric, grouped by the named keys. */
export const summariseRows = <
  R extends { family: string; caseId: string } & Coverage,
>(
  rows: ReadonlyArray<R>,
  keys: ReadonlyArray<keyof R>,
) => {
  const groups = new Map<string, Array<R>>();
  for (const row of rows) {
    const key = JSON.stringify(keys.map((k) => row[k]));
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([key, group]) => ({
    ...Object.fromEntries(
      keys.map((k, index) => [k, (JSON.parse(key) as Array<unknown>)[index]]),
    ),
    hunks: new Set(
      group.map((row) => (row as unknown as { hunkId: string }).hunkId),
    ).size,
    ...Object.fromEntries(
      METRICS.map((metric) => {
        const m = familyMean(
          group.map((row) => ({
            family: row.family,
            caseId: row.caseId,
            value: row[metric],
          })),
        );
        return [metric, { mean: round(m.mean), hunkMean: round(m.hunkMean) }];
      }),
    ),
  }));
};

export const MEASUREMENTS_FILE = join(FULL_TEST_RESULTS, "measurements.json");

export const writeMeasurements = async (
  options: { readonly gold?: string | undefined } = {},
) => {
  const out = await measureAll(options);
  ensureDir(FULL_TEST_RESULTS);
  writeFileSync(MEASUREMENTS_FILE, `${JSON.stringify(out, null, 2)}\n`);
  return out;
};

export type { Ranking };
