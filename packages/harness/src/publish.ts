import { safeRead } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { Clock, Data, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  Dispositions,
  Log,
  Proofs,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core";
import {
  Citation,
  GapKind,
  OwnedRange,
  type Range,
} from "@neuve/records-schema";
import {
  AssembledBatch,
  unitPlace,
  verdictWordsIn,
  type AssembledUnit,
  type CitationTarget,
  type Reference,
} from "./compose.ts";
import type { PipelineConfig } from "./config.ts";
import type { GuidedBasis } from "@neuve/records-schema";
import { LinkedReview } from "./disposition.ts";
import {
  MAX_ROWS,
  applyLane,
  approvalProof,
  unitGuidedBasis,
} from "./disposition.ts";
import { ChangeMap } from "./review-map.ts";
import { ScopeSnapshot } from "./scope.ts";
import { RangeManifest } from "./manifest.ts";
import { qualificationWords } from "./reader-text.ts";
import type { StageRecord } from "./pipeline.ts";
import {
  appendTelemetry,
  harnessActor,
  harnessRegistration,
  stageTelemetry,
} from "./receipt.ts";
import type { RunLog } from "./run-log.ts";

/**
 * Publish (proposal §10; 10.73, PU1–PU6, 10.69, 10.83): appends the packet to Records from the
 * stored outputs, so later information never rewrites it (5.5, 8.7). Per confirmed batch, one append
 * transaction: the batch, its units (`unit.recorded@2`, owned ranges without the hunk IDs Assemble
 * kept), context references, assessments, the delivery content (digest, Facts, Briefed, Explained,
 * Guided, each a computation the event references, PU3), then the findings as comments and last the
 * dispositions that rest on them (§10.2 with the H4 review's order: comments before dispositions,
 * which the append rule checks). Then the run's gaps, the promotion of every cited proof artefact to
 * durable (slice H4b), and last the manifest (a durable content-addressed blob) named by one
 * `packet.published@1`. IDs are ULIDs at the run's start time derived from the run and each event's
 * key, so a replayed Publish appends nothing new and payloads that cite another event's ID match.
 * A unit that owns nothing is not recorded as a unit: no disposition could cover it (vocabulary:
 * owned range), so Publish discloses it instead (the H7 review's carried point; an owner call).
 * The run folder is deleted afterwards, by the handler's cleanup, once the workflow has returned.
 */

export interface PublishContext {
  readonly repository: string;
  readonly runId: string;
  readonly runKey: string;
  readonly range: Range;
  readonly cycleId: string;
  readonly config: PipelineConfig;
  readonly log: RunLog;
  readonly startedAt: number;
  /**
   * Set on a recompose run (`recompose.ts`), which runs only in a scratch store: a unit's review it
   * recomputed with the model is recorded as this generation's own. Absent on every review a person
   * requests.
   */
  readonly recompose?: { readonly allow: ReadonlySet<string> } | undefined;
}

/** One code-filled group and the unit reviews Link attached to it. */
export interface PublishCandidate {
  readonly candidate: string;
  readonly assembledKey: string | null;
  readonly disposed: ReadonlyArray<{
    readonly unit: string;
    readonly key: string | null;
    readonly status: StageRecord["status"];
  }>;
}

export interface PublishInputs {
  /** Kept findings, including any Link could not place on a unit (12.41). */
  readonly findings?: ReadonlyArray<string> | undefined;
  readonly candidates: ReadonlyArray<PublishCandidate>;
  /** Every stage record so far, for whether the packet is complete (12.41). */
  readonly stages: ReadonlyArray<StageRecord>;
  readonly sources: {
    readonly manifest: string | null;
    readonly changeMap: string | null;
    readonly scope: string | null;
  };
  readonly strongestStratum: string;
  /** Why nothing was assembled, when Assemble never started. */
  readonly reason?: string | undefined;
  /**
   * What moved since the cycle's external sources were read (11.18), in the reader's words, from
   * the run's freshness check; `cause` stays in the run log.
   */
  readonly disclosures?:
    | ReadonlyArray<{
        readonly kind: string;
        readonly detail: string;
        readonly cause?: string | undefined;
      }>
    | undefined;
}

/** The run's clock is far ahead of this one: IDs minted from it could pin later records (§10.2). */
export class PublishClockRefused extends Data.TaggedError(
  "PublishClockRefused",
)<{
  readonly message: string;
  readonly retryable: false;
}> {}

/**
 * Publish's version: delivery content is a computation keyed by its inputs and this version, so a
 * change to what Publish writes for the same inputs (2: Guided rows for units no review reached;
 * 3: unit-scoped rows, static closure and the digest's obligation statuses, 10.87; 4: the Guided
 * stop's code-written sentences without internal handles or decision numbers; 5: checkpoints, with
 * each requirement's proof state and its reader's note on the Guided rows, 11.16;
 * 6: verified finding links, no approvals or carried writes, and batch-level gaps; 7: completeness
 * from stages and batch ownership rather than unreviewed units, and finding fates, 12.41)
 * is a new computation, never the stored content of an earlier version.
 */
export const PUBLISH_VERSION = 7;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID from a time, a sequence and a seed: the time's 48 bits, then 16 bits of sequence (so IDs
 * minted in one Publish sort in its order: a unit's assessment before its disposition), then 64 bits
 * of the seed's SHA-256. The same inputs give the same ID on every replay.
 */
export const stableUlid = (timeMs: number, sequence: number, seed: string) => {
  const time = BigInt(Math.max(0, Math.min(Math.floor(timeMs), 2 ** 48 - 1)));
  const random =
    (BigInt(sequence & 0xffff) << 64n) |
    BigInt(`0x${sha256Hex(seed).slice(0, 16)}`);
  let value = (time << 80n) | random;
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
};

/** Text cut to `max` UTF-16 units at a code-point boundary, control characters but tab and newline replaced. */
export const clipText = (text: string, max: number, fallback = "-") => {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  let out = "";
  for (const char of clean) {
    if (out.length + char.length > max) break;
    out += char;
  }
  const trimmed = out.trim();
  return trimmed === "" ? fallback : trimmed;
};

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const readOutput = <O>(key: string, parse: (value: unknown) => O) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const held = yield* store.lookup(key);
    if (Option.isNone(held)) return undefined;
    const read = yield* blobs.get(held.value.outputHash);
    if (read._tag === "Pruned") return undefined;
    const value = JSON.parse(new TextDecoder().decode(read.bytes)) as {
      output?: unknown;
    };
    return parse(
      value !== null && typeof value === "object" && "output" in value
        ? value.output
        : value,
    );
  });

/** Stores one delivery stop's content as a computation and returns its key (PU3). */
const content = (inputs: Record<string, string>, value: unknown) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    // Keyed by the content too, so a change to what Publish writes for the same inputs is always a
    // new computation, never the stored content of an earlier build.
    const result = yield* store.run(
      {
        op: "harness.delivery",
        opVersion: PUBLISH_VERSION,
        inputs: { ...inputs, content: sha256Hex(canonicalJson(value)) },
      },
      Effect.succeed({
        bytes: new TextEncoder().encode(JSON.stringify(value)),
        mediaType: "application/json",
      }),
    );
    return result.computation.key;
  });

/** The packet's content-addressed hash of an event: everything but its ID, time and key. */
const eventHash = (event: Record<string, unknown>) => {
  const { id: _id, occurredAt: _at, idempotencyKey: _key, ...rest } = event;
  return sha256Hex(canonicalJson(rest));
};

interface Gap {
  readonly key: string;
  readonly kind: string;
  /** What the reader can't see or rely on, and why, in a reader's words. */
  readonly detail: string;
  readonly unitIds?: ReadonlyArray<string> | undefined;
  /** The technical cause (handles, error messages): the run log's only, never Records'. */
  readonly cause?: string | undefined;
}

/** What one Records event is, as a reader names it, for a disclosure about it. */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  "batch.recorded@1": "the batch's record",
  "unit.recorded@2": "a unit",
  "context.referenced@2": "a context reference",
  "assessment.recorded@2": "a unit's assessment",
  "assessment.recorded@3": "a unit's assessment",
  "delivery.recorded@1": "a briefing or review stop",
  "comment.recorded@2": "a review comment",
  "disposition.recorded@2": "an agent review decision",
};

