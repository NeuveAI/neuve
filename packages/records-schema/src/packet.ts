import { JudgementLineage } from "./judgement-lineage.ts";
import { z } from "zod";
import { Sha256 } from "./computations.ts";
import {
  Axis,
  CheckpointState,
  ImpactEffect,
  Lane,
  MarkerKind,
  OwnedRange,
  Side,
  Stance,
  UndecidedCause,
} from "./events.ts";
import { ProofKind } from "./proofs.ts";

/**
 * The stored content of a published packet (M5 RD1; record 0011): what Assemble stores for each
 * candidate batch, the Guided basis Dispose stores, the delivery content Publish stores as
 * computations, and the manifest `packet.published@1` names. The harness writes these shapes and
 * Records' read model (`PublishedPackets`) reads them, so they are defined here once. Moving them
 * here changed no stored output and no JSON schema an agent sends.
 */

// ---------------------------------------------------------------------------------------------
// The evidence ledger's fields a context reference carries (Investigate's stored ledger)
// ---------------------------------------------------------------------------------------------

/** Where a ledger entry's region came from: the repository, same-batch work, a stack source or a scope section. */
export const LedgerSource = z.discriminatedUnion("origin", [
  z.strictObject({
    origin: z.enum(["repository", "same-batch"]),
    repository: z.string(),
    revision: z.string(),
    rev: z.string(),
    blob: z.string(),
    path: z.string(),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    /** Declared kinds of the path (10.23), never inferred from its name. */
    kind: z.union([z.array(z.string()), z.literal("undeclared")]),
    /** Changed hunks of the range the region overlaps, for same-batch context (4.12). */
    sameBatch: z.array(z.string()),
  }),
  /**
   * A stack source (11.15, SC9): a region of a pinned dependency's published package or upstream
   * tree, read with the stack tools. Its repository fields name the store's tree (`revision` is the
   * tree's commit there, `rev` is `stack`); `stack` holds its provenance and the cited lines kept as
   * an excerpt, so a citation outlives the store losing the entry. Only while the stack tools are on.
   */
  z.strictObject({
    origin: z.literal("stack"),
    repository: z.string(),
    revision: z.string(),
    rev: z.literal("stack"),
    blob: z.string(),
    path: z.string(),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    kind: z.literal("undeclared"),
    sameBatch: z.array(z.string()).max(0),
    stack: z.strictObject({
      ecosystem: z.string(),
      name: z.string(),
      version: z.string(),
      /** The lockfile's hash of the package. */
      integrity: z.string(),
      level: z.enum([
        "package contents",
        "attested upstream",
        "registry-stated upstream",
      ]),
      /** The tree in the stack store. */
      tree: z.string(),
      upstream: z
        .strictObject({
          url: z.string(),
          commit: z.string(),
          directory: z.string().optional(),
        })
        .optional(),
      fetchedAt: z.string(),
      excerpt: z.string(),
      excerptClipped: z.boolean(),
    }),
  }),
  z.strictObject({
    origin: z.literal("scope"),
    sourceId: z.string(),
    sectionId: z.string(),
    sourceKind: z.string(),
    stratum: z.string(),
    fetchedAt: z.string(),
  }),
]);
export type LedgerSource = z.infer<typeof LedgerSource>;

/** How a ledger entry was retrieved, when a retriever found it. */
export const LedgerRetrieval = z.strictObject({
  retriever: z.string().nullable(),
  querySha256: z.string().nullable(),
  rank: z.int().nullable(),
  score: z.number().nullable(),
});
export type LedgerRetrieval = z.infer<typeof LedgerRetrieval>;

// ---------------------------------------------------------------------------------------------
// The units stage and Assemble's stored output
// ---------------------------------------------------------------------------------------------

/** What a local ID resolves to: a computation entry or an event, as `Citation` in Records holds it. */
export const CitationTarget = z.strictObject({
  kind: z.enum([
    "ledger-entry",
    "change-fact",
    "hunk",
    "obligation",
    "scope-section",
    "proof",
    "unit",
    "reference",
  ]),
  /** `computation:<key>` or `event:<ulid>`; null for a unit or reference of this packet. */
  ref: z.string().nullable(),
  entry: z.string().nullable(),
});
export type CitationTarget = z.infer<typeof CitationTarget>;

const UnitChange = z.strictObject({
  kind: z.enum(["merge", "split"]),
  units: z.array(z.string()),
  parts: z.array(z.array(z.string())),
  reason: z.string(),
  /** Whether code applied it; a refused change says why (10.70 records every merge and split). */
  applied: z.boolean(),
  note: z.string(),
});

/** How a candidate batch was confirmed (10.1) and the unit changes asked for (10.70). */
export const UnitsConfirmation = z.strictObject({
  decision: z.enum(["confirm", "re-split"]),
  reason: z.string(),
  source: z.enum(["agent", "code", "fallback"]),
  changes: z.array(UnitChange),
});
export type UnitsConfirmation = z.infer<typeof UnitsConfirmation>;

const OwnedRangeOut = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("lines"),
    hunkId: z.string(),
    path: z.string(),
    side: z.enum(["old", "new"]),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  }),
  z.strictObject({
    kind: z.literal("whole-nontext"),
    hunkId: z.string(),
    path: z.string(),
    side: z.enum(["old", "new"]),
  }),
]);

