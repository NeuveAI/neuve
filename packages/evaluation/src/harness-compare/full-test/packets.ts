/**
 * A stored run's published packet, as `neuve review show --run <id> --json` prints it (the runner
 * stores that output whole), read into what the full test measures: each unit's lane, axes and
 * verdict, each harness hunk's unit, and the automatic rule checks of FT10, FT11 and FT12. Only the
 * fields read here are typed; everything else in the stored file is left as it is.
 *
 * The rule checks are code over the packet, never a model (10.71). A violation is a defect against
 * the slice that owns the rule (H7 for lanes, H8 for dispositions and Publish), reported with the
 * unit and the rule's words.
 *
 * Every reader of a stored run's units or batches reaches them through one guard here: `packetUnits`
 * and `packetBatches` check the packet before handing out a unit, and `readablePacket`,
 * `readableRun` and `readShownFile` check it where a run is read. A record kind, lane rule or
 * undecoded part a path was not written for stops the command, so a run of a newer shape can never
 * score as units that own no lines or were never assessed. A path that also reads the sections
 * shape says so (`READS_SECTIONS`); every other path reads today's kinds only.
 */

import { readFileSync } from "node:fs";

export type Lane =
  "static-automation" | "agentic" | "human-suggested" | "human-required";

interface Cited {
  readonly cites: ReadonlyArray<unknown>;
}

export interface AssessmentLite {
  readonly id: string;
  readonly payload: {
    readonly lane: Lane;
    readonly quadrant: string;
    readonly complexity: {
      readonly level: "low" | "high";
      readonly factors: ReadonlyArray<Cited>;
    };
    readonly easeOfValidation: {
      readonly level: "easy" | "hard";
      readonly requirements: ReadonlyArray<
        Cited & {
          readonly requirement: string;
          readonly coverage: "missing" | "shallow" | "solid";
          readonly proof: ReadonlyArray<string>;
        }
      >;
    };
    readonly movement: ReadonlyArray<
      Cited & { readonly signal: string; readonly direction?: string }
    >;
    readonly gaps: ReadonlyArray<{
      readonly axis: string;
      readonly kind: string;
    }>;
    readonly rationale: string;
  };
}

