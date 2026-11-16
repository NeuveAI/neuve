import { GROUP_MAX_UNITS } from "./units.ts";

import { posix } from "node:path";
import { z } from "zod";
import {
  AssembledBatch,
  AssembledDigest,
  type SourcePin,
  AssembledReference as Reference,
  AssembledUnit,
  CitationTarget,
  ConfirmedBatch,
  ConfirmedUnit,
  ProofEntry,
  TurnPlan,
  UnitsConfirmation,
} from "@neuve/records-schema";
import { Proofs } from "@neuve/records-core";

import { qualificationWords } from "./reader-text.ts";
import {
  rulesSubmission,
  type ManifestHunk,
  type RangeManifest,
} from "./manifest.ts";
import { assessResponsibilityAllocation } from "@neuve/review-rules";
import { laneOf } from "./lane-rule.ts";
import { proximityUnits, UNIT_GAP_LINES } from "./units.ts";
import {
  SECTIONS_RECIPE,
  sectionLabel,
  sectionsOf,
  type Section,
  type Structure,
} from "./sections.ts";
import { describeListed } from "./proof-tools.ts";

import type { ScopeSnapshot } from "./scope.ts";
import type { ChangeMap } from "./review-map.ts";

export { laneOf };
export { SECTIONS_RECIPE };

// ---------------------------------------------------------------------------------------------
// Inputs and default units
// ---------------------------------------------------------------------------------------------

type Behaviour = ChangeMap["behaviours"][number];

/** A Map group, its immutable range and its compatible packet citations. */
export interface BatchInputs {
  readonly behaviour: Behaviour;
  readonly changeMap: ChangeMap;
  readonly manifest: RangeManifest;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  readonly snapshot: ScopeSnapshot | undefined;
  /**
   * The run's pins of the snapshot's external sources, each with what this run's check found
   * (11.17, 11.18). Absent where no source is pinned.
   */
  readonly pins?: ReadonlyArray<SourcePin> | undefined;
  readonly keys: {
    readonly manifest: string;
    readonly changeMap: string;
    readonly scope: string | null;
  };
  /**
   * Each changed file's structure by blob object ID, at head and base (10.109): where the units
   * stage cuts sections. Absent or missing a blob, that file's hunks are one section each.
   */
  readonly structures?: ReadonlyMap<string, Structure> | undefined;
}

const hunksOf = (inputs: BatchInputs, ids: ReadonlyArray<string>) =>
  ids.flatMap((id) => {
    const hunk = inputs.hunks.get(id);
    return hunk === undefined ? [] : [hunk];
  });

/** Code sections, in file order, before Map proximity units receive them. */
const defaultSections = (
  batchId: string,
  hunks: ReadonlyArray<ManifestHunk>,
  structures: ReadonlyMap<string, Structure> = new Map(),
) =>
  sectionsOf(hunks, structures).map((section, index) => ({
    id: `${batchId}.s${index + 1}`,
    path: section.path,
    hunkIds: [...section.hunkIds],
    changedLines: section.ranges.reduce(
      (sum, range) => sum + range.lineCount,
      0,
    ),
    section,
  }));

const sectionsFor = (
  inputs: BatchInputs,
  batchId: string,
  hunkIds: ReadonlyArray<string>,
) => defaultSections(batchId, hunksOf(inputs, hunkIds), inputs.structures);

/**
 * Proximity units for a set of hunks at a gap, as hunk-ID sets in file order (AS1, 10.59): kept for
 * the packet's coverage telemetry. Map uses the default distance for its unit identities.
 */
const defaultUnits = (
  batchId: string,
  hunks: ReadonlyArray<ManifestHunk>,
  gap: number = UNIT_GAP_LINES,
) => proximityUnits(batchId, hunks, gap);

/**
 * The stored shapes of the units stage and Assemble live in `@neuve/records-schema` (M5 RD1), so
 * Records' read model decodes what this stage stores; re-exported here under the harness's names.
 */
export {
  AssembledBatch,
  AssembledDigest,
  AssembledUnit,
  CitationTarget,
  ConfirmedBatch,
  ConfirmedUnit,
  ProofEntry,
  Reference,
  TurnPlan,
};

