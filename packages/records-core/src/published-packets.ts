import { safeRead } from "@neuve/records-schema";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  AssessedSection,
  AssembledBatch,
  AssembledIndex,
  AssembledUnit,
  BatchDigestContent,
  BriefedContent,
  DisposeCitations,
  ExplainedStored,
  FactsContent,
  GuidedContent,
  PacketManifest,
  SectionContent,
  SectionSide,
  lineCiteOf,
  phraseLinks,
  type ManifestBatch,
  type OwnedRange,
  type RecordEvent,
  type UnitSectionsRead,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import {
  checkerFor,
  sectionCheckpoints,
  unitCheckpoints,
  type Checkpoint,
  type SectionCheckpoint,
  type PinView,
  type PlacedSection,
  type RecordCurrency,
  type SourceStatus,
} from "./checkpoints.ts";
import { ComputationStore } from "./computations.ts";
import { judge, type UnitJudgement } from "./dispositions.ts";
import { get, toStored } from "./log.ts";
import { unitRanges } from "./unit-ranges.ts";

/**
 * Published packets as Records holds them (M5 RD1, §2.1): the standing packet of a cycle (8.7), its
 * manifest, every event the manifest names, the delivery content those events reference, the
 * references whole and every local ID the content cites, resolved through the assembled batch each
 * batch names, the run's disclosed gaps, and each unit's closure as `Dispositions.judge` reads it.
 * `neuve review show` and the web app read this one model. Stored content that does not decode is
 * disclosed in `undecoded`, never thrown, so a store older than this code still reads.
 *
 * Two shapes: `standingPacket`, `exactPacket` and `runPacket` read `packet.published@1` only, with
 * their types unchanged; `readStanding`, `readExact` and `readRun` read both, a cumulative
 * `packet.published@2` with its units' sections, judgements, lineage and manifest-named gaps
 * included.
 *
 * Not the `PacketView` projection row in `@neuve/records-schema`, which is one table row per packet.
 */

type Of<K extends RecordEvent["kind"]> = Extract<RecordEvent, { kind: K }>;

/** Stored content the read model could not read or decode under today's schema, disclosed rather than thrown. */
export interface Undecoded {
  /** What it is, such as `guided of b1.u2` or `manifest`. */
  readonly what: string;
  /** `computation:<key>` or `blob:<hash>`. */
  readonly ref: string;
  readonly issue: string;
  /**
   * Which part of the packet it is: the manifest, a batch's assembled batch or digest, a unit's
   * Dispose output or one of its delivery stops. `what` and `issue` name handles and decoder
   * text; a reader-facing caller words the gap from this and `unit` instead.
   */
  readonly part: UndecodedPart;
  /** The batch's local ID (`PacketBatch.local`), when it is one batch's content. */
  readonly batch?: string | undefined;
  /** The unit's local ID (`PacketUnit.local`), when it is one unit's content. */
  readonly unit?: string | undefined;
}

export type UndecodedPart =
  | "manifest"
  | "assembled-batch"
  | "batch-digest"
  | "dispose"
  | "facts"
  | "briefed"
  | "explained"
  | "guided";

/** A unit's delivery stops, each decoded; a stop that does not decode is in `undecoded` instead. */
export interface UnitContent {
  readonly facts?: FactsContent | undefined;
  readonly briefed?: BriefedContent | undefined;
  readonly explained?: ExplainedStored | undefined;
  readonly guided?: GuidedContent | undefined;
}

/** A context reference whole, as the assembled batch holds it (§2.1): what Records' summary folds together. */
export interface ReferenceDetail {
  /** The reference's local ID in the run, such as `r3`. */
  readonly local: string;
  readonly grade: string;
  readonly why: string;
  readonly beforeYouDecide: string;
  readonly locator: string;
  /** The qualified ledger entries it was projected from. */
  readonly entries: ReadonlyArray<string>;
  /** Every anchor; Records' event carries the first only. */
  readonly anchors: ReadonlyArray<{
    readonly hunk: string;
    readonly path: string;
    readonly side: string;
    readonly startLine: number;
    readonly endLine: number;
  }>;
}

/** What a local ID resolved to. */
export type Resolution =
  | {
      readonly kind: "reference";
      /** The published `context.referenced@2`. */
      readonly eventId: string;
      readonly detail: ReferenceDetail;
      /** The ledger entry cited, when the content cited one and it was projected into this reference. */
      readonly via: string | undefined;
    }
  | {
      readonly kind: "hunk";
      readonly path: string;
      /**
       * Its lines on each side it changes: a modification has an old and a new range. A line cite
       * inside the hunk (`h<hex>@<start>-<end>`) has one range, exactly the lines it cites.
       */
      readonly ranges: ReadonlyArray<{
        readonly side: string;
        /** Undefined for a whole non-text hunk. */
        readonly startLine: number | undefined;
        readonly endLine: number | undefined;
      }>;
    }
  | {
      readonly kind: "unit";
      readonly local: string;
      readonly unitId: string;
      /** Its `unit.recorded@2` or `unit.recorded@3`. */
      readonly eventId: string;
    }
  | { readonly kind: "proof"; readonly eventId: string }
  | {
      /** A change fact, an obligation or a scope section: an entry of a computation Records references. */
      readonly kind: "change-fact" | "obligation" | "scope-section";
      readonly ref: string;
      readonly entry: string | null;
    };

/** One local ID a unit's or digest's content cites, and what it resolved to. */
export interface CitedId {
  readonly id: string;
  /**
   * The stops that cite it: `facts`, `briefed`, `explained`, `guided`, `batch-digest`. On a
   * new-shape packet the phrase links of a section's own Briefed and Explained cite under the
   * same names.
   */
  readonly stops: ReadonlyArray<string>;
  readonly resolution: Resolution | undefined;
  /**
   * Why it stayed plain text: `unknown` (no entry in the index, or a malformed line cite) or
   * `not-published` (points to nothing Records holds, or to lines outside the cited hunk's).
   */
  readonly unresolved: "unknown" | "not-published" | undefined;
  /** For an unresolved ID, what it pointed to when it pointed somewhere. */
  readonly detail: string | undefined;
}

export interface Citations {
  readonly cited: ReadonlyArray<CitedId>;
  readonly resolved: number;
  readonly unresolved: number;
}

export type Sections = NonNullable<AssembledUnit["sections"]>;

/**
 * A unit's sections from the assembled batch's loose index. The strict decode of the whole batch
 * already discloses a malformed list, so one that doesn't decode is left out and the unit reads as
 * one change.
 */
const sectionsOf = (held: Readonly<Record<string, unknown>> | undefined) => {
  const read = safeRead(AssembledUnit.shape.sections, held?.["sections"]);
  return read.success && read.data !== undefined && read.data.length > 0
    ? read.data
    : undefined;
};

export interface PacketUnit {
  readonly local: string;
  readonly unitId: string;
  readonly recorded: Of<"unit.recorded@2"> | undefined;
  /** Version 3 since checkpoints are anchored (11.17); earlier packets hold version 2. */
  readonly assessment:
    Of<"assessment.recorded@2"> | Of<"assessment.recorded@3"> | undefined;
  /**
   * Its validation requirements as checkpoints, each with its proof state set at this read
   * (11.16), its anchors (11.17) and its pinned sources' status (11.18). The desk reads the state
   * here and never derives it.
   */
  readonly checkpoints: ReadonlyArray<Checkpoint>;
  /**
   * Each proof record its checkpoints name, by event ID, with its currency for this unit at this
   * read (11.10): `current`, `stale` with why, or `unchecked` when no repository was given or git
   * could not answer. A record Records does not hold has no entry.
   */
  readonly proofCurrency: Readonly<Record<string, RecordCurrency>>;
  readonly content: UnitContent;
  /**
   * The separate changes of its one file (10.109), each with its title and the lines it owns, in
   * file order, as the assembled batch holds them. Absent when the batch holds none (a unit with one
   * change, or one assembled before sections) or its sections don't decode.
   */
  readonly sections?: Sections;
  readonly references: ReadonlyArray<Of<"context.referenced@2">>;
  /**
   * Each published reference whole, by its event ID, when the assembled batch holds it (§2.1).
   * Kept beside `references` so the events keep the shape `review show --json` has always printed.
   */
  readonly referenceDetails: Readonly<Record<string, ReferenceDetail>>;
  readonly comments: ReadonlyArray<
    Of<"comment.recorded@2" | "comment.carried@1">
  >;
  readonly disposition:
    Of<"disposition.recorded@2" | "disposition.carried@1"> | undefined;
  readonly judgement: UnitJudgement;
  readonly citations: Citations;
}

export interface PacketBatch {
  readonly local: string;
  readonly batchId: string;
  readonly recorded: Of<"batch.recorded@1"> | undefined;
  readonly digest: BatchDigestContent | undefined;
  readonly digestCitations: Citations;
  /** `computation:<key>` of the assembled batch its IDs resolve through, when the packet names one. */
  readonly assembled: string | undefined;
  readonly units: ReadonlyArray<PacketUnit>;
}

export interface StandingPacket {
  readonly eventId: string;
  /** The packet this one supersedes, when it does. */
  readonly supersedes: string | null;
  /** The packet asked for; the standing one differs when a later generation superseded it. */
  readonly requestedPacket: string;
  readonly manifest: string;
  readonly complete: boolean;
  readonly counts: Of<"packet.published@1">["payload"]["counts"];
  readonly batches: ReadonlyArray<PacketBatch>;
  readonly gaps: ReadonlyArray<Of<"gap.disclosed@1">>;
  readonly undecoded: ReadonlyArray<Undecoded>;
}

type Read = { readonly value: unknown } | { readonly missing: string };

/**
 * A blob's JSON, or why it could not be read: pruned, missing, corrupt or not JSON. One unreadable
 * blob is disclosed by the caller, so it never fails the whole packet's read.
 */