export interface OwnedRangeLite {
  readonly kind: "lines" | "whole-nontext";
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface SidedRange {
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

export interface CommentLite {
  readonly id: string;
  readonly payload: {
    readonly body: string;
    readonly anchor?: SidedRange;
    readonly finding?: {
      readonly kind: "defect" | "risk" | "question" | "pattern-note";
      readonly about: "code" | "tests" | "proof";
      readonly signal?: "forged" | "test-bloat" | "untested" | "stale-proof";
      readonly evidence: ReadonlyArray<{
        readonly ref: string;
        readonly entry?: string;
      }>;
    };
  };
}

export interface ReferenceLite {
  readonly id: string;
  readonly payload: {
    readonly summary: string;
    readonly anchor: SidedRange;
    readonly stance: string;
    readonly origin: string;
    readonly retrieval?: { readonly retriever: string; readonly rank: number };
    readonly provenance:
      | {
          readonly kind: "git";
          readonly revision: string;
          readonly path: string;
          readonly startLine?: number;
          readonly endLine?: number;
        }
      | { readonly kind: string };
  };
}

export interface GuidedRowLite {
  readonly row: string;
  readonly text: string;
  readonly basis: string;
  readonly scope?: string;
  readonly required?: boolean;
  readonly status: string;
  readonly disagreement?: string;
  readonly evidence: ReadonlyArray<string>;
}

export interface GuidedLite {
  readonly rows?: ReadonlyArray<GuidedRowLite>;
  readonly review?: {
    readonly verdict: string;
    readonly uncited: boolean;
    readonly withheld?: boolean;
  } | null;
  readonly suggestion?: { readonly verdict: string } | null;
  readonly proof?: string;
}

export interface PacketUnitLite {
  readonly unitId: string;
  readonly local?: string;
  readonly recorded?: {
    readonly payload: {
      readonly title: string;
      readonly ownedRanges: ReadonlyArray<OwnedRangeLite>;
    };
  };
  readonly assessment?: AssessmentLite;
  readonly content: {
    readonly facts?: {
      readonly text: string;
      readonly cites: ReadonlyArray<string>;
    };
    readonly briefed?: { readonly text: string } | null;
    readonly explained?: unknown;
    readonly guided?: GuidedLite;
  };
  readonly references: ReadonlyArray<ReferenceLite>;
  readonly comments: ReadonlyArray<CommentLite>;
  readonly disposition?: {
    readonly id: string;
    readonly payload: {
      readonly verdict: "approve" | "request-changes";
      readonly restsOn: ReadonlyArray<string>;
      readonly proof: ReadonlyArray<string>;
    };
  };
  readonly judgement?: {
    readonly lane: Lane | null;
    readonly closed: boolean;
    readonly closing?: ReadonlyArray<{ readonly actorKind?: string }>;
  };
}

export interface DigestLite {
  readonly digest?: string;
  readonly obligations?: ReadonlyArray<{
    readonly row: string;
    readonly overall: string;
    readonly units: ReadonlyArray<{
      readonly unit: string;
      readonly status: string;
      readonly required: boolean;
    }>;
  }>;
}

export interface PacketLite {
  readonly complete: boolean;
  readonly counts?: Record<string, number>;
  readonly batches: ReadonlyArray<{
    readonly batchId: string;
    readonly digest?: DigestLite;
    readonly units: ReadonlyArray<PacketUnitLite>;
  }>;
  readonly gaps: ReadonlyArray<{
    readonly payload: { readonly kind: string; readonly detail: string };
  }>;
}

export interface ManifestHunkFull {
  readonly hunkId: string;
  readonly kind: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

/** What the runner stored of one run: `review show --json` plus its own measurement record. */
export interface StoredRun {
  readonly runId?: string;
  readonly outcome?: string;
  readonly packet: PacketLite | null;
  readonly manifest: { readonly hunks: ReadonlyArray<ManifestHunkFull> } | null;
  readonly changeMap?: {
    readonly behaviours: ReadonlyArray<{
      readonly id: string;
      readonly hunkIds: ReadonlyArray<string>;
      readonly obligations: ReadonlyArray<{
        readonly basis: unknown;
        readonly text: string;
      }>;
    }>;
  } | null;
  readonly plan?: {
    readonly partitions: ReadonlyArray<{
      readonly id: string;
      readonly hunkIds: ReadonlyArray<string>;
    }>;
  } | null;
  readonly assembled?: ReadonlyArray<{
    readonly citations?: Record<string, unknown>;
  }>;
  /** Investigate's ledgers, read here only to resolve a cited entry to its lines. */
  readonly ledgers?: ReadonlyArray<{
    readonly partition: { readonly id: string };
    readonly entries: ReadonlyArray<{
      readonly id: string;
      readonly source: unknown;
    }>;
    readonly lookAlikes?: ReadonlyArray<{
      readonly id: string;
      readonly source: unknown;
    }>;
  }>;
  readonly measurement?: Record<string, unknown>;
}

// What the eval reads, and the guard every reader of a stored run goes through

/**
 * The record kinds the readers here are written for, as `review show --json` names each event's
 * `kind`. The producer's own lists are in `records-core/src/published-packets.ts`; a kind it passes
 * through that is not here has no reader in the eval, and a run holding one is refused, never read
 * as units that own no lines or were never assessed. These are the kinds every reader reads; the
 * readers that also read the sections shape take `SECTIONS_KINDS`.
 */
export const READ_KINDS = {
  /** The packet itself, where `show.json` shows its kind. */
  packet: ["packet.published@1"],
  /** The batch that lists the units. */
  batch: ["batch.recorded@1"],
  /** A unit's owned ranges and title (`ownedLineKeys`, every line measure). */
  unit: ["unit.recorded@2"],
  /** A unit's lane and axes (every lane measure, the identity check). */
  assessment: ["assessment.recorded@2", "assessment.recorded@3"],
  /** Findings a request for changes rests on (`caughtDefect`). */
  comment: ["comment.recorded@2", "comment.carried@1"],
  /** A unit's verdict (`verdictOf`, `caughtDefect`, `approvalCatch`). */
  disposition: ["disposition.recorded@2", "disposition.carried@1"],
  /** Context references, by their provenance (`citedRegions`, `referencesCover`). */
  reference: ["context.referenced@2"],
} as const satisfies Record<string, ReadonlyArray<string>>;

type KindFamily = keyof typeof READ_KINDS;

/**
 * The lane rules every reader recomputes or reads a stored lane by (`harnessRule` in
 * `lanes-eval.ts`): 1, `laneOf` alone; 2, with the public-surface raise. An assessment that
 * declares another has no reader on that path.
 */
export const READ_LANE_RULES: ReadonlyArray<number> = [1, 2];

/**
 * The sections shape (`packet.published@2`, `unit.recorded@3`, `assessment.recorded@4` under lane
 * rule 3, `comment.recorded@3`), which only the readers that read a unit through its owned ranges
 * and its lane take: the lanes eval's rule-3 reader, the desk and replay calls, key transfer and
 * the unit scorers. Every other reader keeps refusing it.
 */
export const SECTIONS_KINDS = {
  packet: [...READ_KINDS.packet, "packet.published@2"],
  batch: READ_KINDS.batch,
  unit: [...READ_KINDS.unit, "unit.recorded@3"],
  assessment: [...READ_KINDS.assessment, "assessment.recorded@4"],
  comment: [...READ_KINDS.comment, "comment.recorded@3"],
  disposition: READ_KINDS.disposition,
  reference: READ_KINDS.reference,
} as const satisfies Record<KindFamily, ReadonlyArray<string>>;

/**
 * The lane rules a sections-shape reader reads: 3, 4 and 5 are per section (`assessment.recorded@4`);
 * 4 places each section on the matrix with kept findings as moves, in the same shape, and 5 is 4 with
 * a Verify-confirmed request for changes moving both axes (decision 14.34).
 */
export const SECTIONS_LANE_RULES: ReadonlyArray<number> = [1, 2, 3, 4, 5];

/**
 * What one path reads: its kinds and lane rules, and whether a record that prints no kind is read
 * as today's (`kindless`). `review show --json` prints every event whole, so a real run's records
 * always carry their kind, and a newer shape always names its newer kinds.
 */
export interface Reads {
  readonly name: "today" | "stored" | "sections";
  readonly kinds: Readonly<Record<KindFamily, ReadonlyArray<string>>>;
  readonly laneRules: ReadonlyArray<number>;
  readonly kindless: boolean;
}

/** The lanes eval's own reads of today's shapes: a record with no kind cannot be told from a newer one. */
export const READS_TODAY: Reads = {
  name: "today",
  kinds: READ_KINDS,
  laneRules: READ_LANE_RULES,
  kindless: false,
};

/**
 * What every other reader of a stored run's units reads when it names nothing (`packetUnits`,
 * `packetBatches` and the measures over them): today's kinds, with a record that prints no kind
 * read as today's, as those readers always have. Any kind it does not know is refused.
 */
export const READS_STORED: Reads = {
  name: "stored",
  kinds: READ_KINDS,
  laneRules: READ_LANE_RULES,
  kindless: true,
};

/** The lanes eval's reads that also read the sections shape (lane rule 3). */
export const READS_SECTIONS: Reads = {
  name: "sections",
  kinds: SECTIONS_KINDS,
  laneRules: SECTIONS_LANE_RULES,
  kindless: false,
};

/**
 * The parts of a packet that `packet.undecoded` may name and still leave every unit and assessment
 * read: a batch's assembled batch or digest, a unit's Dispose output or one of its delivery stops.
 * Any other part (the manifest, which lists every unit, or a unit's or assessment's own record)
 * leaves units unread, so it is refused.
 */
const UNDECODED_READ_ANYWAY: ReadonlyArray<string> = [
  "assembled-batch",
  "batch-digest",
  "dispose",
  "facts",
  "briefed",
  "explained",
  "guided",
];

/**
 * The same for a packet of the sections shape, which the records read model may also name `gap`
 * (a gap the manifest names and Records does not hold), leaving every unit read. `facts` there is
 * still a unit's Facts delivery stop; a section's own data that does not decode is named
 * `unit-sections` (its blob) or `judgements` (whole or one section's), and those are refused.
 */
const UNDECODED_READ_ANYWAY_SECTIONS: ReadonlyArray<string> = [
  ...UNDECODED_READ_ANYWAY,
  "gap",
];

const LANE_NAMES: ReadonlyArray<string> = [
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
];

/** A stored run the eval cannot read without misreading it; it stops the command. */
export class UnreadableRun extends Error {
  override readonly name = "UnreadableRun";
}

const kindOf = (event: unknown): string | undefined => {
  const kind = (event as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === "string" ? kind : undefined;
};

/**
 * Owned ranges as line keys: `<path>:<side>:<line>` for each line of a lines range, then
 * `<path>:<side>:whole` for each whole non-text range. The one keying of owned lines: a unit's
 * (`ownedLineKeys`) and a section's alike.
 */
export const rangeLineKeys = (
  ranges: ReadonlyArray<OwnedRangeLite> | undefined,
): Set<string> => {
  const keys = new Set<string>();
  for (const range of ranges ?? [])
    if (
      range.kind === "lines" &&
      range.startLine !== undefined &&
      range.endLine !== undefined
    )
      for (let line = range.startLine; line <= range.endLine; line++)
        keys.add(`${range.path}:${range.side}:${line}`);
  for (const range of ranges ?? [])
    if (range.kind === "whole-nontext")
      keys.add(`${range.path}:${range.side}:whole`);
  return keys;
};

/** A section of a sections-shape unit, as `review show --json` prints it (`records-show-shape.md`). */
export interface SectionLite {
  readonly key: string;
  readonly title?: string;
  readonly ownedRanges: ReadonlyArray<OwnedRangeLite>;
  readonly facts?: unknown;
  readonly assess: {
    readonly gaps?: ReadonlyArray<{ readonly axis?: string }>;
  } | null;
  readonly lane: {
    readonly judged: Lane | null;
    readonly surfaced: Lane | null;
    readonly floors: ReadonlyArray<{
      readonly rule: string;
      readonly to: Lane;
    }>;
    readonly applied: Lane;
  };
  readonly undecided?: { readonly cause: string; readonly reading?: string };
  /**
   * A file no reading reads (a lockfile or a declared-generated file, as the readers lane names
   * them; an open set here): no assessment, no cause, human-suggested by the rule.
   */
  readonly excluded?: { readonly reason: string };
  /** What the floors read, so `floorsOf(facts, options)` runs again from the entry. */
  readonly floorInputs?: { readonly facts: unknown; readonly options: unknown };
}

/**
 * The one authority for the sections shape: a packet whose units carry `unit.recorded@3` or
 * `assessment.recorded@4`. The guard refuses such records under any packet kind but
 * `packet.published@2`, so where a run reads at all, its packet's kind and this agree
 * (`shapeOf` in `lanes-eval.ts` reads this).
 */
export const isSectionsShape = (packet: PacketLite | null | undefined) =>
  packet !== null &&
  packet !== undefined &&
  (packet.batches ?? []).some((batch) =>
    (batch.units ?? []).some(
      (unit) =>
        kindOf(unit.recorded) === "unit.recorded@3" ||
        kindOf(unit.assessment) === "assessment.recorded@4",
    ),
  );

const TRAIL_LANES = (value: unknown) =>
  typeof value === "string" && LANE_NAMES.includes(value);

/**
 * A rule-3 unit's own record against itself: every section owns lines and carries a lane trail,
 * every section's applied lane is the unit's lane, the unit's owned lines are exactly its
 * sections' lines with none in two sections, and the unit's not-decided counts and section count
 * are its sections'. What it holds is reported, never fixed up.
 */
const sectionProblems = (unit: PacketUnitLite, name: string): Array<string> => {
  const problems: Array<string> = [];
  const payload = (unit.assessment as { payload?: unknown } | undefined)
    ?.payload as
    | {
        readonly lane?: unknown;
        readonly sections?: {
          readonly count?: unknown;
          readonly raised?: unknown;
          readonly undecided?: unknown;
        };
      }
    | undefined;
  const sections = (unit as { sections?: unknown }).sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    problems.push(
      `${name} has no sections, so its lane rule 3 assessment has nothing to be read by`,
    );
    return problems;
  }
  const owners = new Map<string, string>();
  const causes = new Map<string, number>();
  const keys = new Set<string>();
  let raised = 0;
  for (const [index, raw] of sections.entries()) {
    const section = raw as Partial<SectionLite> | null;
    const key =
      typeof section?.key === "string" ? section.key : `#${index + 1}`;
    const at = `${name}'s section ${key}`;
    const lane = section?.lane;
    const isLane = TRAIL_LANES;
    if (typeof section?.key === "string") {
      if (keys.has(section.key))
        problems.push(`${at} is listed twice in the unit`);
      keys.add(section.key);
    }
    if (
      typeof section?.key !== "string" ||
      lane === undefined ||
      lane === null ||
      !isLane(lane.applied) ||
      !Array.isArray(lane.floors) ||
      !(lane.judged === null || isLane(lane.judged)) ||
      !(lane.surfaced === null || isLane(lane.surfaced))
    ) {
      problems.push(
        `${at} holds no key or no lane trail (judged, surfaced, floors, applied) the eval can read`,
      );
      continue;
    }
    if (lane.applied !== payload?.lane)
      problems.push(
        `${at} applied ${lane.applied}, but the unit's lane is ${String(payload?.lane)}`,
      );
    // A section may own no line (a mode-only change): its lines, none, still join the unit's.
    if (!Array.isArray(section.ownedRanges))
      problems.push(`${at} holds no owned ranges`);
    for (const line of rangeLineKeys(section.ownedRanges)) {
      const other = owners.get(line);
      if (other !== undefined)
        problems.push(`${at} owns ${line}, which section ${other} owns too`);
      owners.set(line, key);
    }
    // Raised as the publisher counts it (`publish-sections.ts`, the assessment's `sections.raised`): a
    // judged section applied at another lane, whether a floor raised it or it was left undecided after
    // its assessment (applied human-required with no floor). A floor that leaves the lane as judged
    // raises nothing.
    if (lane.judged !== null && lane.judged !== lane.applied) raised++;
    // Three kinds of entry, as the harness writes them: assessed (an assessment, maybe undecided
    // after it), undecided with no assessment, or an excluded file with neither.
    const undecided =
      section.undecided !== undefined && section.undecided !== null;
    const excluded =
      section.excluded !== undefined && section.excluded !== null;
    const assessed = section.assess !== null && section.assess !== undefined;
    if (undecided) {
      const cause = section.undecided!.cause;
      if (typeof cause !== "string" || cause === "")
        problems.push(`${at} is undecided with no cause`);
      else causes.set(cause, (causes.get(cause) ?? 0) + 1);
    }
    if (excluded) {
      const reason = (section.excluded as { reason?: unknown }).reason;
      if (typeof reason !== "string" || reason === "")
        problems.push(`${at} is excluded with no reason`);
      if (undecided || assessed)
        problems.push(
          `${at} is excluded but also ${undecided ? "undecided" : "assessed"}, which the harness never writes`,
        );
    }
    if (!undecided && !excluded && !assessed)
      problems.push(
        `${at} holds no assessment, no cause it was not decided and no reason it was excluded, so nothing stands behind its lane`,
      );
  }
  const unitLines = rangeLineKeys(unit.recorded?.payload.ownedRanges);
  const onlyUnit = [...unitLines].filter((line) => !owners.has(line));
  const onlySections = [...owners.keys()].filter(
    (line) => !unitLines.has(line),
  );
  if (onlyUnit.length > 0 || onlySections.length > 0)
    problems.push(
      `${name}'s owned lines are not its sections' lines (${onlyUnit.length} only the unit owns${onlyUnit.length === 0 ? "" : `, first ${onlyUnit[0]}`}; ${onlySections.length} only its sections own${onlySections.length === 0 ? "" : `, first ${onlySections[0]}`})`,
    );
  if (payload !== undefined) {
    const counts = payload.sections;
    if (counts === undefined || counts === null || typeof counts !== "object")
      problems.push(`${name}'s assessment holds no section counts`);
    else {
      if (counts.count !== sections.length)
        problems.push(
          `${name}'s assessment counts ${String(counts.count)} section(s), but it holds ${sections.length}`,
        );
      if (counts.raised !== raised)
        problems.push(
          `${name}'s assessment counts ${String(counts.raised)} section(s) raised, but ${raised} of its sections apply a lane other than the one judged`,
        );
      const stated = new Map<string, number>(
        Object.entries(
          (counts.undecided ?? {}) as Readonly<Record<string, unknown>>,
        ).flatMap(([cause, n]) =>
          typeof n === "number" && n > 0 ? [[cause, n] as const] : [],
        ),
      );
      const differs = [...new Set([...stated.keys(), ...causes.keys()])]
        .sort()
        .filter(
          (cause) => (stated.get(cause) ?? 0) !== (causes.get(cause) ?? 0),
        );
      if (differs.length > 0)
        problems.push(
          `${name}'s assessment counts ${differs.map((cause) => `${stated.get(cause) ?? 0} ${cause}`).join(", ")} section(s) not decided, but its sections hold ${differs.map((cause) => `${causes.get(cause) ?? 0} ${cause}`).join(", ")}`,
        );
    }
  }
  return problems;
};

/**
 * A sections-shape packet against its units: no line owned by two units, and where `show.json`
 * prints them, `counts.sections` and `counts.undecided` are the units' totals.
 */
const packetSectionProblems = (packet: PacketLite): Array<string> => {
  const problems: Array<string> = [];
  const owner = new Map<string, string>();
  let sections = 0;
  const causes = new Map<string, number>();
  const listed = new Set<string>();
  for (const batch of packet.batches ?? [])
    for (const unit of batch.units ?? []) {
      if (listed.has(unit.unitId))
        problems.push(`unit ${unit.unitId} is listed twice in the packet`);
      listed.add(unit.unitId);
      for (const line of rangeLineKeys(unit.recorded?.payload?.ownedRanges)) {
        const other = owner.get(line);
        if (other !== undefined && other !== unit.unitId)
          problems.push(
            `unit ${unit.unitId} owns ${line}, which unit ${other} owns too`,
          );
        owner.set(line, unit.unitId);
      }
      const held = (unit as { sections?: unknown }).sections;
      if (kindOf(unit.recorded) !== "unit.recorded@3" || !Array.isArray(held))
        continue;
      sections += held.length;
      for (const section of held as ReadonlyArray<Partial<SectionLite>>) {
        const cause = section?.undecided?.cause;
        if (typeof cause === "string")
          causes.set(cause, (causes.get(cause) ?? 0) + 1);
      }
    }
  const counts = (packet as { counts?: unknown }).counts as
    { readonly sections?: unknown; readonly undecided?: unknown } | undefined;
  if (typeof counts?.sections === "number" && counts.sections !== sections)
    problems.push(
      `the packet counts ${counts.sections} section(s), but its units hold ${sections}`,
    );
  if (
    counts?.undecided !== undefined &&
    counts.undecided !== null &&
    typeof counts.undecided === "object"
  ) {
    const stated = Object.entries(
      counts.undecided as Readonly<Record<string, unknown>>,
    ).filter(([, n]) => typeof n === "number" && n > 0);
    const off = [
      ...new Set([...stated.map(([cause]) => cause), ...causes.keys()]),
    ]
      .sort()
      .filter(
        (cause) =>
          (stated.find(([c]) => c === cause)?.[1] ?? 0) !==
          (causes.get(cause) ?? 0),
      );
    if (off.length > 0)
      problems.push(
        `the packet counts ${off.map((cause) => `${String(stated.find(([c]) => c === cause)?.[1] ?? 0)} ${cause}`).join(", ")} section(s) not decided, but its units hold ${off.map((cause) => `${causes.get(cause) ?? 0} ${cause}`).join(", ")}`,
      );
  }
  return problems;
};

/**
 * Every reason a stored run's packet cannot be read as one path reads it (`reads`), each a plain
 * sentence naming the unit and the kind. Empty for a packet of today's shapes, a unit with no
 * assessment included: that unit is unassessed and every measure counts it apart.
 */
export const unreadableParts = (
  packet: PacketLite | null | undefined,
  reads: Reads = READS_TODAY,
): Array<string> => {
  if (packet === undefined || packet === null) return [];
  const problems: Array<string> = [];
  const known = (
    what: KindFamily,
    kind: string | undefined,
    of: string,
    then: string,
  ) => {
    if (kind !== undefined && reads.kinds[what].includes(kind)) return;
    if (kind === undefined && reads.kindless) return;
    problems.push(
      `${of} is ${kind ?? "a record with no kind"}, which the eval has no reader for${reads.name === "sections" ? "" : " here"} (it reads ${reads.kinds[what].join(", ")}); ${then}`,
    );
  };
  const shown = packet as PacketLite & {
    readonly kind?: unknown;
    readonly recorded?: unknown;
    readonly undecoded?: ReadonlyArray<{
      readonly part?: unknown;
      readonly what?: unknown;
      readonly unit?: unknown;
      readonly batch?: unknown;
      readonly section?: unknown;
    }>;
  };
  for (const kind of [shown.kind, kindOf(shown.recorded)])
    if (typeof kind === "string")
      known(
        "packet",
        kind,
        "the packet",
        "its batches may hold units of another shape",
      );
  const sectionsShape = isSectionsShape(packet);
  if (sectionsShape && shown.kind !== "packet.published@2")
    problems.push(
      `the packet holds units of the sections shape (unit.recorded@3 or assessment.recorded@4) but ${typeof shown.kind === "string" ? `is ${shown.kind}` : "prints no kind"}, not packet.published@2`,
    );
  if (sectionsShape && reads.name === "sections")
    problems.push(...packetSectionProblems(packet));
  // A `packet.published@2` with no units yet still takes the sections shape's list.
  const readAnyway =
    reads.name === "sections" &&
    (sectionsShape || shown.kind === "packet.published@2")
      ? UNDECODED_READ_ANYWAY_SECTIONS
      : UNDECODED_READ_ANYWAY;
  for (const entry of shown.undecoded ?? [])
    if (!readAnyway.includes(String(entry.part)))
      problems.push(
        `the packet could not decode ${typeof entry.what === "string" ? entry.what : "a part"} (${String(entry.part)}${typeof entry.unit === "string" ? `, unit ${entry.unit}` : typeof entry.batch === "string" ? `, batch ${entry.batch}` : ""}${typeof entry.section === "string" ? `, section ${entry.section}` : ""}), so the units it holds would be missing or unread`,
      );
  for (const batch of packet.batches ?? []) {
    const recorded = (batch as { recorded?: unknown }).recorded;
    if (recorded !== undefined && recorded !== null)
      known(
        "batch",
        kindOf(recorded),
        `batch ${batch.batchId}`,
        "its units may be of another shape",
      );
    for (const unit of batch.units ?? []) {
      const name = `unit ${unit.unitId}${unit.local === undefined ? "" : ` (${unit.local})`}`;
      if (unit.recorded === undefined || unit.recorded === null)
        problems.push(
          `${name} has no unit record, so it would own no lines and leave every line measure`,
        );
      else {
        known(
          "unit",
          kindOf(unit.recorded),
          `${name}'s record`,
          "its lines would leave every line measure",
        );
        if (!Array.isArray(unit.recorded.payload?.ownedRanges))
          problems.push(
            `${name}'s record holds no owned ranges, so it would own no lines and leave every line measure`,
          );
      }
      const assessment = unit.assessment as
        (AssessmentLite & { readonly kind?: unknown }) | undefined | null;
      if (assessment !== undefined && assessment !== null) {
        const kind = kindOf(assessment);
        known(
          "assessment",
          kind,
          `${name}'s assessment`,
          "it would read as unassessed and never be judged",
        );
        const payload = assessment.payload as
          { readonly lane?: unknown; readonly laneRule?: unknown } | undefined;
        if (
          payload?.laneRule !== undefined &&
          !reads.laneRules.includes(payload.laneRule as number)
        )
          problems.push(
            `${name}'s assessment declares lane rule ${String(payload.laneRule)}, which the eval has no reader for${reads.name === "sections" ? "" : " here"} (it reads rules ${reads.laneRules.join(", ")})`,
          );
        // A record that prints no kind, read as today's where the path allows it, keeps its lane
        // as those readers read it (none, when it holds none).
        if (
          !(reads.kindless && kind === undefined) &&
          (typeof payload?.lane !== "string" ||
            !LANE_NAMES.includes(payload.lane))
        )
          problems.push(
            `${name}'s assessment holds no lane the eval knows, so it would read as unassessed`,
          );
        // Lane rules 3, 4 and 5 are read per section, from an `assessment.recorded@4` only.
        if (reads.kinds.assessment.includes("assessment.recorded@4")) {
          const v4 = kind === "assessment.recorded@4";
          const perSection =
            typeof payload?.laneRule === "number" && payload.laneRule >= 3;
          if (v4 !== perSection)
            problems.push(
              v4
                ? `${name}'s assessment is assessment.recorded@4 but declares lane rule ${String(payload?.laneRule)}, not 3, 4 or 5`
                : `${name}'s assessment declares lane rule ${String(payload?.laneRule)} but is ${kind ?? "a record with no kind"}, which holds no sections to read it by`,
            );
          if (v4) problems.push(...sectionProblems(unit, name));
        }
      } else if (
        kindOf(unit.recorded) === "unit.recorded@3" &&
        Array.isArray((unit as { sections?: unknown }).sections)
      ) {
        // An unassessed unit of the sections shape still owns exactly its sections' lines.
        const owned = rangeLineKeys(unit.recorded?.payload.ownedRanges);
        const held = new Set(
          (
            unit as unknown as {
              sections: ReadonlyArray<Partial<SectionLite>>;
            }
          ).sections.flatMap((section) => [
            ...rangeLineKeys(section.ownedRanges),
          ]),
        );
        if (
          owned.size !== held.size ||
          [...owned].some((line) => !held.has(line))
        )
          problems.push(`${name}'s owned lines are not its sections' lines`);
      }
      for (const comment of unit.comments ?? [])
        known(
          "comment",
          kindOf(comment),
          `${name}'s comment ${comment.id}`,
          "a request for changes resting on it could not be read",
        );
      if (unit.disposition !== undefined && unit.disposition !== null)
        known(
          "disposition",
          kindOf(unit.disposition),
          `${name}'s disposition`,
          "its verdict could not be read",
        );
      for (const reference of unit.references ?? [])
        known(
          "reference",
          kindOf(reference),
          `${name}'s reference ${reference.id}`,
          "a finding citing it could not be placed",
        );
    }
  }
  return problems;
};

/** Packets already found readable, by what they were read as: the same packet is checked once. */
const readable = new WeakMap<object, Set<Reads["name"]>>();

/**
 * The guard: refuses a stored run's packet the path cannot read (`reads`, today's kinds unless the
 * path also reads the sections shape), naming where it was read (the case or file), the unit and
 * the kind. Returns the packet, so a reader reads what it checked.
 */
export const readablePacket = <P extends PacketLite | null | undefined>(
  packet: P,
  where: string,
  reads: Reads = READS_TODAY,
): P => {
  if (packet === null || packet === undefined || typeof packet !== "object")
    return packet;
  if (readable.get(packet)?.has(reads.name) === true) return packet;
  const problems = unreadableParts(packet, reads);
  if (problems.length > 0)
    throw new UnreadableRun(
      `${where} cannot be read by the eval: ${problems[0]}${problems.length === 1 ? "" : ` (and ${problems.length - 1} more)`}.`,
    );
  const seen = readable.get(packet) ?? new Set<Reads["name"]>();
  seen.add(reads.name);
  readable.set(packet, seen);
  return packet;
};

/** The guard over a whole `review show --json` output; returns it. */
export const readableRun = <S>(
  shown: S,
  where: string,
  reads: Reads = READS_TODAY,
): S => {
  readablePacket(
    (shown as { readonly packet?: PacketLite | null } | null)?.packet,
    where,
    reads,
  );
  return shown;
};

/** A stored `show.json` (or any file holding `review show --json`), read and put through the guard. */
export const readShownFile = <S = StoredRun>(
  path: string,
  where = path,
  reads: Reads = READS_TODAY,
): S => readableRun(JSON.parse(readFileSync(path, "utf8")) as S, where, reads);

/** Where a reader read a packet and what it reads it as; unnamed, a stored run of today's shapes. */
export interface ReadAs {
  readonly where?: string | undefined;
  readonly reads?: Reads | undefined;
}

/** A packet's batches, through the guard: the one way a reader reaches them. */
export const packetBatches = (
  packet: PacketLite | null | undefined,
  as: ReadAs = {},
): PacketLite["batches"] =>
  readablePacket(packet, as.where ?? "a stored run", as.reads ?? READS_STORED)
    ?.batches ?? [];

/** Every unit of a packet with its batch, through the guard. */
const units = (packet: PacketLite | null | undefined, as: ReadAs = {}) =>
  packetBatches(packet, as).flatMap((batch) =>
    batch.units.map((unit) => ({ batchId: batch.batchId, unit })),
  );

// Hunks and units

/** A harness hunk's changed lines: its new side where it adds lines, else its old side. */
export const changedLines = (hunk: ManifestHunkFull): SidedRange | null => {
  if (hunk.kind !== "text") return null;
  if (hunk.newLines > 0 && hunk.newPath !== null)
    return {
      path: hunk.newPath,
      side: "new",
      startLine: hunk.newStart,
      endLine: hunk.newStart + hunk.newLines - 1,
    };
  if (hunk.oldLines > 0 && hunk.oldPath !== null)
    return {
      path: hunk.oldPath,
      side: "old",
      startLine: hunk.oldStart,
      endLine: hunk.oldStart + hunk.oldLines - 1,
    };
  return null;
};

const overlap = (a: SidedRange, b: SidedRange) =>
  a.path === b.path && a.side === b.side
    ? Math.max(
        0,
        Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1,
      )
    : 0;

const ownedLines = (unit: PacketUnitLite): Array<SidedRange> =>
  (unit.recorded?.payload.ownedRanges ?? []).flatMap((range) =>
    range.kind === "lines" &&
    range.startLine !== undefined &&
    range.endLine !== undefined
      ? [
          {
            path: range.path,
            side: range.side,
            startLine: range.startLine,
            endLine: range.endLine,
          },
        ]
      : [],
  );

/** A unit's owned changed lines as `path:side:line` keys, for unit-level Jaccard matching. */
export const ownedLineKeys = (unit: PacketUnitLite) =>
  rangeLineKeys(unit.recorded?.payload.ownedRanges);

/** The verdict category FT11 compares: a disposition, or the suggested review on human-required work. */
export const verdictOf = (unit: PacketUnitLite): string | null => {
  const lane = unit.assessment?.payload.lane ?? null;
  if (lane === "static-automation") return "static";
  if (lane === "human-required") {
    const suggested = unit.content.guided?.suggestion?.verdict;
    return suggested === undefined ? null : `suggested-${suggested}`;
  }
  return unit.disposition?.payload.verdict ?? null;
};

export interface HunkView {
  readonly hunkId: string;
  readonly unitId: string | null;
  /** The units owning some of the hunk's changed lines (a split hunk has more than one). */
  readonly owners: number;
  readonly assessed: boolean;
  readonly lane: Lane | null;
  readonly complexity: "low" | "high" | null;
  readonly ease: "easy" | "hard" | null;
  readonly verdict: string | null;
}

/**
 * Each text harness hunk with the unit that owns most of its changed lines, and that unit's lane,
 * axis levels and verdict. A hunk no unit owns, or whose unit was never assessed (after a timeout),
 * says so and is counted apart by the agreement measures.
 */
export const hunkViews = (run: StoredRun): Array<HunkView> => {
  const all = units(run.packet);
  return (run.manifest?.hunks ?? []).flatMap((hunk) => {
    const lines = changedLines(hunk);
    if (lines === null) return [];
    let best: { unit: PacketUnitLite; shared: number } | undefined;
    let owners = 0;
    for (const { unit } of all) {
      const shared = ownedLines(unit).reduce(
        (sum, range) => sum + overlap(range, lines),
        0,
      );
      if (shared === 0) continue;
      owners++;
      if (best === undefined || shared > best.shared) best = { unit, shared };
    }
    const unit = best?.unit;
    const assessment = unit?.assessment?.payload;
    return [
      {
        hunkId: hunk.hunkId,
        unitId: unit?.unitId ?? null,
        owners,
        assessed: assessment !== undefined,
        lane: assessment?.lane ?? null,
        complexity: assessment?.complexity.level ?? null,
        ease: assessment?.easeOfValidation.level ?? null,
        verdict: unit === undefined ? null : verdictOf(unit),
      },
    ];
  });
};

// Rule checks (FT10, FT11)

export interface Violation {
  readonly rule: string;
  readonly unitId: string;
  readonly detail: string;
}

const citedBoth = (a: AssessmentLite["payload"]) =>
  a.complexity.factors.some((factor) => factor.cites.length > 0) &&
  a.easeOfValidation.requirements.some((r) => r.cites.length > 0);

/** 10.55's case: cited evidence of high complexity beside a gap on ease of validation. */
export const inCase1055 = (a: AssessmentLite["payload"]) =>
  a.complexity.level === "high" &&
  a.complexity.factors.some((factor) => factor.cites.length > 0) &&
  a.gaps.some((gap) => gap.axis === "ease-of-validation");

export const laneChecks = (run: StoredRun) => {
  const violations: Array<Violation> = [];
  let case1055 = 0;
  let staticUnits = 0;
  let assessed = 0;
  for (const { unit } of units(run.packet)) {
    const a = unit.assessment?.payload;
    if (a === undefined) continue;
    assessed++;
    const add = (rule: string, detail: string) =>
      violations.push({ rule, unitId: unit.unitId, detail });
    const pinned = a.quadrant === "high-hard" && citedBoth(a);
    // 10.9: cited evidence on both axes placing it high and hard keeps it human-required.
    if (pinned && a.lane !== "human-required")
      add("10.9", `high-hard on cited evidence, but ${a.lane}`);
    // 4.4: a gap alone never makes a unit human-required; gaps send it to human-suggested.
    if (a.lane === "human-required" && a.quadrant !== "high-hard")
      add("4.4", `human-required from ${a.quadrant}`);
    if (a.gaps.length > 0 && !pinned && a.lane !== "human-suggested")
      add("4.4", `${a.gaps.length} gap(s) but ${a.lane}, not human-suggested`);
    // 10.55: high complexity with a validation gap stays human-suggested, and is counted.
    if (inCase1055(a) && !pinned) {
      case1055++;
      if (a.lane !== "human-suggested")
        add("10.55", `10.55's case, but ${a.lane}`);
    }
    // 10.82: static automation only when low and easy with every requirement solid.
    if (a.lane === "static-automation") {
      staticUnits++;
      const reqs = a.easeOfValidation.requirements;
      if (
        a.quadrant !== "low-easy" ||
        reqs.length === 0 ||
        reqs.some((r) => r.coverage !== "solid" || r.proof.length === 0)
      )
        add(
          "10.82",
          "static automation without every requirement solid on recorded proof",
        );
    }
    // 10.56: every movement signal cited, with its direction.
    for (const signal of a.movement)
      if (signal.cites.length === 0 || signal.direction === undefined)
        add(
          "10.56",
          `movement signal ${signal.signal} uncited or without a direction`,
        );
    // 4.13, 4.14: an agent's verdict never closes human-required work.
    if (
      a.lane === "human-required" &&
      unit.judgement?.closed === true &&
      (unit.judgement.closing ?? []).some((d) => d.actorKind !== "human")
    )
      add("4.13", "human-required unit closed by an agent's disposition");
  }
  return { assessed, case1055, staticUnits, violations };
};

export const dispositionChecks = (run: StoredRun) => {
  const violations: Array<Violation> = [];
  const counts = {
    approvals: 0,
    requests: 0,
    uncitedRequests: 0,
    withheld: 0,
    approvalsWithoutProof: 0,
    suggestions: 0,
  };
  for (const { unit } of units(run.packet)) {
    const add = (rule: string, detail: string) =>
      violations.push({ rule, unitId: unit.unitId, detail });
    const guided = unit.content.guided;
    const rows = guided?.rows ?? [];
    if (guided?.review?.withheld === true) counts.withheld++;
    if (guided?.suggestion !== null && guided?.suggestion !== undefined)
      counts.suggestions++;
    // 10.87: a Guided row's status is scoped to its unit.
    for (const row of rows)
      if (row.scope !== undefined && row.scope !== "this unit")
        add("10.87", `row ${row.row} scoped "${row.scope}"`);
    const verdict = unit.disposition?.payload.verdict;
    if (verdict === "approve") {
      counts.approvals++;
      // 10.86: no approval beside a not-met row.
      for (const row of rows)
        if (row.status === "not-met" && row.required !== false)
          add("10.86", `approval beside not-met row ${row.row}`);
      // 10.83: an approval cites proof or says it is not recorded.
      const proof = unit.disposition?.payload.proof ?? [];
      if (proof.length === 0) {
        counts.approvalsWithoutProof++;
        if (!/proof is not recorded/.test(guided?.proof ?? ""))
          add(
            "10.83",
            "approval cites no proof and does not say it is not recorded",
          );
      }
    }
    if (verdict === "request-changes") {
      counts.requests++;
      const restsOn = unit.disposition?.payload.restsOn ?? [];
      if (restsOn.length === 0) counts.uncitedRequests++;
      // 10.69: a request for changes links its defect comments.
      const defects = new Set(
        unit.comments
          .filter((c) => c.payload.finding?.kind === "defect")
          .map((c) => c.id),
      );
      for (const id of restsOn)
        if (!defects.has(id))
          add(
            "10.69",
            `request rests on ${id}, not a defect comment of the unit`,
          );
    }
  }
  // 10.87: each batch digest's obligation roll-up matches its units' rows.
  for (const batch of packetBatches(run.packet))
    for (const obligation of batch.digest?.obligations ?? []) {
      const expected = rollUp(obligation.units);
      if (expected !== obligation.overall)
        violations.push({
          rule: "10.87",
          unitId: batch.batchId,
          detail: `obligation ${obligation.row} reads ${obligation.overall}; its units give ${expected}`,
        });
    }
  return { counts, violations };
};

/** Publish's roll-up of one obligation across its units (publish.ts), recomputed to check it. */
export const rollUp = (
  rows: ReadonlyArray<{ readonly status: string; readonly required: boolean }>,
) => {
  const required = rows.filter((row) => row.required);
  const met = required.filter((row) => row.status === "met").length;
  if (required.some((row) => row.status === "not-met")) return "not-met";
  if (required.length > 0 && met === required.length) return "met";
  if (met > 0) return `met on ${met} of ${required.length} units`;
  return "no-evidence";
};

// Digests (FT12)

const VERDICT_WORDS =
  /\b(approve[ds]?|approval|lgtm|reject(?:ed|s)?|request(?:ed|s)? changes|ship it|blocker)\b/gi;

export const digestChecks = (run: StoredRun) => {
  const known = new Set(
    (run.assembled ?? []).flatMap((batch) =>
      Object.keys(batch.citations ?? {}),
    ),
  );
  const checkable = known.size > 0;
  let cites = 0;
  let unresolved = 0;
  let verdictWords = 0;
  const lengths = {
    batchDigests: [] as Array<number>,
    facts: [] as Array<number>,
  };
  for (const batch of packetBatches(run.packet)) {
    const text = batch.digest?.digest ?? "";
    lengths.batchDigests.push(text.length);
    verdictWords += (text.match(VERDICT_WORDS) ?? []).length;
    for (const unit of batch.units) {
      const facts = unit.content.facts;
      if (facts === undefined) continue;
      lengths.facts.push(facts.text.length);
      verdictWords += (facts.text.match(VERDICT_WORDS) ?? []).length;
      for (const cite of facts.cites) {
        cites++;
        if (checkable && !known.has(cite)) unresolved++;
      }
    }
  }
  const rollUps = packetBatches(run.packet).flatMap((batch) =>
    (batch.digest?.obligations ?? []).map((o) => rollUp(o.units) === o.overall),
  );
  return {
    citations: cites,
    unresolved: checkable ? unresolved : null,
    verdictWordsFlagged: verdictWords,
    obligationRollUps: rollUps.length,
    obligationRollUpsMatching: rollUps.filter(Boolean).length,
    meanDigestLength:
      lengths.batchDigests.length === 0
        ? null
        : lengths.batchDigests.reduce((a, b) => a + b, 0) /
          lengths.batchDigests.length,
    meanFactsLength:
      lengths.facts.length === 0
        ? null
        : lengths.facts.reduce((a, b) => a + b, 0) / lengths.facts.length,
  };
};

// Proof (FT9)

export const proofCoverage = (run: StoredRun) => {
  const levels = { missing: 0, shallow: 0, solid: 0 };
  let disagreements = 0;
  let stale = 0;
  let staticReached = 0;
  for (const { unit } of units(run.packet)) {
    const a = unit.assessment?.payload;
    for (const r of a?.easeOfValidation.requirements ?? [])
      levels[r.coverage]++;
    if (a?.lane === "static-automation") staticReached++;
    disagreements += (unit.content.guided?.rows ?? []).filter(
      (row) => row.disagreement !== undefined,
    ).length;
    stale += unit.comments.filter(
      (c) => c.payload.finding?.signal === "stale-proof",
    ).length;
  }
  return {
    requirements: levels,
    disagreements,
    staleProofFindings: stale,
    staticReached,
  };
};

// Known cases (FT11)

/** A cited `path:line` or `path:first-last` entry as a range. */
export const parseEntry = (
  entry: string | undefined,
): { path: string; startLine: number; endLine: number } | null => {
  const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(entry ?? "");
  if (match === null) return null;
  const startLine = Number(match[2]);
  return {
    path: match[1]!,
    startLine,
    endLine: match[3] === undefined ? startLine : Number(match[3]),
  };
};

interface Lines {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The side the lines are numbered on, when the citation says (a ledger entry, a reference). */
  readonly side?: "old" | "new";
}

/** A revision's side in the run's range: its base is old, its head new; unknown otherwise. */
const sideOf = (run: StoredRun, revision: string | undefined) => {
  const m = run.measurement as
    { baseOid?: string; headOid?: string } | undefined;
  if (revision === undefined || m === undefined) return undefined;
  if (revision === m.headOid || revision === "head") return "new" as const;
  if (revision === m.baseOid || revision === "base") return "old" as const;
  return undefined;
};

/**
 * Whether a region lies on a defect's lines: the same path and overlapping lines, on the same side;
 * in a file the range does not change, the two sides number alike, so either side counts.
 */
const onDefect = (
  run: StoredRun,
  defect: SidedRange,
  region: Lines & { readonly side?: "old" | "new" },
) => {
  if (region.path !== defect.path) return false;
  if (region.startLine > defect.endLine || defect.startLine > region.endLine)
    return false;
  if (region.side === undefined || region.side === defect.side) return true;
  const changed = (run.manifest?.hunks ?? []).some(
    (hunk) => hunk.newPath === defect.path || hunk.oldPath === defect.path,
  );
  return !changed;
};

/**
 * The lines a finding's citation points at: a `path:lines` entry; a context reference
 * (`event:<id>`), by its provenance; or a ledger entry (`computation:<ledger key>` with entry
 * `e<n>`), through Assemble's citation index, which names each ledger entry's partition.
 */
export const citedRegions = (
  run: StoredRun,
  cite: { readonly ref: string; readonly entry?: string },
  reads: Reads = READS_STORED,
): Array<Lines> => {
  const direct = parseEntry(cite.entry);
  if (direct !== null) return [direct];
  if (cite.ref.startsWith("event:")) {
    const id = cite.ref.slice("event:".length);
    for (const { unit } of units(run.packet, { reads }))
      for (const reference of unit.references) {
        if (reference.id !== id) continue;
        const p = reference.payload.provenance as {
          kind: string;
          revision?: string;
          path?: string;
          startLine?: number;
          endLine?: number;
        };
        const side = sideOf(run, p.revision);
        return p.kind === "git" &&
          p.path !== undefined &&
          p.startLine !== undefined
          ? [
              {
                path: p.path,
                startLine: p.startLine,
                endLine: p.endLine ?? p.startLine,
                ...(side === undefined ? {} : { side }),
              },
            ]
          : [];
      }
    return [];
  }
  const entry = cite.entry;
  if (cite.ref.startsWith("computation:") && entry !== undefined) {
    const partitions = new Set<string>();
    for (const batch of run.assembled ?? [])
      for (const [qualified, target] of Object.entries(batch.citations ?? {})) {
        const t = target as {
          kind?: string;
          ref?: string | null;
          entry?: string | null;
        };
        if (
          t.kind === "ledger-entry" &&
          t.ref === cite.ref &&
          t.entry === entry &&
          qualified.endsWith(`.${entry}`)
        )
          partitions.add(
            qualified.slice(0, qualified.length - entry.length - 1),
          );
      }
    return (run.ledgers ?? [])
      .filter((ledger) => partitions.has(ledger.partition.id))
      .flatMap((ledger) =>
        [...ledger.entries, ...(ledger.lookAlikes ?? [])]
          .filter((held) => held.id === entry)
          .flatMap((held) => {
            const source = held.source as {
              origin: string;
              rev?: string;
              revision?: string;
              path?: string;
              startLine?: number;
              endLine?: number;
            };
            const side = sideOf(run, source.rev ?? source.revision);
            return source.origin === "scope" ||
              source.path === undefined ||
              source.startLine === undefined
              ? []
              : [
                  {
                    path: source.path,
                    startLine: source.startLine,
                    endLine: source.endLine ?? source.startLine,
                    ...(side === undefined ? {} : { side }),
                  },
                ];
          }),
      );
  }
  return [];
};

/**
 * Whether Dispose caught a known defect: a request for changes on some unit resting on a defect
 * comment whose anchor overlaps the defect's lines, or whose evidence points at them (a cited
 * range, a context reference or a ledger entry).
 */
export const caughtDefect = (
  run: StoredRun,
  defect: ReadonlyArray<SidedRange>,
  reads: Reads = READS_STORED,
) => {
  const hits: Array<{
    unitId: string;
    comment: string;
    how: "anchor" | "evidence";
  }> = [];
  for (const { unit } of units(run.packet, { reads })) {
    if (unit.disposition?.payload.verdict !== "request-changes") continue;
    const restsOn = new Set(unit.disposition.payload.restsOn);
    for (const comment of unit.comments) {
      if (
        !restsOn.has(comment.id) ||
        comment.payload.finding?.kind !== "defect"
      )
        continue;
      const anchor = comment.payload.anchor;
      if (
        anchor !== undefined &&
        defect.some((range) => onDefect(run, range, anchor))
      ) {
        hits.push({ unitId: unit.unitId, comment: comment.id, how: "anchor" });
        continue;
      }
      const named = comment.payload.finding.evidence.some((cite) =>
        citedRegions(run, cite, reads).some((region) =>
          defect.some((range) => onDefect(run, range, region)),
        ),
      );
      if (named)
        hits.push({
          unitId: unit.unitId,
          comment: comment.id,
          how: "evidence",
        });
    }
  }
  // The defect also surfaced only as a risk or question: what 10.86 was found on.
  const mentioned = units(run.packet, { reads }).some(({ unit }) =>
    unit.comments.some(
      (c) =>
        c.payload.anchor !== undefined &&
        defect.some((range) => onDefect(run, range, c.payload.anchor!)),
    ),
  );
  return {
    caught: hits.length > 0,
    hits,
    mentionedWithoutRequest: hits.length === 0 && mentioned,
  };
};

/**
 * The catch for a range whose recorded proof shows a requirement not met (proof range C): caught
 * when every unit owning the defect's lines received a verdict (a disposition, or the suggested
 * review on human-required work) and none of them approves, a suggested approval and a closure by
 * static automation included. A unit
 * never disposed is not a catch. Whether a request for changes cited the failure is reported beside.
 */
export const approvalCatch = (
  run: StoredRun,
  defect: ReadonlyArray<SidedRange>,
) => {
  const owning = units(run.packet).filter(({ unit }) =>
    ownedLines(unit).some((range) => defect.some((d) => overlap(range, d) > 0)),
  );
  const verdicts = owning.map(({ unit }) => ({
    unitId: unit.unitId,
    verdict: verdictOf(unit),
  }));
  const undecided = verdicts.filter((entry) => entry.verdict === null);
  // Static automation closes a unit without review; 10.82 rules it out beside a requirement the
  // recorded proof shows not met, so it counts as an approval here.
  const approved = verdicts.filter(
    (entry) =>
      entry.verdict === "approve" ||
      entry.verdict === "suggested-approve" ||
      entry.verdict === "static",
  );
  const cited = caughtDefect(run, defect);
  return {
    caught:
      owning.length > 0 && undecided.length === 0 && approved.length === 0,
    owningUnits: owning.length,
    undecidedUnits: undecided.map((entry) => entry.unitId),
    approvedUnits: approved.map((entry) => entry.unitId),
    requestCitesFailure: cited.caught,
    hits: cited.hits,
    mentionedWithoutRequest: cited.mentionedWithoutRequest,
  };
};

/** Whether any context reference covered the defect's lines: the pure omission path needs none to. */
export const referencesCover = (
  run: StoredRun,
  defect: ReadonlyArray<SidedRange>,
) =>
  units(run.packet).some(({ unit }) =>
    unit.references.some((reference) => {
      const p = reference.payload.provenance;
      if (p.kind !== "git") return false;
      const git = p as { path: string; startLine?: number; endLine?: number };
      return defect.some(
        (range) =>
          range.path === git.path &&
          (git.startLine ?? 1) <= range.endLine &&
          range.startLine <= (git.endLine ?? Number.MAX_SAFE_INTEGER),
      );
    }),
  );

/**
 * Every unit of a run with its batch, for the sheet, the agreement views and every measure, through
 * the guard: today's kinds, unless the path says it also reads the sections shape (`READS_SECTIONS`).
 */
export const packetUnits = units;