/** The units stage's stored output for one candidate batch. */
export const UnitsPlan = z.strictObject({
  candidate: z.string(),
  confirmation: UnitsConfirmation,
  /** What each of `units` is (10.109): one responsibility section, its plain label and kind. */
  sections: z.array(
    z.strictObject({
      id: z.string(),
      label: z.string(),
      kind: z.string(),
      /** Where its boundaries came from: a capability, or one section per hunk and why. */
      basis: z.string(),
    }),
  ),
  defaults: z.array(
    z.strictObject({
      id: z.string(),
      path: z.string(),
      hunkIds: z.array(z.string()),
    }),
  ),
  batches: z.array(ConfirmedBatch),
  units: z.array(ConfirmedUnit),
  /** Proximity-unit counts at each gap, retained as coverage telemetry. */
  counts: z.strictObject({
    at10: z.int().min(0),
    at20: z.int().min(0),
    at40: z.int().min(0),
  }),
  groups: z.array(
    z.strictObject({
      id: z.string(),
      batchId: z.string(),
      units: z.array(z.string()),
    }),
  ),
  references: z.array(Reference),
  proofs: z.array(ProofEntry),
  turns: TurnPlan,
  /** The review rules' check of the units' ownership (10.21), and what it disclosed. */
  ownership: z.strictObject({
    complete: z.boolean(),
    changedInstances: z.int().min(0),
    allocated: z.int().min(0),
    nontext: z.int().min(0),
    detail: z.array(z.string()),
  }),
});
export type UnitsPlan = z.infer<typeof UnitsPlan>;

/**
 * A hunk's ownership exactly as the shared review rules gave it (10.21): its changed ranges, or the
 * whole file for a hunk the rules qualify as binary or metadata. Nothing else: a hunk the rules
 * left without either owns nothing here, and the units stage discloses it.
 */
const ownedRangesOf = (hunk: ManifestHunk): ConfirmedUnit["ownedRanges"] => {
  const ranges = hunk.ownedRanges
    .filter((range) => range.lineCount > 0 && range.startLine > 0)
    .map((range) => ({
      kind: "lines" as const,
      hunkId: hunk.hunkId,
      path:
        range.side === "old"
          ? (hunk.oldPath ?? hunk.path)
          : (hunk.newPath ?? hunk.path),
      side: range.side,
      startLine: range.startLine,
      endLine: range.startLine + range.lineCount - 1,
    }));
  const nontext = hunk.qualifications.some(
    (entry) => entry.kind === "binary" || entry.kind === "metadata",
  );
  return nontext
    ? [
        ...ranges,
        {
          kind: "whole-nontext" as const,
          hunkId: hunk.hunkId,
          path: hunk.path,
          side: hunk.status === "deleted" ? ("old" as const) : ("new" as const),
        },
      ]
    : ranges;
};

/**
 * Checks the confirmed units against the shared review rules (10.21): the rules' own allocation
 * check over the batch's hunks, so units own disjoint changed lines and every changed line and
 * non-text hunk of the batch has an owner. Anything short of that is disclosed, never repaired.
 */
/** Where a unit sits, as a reader finds it: its file and, when it owns lines, its first range. */
export const unitPlace = (unit: {
  readonly path: string;
  readonly ownedRanges: ReadonlyArray<
    { readonly kind: string } & Partial<{
      readonly startLine: number;
      readonly endLine: number;
    }>
  >;
}) => {
  const first = unit.ownedRanges.find((range) => range.kind === "lines");
  if (first?.startLine === undefined) return unit.path;
  const end = first.endLine ?? first.startLine;
  return end === first.startLine
    ? `${unit.path} (line ${first.startLine})`
    : `${unit.path} (lines ${first.startLine}-${end})`;
};

/** The disclosure for a hunk the review rules give no owned lines; composeBatch drops it for a unit Publish discloses. */
const ownerlessLine = (hunk: ManifestHunk) =>
  `A change in ${hunk.path} at line ${hunk.status === "deleted" ? hunk.oldStart : hunk.newStart} owns no changed lines under the review rules${(() => {
    const why = qualificationWords(hunk.qualifications);
    return why === undefined ? "" : ` (${why})`;
  })()}, so no unit is responsible for it.`;