/** How a reference no Records provenance fits is named for the reader: its source's title or path. */
const referenceName = (
  reference: Reference,
  snapshot: ScopeSnapshot | undefined,
) => {
  const source = reference.source;
  if (source.origin === "stack")
    return `${source.stack.name} ${source.stack.version}, ${source.path}`;
  if (source.origin !== "scope") return source.path;
  const held = snapshot?.sources.find((s) => s.id === source.sourceId);
  const section = held?.sections.find((s) => s.id === source.sectionId);
  const kind =
    source.sourceKind === "ticket"
      ? "ticket"
      : source.sourceKind === "repository-document"
        ? "document"
        : source.sourceKind === "commit-text"
          ? "commit message"
          : "scope source";
  const title =
    held === undefined
      ? undefined
      : source.sourceKind === "repository-document"
        ? (held.ref.path ?? held.title)
        : held.title;
  const where =
    section !== undefined && section.title !== "" && section.title !== title
      ? `, section "${section.title}"`
      : "";
  return title === undefined
    ? `a ${kind} section`
    : `the ${kind} "${title}"${where}`;
};

/**
 * A unit's owned ranges as its `unit.recorded@2` holds them, in order, each beside Assemble's range
 * it came from: a checkpoint's anchors are indices into this list (11.17).
 */
const recordedRanges = (unit: AssembledUnit) =>
  unit.ownedRanges
    .flatMap((range) => {
      const { hunkId: _hunk, ...rest } = range;
      const parsed = OwnedRange.safeParse(rest);
      return parsed.success ? [{ range, parsed: parsed.data }] : [];
    })
    .slice(0, 1_024);

/** A requirement's anchors as indices into its unit's recorded owned ranges (11.17). */
const anchorIndices = (
  anchors: AssembledUnit["assessment"]["validation"]["requirements"][number]["anchors"],
  recorded: ReturnType<typeof recordedRanges>,
) => [
  ...new Set(
    anchors.flatMap((anchor) => {
      const index = recorded.findIndex(
        ({ range }) =>
          range.kind === "lines" &&
          range.hunkId === anchor.hunk &&
          range.side === anchor.side &&
          range.startLine === anchor.startLine &&
          range.endLine === anchor.endLine,
      );
      return index < 0 ? [] : [index];
    }),
  ),
];

/** The Guided stop's content for one unit (10.67): rows, outside items, the review and, on human-required work, the suggestion. */
const guidedContent = (options: {
  readonly unit: AssembledUnit;
  readonly stored: LinkedReview | undefined;
  /**
   * The rows code fills when no review is stored (§9.3: the criteria code can fill, at
   * no-evidence), from the change map's obligations; a stored review carries its own.
   */
  readonly basis: GuidedBasis | undefined;
  readonly status: StageRecord["status"] | "owns-nothing";
  readonly strongestStratum: string;
  readonly commentIds: ReadonlyArray<string>;
}) => {
  const { unit, stored } = options;
  const review = stored?.review ?? null;
  const basis = stored?.guided ?? options.basis;
  const lane = unit.assessment.lane;
  const coverage = new Map(
    unit.assessment.validation.requirements.map((r) => [
      r.requirement,
      {
        coverage: r.coverage,
        note: r.coverageNote,
        proofState: r.proofState,
        proofNote: r.proofNote,
      },
    ]),
  );
  // 10.87: on a unit static automation closed, the rows it was closed on are the rows whose
  // validation requirements are all solid; the others are not required by this unit.
  const statically = lane === "static-automation";
  const rows = (basis?.rows ?? []).map((row) => {
    const judged = review?.criteria.find((c) => c.row === row.row);
    const solid =
      row.requirements.length > 0 &&
      row.requirements.every(
        (r) => coverage.get(r.requirement)?.coverage === "solid",
      );
    return {
      row: row.row,
      text: row.text,
      basis: row.basis,
      sectionId: row.sectionId,
      /** A row's status is this unit's (10.87); the batch digest holds its status across units. */
      scope: "this unit" as const,
      required: !statically || solid,
      ...(statically ? { closedOn: solid } : {}),
      status: judged?.status ?? "no-evidence",
      does:
        judged?.does ??
        "No verified finding establishes this condition's outcome for this unit.",
      evidence: judged?.evidence ?? [],
      // 11.1: Assemble rated every requirement of the row solid, yet the review found it not met
      // or saw no evidence: the sources disagree, and the stop says so rather than showing it silently.
      ...(solid && judged !== undefined && judged.status !== "met"
        ? {
            disagreement: `The assessment rated this row's proof solid, but the review found it ${judged.status === "not-met" ? "not met" : "without evidence"}`,
          }
        : {}),
      requirements: row.requirements.map((r) => ({
        ...r,
        ...(coverage.get(r.requirement) ?? {
          coverage: "missing",
          note: "not assessed",
        }),
      })),
    };
  });
  const proof = approvalProof(unit);
  return {
    unit: unit.id,
    lane,
    basis: basis?.level ?? "none",
    unlinked: basis?.unlinked ?? false,
    stratum: options.strongestStratum,
    rows,
    outside: review?.outside ?? [],
    implied: basis?.implied ?? [],
    /** Rows past the review's 20-row bound: disclosed, not judged. */
    omitted: basis?.omitted ?? [],
    review:
      review === null
        ? null
        : {
            source: stored!.source,
            verdict: review.verdict,
            message: review.message,
            uncited: stored!.uncited,
            // 10.86: an approval beside a not-met row with no cited defect records no disposition.
            withheld: stored!.withheld === true,
            gaps: review.gaps,
          },
    // A suggestion only on human-required units (10.67); not a disposition until a person sends it.
    suggestion:
      lane === "human-required" && review !== null && stored?.withheld !== true
        ? {
            verdict: review.verdict,
            message: review.message,
            comments: [...options.commentIds],
          }
        : null,
    proof: proof.text,
    notes: stored?.notes ?? [],
  };
};

/** What Publish counted and wrote, for its stage record and `neuve review show`. */
export interface PublishSummary {
  readonly manifest: string | null;
  readonly packetEventId: string | null;
  readonly complete: boolean;
  readonly counts: {
    batches: number;
    units: number;
    contextReferences: number;
    assessments: number;
    deliveries: number;
    dispositions: number;
    comments: number;
    gaps: number;
  };
  readonly closure: Record<string, number>;
  readonly promoted: number;
  /** Finding fates follow the actual comment append results, never the attempted writes. */
  readonly findings: ReadonlyArray<
    { readonly id: string } & (
      | { readonly fate: "published"; readonly publicationId: string }
      | { readonly fate: "withheld"; readonly reason: string }
    )
  >;
}

/** Event classes: the 16-bit sequence of a new event's ID, so a unit's assessment sorts before its disposition. */
const CLASS: Readonly<Record<string, number>> = {
  "batch.recorded@1": 1,
  "unit.recorded@2": 2,
  "context.referenced@2": 3,
  "assessment.recorded@2": 4,
  "assessment.recorded@3": 4,
  "delivery.recorded@1": 5,
  "comment.recorded@2": 6,
  "disposition.recorded@2": 7,
  "gap.disclosed@1": 8,
  "packet.published@1": 9,
};

/** One event of the packet as the manifest lists it: its stable position, its key and its stored ID. */
interface ManifestEvent {
  readonly kind: string;
  readonly base: string;
  readonly key: string;
  readonly id: string | null;
  readonly hash: string;
}

/**
 * What Records already holds for this run key in this cycle, by idempotency key: an earlier
 * generation's packet events, or this run's own from an attempt that stopped partway.
 */
const keyedIds = (prefix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    // `#` (0x23) separates a position from its content hash; `$` (0x24) bounds the range scan.
    const rows = yield* sql<{
      id: string;
      key: string;
    }>`SELECT id, idempotency_key AS key FROM events
      WHERE idempotency_key >= ${prefix} AND idempotency_key < ${`${prefix}\u{10FFFF}`}
      ORDER BY id`;
    return rows;
  });

