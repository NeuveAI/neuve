import { Clock, Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  Dispositions,
  Lineage,
  Log,
  Proofs,
  PublishedPackets,
  canonicalJson,
  sha256Hex,
} from "@neuve/records-core";
import {
  GapKind,
  PAYLOAD_MAX_BYTES,
  UNDECIDED_GAP_PREFIX,
  type AssembledUnit,
  type OwnedRange,
  type RecordEvent,
} from "@neuve/records-schema";
import { verdictWordsIn } from "./compose.ts";
import { publishedConfig } from "./config.ts";
import {
  PublishClockRefused,
  clipText,
  deliveryContent,
  eventHash,
  keyedIds,
  referenceEvent,
  stableUlid,
  unpublishedReason,
  type PublishContext,
} from "./publish.ts";
import {
  SECTION_LANE_RULE,
  SettledInput,
  TITLE_MAX,
  batchHandle,
  batchKeyOf,
  boundTitle,
  checkBatch,
  cleanComment,
  codeTitles,
  rangeCounts,
  short,
  unitHandle,
  unitKeyOf,
  unitSections,
  type Refusal,
  type SettledBatch,
  type SettledSection,
  type SettledUnit,
  type WithheldReason,
} from "./publish-sections-input.ts";
import {
  compareUnits,
  earlierUnits,
  gitIsAncestor,
  packetManifest,
  type EarlierUnit,
  type LineageFrom,
  type NewUnit,
} from "./publish-sections-lineage.ts";
import {
  harnessActor,
  harnessRegistration,
  appendTelemetry,
} from "./receipt.ts";

export {
  SettledBatch,
  SettledComment,
  SettledInput,
  SettledSection,
  SettledUnit,
  SECTION_LANE_RULE,
  batchKeyOf,
} from "./publish-sections-input.ts";

/**
 * The new publisher (records design, sections 1, 2, 6, 7; `records-publisher-contract.md`): it
 * publishes settled batches of a new-shape review as one chain of cumulative `packet.published@2`
 * per cycle and run key (a sequence). It sits beside `publishPacket`; a run publishes through one
 * of the two, never both. Nothing calls it yet.
 *
 * Each publication is shared work (record 0016) in two keyed computations: its plan
 * (`harness.publication`, keyed by the cycle, the run key and the sequence's previous packet, or
 * `root`), stored before anything is appended, and its writing (`harness.publication-write`, keyed
 * by the plan), stored once its packet is appended. A replay, or a second caller, reads both and
 * repeats nothing; a stop between them is finished from the stored plan. Every new event's ID is
 * `stableUlid(plan clock, class, key)`, and an event Records already holds keeps its ID.
 *
 * A published batch is frozen: one whose key the sequence already holds is never written again,
 * whatever a caller hands in. A sequence that finds another sequence's packet standing in its
 * cycle when it starts (another configuration) appends its batches on each call with no packet,
 * keyed by the batches it has staged, and writes its one packet on the `ending` call; the mode is
 * decided in its first plan, so a replay keeps it.
 */

/** The caller's input did not decode: nothing was written. */
export class SettledInputRefused extends Data.TaggedError(
  "SettledInputRefused",
)<{ readonly message: string; readonly retryable: false }> {}

/**
 * The stored chain does not advance: a publication names its own base as its packet, or the walk
 * comes back to where it was. Never retried: what is stored would give the same answer.
 */
export class PublicationChainBroken extends Data.TaggedError(
  "PublicationChainBroken",
)<{ readonly message: string; readonly retryable: false }> {}

/**
 * A carried comment that cannot fit the payload cap even with its body cut to nothing: never
 * written, since a request for changes must not lose a comment it rests on without a word.
 */
export class CarriedCommentTooLarge extends Data.TaggedError(
  "CarriedCommentTooLarge",
)<{ readonly message: string; readonly retryable: false }> {}

/** A test's stop inside a publication, as a crash there would leave it. */
export type PublicationStop = "plan" | "batches" | "manifest" | "packet";

const PLAN_OP = "harness.publication";
const WRITE_OP = "harness.publication-write";
/** 2: the packet key holds the packet it follows, and a packet names the held refusals. */
const PLAN_VERSION = 2;
const MANIFEST_VERSION = 8;

/** The 16-bit sequence of a new event's ID, by kind, so a unit's records sort in their order. */
const CLASS: Readonly<Record<string, number>> = {
  "batch.recorded@1": 1,
  "unit.recorded@3": 2,
  "context.referenced@2": 3,
  "assessment.recorded@4": 4,
  "delivery.recorded@1": 5,
  "comment.recorded@3": 6,
  "comment.carried@1": 6,
  "disposition.recorded@2": 7,
  "disposition.carried@1": 7,
  "gap.disclosed@1": 8,
  "packet.published@2": 9,
  "lineage.recorded@1": 10,
};

/** What one Records event is, as a reader names it, for a disclosure about it. */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  "batch.recorded@1": "the batch's record",
  "unit.recorded@3": "a unit",
  "lineage.recorded@1": "how a unit relates to earlier reviews",
  "context.referenced@2": "a context reference",
  "assessment.recorded@4": "a unit's assessment",
  "delivery.recorded@1": "a briefing or review stop",
  "comment.recorded@3": "a review comment",
  "disposition.recorded@2": "an agent review decision",
  "comment.carried@1": "a comment carried from an earlier review",
  "disposition.carried@1": "a person's decision carried from an earlier review",
  "gap.disclosed@1": "a note on what this review can't show",
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A request for changes resting on more comments than a disposition can name, said on its unit. */
const restsOnCut = (uh: string, unitId: string, title: string, n: number) => ({
  base: `${uh}:gap:rests-on-cut:${n}`,
  kind: "rests-on-cut",
  detail: `The request for changes on "${clipText(title, 200)}" rests on ${n} comments; it names ${RESTS_ON_MAX}, so ${n - RESTS_ON_MAX} more aren't named on it.`,
  unitIds: [unitId],
});

/** The most earlier units a `lineage.recorded@1` names, and the most comments a disposition rests on. */
const LINEAGE_MAX = 64;
const RESTS_ON_MAX = 64;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The time a ULID was minted at, in milliseconds. */
const ulidTime = (id: string) => {
  let time = 0;
  for (const char of id.slice(0, 10))
    time = time * 32 + CROCKFORD.indexOf(char);
  return time;
};

const sortedKeys = (keys: Iterable<string>) =>
  [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const LANE_ORDER: Readonly<Record<string, number>> = {
  "static-automation": 0,
  agentic: 1,
  "human-suggested": 2,
  "human-required": 3,
};

// ---------------------------------------------------------------------------------------------
// What is stored: the plan and the writing
// ---------------------------------------------------------------------------------------------

interface RunGap {
  readonly key: string;
  readonly kind: string;
  readonly detail: string;
  readonly cause?: string | undefined;
}

interface RefusedBatch {
  readonly key: string;
  /** Its files, sorted: a held refusal is about them, whatever batch later holds them. */
  readonly paths: ReadonlyArray<string>;
  readonly title: string;
  readonly check: string;
  readonly reason: string;
  readonly cause: string;
}

/** A publication's plan, decided once and stored before anything is appended. */
interface Plan {
  readonly version: typeof PLAN_VERSION;
  /** `packet` writes a packet; `stage` appends a later sequence's batches with none. */
  readonly kind: "packet" | "stage";
  /** Decided in the sequence's first plan and copied into every later one. */
  readonly mode: "first" | "later";
  /** The packets lineage compares with, fixed in the sequence's first plan. */
  readonly lineage: ReadonlyArray<{
    readonly packetId: string;
    readonly cycleId: string;
    readonly sameCycle: boolean;
  }>;
  readonly base: string | null;
  readonly staged: string | null;
  readonly ordinal: number;
  readonly clock: number;
  /** The cycle's packet of record when the plan was made, of either kind. */
  readonly supersedes: string | null;
  readonly run: {
    readonly runId: string;
    readonly range: PublishContext["range"];
    readonly route: unknown;
    readonly config: unknown;
  };
  readonly batches: ReadonlyArray<SettledBatch>;
  readonly refused: ReadonlyArray<RefusedBatch>;
  readonly gaps: ReadonlyArray<RunGap>;
  readonly totals: SettledInput["totals"];
  readonly ending: boolean;
  readonly stagesOk: boolean;
  /** The call the plan was made for, so that call knows its ending and gaps are in. */
  readonly call: string;
  /**
   * People's decisions to carry, read once when the plan was made: per new unit (by batch and unit
   * key), each registered human's decision that `Lineage.lastActs` carries from an earlier unit it
   * is `unchanged` from, as that unit holds it, with the comments it rests on. A replay writes from
   * these and never reads decisions again.
   */
  readonly carried: ReadonlyArray<CarriedDecision>;
  /**
   * The people whose last act on a new unit's unchanged change is a decision no unit this
   * publication compares with holds, read with `carried` (`Lineage.lastActs`): nothing of theirs
   * carries to that unit and a gap says a person decides again. Absent from a plan made before it
   * was recorded.
   */
  readonly withheld?: ReadonlyArray<WithheldDecision> | undefined;
  /**
   * The new units for which people's decisions could not all be read (a person has more acts than
   * `Lineage.ActsReadMax` newer than any about the unit), read with `carried`: nothing carries to
   * them for anyone and a gap says so. Every plan made since it was recorded holds it, empty or
   * not; its absence marks an older plan, whose withheld gap keeps the words it was planned with,
   * so a replay writes the same bytes.
   */
  readonly notKnown?: ReadonlyArray<UnitNotKnown> | undefined;
  /**
   * The rule the plan's carried decisions were read by: `same-section` since a person's acts about
   * a new unit are those on earlier units that hold one of its changes; `shared-change` since a new
   * unit wholly unchanged from no compared unit is asked too (nothing can be carried to it, and a
   * withheld gap may sit on a unit the review's agent closed). Its withheld gap's words follow it;
   * a plan without it keeps the words it was planned with, so a replay writes the same bytes.
   */
  readonly carryRule?: "same-section" | "shared-change" | undefined;
  /**
   * For a packet: the newest held refusal of each batch of the sequence its manifest does not
   * hold, read once when the plan was made, so a replay names the same ones. Empty for a stage.
   */
  readonly heldGaps: ReadonlyArray<{
    readonly batch: string;
    readonly id: string;
  }>;
}

/** A person whose decision about a new unit is not brought to it (`Plan.withheld`). */
interface WithheldDecision {
  readonly batch: string;
  readonly unit: string;
  readonly actor: string;
}

/** A new unit whose people's decisions are not known (`Plan.notKnown`). */
interface UnitNotKnown {
  readonly batch: string;
  readonly unit: string;
}

interface CarriedDecision {
  readonly batch: string;
  readonly unit: string;
  readonly earlierUnit: string;
  readonly earlierCycle: string;
  readonly review: string;
  readonly head: string;
  readonly earlierLane: string | null;
  readonly disposition: string;
  readonly actor: string;
  readonly verdict: "approve" | "request-changes";
  readonly comments: ReadonlyArray<string>;
}

/** A comment's fate by the caller's own ID. */
export type Fate = { readonly id: string; readonly unit: string } & (
  | { readonly fate: "published"; readonly publicationId: string }
  | { readonly fate: "withheld"; readonly reason: string }
);

type Counts = {
  batches: number;
  units: number;
  sections: number;
  contextReferences: number;
  assessments: number;
  deliveries: number;
  dispositions: number;
  comments: number;
  gaps: number;
  pending: { batches: number; sections: number };
  undecided: Record<string, number>;
};

type Added = {
  batches: number;
  units: number;
  sections: number;
  undecided: Record<string, number>;
};

/** What a publication's writing stored: everything a later call or replay reads instead of redoing. */
interface Written {
  readonly kind: "packet" | "stage";
  readonly ordinal: number;
  readonly packetId: string | null;
  readonly manifest: string | null;
  /** For a packet, its manifest's batches; for a stage, the batches it appended. */
  readonly batches: ReadonlyArray<Record<string, unknown>>;
  /** The publication's own gaps, by the IDs Records returned. */
  readonly gaps: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
  /** The signature of the run gaps it carries, so an ending call can tell whether they changed. */
  readonly gapSignature: string;
  readonly complete: boolean;
  readonly counts: Counts;
  readonly added: Added;
  readonly fates: ReadonlyArray<Fate & { readonly batch: string }>;
  readonly fellBack: boolean;
  readonly closure: Record<string, number>;
  readonly promoted: number;
  /** Earlier units a unit of this publication holds a section of. */
  readonly matched: ReadonlyArray<string>;
  readonly unmatched: ReadonlyArray<string>;
  /** People's decisions and the comments they rest on, carried onto unchanged units. */
  readonly carried: {
    readonly dispositions: number;
    readonly comments: number;
  };
  /** The held refusals a packet names, by event ID: the newest per batch it does not hold. */
  readonly held: ReadonlyArray<string>;
}

const planSpec = (
  cycleId: string,
  runKey: string,
  base: string | null,
  staged: string | null,
) => ({
  op: PLAN_OP,
  opVersion: PLAN_VERSION,
  inputs: {
    cycle: cycleId,
    runKey,
    base: base ?? "root",
    ...(staged === null ? {} : { staged }),
  },
});

/** Where in the chain a publication is planned: its base, and what was staged since. */
const planBaseOf = (base: string | null, staged: string | null) =>
  `${base ?? "root"}${staged === null ? "" : `+${staged.slice(0, 16)}`}`;

/**
 * Where a sequence's refusals are held: per batch, a numbered series of gap events
 * (`gap:refused:<batch key>:<nn>`), never keyed by the run, the call or the place in the chain. A
 * refusal handed in whose text is the series' last is the same refusal and appends nothing; any
 * other is the next in the series. At most `REFUSED_MAX` per batch: past it the last stays named.
 */
const REFUSED_PREFIX = "gap:refused:";
const REFUSED_MAX = 32;
const refusedKey = (batch: string, n: number) =>
  `${REFUSED_PREFIX}${batch}:${String(n).padStart(2, "0")}`;

/** A batch's files, stored once by its key, so a held refusal of it can be matched by file. */
const batchPathsSpec = (batch: string) => ({
  op: "harness.batch-paths",
  opVersion: 1,
  inputs: { batch },
});

/** The gap for a refused batch, in a reader's words; the technical cause is the run log's. */
const refusalGap = (refused: RefusedBatch) => ({
  kind: "batch-not-published",
  detail: `The changes in "${clipText(refused.title, 200)}" aren't in this review yet, because ${refused.reason}. They stay pending.`,
  cause: refused.cause,
});

/**
 * Whether a packet is complete: the one rule, used by the packet and by the ending call's check
 * of what a new packet would say. Ending, nothing pending, no batch named as missing, no stage
 * cut short and no batch that fell back.
 */
const isComplete = (state: {
  readonly ending: boolean;
  readonly pending: { readonly batches: number; readonly sections: number };
  readonly heldNamed: number;
  readonly stagesOk: boolean;
  readonly fellBack: boolean;
}) =>
  state.ending &&
  state.pending.batches === 0 &&
  state.pending.sections === 0 &&
  state.heldNamed === 0 &&
  state.stagesOk &&
  !state.fellBack;

/** The run gaps a publication carries, by kind and text, in any order. */
const runGapSignature = (gaps: ReadonlyArray<RunGap>) =>
  sha256Hex(
    canonicalJson(
      gaps.map((gap) => canonicalJson([gap.kind, gap.detail])).sort(),
    ),
  );

const writeSpec = (planKey: string) => ({
  op: WRITE_OP,
  opVersion: PLAN_VERSION,
  inputs: { plan: `computation:${planKey}` },
});

const json = (value: unknown) => ({
  bytes: new TextEncoder().encode(canonicalJson(value)),
  mediaType: "application/json",
});
const parsed = <T>(bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as T;

/** A stored computation's output, or none. */
const storedOutput = <T>(spec: Computations.ComputationSpec) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const { key } = Computations.computationKey(spec);
    const held = yield* store.lookup(key);
    if (Option.isNone(held)) return undefined;
    const blobs = yield* Blobs.BlobStore;
    const read = yield* blobs.get(held.value.outputHash);
    if (read._tag === "Pruned") return undefined;
    return { key, value: parsed<T>(read.bytes) };
  });