const blobJson = (hash: string, what: string) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const read = yield* blobs.get(hash).pipe(
      Effect.map((read) => ({ read })),
      Effect.catchTags({
        BlobMissing: () =>
          Effect.succeed({
            missing: `${what} blob is missing from this store`,
          }),
        BlobCorrupt: (error) =>
          Effect.succeed({
            missing: `${what} blob is corrupt (${error.message})`,
          }),
      }),
    );
    if ("missing" in read) return read satisfies Read;
    if (read.read._tag === "Pruned")
      return { missing: `${what} was pruned` } satisfies Read;
    const bytes = read.read.bytes;
    try {
      return {
        value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      } satisfies Read;
    } catch (error) {
      return {
        missing: `${what} is not JSON (${error instanceof Error ? error.message : String(error)})`,
      } satisfies Read;
    }
  });

/** A computation's stored value, or why it could not be read. */
const computationValue = (key: string) =>
  Effect.gen(function* () {
    const store = yield* ComputationStore;
    const held = yield* store.lookup(key);
    if (Option.isNone(held))
      return { missing: "not held in this store" } satisfies Read;
    return yield* blobJson(held.value.outputHash, "its output");
  });

const unwrapOutput = (value: unknown) =>
  value !== null &&
  typeof value === "object" &&
  "output" in value &&
  !("citations" in value)
    ? (value as { output: unknown }).output
    : value;

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  return issue === undefined
    ? error.message
    : `${issue.path.join(".") || "(root)"}: ${issue.message}${error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : ""}`;
};

/**
 * Where a page starts (M5 RD3), from the projections, one indexed read each: the cycle of the newest
 * published packet, and the cycle a batch or unit was recorded in. Which packet stands in that cycle
 * is still `standingPacket`'s rule, never these tables'. A `packet.published@2` is read from the log
 * (it has no projection row), through the kind index, and the newer of the two by ULID wins.
 */
export const newestPacketCycle = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [projected] = yield* sql<{
    eventId: string;
    cycleId: string;
  }>`SELECT event_id, cycle_id FROM projection_packets ORDER BY event_id DESC LIMIT 1`;
  const [logged] = yield* sql<{
    eventId: string;
    cycleId: string;
  }>`SELECT id AS event_id, json_extract(envelope, '$.attribution.cycleId') AS cycle_id
    FROM events WHERE kind = 'packet.published@2' ORDER BY id DESC LIMIT 1`;
  return projected === undefined ||
    (logged !== undefined && logged.eventId > projected.eventId)
    ? logged?.cycleId
    : projected.cycleId;
});

export const cycleOfBatch = (batchId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      cycleId: string;
    }>`SELECT cycle_id FROM projection_batches WHERE batch_id = ${batchId}`;
    return row?.cycleId;
  });

export const cycleOfUnit = (unitId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      cycleId: string | null;
    }>`SELECT cycle_id FROM projection_units WHERE unit_id = ${unitId}`;
    return row?.cycleId ?? undefined;
  });

/**
 * A cycle's packet of record: its newest packet, `packet.published@1` or `@2`, that no later packet
 * supersedes. Readers of the version 1 shape (`standingPacket`) read nothing for a cycle whose
 * packet of record is version 2, rather than an older packet it superseded.
 */
export const standingPacketId = (cycleId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ id: string }>`SELECT e.id FROM events e
      JOIN event_cycles c ON c.event_seq = e.seq AND c.cycle_id = ${cycleId}
      WHERE e.kind IN ('packet.published@1', 'packet.published@2')
        AND NOT EXISTS (SELECT 1 FROM projection_supersessions s WHERE s.target_id = e.id)
      ORDER BY e.id DESC LIMIT 1`;
    return row?.id;
  });

const manifestOf = (
  packet: Of<"packet.published@1"> | Of<"packet.published@2">,
) =>
  Effect.gen(function* () {
    const ref = packet.refs[0].ref;
    const hash = ref.slice(ref.indexOf(":") + 1);
    if (!ref.startsWith("blob:"))
      return { hash, manifest: undefined, issue: "the manifest is not a blob" };
    const read = yield* blobJson(hash, "the manifest");
    if ("missing" in read)
      return { hash, manifest: undefined, issue: read.missing };
    const parsed = safeRead(PacketManifest, read.value);
    return parsed.success
      ? { hash, manifest: parsed.data, issue: undefined }
      : { hash, manifest: undefined, issue: firstIssue(parsed.error) };
  });

/**
 * A cycle's packet of record and its manifest, with one blob read and nothing else of the packet:
 * what `standingUnits` and the review list read. Undefined when the cycle has no packet; the
 * manifest is undefined, and `issue` says why, when it cannot be read. `packet` is the packet
 * event, of either version.
 */
export const standingManifest = (cycleId: string) =>
  Effect.gen(function* () {
    const id = yield* standingPacketId(cycleId);
    if (id === undefined) return undefined;
    const held = yield* get(id);
    if (
      Option.isNone(held) ||
      (held.value.event.kind !== "packet.published@1" &&
        held.value.event.kind !== "packet.published@2")
    )
      return undefined;
    const packet = held.value.event;
    return { packetId: id, packet, ...(yield* manifestOf(packet)) };
  });

/**
 * The units of a cycle's packet of record, from its manifest: the read rule `review show`, `review
 * stats --cycle` and the day-one counts follow, so units of superseded packets (another run key,
 * or a confirmation a later generation changed) stay in the log without being counted. Undefined
 * when the cycle has no packet, or its manifest cannot be read, so readers fall back to every unit.
 */
export const standingUnits = (cycleId: string) =>
  Effect.gen(function* () {
    const manifest = (yield* standingManifest(cycleId))?.manifest;
    if (manifest === undefined) return undefined;
    return manifest.batches.flatMap((batch) =>
      batch.units.map((unit) => unit.unitId),
    );
  });

/**
 * The units of every cycle's packet of record, for store-wide metrics: each cycle with a packet
 * counts only the units its packet of record names; a cycle with no packet counts all its units,
 * as `standingUnits` falls back.
 */
export const recordUnits = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const cycles = yield* sql<{
      cycleId: string;
    }>`SELECT DISTINCT c.cycle_id FROM events e
      JOIN event_cycles c ON c.event_seq = e.seq
      WHERE e.kind IN ('packet.published@1', 'packet.published@2')`;
    const units: Array<string> = [];
    for (const { cycleId } of cycles)
      units.push(...((yield* standingUnits(cycleId)) ?? []));
    const unpublished = yield* sql<{
      unitId: string;
    }>`SELECT u.unit_id FROM projection_units u
      WHERE u.cycle_id IS NULL OR u.cycle_id NOT IN (SELECT c.cycle_id FROM events e
        JOIN event_cycles c ON c.event_seq = e.seq
        WHERE e.kind IN ('packet.published@1', 'packet.published@2'))`;
    units.push(...unpublished.map((row) => row.unitId));
    return units;
  });

/**
 * What a new-shape batch's references and citations resolve through when it holds no reference
 * and names no assembled batch: nothing.
 */
const NO_INDEX: AssembledIndex = { citations: {}, references: [], units: [] };

/**
 * The index the new publisher writes for a batch that holds references (`index: "sections@1"`):
 * its citations and references, with no assembled batch around them, so no strict decode applies.
 */
const isSectionsIndex = (value: unknown) =>
  value !== null &&
  typeof value === "object" &&
  (value as { index?: unknown }).index === "sections@1";

/**
 * The assembled batch's index, decoded loosely; a strict decode's failure is disclosed, except,
 * when `sectionsIndex` is set (the new-shape read), for the new publisher's own index.
 */
const assembledIndex = (
  ref: string | undefined,
  undecoded: Array<Undecoded>,
  what: string,
  batch: string,
  options: { readonly sectionsIndex?: boolean } = {},
) =>
  Effect.gen(function* () {
    if (ref === undefined || !ref.startsWith("computation:")) {
      undecoded.push({
        what,
        part: "assembled-batch",
        batch,
        ref: ref ?? "none",
        issue:
          "the packet names no assembled batch, so its local IDs stay unresolved",
      });
      return undefined;
    }
    const read = yield* computationValue(ref.slice("computation:".length));
    if (!("value" in read)) {
      undecoded.push({
        what,
        ref,
        issue: read.missing,
        part: "assembled-batch",
        batch,
      });
      return undefined;
    }
    const value = unwrapOutput(read.value);
    const strict = safeRead(AssembledBatch, value);
    if (
      !strict.success &&
      !(options.sectionsIndex === true && isSectionsIndex(value))
    )
      undecoded.push({
        what,
        part: "assembled-batch",
        batch,
        ref,
        issue: `does not decode as today's assembled batch (${firstIssue(strict.error)}); its citations and references are read loosely`,
      });
    const loose = AssembledIndex.safeParse(value);
    if (!loose.success) {
      undecoded.push({
        what,
        part: "assembled-batch",
        batch,
        ref,
        issue: `its citations and references do not decode (${firstIssue(loose.error)}), so its local IDs stay unresolved`,
      });
      return undefined;
    }
    return loose.data;
  });

/**
 * The batch's citation index as Publish resolved it: the assembled batch's, with what each unit's
 * stored Dispose output adds (the IDs its reviewer saw, scope sections among them).
 */