export const publishPacket = (ctx: PublishContext, inputs: PublishInputs) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const occurredAt = new Date(started).toISOString();
    if (ctx.startedAt > started + 60_000)
      return yield* new PublishClockRefused({
        message: `the run's start ${new Date(ctx.startedAt).toISOString()} is more than a minute ahead of this clock`,
        retryable: false,
      });
    const run = ctx.runId;
    // Positions are the cycle and the run's computation key (§10.2), never the run: a later
    // generation of the same request (after a timeout, 10.42) appends only what the earlier packet
    // lacks, under the same batch and unit IDs, so a cycle never holds two sets of units.
    const namespace = `review:${ctx.cycleId}:${ctx.runKey}:`;
    const store = yield* Computations.ComputationStore;
    const epochRead = yield* store.run(
      {
        op: "harness.publish-epoch",
        opVersion: 1,
        inputs: { cycle: ctx.cycleId, runKey: ctx.runKey },
      },
      Effect.succeed({
        bytes: new TextEncoder().encode(JSON.stringify({ at: ctx.startedAt })),
        mediaType: "application/json",
      }),
    );
    const epoch = (
      JSON.parse(new TextDecoder().decode(epochRead.output)) as { at: number }
    ).at;
    const entityId = (key: string) =>
      stableUlid(epoch, 0, `${namespace}entity:${key}`);
    const held = new Map<string, string>();
    for (const row of yield* keyedIds(namespace)) held.set(row.key, row.id);
    // What this run mints carries its start in the ID's time (`stableUlid`); what it reuses keeps
    // the ID an earlier generation minted.
    const thisRun = stableUlid(ctx.startedAt, 0, "").slice(0, 10);
    /** A unit's Guided stops earlier generations recorded, oldest first. */
    const earlierStops = (unit: string) => {
      const base = `${namespace}unit:${unit}:guided`;
      return [...held]
        .filter(
          ([key, id]) =>
            (key === base || key.startsWith(`${base}#`)) &&
            id.slice(0, 10) !== thisRun,
        )
        .map(([key, id]) => ({ key, id }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    };
    /** The Dispose computation a recorded Guided stop was written from, as its content's inputs name it. */
    const disposeOf = (eventId: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const [row] = yield* sql<{
          ref: string | null;
        }>`SELECT json_extract(envelope, '$.refs[0].ref') AS ref FROM events WHERE id = ${eventId}`;
        if (typeof row?.ref !== "string" || !row.ref.startsWith("computation:"))
          return undefined;
        const content = Option.getOrUndefined(
          yield* store.lookup(row.ref.slice("computation:".length)),
        );
        if (content === undefined) return undefined;
        const spec = JSON.parse(content.material) as {
          readonly inputs?: { readonly dispose?: unknown };
        };
        return typeof spec.inputs?.dispose === "string"
          ? spec.inputs.dispose
          : undefined;
      });
    /** The newest event Records holds at a position, under any content. */
    const latestAt = (base: string) => {
      let found: { key: string; id: string } | undefined;
      for (const [key, id] of held)
        if (
          (key === `${namespace}${base}` ||
            key.startsWith(`${namespace}${base}#`)) &&
          (found === undefined || id > found.id)
        )
          found = { key, id };
      return found;
    };
    /** The newest event at a position, other than `full` and older than `id`. */
    const previousAt = (base: string, full: string, id: string) => {
      let found: { key: string; id: string } | undefined;
      for (const [key, heldId] of held)
        if (
          key !== full &&
          heldId < id &&
          (key === `${namespace}${base}` ||
            key.startsWith(`${namespace}${base}#`)) &&
          (found === undefined || heldId > found.id)
        )
          found = { key, id: heldId };
      return found;
    };
    // The packet's actors belong to the request in its cycle, not to one generation of it, so a
    // later generation's events match the earlier ones and its dispositions are the same reviewer's.
    const session = `review:${ctx.cycleId}:${ctx.runKey}`;
    const actors = {
      assemble: harnessActor(session, "link"),
      dispose: harnessActor(session, "link"),
      publish: harnessActor(session, "publish"),
    };
    yield* appendTelemetry(ctx.log, [
      harnessRegistration(session, "link", occurredAt),
      harnessRegistration(session, "publish", occurredAt),
    ]);
    /**
     * An event at a stable position. A content-keyed one carries its content's hash in its key, so
     * changed content (a unit assessed in this generation that the earlier one could not) is a new
     * event that supersedes the earlier one; unchanged content is the same key, already held. One
     * keyed by its run (`{ run }`) is that generation's own and supersedes nothing.
     */
    const event = (
      kind: string,
      base: string,
      actor: string,
      attribution: Record<string, unknown>,
      payload: unknown,
      refs?: ReadonlyArray<{ readonly ref: string; readonly role: string }>,
      keyed: boolean | { readonly run: string } = true,
    ) => {
      const content = { kind, attribution, payload, refs: refs ?? null };
      const key =
        keyed === true
          ? `${base}#${sha256Hex(canonicalJson(content)).slice(0, 16)}`
          : keyed === false
            ? base
            : `${base}#run:${keyed.run}`;
      const full = `${namespace}${key}`;
      const id =
        held.get(full) ?? stableUlid(ctx.startedAt, CLASS[kind] ?? 15, full);
      // What this event supersedes: the newest other event at its position that is older than it,
      // so a replay of a later generation names the same earlier event it named the first time.
      const previous = keyed === true ? previousAt(base, full, id) : undefined;
      return {
        id,
        kind,
        idempotencyKey: full,
        actor,
        occurredAt,
        attribution,
        payload,
        ...(refs === undefined ? {} : { refs }),
        ...(previous === undefined
          ? {}
          : { causation: { supersedes: previous.id } }),
        base,
      };
    };
    type Built = ReturnType<typeof event>;
    const strip = ({ base: _base, ...rest }: Built) => rest;

    const gaps: Array<Gap> = [];
    const counts = {
      batches: 0,
      units: 0,
      contextReferences: 0,
      assessments: 0,
      deliveries: 0,
      dispositions: 0,
      comments: 0,
      gaps: 0,
    };
    const manifestBatches: Array<unknown> = [];
    const publishedUnits: Array<string> = [];
    const citedProofs = new Set<string>();
    let complete = !inputs.stages.some(
      (stage) => stage.status === "interrupted" || stage.status === "skipped",
    );
    for (const [index, disclosure] of (inputs.disclosures ?? []).entries())
      gaps.push({
        key: `freshness:${index}`,
        kind: disclosure.kind,
        detail: disclosure.detail,
        cause: disclosure.cause,
      });
    if (inputs.reason !== undefined) {
      complete = false;
      gaps.push({
        key: "nothing-assembled",
        kind: "nothing-assembled",
        detail: `Nothing in this change was assessed, because ${inputs.reason}.`,
      });
    }

    // The change map, for the Guided rows of units no review reached (§9.3).
    const changeMap =
      inputs.sources.changeMap === null
        ? undefined
        : yield* readOutput(inputs.sources.changeMap, (value) =>
            readData(ChangeMap, value),
          );
    const groups = new Map(
      (changeMap?.behaviours ?? []).map((group) => [
        group.id,
        {
          label: group.title,
          obligations: group.obligations,
        },
      ]),
    );
    // The scope snapshot, only to name the scope sources a reference cites when Records can't hold it.
    const scopeRead =
      inputs.sources.scope === null
        ? undefined
        : yield* Effect.result(
            readOutput(inputs.sources.scope, (value) => {
              const parsed = safeRead(ScopeSnapshot, value);
              return parsed.success ? parsed.data : undefined;
            }),
          );
    const snapshot =
      scopeRead?._tag === "Success" ? scopeRead.success : undefined;
    // The range manifest, read once and only when a unit owns nothing (null: not read yet).
    let rangeManifest: RangeManifest | undefined | null = null;
    const findings = new Map<string, PublishSummary["findings"][number]>(
      (inputs.findings ?? []).map((id) => [
        id,
        { id, fate: "withheld", reason: "no-comment" },
      ]),
    );
    for (const candidate of inputs.candidates) {
      const assembled =
        candidate.assembledKey === null
          ? undefined
          : yield* readOutput(candidate.assembledKey, (value) =>
              readData(AssembledBatch, value),
            );
      if (assembled === undefined || candidate.assembledKey === null) {
        complete = false;
        const title = groups.get(candidate.candidate)?.label;
        gaps.push({
          key: `candidate:${candidate.candidate}:not-assembled`,
          kind: "batch-not-assembled",
          detail:
            title === undefined
              ? "Part of the change wasn't assembled into units, so it isn't in this review."
              : `The changes for "${clipText(title, 200)}" weren't assembled into units, so they aren't in this review.`,
        });
        continue;
      }
      const assembledKey = candidate.assembledKey;
      if (assembled.complete === false) complete = false;
      const disposals = new Map<
        string,
        {
          readonly stored: LinkedReview | undefined;
          readonly key: string | null;
          readonly status: StageRecord["status"];
        }
      >();
      for (const disposal of candidate.disposed)
        disposals.set(disposal.unit, {
          stored:
            disposal.key === null
              ? undefined
              : yield* readOutput(disposal.key, (value) =>
                  readData(LinkedReview, value),
                ),
          key: disposal.key,
          status: disposal.status,
        });
      // Entity IDs: batches and units that own something (the rule for a unit that owns nothing).
      const batchIds = new Map(
        assembled.batches.map((batch) => [
          batch.id,
          entityId(`batch:${batch.id}`),
        ]),
      );
      const unitIds = new Map<string, string>();
      for (const unit of assembled.units)
        if (unit.ownedRanges.length > 0)
          unitIds.set(unit.id, entityId(`unit:${unit.id}`));
        else {
          // The rules' reason is the hunks' qualifications, which the range manifest holds.
          if (rangeManifest === null) {
            const read =
              inputs.sources.manifest === null
                ? undefined
                : yield* Effect.result(
                    readOutput(inputs.sources.manifest, (value) => {
                      const parsed = safeRead(RangeManifest, value);
                      return parsed.success ? parsed.data : undefined;
                    }),
                  );
            rangeManifest = read?._tag === "Success" ? read.success : undefined;
          }
          const why = qualificationWords(
            (rangeManifest?.hunks ?? [])
              .filter((h) => unit.hunkIds.includes(h.hunkId))
              .flatMap((h) => h.qualifications),
          );
          gaps.push({
            key: `unit:${unit.id}:owns-nothing`,
            kind: "unit-owns-nothing",
            detail: `The change in ${unit.path} owns no changed lines under the review rules${why === undefined ? "" : ` (${why})`}, so it isn't a review unit and no review covers it.`,
          });
        }
      const unitEvents = new Map<string, string>();
      const referenceEvents = new Map<string, string>();
      const targets: Record<string, CitationTarget> = {
        ...assembled.citations,
      };
      for (const { stored } of disposals.values())
        Object.assign(targets, stored?.citations ?? {});
      const citationOf = (id: string) => {
        const target = targets[id];
        if (target === undefined) return [];
        let raw: { ref: string; entry?: string };
        if (target.kind === "reference") {
          const known = referenceEvents.get(id);
          raw =
            known === undefined
              ? { ref: `computation:${assembledKey}`, entry: id }
              : { ref: `event:${known}` };
        } else if (target.kind === "unit") {
          const known = unitEvents.get(id);
          if (known === undefined) return [];
          raw = { ref: `event:${known}` };
        } else {
          if (target.ref === null) return [];
          raw = {
            ref: target.ref,
            ...(target.entry === null ? {} : { entry: target.entry }),
          };
        }
        if (target.kind === "proof") citedProofs.add(id);
        const parsed = Citation.safeParse(raw);
        if (parsed.success) return [parsed.data];
        const bare = Citation.safeParse({ ref: raw.ref });
        return bare.success ? [bare.data] : [];
      };
      const citations = (ids: ReadonlyArray<string>, max: number) => {
        const seen = new Set<string>();
        return ids
          .flatMap(citationOf)
          .filter((c) => {
            const key = `${c.ref}#${c.entry ?? ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, max);
      };
      // A reference goes with the batch of its first published unit.
      const referenceHome = new Map<string, string>();
      for (const reference of assembled.references) {
        const first = assembled.units.find(
          (unit) => reference.unitIds.includes(unit.id) && unitIds.has(unit.id),
        );
        if (first !== undefined) referenceHome.set(reference.id, first.batchId);
      }

      for (const batch of assembled.batches) {
        const batchId = batchIds.get(batch.id)!;
        const events: Array<Built> = [];
        const commentFindings = new Map<string, string>();
        events.push(
          event(
            "batch.recorded@1",
            `batch:${batch.id}`,
            actors.assemble,
            { cycleId: ctx.cycleId, batchId },
            {
              title: clipText(batch.title, 512),
              focus: clipText(batch.focus, 2_000),
            },
          ),
        );
        const units = assembled.units.filter(
          (unit) => unit.batchId === batch.id && unitIds.has(unit.id),
        );
        // Units: owned ranges as Records holds them, without Assemble's hunk IDs (H7 review).
        for (const unit of units) {
          const ownedRanges = recordedRanges(unit).map((kept) => kept.parsed);
          const built = event(
            "unit.recorded@2",
            `unit:${unit.id}`,
            actors.assemble,
            {
              cycleId: ctx.cycleId,
              batchId,
              unitIds: [unitIds.get(unit.id)!],
            },
            {
              title: clipText(unit.title, 512),
              ownedRanges: ownedRanges.slice(0, 1_024),
              grouping: {
                gapLines: Math.min(400, unit.grouping.gapLines),
                ...(unit.grouping.adjustment === undefined
                  ? {}
                  : {
                      adjustment: {
                        kind: unit.grouping.adjustment.kind,
                        reason: clipText(
                          unit.grouping.adjustment.reason,
                          1_000,
                        ),
                      },
                    }),
              },
            },
          );
          unitEvents.set(unit.id, built.id);
          events.push(built);
        }
        // Context references (0006's contract as M3 fills it). Those Publish can't record as
        // references are disclosed once per reason for the batch, by their sources' names.
        const unpublished = new Map<UnpublishedReason, Array<string>>();
        for (const reference of assembled.references) {
          if (referenceHome.get(reference.id) !== batch.id) continue;
          const built = referenceEvent(
            reference,
            assembled.units,
            unitIds,
            batchIds,
            ctx,
          );
          if (built === undefined) {
            const reason = unpublishedReason(reference, unitIds) ?? "anchor";
            unpublished.set(reason, [
              ...(unpublished.get(reason) ?? []),
              referenceName(reference, snapshot),
            ]);
            continue;
          }
          const referenced = event(
            "context.referenced@2",
            `reference:${reference.id}`,
            actors.assemble,
            built.attribution,
            built.payload,
            [{ ref: `computation:${assembledKey}`, role: "content" }],
          );
          referenceEvents.set(reference.id, referenced.id);
          events.push(referenced);
          counts.contextReferences += 1;
        }
        for (const [reason, cited] of unpublished)
          gaps.push({
            key: `batch:${batch.id}:references-not-published:${reason}`,
            kind: "reference-not-published",
            detail: clipText(
              unpublishedLine(reason, [...new Set(cited)]),
              2_000,
            ),
          });
        const unassessed = units.filter(
          (unit) => unit.assessment.status !== "assessed",
        );
        if (unassessed.length > 0)
          gaps.push({
            key: `batch:${batch.id}:not-assessed`,
            kind: "not-assessed",
            detail: `${unassessed.length} ${unassessed.length === 1 ? "unit" : "units"} in "${clipText(batch.title, 200)}" ${unassessed.length === 1 ? "has" : "have"} no assessment of complexity or ease of validation.`,
            unitIds: unassessed.map((unit) => unitIds.get(unit.id)!),
          });
        // Assessments.
        for (const unit of units) {
          const a = unit.assessment;
          if (
            a.status !== "assessed" ||
            a.quadrant === null ||
            a.complexity.level === null ||
            a.validation.level === null
          ) {
            continue;
          }
          for (const r of a.validation.requirements)
            for (const proof of r.proof) citedProofs.add(proof);
          const recorded = recordedRanges(unit);
          const pinCurrent = new Map(
            assembled.pins.map((pin) => [pin.source, pin.status === "current"]),
          );
          const anchored = a.validation.requirements
            .slice(0, 8)
            .map((r) => anchorIndices(r.anchors, recorded));
          // 11.17: a checkpoint that reaches no owned line is anchored to its unit as a whole and
          // shows in the briefing only, which the reader is told.
          const whole = a.validation.requirements
            .slice(0, 8)
            .filter((_, i) => anchored[i]!.length === 0);
          if (whole.length > 0)
            gaps.push({
              key: `unit:${unit.id}:checkpoints-unanchored`,
              kind: "checkpoint-unanchored",
              detail: clipText(
                `${whole.length === 1 ? "One checkpoint" : `${whole.length} checkpoints`} of the unit in ${unitPlace(unit)} ${whole.length === 1 ? "doesn't" : "don't"} point to any changed line the unit owns, so ${whole.length === 1 ? "it shows" : "they show"} in the unit's briefing only: ${whole.map((r) => `"${clipText(r.requirement, 120)}"`).join(", ")}.`,
                2_000,
              ),
              unitIds: [unitIds.get(unit.id)!],
            });
          // 11.20: where no test can check a requirement, the agent's reason is said to the reader.
          const untestable = a.validation.requirements.filter(
            (r) => r.untested !== "",
          );
          if (untestable.length > 0)
            gaps.push({
              key: `unit:${unit.id}:checkpoints-untested`,
              kind: "checkpoint-untested",
              detail: clipText(
                `No test can check ${untestable.length === 1 ? "one checkpoint" : `${untestable.length} checkpoints`} of the unit in ${unitPlace(unit)}, as the assessment says: ${untestable.map((r) => `"${clipText(r.requirement, 120)}" (${clipText(r.untested, 200).replace(/\.$/, "")})`).join("; ")}.`,
                2_000,
              ),
              unitIds: [unitIds.get(unit.id)!],
            });
          // 11.18: what moved since the proof was recorded, said plainly for each unit.
          const outOfDate = a.validation.requirements.filter(
            (r) => r.proofState === "out-of-date",
          );
          if (outOfDate.length > 0)
            gaps.push({
              key: `unit:${unit.id}:checkpoints-out-of-date`,
              kind: "checkpoint-out-of-date",
              detail: clipText(
                `${outOfDate.length === 1 ? "One checkpoint" : `${outOfDate.length} checkpoints`} of the unit in ${unitPlace(unit)} ${outOfDate.length === 1 ? "is" : "are"} out of date: ${outOfDate.map((r) => `"${clipText(r.requirement, 120)}" (${r.proofNote.replace(/^Out of date: /, "").replace(/\.$/, "")})`).join("; ")}.`,
                2_000,
              ),
              unitIds: [unitIds.get(unit.id)!],
            });
          // Within the event's caps, the first gap on each axis is kept, so 10.55's count (a gap
          // on ease of validation) never depends on how many complexity gaps came first.
          const firstOf = (axis: string) =>
            a.gaps.findIndex((g) => g.axis === axis);
          const keep = new Set(
            [firstOf("ease-of-validation"), firstOf("complexity")].filter(
              (i) => i >= 0,
            ),
          );
          for (const [i] of a.gaps.entries()) if (keep.size < 6) keep.add(i);
          const keptGaps = a.gaps.filter((_, i) => keep.has(i));
          if (
            keptGaps.length < a.gaps.length ||
            a.complexity.factors.length > 8 ||
            a.validation.requirements.length > 8 ||
            a.validation.requirements.some(
              (r) =>
                new Set(r.anchors.map((x) => x.hunk + x.side + x.startLine))
                  .size > 8 || r.sources.length > 4,
            ) ||
            a.movement.length > 6
          )
            gaps.push({
              key: `unit:${unit.id}:assessment-cut`,
              kind: "assessment-cut",
              detail: `Only part of the assessment of the unit in ${unitPlace(unit)} is shown: it has ${a.gaps.length} gap(s), ${a.complexity.factors.length} complexity factor(s), ${a.validation.requirements.length} validation requirement(s) and ${a.movement.length} signal(s), and the review shows at most 6, 8, 8 and 6.`,
              unitIds: [unitIds.get(unit.id)!],
            });
          events.push(
            event(
              "assessment.recorded@3",
              `unit:${unit.id}:assessment`,
              actors.assemble,
              { cycleId: ctx.cycleId, unitIds: [unitIds.get(unit.id)!] },
              {
                lane: a.lane,
                quadrant: a.quadrant,
                complexity: {
                  level: a.complexity.level,
                  factors: a.complexity.factors.slice(0, 8).map((f) => ({
                    factor: /^[a-z][a-z0-9-]{0,63}$/.test(f.factor)
                      ? f.factor
                      : "unnamed",
                    finding: clipText(f.finding, 300),
                    cites: citations(f.cites, 6),
                  })),
                },
                easeOfValidation: {
                  level: a.validation.level,
                  requirements: a.validation.requirements
                    .slice(0, 8)
                    .map((r) => ({
                      requirement: clipText(r.requirement, 300),
                      // The basis first, so the cut to six never drops the scope item a
                      // checkpoint sits under on the desk (11.23).
                      cites: citations(
                        [...(r.basis === "" ? [] : [r.basis]), ...r.cites],
                        6,
                      ),
                      coverage: r.coverage,
                      proof: r.proof.filter((id) => ULID.test(id)).slice(0, 8),
                      kinds: [...new Set(r.kinds)].slice(0, 6),
                      agree: r.agree,
                      testable: r.untested === "",
                      anchors: anchorIndices(r.anchors, recorded).slice(0, 8),
                      // Past the event's four, sources not current come first, so a
                      // cut never hides the one that makes a checkpoint Out of date.
                      sources: r.sources
                        .filter((id) => /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(id))
                        .sort(
                          (x, y) =>
                            Number(pinCurrent.get(x) === true) -
                            Number(pinCurrent.get(y) === true),
                        )
                        .slice(0, 4),
                    })),
                },
                movement: a.movement
                  .filter((m) =>
                    ["prior-bug", "outage", "blast-radius"].includes(m.signal),
                  )
                  .slice(0, 6)
                  .map((m) => ({
                    signal: m.signal,
                    finding: clipText(m.finding, 300),
                    axis: m.axis,
                    direction: m.direction,
                    cites: citations(m.cites, 6),
                  })),
                ...(a.quadrant === "high-easy" && a.lean !== null
                  ? {
                      lean: {
                        lane: a.lean.lane,
                        reason: clipText(a.lean.reason, 300),
                      },
                    }
                  : {}),
                gaps: keptGaps.map((g) => ({
                  axis: g.axis,
                  kind: GapKind.safeParse(g.kind).success ? g.kind : "unnamed",
                  detail: clipText(g.detail, 300),
                })),
                rationale: clipText(a.rationale, 1_000),
              },
            ),
          );
          counts.assessments += 1;
        }
        // Each obligation's status on every unit whose Guided stop holds it, for the digest (10.87).
        const acrossUnits = new Map<
          string,
          {
            text: string;
            basis: string;
            units: Array<{ unit: string; status: string; required: boolean }>;
          }
        >();
        const unitManifest: Array<unknown> = [];
        const reviewEvents: Array<Built> = [];
        const unitDispositions: Array<Built> = [];
        for (const unit of units) {
          const target = {
            cycleId: ctx.cycleId,
            batchId,
            unitIds: [unitIds.get(unit.id)!],
          };
          const stops: Array<[string, unknown, number]> = [
            [
              "facts",
              unit.content.facts,
              verdictWordsIn(unit.content.facts.text),
            ],
            ...(unit.content.briefed === null
              ? []
              : ([
                  [
                    "briefed",
                    { text: unit.content.briefed },
                    verdictWordsIn(unit.content.briefed),
                  ],
                ] as Array<[string, unknown, number]>)),
            ...(unit.content.explained === null
              ? []
              : ([
                  [
                    "explained",
                    unit.content.explained,
                    verdictWordsIn(
                      [
                        unit.content.explained.before,
                        unit.content.explained.after,
                        ...unit.content.explained.terms.map((t) => t.meaning),
                      ].join("\n"),
                    ),
                  ],
                ] as Array<[string, unknown, number]>)),
          ];
          for (const [stop, value, words] of stops) {
            const key = yield* content(
              {
                assembled: `computation:${assembledKey}`,
                unit: unit.id,
                stop,
              },
              value,
            );
            events.push(
              event(
                "delivery.recorded@1",
                `unit:${unit.id}:${stop}`,
                actors.assemble,
                target,
                { content: stop, verdictWords: Math.min(1_000, words) },
                [{ ref: `computation:${key}`, role: "content" }],
              ),
            );
          }
          counts.deliveries += stops.length;
          const disposal = disposals.get(unit.id);
          const stored = disposal?.stored;
          const review = stored?.review ?? null;
          for (const finding of review?.findings ?? [])
            if (finding.id !== undefined && !findings.has(finding.id))
              findings.set(finding.id, {
                id: finding.id,
                fate: "withheld",
                reason: "no-comment",
              });
          // Link reviews are keyed by their stored finding and citation content.
          const reviewInput =
            disposal?.key == null
              ? `missing:${unit.id}`
              : `computation:${disposal.key}`;
          // The review: recorded once per unit and cycle and never regenerated (4.7, 4.11). When an
          // earlier generation of this request already recorded one, it stands and this one is not
          // appended; a generation reviewing a unit the earlier one left without a review fills it.
          // Only earlier generations' Guided stops count, never one this run minted on an earlier
          // attempt, so a replayed Publish decides as its first attempt did.
          const earlier = earlierStops(unit.id);
          // A recompose, in its scratch store, that recomputed this review with the model appends it
          // as this generation's own record, keyed by its run, beside the earlier one, which stays as
          // it is: what the recompose measures is the review it made. A review it reused, and every
          // run a person requests, keep the rule above.
          const own =
            ctx.recompose !== undefined &&
            disposal?.status === "computed" &&
            earlier.length > 0;
          // The earlier review that stands: the newest one written from the Dispose computation this
          // run reused, so a recompose reusing an older generation's review carries that one; else the
          // newest. A cycle a person requested holds one earlier review at most, so it reads nothing.
          let reviewedEarlier = earlier.at(-1);
          if (!own && earlier.length > 1 && typeof disposal?.key === "string")
            for (const stop of [...earlier].reverse())
              if ((yield* disposeOf(stop.id)) === reviewInput) {
                reviewedEarlier = stop;
                break;
              }
          const keyed = own ? { run: ctx.runId } : false;
          // The earlier review's own events: those of the generation that recorded its Guided stop.
          const generationOf = (key: string) => /#run:([^#]+)$/.exec(key)?.[1];
          const reviewKeys = (prefix: string) =>
            [...held]
              .filter(
                ([key]) =>
                  key.startsWith(`${namespace}${prefix}`) &&
                  generationOf(key) ===
                    (reviewedEarlier === undefined
                      ? undefined
                      : generationOf(reviewedEarlier.key)),
              )
              .map(([key, id]) => ({ key: key.slice(namespace.length), id }));
          const comments: Array<{ id: string; defect: boolean }> = [];
          const mine: Array<Built> = [];
          if (review !== null)
            for (const [index, finding] of review.findings.entries()) {
              const built = event(
                "comment.recorded@2",
                `unit:${unit.id}:comment:${index}`,
                actors.dispose,
                { cycleId: ctx.cycleId, unitIds: [unitIds.get(unit.id)!] },
                {
                  body: clipText(finding.text, 20_000),
                  anchor: {
                    path: finding.anchor.path,
                    side: finding.anchor.side,
                    startLine: finding.anchor.startLine,
                    endLine: Math.max(
                      finding.anchor.startLine,
                      finding.anchor.endLine,
                    ),
                  },
                  finding: {
                    kind: finding.kind,
                    about: finding.about,
                    ...(finding.signal === null
                      ? {}
                      : { signal: finding.signal }),
                    evidence: citations(finding.evidence, 32),
                  },
                },
                undefined,
                keyed,
              );
              // The stored review passed code's anchor checks, or repair dropped what failed them.
              comments.push({
                id: built.id,
                defect:
                  finding.kind === "defect" && finding.evidence.length > 0,
              });
              mine.push(built);
            }
          const group = groups.get(candidate.candidate);
          const guided = guidedContent({
            unit,
            stored,
            basis:
              stored === undefined && group !== undefined
                ? unitGuidedBasis(
                    {
                      obligations: group.obligations,
                      unlinked: changeMap?.unlinked ?? false,
                    },
                    batch,
                    unit,
                  )
                : undefined,
            status: disposal?.status ?? "skipped",
            strongestStratum: inputs.strongestStratum,
            commentIds: comments.map((c) => c.id),
          });
          for (const row of guided.rows) {
            const entry = acrossUnits.get(row.row) ?? {
              text: row.text,
              basis: row.basis,
              units: [],
            };
            entry.units.push({
              unit: unit.id,
              status: row.status,
              required: row.required,
            });
            acrossUnits.set(row.row, entry);
          }
          for (const row of guided.rows)
            for (const id of row.evidence) citationOf(id);
          const guidedKey = yield* content(
            {
              assembled: `computation:${assembledKey}`,
              dispose: reviewInput,
              presentation: sha256Hex(
                canonicalJson({
                  source: stored?.source ?? null,
                  comments: comments.map((comment) => comment.id),
                  stratum: inputs.strongestStratum,
                }),
              ),
              unit: unit.id,
              stop: "guided",
            },
            guided,
          );
          // A Guided stop with no review is pending: a later generation's review supersedes it.
          const guidedBase =
            review === null
              ? `unit:${unit.id}:guided-pending`
              : `unit:${unit.id}:guided`;
          const pending =
            review === null
              ? undefined
              : latestAt(`unit:${unit.id}:guided-pending`);
          const guidedEvent = event(
            "delivery.recorded@1",
            guidedBase,
            actors.dispose,
            target,
            { content: "guided" },
            [{ ref: `computation:${guidedKey}`, role: "content" }],
            own ? keyed : true,
          );
          const guidedFinal =
            !own && pending !== undefined && guidedEvent.causation === undefined
              ? { ...guidedEvent, causation: { supersedes: pending.id } }
              : guidedEvent;
          if (
            !own &&
            reviewedEarlier !== undefined &&
            reviewedEarlier.key !== guidedFinal.idempotencyKey
          ) {
            const standingEvents = [
              ...reviewKeys(`unit:${unit.id}:comment:`),
              ...reviewKeys(`unit:${unit.id}:disposition`),
              {
                key: reviewedEarlier.key.slice(namespace.length),
                id: reviewedEarlier.id,
              },
            ];
            unitManifest.push({
              unit: unit.id,
              unitId: unitIds.get(unit.id),
              dispose: disposal?.key ?? null,
              review: "earlier",
              events: standingEvents,
            });
            continue;
          }
          reviewEvents.push(...mine, guidedFinal);
          for (const [index, finding] of (review?.findings ?? []).entries())
            if (finding.id !== undefined)
              commentFindings.set(
                `unit:${unit.id}:comment:${index}`,
                finding.id,
              );
          counts.comments += mine.length;
          counts.deliveries += 1;
          const unitReviewEvents: Array<Built> = [...mine, guidedFinal];
          if (review === null) {
            unitManifest.push({
              unit: unit.id,
              unitId: unitIds.get(unit.id),
              dispose: disposal?.key ?? null,
              review: "missing",
              events: unitReviewEvents.map((e) => ({ key: e.base, id: e.id })),
            });
            continue;
          }
          for (const [index, gap] of review.gaps.entries())
            gaps.push({
              key: `unit:${unit.id}:review-gap:${index}`,
              kind: "review-gap",
              detail: clipText(`${unitPlace(unit)}: ${gap}`, 2_000),
              unitIds: [unitIds.get(unit.id)!],
            });
          if (stored!.guided.omitted.length > 0)
            gaps.push({
              key: `unit:${unit.id}:rows-omitted`,
              kind: "rows-omitted",
              detail: clipText(
                `${stored!.guided.omitted.length} item(s) to check for ${unitPlace(unit)} weren't judged, because a review judges at most ${MAX_ROWS}: ${stored!.guided.omitted.map((o) => `"${clipText(o.text, 120)}"`).join(", ")}`,
                2_000,
              ),
              unitIds: [unitIds.get(unit.id)!],
            });
          for (const row of guided.rows)
            if ("disagreement" in row && typeof row.disagreement === "string")
              gaps.push({
                key: `unit:${unit.id}:disagreement:${row.row}`,
                kind: "proof-disagreement",
                detail: clipText(
                  `"${clipText(row.text, 200)}" (${unitPlace(unit)}): ${row.disagreement}.`,
                  2_000,
                ),
                unitIds: [unitIds.get(unit.id)!],
              });
          const outcome =
            stored!.withheld === true || review.verdict !== "request-changes"
              ? { disposition: undefined, suggestion: false }
              : applyLane(unit.assessment.lane, review.verdict);
          if (outcome.disposition === "request-changes") {
            const disposition = event(
              "disposition.recorded@2",
              `unit:${unit.id}:disposition`,
              actors.dispose,
              { cycleId: ctx.cycleId, unitIds: [unitIds.get(unit.id)!] },
              {
                verdict: outcome.disposition,
                reviewedHeadOid: ctx.range.headOid,
                note: clipText(review.message, 4_000),
                restsOn: comments
                  .filter((c) => c.defect)
                  .map((c) => c.id)
                  .slice(0, 64),
                proof: [],
              },
              undefined,
              keyed,
            );
            unitDispositions.push(disposition);
            unitReviewEvents.push(disposition);
            counts.dispositions += 1;
          }
          unitManifest.push({
            unit: unit.id,
            unitId: unitIds.get(unit.id),
            dispose: disposal?.key ?? null,
            review: "this",
            events: unitReviewEvents.map((e) => ({ key: e.base, id: e.id })),
          });
        }
        // The batch digest, with each obligation's overall status across its units (10.87), then
        // the comments before the dispositions that rest on them (the append rule checks it).
        const obligations = [...acrossUnits].map(([row, entry]) => {
          const required = entry.units.filter((u) => u.required);
          // In the Guided statuses' own words: met, not met or no evidence, or met on n of m units.
          const met = required.filter((u) => u.status === "met").length;
          const overall = required.some((u) => u.status === "not-met")
            ? "not-met"
            : required.length > 0 && met === required.length
              ? "met"
              : met > 0
                ? `met on ${met} of ${required.length} units`
                : "no-evidence";
          return {
            row,
            text: entry.text,
            basis: entry.basis,
            overall,
            units: entry.units,
          };
        });
        const digestValue = { ...batch.digest, obligations };
        const digestKey = yield* content(
          {
            assembled: `computation:${assembledKey}`,
            batch: batch.id,
            stop: "batch-digest",
            obligations: sha256Hex(canonicalJson(obligations)),
          },
          digestValue,
        );
        events.push(
          event(
            "delivery.recorded@1",
            `batch:${batch.id}:digest`,
            actors.assemble,
            { cycleId: ctx.cycleId, batchId },
            {
              content: "batch-digest",
              verdictWords: Math.min(1_000, batch.digest.verdictWords),
            },
            [{ ref: `computation:${digestKey}`, role: "content" }],
          ),
        );
        events.push(...reviewEvents, ...unitDispositions);
        const appended = yield* appendBatch(
          ctx,
          events.map(strip),
          gaps,
          batch.id,
        );
        if (appended.fellBack) complete = false;
        const stored = new Map(
          events.map((e, index) => [e.base, appended.ids[index] ?? null]),
        );
        const accepted = new Set(
          events
            .filter((_, index) => appended.accepted[index])
            .map((event) => event.base),
        );
        for (const [base, id] of commentFindings) {
          const publicationId = stored.get(base);
          findings.set(
            id,
            publicationId != null && accepted.has(base)
              ? { id, fate: "published", publicationId }
              : {
                  id,
                  fate: "withheld",
                  reason:
                    publicationId == null
                      ? "comment-refused"
                      : "comment-kept-earlier",
                },
          );
        }
        counts.batches += 1;
        counts.units += units.length;
        for (const unit of units) publishedUnits.push(unitIds.get(unit.id)!);
        manifestBatches.push({
          batch: batch.id,
          candidate: candidate.candidate,
          batchId,
          assembled: `computation:${assembledKey}`,
          units: unitManifest.map((entry) => {
            const u = entry as {
              events: ReadonlyArray<{ key: string; id: string }>;
            };
            return {
              ...(entry as object),
              // Only IDs Records holds: a refused event has none.
              events: u.events.map((e) => ({
                key: e.key,
                id: stored.has(e.key) ? stored.get(e.key) : e.id,
              })),
            };
          }),
          events: events.map((e, index): ManifestEvent => ({
            kind: e.kind,
            base: e.base,
            key: e.idempotencyKey.slice(namespace.length),
            id: appended.ids[index] ?? null,
            hash: eventHash(strip(e)),
          })),
        });
      }
      // Under 12.41, untouched units deliberately have no review. They do not affect packet
      // completeness; whether they need dispositions remains an open owner decision.
    }

    // The run's gaps (2.5): one record each, attributed to Publish and to their units.
    let gapSequence = 0;
    const gapEvents = gaps.map((gap) => ({
      id: stableUlid(
        ctx.startedAt,
        CLASS["gap.disclosed@1"]! * 256 + (gapSequence++ % 256),
        `${run}:gap:${gap.key}`,
      ),
      kind: "gap.disclosed@1",
      idempotencyKey: `review:${run}:gap:publish:${gap.key}`,
      actor: actors.publish,
      occurredAt,
      attribution: {
        cycleId: ctx.cycleId,
        range: ctx.range,
        runId: run,
        stage: "publish",
        ...(gap.unitIds === undefined || gap.unitIds.length === 0
          ? {}
          : { unitIds: [...gap.unitIds] }),
      },
      payload: { kind: gap.kind, detail: clipText(gap.detail, 2_000) },
    }));
    yield* appendTelemetry(ctx.log, gapEvents);
    counts.gaps = gaps.length;
    // The receipt lists the run log's gaps; written once per run.
    if (
      !ctx.log
        .read()
        .some((entry) => entry.type === "gap" && entry["agent"] === "publish")
    )
      for (const gap of gaps)
        ctx.log.write({
          type: "gap",
          stage: "publish",
          agent: "publish",
          kind: gap.kind,
          detail: gap.detail,
          ...(gap.cause === undefined ? {} : { cause: gap.cause }),
        });

    // Every proof artefact the packet cites becomes durable: re-reviews reuse it (4.7, 10.68).
    const promotions = yield* Proofs.promoteCited(
      [...citedProofs].filter((id) => ULID.test(id)),
    );

    // One packet of record per cycle: this one supersedes the cycle's newest earlier packet, of
    // this request or another run key (a route, configuration or pipeline change), so readers take
    // units, assessments, references, deliveries and dispositions through one manifest. Older than
    // this packet's own ID, so a replay supersedes what the first attempt did.
    const packetKey = `${namespace}packet:${run}`;
    const packetId =
      held.get(packetKey) ??
      stableUlid(ctx.startedAt, CLASS["packet.published@1"]! * 256, packetKey);
    const superseded = yield* previousPacket(ctx.cycleId, packetId);

    // The manifest, last (PU2): a durable content-addressed blob named by packet.published@1.
    const manifest = {
      version: PUBLISH_VERSION,
      run: {
        runId: run,
        runKey: ctx.runKey,
        cycleId: ctx.cycleId,
        range: ctx.range,
      },
      route: {
        provider: ctx.config.route.provider,
        model: ctx.config.route.model,
        effort: ctx.config.route.effort,
      },
      config: JSON.parse(JSON.stringify(ctx.config)) as unknown,
      complete,
      supersedes: superseded ?? null,
      sources: inputs.sources,
      batches: manifestBatches,
      gaps: gapEvents.map((g) => ({ id: g.id, kind: g.payload.kind })),
      counts,
    };
    const blobs = yield* Blobs.BlobStore;
    const manifestBlob = yield* blobs.put({
      bytes: new TextEncoder().encode(canonicalJson(manifest)),
      mediaType: "application/json",
      retention: "durable",
    });
    const packet = {
      id: packetId,
      kind: "packet.published@1",
      idempotencyKey: `${namespace}packet:${run}`,
      actor: actors.publish,
      occurredAt,
      attribution: { cycleId: ctx.cycleId, range: ctx.range, runId: run },
      payload: { complete, counts },
      refs: [{ ref: `blob:${manifestBlob.blob.hash}`, role: "manifest" }],
      // The latest generation's packet stands; the earlier one stays in the log as history.
      ...(superseded === undefined
        ? {}
        : { causation: { supersedes: superseded } }),
    };
    const [packetStatus] = yield* appendTelemetry(ctx.log, [packet]);

    // Which units already have their needed dispositions (Dispositions.judge, §10.2).
    const closure: Record<string, number> = {};
    for (const unitId of publishedUnits) {
      const judged = yield* Dispositions.judge(unitId);
      const label = judged.closed ? "closed" : `needs ${judged.needs}`;
      closure[label] = (closure[label] ?? 0) + 1;
    }
    const summary: PublishSummary = {
      manifest: manifestBlob.blob.hash,
      packetEventId: packetStatus === "kept-earlier" ? null : packet.id,
      complete,
      counts,
      closure,
      promoted: promotions.filter((p) => p.result === "promoted").length,
      findings: [...findings.values()],
    };
    const { findings: _findings, ...logged } = summary;
    ctx.log.write({
      type: "publish",
      ...logged,
      supersedes: superseded ?? null,
    });
    return summary;
  });