export const ConfirmedUnit = z.strictObject({
  id: z.string(),
  batchId: z.string(),
  path: z.string(),
  hunkIds: z.array(z.string()),
  changedLines: z.int().min(0),
  /** The default units (at 20 lines, on the candidate batch) its hunks came from. */
  from: z.array(z.string()),
  /** As `unit.recorded@2` carries it (10.70). */
  grouping: z.strictObject({
    gapLines: z.int().min(0),
    adjustment: z
      .strictObject({ kind: z.enum(["merge", "split"]), reason: z.string() })
      .optional(),
  }),
  ownedRanges: z.array(OwnedRangeOut),
  /** Paths on either side, for the proof currency check (11.10). */
  ownedPaths: z.array(z.string()),
});
export type ConfirmedUnit = z.infer<typeof ConfirmedUnit>;

export const ConfirmedBatch = z.strictObject({
  id: z.string(),
  title: z.string(),
  focus: z.string(),
  hunkIds: z.array(z.string()),
  obligationIds: z.array(z.string()),
  /** The re-split's reason for this batch, or null when the candidate stands. */
  reason: z.string().nullable(),
  units: z.array(z.string()),
});
export type ConfirmedBatch = z.infer<typeof ConfirmedBatch>;

/** A context reference: ledger entries projected onto the units owning their anchors (3.5). */
export const AssembledReference = z.strictObject({
  id: z.string(),
  /** The qualified ledger entries (`p1.e3`) it was projected from: one region, one reference. */
  entries: z.array(z.string()),
  unitIds: z.array(z.string()),
  markerKind: MarkerKind,
  origin: z.enum(["committed", "same-batch", "scope"]),
  locator: z.string(),
  source: LedgerSource,
  anchors: z.array(
    z.strictObject({
      hunk: z.string(),
      path: z.string(),
      side: z.enum(["old", "new"]),
      startLine: z.int().min(1),
      endLine: z.int().min(1),
    }),
  ),
  grade: z.enum(["necessary", "useful"]),
  stance: Stance,
  why: z.string(),
  beforeYouDecide: z.string(),
  retrieval: LedgerRetrieval,
  tokens: z.int().min(0),
});
export type AssembledReference = z.infer<typeof AssembledReference>;

/** A proof record of the range as Assemble lists it, with its currency for each unit (11.10). */
export const ProofEntry = z.strictObject({
  id: z.string(),
  kind: ProofKind,
  revision: z.string(),
  recorder: z.string(),
  requirement: z.string(),
  claim: z.string(),
  /** The pager's own description of the record. */
  listing: z.string(),
  /** Unit ID to `current` or a stale reason in a few words. */
  currency: z.record(z.string(), z.string()),
});
export type ProofEntry = z.infer<typeof ProofEntry>;

/** How the batch's 40 turns are shared (10.28): the confirmation, the groups, the digests. */
export const TurnPlan = z.strictObject({
  limit: z.int().min(1),
  confirm: z.int().min(0),
  groups: z.int().min(0),
  groupTurns: z.int().min(1),
  digests: z.int().min(0),
  digestTurns: z.int().min(1),
  /** Set when one turn per group already exceeds what the 40 leave: disclosed. */
  overrun: z.boolean(),
});
export type TurnPlan = z.infer<typeof TurnPlan>;

/**
 * The Explained stop as a unit group's agent writes it and Publish stores it (10.60). The group's
 * submission carries exactly this shape, so its bounds and its description of the cited IDs are the
 * agent's contract too.
 */
export const ExplainedContent = z.strictObject({
  before: z.string().min(1).max(600),
  after: z.string().min(1).max(600),
  terms: z
    .array(
      z.strictObject({
        term: z.string().min(1).max(60),
        meaning: z.string().min(1).max(200),
      }),
    )
    .max(3),
  cites: z
    .array(z.string().min(1).max(160))
    .max(6)
    .describe(
      "IDs from this task: ledger entries (p1.e3), change facts, hunks, obligations, scope sections, proof records.",
    ),
});
export type ExplainedContent = z.infer<typeof ExplainedContent>;

const Coverage = z.enum(["missing", "shallow", "solid"]);

/**
 * An external source a checkpoint rests on, pinned when the batch is created (11.17): a ticket read
 * through an integration, by its ID in the cycle's snapshot (`source`), with the provider's version
 * or update time where it gives one, when it was read and the SHA-256 of what was read. `status` is
 * what this run found when it checked the source against its provider (11.18): `current` when the
 * text is the one pinned (read in this cycle, or read again unchanged), `changed` when the provider
 * now holds other text that this run could not take in, `unchecked` when the provider could not be
 * asked or what was read before is not known. A pin that is not current leaves the checkpoints
 * resting on it Out of date.
 */
export const SourcePin = z.strictObject({
  source: z.string(),
  kind: z.literal("ticket"),
  /** The integration that serves it, as its settings name it, and its identifier there. */
  provider: z.string(),
  item: z.string(),
  title: z.string(),
  version: z.string().nullable(),
  readAt: z.string(),
  sha256: z.string(),
  status: z.enum(["current", "changed", "unchecked"]),
  /** When this run asked the provider again; null when the source was read in this run. */
  checkedAt: z.string().nullable(),
});
export type SourcePin = z.infer<typeof SourcePin>;

/** An owned line range a checkpoint is anchored on (11.17), as the unit's `ownedRanges` hold it. */
export const CheckpointAnchor = z.strictObject({
  hunk: z.string(),
  path: z.string(),
  side: z.enum(["old", "new"]),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});