/** A range-manifest limitation from the review rules, as a reader sees it (its handles stay in the manifest). */
const rulesLimitation = (limitation: string) => {
  const unavailable = /^review rules: [a-z-]+: (.+)$/.exec(limitation);
  if (unavailable !== null)
    return `The review rules couldn't account for part of the change (${unavailable[1]!.charAt(0).toLowerCase()}${unavailable[1]!.slice(1)}), so it may have no owner here.`;
  const refused =
    /^review rules refused the range \(([^,)]+)[^)]*\): (.+); no owned ranges$/.exec(
      limitation,
    );
  return refused === null
    ? "The review rules couldn't account for part of the change, so it may have no owner here."
    : `The review rules refused the change's ranges (${refused[1]}: ${refused[2]}), so none of its lines has an owner here.`;
};

export const ownershipCheck = (
  inputs: BatchInputs,
  units: ReadonlyArray<ConfirmedUnit>,
) => {
  const hunks = hunksOf(inputs, inputs.behaviour.hunkIds);
  const detail: Array<string> = [];
  for (const hunk of hunks)
    if (ownedRangesOf(hunk).length === 0) detail.push(ownerlessLine(hunk));
  for (const limitation of inputs.manifest.limitations)
    if (limitation.startsWith("review rules"))
      detail.push(rulesLimitation(limitation));
  const members = (unit: ConfirmedUnit) =>
    unit.ownedRanges.map((range) =>
      range.kind === "lines"
        ? {
            kind: "changed-lines" as const,
            hunkId: range.hunkId,
            side: range.side,
            startLine: range.startLine,
            lineCount: range.endLine - range.startLine + 1,
          }
        : { kind: "whole-nontext" as const, hunkId: range.hunkId },
    );
  try {
    const allocation = assessResponsibilityAllocation({
      submission: rulesSubmission(inputs.manifest.range, hunks),
      units: units
        .filter((unit) => unit.ownedRanges.length > 0)
        .map((unit) => ({
          unitId: unit.id,
          revisionId: inputs.manifest.range.headOid,
          responsibility: { kind: "changed-ranges", members: members(unit) },
        })),
    });
    // A hunk that owns no lines at all is disclosed above (`ownerlessLine`), so it is not named twice.
    const unowned = allocation.unallocated.filter((m) => {
      const of = inputs.hunks.get(m.hunkId);
      return of === undefined || ownedRangesOf(of).length > 0;
    });
    if (unowned.length > 0)
      detail.push(
        `The review rules find ${unowned.length} changed range(s) with no unit responsible for them, in ${[
          ...new Set(
            unowned.map(
              (m) => inputs.hunks.get(m.hunkId)?.path ?? "an unnamed file",
            ),
          ),
        ]
          .slice(0, 6)
          .join(", ")}.`,
      );
    return {
      complete: allocation.allocationComplete && detail.length === 0,
      changedInstances: allocation.changedInstances,
      allocated: allocation.allocatedChangedInstances,
      nontext: allocation.nontextObligations,
      detail,
    };
  } catch (error) {
    detail.push(
      `The review rules refused how the units divide this batch's lines (${error instanceof Error ? error.message : String(error)}), so who owns what is unchecked.`,
    );
    return {
      complete: false,
      changedInstances: 0,
      allocated: 0,
      nontext: 0,
      detail,
    };
  }
};

/** A set of sections' owned ranges, exactly as the review rules gave their lines (10.21). */
const sectionOwnership = (
  inputs: BatchInputs,
  pieces: ReadonlyArray<Section>,
): ConfirmedUnit["ownedRanges"] => {
  const lines = pieces.flatMap((piece) =>
    piece.ranges.flatMap((range) => {
      const hunk = inputs.hunks.get(range.hunkId);
      if (hunk === undefined) return [];
      return [
        {
          kind: "lines" as const,
          hunkId: range.hunkId,
          path:
            range.side === "old"
              ? (hunk.oldPath ?? hunk.path)
              : (hunk.newPath ?? hunk.path),
          side: range.side,
          startLine: range.startLine,
          endLine: range.startLine + range.lineCount - 1,
        },
      ];
    }),
  );
  const nontext = [
    ...new Set(pieces.flatMap((piece) => piece.hunkIds)),
  ].flatMap((hunkId) => {
    const hunk = inputs.hunks.get(hunkId);
    return hunk !== undefined &&
      hunk.qualifications.some(
        (entry) => entry.kind === "binary" || entry.kind === "metadata",
      )
      ? [
          {
            kind: "whole-nontext" as const,
            hunkId,
            path: hunk.path,
            side:
              hunk.status === "deleted" ? ("old" as const) : ("new" as const),
          },
        ]
      : [];
  });
  return [...lines, ...nontext];
};