const withDisposeCitations = (
  index: AssembledIndex | undefined,
  entry: ManifestBatch,
  undecoded: Array<Undecoded>,
) =>
  Effect.gen(function* () {
    if (index === undefined) return undefined;
    const citations = { ...index.citations };
    for (const unit of entry.units) {
      if (typeof unit.dispose !== "string") continue;
      const ref = `computation:${unit.dispose}`;
      const read = yield* computationValue(unit.dispose);
      if (!("value" in read)) {
        undecoded.push({
          what: `review of ${unit.unit}`,
          part: "dispose",
          batch: entry.batch,
          unit: unit.unit,
          ref,
          issue: read.missing,
        });
        continue;
      }
      const parsed = safeRead(DisposeCitations, unwrapOutput(read.value));
      if (!parsed.success) {
        undecoded.push({
          what: `review of ${unit.unit}`,
          part: "dispose",
          batch: entry.batch,
          unit: unit.unit,
          ref,
          issue: `its citations do not decode (${firstIssue(parsed.error)})`,
        });
        continue;
      }
      Object.assign(citations, parsed.data.citations);
    }
    return { ...index, citations };
  });

/** The local IDs a stop's content cites, in order of first citation. */
const idsOf = (stop: string, value: unknown): ReadonlyArray<string> => {
  const links = (text: unknown) =>
    typeof text === "string" ? phraseLinks(text).map((link) => link.id) : [];
  const list = (ids: unknown) =>
    Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [];
  const v = (value ?? {}) as Record<string, unknown>;
  switch (stop) {
    case "facts":
      return [...list(v["cites"]), ...links(v["text"])];
    case "briefed":
      return links(v["text"]);
    case "explained":
      return [...list(v["cites"]), ...links(v["before"]), ...links(v["after"])];
    case "guided": {
      const rows = Array.isArray(v["rows"]) ? v["rows"] : [];
      const outside = Array.isArray(v["outside"]) ? v["outside"] : [];
      // A row's reading cites from every section, its evidence from the worst-status answers, so
      // either can hold an ID the other lacks. A reading of another shape adds nothing.
      return [...rows, ...outside].flatMap((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        const reading = (
          typeof row["reading"] === "object" && row["reading"] !== null
            ? row["reading"]
            : {}
        ) as Record<string, unknown>;
        return [
          ...list(row["evidence"]),
          ...list(reading["cites"]),
          ...links(reading["text"]),
        ];
      });
    }
    case "batch-digest":
      return [...links(v["digest"]), ...links(v["verification"])];
    default:
      return [];
  }
};

/**
 * A new-shape batch's hunks, by hunk ID: each section that holds one, with its file and the ranges
 * that are the hunk's. A section whose blob names each range's hunk (`rangeHunks`) holds exactly
 * the hunks it names, with only the ranges named for each (`own`). A section whose blob names none
 * holds the hunks its code Facts cite, which are the section's own hunks (at most 6), with all its
 * ranges and how many hunks its Facts cite: its lines are a hunk's own only when that is one.
 */
type HeldHunks = Map<
  string,
  Array<{
    readonly path: string;
    readonly ranges: ReadonlyArray<OwnedRange>;
    readonly own: boolean;
    readonly hunks: number;
  }>
>;

/**
 * Resolves the local IDs of one manifest batch through its assembled batch (§2.1): a ledger entry
 * becomes the reference it was projected into, a hunk its path, side and lines, a unit or proof its
 * event. A new-shape batch (`held` given) also resolves what its index does not name: a unit's
 * handle in the manifest to its recording, and a hunk ID to its lines in every section that holds
 * it (a hunk split between sections is all of theirs). A section that names each range's hunk
 * gives exactly the ranges named for it; one that names none gives all its lines when its Facts
 * cite that hunk alone. A hunk that a section naming none holds among several stays unresolved,
 * even where other sections name its ranges: which of that section's lines are its own is not
 * stored, and a link missing them, or reaching another hunk's lines, would mislead. An ID that
 * resolves to nothing published stays unresolved, with why.
 */
const resolverFor = (
  index: AssembledIndex | undefined,
  entry: ManifestBatch,
  events: ReadonlyArray<RecordEvent>,
  /**
   * The new-shape reader's rule for a unit the manifest names two recordings of: the newest by
   * ULID, as the projection and the read unit take it. Version 1 packets keep the last listed.
   */
  newestUnit = false,
  /**
   * A new-shape batch's hunks from its units' sections (`HeldHunks`), filled before any ID is
   * resolved. Absent for a version 1 packet, whose IDs resolve through its assembled batch only.
   */
  held?: HeldHunks,
) => {
  const byLocal = new Map(
    (index?.references ?? []).map((reference) => [reference.id, reference]),
  );
  const detailOf = (
    reference: AssembledIndex["references"][number],
  ): ReferenceDetail => ({
    local: reference.id,
    grade: reference.grade,
    why: reference.why,
    beforeYouDecide: reference.beforeYouDecide,
    locator: reference.locator,
    entries: reference.entries,
    anchors: reference.anchors,
  });
  // A published reference's event, by the base Publish keyed it on (`reference:<local>`).
  const referenceEvents = new Map<string, string>();
  for (const named of entry.events) {
    const base = named.base ?? named.key;
    if (
      named.kind === "context.referenced@2" &&
      base !== undefined &&
      typeof named.id === "string"
    )
      referenceEvents.set(
        base.slice(base.lastIndexOf("reference:") + "reference:".length),
        named.id,
      );
  }
  // A unit's recording, version 2 or 3: a packet names one or the other for each of its units.
  const unitEvents = new Map<string, string>();
  for (const event of events)
    if (event.kind === "unit.recorded@2" || event.kind === "unit.recorded@3")
      if (
        !newestUnit ||
        (unitEvents.get(event.attribution.unitIds[0]) ?? "") < event.id
      )
        unitEvents.set(event.attribution.unitIds[0], event.id);
  const unitIds = new Map(entry.units.map((unit) => [unit.unit, unit.unitId]));
  const asReference = (
    local: string,
    via: string | undefined,
  ): Pick<CitedId, "resolution" | "unresolved" | "detail"> => {
    const reference = byLocal.get(local);
    if (reference === undefined)
      return {
        resolution: undefined,
        unresolved: "unknown",
        detail: `reference ${local} is not in the assembled batch`,
      };
    const eventId = referenceEvents.get(local);
    if (eventId === undefined)
      return {
        resolution: undefined,
        unresolved: "not-published",
        detail: `reference ${local} (${reference.locator}) stays in the assembled batch; Records holds no event for it`,
      };
    return {
      resolution: {
        kind: "reference",
        eventId,
        detail: detailOf(reference),
        via,
      },
      unresolved: undefined,
      detail: undefined,
    };
  };
  const asUnit = (
    local: string,
  ): Pick<CitedId, "resolution" | "unresolved" | "detail"> => {
    const unitId = unitIds.get(local);
    const eventId = unitId === undefined ? undefined : unitEvents.get(unitId);
    if (unitId === undefined || eventId === undefined)
      return {
        resolution: undefined,
        unresolved: "not-published",
        detail: `unit ${local} is not recorded (it owns nothing, or another batch holds it)`,
      };
    return {
      resolution: { kind: "unit", local, unitId, eventId },
      unresolved: undefined,
      detail: undefined,
    };
  };
  /** What a new-shape batch resolves beyond its index: a unit's handle, then a cited hunk. */
  const ownResolution = (
    id: string,
  ): Pick<CitedId, "resolution" | "unresolved" | "detail"> | undefined => {
    if (held === undefined) return undefined;
    if (unitIds.has(id)) return asUnit(id);
    const holders = held.get(id);
    if (holders === undefined || holders.length === 0) return undefined;
    const several = holders.find((holder) => !holder.own && holder.hunks > 1);
    if (several !== undefined)
      return {
        resolution: undefined,
        unresolved: "not-published",
        detail: `hunk ${id} is in a section of ${several.path} that holds several hunks (its Facts cite ${several.hunks}); the packet keeps the section's lines without saying which are this hunk's`,
      };
    return {
      resolution: {
        kind: "hunk",
        path: holders[0]!.path,
        ranges: holders.flatMap((holder) =>
          holder.ranges.map((range) => ({
            side: range.side,
            startLine: range.kind === "lines" ? range.startLine : undefined,
            endLine: range.kind === "lines" ? range.endLine : undefined,
          })),
        ),
      },
      unresolved: undefined,
      detail: undefined,
    };
  };
  const resolve = (id: string) =>
    Effect.gen(function* () {
      const target = index?.citations[id];
      if (target === undefined)
        return (
          ownResolution(id) ?? {
            resolution: undefined,
            unresolved: "unknown" as const,
            detail:
              index === undefined
                ? "the assembled batch could not be read"
                : undefined,
          }
        );
      switch (target.kind) {
        case "reference":
          return asReference(id, undefined);
        case "ledger-entry": {
          const into = (index?.references ?? []).find((reference) =>
            reference.entries.includes(id),
          );
          if (into === undefined)
            return {
              resolution: undefined,
              unresolved: "not-published" as const,
              detail: `ledger entry ${id} was projected into no reference`,
            };
          return asReference(into.id, id);
        }
        case "hunk": {
          // The unit that owns it holds its lines on each side; a reference anchored on it, else.
          const owned = (index?.units ?? []).flatMap((unit) =>
            unit.ownedRanges.filter((range) => range.hunkId === id),
          );
          const anchored = (index?.references ?? [])
            .flatMap((reference) => reference.anchors)
            .filter((anchor) => anchor.hunk === id);
          const found = owned.length > 0 ? owned : anchored.slice(0, 1);
          if (found.length === 0)
            return {
              resolution: undefined,
              unresolved: "not-published" as const,
              detail: `hunk ${id} is owned by no unit of the batch`,
            };
          return {
            resolution: {
              kind: "hunk" as const,
              path: found[0]!.path,
              ranges: found.map((range) => ({
                side: range.side,
                startLine: range.startLine,
                endLine: range.endLine,
              })),
            },
            unresolved: undefined,
            detail: undefined,
          };
        }
        case "unit":
          return asUnit(target.entry ?? id);
        case "proof": {
          const eventId =
            target.ref !== null && target.ref.startsWith("event:")
              ? target.ref.slice("event:".length)
              : id;
          const held = yield* get(eventId);
          if (
            Option.isNone(held) ||
            held.value.event.kind !== "proof.recorded@1"
          )
            return {
              resolution: undefined,
              unresolved: "not-published" as const,
              detail: `proof record ${eventId} is not in this store`,
            };
          return {
            resolution: { kind: "proof" as const, eventId },
            unresolved: undefined,
            detail: undefined,
          };
        }
        case "change-fact":
        case "obligation":
        case "scope-section":
          if (target.ref === null)
            return {
              resolution: undefined,
              unresolved: "not-published" as const,
              detail: `${target.kind} ${id} names no computation`,
            };
          return {
            resolution: {
              kind: target.kind,
              ref: target.ref,
              entry: target.entry,
            },
            unresolved: undefined,
            detail: undefined,
          };
        default:
          return {
            resolution: undefined,
            unresolved: "unknown" as const,
            detail: `an index entry of kind ${target.kind}`,
          };
      }
    });
  /**
   * A line cite (`lineCiteOf`) resolves its hunk as a bare cite does, then narrows it: the same
   * hunk resolution with exactly the cited lines, on the hunk's new side, or its old side when it
   * has no new-side range, when one held range on that side holds them all. Lines outside every
   * held range, malformed lines, or a hunk that does not resolve leave it unresolved, with why.
   */
  const resolveCite = (id: string) =>
    Effect.gen(function* () {
      const cite = lineCiteOf(id);
      if (cite === undefined) return yield* resolve(id);
      if ("malformed" in cite.lines)
        return {
          resolution: undefined,
          unresolved: "unknown" as const,
          detail: `line cite ${id} is malformed: ${cite.lines.malformed}`,
        };
      const { startLine, endLine } = cite.lines;
      const base = yield* resolve(cite.hunk);
      if (base.resolution === undefined)
        return {
          resolution: undefined,
          unresolved: base.unresolved ?? ("unknown" as const),
          detail: `its hunk ${cite.hunk} does not resolve${base.detail === undefined ? "" : `: ${base.detail}`}`,
        };
      if (base.resolution.kind !== "hunk")
        return {
          resolution: undefined,
          unresolved: "not-published" as const,
          detail: `${cite.hunk} resolves to a ${base.resolution.kind}, not a hunk, so it has no lines to cite`,
        };
      const side = base.resolution.ranges.some((range) => range.side === "new")
        ? "new"
        : "old";
      const held = base.resolution.ranges.filter(
        (range) =>
          range.side === side &&
          range.startLine !== undefined &&
          range.endLine !== undefined,
      );
      if (
        !held.some(
          (range) => range.startLine! <= startLine && endLine <= range.endLine!,
        )
      )
        return {
          resolution: undefined,
          unresolved: "not-published" as const,
          detail: `lines ${startLine}-${endLine} are outside hunk ${cite.hunk}'s lines on its ${side} side (${held.length === 0 ? "it has none" : held.map((range) => `${range.startLine}-${range.endLine}`).join(", ")})`,
        };
      return {
        resolution: {
          ...base.resolution,
          ranges: [{ side, startLine, endLine }],
        },
        unresolved: undefined,
        detail: undefined,
      };
    });
  return {
    resolve: resolveCite,
    referenceDetail: (local: string) => {
      const reference = byLocal.get(local);
      return reference === undefined ? undefined : detailOf(reference);
    },
  };
};