export type CheckpointAnchor = z.infer<typeof CheckpointAnchor>;

/**
 * A section's own Facts, Briefed and Explained, as its group wrote them, in the unit's own shapes,
 * so a reader can be briefed change by change: an assembled unit's section holds it, and so does a
 * section of a `unit.recorded@3`'s blob.
 */
export const SectionContent = z.strictObject({
  facts: z.strictObject({
    text: z.string(),
    cites: z.array(z.string()),
  }),
  briefed: z.string().nullable(),
  explained: ExplainedContent.nullable(),
});
export type SectionContent = z.infer<typeof SectionContent>;

export const AssembledUnit = z.strictObject({
  ...ConfirmedUnit.shape,
  /**
   * The separate changes of one file this unit holds (10.109): each section's title and the lines
   * it owns, in file order. Absent on units assembled before sections.
   */
  sections: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        ownedRanges: z.array(OwnedRangeOut),
        /** The section's own content (`SectionContent`). Absent on units assembled before it. */
        content: SectionContent.optional(),
      }),
    )
    .optional(),
  title: z.string(),
  group: z.string(),
  references: z.array(z.string()),
  assessment: z.strictObject({
    status: z.enum(["assessed", "not-assessed"]),
    source: z.enum(["agent", "final-generation", "none"]),
    quadrant: z
      .enum(["low-easy", "low-hard", "high-easy", "high-hard"])
      .nullable(),
    lane: z.enum([
      "static-automation",
      "agentic",
      "human-suggested",
      "human-required",
    ]),
    laneNote: z.string(),
    complexity: z.strictObject({
      level: z.enum(["low", "high"]).nullable(),
      factors: z.array(
        z.strictObject({
          factor: z.string(),
          finding: z.string(),
          cites: z.array(z.string()),
          uncited: z.boolean(),
        }),
      ),
    }),
    validation: z.strictObject({
      level: z.enum(["easy", "hard"]).nullable(),
      requirements: z.array(
        z.strictObject({
          requirement: z.string(),
          basis: z.string(),
          cites: z.array(z.string()),
          kinds: z.array(ProofKind),
          proof: z.array(z.string()),
          agree: z.boolean(),
          /** Empty when a test can check it; otherwise the agent's reason no test can (11.20). */
          untested: z.string(),
          coverage: Coverage,
          /** Why the coverage is what it is, in a few words: the kinds current, stale records. */
          coverageNote: z.string(),
          /** Its checkpoint's proof state as code set it at assembly (11.16). */
          proofState: CheckpointState,
          /** What the state rests on, in the reader's plain words. */
          proofNote: z.string(),
          /**
           * The owned line ranges that meet it (11.17), resolved from its citations and its basis;
           * empty when it reaches no owned line, so it is anchored to the unit as a whole.
           */
          anchors: z.array(CheckpointAnchor),
          /** The pinned external sources it rests on, by their ID in the cycle's snapshot. */
          sources: z.array(z.string()),
        }),
      ),
    }),
    movement: z.array(
      z.strictObject({
        signal: z.string(),
        finding: z.string(),
        axis: Axis,
        direction: z.enum(["toward-human", "away-from-human"]),
        cites: z.array(z.string()),
        uncited: z.boolean(),
      }),
    ),
    lean: z
      .strictObject({
        lane: z.enum(["agentic", "human-suggested"]),
        reason: z.string(),
      })
      .nullable(),
    gaps: z.array(
      z.strictObject({ axis: Axis, kind: z.string(), detail: z.string() }),
    ),
    rationale: z.string(),
    /** 10.55's case: evidence of high complexity, a gap on validation, so human-suggested. */
    highComplexityValidationGap: z.boolean(),
  }),
  content: z.strictObject({
    source: z.enum(["agent", "code"]),
    facts: z.strictObject({ text: z.string(), cites: z.array(z.string()) }),
    briefed: z.string().nullable(),
    explained: ExplainedContent.nullable(),
    /** Verdict words flagged in Facts, Briefed and Explained, and lane words in Facts (10.61). */
    verdictWords: z.int().min(0),
    laneWords: z.int().min(0),
  }),
});
export type AssembledUnit = z.infer<typeof AssembledUnit>;

export const AssembledDigest = z.strictObject({
  batchId: z.string(),
  source: z.enum(["agent", "code"]),
  digest: z.string(),
  verification: z.string(),
  uncertainty: z.array(z.string()),
  limitations: z.array(z.string()),
  verdictWords: z.int().min(0),
});
export type AssembledDigest = z.infer<typeof AssembledDigest>;