/** Code assigns every changed line to one section before the proximity join. */
export const codeUnits = (inputs: BatchInputs) => {
  const behaviour = inputs.behaviour;
  const defaults = sectionsFor(inputs, behaviour.id, behaviour.hunkIds);
  const units: ConfirmedUnit[] = defaults.map((entry) => {
    const hunks = hunksOf(inputs, entry.hunkIds);
    return {
      id: entry.id,
      batchId: behaviour.id,
      path: entry.path,
      hunkIds: entry.hunkIds,
      changedLines: entry.changedLines,
      from: [entry.id],
      grouping: { gapLines: 0 },
      ownedRanges: sectionOwnership(inputs, [entry.section]),
      ownedPaths: [
        ...new Set(
          hunks.flatMap((h) =>
            [h.oldPath, h.newPath, h.path].filter(
              (path): path is string => path !== null,
            ),
          ),
        ),
      ],
    };
  });
  return {
    confirmation: {
      decision: "confirm" as const,
      reason: "Code preserves the Map group's changed ranges.",
      source: "code" as const,
      changes: [],
    },
    defaults: defaults.map(({ id, path, hunkIds }) => ({ id, path, hunkIds })),
    batches: [
      {
        id: behaviour.id,
        title: behaviour.title,
        focus: behaviour.focus,
        hunkIds: [...behaviour.hunkIds],
        obligationIds: behaviour.obligations.map((o) => o.id),
        reason: null,
        units: units.map((u) => u.id),
      },
    ],
    units,
    sections: defaults.map((entry) => ({
      id: entry.id,
      label: sectionLabel(entry.section),
      kind: entry.section.kind,
      basis: entry.section.basis,
    })),
    counts: {
      at10: defaultUnits(behaviour.id, hunksOf(inputs, behaviour.hunkIds), 10)
        .length,
      at20: defaultUnits(behaviour.id, hunksOf(inputs, behaviour.hunkIds), 20)
        .length,
      at40: defaultUnits(behaviour.id, hunksOf(inputs, behaviour.hunkIds), 40)
        .length,
    },
  };
};

/** Groups of up to four units in file order; a file's units share a group where they fit (§8.2). */
export const groupUnits = (
  batch: ConfirmedBatch,
  units: ReadonlyArray<ConfirmedUnit>,
) => {
  const own = units.filter((unit) => unit.batchId === batch.id);
  const byFile = new Map<string, Array<string>>();
  for (const unit of own)
    byFile.set(unit.path, [...(byFile.get(unit.path) ?? []), unit.id]);
  const groups: Array<Array<string>> = [];
  let current: Array<string> = [];
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  for (const ids of byFile.values()) {
    if (ids.length <= GROUP_MAX_UNITS) {
      if (current.length + ids.length > GROUP_MAX_UNITS) flush();
      current.push(...ids);
      continue;
    }
    flush();
    for (let i = 0; i < ids.length; i += GROUP_MAX_UNITS) {
      flush();
      current.push(...ids.slice(i, i + GROUP_MAX_UNITS));
    }
  }
  flush();
  return groups.map((ids, index) => ({
    id: `${batch.id}.g${index + 1}`,
    batchId: batch.id,
    units: ids,
  }));
};

/** The range's proof records with each unit's currency, as the units stage stores them. */
export const proofIndex = (
  listed: ReadonlyArray<Proofs.ListedProof>,
  currency: ReadonlyMap<string, ReadonlyMap<string, string>>,
): ReadonlyArray<ProofEntry> =>
  listed.map((record) => ({
    id: record.id,
    kind: record.kind,
    revision: record.revision,
    recorder: `${record.recorder.alias} (${record.recorder.harness ?? "unregistered"})`,
    requirement: record.requirement.text,
    claim: record.claim,
    listing: describeListed(record),
    currency: Object.fromEntries(currency.get(record.id) ?? new Map()),
  }));

// ---------------------------------------------------------------------------------------------
// Citations: every ID an agent may cite, and what it resolves to (§8.4: hard integrity)
// ---------------------------------------------------------------------------------------------