/** The cycle's newest packet older than `before`, the one a packet with that ID supersedes. */
const previousPacket = (cycleId: string, before: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ id: string }>`SELECT e.id FROM events e
      JOIN event_cycles c ON c.event_seq = e.seq AND c.cycle_id = ${cycleId}
      WHERE e.kind = 'packet.published@1' AND e.id < ${before}
      ORDER BY e.id DESC LIMIT 1`;
    return row?.id;
  });

/**
 * One batch's events in one append transaction (PU1). Should Records refuse the batch (an event
 * held with other content, or one it refuses), it is appended event by event instead: an event
 * held with other content keeps the stored one, whose ID the manifest names; a refused event has
 * no ID in the manifest and is disclosed; the packet is marked incomplete (`fellBack`).
 */
const appendBatch = (
  ctx: PublishContext,
  events: ReadonlyArray<Record<string, unknown>>,
  gaps: Array<Gap>,
  batch: string,
) =>
  Effect.gen(function* () {
    const whole = yield* Effect.result(Log.append(events));
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
        ids: whole.success.map((r) => r.id) as ReadonlyArray<string | null>,
        accepted: whole.success.map(() => true),
        fellBack: false,
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
    const accepted: boolean[] = [];
    for (const single of events) {
      const one = yield* Effect.result(Log.append([single]));
      if (one._tag === "Success") {
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
      const what = EVENT_WORDS[String(single["kind"])] ?? "one record";
      gaps.push({
        key: `event:${String(single["idempotencyKey"])}`,
        kind: kept ? "publish-kept-earlier" : "publish-refused",
        detail: kept
          ? `An earlier run's version of ${what} in this batch is shown, because this run wrote it differently.`
          : `${what.charAt(0).toUpperCase()}${what.slice(1)} in this batch couldn't be saved, so it's missing from this review.`,
        cause: clipText(
          `${String(single["kind"])} of batch ${batch} (${String(single["idempotencyKey"])}): ${kept ? `Records holds it with other content as ${reason.existingEventId}, which stands` : `${reason._tag ?? "error"}${reason.message === undefined ? "" : `: ${reason.message}`}`}`,
          2_000,
        ),
      });
    }
    return {
      ids: ids as ReadonlyArray<string | null>,
      accepted,
      fellBack: true,
    };
  });

/** Why Publish can't record a context reference as `context.referenced@2`. */
export type UnpublishedReason =
  "no-unit" | "scope" | "stack" | "revision" | "anchor";

/** The reason `referenceEvent` records no event for a reference, or undefined when it records one. */
export const unpublishedReason = (
  reference: Reference,
  unitIds: ReadonlyMap<string, string>,
): UnpublishedReason | undefined => {
  if (!reference.unitIds.some((id) => unitIds.has(id))) return "no-unit";
  const source = reference.source;
  if (source.origin === "scope") return "scope";
  if (source.origin === "stack") return "stack";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.revision))
    return "revision";
  return reference.anchors[0] === undefined ? "anchor" : undefined;
};