/** Assemble's stored output for one candidate batch: what Publish publishes and the read model resolves through. */
export const AssembledBatch = z.strictObject({
  candidate: z.string(),
  /** Whether ownership and proof lookup ran completely. Absent on older stored batches. */
  complete: z.boolean().optional(),
  confirmation: UnitsConfirmation,
  batches: z.array(ConfirmedBatch.extend({ digest: AssembledDigest })),
  units: z.array(AssembledUnit),
  references: z.array(AssembledReference),
  proofs: z.array(ProofEntry.omit({ listing: true })),
  /** The external sources the batch's checkpoints rest on, pinned at its creation (11.17). */
  pins: z.array(SourcePin),
  citations: z.record(z.string(), CitationTarget),
  counts: z.strictObject({
    at10: z.int().min(0),
    at20: z.int().min(0),
    at40: z.int().min(0),
    defaultUnits: z.int().min(0),
    units: z.int().min(0),
    merges: z.int().min(0),
    splits: z.int().min(0),
    lanes: z.record(z.string(), z.int().min(0)),
    highComplexityValidationGap: z.int().min(0),
    coverage: z.strictObject({
      missing: z.int().min(0),
      shallow: z.int().min(0),
      solid: z.int().min(0),
    }),
    /** Checkpoints by proof state, and those anchored to their unit as a whole (11.16, 11.17). */
    checkpoints: z.strictObject({
      missing: z.int().min(0),
      outOfDate: z.int().min(0),
      conflicting: z.int().min(0),
      proven: z.int().min(0),
      thin: z.int().min(0),
      wholeUnit: z.int().min(0),
    }),
    notAssessed: z.int().min(0),
    uncited: z.int().min(0),
    verdictWords: z.int().min(0),
    laneWords: z.int().min(0),
  }),
  turns: TurnPlan,
  gaps: z.array(z.string()),
});
export type AssembledBatch = z.infer<typeof AssembledBatch>;

// ---------------------------------------------------------------------------------------------
// Dispose's Guided basis (10.67)
// ---------------------------------------------------------------------------------------------

/** One row of the Guided stop (10.67): an obligation the unit is judged against. */
export const GuidedRow = z.strictObject({
  row: z.string(),
  text: z.string(),
  basis: z.enum(["done-when", "scope", "gathered"]),
  sectionId: z.string().nullable(),
  /** The validation requirements Assemble tied to this obligation, and their applicable kinds. */
  requirements: z.array(
    z.strictObject({
      requirement: z.string(),
      kinds: z.array(z.string()),
      proof: z.array(z.string()),
    }),
  ),
});
export type GuidedRow = z.infer<typeof GuidedRow>;

/** What the Guided stop rests on (10.67): the strongest basis among the unit's obligations. */
export const GuidedBasis = z.strictObject({
  level: z.enum(["done-when", "scope", "gathered", "none"]),
  /** Nothing links the change to a scope (Understand's change map). */
  unlinked: z.boolean(),
  rows: z.array(GuidedRow),
  /** Requirements Assemble stated with no obligation as their basis: implied by the change. */
  implied: z.array(GuidedRow.shape.requirements.element),
  /** Rows past the review's 20-criterion bound, disclosed and not judged (`MAX_ROWS`). */
  omitted: z.array(GuidedRow.pick({ row: true, text: true, basis: true })),
});
export type GuidedBasis = z.infer<typeof GuidedBasis>;

// ---------------------------------------------------------------------------------------------
// Delivery content, as each `delivery.recorded@1` references it (PU3)
// ---------------------------------------------------------------------------------------------
// Read schemas: loose objects whose fields later Publish versions added are optional, so content
// any earlier version stored still decodes, and fields a later version adds pass through.

/** Facts: a cited sentence or two (10.60). */
export const FactsContent = z.looseObject({
  text: z.string(),
  cites: z.array(z.string()).optional(),
});
export type FactsContent = z.infer<typeof FactsContent>;

/** Briefed: one paragraph with phrase links, `[phrase](id)`. */
export const BriefedContent = z.looseObject({ text: z.string() });
export type BriefedContent = z.infer<typeof BriefedContent>;

/** Explained as read back: the stored stop, with no bound applied to what was already stored. */
export const ExplainedStored = z.looseObject({
  before: z.string(),
  after: z.string(),
  terms: z
    .array(z.looseObject({ term: z.string(), meaning: z.string() }))
    .optional(),
  cites: z.array(z.string()).optional(),
});
export type ExplainedStored = z.infer<typeof ExplainedStored>;

const GuidedEvidence = z.array(z.string());

/** One Guided row as Publish stores it: this unit's status for one obligation (10.67, 10.87). */
export const GuidedContentRow = z.looseObject({
  row: z.string(),
  text: z.string(),
  basis: z.string(),
  sectionId: z.string().nullable().optional(),
  scope: z.string().optional(),
  /** False on a static-automation unit for a row it was not closed on (10.87). */
  required: z.boolean().optional(),
  closedOn: z.boolean().optional(),
  status: z.string(),
  does: z.string(),
  evidence: GuidedEvidence,
  /** Assemble rated the row solid and the review disagreed (11.1). */
  disagreement: z.string().optional(),
  requirements: z
    .array(
      z.looseObject({
        requirement: z.string(),
        kinds: z.array(z.string()).optional(),
        proof: z.array(z.string()),
        coverage: z.string(),
        note: z.string().optional(),
      }),
    )
    .optional(),
});
export type GuidedContentRow = z.infer<typeof GuidedContentRow>;

