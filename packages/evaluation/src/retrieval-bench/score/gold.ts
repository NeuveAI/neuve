import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  GRADES,
  pooledKey,
  type GoldSpan,
  type Grade,
  type HunkGold,
  type JudgedCandidate,
} from "./types.ts";
import { spanKey } from "../ranking.ts";

/**
 * Reads B3's resolved gold (labelling/adjudication.ts, `resolveGold`; one `gold.json` per hunk) and
 * splits it into what pass 1 scoring may use.
 *
 * Retrieval targets are the items B3 marks `retrievalTarget` that are base spans: committed base
 * regions and base regions only partly changed in the range. Earlier commits are retrieval targets
 * of pass 2 (history, M6) and are excluded here; same-batch regions, the range's own changes,
 * in-range documents and later commits (hindsight, 9.12) are never targets. Every exclusion is
 * counted by reason. Owner-queued items carry their provisional lower grade (9.36) until decided.
 *
 * Judged spans: B3 pools each hunk by merging overlapping arm regions into one candidate, and the
 * labellers judge the merged span. The sibling `pool.json` keeps every arm's own region under the
 * candidate's `sources`, so an arm's pooled item maps to its candidate through (arm, rank, span).
 */

const GoldItem = z.object({
  id: z.string(),
  source: z.enum(["pool", "addition"]),
  region: z.string(),
  kind: z.string(),
  grade: z.enum(GRADES),
  status: z.string(),
  availability: z.string(),
  retrievalTarget: z.boolean(),
});
export type GoldItem = z.infer<typeof GoldItem>;
const GoldFile = z.array(GoldItem);
const PoolFile = z.object({
  caseId: z.string(),
  hunkId: z.string(),
  candidates: z
    .array(
      z.object({
        id: z.string(),
        sources: z.array(
          z.object({
            source: z.string(),
            rank: z.number().nullable(),
            startLine: z.number().nullable(),
            endLine: z.number().nullable(),
          }),
        ),
      }),
    )
    .default([]),
});
export type PoolCandidates = z.infer<typeof PoolFile>["candidates"];

export type ParsedRegion =
  | {
      readonly type: "base";
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    }
  | { readonly type: "base-whole"; readonly path: string }
  | { readonly type: "commit"; readonly commit: string }
  | { readonly type: "range"; readonly text: string };

/** B3's region text: `path:start-end`, `commit <sha>`, `range doc …`, `range change …`. */
export const parseRegion = (region: string): ParsedRegion => {
  if (region.startsWith("commit "))
    return { type: "commit", commit: region.slice(7) };
  if (region.startsWith("range doc ") || region.startsWith("range change "))
    return { type: "range", text: region };
  const match = /^(.*):(\d+)-(\d+)$/.exec(region);
  if (match === null) return { type: "base-whole", path: region };
  return {
    type: "base",
    path: match[1] as string,
    startLine: Number(match[2]),
    endLine: Number(match[3]),
  };
};

const RELEVANCE: Record<Grade, number> = {
  necessary: 3,
  useful: 2,
  misleading: 1,
  irrelevant: 0,
};