// ---------------------------------------------------------------------------------------------
// The chain as it stands
// ---------------------------------------------------------------------------------------------

interface Chain {
  readonly base: string | null;
  readonly staged: string | null;
  /** The write keys of the stages since the last packet, which `staged` hashes. */
  readonly stages: ReadonlyArray<string>;
  readonly mode: Plan["mode"] | undefined;
  readonly lineage: Plan["lineage"] | undefined;
  /** The last packet's manifest batches, verbatim. */
  readonly packetBatches: ReadonlyArray<Record<string, unknown>>;
  /** Batches appended since the last packet (a later sequence's), verbatim. */
  readonly stagedBatches: ReadonlyArray<Record<string, unknown>>;
  readonly stagedGaps: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
  }>;
  readonly last: Written | undefined;
  readonly lastPacket: Written | undefined;
  readonly fellBack: boolean;
  readonly matched: ReadonlySet<string>;
  /** Every batch key the sequence published or staged. */
  readonly frozen: ReadonlySet<string>;
  readonly fates: ReadonlyMap<string, ReadonlyArray<Fate>>;
  readonly publications: ReadonlyArray<{
    readonly plan: Plan;
    readonly written: Written;
  }>;
}

/**
 * The sequence's chain, walked from `root` through the stored plans and writings: where it stands,
 * and the plan whose writing is still to do, when a publication stopped partway.
 */
const walk = (cycleId: string, runKey: string) =>
  Effect.gen(function* () {
    let chain: Chain = {
      base: null,
      staged: null,
      stages: [],
      mode: undefined,
      lineage: undefined,
      packetBatches: [],
      stagedBatches: [],
      stagedGaps: [],
      last: undefined,
      lastPacket: undefined,
      fellBack: false,
      matched: new Set(),
      frozen: new Set(),
      fates: new Map(),
      publications: [],
    };
    // Each step must move the chain to a place it has not been: a stored publication whose
    // packet is its own base, or any other repeat, is a broken chain, said rather than spun on.
    const visited = new Set<string>();
    for (;;) {
      const place = `${chain.base ?? "root"}+${chain.staged ?? ""}`;
      if (visited.has(place))
        return yield* new PublicationChainBroken({
          message: `the publication chain of cycle ${cycleId} returns to ${place}`,
          retryable: false,
        });
      visited.add(place);
      const plan = yield* storedOutput<Plan>(
        planSpec(cycleId, runKey, chain.base, chain.staged),
      );
      if (plan === undefined) return { chain, open: undefined };
      const written = yield* storedOutput<Written>(writeSpec(plan.key));
      if (written === undefined)
        return { chain, open: { key: plan.key, plan: plan.value } };
      const w = written.value;
      const keys = plan.value.batches.map((batch) => batchKeyOf(batch.paths));
      const fates = new Map(chain.fates);
      for (const key of keys)
        fates.set(
          key,
          w.fates.filter((fate) => fate.batch === key),
        );
      const common = {
        mode: plan.value.mode,
        lineage: plan.value.lineage,
        last: w,
        fellBack: chain.fellBack || w.fellBack,
        matched: new Set([...chain.matched, ...w.matched]),
        frozen: new Set([...chain.frozen, ...keys]),
        fates,
        publications: [...chain.publications, { plan: plan.value, written: w }],
      };
      if (
        w.kind === "packet" &&
        (w.packetId === null || w.packetId === chain.base)
      )
        return yield* new PublicationChainBroken({
          message: `the publication planned on ${chain.base ?? "root"} in cycle ${cycleId} names ${w.packetId ?? "no packet"} as its packet`,
          retryable: false,
        });
      if (w.kind === "packet")
        chain = {
          ...chain,
          ...common,
          base: w.packetId,
          staged: null,
          stages: [],
          packetBatches: w.batches,
          stagedBatches: [],
          stagedGaps: [],
          lastPacket: w,
        };
      else {
        const stages = [...chain.stages, written.key];
        chain = {
          ...chain,
          ...common,
          staged: sha256Hex(canonicalJson(stages)),
          stages,
          stagedBatches: [...chain.stagedBatches, ...w.batches],
          stagedGaps: [...chain.stagedGaps, ...w.gaps],
        };
      }
    }
  });

// ---------------------------------------------------------------------------------------------
// Lineage and carried decisions
// ---------------------------------------------------------------------------------------------

/** The earlier units of each packet fixed in the sequence's first plan. */
const earlierSets = (lineage: Plan["lineage"]) =>
  Effect.gen(function* () {
    const sets: Array<{
      units: ReadonlyArray<EarlierUnit>;
      sameCycle: boolean;
    }> = [];
    for (const packet of lineage)
      sets.push({
        units: yield* earlierUnits(packet.packetId),
        sameCycle: packet.sameCycle,
      });
    return sets;
  });

/** How each unit of a batch relates to the earlier units, by unit key, at most 64 each. */
const batchLineage = (
  batch: SettledBatch,
  earlier: ReadonlyArray<{
    readonly units: ReadonlyArray<EarlierUnit>;
    readonly sameCycle: boolean;
  }>,
) => {
  const sections = new Map<string, SettledSection>(
    batch.sections.map((section) => [section.identity.key, section]),
  );
  const fresh: Array<NewUnit> = batch.units.map((unit) => ({
    key: unitKeyOf(unit),
    path: unit.path,
    sections: sortedKeys(unit.sectionKeys).map((sectionKey) => {
      const section = sections.get(sectionKey)!;
      return {
        key: sectionKey,
        kind: section.identity.parts.kind,
        name: section.identity.parts.name,
        start: section.identity.where?.startLine ?? Number.MAX_SAFE_INTEGER,
        ranges: section.ownedRanges,
      };
    }),
  }));
  const lineageOf = new Map<string, Array<LineageFrom>>();
  for (const set of earlier)
    for (const [key, from] of compareUnits(fresh, set.units, set.sameCycle))
      lineageOf.set(key, [...(lineageOf.get(key) ?? []), ...from]);
  for (const [key, from] of lineageOf)
    lineageOf.set(
      key,
      [...from].sort(
        (a, b) =>
          b.unchanged + b.changed - (a.unchanged + a.changed) ||
          (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0),
      ),
    );
  return lineageOf;
};

type Of<K extends RecordEvent["kind"]> = Extract<RecordEvent, { kind: K }>;
type Decision = Of<
  "disposition.recorded@1" | "disposition.recorded@2" | "disposition.carried@1"
>;
const isDecision = (event: RecordEvent): event is Decision =>
  event.kind === "disposition.recorded@1" ||
  event.kind === "disposition.recorded@2" ||
  event.kind === "disposition.carried@1";

/**
 * What people's decisions bring to each unit of these batches from the earlier units it is
 * `unchanged` from (the owner's ruling: an unchanged unit is not asked again), as
 * `Lineage.lastActs` answers: each registered person's last act on the same unchanged change, in
 * the store's append order, decides. A decision a compared unit holds (itself or a standing copy)
 * carries, with the comments it rests on there, in disposition-ID order; one no compared unit
 * holds is withheld, and a gap says a person decides again; a withdrawal carries nothing. A unit
 * whose people's acts are too many to read carries nothing for anyone, and a gap says so.
 * Agents' decisions never carry.
 */