/**
 * What a reader loses for references of one reason: the source beside the code, and with it the
 * note on why it applies and what to check before deciding, which only a recorded reference carries.
 */
const unpublishedLine = (
  reason: UnpublishedReason,
  names: ReadonlyArray<string>,
) => {
  const lost =
    "nor their notes on why they apply and what to check before deciding";
  const list = names.join("; ");
  switch (reason) {
    case "scope":
      return names.length === 1
        ? `A scope source cited as context, ${names[0]}, was read but isn't shown beside the code, nor its note on why it applies and what to check before deciding.`
        : `${names.length} scope sources cited as context were read but aren't shown beside the code, ${lost}: ${list}.`;
    case "stack":
      return `${names.length} part(s) of the libraries this change uses were read as context but aren't shown beside the code yet, ${lost}: ${list}.`;
    case "revision":
      return `${names.length} context source(s) were read at a revision that isn't a commit, so they aren't shown beside the code, ${lost}: ${list}.`;
    case "anchor":
      return `${names.length} context source(s) have no line in this change to attach to, so they aren't shown beside the code, ${lost}: ${list}.`;
    case "no-unit":
      return `${names.length} context source(s) bear only on changes no review unit owns, so they aren't shown, ${lost}: ${list}.`;
  }
};

/** A context reference as `context.referenced@2`, or undefined when no provenance fits (0006). */
export const referenceEvent = (
  reference: Reference,
  units: ReadonlyArray<AssembledUnit>,
  unitIds: ReadonlyMap<string, string>,
  batchIds: ReadonlyMap<string, string>,
  ctx: PublishContext,
) => {
  const ids = reference.unitIds.flatMap((id) =>
    unitIds.has(id) ? [unitIds.get(id)!] : [],
  );
  if (ids.length === 0) return undefined;
  const source = reference.source;
  if (source.origin === "scope") return undefined;
  // A stack source (11.15) is no git object of the repository and nothing committed, so it is not
  // published as a reference; how stack provenance appears in published references is open (SC9).
  if (source.origin === "stack") return undefined;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.revision))
    return undefined;
  const provenance = {
    kind: "git",
    revision: source.revision,
    ...(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.blob)
      ? { blob: source.blob }
      : {}),
    path: source.path,
    startLine: source.startLine,
    endLine: Math.max(source.startLine, source.endLine),
  };
  const anchor = reference.anchors[0];
  if (anchor === undefined) return undefined;
  const batches = new Set(
    units
      .filter((unit) => reference.unitIds.includes(unit.id))
      .map((unit) => unit.batchId),
  );
  const retrieval =
    reference.retrieval.retriever !== null &&
    reference.retrieval.rank !== null &&
    reference.retrieval.rank >= 1
      ? {
          retrieval: {
            retriever: clipText(reference.retrieval.retriever, 128),
            rank: reference.retrieval.rank,
            ...(reference.retrieval.score === null
              ? {}
              : { score: reference.retrieval.score }),
          },
        }
      : {};
  return {
    attribution: {
      cycleId: ctx.cycleId,
      ...(batches.size === 1
        ? { batchId: batchIds.get([...batches][0]!)! }
        : {}),
      unitIds: ids,
    },
    payload: {
      markerKind: reference.markerKind,
      source: {
        kind: source.origin === "same-batch" ? "same-batch" : "git",
        locator: clipText(reference.locator, 4_096),
      },
      summary: clipText(
        `${reference.why} Before you decide: ${reference.beforeYouDecide}`,
        2_000,
      ),
      anchor: {
        path: anchor.path,
        side: anchor.side,
        startLine: anchor.startLine,
        endLine: Math.max(anchor.startLine, anchor.endLine),
      },
      stance: reference.stance,
      origin: reference.origin === "same-batch" ? "same-batch" : "committed",
      ...retrieval,
      provenance,
    },
  };
};