const citationsOf = (
  resolver: ReturnType<typeof resolverFor>,
  stops: ReadonlyArray<readonly [string, unknown]>,
) =>
  Effect.gen(function* () {
    const where = new Map<string, Array<string>>();
    for (const [stop, value] of stops)
      for (const id of idsOf(stop, value)) {
        const seen = where.get(id) ?? [];
        if (!seen.includes(stop)) seen.push(stop);
        where.set(id, seen);
      }
    const cited: Array<CitedId> = [];
    for (const [id, inStops] of where)
      cited.push({ id, stops: inStops, ...(yield* resolver.resolve(id)) });
    const resolved = cited.filter((c) => c.resolution !== undefined).length;
    return {
      cited,
      resolved,
      unresolved: cited.length - resolved,
    } satisfies Citations;
  });

const CONTENT_SCHEMAS = {
  facts: FactsContent,
  briefed: BriefedContent,
  explained: ExplainedStored,
  guided: GuidedContent,
} as const;

/** How a packet is read. */
export interface ReadOptions {
  /**
   * The repository whose git objects decide each proof record's currency (11.10). Without it every
   * record's currency is unchecked, so checkpoints resting on records read Out of date.
   */
  readonly repository?: string | undefined;
}

const SOURCE_STATUSES: ReadonlyArray<string> = [
  "current",
  "changed",
  "unchecked",
];

/** Every event a manifest batch names, its units' included, once each, in the manifest's order. */
const batchEventsOf = (entry: ManifestBatch) =>
  Effect.gen(function* () {
    const events: Array<RecordEvent> = [];
    const seen = new Set<string>();
    for (const named of [
      ...entry.events,
      ...entry.units.flatMap((unit) => unit.events ?? []),
    ]) {
      if (typeof named.id !== "string" || seen.has(named.id)) continue;
      seen.add(named.id);
      const held = yield* get(named.id);
      if (Option.isSome(held)) events.push(held.value.event);
    }
    return events;
  });

/** The batch's pinned sources (11.17), with a status this build does not know read as unknown. */
const pinsOf = (index: AssembledIndex | undefined): ReadonlyArray<PinView> =>
  (index?.pins ?? []).map((pin) => ({
    source: pin.source,
    provider: pin.provider,
    item: pin.item,
    title: pin.title,
    version: pin.version ?? null,
    readAt: pin.readAt,
    status: (SOURCE_STATUSES.includes(pin.status)
      ? pin.status
      : "unknown") as SourceStatus,
    checkedAt: pin.checkedAt ?? null,
  }));

/** A published reference's local ID by its event ID, from the base Publish keyed it on. */
const referenceLocalsOf = (entry: ManifestBatch) => {
  const referenceLocals = new Map<string, string>();
  for (const named of entry.events) {
    const base = named.base ?? named.key;
    if (
      named.kind === "context.referenced@2" &&
      base !== undefined &&
      typeof named.id === "string"
    )
      referenceLocals.set(
        named.id,
        base.slice(base.lastIndexOf("reference:") + "reference:".length),
      );
  }
  return referenceLocals;
};

/** A delivery stop's content, decoded; undefined and disclosed when it is not held or does not decode. */
const contentReader =
  (undecoded: Array<Undecoded>) =>
  <S extends z.ZodType>(
    event: Of<"delivery.recorded@1">,
    schema: S,
    what: string,
    of: Pick<Undecoded, "part" | "batch" | "unit">,
  ) =>
    Effect.gen(function* () {
      const ref = event.refs[0].ref;
      const read = yield* computationValue(ref.slice("computation:".length));
      if (!("value" in read)) {
        undecoded.push({ what, ref, issue: read.missing, ...of });
        return { raw: undefined, decoded: undefined };
      }
      const parsed = safeRead(schema, read.value);
      if (!parsed.success)
        undecoded.push({ what, ref, issue: firstIssue(parsed.error), ...of });
      return {
        raw: read.value,
        decoded: parsed.success ? (parsed.data as z.infer<S>) : undefined,
      };
    });