const decisionsToCarry = (
  batches: ReadonlyArray<SettledBatch>,
  lineage: Plan["lineage"],
) =>
  Effect.gen(function* () {
    const carried: Array<CarriedDecision> = [];
    const withheld: Array<WithheldDecision> = [];
    const notKnown: Array<UnitNotKnown> = [];
    if (lineage.length === 0) return { carried, withheld, notKnown };
    const earlier = yield* earlierSets(lineage);
    const byId = new Map(
      earlier.flatMap((set) => set.units).map((u) => [u.unitId, u]),
    );
    const asked: Array<{
      readonly batch: string;
      readonly unit: string;
      readonly from: ReadonlyArray<LineageFrom>;
      readonly sharing: ReadonlyArray<string>;
      readonly sectionKeys: ReadonlyArray<string>;
      readonly paths: ReadonlyArray<string>;
    }> = [];
    for (const batch of batches) {
      const keysOf = new Map(
        batch.units.map((u) => [unitKeyOf(u), sortedKeys(u.sectionKeys)]),
      );
      // Each unit's files: its path and every path its sections name, so an act on an
      // older-shape unit (owned ranges, no section keys) counts only in the same file.
      const pathsOf = new Map(
        batch.units.map((u) => {
          const files = new Set([u.path]);
          for (const section of batch.sections)
            if (u.sectionKeys.includes(section.identity.key)) {
              files.add(section.identity.parts.path);
              for (const range of section.ownedRanges) files.add(range.path);
            }
          return [unitKeyOf(u), [...files].sort()];
        }),
      );
      for (const [unit, from] of batchLineage(batch, earlier)) {
        const kept = from.slice(0, LINEAGE_MAX);
        const unchanged = kept.filter(
          (entry) => entry.relation === "unchanged",
        );
        const sharing = kept
          .filter(
            (entry) => entry.relation !== "unchanged" && entry.unchanged >= 1,
          )
          .map((entry) => entry.unitId);
        if (unchanged.length > 0 || sharing.length > 0)
          asked.push({
            batch: batchKeyOf(batch.paths),
            unit,
            from: unchanged,
            sharing,
            sectionKeys: keysOf.get(unit) ?? [],
            paths: pathsOf.get(unit) ?? [],
          });
      }
    }
    // Each new unit with its section keys: a person's acts about it are those on every unit that
    // holds one of its changes, joined by lineage or not. Nothing is carried from the compared
    // units it only overlaps (`sharing`: at least one of its changes unchanged there).
    // A new unit wholly unchanged from no compared unit is asked with no unit to carry from: a
    // person whose last act on one of its changes is a decision is withheld, and a gap says so.
    const answers = yield* Lineage.lastActs(
      asked.map(({ from, sharing, sectionKeys, paths }) => ({
        units: from.map((entry) => entry.unitId),
        sharing,
        sectionKeys,
        paths,
      })),
    );
    for (const [n, { batch, unit, from }] of asked.entries()) {
      const answer = answers[n]!;
      if (answer.kind === "not-known") {
        notKnown.push({ batch, unit });
        continue;
      }
      for (const person of answer.people) {
        const stored =
          person.kind === "carry"
            ? yield* Log.get(person.eventId)
            : Option.none();
        const entry =
          person.kind === "carry"
            ? from.find((e) => e.unitId === person.unitId)
            : undefined;
        if (
          person.kind === "withheld" ||
          entry === undefined ||
          Option.isNone(stored) ||
          !isDecision(stored.value.event)
        ) {
          withheld.push({ batch, unit, actor: person.actorId });
          continue;
        }
        const event = stored.value.event;
        const earlierUnit = byId.get(entry.unitId);
        carried.push({
          batch,
          unit,
          earlierUnit: entry.unitId,
          earlierCycle: entry.cycleId,
          review: earlierUnit?.review ?? "",
          head: earlierUnit?.head ?? event.payload.reviewedHeadOid,
          earlierLane: entry.lane,
          disposition: event.id,
          actor: event.actor,
          verdict: event.payload.verdict,
          comments:
            event.kind === "disposition.recorded@1"
              ? []
              : sortedKeys(event.payload.restsOn),
        });
      }
    }
    return {
      carried: carried.sort((a, b) =>
        a.disposition < b.disposition
          ? -1
          : a.disposition > b.disposition
            ? 1
            : 0,
      ),
      withheld,
      notKnown,
    };
  });

/**
 * A carried comment's payload within the event payload cap: an earlier comment at its own cap,
 * plus `from` and `lineage`, can pass it, so the body is cut with the same cleaner until it fits.
 * Each UTF-16 unit takes at least one byte, so cutting the excess in units always fits.
 */
const fitPayload = (payload: { body: string } & Record<string, unknown>) => {
  let body = payload.body;
  for (let step = 0; step < 8; step++) {
    const bytes = new TextEncoder().encode(
      canonicalJson({ ...payload, body }),
    ).length;
    if (bytes <= PAYLOAD_MAX_BYTES)
      return { payload: { ...payload, body }, clipped: body !== payload.body };
    body = clipText(
      body,
      Math.max(1, body.length - (bytes - PAYLOAD_MAX_BYTES) - 8),
    );
  }
  // Measured again: what is left without the body must fit too, or nothing is written.
  const last = { ...payload, body: "-" };
  return new TextEncoder().encode(canonicalJson(last)).length <=
    PAYLOAD_MAX_BYTES
    ? { payload: last, clipped: true }
    : undefined;
};

const FINDING_KINDS_V2: ReadonlyArray<string> = [
  "defect",
  "risk",
  "question",
  "pattern-note",
];

/**
 * A comment as `comment.carried@1` holds it (comment version 2's payload), with its anchor moved
 * onto the new unit's lines: the section it sits in is unchanged, so its span's text is the same,
 * and the anchor moves by the distance between the two spans' first lines. An anchor in no
 * unchanged section, or on a section with no span on either side, is dropped (`unplaced`). A
 * finding of a kind version 2 does not know (impact) carries as its text only.
 */
const carriedComment = (
  comment: RecordEvent,
  earlierUnit: EarlierUnit | undefined,
  newSections: ReadonlyMap<string, SettledSection>,
  sectionKeys: ReadonlySet<string>,
) => {
  const payload =
    (comment as { payload?: Record<string, unknown> }).payload ?? {};
  const body = clipText(String(payload["body"] ?? ""), 20_000);
  const anchor = payload["anchor"] as
    | { path: string; side?: "old" | "new"; startLine: number; endLine: number }
    | undefined;
  const finding = payload["finding"] as
    | {
        kind: string;
        about: string;
        signal?: string;
        evidence: ReadonlyArray<unknown>;
      }
    | undefined;
  let moved: Record<string, unknown> | undefined;
  if (anchor !== undefined && anchor.side !== undefined)
    for (const section of earlierUnit?.sections ?? []) {
      const now = newSections.get(section.key)?.identity.where;
      if (
        !sectionKeys.has(section.key) ||
        section.where === null ||
        now == null ||
        section.path !== anchor.path ||
        (section.side ?? "new") !== anchor.side ||
        anchor.startLine < section.where.startLine ||
        anchor.endLine > section.where.endLine
      )
        continue;
      const offset = now.startLine - section.where.startLine;
      moved = {
        path: anchor.path,
        side: anchor.side,
        startLine: anchor.startLine + offset,
        endLine: anchor.endLine + offset,
      };
      break;
    }
  return {
    unplaced: anchor !== undefined && moved === undefined,
    payload: {
      body,
      ...(moved === undefined ? {} : { anchor: moved }),
      ...(finding !== undefined && FINDING_KINDS_V2.includes(finding.kind)
        ? {
            finding: {
              kind: finding.kind,
              about: finding.about,
              ...(finding.signal === undefined
                ? {}
                : { signal: finding.signal }),
              evidence: finding.evidence,
            },
          }
        : {}),
    },
  };
};

/**
 * The carried events of one new unit: each carried request for changes with the comments it rests
 * on carried first, each by its own actor; each carried approval, unless this review disputes the
 * unit (asks for changes to it, or places it in a higher lane than the earlier unit's), when it is
 * not carried and a gap says a person decides again. A gap also says when people's later
 * decisions about the unit sit where this publication cannot bring them from, when the unit's
 * unchanged change spans too many earlier units to read, and which carried comments lost their
 * anchor.
 */
const carryDecisions = (input: {
  readonly items: ReadonlyArray<CarriedDecision>;
  /** How many people's later decisions about the unit are not brought to it. */
  readonly withheld: number;
  /**
   * The words of the withheld gap, by the plan that made it: `shared-change` or `same-section`
   * (`Plan.carryRule`), `last-act` (`Plan.notKnown` present, no rule) or `before` (neither). An
   * older plan keeps the words it was planned with.
   */
  readonly words: "shared-change" | "same-section" | "last-act" | "before";
  /** Whether people's decisions on the unit's unchanged change could not all be read. */
  readonly notKnown: boolean;
  readonly event: (
    kind: string,
    base: string,
    actor: string,
    attribution: Record<string, unknown>,
    payload: unknown,
  ) => Built;
  readonly on: Record<string, unknown>;
  readonly head: string;
  readonly lineageId: string | null;
  readonly uh: string;
  readonly unitId: string;
  readonly title: string;
  readonly lane: SettledBatch["units"][number]["lane"];
  readonly disputedBy: "changes" | undefined;
  readonly earlierById: ReadonlyMap<string, EarlierUnit>;
  readonly newSections: ReadonlyMap<string, SettledSection>;
  readonly sectionKeys: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    const events: Array<Built> = [];
    const gaps: Array<Gap> = [];
    const comments = new Map<string, Built>();
    let dispositions = 0;
    let unplaced = 0;
    let clipped = 0;
    const notCarried = new Map<"changes" | "higher", number>();
    for (const item of [...input.items].sort((a, b) =>
      a.disposition < b.disposition ? -1 : 1,
    )) {
      if (item.verdict === "approve") {
        const higher =
          LANE_ORDER[input.lane]! >
          (item.earlierLane === null
            ? -1
            : (LANE_ORDER[item.earlierLane] ?? -1));
        const why = input.disputedBy ?? (higher ? "higher" : undefined);
        if (why !== undefined) {
          notCarried.set(why, (notCarried.get(why) ?? 0) + 1);
          continue;
        }
      }
      const held = yield* Log.get(item.disposition);
      if (Option.isNone(held) || !isDecision(held.value.event)) continue;
      const decision = held.value.event;
      const from = (judgement: string) => ({
        review: item.review,
        cycle: item.earlierCycle,
        head: item.head,
        judgement,
        output: input.lineageId ?? "",
        savedMs: 0,
      });
      const restsOn: Array<string> = [];
      if (item.verdict === "request-changes")
        for (const commentId of item.comments) {
          const known = comments.get(commentId);
          if (known !== undefined) {
            restsOn.push(known.id);
            continue;
          }
          const comment = yield* Log.get(commentId);
          if (Option.isNone(comment)) continue;
          const carried = carriedComment(
            comment.value.event,
            input.earlierById.get(item.earlierUnit),
            input.newSections,
            input.sectionKeys,
          );
          if (carried.unplaced) unplaced += 1;
          const fitted = fitPayload({
            ...carried.payload,
            lineage: "carried",
            from: from(commentId),
          });
          if (fitted === undefined)
            return yield* new CarriedCommentTooLarge({
              message: `comment ${commentId} carried onto ${input.uh} cannot fit the payload cap even with no body`,
              retryable: false,
            });
          if (fitted.clipped) clipped += 1;
          const built = input.event(
            "comment.carried@1",
            `${input.uh}:carried-comment:${short(commentId)}`,
            comment.value.event.actor,
            input.on,
            fitted.payload,
          );
          comments.set(commentId, built);
          events.push(built);
          restsOn.push(built.id);
        }
      if (restsOn.length > RESTS_ON_MAX)
        gaps.push(
          restsOnCut(input.uh, input.unitId, input.title, restsOn.length),
        );
      const note = (decision.payload as { note?: string }).note;
      events.push(
        input.event(
          "disposition.carried@1",
          `${input.uh}:carried:${short(item.disposition)}`,
          decision.actor,
          input.on,
          {
            verdict: item.verdict,
            reviewedHeadOid: input.head,
            ...(note === undefined ? {} : { note }),
            restsOn: sortedKeys(restsOn).slice(0, RESTS_ON_MAX),
            proof:
              decision.kind === "disposition.recorded@1"
                ? []
                : decision.payload.proof,
            lineage: "carried",
            from: from(item.disposition),
          },
        ),
      );
      dispositions += 1;
    }
    const name = `"${clipText(input.title, 200)}"`;
    for (const [why, n] of notCarried)
      gaps.push({
        base: `${input.uh}:gap:earlier-approval-not-carried:${why}`,
        kind: "earlier-approval-not-carried",
        detail: `${n === 1 ? "A person's earlier approval" : `${n} people's earlier approvals`} of ${name} ${n === 1 ? "wasn't" : "weren't"} carried to this review, because this review ${why === "changes" ? "asks for changes to it" : `places it in a higher review lane (${LANE_WORDS[input.lane]})`}. A person decides it again.`,
        unitIds: [input.unitId],
      });
    if (input.withheld > 0)
      gaps.push({
        base: `${input.uh}:gap:later-decision-not-carried`,
        kind: "later-decision-not-carried",
        // The later decision may sit in the review of an earlier range as well as in another
        // review of this one, on a unit that held only some of this unit's changes; an older plan
        // keeps the words it was planned with.
        // Since `shared-change` the unit may be one the review's agent closed, so the last sentence
        // says what a person may do, not that the unit waits for them.
        detail:
          input.words === "shared-change"
            ? `${input.withheld === 1 ? "A person's latest decision on a change" : `${input.withheld} people's latest decisions on changes`} in ${name}, made in ${input.withheld === 1 ? "an earlier review" : "earlier reviews"}, ${input.withheld === 1 ? "wasn't" : "weren't"} brought forward to this one. ${input.withheld === 1 ? "It" : "They"} can be made again here.`
            : input.words === "same-section"
              ? `${input.withheld === 1 ? "A person's latest decision on a change" : `${input.withheld} people's latest decisions on changes`} in ${name}, made in ${input.withheld === 1 ? "an earlier review" : "earlier reviews"}, ${input.withheld === 1 ? "wasn't" : "weren't"} brought forward to this one. A person decides it again.`
              : input.words === "last-act"
                ? `${input.withheld === 1 ? "A person's latest decision" : `${input.withheld} people's latest decisions`} on ${name}, made in ${input.withheld === 1 ? "an earlier review" : "earlier reviews"}, ${input.withheld === 1 ? "wasn't" : "weren't"} brought forward to this one. A person decides it again.`
                : `${input.withheld === 1 ? "A person's later decision" : `${input.withheld} people's later decisions`} on ${name}, made in another review of this range, ${input.withheld === 1 ? "wasn't" : "weren't"} brought forward to this review. A person decides it again.`,
        unitIds: [input.unitId],
      });
    if (input.notKnown)
      gaps.push({
        base: `${input.uh}:gap:earlier-decisions-not-read`,
        kind: "earlier-decisions-not-read",
        detail: `${name} is unchanged across too many earlier reviews to read every decision made on it, so none was brought forward to this review. A person decides it again.`,
        unitIds: [input.unitId],
      });
    if (clipped > 0)
      gaps.push({
        base: `${input.uh}:gap:carried-comment-clipped`,
        kind: "carried-comment-clipped",
        detail: `${clipped === 1 ? "A comment" : `${clipped} comments`} carried onto ${name} from an earlier review ${clipped === 1 ? "was" : "were"} shortened to fit; the earlier review holds ${clipped === 1 ? "it" : "them"} whole.`,
        unitIds: [input.unitId],
      });
    if (unplaced > 0)
      gaps.push({
        base: `${input.uh}:gap:carried-comment-unanchored`,
        kind: "carried-comment-unanchored",
        detail: `${unplaced === 1 ? "A comment" : `${unplaced} comments`} carried onto ${name} from an earlier review ${unplaced === 1 ? "points" : "point"} to lines that can't be found in it now, so ${unplaced === 1 ? "it is" : "they are"} shown on the unit as a whole.`,
        unitIds: [input.unitId],
      });
    return { events, gaps, dispositions, comments: comments.size };
  });