/** Publish's own stage telemetry (10.32): its stage record, as every stage's is recorded. */
export const recordPublishStage = (
  ctx: PublishContext,
  record: StageRecord,
  manifest: string | null,
) =>
  Effect.gen(function* () {
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* appendTelemetry(ctx.log, [
      {
        id: mintUlid(),
        kind: "stage.completed@1",
        idempotencyKey: `review:${ctx.runId}:stage:publish`,
        actor: harnessActor(ctx.runId, "publish"),
        occurredAt,
        attribution: {
          cycleId: ctx.cycleId,
          range: ctx.range,
          runId: ctx.runId,
          stage: "publish",
        },
        ...(manifest === null
          ? {}
          : { refs: [{ ref: `blob:${manifest}`, role: "manifest" }] }),
        payload: stageTelemetry(record, ctx.log.read(), ctx.config),
      },
    ]);
  });

export const publishNote = (summary: PublishSummary) =>
  `packet ${summary.complete ? "complete" : "incomplete"}: ${summary.counts.batches} batch(es), ${summary.counts.units} unit(s), ${summary.counts.contextReferences} reference(s), ${summary.counts.assessments} assessment(s), ${summary.counts.deliveries} delivery stop(s), ${summary.counts.comments} comment(s), ${summary.counts.dispositions} disposition(s), ${summary.counts.gaps} gap(s); ${summary.promoted} proof artefact(s) promoted; closure ${
    Object.entries(summary.closure)
      .map(([label, n]) => `${label} ${n}`)
      .join(", ") || "none"
  }${summary.manifest === null ? "" : `; manifest blob ${summary.manifest.slice(0, 12)}`}`;

/** Helpers the new publisher (`publish-sections.ts`) reuses unchanged. */
export { content as deliveryContent, eventHash, keyedIds };