/** Reads one published packet, resolving what it cites. */
const readPacket = (
  packetId: string,
  requestedPacket: string,
  options: ReadOptions = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const stored = yield* get(packetId);
    if (Option.isNone(stored)) return undefined;
    const packet = stored.value.event;
    if (packet.kind !== "packet.published@1") return undefined;
    const undecoded: Array<Undecoded> = [];
    const { hash, manifest, issue } = yield* manifestOf(packet);
    if (issue !== undefined)
      undecoded.push({
        what: "manifest",
        ref: packet.refs[0].ref,
        issue,
        part: "manifest",
      });
    const contentOf = contentReader(undecoded);
    const batches: Array<PacketBatch> = [];
    // Currency is decided at this read, against the packet's head (11.10, 11.18).
    const check = checkerFor(
      options.repository,
      packet.attribution.range.headOid,
    );
    const states = {
      proven: 0,
      thin: 0,
      conflicting: 0,
      "out-of-date": 0,
      missing: 0,
    };
    for (const entry of manifest?.batches ?? []) {
      const events = yield* batchEventsOf(entry);
      // The assembled batch: the manifest names it, and so does every reference event (5.3).
      const assembledRef =
        entry.assembled ??
        events.find((e) => e.kind === "context.referenced@2")?.refs?.[0]?.ref;
      const index = yield* withDisposeCitations(
        yield* assembledIndex(
          assembledRef,
          undecoded,
          `assembled batch of ${entry.batch}`,
          entry.batch,
        ),
        entry,
        undecoded,
      );
      const resolver = resolverFor(index, entry, events);
      const pins = pinsOf(index);
      const referenceLocals = referenceLocalsOf(entry);
      const on = (unitId: string) =>
        events.filter((e) =>
          (
            e.attribution as { unitIds?: ReadonlyArray<string> } | undefined
          )?.unitIds?.includes(unitId),
        );
      const digestEvent = events.find(
        (e): e is Of<"delivery.recorded@1"> =>
          e.kind === "delivery.recorded@1" &&
          e.payload.content === "batch-digest",
      );
      const digest =
        digestEvent === undefined
          ? { raw: undefined, decoded: undefined }
          : yield* contentOf(
              digestEvent,
              BatchDigestContent,
              `batch digest of ${entry.batch}`,
              { part: "batch-digest", batch: entry.batch },
            );
      const units: Array<PacketUnit> = [];
      for (const unit of entry.units) {
        const mine = on(unit.unitId);
        const references = events.filter(
          (e): e is Of<"context.referenced@2"> =>
            e.kind === "context.referenced@2" &&
            e.attribution.unitIds.includes(unit.unitId),
        );
        const content: Record<string, unknown> = {};
        const stops: Array<readonly [string, unknown]> = [];
        for (const e of mine)
          if (
            e.kind === "delivery.recorded@1" &&
            e.payload.content !== "batch-digest"
          ) {
            const stop = e.payload.content;
            const read = yield* contentOf(
              e,
              CONTENT_SCHEMAS[stop],
              `${stop} of ${unit.unit}`,
              { part: stop, batch: entry.batch, unit: unit.unit },
            );
            if (read.decoded !== undefined) content[stop] = read.decoded;
            stops.push([stop, read.raw]);
          }
        const recorded = mine.find(
          (e): e is Of<"unit.recorded@2"> => e.kind === "unit.recorded@2",
        );
        const assessment = mine.find(
          (e): e is Of<"assessment.recorded@2"> | Of<"assessment.recorded@3"> =>
            e.kind === "assessment.recorded@2" ||
            e.kind === "assessment.recorded@3",
        );
        const held = index?.units.find((held) => held.id === unit.unit);
        const sections = sectionsOf(held);
        const { checkpoints, proofCurrency } = yield* unitCheckpoints({
          assessment,
          recorded,
          pins,
          untested: held?.assessment?.validation.requirements.map(
            (requirement) => requirement.untested || undefined,
          ),
          check,
        });
        for (const checkpoint of checkpoints) states[checkpoint.proof] += 1;
        units.push({
          local: unit.unit,
          unitId: unit.unitId,
          recorded,
          assessment,
          checkpoints,
          proofCurrency,
          content: content as UnitContent,
          ...(sections === undefined ? {} : { sections }),
          references,
          referenceDetails: Object.fromEntries(
            references.flatMap((event) => {
              const local = referenceLocals.get(event.id);
              const detail =
                local === undefined
                  ? undefined
                  : resolver.referenceDetail(local);
              return detail === undefined ? [] : [[event.id, detail]];
            }),
          ),
          comments: mine.filter(
            (e): e is Of<"comment.recorded@2" | "comment.carried@1"> =>
              e.kind === "comment.recorded@2" || e.kind === "comment.carried@1",
          ),
          disposition: mine.find(
            (e): e is Of<"disposition.recorded@2" | "disposition.carried@1"> =>
              e.kind === "disposition.recorded@2" ||
              e.kind === "disposition.carried@1",
          ),
          judgement: yield* judge(unit.unitId),
          citations: yield* citationsOf(resolver, stops),
        });
      }
      batches.push({
        local: entry.batch,
        batchId: entry.batchId,
        recorded: events.find(
          (e): e is Of<"batch.recorded@1"> => e.kind === "batch.recorded@1",
        ),
        digest: digest.decoded,
        digestCitations: yield* citationsOf(
          resolver,
          digest.raw === undefined ? [] : [["batch-digest", digest.raw]],
        ),
        assembled: assembledRef,
        units,
      });
    }
    const gapRows = yield* sql<{ id: string }>`SELECT id FROM events
      WHERE kind = 'gap.disclosed@1' AND json_extract(envelope, '$.attribution.runId') = ${packet.attribution.runId}
      ORDER BY seq`;
    const gaps: Array<Of<"gap.disclosed@1">> = [];
    for (const gap of gapRows) {
      const held = yield* get(gap.id);
      if (Option.isSome(held) && held.value.event.kind === "gap.disclosed@1")
        gaps.push(held.value.event);
    }
    const cited = batches.flatMap((batch) => [
      batch.digestCitations,
      ...batch.units.map((unit) => unit.citations),
    ]);
    yield* Effect.annotateCurrentSpan({
      "neuve.packet.id": packet.id,
      "neuve.packet.batches": batches.length,
      "neuve.packet.units": batches.reduce((n, b) => n + b.units.length, 0),
      "neuve.packet.citations.resolved": cited.reduce(
        (n, c) => n + c.resolved,
        0,
      ),
      "neuve.packet.citations.unresolved": cited.reduce(
        (n, c) => n + c.unresolved,
        0,
      ),
      "neuve.packet.undecoded": undecoded.length,
      "neuve.packet.checkpoints.proven": states.proven,
      "neuve.packet.checkpoints.thin": states.thin,
      "neuve.packet.checkpoints.conflicting": states.conflicting,
      "neuve.packet.checkpoints.out_of_date": states["out-of-date"],
      "neuve.packet.checkpoints.missing": states.missing,
      "neuve.packet.currency_checked": check !== undefined,
    });
    return {
      eventId: packet.id,
      supersedes: packet.causation?.supersedes ?? null,
      requestedPacket,
      manifest: hash,
      complete: packet.payload.complete,
      counts: packet.payload.counts,
      batches,
      gaps,
      undecoded,
    } satisfies StandingPacket;
  });

/**
 * One immutable `packet.published@1`, including its own decoding gaps, even after a later packet
 * supersedes it. Undefined for a `packet.published@2`, which `readExact` reads: this shape cannot
 * hold one, and a half-read packet is never returned.
 */
export const exactPacket = (packetId: string, options: ReadOptions = {}) =>
  readPacket(packetId, packetId, options).pipe(
    Effect.withSpan("records.packets.exact", {
      attributes: { "neuve.packet.id": packetId },
    }),
  );

/**
 * A cycle's standing packet: what the desk opens for the cycle (RD3). Undefined when it has none,
 * and when its packet of record is a `packet.published@2`, which `readStanding` reads: the cycle
 * then shows no review here rather than a half-read one, or an older packet it superseded.
 */
export const standingPacket = (cycleId: string, options: ReadOptions = {}) =>
  Effect.gen(function* () {
    const id = yield* standingPacketId(cycleId);
    return id === undefined ? undefined : yield* readPacket(id, id, options);
  }).pipe(
    Effect.withSpan("records.packets.standing", {
      attributes: { "neuve.cycle.id": cycleId },
    }),
  );

/**
 * A run's packet as its cycle stands: the cycle's packet of record, whichever run or run key
 * published it, so `review show` reads one set of units, never two. Undefined when the run
 * published no `packet.published@1`, and when the cycle's packet of record is a
 * `packet.published@2`, which `readRun` reads.
 */
export const runPacket = (runId: string, options: ReadOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [own] = yield* sql<{
      id: string;
    }>`SELECT id FROM events
      WHERE kind = 'packet.published@1' AND json_extract(envelope, '$.attribution.runId') = ${runId}
      ORDER BY id LIMIT 1`;
    if (own === undefined) return undefined;
    const cycle = (yield* get(own.id)).pipe(
      Option.map((e) => (e.event.attribution as { cycleId?: string }).cycleId),
      Option.getOrUndefined,
    );
    const standing =
      cycle === undefined ? undefined : yield* standingPacketId(cycle);
    return yield* readPacket(standing ?? own.id, own.id, options);
  }).pipe(
    Effect.withSpan("records.packets.run", {
      attributes: { "neuve.run.id": runId },
    }),
  );

// ---------------------------------------------------------------------------------------------
// The read model of both packet shapes
// ---------------------------------------------------------------------------------------------

/** What the read model of both shapes may disclose: version 1's parts and the new shape's. */
export type ReadUndecodedPart =
  | UndecodedPart
  /** A `unit.recorded@3`'s sections blob: the unit is listed with no lines. */
  | "unit-sections"
  /** An `assessment.recorded@4`'s judgements, or one entry of them: the unit keeps its lane. */
  | "judgements"
  /** A gap the manifest names that Records does not hold. */
  | "gap";

export interface ReadUndecoded extends Omit<Undecoded, "part"> {
  readonly part: ReadUndecodedPart;
  /** The section's key, when it is one section's judgement. */
  readonly section?: string | undefined;
}

/**
 * A `unit.recorded@3` with its owned ranges resolved from its sections blob into today's
 * `OwnedRange` form, beside its title, so readers of a unit's lines read either version alike.
 * Empty when the blob could not be read, which `undecoded` then says.
 */
export type ResolvedUnitV3 = Omit<Of<"unit.recorded@3">, "payload"> & {
  readonly payload: Of<"unit.recorded@3">["payload"] & {
    readonly ownedRanges: ReadonlyArray<OwnedRange>;
  };
};

type BlobSection = UnitSectionsRead["sections"][number];

/**
 * One section of a new-shape unit: its identity, title, owned ranges and own content from the
 * unit's blob, joined by key with its entry in the assessment's judgements (axes, review, lane
 * trail, why it was undecided, lineage, and, when stored, what produced it, the code rules it rests
 * on, the pattern it shares and whether it is context of its file's unit). The judgement's keys are
 * absent when no entry joined, which `undecoded` then says.
 */
export type ReadSection = {
  readonly key: string;
  readonly title: string;
  /**
   * Its identity parts (unknown parts kept); `side` names the side `where` is on, when the blob
   * gives one this build knows, and is absent otherwise.
   */
  readonly parts: Omit<BlobSection["parts"], "side"> & {
    readonly path: string;
    readonly kind: string;
    readonly name: string | null;
    readonly side?: SectionSide;
  };
  readonly where: BlobSection["where"];
  readonly renamedFrom: string | null;
  readonly ownedRanges: ReadonlyArray<OwnedRange>;
  /**
   * The hunk ID of each of `ownedRanges`, in its order; absent when the blob names none, or names
   * them in a form this build does not read, which `undecoded` then says.
   */
  readonly rangeHunks?: ReadonlyArray<string>;
  /**
   * Its own Facts, Briefed and Explained, in the assembled unit's section shape; absent when the
   * blob holds none for it, or holds one that does not decode, which `undecoded` then says.
   */
  readonly content?: SectionContent;
} & Partial<
  Pick<
    AssessedSection,
    | "facts"
    | "assess"
    | "review"
    | "lane"
    | "undecided"
    | "excluded"
    | "lineage"
    | "from"
    | "impact"
    | "verdict"
    | "restsOn"
    | "floorInputs"
    | "origin"
    | "rules"
    | "family"
    | "context"
  >