export const citationIndex = (
  inputs: BatchInputs,
  plan: Pick<UnitsPlan, "units" | "proofs" | "references">,
) => {
  const index = new Map<string, CitationTarget>();
  const manifest = `computation:${inputs.keys.manifest}`;
  for (const fact of inputs.manifest.facts)
    index.set(fact.id, { kind: "change-fact", ref: manifest, entry: fact.id });
  for (const id of inputs.hunks.keys())
    index.set(id, { kind: "hunk", ref: manifest, entry: id });
  for (const behaviour of inputs.changeMap.behaviours)
    for (const obligation of behaviour.obligations)
      index.set(obligation.id, {
        kind: "obligation",
        ref: `computation:${inputs.keys.changeMap}`,
        entry: obligation.id,
      });
  for (const source of inputs.snapshot?.sources ?? [])
    for (const section of source.sections)
      index.set(section.id, {
        kind: "scope-section",
        ref:
          inputs.keys.scope === null
            ? null
            : `computation:${inputs.keys.scope}`,
        entry: section.id,
      });
  for (const proof of plan.proofs)
    index.set(proof.id, {
      kind: "proof",
      ref: `event:${proof.id}`,
      entry: null,
    });
  for (const unit of plan.units)
    index.set(unit.id, { kind: "unit", ref: null, entry: unit.id });
  for (const reference of plan.references)
    index.set(reference.id, {
      kind: "reference",
      ref: null,
      entry: reference.id,
    });
  const normalise = (raw: string) => {
    const id = raw.trim().replace(/^\[|\]$/g, "");
    return index.has(id) ? id : undefined;
  };
  return { index, normalise };
};

/** A Facts line built by code from the change map and change facts, for a unit with no content (§8.6). */
const codeFacts = (
  unit: ConfirmedUnit,
  inputs: BatchInputs,
  label: string | undefined,
) => {
  const count = (side: "old" | "new") =>
    unit.ownedRanges.reduce(
      (sum, range) =>
        range.kind === "lines" && range.side === side
          ? sum + range.endLine - range.startLine + 1
          : sum,
      0,
    );
  const added = count("new");
  const deleted = count("old");
  const fact = inputs.manifest.facts.find(
    (f) => f.about.kind === "file" && f.about.path === unit.path,
  );
  const what =
    added > 0 && deleted > 0
      ? `${added} line(s) added and ${deleted} removed`
      : added > 0
        ? `${added} line(s) added`
        : deleted > 0
          ? `${deleted} line(s) removed`
          : "a change with no text lines";
  return {
    text: `${label ?? unit.path}: ${what}, for "${inputs.behaviour.title}".`.slice(
      0,
      400,
    ),
    cites: [
      ...unit.hunkIds.slice(0, 6),
      ...(fact === undefined ? [] : [fact.id]),
    ],
  };
};

/** A proof's currency per unit, with each joined unit taking its first section's (same file, same paths). */
const remapCurrency = (
  currency: Readonly<Record<string, string>>,
  finalOf: ReadonlyMap<string, string>,
) => {
  const out: Record<string, string> = { ...currency };
  for (const [section, unit] of finalOf)
    if (out[unit] === undefined && currency[section] !== undefined)
      out[unit] = currency[section]!;
  return out;
};