/** The Guided stop: rows, outside items, the agent's lane-blind review and, on human-required work, the suggestion. */
export const GuidedContent = z.looseObject({
  unit: z.string().optional(),
  lane: z.string().optional(),
  basis: z.string().optional(),
  unlinked: z.boolean().optional(),
  stratum: z.string().optional(),
  rows: z.array(GuidedContentRow).optional(),
  outside: z
    .array(
      z.looseObject({
        item: z.string(),
        does: z.string(),
        evidence: GuidedEvidence,
      }),
    )
    .optional(),
  implied: z.array(z.unknown()).optional(),
  omitted: z
    .array(z.looseObject({ row: z.string(), text: z.string() }))
    .optional(),
  review: z
    .looseObject({
      source: z.string(),
      carried: JudgementLineage.optional(),
      verdict: z.string(),
      message: z.string(),
      uncited: z.boolean(),
      withheld: z.boolean().optional(),
      gaps: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  suggestion: z
    .looseObject({
      verdict: z.string(),
      message: z.string(),
      comments: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  proof: z.string().optional(),
  notes: z.array(z.string()).optional(),
});
export type GuidedContent = z.infer<typeof GuidedContent>;

/** The batch digest: Assemble's digest with each obligation's status across the batch's units (10.87). */
export const BatchDigestContent = z.looseObject({
  batchId: z.string().optional(),
  source: z.string().optional(),
  digest: z.string(),
  verification: z.string().optional(),
  uncertainty: z.array(z.string()).optional(),
  limitations: z.array(z.string()).optional(),
  verdictWords: z.number().optional(),
  obligations: z
    .array(
      z.looseObject({
        row: z.string(),
        text: z.string(),
        basis: z.string().optional(),
        overall: z.string(),
        units: z.array(
          z.looseObject({
            unit: z.string(),
            status: z.string(),
            required: z.boolean(),
          }),
        ),
      }),
    )
    .optional(),
});
export type BatchDigestContent = z.infer<typeof BatchDigestContent>;

// ---------------------------------------------------------------------------------------------
// The packet's manifest (8.7, PU2)
// ---------------------------------------------------------------------------------------------

/**
 * An event the manifest names: Publish's base and key, its ID when Records holds it, and, in a
 * batch's own list, its kind and content hash (a unit's review events carry key and ID only).
 */
export const ManifestEvent = z.looseObject({
  kind: z.string().optional(),
  base: z.string().optional(),
  key: z.string().optional(),
  id: z.string().nullable().optional(),
  hash: z.string().optional(),
});
export type ManifestEvent = z.infer<typeof ManifestEvent>;

/** One unit of a manifest batch: its local and Records IDs and its review events, earlier generations' included. */
export const ManifestUnit = z.looseObject({
  unit: z.string(),
  unitId: z.string(),
  dispose: z.string().nullable().optional(),
  review: z.string().optional(),
  events: z.array(ManifestEvent).optional(),
  /** A `unit.recorded@3` unit's file and key, so a later review finds the earlier units of a path. */
  path: z.string().optional(),
  key: z.string().optional(),
});
export type ManifestUnit = z.infer<typeof ManifestUnit>;

export const ManifestBatch = z.looseObject({
  batch: z.string(),
  candidate: z.string().optional(),
  batchId: z.string(),
  /** `computation:<key>` of the assembled batch every reference and citation resolves through. */
  assembled: z.string().optional(),
  units: z.array(ManifestUnit),
  events: z.array(ManifestEvent),
  /** The batch's key in a `packet.published@2` chain: the hash of its sorted file paths. */
  key: z.string().optional(),
  /** The gaps frozen with the batch when it was published, by event ID. */
  gaps: z.array(z.looseObject({ id: z.string(), kind: z.string() })).optional(),
  /** The run and publication that published the batch, in a `packet.published@2` chain. */
  publishedBy: z
    .looseObject({ runId: z.string(), ordinal: z.number() })
    .optional(),
});
export type ManifestBatch = z.infer<typeof ManifestBatch>;

/**
 * The small durable manifest `packet.published@1` names (8.7). A read schema: earlier Publish
 * versions' manifests decode, and the run's configuration stays as stored.
 */
export const PacketManifest = z.looseObject({
  version: z.number().optional(),
  run: z
    .looseObject({
      runId: z.string(),
      runKey: z.string().optional(),
      cycleId: z.string().optional(),
    })
    .optional(),
  route: z.unknown().optional(),
  config: z.unknown().optional(),
  complete: z.boolean().optional(),
  supersedes: z.string().nullable().optional(),
  sources: z.unknown().optional(),
  batches: z.array(ManifestBatch),
  gaps: z.array(z.looseObject({ id: z.string(), kind: z.string() })).optional(),
  counts: z.unknown().optional(),
  /**
   * Its place in a `packet.published@2` chain: the run key of the review, its ordinal, and the
   * packet it follows (`null` for the first).
   */
  sequence: z
    .looseObject({
      runKey: z.string(),
      ordinal: z.number(),
      base: z.string().nullable(),
    })
    .optional(),
  /** Earlier units no unit of this review holds a section of, by Records ID. */
  unmatched: z.array(z.string()).optional(),
});
export type PacketManifest = z.infer<typeof PacketManifest>;

/**
 * The parts of an assembled batch the read model resolves local IDs through (M5 §2.1): its
 * citation index, its references whole and its units' owned ranges. A read schema over
 * `AssembledBatch`, loose so an assembled batch an earlier Assemble version stored still resolves.
 */
export const AssembledIndex = z.looseObject({
  citations: z.record(
    z.string(),
    z.looseObject({
      kind: z.string(),
      ref: z.string().nullable(),
      entry: z.string().nullable(),
    }),
  ),
  references: z.array(
    z.looseObject({
      id: z.string(),
      entries: z.array(z.string()),
      unitIds: z.array(z.string()),
      locator: z.string(),
      grade: z.string(),
      why: z.string(),
      beforeYouDecide: z.string(),
      anchors: z.array(
        z.looseObject({
          hunk: z.string(),
          path: z.string(),
          side: z.string(),
          startLine: z.number(),
          endLine: z.number(),
        }),
      ),
    }),
  ),
  /** The pins of the batch's external sources (11.17); absent before checkpoints were anchored. */
  pins: z
    .array(
      z.looseObject({
        source: z.string(),
        provider: z.string(),
        item: z.string(),
        title: z.string(),
        version: z.string().nullable().optional(),
        readAt: z.string(),
        sha256: z.string(),
        status: z.string(),
        checkedAt: z.string().nullable().optional(),
      }),
    )
    .optional(),
  units: z.array(
    z.looseObject({
      id: z.string(),
      /** Each requirement's reason no test can check it (11.20); absent before it was asked. */
      assessment: z
        .looseObject({
          validation: z.looseObject({
            requirements: z.array(
              z.looseObject({ untested: z.string().optional() }),
            ),
          }),
        })
        .optional(),
      ownedRanges: z.array(
        z.looseObject({
          hunkId: z.string(),
          path: z.string(),
          side: z.string(),
          startLine: z.number().optional(),
          endLine: z.number().optional(),
        }),
      ),
    }),
  ),
});
export type AssembledIndex = z.infer<typeof AssembledIndex>;

/** A phrase link in Briefed, Explained and digest text, `[phrase](id)`: the phrase and the local ID it cites. */
export const PHRASE_LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,160})\)/g;

/** The phrase links of a text, in order. */
export const phraseLinks = (text: string) =>
  [...text.matchAll(PHRASE_LINK)].map((match) => ({
    phrase: match[1]!,
    id: match[2]!,
  }));

/**
 * A line cite inside a hunk, a phrase link's ID of the form `h<15 hex>@<start>-<end>`, or
 * `h<15 hex>@<line>` for one line: the hunk ID as a bare hunk cite has it, then what follows `@`.
 * The lines are on the hunk's new side, or its old side when it has no new-side lines.
 */
export const LINE_CITE = /^(h[0-9a-f]{15})@(.*)$/s;

/** The lines of a line cite: positive whole numbers without leading zeros, `start <= end`. */
const CITED_LINES = /^([1-9][0-9]{0,8})(?:-([1-9][0-9]{0,8}))?$/;

/**
 * A line cite's hunk and lines, or why its lines are malformed; undefined for an ID that is not a
 * line cite (a bare hunk ID among them).
 */
export const lineCiteOf = (
  id: string,
):
  | {
      readonly hunk: string;
      readonly lines:
        | { readonly startLine: number; readonly endLine: number }
        | { readonly malformed: string };
    }
  | undefined => {
  const cite = LINE_CITE.exec(id);
  if (cite === null) return undefined;
  const hunk = cite[1]!;
  const after = cite[2]!;
  const lines = CITED_LINES.exec(after);
  if (lines === null)
    return {
      hunk,
      lines: {
        malformed: `"${after}" after the hunk ID is not a line or a line range of positive whole numbers without leading zeros`,
      },
    };
  const startLine = Number(lines[1]);
  const endLine = lines[2] === undefined ? startLine : Number(lines[2]);
  if (startLine > endLine)
    return {
      hunk,
      lines: {
        malformed: `it starts at line ${startLine}, after its end at line ${endLine}`,
      },
    };
  return { hunk, lines: { startLine, endLine } };
};

/**
 * What a unit's stored Dispose output adds to the batch's citation index: the IDs its reviewer could
 * cite beyond Assemble's (scope sections among them), as Publish merges them. A read schema over
 * the harness's Dispose output.
 */
export const DisposeCitations = z.looseObject({
  citations: AssembledIndex.shape.citations,
});
export type DisposeCitations = z.infer<typeof DisposeCitations>;

// ---------------------------------------------------------------------------------------------
// What a `unit.recorded@3` holds, and what an `assessment.recorded@4` judged
// ---------------------------------------------------------------------------------------------

/**
 * The lines a section's enclosing span covers in its file, on the side its identity parts name
 * (`parts.side`): `new`, the head blob's lines; `old`, the base blob's, for a section only the base
 * has; `none`, no span, so `where` is null.
 */
const SectionWhere = z
  .strictObject({ startLine: z.int().min(1), endLine: z.int().min(1) })
  .refine(
    (where) => where.endLine >= where.startLine,
    "endLine precedes startLine",
  );

/**
 * Which file a section's span is in: `new`, the head blob; `old`, the base blob, for a section only
 * the base has; `none`, no span. Optional in a section's parts, so a blob written before it reads.
 */
export const SectionSide = z.enum(["new", "old", "none"]);
export type SectionSide = z.infer<typeof SectionSide>;

/**
 * One section of a unit as Publish stores it: its key (the hash of its path, span text and changed
 * rows, so the same key means the same change), the harness's identity parts it was keyed from
 * (unknown parts kept), its span's lines, the path it was renamed from, its title, the owned
 * ranges it holds (with each one's hunk ID, when given) and, when its group wrote them, its own
 * Facts, Briefed and Explained.
 */
export const UnitSection = z
  .strictObject({
    key: Sha256,
    parts: z.looseObject({
      path: z.string(),
      side: SectionSide.optional(),
      kind: z.string(),
      name: z.string().nullable(),
    }),
    /**
     * The span's lines, on the side `parts.side` names: the head blob's for `new`, the base blob's
     * for `old`; null for `none`, which has no span.
     */
    where: SectionWhere.nullable(),
    renamedFrom: z.string().nullable(),
    title: z.string().min(1),
    ownedRanges: z.array(OwnedRange).min(1),
    /**
     * The hunk ID of each owned range, in `ownedRanges`' order and one per range, so a hunk resolves
     * to its own lines. A parallel list, since the events' `OwnedRange` is strict. Absent in a blob
     * written before it, or when the caller gave none.
     */
    rangeHunks: z.array(z.string().min(1)).optional(),
    /** The section's own content, as an assembled unit's section holds it; absent when none. */
    content: SectionContent.optional(),
  })
  .refine(
    (section) => section.parts.side !== "none" || section.where === null,
    "a section with no span (side none) has no lines",
  )
  .refine(
    (section) =>
      section.rangeHunks === undefined ||
      section.rangeHunks.length === section.ownedRanges.length,
    "a section's range hunks name one hunk per owned range",
  );
export type UnitSection = z.infer<typeof UnitSection>;

/**
 * The `sections` blob a `unit.recorded@3` names: every section the unit holds, in key order. The
 * write schema; Records reads it with `UnitSectionsRead`.
 */
export const UnitSections = z.strictObject({
  sections: z
    .array(UnitSection)
    .min(1)
    .refine(
      (sections) =>
        new Set(sections.map((section) => section.key)).size ===
        sections.length,
      "section keys must not repeat",
    ),
});
export type UnitSections = z.infer<typeof UnitSections>;

const OwnedRangeRead = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("lines"),
    path: z.string(),
    side: Side,
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  }),
  z.looseObject({
    kind: z.literal("whole-nontext"),
    path: z.string(),
    side: Side,
  }),
]);