>;

export interface ReadUnit extends Omit<
  PacketUnit,
  "recorded" | "assessment" | "checkpoints" | "comments" | "sections"
> {
  readonly recorded: Of<"unit.recorded@2"> | ResolvedUnitV3 | undefined;
  readonly assessment:
    | Of<"assessment.recorded@2">
    | Of<"assessment.recorded@3">
    | Of<"assessment.recorded@4">
    | undefined;
  /** From each section's requirements for a version 4 assessment; as `PacketUnit` otherwise. */
  readonly checkpoints: ReadonlyArray<Checkpoint | SectionCheckpoint>;
  /** In the blob's order; empty for a version 2 unit or a blob that could not be read. */
  readonly sections: ReadonlyArray<ReadSection>;
  readonly comments: ReadonlyArray<
    Of<"comment.recorded@2" | "comment.recorded@3" | "comment.carried@1">
  >;
  /** How it relates to earlier units, when the manifest names a `lineage.recorded@1` for it. */
  readonly lineage: Of<"lineage.recorded@1"> | undefined;
  /**
   * The decisions registered people made on an earlier unit this one is unchanged from, carried
   * onto it (`disposition.carried@1` by the person's actor), oldest first. `disposition` is the
   * review's own and never one of these.
   */
  readonly carriedDecisions: ReadonlyArray<Of<"disposition.carried@1">>;
}

export interface ReadBatch extends Omit<PacketBatch, "units"> {
  readonly units: ReadonlyArray<ReadUnit>;
  /** The batch's key in its chain, when the manifest gives one. */
  readonly key: string | undefined;
  /** The run and publication that published it, when the manifest says. */
  readonly publishedBy:
    { readonly runId: string; readonly ordinal: number } | undefined;
  /** The gaps frozen with the batch, as its manifest entry names them. */
  readonly gaps: ReadonlyArray<Of<"gap.disclosed@1">>;
}

/** A `packet.published@1` as `standingPacket` reads it, marked with its kind. */
export interface ReadPacketV1 extends StandingPacket {
  readonly kind: "packet.published@1";
}

/** A `packet.published@2`: one publication of a review's chain, read whole. */
export interface ReadPacketV2 extends Omit<
  StandingPacket,
  "counts" | "batches" | "undecoded"
> {
  readonly kind: "packet.published@2";
  readonly ordinal: number;
  readonly counts: Of<"packet.published@2">["payload"]["counts"];
  readonly added: Of<"packet.published@2">["payload"]["added"];
  /** The manifest's place in the chain, when it gives one. */
  readonly sequence: PacketManifest["sequence"];
  /** Earlier units no unit of this review holds a section of, by Records ID. */
  readonly unmatched: ReadonlyArray<string>;
  readonly batches: ReadonlyArray<ReadBatch>;
  /** Every gap the manifest names, its own and its batches', each once. */
  readonly gaps: ReadonlyArray<Of<"gap.disclosed@1">>;
  readonly undecoded: ReadonlyArray<ReadUndecoded>;
}

export type ReadPacket = ReadPacketV1 | ReadPacketV2;

/** The judgements body read loosely around its entries, so each entry decodes on its own. */
const JudgementsEnvelope = z.looseObject({
  rule: z.number(),
  sections: z.array(z.unknown()),
});

/**
 * An `assessment.recorded@4`'s judgement entries by section key, each decoded on its own, and the
 * keys of entries that did not decode, which are disclosed here and nowhere else.
 */
const judgementsOf = (
  assessment: Of<"assessment.recorded@4">,
  undecoded: Array<ReadUndecoded>,
  of: { readonly batch?: string; readonly unit: string },
) =>
  Effect.gen(function* () {
    const ref = assessment.refs[0].ref;
    const what = `judgements of ${of.unit}`;
    const read = yield* computationValue(ref.slice("computation:".length));
    if (!("value" in read)) {
      undecoded.push({
        what,
        ref,
        issue: read.missing,
        part: "judgements",
        ...of,
      });
      return undefined;
    }
    const body = safeRead(JudgementsEnvelope, unwrapOutput(read.value));
    if (!body.success) {
      undecoded.push({
        what,
        ref,
        issue: firstIssue(body.error),
        part: "judgements",
        ...of,
      });
      return undefined;
    }
    const entries = new Map<string, AssessedSection>();
    const failed = new Set<string>();
    for (const [position, raw] of body.data.sections.entries()) {
      const entry = safeRead(AssessedSection, raw);
      const key =
        raw !== null &&
        typeof raw === "object" &&
        typeof (raw as { key?: unknown }).key === "string"
          ? (raw as { key: string }).key
          : undefined;
      if (!entry.success) {
        undecoded.push({
          what: `judgement ${position + 1} of ${of.unit}`,
          ref,
          issue: firstIssue(entry.error),
          part: "judgements",
          ...of,
          section: key,
        });
        if (key !== undefined) failed.add(key);
        continue;
      }
      // A repeated key is a body that disagrees with itself: the first entry stands, and it is said.
      if (entries.has(entry.data.key)) {
        undecoded.push({
          what: `judgement ${position + 1} of ${of.unit}`,
          ref,
          issue:
            "repeats the key of an earlier judgement of the unit, so it is left out",
          part: "judgements",
          ...of,
          section: entry.data.key,
        });
        continue;
      }
      entries.set(entry.data.key, entry.data);
    }
    return { entries, failed };
  });

/**
 * The readable judgement entries of each unit's newest assessment, through the unit's projection
 * row. Unlike a packet read, entries are not joined to the unit's sections blob; a stray entry
 * (`ReviewStats` counts them) would still count here.
 */
export const latestJudgements = (unitIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const byUnit = new Map<string, ReadonlyArray<AssessedSection>>();
    const pageSize = 500;
    for (let start = 0; start < unitIds.length; start += pageSize) {
      const page = unitIds.slice(start, start + pageSize);
      const rows = yield* sql<{
        unitId: string;
        seq: number;
        recordedAt: string;
        kind: string;
        envelope: string;
      }>`SELECT u.unit_id, e.seq, e.recorded_at, e.kind, e.envelope
        FROM projection_units u JOIN events e ON e.id = u.assessment_event_id
        WHERE ${sql.in("u.unit_id", page)} AND e.kind = 'assessment.recorded@4'`;
      for (const row of rows) {
        const stored = yield* toStored(row);
        if (Option.isNone(stored)) continue;
        const assessment = stored.value.event;
        if (assessment.kind !== "assessment.recorded@4") continue;
        const judged = yield* judgementsOf(assessment, [], {
          unit: row.unitId,
        });
        if (judged !== undefined && judged.entries.size > 0)
          byUnit.set(row.unitId, [...judged.entries.values()]);
      }
    }
    return byUnit;
  });