/** Code fills facts and ownership; findings and dispositions are attached by Link. */
export const composeBatch = (options: {
  readonly inputs: BatchInputs;
  readonly plan: UnitsPlan;
  readonly gaps: ReadonlyArray<string>;
  readonly unitOf: (section: AssembledUnit) => string;
}): AssembledBatch => {
  const { inputs, plan } = options;
  const citations = citationIndex(inputs, plan);
  const ownerless = new Set(
    plan.units
      .filter((unit) => unit.ownedRanges.length === 0)
      .flatMap((unit) => hunksOf(inputs, unit.hunkIds))
      .map(ownerlessLine),
  );
  const labels = new Map(plan.sections.map((entry) => [entry.id, entry.label]));
  const parts: AssembledUnit[] = plan.units.map((unit) => ({
    ...unit,
    title:
      `Changes to ${labels.get(unit.id) ?? posix.basename(unit.path)}`.slice(
        0,
        120,
      ),
    group: plan.groups.find((group) => group.units.includes(unit.id))!.id,
    references: [],
    assessment: {
      status: "not-assessed",
      source: "none",
      quadrant: null,
      lane: "human-suggested",
      laneNote: "No assessment is recorded for this unit.",
      complexity: { level: null, factors: [] },
      validation: { level: null, requirements: [] },
      movement: [],
      lean: null,
      gaps: [
        {
          axis: "complexity",
          kind: "not-assessed",
          detail: "No assessment is recorded for this unit.",
        },
      ],
      rationale: "The unit needs a person's review.",
      highComplexityValidationGap: false,
    },
    content: {
      source: "code",
      facts: codeFacts(unit, inputs, labels.get(unit.id)),
      briefed: null,
      explained: null,
      verdictWords: 0,
      laneWords: 0,
    },
  }));
  const grouped = new Map<string, AssembledUnit[]>();
  for (const part of parts) {
    const id = options.unitOf(part);
    const members = grouped.get(id) ?? [];
    members.push(part);
    grouped.set(id, members);
  }
  const finalOf = new Map<string, string>();
  const units: AssembledUnit[] = [...grouped].map(([id, members]) => {
    const first = members[0]!;
    for (const member of members) finalOf.set(member.id, id);
    return {
      ...first,
      id,
      title:
        members.length === 1
          ? first.title
          : `Changes in ${posix.basename(first.path)}`,
      hunkIds: [...new Set(members.flatMap((m) => m.hunkIds))],
      changedLines: members.reduce((sum, m) => sum + m.changedLines, 0),
      from: [...new Set(members.flatMap((m) => m.from))],
      ownedRanges: members.flatMap((m) => m.ownedRanges),
      ownedPaths: [...new Set(members.flatMap((m) => m.ownedPaths))],
      sections: members.map((m) => ({
        id: m.id,
        title: m.title,
        ownedRanges: m.ownedRanges,
        content: {
          facts: m.content.facts,
          briefed: m.content.briefed,
          explained: m.content.explained,
        },
      })),
      content: {
        ...first.content,
        facts: {
          text: members.map((m) => m.content.facts.text).join(" "),
          cites: [...new Set(members.flatMap((m) => m.content.facts.cites))],
        },
      },
    };
  });
  const batches = plan.batches.map((batch) => {
    const own = units.filter((unit) => unit.batchId === batch.id);
    return {
      ...batch,
      units: own.map((unit) => unit.id),
      digest: {
        batchId: batch.id,
        source: "code" as const,
        digest:
          `${own.length} unit(s) in ${new Set(own.map((u) => u.path)).size} file(s) for "${batch.title}". ${own.map((u) => `[${unitPlace(u)}](${u.id}): ${u.content.facts.text}`).join(" ")}`.slice(
            0,
            2_000,
          ),
        verification: "No assessment is recorded for these units.",
        uncertainty: [],
        limitations: [
          "This briefing was put together by code from each unit's facts.",
        ],
        verdictWords: 0,
      },
    };
  });
  const used = new Set(units.flatMap((unit) => unit.content.facts.cites));
  for (const unit of units) {
    citations.index.set(unit.id, { kind: "unit", ref: null, entry: unit.id });
    used.add(unit.id);
  }
  return {
    candidate: plan.candidate,
    complete: plan.ownership.complete,
    confirmation: plan.confirmation,
    batches,
    units,
    references: [],
    proofs: plan.proofs.map(({ listing: _listing, ...proof }) => ({
      ...proof,
      currency: remapCurrency(proof.currency, finalOf),
    })),
    pins: [],
    citations: Object.fromEntries(
      [...used].flatMap((id) =>
        citations.index.has(id) ? [[id, citations.index.get(id)!]] : [],
      ),
    ),
    counts: {
      ...plan.counts,
      defaultUnits: plan.defaults.length,
      units: units.length,
      merges: 0,
      splits: 0,
      lanes: { "human-suggested": units.length },
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
      notAssessed: units.length,
      uncited: 0,
      verdictWords: 0,
      laneWords: 0,
    },
    turns: plan.turns,
    gaps: [
      ...options.gaps,
      ...plan.ownership.detail.filter((line) => !ownerless.has(line)),
    ],
  };
};

const VERDICT =
  /\b(approve[sd]?|approval|lgtm|looks good|safe to (?:merge|ship)|ready to (?:merge|ship)|correct(?:ly)?|incorrect(?:ly)?|requests? changes|bug-free|no issues)\b/gi;
/** Count verdict wording in descriptive content before publication. */
export const verdictWordsIn = (text: string) =>
  [...text.matchAll(VERDICT)].length;