const LANE_WORDS: Readonly<Record<string, string>> = {
  "static-automation": "static automation",
  agentic: "agentic",
  "human-suggested": "human suggested",
  "human-required": "human required",
};

// ---------------------------------------------------------------------------------------------
// Writing one publication
// ---------------------------------------------------------------------------------------------

/** A gap as the publisher writes it: a reader's sentence, its units, and the run log's cause. */
interface Gap {
  readonly base: string;
  readonly kind: string;
  readonly detail: string;
  readonly unitIds?: ReadonlyArray<string> | undefined;
  readonly cause?: string | undefined;
}

type Built = Record<string, unknown> & {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly base: string;
};

const strip = ({ base: _base, ...rest }: Built) => rest;

/** The withheld reasons a reader is told of, in their words. */
const WITHHELD_WORDS: Readonly<Record<string, string>> = {
  "impact-without-summary":
    "an impact comment gives no one-line summary of what changes",
  "anchor-outside-unit": "it points to lines the unit doesn't own",
};

const UNDECIDED_LINE = (title: string, n: number, of: number) =>
  `No agent decided ${n === 1 ? "one" : n} of the ${of === 1 ? "section" : `${of} sections`} of "${clipText(title, 200)}" in this run, so a person decides ${n === 1 ? "it" : "them"}.`;

/**
 * The index the reader resolves a batch's references through, written only for a batch that holds
 * references: their local IDs and the unit handles they name, and the references whole, with
 * nothing made up around them (`index: "sections@1"`, which the new-shape read decodes loosely in
 * `assembledIndex`, `packages/records-core/src/published-packets.ts`). A batch with no reference
 * names none, and the reader reads its references and citations as none.
 */
const indexOf = (batch: SettledBatch, handles: ReadonlyArray<string>) => ({
  index: "sections@1",
  citations: Object.fromEntries([
    ...handles.map((handle) => [
      handle,
      { kind: "unit", ref: null, entry: handle },
    ]),
    ...(batch.references ?? []).map((reference) => [
      reference.id,
      { kind: "reference", ref: null, entry: null },
    ]),
  ]),
  references: batch.references ?? [],
  units: [],
});

/**
 * One batch's events in one append transaction. Should Records refuse it, they are appended one by
 * one: an event held with other content keeps the stored one, whose ID the manifest names; a
 * refused one has no ID and is disclosed; the publication is then incomplete (today's habit,
 * `publish.ts`'s `appendBatch`, with the new kinds' words and keys that never hold a path).
 */
const appendSettled = (
  ctx: PublishContext,
  events: ReadonlyArray<Built>,
  disclose: (gap: Gap) => Built,
  batch: string,
) =>
  Effect.gen(function* () {
    const whole = yield* Effect.result(Log.append(events.map(strip)));
    if (whole._tag === "Success") {
      ctx.log.write({
        type: "records",
        kind: "publish.batch",
        batch,
        status: whole.success.every((r) => r.status === "existing")
          ? "existing"
          : "appended",
        events: events.length,
      });
      return {
        ids: whole.success.map((r) => r.id) as Array<string | null>,
        accepted: whole.success.map(() => true),
        fellBack: false,
        disclosed: [] as Array<{ built: Built; id: string | null }>,
      };
    }
    const tag = (whole.failure as { _tag?: string })._tag ?? "error";
    if (
      ![
        "IdempotencyConflict",
        "InvalidEvent",
        "PayloadTooLarge",
        "WorkflowRuleViolation",
        "EventIdConflict",
      ].includes(tag)
    )
      return yield* Effect.fail(whole.failure);
    ctx.log.write({
      type: "records",
      kind: "publish.batch",
      batch,
      status: "one-by-one",
      cause: tag,
    });
    const ids: Array<string | null> = [];
    const accepted: Array<boolean> = [];
    const gaps: Array<Built> = [];
    // A carried copy enters the store only after its unit's lineage, which names the unit it was
    // carried from: a reader finds where a copy came from through that link. A unit's
    // lineage comes before its carried events in the batch; when it was not saved as written,
    // they are not saved either.
    const linked = new Set<string>();
    const unitOf = (built: Built) =>
      (built["attribution"] as { unitIds?: ReadonlyArray<string> } | undefined)
        ?.unitIds?.[0] ?? "";
    for (const single of events) {
      const unlinked =
        (single.kind === "disposition.carried@1" ||
          single.kind === "comment.carried@1") &&
        !linked.has(unitOf(single));
      const one = unlinked
        ? ({
            _tag: "Failure",
            failure: {
              _tag: "LineageNotSaved",
              message: "its unit's lineage was not saved",
            },
          } as const)
        : yield* Effect.result(Log.append([strip(single)]));
      if (one._tag === "Success") {
        if (single.kind === "lineage.recorded@1") linked.add(unitOf(single));
        ids.push(one.success[0]?.id ?? null);
        accepted.push(true);
        continue;
      }
      accepted.push(false);
      const reason = one.failure as {
        _tag?: string;
        message?: string;
        existingEventId?: string;
      };
      const kept =
        reason._tag === "IdempotencyConflict" &&
        typeof reason.existingEventId === "string";
      ids.push(kept ? reason.existingEventId! : null);
      const what = EVENT_WORDS[single.kind] ?? "one record";
      gaps.push(
        disclose({
          base: `${batch}:gap:event:${short(single.idempotencyKey)}`,
          kind: kept ? "publish-kept-earlier" : "publish-refused",
          detail: kept
            ? `An earlier run's version of ${what} in this batch is shown, because this run wrote it differently.`
            : `${what.charAt(0).toUpperCase()}${what.slice(1)} in this batch couldn't be saved, so it's missing from this review.`,
          cause: clipText(
            `${single.kind} of batch ${batch} (${single.idempotencyKey}): ${kept ? `Records holds it with other content as ${reason.existingEventId}, which stands` : `${reason._tag ?? "error"}${reason.message === undefined ? "" : `: ${reason.message}`}`}`,
            2_000,
          ),
        }),
      );
    }
    const disclosed: Array<{ built: Built; id: string | null }> = [];
    for (const gap of gaps) {
      const one = yield* Effect.result(Log.append([strip(gap)]));
      disclosed.push({
        built: gap,
        id:
          one._tag === "Success"
            ? (one.success[0]?.id ?? null)
            : ((one.failure as { existingEventId?: string }).existingEventId ??
              null),
      });
    }
    return { ids, accepted, fellBack: true, disclosed };
  });

/**
 * Writes one publication from its stored plan: each planned batch in one append transaction, then
 * (for a packet) the publication's own gaps, the manifest and the packet. Pure over the plan and
 * what Records already holds, so a replay writes the same bytes.
 */