/** Reads a `packet.published@2`: its manifest's batches, each unit whole, and the gaps it names. */
const readPacketV2 = (
  packet: Of<"packet.published@2">,
  requestedPacket: string,
  options: ReadOptions,
) =>
  Effect.gen(function* () {
    const sqlV2 = yield* SqlClient;
    const undecoded: Array<ReadUndecoded> = [];
    // Version 1's stops and assembled batches disclose under its own parts, which this shape keeps.
    const legacy = undecoded as Array<Undecoded>;
    const { hash, manifest, issue } = yield* manifestOf(packet);
    if (issue !== undefined)
      undecoded.push({
        what: "manifest",
        ref: packet.refs[0].ref,
        issue,
        part: "manifest",
      });
    const contentOf = contentReader(legacy);
    const check = checkerFor(
      options.repository,
      packet.attribution.range.headOid,
    );
    // Gaps are those the manifest names, each read by its ID; one Records does not hold is said.
    const gapEvents = new Map<string, Of<"gap.disclosed@1">>();
    const gapsNamed = (
      named: ReadonlyArray<{ readonly id: string }>,
      where: string,
      batch?: string,
    ) =>
      Effect.gen(function* () {
        const found: Array<Of<"gap.disclosed@1">> = [];
        for (const { id } of named) {
          const known = gapEvents.get(id);
          if (known !== undefined) {
            found.push(known);
            continue;
          }
          const held = yield* get(id);
          if (
            Option.isNone(held) ||
            held.value.event.kind !== "gap.disclosed@1"
          ) {
            undecoded.push({
              what: `gap ${id} named by ${where}`,
              ref: `event:${id}`,
              issue: "Records holds no gap with this ID",
              part: "gap",
              ...(batch === undefined ? {} : { batch }),
            });
            continue;
          }
          gapEvents.set(id, held.value.event);
          found.push(held.value.event);
        }
        return found;
      });
    yield* gapsNamed(manifest?.gaps ?? [], "the manifest");
    const batches: Array<ReadBatch> = [];
    const placing: Array<{
      readonly batch: number;
      readonly at: number;
      readonly sections: ReadonlyArray<PlacedSection>;
      readonly ownedPaths: ReadonlyArray<string>;
      readonly pins: ReadonlyArray<PinView>;
    }> = [];
    for (const entry of manifest?.batches ?? []) {
      const events = yield* batchEventsOf(entry);
      const assembledRef =
        entry.assembled ??
        events.find((e) => e.kind === "context.referenced@2")?.refs?.[0]?.ref;
      // A new-shape batch that names no assembled batch and holds no reference has nothing to
      // resolve through: its references and citations read as none, and nothing is undecoded.
      const index =
        assembledRef === undefined
          ? NO_INDEX
          : yield* withDisposeCitations(
              yield* assembledIndex(
                assembledRef,
                legacy,
                `assembled batch of ${entry.batch}`,
                entry.batch,
                { sectionsIndex: true },
              ),
              entry,
              legacy,
            );
      // Filled as each unit's sections are read; every ID resolves once all of them are in.
      const hunks: HeldHunks = new Map();
      const resolver = resolverFor(index, entry, events, true, hunks);
      const unitStops: Array<ReadonlyArray<readonly [string, unknown]>> = [];
      const pins = pinsOf(index);
      const referenceLocals = referenceLocalsOf(entry);
      const on = (unitId: string) =>
        events.filter((e) =>
          (
            e.attribution as { unitIds?: ReadonlyArray<string> } | undefined
          )?.unitIds?.includes(unitId),
        );
      const digestEvent = events.find(
        (e): e is Of<"delivery.recorded@1"> =>
          e.kind === "delivery.recorded@1" &&
          e.payload.content === "batch-digest",
      );
      const digest =
        digestEvent === undefined
          ? { raw: undefined, decoded: undefined }
          : yield* contentOf(
              digestEvent,
              BatchDigestContent,
              `batch digest of ${entry.batch}`,
              { part: "batch-digest", batch: entry.batch },
            );
      const units: Array<ReadUnit> = [];
      for (const unit of entry.units) {
        const of = { batch: entry.batch, unit: unit.unit };
        const mine = on(unit.unitId);
        const references = events.filter(
          (e): e is Of<"context.referenced@2"> =>
            e.kind === "context.referenced@2" &&
            e.attribution.unitIds.includes(unit.unitId),
        );
        const content: Record<string, unknown> = {};
        const stops: Array<readonly [string, unknown]> = [];
        for (const e of mine)
          if (
            e.kind === "delivery.recorded@1" &&
            e.payload.content !== "batch-digest"
          ) {
            const stop = e.payload.content;
            const read = yield* contentOf(
              e,
              CONTENT_SCHEMAS[stop],
              `${stop} of ${unit.unit}`,
              { part: stop, ...of },
            );
            if (read.decoded !== undefined) content[stop] = read.decoded;
            stops.push([stop, read.raw]);
          }
        // The unit's recording: version 3, whose lines are in its sections blob, or version 2.
        // Newest by ULID when the manifest names more than one, as the projection takes it.
        const recording = mine
          .filter(
            (e): e is Of<"unit.recorded@2"> | Of<"unit.recorded@3"> =>
              (e.kind === "unit.recorded@3" || e.kind === "unit.recorded@2") &&
              e.attribution.unitIds[0] === unit.unitId,
          )
          .reduce<Of<"unit.recorded@2"> | Of<"unit.recorded@3"> | undefined>(
            (newest, e) =>
              newest === undefined || e.id > newest.id ? e : newest,
            undefined,
          );
        let recorded: ReadUnit["recorded"];
        let ownedRanges: ReadonlyArray<OwnedRange> = [];
        let blobSections: ReadonlyArray<BlobSection> = [];
        let blobRef = "";
        if (recording?.kind === "unit.recorded@3") {
          blobRef = recording.refs[0].ref;
          const ranges = yield* unitRanges(recording);
          if (ranges._tag === "Ranges") {
            ownedRanges = ranges.ranges as ReadonlyArray<OwnedRange>;
            blobSections = ranges.sections ?? [];
            // The blob reads, but disagrees with the payload or with itself: every range is kept.
            for (const issue of ranges.issues ?? [])
              undecoded.push({
                what: `sections of ${unit.unit}`,
                ref: recording.refs[0].ref,
                issue,
                part: "unit-sections",
                ...of,
              });
          } else
            undecoded.push({
              what: `sections of ${unit.unit}`,
              ref: ranges.ref,
              issue: ranges.issue,
              part: "unit-sections",
              ...of,
            });
          recorded = {
            ...recording,
            payload: { ...recording.payload, ownedRanges },
          };
        } else if (recording !== undefined) {
          recorded = recording;
          ownedRanges = recording.payload.ownedRanges;
        }
        const assessment = mine
          .filter(
            (
              e,
            ): e is
              | Of<"assessment.recorded@2">
              | Of<"assessment.recorded@3">
              | Of<"assessment.recorded@4"> =>
              (e.kind === "assessment.recorded@4" ||
                e.kind === "assessment.recorded@3" ||
                e.kind === "assessment.recorded@2") &&
              e.attribution.unitIds[0] === unit.unitId,
          )
          .reduce<ReadUnit["assessment"]>(
            (newest, e) =>
              newest === undefined || e.id > newest.id ? e : newest,
            undefined,
          );
        const v4 =
          assessment?.kind === "assessment.recorded@4" ? assessment : undefined;
        const judged =
          v4 === undefined ? undefined : yield* judgementsOf(v4, undecoded, of);
        const judgements = judged?.entries;
        const sections = blobSections.map((section): ReadSection => {
          const { key: _key, ...judged } = judgements?.get(section.key) ?? {
            key: section.key,
          };
          // Each section's content decodes on its own: one that does not is left off that
          // section and said, and the unit keeps its lines, its other sections and their content.
          // So does its side: one this build does not know reads as absent, and is said.
          const { side: rawSide, ...parts } = section.parts;
          const side =
            rawSide === undefined ? undefined : safeRead(SectionSide, rawSide);
          if (side !== undefined && !side.success)
            undecoded.push({
              what: `side of section ${section.key} of ${unit.unit}`,
              ref: blobRef,
              issue: firstIssue(side.error),
              part: "unit-sections",
              ...of,
              section: section.key,
            });
          // Its ranges' hunk IDs read only as one string per range; anything else is said, and
          // the section's hunks resolve as a blob without them does.
          const rangeHunks =
            section.rangeHunks === undefined
              ? undefined
              : safeRead(
                  z.array(z.string()).length(section.ownedRanges.length),
                  section.rangeHunks,
                );
          if (rangeHunks !== undefined && !rangeHunks.success)
            undecoded.push({
              what: `range hunks of section ${section.key} of ${unit.unit}`,
              ref: blobRef,
              issue: firstIssue(rangeHunks.error),
              part: "unit-sections",
              ...of,
              section: section.key,
            });
          const content =
            section.content === undefined
              ? undefined
              : safeRead(SectionContent, section.content);
          if (content !== undefined && !content.success)
            undecoded.push({
              what: `content of section ${section.key} of ${unit.unit}`,
              ref: blobRef,
              issue: firstIssue(content.error),
              part: "unit-sections",
              ...of,
              section: section.key,
            });
          return {
            ...judged,
            key: section.key,
            title: section.title,
            parts: {
              ...parts,
              ...(side?.success === true ? { side: side.data } : {}),
            },
            where: section.where,
            renamedFrom: section.renamedFrom,
            ...(content?.success === true ? { content: content.data } : {}),
            ...(rangeHunks?.success === true
              ? { rangeHunks: rangeHunks.data }
              : {}),
            ownedRanges: section.ownedRanges.map((range): OwnedRange =>
              range.kind === "lines"
                ? {
                    kind: "lines",
                    path: range.path,
                    side: range.side,
                    startLine: range.startLine,
                    endLine: range.endLine,
                  }
                : {
                    kind: "whole-nontext",
                    path: range.path,
                    side: range.side,
                  },
            ),
          };
        });
        // The phrase links of each section's own Briefed and Explained cite under the unit's stop
        // of the same name, after the unit's stops: a phrase in a section's Briefed links as the
        // unit lead's does, and a line cite only a section's text holds is one of the unit's
        // citations. Its Facts cites are already the unit's (the unit's Facts stop joins them);
        // its Explained cites list stays the section's, as before.
        for (const { content: own } of sections)
          if (own !== undefined)
            stops.push(
              ...(own.briefed === null
                ? []
                : [["briefed", { text: own.briefed }] as const]),
              ...(own.explained === null
                ? []
                : [
                    [
                      "explained",
                      {
                        before: own.explained.before,
                        after: own.explained.after,
                      },
                    ] as const,
                  ]),
            );
        // The hunks its sections hold, for every ID of the batch that names one: each range's
        // own where the blob names them, else those the section's Facts cite.
        for (const section of sections) {
          if (section.rangeHunks !== undefined) {
            const named = new Map<string, Array<OwnedRange>>();
            section.rangeHunks.forEach((id, at) =>
              named.set(id, [
                ...(named.get(id) ?? []),
                section.ownedRanges[at]!,
              ]),
            );
            for (const [id, ranges] of named)
              hunks.set(id, [
                ...(hunks.get(id) ?? []),
                {
                  path: section.parts.path,
                  ranges,
                  own: true,
                  hunks: named.size,
                },
              ]);
            continue;
          }
          const cites = new Set(section.content?.facts.cites ?? []);
          for (const id of cites)
            hunks.set(id, [
              ...(hunks.get(id) ?? []),
              {
                path: section.parts.path,
                ranges: section.ownedRanges,
                own: false,
                hunks: cites.size,
              },
            ]);
        }
        // A body and a blob that disagree on the unit's sections leave some unjudged: said, once.
        if (
          v4 !== undefined &&
          judgements !== undefined &&
          recording?.kind === "unit.recorded@3"
        ) {
          const held = new Set(blobSections.map((section) => section.key));
          // An entry that did not decode is already disclosed on its own.
          const unjudged = blobSections.filter(
            (section) =>
              !judgements.has(section.key) && !judged!.failed.has(section.key),
          ).length;
          const stray = [...judgements.keys()].filter(
            (key) => !held.has(key),
          ).length;
          if (blobSections.length > 0 && (unjudged > 0 || stray > 0))
            undecoded.push({
              what: `judgements of ${unit.unit}`,
              ref: v4.refs[0].ref,
              issue: `${unjudged} of its ${blobSections.length} sections have no judgement, and ${stray} judgements name no section of the unit`,
              part: "judgements",
              ...of,
            });
        }
        // Checkpoints come only from judgements joined to a section of the unit's blob: a stray
        // one is disclosed above and gives none. With no sections read (the blob could not be
        // read, or the unit is not a version 3), nothing can be joined, so none gives a checkpoint
        // and that is said.
        const heldKeys = new Set(blobSections.map((section) => section.key));
        const joined = [...(judgements?.values() ?? [])].filter((judgement) =>
          heldKeys.has(judgement.key),
        );
        if (
          v4 !== undefined &&
          judgements !== undefined &&
          judgements.size > 0 &&
          blobSections.length === 0
        )
          undecoded.push({
            what: `judgements of ${unit.unit}`,
            ref: v4.refs[0].ref,
            issue: `none of its ${judgements.size} judgements can be joined to a section, since the unit's sections could not be read, so they give no checkpoints`,
            part: "judgements",
            ...of,
          });
        const held = index?.units.find((held) => held.id === unit.unit);
        // A version 4 unit's checkpoints are placed across the packet once all its batches are
        // read (`sectionCheckpoints`): an Assess class can span batches, and a requirement no
        // section ties to a line goes on one unit only.
        if (v4 !== undefined)
          placing.push({
            batch: batches.length,
            at: units.length,
            pins,
            sections: joined.map((judgement) => ({
              entry: judgement,
              ownedRanges:
                blobSections.find((section) => section.key === judgement.key)
                  ?.ownedRanges ?? [],
            })),
            ownedPaths: ownedRanges.map((range) => range.path),
          });
        const { checkpoints, proofCurrency } =
          v4 !== undefined
            ? { checkpoints: [], proofCurrency: {} }
            : yield* unitCheckpoints({
                assessment:
                  assessment?.kind === "assessment.recorded@4"
                    ? undefined
                    : assessment,
                recorded:
                  recorded?.kind === "unit.recorded@2" ? recorded : undefined,
                pins,
                untested: held?.assessment?.validation.requirements.map(
                  (requirement) => requirement.untested || undefined,
                ),
                check,
              });
        // The review's own disposition, and apart from it the decisions registered people made on
        // an earlier unit this one is unchanged from, carried onto it: told apart by the actor's
        // kind in `projection_actors`, since Publish records the review's own as an agent.
        const decisions = mine.filter(
          (e): e is Of<"disposition.recorded@2" | "disposition.carried@1"> =>
            (e.kind === "disposition.recorded@2" ||
              e.kind === "disposition.carried@1") &&
            e.attribution.unitIds[0] === unit.unitId,
        );
        const people = new Set<string>();
        for (const actor of new Set(decisions.map((e) => e.actor))) {
          const [row] = yield* sqlV2<{
            actorKind: string;
          }>`SELECT actor_kind FROM projection_actors WHERE actor_id = ${actor}`;
          if (row?.actorKind === "human") people.add(actor);
        }
        units.push({
          local: unit.unit,
          unitId: unit.unitId,
          recorded,
          assessment,
          checkpoints,
          proofCurrency,
          content: content as UnitContent,
          sections,
          references,
          referenceDetails: Object.fromEntries(
            references.flatMap((event) => {
              const local = referenceLocals.get(event.id);
              const detail =
                local === undefined
                  ? undefined
                  : resolver.referenceDetail(local);
              return detail === undefined ? [] : [[event.id, detail]];
            }),
          ),
          comments: mine.filter(
            (
              e,
            ): e is Of<
              "comment.recorded@2" | "comment.recorded@3" | "comment.carried@1"
            > =>
              e.kind === "comment.recorded@2" ||
              e.kind === "comment.recorded@3" ||
              e.kind === "comment.carried@1",
          ),
          disposition: decisions.find((e) => !people.has(e.actor)),
          carriedDecisions: decisions
            .filter(
              (e): e is Of<"disposition.carried@1"> =>
                e.kind === "disposition.carried@1" && people.has(e.actor),
            )
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
          lineage: mine
            .filter(
              (e): e is Of<"lineage.recorded@1"> =>
                e.kind === "lineage.recorded@1" &&
                e.attribution.unitIds[0] === unit.unitId,
            )
            .reduce<Of<"lineage.recorded@1"> | undefined>(
              (newest, e) =>
                newest === undefined || e.id > newest.id ? e : newest,
              undefined,
            ),
          judgement: yield* judge(unit.unitId),
          // Resolved below, once every unit's sections are read.
          citations: { cited: [], resolved: 0, unresolved: 0 },
        });
        unitStops.push(stops);
      }
      for (const [place, stops] of unitStops.entries())
        units[place] = {
          ...units[place]!,
          citations: yield* citationsOf(resolver, stops),
        };
      batches.push({
        local: entry.batch,
        batchId: entry.batchId,
        recorded: events.find(
          (e): e is Of<"batch.recorded@1"> => e.kind === "batch.recorded@1",
        ),
        digest: digest.decoded,
        digestCitations: yield* citationsOf(
          resolver,
          digest.raw === undefined ? [] : [["batch-digest", digest.raw]],
        ),
        assembled: assembledRef,
        units,
        key: entry.key,
        publishedBy:
          entry.publishedBy === undefined
            ? undefined
            : {
                runId: entry.publishedBy.runId,
                ordinal: entry.publishedBy.ordinal,
              },
        gaps: yield* gapsNamed(
          entry.gaps ?? [],
          `batch ${entry.batch}`,
          entry.batch,
        ),
      });
    }
    // Once over the whole packet, written back to each unit by its batch and place.
    const placed = yield* sectionCheckpoints({ units: placing, check });
    placing.forEach(({ batch, at }, index) => {
      const held = batches[batch]!;
      batches[batch] = {
        ...held,
        units: held.units.map((unit, place) =>
          place === at ? { ...unit, ...placed[index]! } : unit,
        ),
      };
    });
    const cited = batches.flatMap((batch) => [
      batch.digestCitations,
      ...batch.units.map((unit) => unit.citations),
    ]);
    yield* Effect.annotateCurrentSpan({
      "neuve.packet.id": packet.id,
      "neuve.packet.kind": packet.kind,
      "neuve.packet.ordinal": packet.payload.ordinal,
      "neuve.packet.batches": batches.length,
      "neuve.packet.units": batches.reduce((n, b) => n + b.units.length, 0),
      "neuve.packet.citations.resolved": cited.reduce(
        (n, c) => n + c.resolved,
        0,
      ),
      "neuve.packet.citations.unresolved": cited.reduce(
        (n, c) => n + c.unresolved,
        0,
      ),
      "neuve.packet.undecoded": undecoded.length,
      "neuve.packet.currency_checked": check !== undefined,
    });
    return {
      kind: "packet.published@2",
      eventId: packet.id,
      supersedes: packet.causation?.supersedes ?? null,
      requestedPacket,
      manifest: hash,
      complete: packet.payload.complete,
      ordinal: packet.payload.ordinal,
      counts: packet.payload.counts,
      added: packet.payload.added,
      sequence: manifest?.sequence,
      unmatched: manifest?.unmatched ?? [],
      batches,
      gaps: [...gapEvents.values()],
      undecoded,
    } satisfies ReadPacketV2;
  });