/**
 * `UnitSections` as Records reads it: loose at every level, so the keys a later harness adds still
 * read. A blob that does not decode leaves the unit with no lines, which the read model discloses.
 */
export const UnitSectionsRead = z.looseObject({
  sections: z
    .array(
      z.looseObject({
        key: z.string(),
        parts: z.looseObject({
          path: z.string(),
          /**
           * Any value: the read model checks it against `SectionSide` on its own, so a side it does
           * not know reads as absent and is disclosed, never costing the unit its lines. Absent in
           * a blob written before it.
           */
          side: z.unknown().optional(),
          kind: z.string(),
          name: z.string().nullable(),
        }),
        /** The span's lines, on the side `parts.side` names; null when it has no span. */
        where: z
          .looseObject({ startLine: z.number(), endLine: z.number() })
          .nullable(),
        renamedFrom: z.string().nullable(),
        title: z.string(),
        ownedRanges: z.array(OwnedRangeRead).min(1),
        /**
         * Any value: the read model takes it only as one string per owned range, so one that does
         * not read costs only how that section's hunks resolve, never the unit's lines. Absent in a
         * blob written before it.
         */
        rangeHunks: z.unknown().optional(),
        /**
         * Any value: the read model decodes each section's content on its own against
         * `SectionContent`, so one that does not decode costs only that section's content, never
         * the unit's lines or its other sections.
         */
        content: z.unknown().optional(),
      }),
    )
    .min(1),
});
export type UnitSectionsRead = z.infer<typeof UnitSectionsRead>;