export const buildHunkGold = (
  caseId: string,
  hunkId: string,
  items: ReadonlyArray<GoldItem>,
  pool: PoolCandidates = [],
): HunkGold & { readonly provisional: number } => {
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const judged = new Map<string, { grade: Grade; target: boolean }>();
  const candidateSpans = new Map<
    string,
    { key: string; path: string; startLine: number; endLine: number }
  >();
  const targets = new Map<string, GoldSpan>();
  let duplicateSpans = 0;
  let provisional = 0;
  for (const item of items) {
    const region = parseRegion(item.region);
    const relevant = item.grade === "necessary" || item.grade === "useful";
    if (region.type === "base") {
      const key = spanKey(region.path, region.startLine, region.endLine);
      const held = judged.get(key);
      if (held === undefined || RELEVANCE[item.grade] > RELEVANCE[held.grade])
        judged.set(key, {
          grade: item.grade,
          target: item.retrievalTarget || (held?.target ?? false),
        });
      if (item.source === "pool")
        candidateSpans.set(item.id, { key, ...region });
    }
    if (!relevant) continue;
    if (item.status === "owner") provisional++;
    if (!item.retrievalTarget) {
      exclude(`not a retrieval target: ${item.availability}`);
      continue;
    }
    if (region.type === "commit") {
      exclude("history: earlier commit (pass 2, M6)");
      continue;
    }
    if (region.type !== "base") {
      exclude(`unscorable region: ${region.type}`);
      continue;
    }
    const key = spanKey(region.path, region.startLine, region.endLine);
    const span: GoldSpan = {
      id: item.id,
      path: region.path,
      startLine: region.startLine,
      endLine: region.endLine,
      kind: item.kind,
      grade: item.grade as "necessary" | "useful",
      source: item.source,
      availability: item.availability,
    };
    const held = targets.get(key);
    if (held !== undefined) {
      duplicateSpans++;
      if (held.grade === "useful" && span.grade === "necessary")
        targets.set(key, span);
      continue;
    }
    targets.set(key, span);
  }
  // Judged candidates by path (B3's candidates on one path never overlap), and each arm's pooled item.
  const candidates = new Map<string, Array<JudgedCandidate>>();
  for (const { key, path, startLine, endLine } of candidateSpans.values()) {
    const list = candidates.get(path) ?? [];
    if (list.some((entry) => entry.key === key)) continue;
    const label = judged.get(key) as { grade: Grade; target: boolean };
    list.push({ key, startLine, endLine, ...label });
    candidates.set(path, list);
  }
  const pooled = new Map<string, string>();
  for (const candidate of pool) {
    const span = candidateSpans.get(candidate.id);
    if (span === undefined) continue;
    const { key, path } = span;
    for (const source of candidate.sources)
      if (
        source.rank !== null &&
        source.startLine !== null &&
        source.endLine !== null
      )
        pooled.set(
          pooledKey(
            source.source,
            source.rank,
            spanKey(path, source.startLine, source.endLine),
          ),
          key,
        );
  }
  const list = [...targets.values()];
  const necessary = list.filter((span) => span.grade === "necessary");
  const useful = list.filter((span) => span.grade === "useful");
  let overlappingSpans = 0;
  for (const group of [necessary, useful])
    for (let a = 0; a < group.length; a++)
      for (let b = a + 1; b < group.length; b++) {
        const x = group[a] as GoldSpan;
        const y = group[b] as GoldSpan;
        if (
          x.path === y.path &&
          x.startLine <= y.endLine &&
          y.startLine <= x.endLine
        )
          overlappingSpans++;
      }
  return {
    caseId,
    hunkId,
    necessary,
    useful,
    judged,
    candidates,
    pooled,
    excluded,
    fromAdditions: {
      necessary: necessary.filter((span) => span.source === "addition").length,
      useful: useful.filter((span) => span.source === "addition").length,
    },
    duplicateSpans,
    overlappingSpans,
    provisional,
  };
};

const findGoldFiles = (directory: string, out: Array<string> = []) => {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) findGoldFiles(path, out);
    else if (name === "gold.json") out.push(path);
  }
  return out;
};

// ---------------------------------------------------------------- cross-family subset

/** The council's rounds as B3 records them on a council-decided item (`owner.council.votes`). */
const CouncilRecord = z.object({
  owner: z
    .object({
      council: z
        .object({
          votes: z.array(z.object({ votes: z.record(z.string(), z.string()) })),
        })
        .optional(),
    })
    .optional(),
});

/** A gold item's raw JSON with what the cross-family rule reads. */
export type RawGoldItem = GoldItem & z.infer<typeof CouncilRecord>;

/** The two Sol members of the council (9.52); the rule asks both of them. */
export const SOL_MEMBERS = ["sol-medium", "sol-high"] as const;