/** Reads a packet of either shape; undefined when the ID names no packet. */
const readAny = (
  packetId: string,
  requestedPacket: string,
  options: ReadOptions,
) =>
  Effect.gen(function* () {
    const stored = yield* get(packetId);
    if (Option.isNone(stored)) return undefined;
    const packet = stored.value.event;
    if (packet.kind === "packet.published@2")
      return (yield* readPacketV2(
        packet,
        requestedPacket,
        options,
      )) as ReadPacket;
    if (packet.kind !== "packet.published@1") return undefined;
    const read = yield* readPacket(packetId, requestedPacket, options);
    return read === undefined
      ? undefined
      : ({
          kind: "packet.published@1",
          ...read,
        } satisfies ReadPacketV1 as ReadPacket);
  });

/** One immutable packet of either shape, even after a later packet supersedes it. */
export const readExact = (packetId: string, options: ReadOptions = {}) =>
  readAny(packetId, packetId, options).pipe(
    Effect.withSpan("records.packets.read-exact", {
      attributes: { "neuve.packet.id": packetId },
    }),
  );

/** A cycle's packet of record, of either shape. Undefined when the cycle has none. */
export const readStanding = (cycleId: string, options: ReadOptions = {}) =>
  Effect.gen(function* () {
    const id = yield* standingPacketId(cycleId);
    return id === undefined ? undefined : yield* readAny(id, id, options);
  }).pipe(
    Effect.withSpan("records.packets.read-standing", {
      attributes: { "neuve.cycle.id": cycleId },
    }),
  );

/**
 * A run's packet as its cycle stands, of either shape: the cycle's packet of record, with
 * `requestedPacket` naming the run's own, which is the newest packet the run published (a run
 * publishes a chain of them). Undefined when the run published none.
 */
export const readRun = (runId: string, options: ReadOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [own] = yield* sql<{
      id: string;
    }>`SELECT id FROM events
      WHERE kind IN ('packet.published@1', 'packet.published@2')
        AND json_extract(envelope, '$.attribution.runId') = ${runId}
      ORDER BY id DESC LIMIT 1`;
    if (own === undefined) return undefined;
    const cycle = (yield* get(own.id)).pipe(
      Option.map((e) => (e.event.attribution as { cycleId?: string }).cycleId),
      Option.getOrUndefined,
    );
    const standing =
      cycle === undefined ? undefined : yield* standingPacketId(cycle);
    return yield* readAny(standing ?? own.id, own.id, options);
  }).pipe(
    Effect.withSpan("records.packets.read-run", {
      attributes: { "neuve.run.id": runId },
    }),
  );