const LocalIds = z.array(z.string());

/** A cited finding behind a section's complexity. `uncited` when code found no citation to hold. */
const JudgedFactor = z.looseObject({
  factor: z.string(),
  finding: z.string(),
  cites: LocalIds,
  uncited: z.boolean().optional(),
});

/**
 * A validation requirement of a section as the lane rule saw it: its coverage as code set it when
 * the rule ran, anchored by path, side and lines (never an index into the unit's ranges), the
 * applicable kinds, agreement and testability its proof state is set from, the proof records and
 * pinned sources it rests on, and, when no test can check it, why (`untested`). `proofState` and
 * the notes are what the rule saw; a reader's state is set again at each read.
 */
const JudgedRequirement = z.looseObject({
  requirement: z.string(),
  cites: LocalIds,
  coverage: z.enum(["missing", "shallow", "solid"]),
  proof: z.array(z.string()),
  kinds: z.array(ProofKind),
  agree: z.boolean(),
  testable: z.boolean(),
  anchors: z.array(
    z.looseObject({
      path: z.string(),
      side: Side,
      startLine: z.int().min(1),
      endLine: z.int().min(1),
    }),
  ),
  sources: z.array(z.string()),
  untested: z.string().optional(),
  proofState: CheckpointState.optional(),
  coverageNote: z.string().optional(),
  proofNote: z.string().optional(),
});

/**
 * An open lower-case name, as an undecided cause is (`UndecidedCause`): a rule's name or a word of
 * an entry's origin. At most 32 characters, so the counts keyed by it and the text naming it stay
 * small whatever a writer stores.
 */
const OpenName = UndecidedCause;

/** The most rules one judgement entry names. */
export const MAX_ENTRY_RULES = 16;

/**
 * A code rule's judgement a section's entry rests on, exactly as the sections lane returns it:
 * the rule's name and its own version, what it read (`inputs`, any JSON, so it can be run again)
 * and what it gave (`result`, any JSON: `holds`, `not-held` or `not-evaluated` today), and its
 * code-written `reason` and `statement`, printed only through a cleaner. Unknown keys are kept.
 */