export const CROSS_FAMILY_RULE =
  "a relevant retrieval target (graded necessary or useful, retrievalTarget true) is kept when its status is agreed or owner-decided, or council-decided with both sol-medium and sol-high voting the decided grade in the council's final round; every other relevant target is dropped and left unjudged, never counted as irrelevant. Items that are not relevant retrieval targets keep their grades";

/** Whether the cross-family rule applies to the item: a relevant retrieval target. */
export const isRelevantTarget = (item: GoldItem) =>
  item.retrievalTarget &&
  (item.grade === "necessary" || item.grade === "useful");

/**
 * The cross-family subset (a sensitivity, never the decision): whether a relevant retrieval target
 * stands without resting on Opus alone. Agreed items had both families' labellers agree; owner
 * decisions stand; a council decision stands only when both Sol members voted the decided grade in
 * the final round. Items the rule does not apply to are kept.
 */
export const keepCrossFamily = (item: RawGoldItem) => {
  if (!isRelevantTarget(item)) return true;
  if (item.status === "agreed" || item.status === "owner-decided") return true;
  if (item.status !== "council-decided") return false;
  const final = item.owner?.council?.votes.at(-1)?.votes;
  return (
    final !== undefined &&
    SOL_MEMBERS.every((member) => final[member] === item.grade)
  );
};

/** Every relevant retrieval target's fate under the cross-family rule, by status. */
export const crossFamilyTally = async (directory: string) => {
  let targets = 0;
  let kept = 0;
  const dropped: Record<string, number> = {};
  for (const file of findGoldFiles(directory)) {
    const json: unknown = JSON.parse(await Bun.file(file).text());
    const items = GoldFile.parse(json);
    const raw = z.array(CouncilRecord).parse(json);
    items.forEach((item, index) => {
      if (!isRelevantTarget(item)) return;
      targets++;
      if (keepCrossFamily({ ...item, ...raw[index] })) kept++;
      else dropped[item.status] = (dropped[item.status] ?? 0) + 1;
    });
  }
  return {
    targets,
    kept,
    dropped: targets - kept,
    droppedByStatus: dropped,
  };
};

/**
 * Every `gold.json` under `directory`. The hunk is named by the sibling `pool.json` (B3's layout,
 * `hunks/<case>/<hunk>/`), or by the directory name when no pool file is beside it. With `keep`,
 * items it refuses are removed before the gold is built, so they are unjudged, not irrelevant.
 */
export const loadGold = async (
  directory: string,
  caseOf: (hunkId: string) => string | undefined,
  keep?: (item: RawGoldItem) => boolean,
) => {
  const out = new Map<string, HunkGold & { readonly provisional: number }>();
  for (const file of findGoldFiles(directory)) {
    const poolPath = join(dirname(file), "pool.json");
    const ids = (await Bun.file(poolPath).exists())
      ? PoolFile.parse(JSON.parse(await Bun.file(poolPath).text()))
      : { hunkId: basename(dirname(file)), caseId: "", candidates: [] };
    const caseId = caseOf(ids.hunkId);
    if (caseId === undefined)
      throw new Error(
        `${file}: hunk ${ids.hunkId} is not a hunk of the manifest's split`,
      );
    if (ids.caseId !== "" && ids.caseId !== caseId)
      throw new Error(
        `${file}: case ${ids.caseId} differs from the manifest's ${caseId}`,
      );
    if (out.has(ids.hunkId))
      throw new Error(`${file}: second gold file for ${ids.hunkId}`);
    const text = await Bun.file(file).text();
    const parsed = GoldFile.parse(JSON.parse(text));
    const items =
      keep === undefined
        ? parsed
        : (() => {
            const raw = z.array(CouncilRecord).parse(JSON.parse(text));
            return parsed.filter((item, index) =>
              keep({ ...item, ...raw[index] }),
            );
          })();
    out.set(
      ids.hunkId,
      buildHunkGold(caseId, ids.hunkId, items, ids.candidates),
    );
  }
  return out;
};