const writePublication = (
  ctx: PublishContext,
  plan: Plan,
  chain: Chain,
  epoch: number,
  stop: PublicationStop | undefined,
) =>
  Effect.gen(function* () {
    const namespace = `review:${ctx.cycleId}:${ctx.runKey}:`;
    const session = `review:${ctx.cycleId}:${ctx.runKey}`;
    const actors = {
      assemble: harnessActor(session, "link"),
      dispose: harnessActor(session, "link"),
      publish: harnessActor(session, "publish"),
    };
    const occurredAt = new Date(plan.clock).toISOString();
    const held = new Map<string, string>();
    for (const row of yield* keyedIds(namespace)) held.set(row.key, row.id);
    const entityId = (key: string) =>
      stableUlid(epoch, 0, `${namespace}entity:${key}`);
    const event = (
      kind: string,
      base: string,
      actor: string,
      attribution: Record<string, unknown>,
      payload: unknown,
      refs?: ReadonlyArray<{ readonly ref: string; readonly role: string }>,
    ): Built => {
      const content = { kind, attribution, payload, refs: refs ?? null };
      const full = `${namespace}${base}#${sha256Hex(canonicalJson(content)).slice(0, 16)}`;
      return {
        id: held.get(full) ?? stableUlid(plan.clock, CLASS[kind] ?? 15, full),
        kind,
        idempotencyKey: full,
        actor,
        occurredAt,
        attribution,
        payload,
        ...(refs === undefined ? {} : { refs }),
        base,
      };
    };
    const gapEvent = (gap: Gap) =>
      event(
        "gap.disclosed@1",
        gap.base,
        actors.publish,
        {
          cycleId: ctx.cycleId,
          range: plan.run.range,
          runId: plan.run.runId,
          stage: "publish",
          ...(gap.unitIds === undefined || gap.unitIds.length === 0
            ? {}
            : { unitIds: [...gap.unitIds] }),
        },
        {
          kind: GapKind.safeParse(gap.kind).success ? gap.kind : "publish-gap",
          detail: clipText(gap.detail, 2_000),
        },
      );
    const logGap = (gap: Gap) =>
      ctx.log.write({
        type: "gap",
        stage: "publish",
        agent: "publish",
        kind: gap.kind,
        detail: gap.detail,
        ...(gap.cause === undefined ? {} : { cause: gap.cause }),
      });

    // Lineage: the earlier units of the packets fixed in the sequence's first plan.
    const earlier = yield* earlierSets(plan.lineage);
    const earlierById = new Map(
      earlier.flatMap((set) => set.units).map((u) => [u.unitId, u]),
    );
    const carriedCounts = { dispositions: 0, comments: 0 };

    const entries: Array<Record<string, unknown>> = [];
    const fates: Array<Fate & { batch: string }> = [];
    const matched = new Set<string>();
    const proofs = new Set<string>();
    let fellBack = false;
    const added: Added = { batches: 0, units: 0, sections: 0, undecided: {} };

    for (const batch of plan.batches) {
      const batchKey = batchKeyOf(batch.paths);
      const bh = batchHandle(batchKey);
      const batchId = entityId(`batch:${batchKey}`);
      const sections = new Map<string, SettledSection>(
        batch.sections.map((section) => [section.identity.key, section]),
      );
      const units = [...batch.units]
        .map((unit) => ({ unit, key: unitKeyOf(unit) }))
        .sort(
          (a, b) =>
            (a.unit.path < b.unit.path
              ? -1
              : a.unit.path > b.unit.path
                ? 1
                : 0) ||
            LANE_ORDER[a.unit.lane]! - LANE_ORDER[b.unit.lane]! ||
            (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
        );
      const unitIdOf = new Map(
        units.map(({ key }) => [key, entityId(`unit:${key}`)]),
      );
      // A caller's batch gap names a unit by its index in the caller's list.
      const callerUnitKey = batch.units.map((unit) => unitKeyOf(unit));
      const gaps: Array<Gap> = [];
      for (const gap of batch.gaps ?? []) {
        const unitKey =
          gap.unit === undefined ? undefined : callerUnitKey[gap.unit];
        gaps.push({
          base: `${bh}:gap:${short(gap.key)}`,
          kind: gap.kind,
          detail: gap.detail,
          ...(unitKey === undefined
            ? {}
            : { unitIds: [unitIdOf.get(unitKey)!] }),
        });
      }
      const events: Array<Built> = [
        event(
          "batch.recorded@1",
          bh,
          actors.assemble,
          { cycleId: ctx.cycleId, batchId },
          {
            title: clipText(batch.title, 512),
            focus: clipText(batch.focus, 2_000),
          },
        ),
      ];
      // Lineage per unit, file by file, against each earlier packet.
      const lineageOf = batchLineage(batch, earlier);
      const blobOf = new Map(
        units.map(({ unit, key }) => [key, unitSections(unit, sections)]),
      );
      const titledByAgent = (unit: SettledUnit) =>
        unit.title !== undefined && clipText(unit.title, 512, "") !== "";
      // Code titles are made for the batch at once, so two units of one file are told apart by
      // their parts, and by their lines when their parts read the same; never by their lane.
      const byCode = units.filter(({ unit }) => !titledByAgent(unit));
      const coded = codeTitles(
        byCode.map(({ unit, key }) => ({ unit, blob: blobOf.get(key)! })),
      );
      const codeTitleOf = new Map(
        byCode.map(({ key }, i) => [key, coded[i]!] as const),
      );
      const titles = new Set<string>();
      const unitEntries: Array<{
        readonly entry: Record<string, unknown>;
        readonly events: ReadonlyArray<Built>;
        readonly comments: ReadonlyArray<{ id: string; built: Built }>;
      }> = [];
      const withheldFates: Array<Fate & { batch: string }> = [];
      for (const { unit, key } of units) {
        const uh = unitHandle(key);
        const unitId = unitIdOf.get(key)!;
        const on = { cycleId: ctx.cycleId, unitIds: [unitId] };
        const target = { cycleId: ctx.cycleId, batchId, unitIds: [unitId] };
        const blob = blobOf.get(key)!;
        const blobs = yield* Blobs.BlobStore;
        const stored = yield* blobs.put({
          bytes: new TextEncoder().encode(canonicalJson(blob)),
          mediaType: "application/json",
          retention: "durable",
        });
        const byAgent = titledByAgent(unit);
        let title = byAgent
          ? clipText(unit.title!, 512)
          : codeTitleOf.get(key)!;
        // A code-built title stays within its bound with the number that tells it apart.
        for (let n = 2; titles.has(title); n++)
          title = byAgent
            ? `${clipText(title, 500)} (${n})`
            : `${boundTitle(title, TITLE_MAX - ` (${n})`.length)} (${n})`;
        titles.add(title);
        const unitEvents: Array<Built> = [
          event(
            "unit.recorded@3",
            uh,
            actors.assemble,
            target,
            {
              title,
              titleBy: byAgent ? "agent" : "code",
              path: unit.path,
              key,
              sections: { count: blob.sections.length },
              ranges: rangeCounts(blob),
            },
            [{ ref: `blob:${stored.blob.hash}`, role: "sections" }],
          ),
        ];
        const from = lineageOf.get(key) ?? [];
        if (from.length > 0) {
          const kept = from.slice(0, LINEAGE_MAX);
          for (const entry of from) matched.add(entry.unitId);
          if (from.length > LINEAGE_MAX)
            gaps.push({
              base: `${uh}:gap:lineage-cut`,
              kind: "lineage-cut",
              detail: `"${clipText(title, 200)}" holds changes of ${from.length} units of earlier reviews; only the ${LINEAGE_MAX} it shares most with are named on it.`,
              unitIds: [unitId],
            });
          unitEvents.push(
            event(
              "lineage.recorded@1",
              `${uh}:lineage`,
              actors.publish,
              {
                cycleId: ctx.cycleId,
                unitIds: [unitId, ...kept.map((e) => e.unitId)],
              },
              { from: kept },
            ),
          );
        }
        const entriesOfUnit = blob.sections.map(
          (section) => sections.get(section.key)!.entry,
        );
        const undecided: Record<string, number> = {};
        for (const entry of entriesOfUnit)
          if (entry.undecided !== undefined)
            undecided[entry.undecided.cause] =
              (undecided[entry.undecided.cause] ?? 0) + 1;
        const laneRule = unit.laneRule ?? SECTION_LANE_RULE;
        const judgements = yield* deliveryContent(
          { unit: key, stop: "judgements" },
          { rule: laneRule, sections: entriesOfUnit },
        );
        unitEvents.push(
          event(
            "assessment.recorded@4",
            `${uh}:assessment`,
            actors.assemble,
            on,
            {
              lane: unit.lane,
              laneRule,
              sections: {
                count: blob.sections.length,
                raised: entriesOfUnit.filter(
                  (entry) =>
                    entry.lane.judged !== null &&
                    entry.lane.judged !== entry.lane.applied,
                ).length,
                undecided,
              },
            },
            [{ ref: `computation:${judgements}`, role: "judgements" }],
          ),
        );
        for (const entry of entriesOfUnit)
          for (const requirement of entry.assess?.easeOfValidation
            .requirements ?? [])
            for (const id of requirement.proof)
              if (ULID.test(id)) proofs.add(id);
        const contents = blob.sections.flatMap((section) =>
          section.content === undefined ? [] : [section.content],
        );
        if (contents.length > 0) {
          const facts = {
            text: contents.map((c) => c.facts.text).join(" "),
            cites: [...new Set(contents.flatMap((c) => c.facts.cites))],
          };
          const factsKey = yield* deliveryContent(
            { unit: key, stop: "facts" },
            facts,
          );
          unitEvents.push(
            event(
              "delivery.recorded@1",
              `${uh}:facts`,
              actors.assemble,
              target,
              {
                content: "facts",
                verdictWords: Math.min(1_000, verdictWordsIn(facts.text)),
              },
              [{ ref: `computation:${factsKey}`, role: "content" }],
            ),
          );
        }
        // The unit's lead, as the readers' briefing wrote it: a unit's Briefed stop, whose links
        // resolve as every stop's do. Absent writes none, so the unit's records stay as before.
        if (unit.briefed !== undefined) {
          const briefed = { text: unit.briefed };
          const briefedKey = yield* deliveryContent(
            { unit: key, stop: "briefed" },
            briefed,
          );
          unitEvents.push(
            event(
              "delivery.recorded@1",
              `${uh}:briefed`,
              actors.assemble,
              target,
              {
                content: "briefed",
                verdictWords: Math.min(1_000, verdictWordsIn(briefed.text)),
              },
              [{ ref: `computation:${briefedKey}`, role: "content" }],
            ),
          );
        }
        if (unit.guided !== undefined) {
          const guidedKey = yield* deliveryContent(
            { unit: key, stop: "guided" },
            unit.guided,
          );
          unitEvents.push(
            event(
              "delivery.recorded@1",
              `${uh}:guided`,
              actors.dispose,
              target,
              { content: "guided" },
              [{ ref: `computation:${guidedKey}`, role: "content" }],
            ),
          );
        }
        // Comments, in the caller's rank order; those below the cut stay in the judgements.
        const owned: Array<OwnedRange> = blob.sections.flatMap(
          (s) => s.ownedRanges,
        );
        const comments: Array<{
          id: string;
          built: Built;
          restedOn: boolean;
          kind: string;
        }> = [];
        const withheld = new Map<WithheldReason, number>();
        for (const comment of unit.comments) {
          const cleaned = cleanComment(comment, owned);
          if ("withheld" in cleaned) {
            withheldFates.push({
              id: comment.id,
              unit: uh,
              batch: batchKey,
              fate: "withheld",
              reason: cleaned.withheld,
            });
            if (cleaned.withheld !== "below-the-cut")
              withheld.set(
                cleaned.withheld,
                (withheld.get(cleaned.withheld) ?? 0) + 1,
              );
            continue;
          }
          for (const cited of comment.evidence)
            if (cited.ref.startsWith("event:")) proofs.add(cited.ref.slice(6));
          comments.push({
            id: comment.id,
            restedOn: comment.restedOn,
            kind: comment.kind,
            built: event(
              "comment.recorded@3",
              `${uh}:comment:${short(comment.id)}`,
              actors.dispose,
              on,
              cleaned.payload,
            ),
          });
        }
        for (const [reason, n] of withheld)
          gaps.push({
            base: `${uh}:gap:withheld-${reason}`,
            kind: "comment-withheld",
            detail: `${n === 1 ? "A comment" : `${n} comments`} on "${clipText(title, 200)}" ${n === 1 ? "isn't" : "aren't"} shown, because ${WITHHELD_WORDS[reason]}.`,
            unitIds: [unitId],
          });
        unitEvents.push(...comments.map((c) => c.built));
        if (unit.disposition !== undefined) {
          if (unit.disposition === "approve" && unit.lane === "human-required")
            gaps.push({
              base: `${uh}:gap:approval-withheld`,
              kind: "approval-withheld",
              detail: `An agent's approval of "${clipText(title, 200)}" isn't recorded, because only a person approves human-required work.`,
              unitIds: [unitId],
            });
          else {
            const proof = [
              ...new Set(unit.proof.filter((id) => ULID.test(id))),
            ].slice(0, 64);
            for (const id of proof) proofs.add(id);
            const note =
              unit.message === undefined
                ? ""
                : clipText(unit.message, 4_000, "");
            const rested = comments
              .filter((c) => c.restedOn)
              .map((c) => c.built.id);
            if (
              unit.disposition === "request-changes" &&
              rested.length > RESTS_ON_MAX
            )
              gaps.push(restsOnCut(uh, unitId, title, rested.length));
            unitEvents.push(
              event(
                "disposition.recorded@2",
                `${uh}:disposition`,
                actors.dispose,
                on,
                {
                  verdict: unit.disposition,
                  reviewedHeadOid: plan.run.range.headOid,
                  ...(note === "" ? {} : { note }),
                  // The first 64 in rank order, listed by ID, so the decision never follows the
                  // order its comments arrived in; a cut is said in a gap below.
                  restsOn:
                    unit.disposition === "request-changes"
                      ? sortedKeys(rested.slice(0, RESTS_ON_MAX))
                      : [],
                  proof,
                },
              ),
            );
          }
        }
        // People's decisions on an earlier unit this one is unchanged from carry to it (the owner's
        // ruling), read from the plan, never again from Records' current state.
        const carried = yield* carryDecisions({
          items: plan.carried.filter(
            (item) => item.batch === batchKey && item.unit === key,
          ),
          withheld: (plan.withheld ?? []).filter(
            (item) => item.batch === batchKey && item.unit === key,
          ).length,
          words:
            plan.carryRule !== undefined
              ? plan.carryRule
              : plan.notKnown !== undefined
                ? "last-act"
                : "before",
          notKnown: (plan.notKnown ?? []).some(
            (item) => item.batch === batchKey && item.unit === key,
          ),
          event,
          on,
          head: plan.run.range.headOid,
          lineageId:
            unitEvents.find((e) => e.kind === "lineage.recorded@1")?.id ?? null,
          uh,
          unitId,
          title,
          lane: unit.lane,
          disputedBy:
            unit.disposition === "request-changes" ||
            comments.some((c) => c.kind === "defect")
              ? "changes"
              : undefined,
          earlierById,
          newSections: sections,
          sectionKeys: new Set(unit.sectionKeys),
        });
        unitEvents.push(...carried.events);
        gaps.push(...carried.gaps);
        carriedCounts.dispositions += carried.dispositions;
        carriedCounts.comments += carried.comments;
        for (const [cause, n] of Object.entries(undecided).sort())
          gaps.push({
            base: `${uh}:gap:${UNDECIDED_GAP_PREFIX}${cause}`,
            kind: `${UNDECIDED_GAP_PREFIX}${cause}`,
            detail: UNDECIDED_LINE(title, n, blob.sections.length),
            unitIds: [unitId],
          });
        events.push(...unitEvents);
        unitEntries.push({
          entry: {
            unit: uh,
            unitId,
            path: unit.path,
            key,
            lane: unit.lane,
            sections: blob.sections.length,
            undecided,
          },
          events: unitEvents,
          comments,
        });
        added.units += 1;
        added.sections += blob.sections.length;
        for (const [cause, n] of Object.entries(undecided))
          added.undecided[cause] = (added.undecided[cause] ?? 0) + n;
      }
      // The batch's index for the reader, its digest, then its references.
      const index =
        (batch.references ?? []).length === 0
          ? undefined
          : yield* deliveryContent(
              { batch: batchKey, stop: "index" },
              indexOf(
                batch,
                units.map(({ key }) => unitHandle(key)),
              ),
            );
      // A digest that names its source (the readers' briefing step) is counted over all its prose
      // and carries its obligations, each unit by its published handle, in the units' order. One
      // that names none is the earlier input, written as before, so a plan stored before the
      // fields were added writes the same bytes.
      const callerUnitOrder = new Map(
        callerUnitKey.map((key) => [
          key,
          units.findIndex((unit) => unit.key === key),
        ]),
      );
      const obligations = batch.digest.obligations?.map((obligation) => ({
        row: obligation.row,
        text: obligation.text,
        ...(obligation.basis === undefined ? {} : { basis: obligation.basis }),
        overall: obligation.overall,
        units: [...obligation.units]
          .sort(
            (a, b) =>
              callerUnitOrder.get(callerUnitKey[a.unit]!)! -
              callerUnitOrder.get(callerUnitKey[b.unit]!)!,
          )
          .map((named) => ({
            unit: unitHandle(callerUnitKey[named.unit]!),
            status: named.status,
            required: named.required,
          })),
      }));
      const digest = {
        batchId: bh,
        source: batch.digest.source ?? "code",
        digest: batch.digest.text,
        verification: batch.digest.verification ?? "",
        uncertainty: batch.digest.uncertainty ?? [],
        limitations: batch.digest.limitations ?? [],
        verdictWords: verdictWordsIn(
          batch.digest.source === undefined
            ? batch.digest.text
            : [
                batch.digest.text,
                ...(batch.digest.uncertainty ?? []),
                ...(batch.digest.limitations ?? []),
              ].join("\n"),
        ),
        ...(obligations === undefined ? {} : { obligations }),
      };
      const digestKey = yield* deliveryContent(
        { batch: batchKey, stop: "batch-digest" },
        digest,
      );
      const batchEvents: Array<Built> = [
        events[0]!,
        event(
          "delivery.recorded@1",
          `${bh}:digest`,
          actors.assemble,
          { cycleId: ctx.cycleId, batchId },
          {
            content: "batch-digest",
            verdictWords: Math.min(1_000, digest.verdictWords),
          },
          [{ ref: `computation:${digestKey}`, role: "content" }],
        ),
      ];
      // A reference names units by key or handle; `referenceEvent` reads only their IDs and batch.
      const byName = new Map<string, string>();
      for (const { key } of units) {
        byName.set(key, key);
        byName.set(unitHandle(key), key);
      }
      const unpublished = new Map<string, number>();
      for (const reference of batch.references ?? []) {
        const local = {
          ...reference,
          unitIds: reference.unitIds.flatMap((name) =>
            byName.has(name) ? [byName.get(name)!] : [],
          ),
        };
        const built = referenceEvent(
          local,
          local.unitIds.map(
            (id) => ({ id, batchId: bh }) as unknown as AssembledUnit,
          ),
          unitIdOf,
          new Map([[bh, batchId]]),
          ctx,
        );
        if (built === undefined) {
          const reason = unpublishedReason(local, unitIdOf) ?? "anchor";
          unpublished.set(reason, (unpublished.get(reason) ?? 0) + 1);
          continue;
        }
        batchEvents.push(
          event(
            "context.referenced@2",
            `${bh}:reference:${reference.id}`,
            actors.assemble,
            built.attribution,
            built.payload,
            [{ ref: `computation:${index!}`, role: "content" }],
          ),
        );
      }
      for (const [reason, n] of unpublished)
        gaps.push({
          base: `${bh}:gap:references-${reason}`,
          kind: "reference-not-published",
          detail: `${n === 1 ? "A context source" : `${n} context sources`} of "${clipText(batch.title, 200)}" ${n === 1 ? "isn't" : "aren't"} shown beside the code, nor ${n === 1 ? "its note" : "their notes"} on why ${n === 1 ? "it applies" : "they apply"} and what to check before deciding.`,
        });
      const gapEvents = gaps.map(gapEvent);
      const all = [
        events[0]!,
        ...events.slice(1),
        ...batchEvents.slice(1),
        ...gapEvents,
      ];
      const appended = yield* appendSettled(ctx, all, gapEvent, bh);
      if (appended.fellBack) fellBack = true;
      const idOf = new Map<string, string | null>();
      const accepted = new Set<string>();
      for (const [i, built] of all.entries()) {
        idOf.set(built.idempotencyKey, appended.ids[i] ?? null);
        if (appended.accepted[i]) accepted.add(built.idempotencyKey);
      }
      for (const gap of gaps) logGap(gap);
      const named = (built: Built) => ({
        kind: built.kind,
        key: built.idempotencyKey.slice(namespace.length),
        id: idOf.get(built.idempotencyKey) ?? null,
      });
      for (const unit of unitEntries)
        for (const comment of unit.comments) {
          const id = idOf.get(comment.built.idempotencyKey) ?? null;
          fates.push(
            id !== null && accepted.has(comment.built.idempotencyKey)
              ? {
                  id: comment.id,
                  unit: String(unit.entry["unit"]),
                  batch: batchKey,
                  fate: "published",
                  publicationId: id,
                }
              : {
                  id: comment.id,
                  unit: String(unit.entry["unit"]),
                  batch: batchKey,
                  fate: "withheld",
                  reason:
                    id === null ? "comment-refused" : "comment-kept-earlier",
                },
          );
        }
      fates.push(...withheldFates);
      const batchGaps = [
        ...gapEvents.flatMap((built) => {
          const id = idOf.get(built.idempotencyKey);
          return typeof id === "string"
            ? [
                {
                  id,
                  kind: String((built["payload"] as { kind: string }).kind),
                },
              ]
            : [];
        }),
        ...appended.disclosed.flatMap(({ built, id }) =>
          id === null
            ? []
            : [
                {
                  id,
                  kind: String((built["payload"] as { kind: string }).kind),
                },
              ],
        ),
      ];
      entries.push({
        batch: bh,
        batchId,
        key: batchKey,
        ...(index === undefined ? {} : { assembled: `computation:${index}` }),
        units: unitEntries.map((unit) => ({
          ...unit.entry,
          events: unit.events.map(named),
        })),
        events: batchEvents.map((built) => ({
          ...named(built),
          base: built.base,
          hash: eventHash(strip(built)),
        })),
        gaps: batchGaps,
        publishedBy: { runId: plan.run.runId, ordinal: plan.ordinal },
      });
      added.batches += 1;
    }
    if (stop === "batches")
      return yield* Effect.die(new Error("stopped after the batches (test)"));

    // The publication's own gaps: the run's, keyed by its base, and, for a packet, the newest held
    // refusal of each batch its manifest does not hold, as its plan fixed them.
    const planBase = planBaseOf(plan.base, plan.staged);
    const ownGaps: Array<Gap> = [
      ...plan.gaps.map((gap) => ({
        base: `gap:${planBase}:run:${short(gap.key)}`,
        kind: gap.kind,
        detail: gap.detail,
        cause: gap.cause,
      })),
    ];
    const ownBuilt = ownGaps.map(gapEvent);
    const ownIds: Array<{ id: string; kind: string }> = (
      plan.kind === "packet" ? plan.heldGaps : []
    ).map(({ id }) => ({ id, kind: "batch-not-published" }));
    for (const built of ownBuilt) {
      const one = yield* Effect.result(Log.append([strip(built)]));
      const id =
        one._tag === "Success"
          ? (one.success[0]?.id ?? null)
          : ((one.failure as { existingEventId?: string }).existingEventId ??
            null);
      if (id !== null)
        ownIds.push({
          id,
          kind: String((built["payload"] as { kind: string }).kind),
        });
    }
    for (const gap of ownGaps) logGap(gap);
    const gapSignature = runGapSignature(plan.gaps);
    const promotions = yield* Proofs.promoteCited([...proofs]);
    const promoted = promotions.filter((p) => p.result === "promoted").length;

    if (plan.kind === "stage")
      return {
        kind: "stage",
        ordinal: plan.ordinal,
        packetId: null,
        manifest: null,
        batches: entries,
        gaps: ownIds,
        gapSignature,
        complete: false,
        counts: countsOf(
          [...chain.packetBatches, ...chain.stagedBatches, ...entries],
          [],
          plan.totals,
        ),
        added,
        fates,
        fellBack,
        closure: {},
        promoted,
        matched: [...matched],
        unmatched: [],
        carried: carriedCounts,
        held: [],
      } satisfies Written;

    // The packet: the previous packet's batches verbatim, then what was staged, then the new ones.
    const batches = [
      ...chain.packetBatches,
      ...chain.stagedBatches,
      ...entries,
    ];
    const gaps = [...chain.stagedGaps, ...ownIds];
    const counts = countsOf(batches, gaps, plan.totals);
    const stagedAdded = countsOf(chain.stagedBatches, [], {
      batches: 0,
      sections: 0,
    });
    const addedAll: Added = {
      batches: added.batches + stagedAdded.batches,
      units: added.units + stagedAdded.units,
      sections: added.sections + stagedAdded.sections,
      undecided: { ...stagedAdded.undecided },
    };
    for (const [cause, n] of Object.entries(added.undecided))
      addedAll.undecided[cause] = (addedAll.undecided[cause] ?? 0) + n;
    // A packet that names a batch as still missing is never complete, whatever the counts say.
    const complete = isComplete({
      ending: plan.ending,
      pending: counts.pending,
      heldNamed: plan.heldGaps.length,
      stagesOk: plan.stagesOk,
      fellBack: fellBack || chain.fellBack,
    });
    const allMatched = new Set([...chain.matched, ...matched]);
    const unmatched = plan.ending
      ? sortedKeys(
          earlier
            .flatMap((set) => set.units.map((unit) => unit.unitId))
            .filter((id) => !allMatched.has(id)),
        )
      : [];
    const manifest = {
      version: MANIFEST_VERSION,
      run: {
        runId: plan.run.runId,
        runKey: ctx.runKey,
        cycleId: ctx.cycleId,
        range: plan.run.range,
      },
      route: plan.run.route,
      config: plan.run.config,
      complete,
      supersedes: plan.supersedes,
      sequence: { runKey: ctx.runKey, ordinal: plan.ordinal, base: plan.base },
      batches,
      gaps,
      counts,
      ...(unmatched.length === 0 ? {} : { unmatched }),
    };
    const blobs = yield* Blobs.BlobStore;
    const manifestBlob = yield* blobs.put({
      bytes: new TextEncoder().encode(canonicalJson(manifest)),
      mediaType: "application/json",
      retention: "durable",
    });
    if (stop === "manifest")
      return yield* Effect.die(new Error("stopped before the packet (test)"));
    // Keyed by the packet it follows as well as its batches: a publication that adds no batch
    // (an ending call, a run gap) is still a new packet, never the one before it. The base is in
    // the stored plan, so a replay keys it the same.
    const packetKey = `${namespace}packet:${sha256Hex(canonicalJson({ follows: plan.base ?? "root", batches }))}`;
    const packet = {
      id:
        held.get(packetKey) ??
        stableUlid(plan.clock, CLASS["packet.published@2"]!, packetKey),
      kind: "packet.published@2",
      idempotencyKey: packetKey,
      actor: actors.publish,
      occurredAt,
      attribution: {
        cycleId: ctx.cycleId,
        range: plan.run.range,
        runId: plan.run.runId,
      },
      payload: { complete, ordinal: plan.ordinal, counts, added: addedAll },
      refs: [{ ref: `blob:${manifestBlob.blob.hash}`, role: "manifest" }],
      ...(plan.supersedes === null
        ? {}
        : { causation: { supersedes: plan.supersedes } }),
    };
    const appended = yield* Effect.result(Log.append([packet]));
    const packetId =
      appended._tag === "Success"
        ? (appended.success[0]?.id ?? packet.id)
        : appended.failure._tag === "IdempotencyConflict"
          ? appended.failure.existingEventId
          : yield* Effect.fail(appended.failure);
    if (packetId === plan.base)
      return yield* new PublicationChainBroken({
        message: `the publication planned on ${plan.base} would name that packet as its own`,
        retryable: false,
      });
    if (stop === "packet")
      return yield* Effect.die(
        new Error("stopped after the packet, before its writing (test)"),
      );
    const closure: Record<string, number> = {};
    for (const batch of batches)
      for (const unit of (batch["units"] as ReadonlyArray<{
        unitId: string;
      }>) ?? []) {
        const judged = yield* Dispositions.judge(unit.unitId);
        const label = judged.closed ? "closed" : `needs ${judged.needs}`;
        closure[label] = (closure[label] ?? 0) + 1;
      }
    ctx.log.write({
      type: "publish",
      publisher: "sections",
      manifest: manifestBlob.blob.hash,
      packetEventId: packetId,
      ordinal: plan.ordinal,
      complete,
      counts,
      supersedes: plan.supersedes,
    });
    return {
      kind: "packet",
      ordinal: plan.ordinal,
      packetId,
      manifest: manifestBlob.blob.hash,
      batches,
      gaps: ownIds,
      gapSignature,
      complete,
      counts,
      added: addedAll,
      fates,
      fellBack,
      closure,
      promoted,
      matched: [...matched],
      unmatched,
      carried: carriedCounts,
      held: plan.heldGaps.map(({ id }) => id),
    } satisfies Written;
  });

/** A manifest's counts: what its batches hold, its gaps, and what is still pending of the totals. */
const countsOf = (
  batches: ReadonlyArray<Record<string, unknown>>,
  gaps: ReadonlyArray<{ readonly id: string }>,
  totals: SettledInput["totals"],
): Counts => {
  const counts: Counts = {
    batches: batches.length,
    units: 0,
    sections: 0,
    contextReferences: 0,
    assessments: 0,
    deliveries: 0,
    dispositions: 0,
    comments: 0,
    gaps: 0,
    pending: { batches: 0, sections: 0 },
    undecided: {},
  };
  const gapIds = new Set(gaps.map((gap) => gap.id));
  for (const batch of batches) {
    type Named = { kind?: string; id?: string | null };
    const units = (batch["units"] ?? []) as ReadonlyArray<{
      sections?: number;
      undecided?: Record<string, number>;
      events?: ReadonlyArray<Named>;
    }>;
    const events = [
      ...((batch["events"] ?? []) as ReadonlyArray<Named>),
      ...units.flatMap((unit) => unit.events ?? []),
    ].filter((e) => typeof e.id === "string");
    for (const gap of (batch["gaps"] ?? []) as ReadonlyArray<{ id: string }>)
      gapIds.add(gap.id);
    counts.units += units.length;
    for (const unit of units) {
      counts.sections += unit.sections ?? 0;
      for (const [cause, n] of Object.entries(unit.undecided ?? {}))
        counts.undecided[cause] = (counts.undecided[cause] ?? 0) + n;
    }
    for (const e of events)
      switch (e.kind) {
        case "context.referenced@2":
          counts.contextReferences += 1;
          break;
        case "assessment.recorded@4":
          counts.assessments += 1;
          break;
        case "delivery.recorded@1":
          counts.deliveries += 1;
          break;
        case "disposition.recorded@2":
          counts.dispositions += 1;
          break;
        case "comment.recorded@3":
          counts.comments += 1;
          break;
      }
  }
  counts.gaps = gapIds.size;
  counts.pending = {
    batches: Math.max(0, totals.batches - counts.batches),
    sections: Math.max(0, totals.sections - counts.sections),
  };
  return counts;
};

// ---------------------------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------------------------

/** What a call published, in the shape `recordPublishStage` and the receipt read today. */
export interface SectionsPublishSummary {
  /** The newest manifest this call published or found, by blob hash. */
  readonly manifest: string | null;
  readonly packetEventId: string | null;
  readonly complete: boolean;
  readonly counts: Counts;
  readonly closure: Record<string, number>;
  readonly promoted: number;
  /** Each of the call's comments by the caller's own ID, with its unit's handle. */
  readonly findings: ReadonlyArray<Fate>;
  /** The publication's ordinal; null when the call wrote no packet. */
  readonly ordinal: number | null;
  /** What is still being judged of the review's totals. */
  readonly pending: { readonly batches: number; readonly sections: number };
  /** Every publication that holds this call's batches, oldest first. */
  readonly publications: ReadonlyArray<{
    readonly ordinal: number;
    readonly packetEventId: string | null;
    readonly manifest: string | null;
    readonly kind: "packet" | "stage";
  }>;
  /** Batches handed in again that a packet already holds: not written again. */
  readonly frozen: ReadonlyArray<string>;
  /** Batches a check refused: unpublished and still pending. */
  readonly refused: ReadonlyArray<{
    readonly batch: string;
    readonly check: string;
  }>;
  /**
   * People's decisions carried onto this call's unchanged units, and the comments they rest on:
   * apart from this review's own, which `counts` holds.
   */
  readonly carried: {
    readonly dispositions: number;
    readonly comments: number;
  };
}

/** The call's own signature: its batches by key, totals, ending and gaps. */
const callSignature = (input: SettledInput) =>
  sha256Hex(
    canonicalJson({
      batches: input.batches.map((batch) => sha256Hex(canonicalJson(batch))),
      totals: input.totals,
      ending: input.ending,
      gaps: input.gaps,
    }),
  );

/**
 * Publishes the settled batches of a new-shape review (the contract's `publishSettled`). Each
 * publication runs as shared work keyed by the cycle, the run key and its place in the run's
 * chain, so a replay or a second caller repeats nothing. Calls within one run may overlap: a call
 * that loses a place subscribes to the winner's plan and plans at the next place with what is
 * still unpublished. That holds when each call hands every batch settled so far, and the ending
 * call comes after every other call of the run has returned. A call whose passes run out returns
 * its unpublished batches as refused with check `pending`, and a later call publishes them. The
 * input is checked at the door: one that does not decode is refused whole
 * (`SettledInputRefused`) and writes nothing.
 */
export const publishSettled = (ctx: PublishContext, input: SettledInput) =>
  publishCall(ctx, input, undefined);

/**
 * `publishSettled` stopped at one point inside a publication, as a crash there would leave it: for
 * the replay tests only. No review calls it.
 */
export const publishSettledForTest = (
  ctx: PublishContext,
  input: SettledInput,
  stop: PublicationStop,
) => publishCall(ctx, input, stop);

const publishCall = (
  ctx: PublishContext,
  raw: unknown,
  stop: PublicationStop | undefined,
) =>
  Effect.gen(function* () {
    const decoded = SettledInput.safeParse(raw);
    if (!decoded.success)
      return yield* new SettledInputRefused({
        message: `${decoded.error.issues[0]?.path.join(".") ?? ""}: ${decoded.error.issues[0]?.message ?? decoded.error.message}`,
        retryable: false,
      });
    const input = decoded.data;
    const now = yield* Clock.currentTimeMillis;
    if (ctx.startedAt > now + 60_000)
      return yield* new PublishClockRefused({
        message: `the run's start ${new Date(ctx.startedAt).toISOString()} is more than a minute ahead of this clock`,
        retryable: false,
      });
    const store = yield* Computations.ComputationStore;
    const epochRead = yield* store.run(
      {
        op: "harness.publish-epoch",
        opVersion: 1,
        inputs: { cycle: ctx.cycleId, runKey: ctx.runKey },
      },
      Effect.succeed(json({ at: ctx.startedAt })),
    );
    const epoch = parsed<{ at: number }>(epochRead.output).at;
    const session = `review:${ctx.cycleId}:${ctx.runKey}`;
    const occurredAt = new Date(now).toISOString();
    yield* appendTelemetry(ctx.log, [
      harnessRegistration(session, "link", occurredAt),
      harnessRegistration(session, "publish", occurredAt),
    ]);
    const call = callSignature(input);
    const stagesOk = !input.stages.some(
      (stage) => stage.status === "interrupted" || stage.status === "skipped",
    );
    const write = (planKey: string, plan: Plan, chain: Chain) =>
      Effect.map(
        store.run(
          writeSpec(planKey),
          Effect.map(writePublication(ctx, plan, chain, epoch, stop), json),
        ),
        (result) => parsed<Written>(result.output),
      );
    let handled = false;
    const refusedNow = new Map<string, string>();
    for (let guard = 0; guard < input.batches.length + 8; guard++) {
      const { chain, open } = yield* walk(ctx.cycleId, ctx.runKey);
      if (open !== undefined) {
        yield* write(open.key, open.plan, chain);
        if (open.plan.call === call) handled = true;
        continue;
      }
      if (handled) break;
      // What this call adds: its batches the sequence does not hold, each checked.
      const seen = new Set<string>();
      const fresh: Array<SettledBatch> = [];
      const refused: Array<RefusedBatch> = [];
      for (const batch of input.batches) {
        const key = batchKeyOf(batch.paths);
        if (chain.frozen.has(key)) continue;
        const failed: Refusal | undefined = seen.has(key)
          ? {
              check: "batch-repeated",
              reason: "another batch of this call holds the same files",
              cause: `batch ${batchHandle(key)} is handed in twice`,
            }
          : checkBatch(batch);
        seen.add(key);
        if (failed === undefined) fresh.push(batch);
        else
          refused.push({
            key,
            paths: sortedKeys(batch.paths),
            title: batch.title,
            ...failed,
          });
      }
      const ownPacket = chain.lastPacket !== undefined;
      // Every refusal is held at once, by batch and check; each packet names the newest held
      // refusal of every batch it does not publish, so none is lost to timing.
      if (refused.length > 0)
        yield* holdRefusals(ctx, chain, refused, refusedNow);
      const published = publishedFiles(chain, []);
      const pendingHeld = yield* heldPending(ctx, published);
      // An ending call that adds no batch writes a packet only when it would say something the
      // last packet does not: its completeness, the refusals it names, its run gaps, what is
      // pending, or that the review ended. Equal means nothing is written, so a repeat is quiet.
      const pending = countsOf(
        [...chain.packetBatches, ...chain.stagedBatches],
        [],
        input.totals,
      ).pending;
      const lastPlan = [...chain.publications]
        .reverse()
        .find(({ written }) => written.kind === "packet")?.plan;
      const says = (state: {
        complete: boolean;
        held: ReadonlyArray<string>;
        gaps: string;
        pending: { batches: number; sections: number };
        ending: boolean;
      }) => canonicalJson(state);
      const endingChange =
        input.ending &&
        (!ownPacket ||
          chain.stagedBatches.length > 0 ||
          says({
            complete: isComplete({
              ending: true,
              pending,
              heldNamed: pendingHeld.length,
              stagesOk,
              fellBack: chain.fellBack,
            }),
            held: pendingHeld.map(({ id }) => id),
            gaps: runGapSignature(input.gaps),
            pending,
            ending: true,
          }) !==
            says({
              complete: chain.lastPacket!.complete,
              held: chain.lastPacket!.held ?? [],
              gaps: chain.lastPacket!.gapSignature,
              pending: chain.lastPacket!.counts.pending,
              ending: lastPlan?.ending ?? false,
            }));
      // Nothing to publish: a refusal held now is named by the sequence's next packet, the
      // ending one at the latest.
      if (fresh.length === 0 && !endingChange) break;
      for (const r of refused) refusedNow.set(r.key, r.check);
      const spec = planSpec(ctx.cycleId, ctx.runKey, chain.base, chain.staged);
      const planned = yield* store.run(
        spec,
        Effect.gen(function* () {
          const decidedAt = yield* Clock.currentTimeMillis;
          const standing =
            (yield* PublishedPackets.standingPacketId(ctx.cycleId)) ?? null;
          let mode = chain.mode;
          let lineage = chain.lineage;
          if (mode === undefined) {
            // The sequence's first plan: whether another sequence stands in the cycle, and which
            // packets its units are compared with, decided once.
            mode = standing === null ? "first" : "later";
            lineage = [
              ...(yield* Lineage.earlierReview({
                cycleId: ctx.cycleId,
                isAncestor: gitIsAncestor(ctx.repository),
              })),
            ];
          }
          // A later sequence appends its batches with no packet until its ending call (or once
          // its own packet stands); the first sequence of a cycle publishes on every call.
          const staging = !input.ending && mode === "later" && !ownPacket;
          const supersedes = staging ? null : standing;
          // Which people's decisions carry: read now, once, and stored with the plan.
          const { carried, withheld, notKnown } = yield* decisionsToCarry(
            fresh,
            lineage ?? [],
          );
          // Which held refusals the packet names: read now, once, for the batches it won't hold.
          const heldGaps = staging
            ? []
            : yield* heldPending(ctx, publishedFiles(chain, fresh));
          const clock = Math.max(
            decidedAt,
            supersedes === null ? 0 : ulidTime(supersedes) + 1,
            chain.base === null ? 0 : ulidTime(chain.base) + 1,
          );
          return json({
            version: PLAN_VERSION,
            kind: staging ? "stage" : "packet",
            mode,
            lineage: lineage ?? [],
            base: chain.base,
            staged: chain.staged,
            ordinal: (chain.lastPacket?.ordinal ?? 0) + 1,
            clock,
            supersedes,
            run: {
              runId: ctx.runId,
              range: ctx.range,
              route: {
                provider: ctx.config.route.provider,
                model: ctx.config.route.model,
                effort: ctx.config.route.effort,
              },
              config: publishedConfig(ctx.config),
            },
            batches: fresh,
            refused,
            gaps: input.gaps,
            totals: input.totals,
            ending: input.ending,
            stagesOk,
            call,
            carried,
            withheld,
            notKnown,
            carryRule: "shared-change",
            heldGaps,
          } satisfies Plan);
        }),
      );
      if (stop === "plan")
        return yield* Effect.die(new Error("stopped after the plan (test)"));
      const plan = parsed<Plan>(planned.output);
      yield* write(planned.computation.key, plan, chain);
      if (plan.call === call) handled = true;
    }
    return yield* summaryOf(ctx, input, refusedNow);
  }).pipe(
    Effect.withSpan("harness.publish.sections", {
      attributes: { "neuve.cycle.id": ctx.cycleId, "neuve.run.id": ctx.runId },
    }),
  );

/**
 * Holds each refusal of this call as the next in its batch's series (`REFUSED_PREFIX`): when the
 * series' last says the same (the same check of the same batch under the same title), it is the
 * same refusal and nothing is appended, so a repeat or a follow-on run writes nothing new. Two
 * holders that pick the same number with different texts conflict in Records, and the one that
 * loses reads the series again. The batch's files are stored once beside it (`batchPathsSpec`).
 */
const holdRefusals = (
  ctx: PublishContext,
  chain: Chain,
  refused: ReadonlyArray<RefusedBatch>,
  refusedNow: Map<string, string>,
) =>
  Effect.gen(function* () {
    const namespace = `review:${ctx.cycleId}:${ctx.runKey}:`;
    const store = yield* Computations.ComputationStore;
    const clock = Math.max(
      yield* Clock.currentTimeMillis,
      chain.base === null ? 0 : ulidTime(chain.base) + 1,
    );
    const actor = harnessActor(
      `review:${ctx.cycleId}:${ctx.runKey}`,
      "publish",
    );
    for (const r of refused) {
      refusedNow.set(r.key, r.check);
      yield* store.run(
        batchPathsSpec(r.key),
        Effect.succeed(json({ paths: r.paths })),
      );
      const gap = refusalGap(r);
      const payload = { kind: gap.kind, detail: clipText(gap.detail, 2_000) };
      for (let attempt = 0; attempt <= REFUSED_MAX + 1; attempt++) {
        const series = yield* refusalSeries(ctx, r.key);
        const last = series.at(-1);
        if (last !== undefined) {
          const held = yield* Log.get(last.id);
          const said =
            Option.isSome(held) && held.value.event.kind === "gap.disclosed@1"
              ? held.value.event.payload.detail
              : undefined;
          if (said === payload.detail) break;
        }
        if (series.length >= REFUSED_MAX) break;
        const key = `${namespace}${refusedKey(r.key, (last?.n ?? 0) + 1)}`;
        const appended = yield* Effect.result(
          Log.append([
            {
              id: stableUlid(clock, CLASS["gap.disclosed@1"]!, key),
              kind: "gap.disclosed@1",
              idempotencyKey: key,
              actor,
              occurredAt: new Date(clock).toISOString(),
              attribution: {
                cycleId: ctx.cycleId,
                range: ctx.range,
                runId: ctx.runId,
                stage: "publish",
              },
              payload,
            },
          ]),
        );
        if (appended._tag === "Success") break;
        // Another holder took this number: read the series again.
        if (appended.failure._tag !== "IdempotencyConflict")
          return yield* Effect.fail(appended.failure);
      }
      ctx.log.write({
        type: "gap",
        stage: "publish",
        agent: "publish",
        kind: gap.kind,
        detail: gap.detail,
        cause: gap.cause,
      });
    }
  });

/** A batch's held refusals, in their order in its series. */
const refusalSeries = (ctx: PublishContext, batch: string) =>
  Effect.gen(function* () {
    const prefix = `review:${ctx.cycleId}:${ctx.runKey}:${REFUSED_PREFIX}${batch}:`;
    return (yield* keyedIds(prefix))
      .map((row) => ({ id: row.id, n: Number(row.key.slice(prefix.length)) }))
      .filter((row) => Number.isInteger(row.n) && row.n >= 1)
      .sort((a, b) => a.n - b.n);
  });

/** The files the packet planned on `chain` holds, with `fresh` added: what is no longer missing. */
const publishedFiles = (chain: Chain, fresh: ReadonlyArray<SettledBatch>) => {
  const keys = new Set(
    [...chain.packetBatches, ...chain.stagedBatches].map((batch) =>
      String(batch["key"]),
    ),
  );
  const files = new Set<string>();
  for (const { plan } of chain.publications)
    for (const batch of plan.batches)
      if (keys.has(batchKeyOf(batch.paths)))
        for (const path of batch.paths) files.add(path);
  for (const batch of fresh) {
    keys.add(batchKeyOf(batch.paths));
    for (const path of batch.paths) files.add(path);
  }
  return { files, keys };
};

/**
 * The last held refusal of each batch of the sequence with a file that `published` does not hold:
 * what a packet names as still missing. A refusal is about files, so once every file of a refused
 * batch is in the packet, under whatever batch key, it is not named; one still refused is named
 * by every packet until its files are published.
 */
const heldPending = (
  ctx: PublishContext,
  published: {
    readonly files: ReadonlySet<string>;
    readonly keys: ReadonlySet<string>;
  },
) =>
  Effect.gen(function* () {
    const prefix = `review:${ctx.cycleId}:${ctx.runKey}:${REFUSED_PREFIX}`;
    const last = new Map<string, { n: number; id: string }>();
    for (const row of yield* keyedIds(prefix)) {
      const [batch, number] = row.key.slice(prefix.length).split(":");
      const n = Number(number);
      if (batch === undefined || !Number.isInteger(n)) continue;
      const known = last.get(batch);
      if (known === undefined || n > known.n)
        last.set(batch, { n, id: row.id });
    }
    const pending: Array<{ batch: string; id: string }> = [];
    for (const [batch, { id }] of [...last].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const stored = yield* storedOutput<{ paths: ReadonlyArray<string> }>(
        batchPathsSpec(batch),
      );
      // Files when they can be read; when they cannot (pruned), the batch's own key.
      const paths = stored?.value.paths ?? [];
      const present =
        paths.length > 0
          ? paths.every((path) => published.files.has(path))
          : published.keys.has(batch);
      if (present) continue;
      pending.push({ batch, id });
    }
    return pending;
  });

/** The call's summary, from the chain as it now stands: replaying a call reads the same one. */
const summaryOf = (
  ctx: PublishContext,
  input: SettledInput,
  refusedNow: ReadonlyMap<string, string> = new Map(),
) =>
  Effect.gen(function* () {
    const { chain } = yield* walk(ctx.cycleId, ctx.runKey);
    // A batch is this call's when a publication holds it as handed in; one handed in with other
    // content than its publication holds is frozen, not written again. Replays read the same.
    const contentOf = (batch: SettledBatch) =>
      sha256Hex(canonicalJson(JSON.parse(JSON.stringify(batch)) as unknown));
    const handed = new Set(input.batches.map(contentOf));
    const call = callSignature(input);
    const involved = chain.publications.filter(
      ({ plan }) =>
        plan.call === call ||
        plan.batches.some((batch) => handed.has(contentOf(batch))),
    );
    const publishedAs = new Map<string, string>();
    for (const { plan } of chain.publications)
      for (const batch of plan.batches)
        publishedAs.set(batchKeyOf(batch.paths), contentOf(batch));
    const newest = involved.at(-1)?.written;
    const packet = [...involved]
      .reverse()
      .find(({ written }) => written.kind === "packet")?.written;
    const shown = packet ?? chain.lastPacket ?? newest;
    const findings: Array<Fate> = [];
    const frozen: Array<string> = [];
    const refused: Array<{ batch: string; check: string }> = [];
    for (const batch of input.batches) {
      const key = batchKeyOf(batch.paths);
      const fates = chain.fates.get(key);
      if (publishedAs.has(key) && publishedAs.get(key) !== contentOf(batch))
        frozen.push(batchHandle(key));
      if (fates !== undefined) {
        // Fates of the comments as first published; a comment handed in that the batch never held
        // is withheld as frozen.
        for (const unit of batch.units)
          for (const comment of unit.comments) {
            const fate = fates.find(
              (f) =>
                f.id === comment.id && f.unit === unitHandle(unitKeyOf(unit)),
            );
            findings.push(
              fate === undefined
                ? {
                    id: comment.id,
                    unit: unitHandle(unitKeyOf(unit)),
                    fate: "withheld",
                    reason: "batch-frozen",
                  }
                : (({ batch: _b, ...rest }) => rest)(
                    fate as Fate & { batch?: string },
                  ),
            );
          }
        continue;
      }
      const refusal = [...involved]
        .reverse()
        .flatMap(({ plan }) => plan.refused)
        .find((r) => r.key === key);
      // This call's own refusal first: an earlier plan's is about what an earlier call handed in.
      refused.push({
        batch: batchHandle(key),
        check: refusedNow.get(key) ?? refusal?.check ?? "pending",
      });
      for (const unit of batch.units)
        for (const comment of unit.comments)
          findings.push({
            id: comment.id,
            unit: unitHandle(unitKeyOf(unit)),
            fate: "withheld",
            reason: "batch-refused",
          });
    }
    const counts =
      shown?.counts ??
      countsOf(
        [...chain.packetBatches, ...chain.stagedBatches],
        [],
        input.totals,
      );
    const summary: SectionsPublishSummary = {
      manifest: packet?.manifest ?? null,
      packetEventId: packet?.packetId ?? null,
      complete: packet?.complete ?? false,
      counts,
      closure: packet?.closure ?? {},
      promoted: involved.reduce((n, { written }) => n + written.promoted, 0),
      findings,
      ordinal: packet?.ordinal ?? null,
      pending: counts.pending,
      publications: involved.map(({ written }) => ({
        ordinal: written.ordinal,
        packetEventId: written.packetId,
        manifest: written.manifest,
        kind: written.kind,
      })),
      frozen,
      refused,
      carried: {
        dispositions: involved.reduce(
          (n, { written }) => n + written.carried.dispositions,
          0,
        ),
        comments: involved.reduce(
          (n, { written }) => n + written.carried.comments,
          0,
        ),
      },
    };
    return summary;
  });

// ---------------------------------------------------------------------------------------------
// For the interrupted-publish check (`handler.ts`)
// ---------------------------------------------------------------------------------------------

/**
 * The batches a run appended under this publisher that no packet of its sequence names: those of
 * the run's plans whose packet was never written (a stop partway, or a later sequence's staged
 * batches before its ending), each with the batch event Records holds. Empty when every batch the
 * run appended is in a packet, or the run published through `publishPacket`. "In a packet" is what
 * the stored writings say and what the sequence's newest packet holds: a packet is appended before
 * the rest of its writing's compute, so a drop there leaves the packet standing with no writing.
 * When that packet or its manifest cannot be read, the stored writings alone decide: this check
 * adds no failure of its own.
 */
export const unpublishedBatches = (input: {
  readonly cycleId: string;
  readonly runKey: string;
  readonly runId: string;
}) =>
  Effect.gen(function* () {
    const namespace = `review:${input.cycleId}:${input.runKey}:`;
    const { chain, open } = yield* walk(input.cycleId, input.runKey);
    const sql = yield* SqlClient;
    // A packet is cumulative, so the sequence's newest one holds every batch it published.
    const newest = yield* Effect.result(
      Effect.gen(function* () {
        const prefix = `${namespace}packet:`;
        const [row] = yield* sql<{ id: string }>`SELECT id FROM events
          WHERE kind = 'packet.published@2' AND idempotency_key >= ${prefix}
            AND idempotency_key < ${`${prefix}\u{10FFFF}`} ORDER BY seq DESC LIMIT 1`;
        return row === undefined ? undefined : yield* packetManifest(row.id);
      }),
    );
    const inPackets = new Set([
      ...chain.packetBatches.map((batch) => String(batch["key"])),
      ...(newest._tag === "Success"
        ? (newest.success?.manifest.batches ?? [])
        : []
      ).flatMap((batch) => (batch.key === undefined ? [] : [batch.key])),
    ]);
    const plans = [
      ...chain.publications
        .filter(({ written }) => written.kind === "stage")
        .map(({ plan }) => plan),
      ...(open === undefined ? [] : [open.plan]),
    ].filter((plan) => plan.run.runId === input.runId);
    const found: Array<{ batch: string; batchKey: string; eventId: string }> =
      [];
    for (const plan of plans)
      for (const batch of plan.batches) {
        const key = batchKeyOf(batch.paths);
        if (inPackets.has(key)) continue;
        const prefix = `${namespace}${batchHandle(key)}#`;
        const [row] = yield* sql<{ id: string }>`SELECT id FROM events
          WHERE kind = 'batch.recorded@1' AND idempotency_key >= ${prefix}
            AND idempotency_key < ${`${prefix}\u{10FFFF}`} ORDER BY id LIMIT 1`;
        if (row !== undefined)
          found.push({
            batch: batchHandle(key),
            batchKey: key,
            eventId: row.id,
          });
      }
    return found;
  });