const EntryRule = z.looseObject({
  rule: OpenName,
  version: z.int().min(1),
  inputs: z.unknown().optional(),
  result: z.unknown().optional(),
  reason: z.string().optional(),
  statement: z.string().optional(),
});

/** One section's entry in an `assessment.recorded@4`'s `judgements`, joined to the unit's section by `key`. */
export const AssessedSection = z.looseObject({
  key: z.string(),
  /** The change facts the lane rule's floors read. */
  facts: z.unknown().optional(),
  /** The section's axes as an agent judged them; null when no agent did. */
  assess: z
    .looseObject({
      complexity: z.looseObject({
        level: z.enum(["low", "high"]),
        factors: z.array(JudgedFactor),
      }),
      easeOfValidation: z.looseObject({
        level: z.enum(["easy", "hard"]),
        requirements: z.array(JudgedRequirement),
      }),
      movement: z.array(z.unknown()),
      lean: z
        .looseObject({ lane: Lane, reason: z.string() })
        .nullable()
        .optional(),
      gaps: z.array(
        z.looseObject({ axis: Axis, kind: z.string(), detail: z.string() }),
      ),
    })
    .nullable(),
  /** The agent's lane-blind review of the section; null when none was given. */
  review: z
    .looseObject({ verdict: z.enum(["approve", "request-changes", "unsure"]) })
    .nullable(),
  /**
   * The trail from the lane the model's axes give (`judged`), through the public-surface raise
   * (`surfaced`) and every floor that raised it, to the lane code applied.
   */
  lane: z.looseObject({
    judged: Lane.nullable(),
    surfaced: Lane.nullable(),
    floors: z.array(z.looseObject({ rule: z.string(), to: Lane })),
    applied: Lane,
  }),
  /**
   * Why no agent decided the section, and which reading was left undecided (`assess`,
   * `lane-review` or `verify` today). Both are open sets.
   */
  undecided: z
    .looseObject({ cause: UndecidedCause, reading: z.string() })
    .optional(),
  /**
   * Why no reading was made of the section: the map excluded its file. `reason` is an open name,
   * so a build reads an entry a later build wrote; today's are `lockfile`, `declared-generated`
   * (the repository declares it generated), `linguist-generated` and `linguist-vendored`
   * (GitHub Linguist's generated or vendored list marks it, decision 14.18). `by` names the
   * declaration or the rule that fired, as plain text printed only through a cleaner; entries
   * stored before it have none. Such an entry has `assess: null`, `review: null` and no
   * `undecided`. An entry holding both `excluded` and `undecided` is a writer's error for the
   * publisher to refuse; it is not refused here, since this schema also reads what is stored.
   */
  excluded: z
    .looseObject({ reason: OpenName, by: z.string().optional() })
    .optional(),
  /** Whether the judgement was made in this review or carried from an earlier one (`from`). */
  lineage: z.enum(["fresh", "carried"]),
  from: z.looseObject(JudgementLineage.shape).optional(),
  /** The impact findings the section's review raised, with the effect each names. */
  impact: z
    .array(
      z.looseObject({
        effect: ImpactEffect,
        text: z.string(),
        cites: LocalIds,
      }),
    )
    .optional(),
  /** The section's verdict where its review gave one, and the findings a request rests on. */
  verdict: z.enum(["approve", "request-changes"]).nullable().optional(),
  restsOn: LocalIds.optional(),
  /**
   * What the lane rule's floors read for the section (`{ facts, options }` as the readers lane
   * stores it), so the lanes eval can run the floors again. Any JSON value, kept as stored.
   */
  floorInputs: z.unknown().optional(),
  /**
   * What produced the judgement: `assess` names what set the axes (`model` or `rule` today),
   * `review` what gave the review (`model`, `family` or `none` today). Both open names. Absent on
   * an entry written before it, whose judgement a model made.
   */
  origin: z.looseObject({ assess: OpenName, review: OpenName }).optional(),
  /**
   * The code rules the judgement rests on, each as the sections lane returns it. At most
   * `MAX_ENTRY_RULES`, since each one is printed and counted wherever the entry is read.
   */
  rules: z.array(EntryRule).max(MAX_ENTRY_RULES).optional(),
  /**
   * The section's judgement is its pattern's: `key` is the sections lane's hash of the pattern,
   * `representative` the section whose judgement this is (itself on the representative), `reading`
   * the computation that judged the representative, and `members`, on the representative, how many
   * sections share it, itself included. A member's entry holds the copied judgement whole, so it
   * reads without its representative, which Records never follows.
   */
  family: z
    .looseObject({
      key: z.string(),
      representative: z.string(),
      reading: z.string().optional(),
      members: z.int().min(1).optional(),
    })
    .optional(),
  /**
   * An import-only change kept with its file's unit: its own lane, which may be lower than the
   * unit's, takes no part in the unit's lane.
   */
  context: z.literal(true).optional(),
});
export type AssessedSection = z.infer<typeof AssessedSection>;

/**
 * The `judgements` computation an `assessment.recorded@4` names: the lane rule's version and one
 * entry per section. A read schema, loose at every level; Records decodes each entry on its own, so
 * one entry it cannot read leaves the others readable.
 */
export const AssessedSections = z.looseObject({
  rule: z.number(),
  sections: z.array(AssessedSection),
});
export type AssessedSections = z.infer<typeof AssessedSections>;
