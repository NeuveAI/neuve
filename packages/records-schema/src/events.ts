import { JudgementLineage } from "./judgement-lineage.ts";
import { z } from "zod";
import {
  ExternalReviewPinSchema,
  ReviewOriginSchema,
} from "./review-origin.ts";
import { Sha256, TranscriptSummary } from "./computations.ts";
import { ProofKind, ProofPayload } from "./proofs.ts";
import { ModelCallAttempts, RunReceipt, StageTelemetry } from "./telemetry.ts";
import {
  ActorId,
  Attribution,
  Causation,
  GitOid,
  Instant,
  Range,
  Ulid,
  UnitIds,
  envelopeFields,
} from "./envelope.ts";

const title = z.string().min(1).max(512);
const LineRange = z
  .strictObject({
    path: z.string().min(1).max(4_096),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  })
  .refine(
    (range) => range.endLine >= range.startLine,
    "endLine precedes startLine",
  );

/** Review lanes from the complexity × ease-of-validation matrix (vocabulary: Review lane). */
export const Lane = z.enum([
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
]);

/** Contextual marker kinds as the reader sees them (vocabulary: Marker kind). */
export const MarkerKind = z.enum([
  "conflict",
  "decision-signal",
  "failed-check",
  "assessment-gap",
  "unavailable-evidence",
  "same-batch",
  "contextual-signal",
  "test",
  "captured-source",
  "graph",
  "history",
  "doc",
]);

export const Verdict = z.enum(["approve", "request-changes"]);

const event = <
  const Kind extends string,
  P extends z.ZodType,
  A extends z.ZodType,
>(
  kind: Kind,
  payload: P,
  attribution: A,
) =>
  z.strictObject({
    ...envelopeFields,
    kind: z.literal(kind),
    attribution,
    payload,
  });

const singleUnit = z.tuple([Ulid]);

/** The external harness an actor runs in, such as `claude-code` or `codex`, or `git` for humans. */
const Harness = z.string().min(1).max(64);
const SessionId = z.string().min(1).max(256);
const TurnKey = z.string().min(1).max(512);

/**
 * An actor: an agent session, one of its subagents, or a human (D21). The fingerprint is the event's
 * `actor`; the alias is projected from it, never copied. The model is not part of identity and is
 * recorded per turn. A registration may repeat; its fields other than `displayName` never change.
 */
export const ActorRegistered = event(
  "actor.registered@1",
  z.strictObject({
    actorKind: z.enum(["agent", "human"]),
    harness: Harness,
    sessionId: SessionId.optional(),
    subagentId: SessionId.optional(),
    parentActor: ActorId.optional(),
    agentType: z.string().min(1).max(128).optional(),
    displayName: z.string().min(1).max(256).optional(),
    email: z.email().optional(),
  }),
  Attribution.optional(),
);

/** Where an agent session's transcript lives. A local reference only; the content is session data (D25). */
const TranscriptPath = z.string().min(1).max(4_096);
/**
 * The transcript's size in bytes when the hook ran. Segments between consecutive offsets are what
 * `transcript.capture` copies, so the bytes, not the hook's clock, decide what a turn covers.
 */
const TranscriptOffset = z.int().min(0);
const Model = z.string().min(1).max(128);

/** An agent session started or resumed in an external harness. Prompts are never recorded (D25). */
export const SessionStarted = event(
  "session.started@1",
  z.strictObject({
    harness: Harness,
    source: z.string().min(1).max(64).optional(),
    model: Model.optional(),
    transcriptPath: TranscriptPath.optional(),
  }),
  Attribution.extend({ sessionId: SessionId }),
);

/** An agent session ended. */
export const SessionEnded = event(
  "session.ended@1",
  z.strictObject({
    harness: Harness,
    reason: z.string().min(1).max(64).optional(),
    transcriptPath: TranscriptPath.optional(),
    transcriptOffset: TranscriptOffset.optional(),
  }),
  Attribution.extend({ sessionId: SessionId }),
);

/**
 * A turn began: a prompt submitted to a session, or a subagent run started. The event's actor is the
 * session or the subagent; `turnKey` pairs it with its end. The prompt itself is never recorded (D25).
 */
export const TurnStarted = event(
  "turn.started@1",
  z.strictObject({
    harness: Harness,
    model: Model.optional(),
    transcriptPath: TranscriptPath.optional(),
    transcriptOffset: TranscriptOffset.optional(),
  }),
  Attribution.extend({ sessionId: SessionId, turnKey: TurnKey }),
);

/**
 * A turn ended, with the model that answered it when the harness reports one. With a transcript path
 * and offset it enqueues `transcript.capture` in its append transaction.
 */
export const TurnEnded = event(
  "turn.ended@1",
  z.strictObject({
    harness: Harness,
    model: Model.optional(),
    transcriptPath: TranscriptPath.optional(),
    transcriptOffset: TranscriptOffset.optional(),
  }),
  Attribution.extend({ sessionId: SessionId, turnKey: TurnKey }),
);

/**
 * What one transcript segment held, recorded by `transcript.capture` so token and cost figures outlive
 * the transcript (D25, 8.10). A `turn` segment runs from the previous turn or session end of the same
 * transcript to this turn's end; a `session-tail` segment holds what the transcript gained after the
 * last turn ended, attributed to that turn. Refs name the segment's raw-capture blob (role
 * `transcript`) and the summary computation (role `summary`); the payload never holds transcript text.
 */
export const TurnSummarized = event(
  "turn.summarized@1",
  TranscriptSummary.extend({
    harness: Harness,
    segment: z.enum(["turn", "session-tail"]),
    fromOffset: TranscriptOffset,
    toOffset: TranscriptOffset,
    /**
     * The segment's last bytes (at most 256) and their hash. The next capture of the same transcript
     * checks them before reading on from `toOffset`, so a transcript replaced or truncated and grown
     * again is refused instead of read at a stale offset.
     */
    tail: z.strictObject({ bytes: z.int().min(0).max(256), sha256: Sha256 }),
  }),
  Attribution.extend({ sessionId: SessionId }),
);

/** Longest vent, in characters (proposal §8, D27). */
export const VENT_TEXT_MAX = 2_000;

/**
 * A vent's text: the agent's own words, at least one non-blank character and at most
 * `VENT_TEXT_MAX` characters. Characters are counted as JSON Schema's `maxLength` counts them (code
 * points), so the schema the `vent` tool advertises accepts exactly what this accepts.
 */
export const VentText = z
  .string()
  .min(1)
  .refine(
    (text) => [...text].length <= VENT_TEXT_MAX,
    `A vent has at most ${VENT_TEXT_MAX} characters`,
  )
  .regex(/\S/, "A vent needs some text")
  .meta({ maxLength: VENT_TEXT_MAX });

/**
 * A vent from before 8.17, with its text inline in the event. Kept so stored events still decode;
 * producers can no longer append it (see `Log.append`), because its text could never expire.
 */
export const VentRecordedInline = event(
  "vent.recorded@1",
  z.strictObject({ text: VentText }),
  Attribution.extend({ sessionId: SessionId }),
).extend({ causation: z.never().optional() });

/** The harness's per-review-cycle session ID that ties a vent to the right agent session (8.16). */
export const ReconciliationId = z.string().min(1).max(256);

/** Media type of raw text captures, including vents and query questions. */
export const TEXT_CAPTURE_MEDIA_TYPE = "text/plain; charset=utf-8";
export const VENT_MEDIA_TYPE = TEXT_CAPTURE_MEDIA_TYPE;

/**
 * What an agent found difficult in its session, in its own words (2.15, 8.8). Optional and at most
 * one per actor and reconciliation ID, or per actor and session when the vent carries none (8.16): a
 * unique index on the log holds that under races. The actor is the agent session (or subagent) that
 * vented; the turn, run and stage are recorded when known. The text is a raw-capture blob, the only
 * ref, which the pruner removes after 30 days (8.17); the event keeps the attribution. A vent never
 * changes the task or the review, and never enters review context, so it carries no causation: it
 * cannot supersede or be caused by another record.
 */
export const VentRecorded = event(
  "vent.recorded@2",
  z.strictObject({ reconciliationId: ReconciliationId.optional() }),
  Attribution.extend({ sessionId: SessionId }),
).extend({
  causation: z.never().optional(),
  refs: z.tuple([
    z.strictObject({
      ref: z.string().regex(/^blob:[0-9a-f]{64}$/, "Expected blob:<sha256>"),
      role: z.literal("vent"),
    }),
  ]),
});

/** A finished query run. Its question is a raw capture and expires with the other captures. */
export const QueryRecorded = event(
  "query.recorded@1",
  z
    .strictObject({
      revision: GitOid.nullable(),
      maxResults: z.int().positive(),
      maxContextBytes: z.int().positive(),
      cache: z.enum(["reuse", "refresh", "prepared"]),
      profile: z.enum(["full", "syntax-only"]),
      relationshipPlanSize: z.int().nonnegative(),
      outcome: z.enum(["completed", "failed", "interrupted"]),
      candidatesReturned: z.int().nonnegative(),
      relationships: z.int().nonnegative(),
      resultBytes: z.int().nonnegative(),
      resultsDroppedByBudget: z.int().nonnegative(),
      snippetsTruncatedByBudget: z.int().nonnegative(),
      startedAt: Instant,
      elapsedMs: z.int().nonnegative(),
    })
    .refine(
      (run) => run.outcome !== "completed" || run.revision !== null,
      "A completed query needs a resolved revision",
    ),
  Attribution.optional(),
).extend({
  refs: z.tuple([
    z.strictObject({
      ref: z.string().regex(/^blob:[0-9a-f]{64}$/, "Expected blob:<sha256>"),
      role: z.literal("question"),
    }),
  ]),
});
export type QueryRecorded = z.infer<typeof QueryRecorded>;

/**
 * The `vent` tool's and command's input. The text is checked as given and trimmed afterwards, so
 * what the tool advertises is exactly what it accepts.
 */
export const VentInput = z.strictObject({
  text: VentText.describe(
    "What made this session difficult, in your own words.",
  ),
  reconciliationId: ReconciliationId.optional().describe(
    "The session ID your harness gave this review cycle, when it gave one. Leave it out otherwise.",
  ),
});

export const CycleScopeSource = z.strictObject({
  server: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  item: z.string().min(1).max(256),
  workspace: z.string().min(1).max(256).nullable(),
});
export type CycleScopeSource = z.infer<typeof CycleScopeSource>;

/** The explicit planning selection, admitted before the cycle opens in the same transaction. */
export const CycleScopeSelected = event(
  "cycle.scope-selected@1",
  CycleScopeSource,
  Attribution.extend({ cycleId: Ulid, range: Range }),
);

/** One review cycle over a commit range (4.11). */
export const CycleOpened = event(
  "cycle.opened@1",
  z.strictObject({}),
  Attribution.extend({ cycleId: Ulid, range: Range }),
);

/** A review cycle opened by a read, before a review gives it a head. */
export const CycleOpenedV2 = event(
  "cycle.opened@2",
  z.strictObject({
    baseRef: Range.shape.baseRef,
    baseOid: GitOid,
    branch: z.string().min(1).max(4_096),
    branchTipOid: GitOid,
  }),
  Attribution.omit({ range: true }).extend({ cycleId: Ulid }),
);

export const CycleExternalContextSelected = event(
  "cycle.external-context-selected@1",
  z.strictObject({
    identity: Sha256,
    sources: z.array(ExternalReviewPinSchema).min(1).max(16),
  }),
  Attribution.extend({ cycleId: Ulid, range: Range }),
);

export const MAX_SCOPE_DOCUMENTS = 20;

const LocalScopePath = z.strictObject({ path: z.string().min(1) });
export const CycleLocalScopeSelected = event(
  "cycle.local-scope-selected@1",
  z.strictObject({
    root: z.string().min(1),
    sources: z
      .array(
        z.discriminatedUnion("kind", [
          LocalScopePath.extend({
            kind: z.literal("repository-document"),
            blob: GitOid,
          }),
          LocalScopePath.extend({
            kind: z.literal("working-file"),
            sourceId: z.string().regex(/^S[1-9][0-9]?$/),
            fetchedAt: Instant,
            sha256: Sha256,
          }),
          LocalScopePath.extend({ kind: z.literal("gap"), reason: z.string() }),
        ]),
      )
      .min(1)
      .max(MAX_SCOPE_DOCUMENTS),
    omitted: z.int().nonnegative(),
  }),
  Attribution.omit({ range: true }).extend({ cycleId: Ulid }),
);
export type CycleLocalScopeSelected = z.infer<typeof CycleLocalScopeSelected>;

export const ReviewOriginRecorded = event(
  "review.origin-recorded@1",
  z.strictObject({ identity: Sha256, origin: ReviewOriginSchema }),
  Attribution.extend({ cycleId: Ulid, range: Range }),
);

/**
 * A request to review a commit range, opening or joining its cycle (10.13). It enqueues one
 * `review.run` job in its append transaction, keyed by `runKey` and `generation`: a second request
 * for the same range and configuration joins the same job, and a request after that job failed
 * starts generation `n + 1`, a new run that reuses every cached computation (10.42). `runKey` is the
 * computation key of the run (range OIDs, pipeline version, configuration and route), and
 * `pipeline.config` is the harness's own configuration frozen with the request, which Records stores
 * without interpreting.
 */
export const ReviewRequested = event(
  "review.requested@1",
  z.strictObject({
    runKey: Sha256,
    /** How many earlier runs of this key ended failed; their jobs keep their own keys. */
    generation: z.int().min(0).max(1_000),
    pipeline: z.strictObject({
      version: z.int().min(1),
      config: z.json(),
    }),
  }),
  Attribution.extend({ cycleId: Ulid, range: Range }),
);

/** A likely review or a sampled judgement, queued without publishing a review (12.35, 12.36). */
export const JudgementPreparationRequested = event(
  "judgement.preparation.requested@1",
  ReviewRequested.shape.payload.extend({
    branch: z.string().min(1),
    reviewed: z.boolean(),
    trigger: z.enum(["head", "fetch", "pull-request", "shadow"]),
    quietUntil: z.iso.datetime(),
  }),
  Attribution.extend({ cycleId: Ulid, range: Range }),
);

/** Counts are attributed to a run without changing older run.completed@1 payloads (8.19). */
export const JudgementCounted = event(
  "judgement.counted@1",
  z.strictObject({
    carried: z.int().min(0),
    fresh: z.int().min(0),
    shadowChecked: z.int().min(0),
    shadowAgreed: z.int().min(0),
    savedSeconds: z.number().min(0),
  }),
  Attribution.extend({ cycleId: Ulid, range: Range, runId: z.string() }),
);
export const JudgementShadowChecked = event(
  "judgement.shadow-checked@1",
  z.strictObject({
    judgement: Sha256,
    agreement: z.boolean(),
    sourceReview: z.string(),
  }),
  Attribution.extend({ cycleId: Ulid, runId: z.string() }),
);

/** A current review batch: work reviewed together with a single focus. */
export const BatchRecorded = event(
  "batch.recorded@1",
  z.strictObject({ title, focus: z.string().min(1).max(2_000) }),
  Attribution.extend({ cycleId: Ulid, batchId: Ulid }),
);

/** A review unit and the changed ranges it owns. */
export const UnitRecorded = event(
  "unit.recorded@1",
  z.strictObject({ title, ownedRanges: z.array(LineRange).min(1).max(1_024) }),
  Attribution.extend({ cycleId: Ulid, batchId: Ulid, unitIds: singleUnit }),
);

/** A contextual marker attributed to one or more units; the retrieved content is a referenced computation. */
export const ContextReferenced = event(
  "context.referenced@1",
  z.strictObject({
    markerKind: MarkerKind,
    source: z.strictObject({
      kind: z.string().min(1).max(64),
      locator: z.string().min(1).max(4_096),
    }),
    summary: z.string().min(1).max(2_000),
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: UnitIds }),
);

/** The harness's lane assessment of one unit. */
export const AssessmentRecorded = event(
  "assessment.recorded@1",
  z.strictObject({
    lane: Lane,
    complexity: z.enum(["low", "high"]),
    easeOfValidation: z.enum(["easy", "hard"]),
    rationale: z.string().min(1).max(4_000),
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
);

/** An approval or request for changes on one unit's owned work, bound to the exact reviewed source. */
export const DispositionRecorded = event(
  "disposition.recorded@1",
  z.strictObject({
    verdict: Verdict,
    reviewedHeadOid: GitOid,
    note: z.string().min(1).max(4_000).optional(),
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
);

/**
 * Withdraws a disposition. `causation.supersedes` names it; only its author may retract it, which
 * the append transaction enforces.
 */
export const DispositionRetracted = event(
  "disposition.retracted@1",
  z.strictObject({ reason: z.string().min(1).max(4_000).optional() }),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
).extend({ causation: Causation.extend({ supersedes: Ulid }) });

/** A review comment, optionally anchored to lines; informational unless a disposition references it. */
export const CommentRecorded = event(
  "comment.recorded@1",
  z.strictObject({
    body: z.string().min(1).max(20_000),
    anchor: LineRange.optional(),
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: UnitIds }),
);

// ---------------------------------------------------------------------------------------------
// M3 versions (proposal §10.2, PU5; 10.73). Each new version sits beside the one it extends, which
// stays in the union so stored events still decode. Content larger than a field's cap goes by
// reference (5.3): digests, delivery stops, ledgers and retrieved content are computations.
// ---------------------------------------------------------------------------------------------

/** A side of a diff: the base revision's lines (`old`) or the head revision's (`new`). */
export const Side = z.enum(["old", "new"]);

/**
 * An owned range with its side (vocabulary: Owned range). `lines` owns changed lines on one side;
 * `whole-nontext` owns a binary or otherwise non-text change to a file as a whole, as the kept review
 * rules define it.
 */
export const OwnedRange = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("lines"),
      path: z.string().min(1).max(4_096),
      side: Side,
      startLine: z.int().min(1),
      endLine: z.int().min(1),
    })
    .refine(
      (range) => range.endLine >= range.startLine,
      "endLine precedes startLine",
    ),
  z.strictObject({
    kind: z.literal("whole-nontext"),
    path: z.string().min(1).max(4_096),
    side: Side,
  }),
]);

/** Lines on one side of the diff, for anchors. */
const SidedLineRange = z
  .strictObject({
    path: z.string().min(1).max(4_096),
    side: Side,
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  })
  .refine(
    (range) => range.endLine >= range.startLine,
    "endLine precedes startLine",
  );

/**
 * What an assessment factor, a finding or a criterion cites: a computation or blob (a ledger, change
 * facts, a retrieved excerpt), optionally one entry inside it, or another event such as a context
 * reference or a proof record.
 */
export const Citation = z.strictObject({
  ref: z
    .string()
    .regex(
      /^(?:(?:computation|blob):[0-9a-f]{64}|event:[0-9A-HJKMNP-TV-Z]{26})$/,
      "Expected computation:<sha256>, blob:<sha256> or event:<ulid>",
    ),
  /** An entry inside the cited content, such as a ledger entry or `path:line`: printable ASCII. */
  entry: z
    .string()
    .regex(
      /^[\x21-\x7e]{1,128}$/,
      "Expected at most 128 printable ASCII characters",
    )
    .refine((entry) => !/["\\]/.test(entry), "Expected no quote or backslash")
    .optional(),
});
const citations = (max: number) => z.array(Citation).max(max);

/**
 * Text whose canonical JSON takes at most 3 bytes per character: no control character but tab and
 * newline (each escaped in 2 bytes), so a cap on characters bounds the bytes an event can take.
 */
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(
      /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/,
      "Expected no control characters but tab and newline",
    );

/** A kind of disclosed gap, such as `scope-missing` or `stage-interrupted`; stages add kinds. */
export const GapKind = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/, "Expected a lower-case gap kind");

/**
 * Why no agent decided a section, such as `failed`, `not-reached`, `unsure`, `unconfirmed`,
 * `disagreed` or `too-large`. An open set: the harness adds causes without a new event version, as
 * stages add gap kinds, so a reader names a cause it does not know rather than refusing it.
 *
 * A unit with a section no agent decided is said to the reader in one `gap.disclosed@1` per unit,
 * attributed to that unit, whose kind is `UNDECIDED_GAP_PREFIX` followed by the cause, such as
 * `undecided-failed`. That kind is a contract between writers and readers: readers find these gaps
 * by the prefix, and the desk hides them from a person by it (the cause is never shown there), so
 * the prefix and every cause name are stable. A cause is at most 32 characters, so the gap kind
 * stays within `GapKind`'s 64.
 */
export const UndecidedCause = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/, "Expected a lower-case cause name");

/**
 * The start of the kind of the one `gap.disclosed@1` per unit that says a section of it no agent
 * decided: the gap kind is this prefix followed by the `UndecidedCause`. Writers build the kind
 * with it and readers match it, so both share this one definition.
 */
export const UNDECIDED_GAP_PREFIX = "undecided-" as const;

/** Sections no agent decided, counted by cause; a cause with none is absent, so `{}` is none. */
export const UndecidedCounts = z
  .record(UndecidedCause, z.int().min(1))
  .refine(
    (counts) => Object.keys(counts).length <= 16,
    "at most 16 causes are counted",
  );

const undecidedTotal = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

/**
 * How the agent grouped the unit (10.59, 10.70): the unchanged-line gap its default grouping used
 * (20 unless the range's guidance moved it within 10–40), and, when the agent merged default units
 * or split one, which and why. Telemetry counts both.
 */
export const UnitGrouping = z.strictObject({
  gapLines: z.int().min(0).max(400),
  adjustment: z
    .strictObject({
      kind: z.enum(["merge", "split"]),
      reason: z.string().min(1).max(1_000),
    })
    .optional(),
});

/** A review unit, its owned ranges with their sides, and how it was grouped (10.70). */
export const UnitRecordedV2 = event(
  "unit.recorded@2",
  z.strictObject({
    title,
    ownedRanges: z.array(OwnedRange).min(1).max(1_024),
    grouping: UnitGrouping,
  }),
  Attribution.extend({ cycleId: Ulid, batchId: Ulid, unitIds: singleUnit }),
);

/**
 * Version 3 of a review unit: one file's sections in one review lane, identified by the hash of the
 * keys of the sections it holds (`key`, which the harness computes), so the same ID always means
 * the same sections. What the unit holds (each section's identity, title and owned ranges) is the
 * one `sections` blob, durable and without a bound, so a file of any size keeps every range; the
 * payload carries the title, the path and counts. There is no grouping: proximity grouping ended
 * with sections. Older builds skip the kind, so they never read a unit without its lines.
 */
export const UnitRecordedV3 = event(
  "unit.recorded@3",
  z.strictObject({
    title,
    /** Who wrote the title: code (from the file and the section titles) or an agent. */
    titleBy: z.enum(["code", "agent"]),
    path: z.string().min(1).max(4_096),
    key: Sha256,
    sections: z.strictObject({ count: z.int().min(1) }),
    /**
     * What the blob holds, for readers that need no blob: `count` is its owned ranges, and `lines`
     * the lines they cover, each line range counting `endLine - startLine + 1` and a whole non-text
     * range counting none. A reader discloses a payload that disagrees with its blob.
     */
    ranges: z.strictObject({ count: z.int().min(1), lines: z.int().min(0) }),
  }),
  Attribution.extend({ cycleId: Ulid, batchId: Ulid, unitIds: singleUnit }),
).extend({
  refs: z.tuple([
    z.strictObject({
      ref: z.string().regex(/^blob:[0-9a-f]{64}$/, "Expected blob:<sha256>"),
      role: z.literal("sections"),
    }),
  ]),
});

/** Where a context reference stands toward the change ([0006](../../../architecture/decisions/0006-hybrid-retrieval-and-context-references.md)). */
export const Stance = z.enum([
  "supports",
  "contradicts",
  "background",
  "unresolved",
]);

/** Where the referenced content came from (0006 attribution: provenance). */
export const Provenance = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("git"),
    revision: GitOid,
    blob: GitOid.optional(),
    path: z.string().min(1).max(4_096),
    startLine: z.int().min(1).optional(),
    endLine: z.int().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal("record"), eventId: Ulid }),
  z.strictObject({
    kind: z.literal("url"),
    url: z.url().max(4_096),
    version: z.string().min(1).max(256).optional(),
  }),
]);

/**
 * A contextual marker with the parts of 0006's contract M3 fills: the anchor on a changed line, the
 * stance, committed or same-batch origin, how it was retrieved and its provenance. The reference's
 * identity is the event ID; batch and cycle are its attribution; the retrieved content is a
 * referenced computation. M4 completes the contract.
 */
export const ContextReferencedV2 = event(
  "context.referenced@2",
  z.strictObject({
    markerKind: MarkerKind,
    source: z.strictObject({
      kind: z.string().min(1).max(64),
      locator: z.string().min(1).max(4_096),
    }),
    summary: z.string().min(1).max(2_000),
    anchor: SidedLineRange,
    stance: Stance,
    origin: z.enum(["committed", "same-batch"]),
    retrieval: z
      .strictObject({
        retriever: z.string().min(1).max(128),
        query: z.string().min(1).max(2_000).optional(),
        rank: z.int().min(1),
        score: z.number().optional(),
      })
      .optional(),
    provenance: Provenance,
  }),
  Attribution.extend({
    cycleId: Ulid,
    batchId: Ulid.optional(),
    unitIds: UnitIds,
  }),
);

/** One cited finding behind an axis level, such as impact or size for complexity (10.57). */
const Factor = z.strictObject({
  factor: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/, "Expected a lower-case factor name"),
  finding: boundedText(300),
  cites: citations(6),
});

/** A validation requirement and its proof coverage (10.58, 11.1): solid only when the kinds converge. */
const ValidationRequirement = z.strictObject({
  requirement: boundedText(300),
  cites: citations(6),
  coverage: z.enum(["missing", "shallow", "solid"]),
  /** The proof records it rests on, by event ID; empty while none is recorded (10.62). */
  proof: z.array(Ulid).max(8),
});

export const Axis = z.enum(["complexity", "ease-of-validation"]);

/** A quadrant of the lane matrix (4.2): complexity, then ease of validation. */
export const Quadrant = z.enum([
  "low-easy",
  "low-hard",
  "high-easy",
  "high-hard",
]);

/** The assessment's fields every version from 2 shares, around its validation requirements. */
const assessmentFields = <R extends z.ZodType>(requirement: R) => ({
  lane: Lane,
  quadrant: Quadrant,
  complexity: z.strictObject({
    level: z.enum(["low", "high"]),
    factors: z.array(Factor).max(8),
  }),
  easeOfValidation: z.strictObject({
    level: z.enum(["easy", "hard"]),
    requirements: z.array(requirement).max(8),
  }),
  movement: z
    .array(
      z.strictObject({
        signal: z.enum(["prior-bug", "outage", "blast-radius"]),
        finding: boundedText(300),
        axis: Axis,
        direction: z.enum(["toward-human", "away-from-human"]),
        cites: citations(6),
      }),
    )
    .max(6),
  lean: z
    .strictObject({
      lane: z.enum(["agentic", "human-suggested"]),
      reason: boundedText(300),
    })
    .optional(),
  gaps: z
    .array(
      z.strictObject({
        axis: Axis,
        kind: GapKind,
        detail: boundedText(300),
      }),
    )
    .max(6),
  rationale: boundedText(1_000),
});

const quadrantMatches = (p: {
  readonly quadrant: string;
  readonly complexity: { readonly level: string };
  readonly easeOfValidation: { readonly level: string };
}) =>
  p.quadrant ===
  `${p.complexity.level}-${p.easeOfValidation.level === "easy" ? "easy" : "hard"}`;
const QUADRANT_MESSAGE = "quadrant does not match the axis levels";

/**
 * The lane assessment with its axes, cited factors, movement signals, gaps and quadrant (proposal
 * §8.4; 10.55–10.57). Two levels per axis, no scores. Gaps are per axis; a gap on ease of validation
 * beside high complexity is 10.55's case, which telemetry counts.
 *
 * Its bounds keep every assessment within the 64 KB payload cap, so it never needs a reference.
 * Text takes at most 3 bytes a character (`boundedText`) and a citation at most 225 bytes, so at
 * every bound: 8 factors of 2,356 bytes, 8 requirements of 2,547, 6 movement signals of 2,362, 6 gaps
 * of 1,015, the lean at 938 and the rationale at 3,002 come to 63,640 bytes with their keys, under
 * 65,536 (the records-core test `review-events` builds that payload and measures it).
 */
export const AssessmentRecordedV2 = event(
  "assessment.recorded@2",
  z
    .strictObject(assessmentFields(ValidationRequirement))
    .refine(quadrantMatches, QUADRANT_MESSAGE),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
);

/**
 * A checkpoint's proof state (vocabulary: Checkpoint; 11.16, 11.19, 11.20), set by code from the
 * proof records it rests on and their currency for its unit, never by an agent, in this order:
 * `missing`, no record it names is in Records; `out-of-date`, a record it rests on is not current
 * for the unit, or an external source it rests on changed or could not be checked; `conflicting`,
 * the records it rests on disagree; `proven`, two or more kinds, every applicable kind recorded, a
 * current test run wherever the behaviour can be tested, all current and in agreement; `thin`,
 * anything else. Missing, Out of date and Conflicting are unmet.
 */
export const CheckpointState = z.enum([
  "missing",
  "out-of-date",
  "conflicting",
  "proven",
  "thin",
]);

const distinct = <T>(values: ReadonlyArray<T>) =>
  new Set(values).size === values.length;

/**
 * A validation requirement as a checkpoint (10.110, 11.16, 11.17): version 2's requirement with what
 * code needs to set its proof state at any later read (the applicable kinds the agent named and
 * whether the records agree), its anchors and the external sources it rests on. `anchors` are
 * indices into its unit's `unit.recorded@2` owned ranges: the owned line ranges that meet it,
 * resolved by Assemble when the batch was created; none means it reaches no owned line and is
 * anchored to its unit as a whole. `sources` name the scope sources it rests on by their ID in the
 * cycle's snapshot; the assembled batch the packet names holds each one's pin (`SourcePin`), which
 * would not fit the payload cap here.
 */
const ValidationRequirementV3 = ValidationRequirement.extend({
  kinds: z.array(ProofKind).max(6).refine(distinct, "kinds must not repeat"),
  agree: z.boolean(),
  /**
   * Whether a test can check the behaviour (11.20): when it can, Proven needs a current test run.
   * When it can't, the agent said why; the assembled batch keeps the reason, which the read model
   * shows, since text here would not fit the payload cap.
   */
  testable: z.boolean(),
  anchors: z
    .array(z.int().min(0).max(1_023))
    .max(8)
    .refine(distinct, "anchors must not repeat"),
  sources: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/, "Expected a scope source ID"),
    )
    .max(4)
    .refine(distinct, "sources must not repeat"),
});

/**
 * Version 3 of the assessment (11.16, 11.17): every requirement carries its checkpoint's anchors,
 * applicable kinds, agreement and the external sources it rests on. The proof state itself is not
 * stored: code sets it when it is read, from the records named, their currency for the unit at that
 * read (11.10) and the pins' status (11.18). At every bound it takes 65,440 bytes of the 64 KB
 * payload cap, which the records-core test `review-events` measures.
 */
export const AssessmentRecordedV3 = event(
  "assessment.recorded@3",
  z
    .strictObject(assessmentFields(ValidationRequirementV3))
    .refine(quadrantMatches, QUADRANT_MESSAGE),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
);

/**
 * Version 4 of the assessment: the unit's lane as code applied it, under lane rule `laneRule`, and
 * counts of its sections (how many; how many code applied a higher lane than the judged one, whatever
 * raised it: the public-surface raise, a floor, or being undecided; and those no agent decided, by
 * cause).
 * What was judged about each section (its axes, its review, the trail from the judged lane to the
 * applied one, and why none was decided) is the one `judgements` computation, joined to the unit's
 * sections by key. Every published unit records its lane this way, including one no agent decided,
 * so no unit reads as never assessed. Older builds skip the kind.
 */
export const AssessmentRecordedV4 = event(
  "assessment.recorded@4",
  z
    .strictObject({
      lane: Lane,
      laneRule: z.int().min(3).max(1_000),
      sections: z.strictObject({
        count: z.int().min(1),
        raised: z.int().min(0),
        undecided: UndecidedCounts,
      }),
      rationale: boundedText(1_000).optional(),
    })
    .refine(
      (p) => p.sections.raised <= p.sections.count,
      "no more sections are raised than the unit holds",
    )
    .refine(
      (p) => undecidedTotal(p.sections.undecided) <= p.sections.count,
      "no more sections are undecided than the unit holds",
    ),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
).extend({
  refs: z.tuple([
    z.strictObject({
      ref: z
        .string()
        .regex(/^computation:[0-9a-f]{64}$/, "Expected computation:<sha256>"),
      role: z.literal("judgements"),
    }),
  ]),
});

/** The delivery content a batch or unit carries (vocabulary: Digest, review delivery stops). */
export const DeliveryContent = z.enum([
  "batch-digest",
  "facts",
  "briefed",
  "explained",
  "guided",
]);

/**
 * A digest or delivery stop (proposal §8.5, 10.60, 10.61, 10.67). The text is a computation the
 * single `content` ref names, never copied (5.3, PU3). A batch digest names its batch; every stop
 * names its one unit. `verdictWords` counts the verdict words code flagged for measurement (10.61).
 */
export const DeliveryRecorded = event(
  "delivery.recorded@1",
  z.strictObject({
    content: DeliveryContent,
    verdictWords: z.int().min(0).max(1_000).optional(),
  }),
  Attribution.extend({
    cycleId: Ulid,
    batchId: Ulid,
    unitIds: singleUnit.optional(),
  }),
)
  .extend({
    refs: z.tuple([
      z.strictObject({
        ref: z
          .string()
          .regex(/^computation:[0-9a-f]{64}$/, "Expected computation:<sha256>"),
        role: z.literal("content"),
      }),
    ]),
  })
  .refine(
    (e) =>
      (e.payload.content === "batch-digest") ===
      (e.attribution.unitIds === undefined),
    "a batch digest names no unit; every delivery stop names its one unit",
  );

/** A finding's kind and what it is about (proposal §9.3, 10.63, 10.69). */
export const FindingKind = z.enum([
  "defect",
  "risk",
  "question",
  "pattern-note",
]);
export const FindingAbout = z.enum(["code", "tests", "proof"]);

/**
 * Which of 10.63's and 11.10's signs a finding about tests or proof rests on, so telemetry counts
 * each apart: forged or bogus evidence is a defect; test bloat, behaviour no test covers and stale
 * proof are risks (stale proof is not forged, 11.10). Internal; not a product term.
 */
export const FindingSignal = z.enum([
  "forged",
  "test-bloat",
  "untested",
  "stale-proof",
]);

/** Which finding kinds a test-or-proof sign may sit on (10.63, 11.10); every comment version keeps it. */
const signalMatches = (f: {
  readonly kind: string;
  readonly about: string;
  readonly signal?: string | undefined;
}) =>
  f.signal === undefined ||
  (f.about !== "code" &&
    (f.signal === "forged") === (f.kind === "defect") &&
    (f.signal !== "stale-proof" || f.about === "proof") &&
    (f.signal === "forged" || f.kind === "risk"));
const SIGNAL_MESSAGE =
  "a signal belongs to a finding about tests or proof: forged on a defect; test-bloat, untested or stale-proof (about proof) on a risk";

/**
 * A review comment; a finding carries its kind, what it is about, its evidence (10.69) and, for a
 * finding about tests or proof, the sign it rests on (10.63). Informational unless a disposition
 * references it.
 */
export const CommentRecordedV2 = event(
  "comment.recorded@2",
  z.strictObject({
    body: z.string().min(1).max(20_000),
    anchor: SidedLineRange.optional(),
    finding: z
      .strictObject({
        kind: FindingKind,
        about: FindingAbout,
        signal: FindingSignal.optional(),
        evidence: citations(32),
      })
      .refine(signalMatches, SIGNAL_MESSAGE)
      .optional(),
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: UnitIds }),
);

/**
 * A finding's kind from comment version 3: version 2's kinds and `impact`, a change in what the
 * code does that a person should weigh (13.19, 13.20). A new enum, so version 2 keeps its closed set
 * and older builds never read a version 2 comment with a kind they do not know.
 */
export const FindingKindV3 = z.enum([...FindingKind.options, "impact"]);

/** What an impact finding says the change does to a behaviour (13.19, 13.20). */
export const ImpactEffect = z.enum([
  "removed",
  "disabled",
  "narrowed",
  "changed",
  "added",
]);

/** Causation for a claim that never sets another record aside: no `supersedes`. */
const neverSupersedes = Causation.extend({
  supersedes: z.never().optional(),
}).optional();

/**
 * Version 3 of a review comment: version 2 with the impact finding (13.19, 13.20), whose `effect`
 * says what the change does to a behaviour, so the desk can put removals first and the stats can
 * count them, and whose `summary` is the one sentence the desk prints for it in a batch briefing's
 * part on what was removed, disabled or narrowed; the body stays the full comment. The effect and
 * the summary are given on an impact finding and only there. Version 2 is unchanged and
 * stays what people's comments use. Read from the log, not projected into the shared comments
 * table, whose read model on older builds knows only version 2's four finding kinds; it supersedes
 * nothing, since nothing would record the supersession.
 */
export const CommentRecordedV3 = event(
  "comment.recorded@3",
  z.strictObject({
    /**
     * At most 10,600 characters of 3 bytes each, so the payload fits the 64 KB cap at every bound
     * with an anchor path of 4,096 control characters (6 bytes each), an impact summary of 300
     * characters of 3 bytes each and 32 citations at their longest (the records-core test
     * `new-kinds-codec` measures it). Version 2's 20,000 does not.
     */
    body: boundedText(10_600),
    anchor: SidedLineRange.optional(),
    /**
     * The key of the section of its unit the comment is about (the `key` of a section in the
     * unit's `sections` blob), so a comment with no anchor still sits under its section on the
     * desk. Absent for a comment about the whole unit. Its 77 bytes in canonical JSON keep the
     * payload within the 64 KB cap at every bound (the records-core test `new-kinds-codec`).
     */
    section: Sha256.optional(),
    finding: z
      .strictObject({
        kind: FindingKindV3,
        about: FindingAbout,
        signal: FindingSignal.optional(),
        effect: ImpactEffect.optional(),
        /**
         * An impact finding's one sentence, as the desk prints it in a batch briefing: one line of
         * at most 300 characters that says something, so it never prints blank: at least one letter
         * or digit (`\p{L}`, `\p{N}`), where the Hangul fillers, which Unicode counts as letters
         * but which print nothing, do not count. No line break, line or paragraph separator
         * (U+0085, U+2028, U+2029) or tab.
         */
        summary: boundedText(300)
          .regex(
            /^[^\n\t\u0085\u2028\u2029]*$/,
            "Expected one line, with no line break, line or paragraph separator, or tab",
          )
          .regex(
            /(?![\u115f\u1160\u3164\uffa0])[\p{L}\p{N}]/u,
            "Expected at least one letter or digit",
          )
          .optional(),
        evidence: citations(32),
      })
      .refine(signalMatches, SIGNAL_MESSAGE)
      .refine(
        (f) => (f.kind === "impact") === (f.effect !== undefined),
        "an impact finding names its effect, and only an impact finding has one",
      )
      .refine(
        (f) => (f.kind === "impact") === (f.summary !== undefined),
        "an impact finding gives its summary, and only an impact finding has one",
      )
      .optional(),
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: UnitIds }),
).extend({ causation: neverSupersedes });

const distinctIds = (max: number) =>
  z
    .array(Ulid)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, "IDs must not repeat");

/**
 * A disposition naming the comments a request for changes rests on (10.69) and the proof records an
 * approval rests on (10.62: none yet in M3, which telemetry counts by lane). A request with no
 * comment named is recorded as decided and counted as uncited (proposal §9.2).
 */
export const DispositionRecordedV2 = event(
  "disposition.recorded@2",
  z
    .strictObject({
      verdict: Verdict,
      reviewedHeadOid: GitOid,
      note: z.string().min(1).max(4_000).optional(),
      restsOn: distinctIds(64),
      proof: distinctIds(64),
    })
    .refine(
      (p) => p.verdict === "request-changes" || p.restsOn.length === 0,
      "only a request for changes rests on comments",
    ),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
);

/** Reuse is an attributed claim. Older readers skip these distinct kinds (8.19). */
export const DispositionCarried = event(
  "disposition.carried@1",
  DispositionRecordedV2.shape.payload.safeExtend({
    lineage: z.literal("carried"),
    from: JudgementLineage,
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: singleUnit }),
);
export const CommentCarried = event(
  "comment.carried@1",
  CommentRecordedV2.shape.payload.extend({
    lineage: z.literal("carried"),
    from: JudgementLineage,
  }),
  Attribution.extend({ cycleId: Ulid, unitIds: UnitIds }),
);

/**
 * How a unit relates to earlier units: another configuration's units of the same range, or the
 * units of an earlier commit's review, compared section by section. Each earlier unit counts the
 * new unit's sections that are the same change there (`unchanged`) and those that are the same
 * symbol changed since (`changed`); `unchanged` as the relation means every section of the new unit
 * is the same change in that one unit, so whatever was decided there was decided on exactly this
 * code. Each entry also keeps the earlier unit's lane, so a reader can say a unit moved up a lane.
 * An attributed claim, read from the log and never projected: it moves no decision and
 * supersedes nothing. Attributed to the successor first and then the earlier units, so the unit
 * index leads from an earlier unit to the units that now hold its sections.
 */
export const LineageRecorded = event(
  "lineage.recorded@1",
  z.strictObject({
    from: z
      .array(
        z
          .strictObject({
            unitId: Ulid,
            cycleId: Ulid,
            relation: z.enum(["unchanged", "changed"]),
            unchanged: z.int().min(0),
            changed: z.int().min(0),
            /** The earlier unit's lane as its own packet recorded it; null when it had no assessment. */
            lane: Lane.nullable(),
          })
          .refine(
            (entry) => entry.unchanged + entry.changed >= 1,
            "an earlier unit counts at least one section",
          )
          .refine(
            (entry) => entry.relation !== "unchanged" || entry.changed === 0,
            "an unchanged relation has no changed sections",
          ),
      )
      .min(1)
      .max(64)
      .refine(
        (from) =>
          new Set(from.map((entry) => entry.unitId)).size === from.length,
        "earlier units must not repeat",
      ),
  }),
  Attribution.extend({
    cycleId: Ulid,
    unitIds: z
      .array(Ulid)
      .min(2)
      .max(65)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "unitIds must not repeat",
      ),
  }),
)
  .extend({ causation: neverSupersedes })
  .refine(
    (e) =>
      e.attribution.unitIds.length === e.payload.from.length + 1 &&
      e.payload.from.every(
        (entry, index) => e.attribution.unitIds[index + 1] === entry.unitId,
      ),
    "attributed to the successor, then each earlier unit in the order `from` names them",
  );

/**
 * A published packet (8.7): its small content-addressed manifest of every batch, unit, reference,
 * assessment, delivery content and disposition hash, plus the run's configuration and route, is the
 * single `manifest` ref. The counts summarise it, and `complete` is false when gaps cut it short.
 */
export const PacketPublished = event(
  "packet.published@1",
  z.strictObject({
    complete: z.boolean(),
    counts: z.strictObject({
      batches: z.int().min(0),
      units: z.int().min(0),
      contextReferences: z.int().min(0),
      assessments: z.int().min(0),
      deliveries: z.int().min(0),
      dispositions: z.int().min(0),
      comments: z.int().min(0),
      gaps: z.int().min(0),
    }),
  }),
  Attribution.extend({
    cycleId: Ulid,
    range: Range,
    runId: z.string().min(1).max(512),
  }),
).extend({
  refs: z.tuple([
    z.strictObject({
      ref: z
        .string()
        .regex(
          /^(?:computation|blob):[0-9a-f]{64}$/,
          "Expected computation:<sha256> or blob:<sha256>",
        ),
      role: z.literal("manifest"),
    }),
  ]),
});

const tally = z.int().min(0);

/**
 * One publication in a review's chain of cumulative packets: each packet's manifest is the
 * previous one's batches, unchanged and in order, plus the batches settled since, and a published
 * batch never changes. `ordinal` is its place in the chain; `counts` cover the review so far,
 * including what is still being judged (`pending`) and the sections no agent decided, by cause;
 * `added` is what this publication brought. Its gaps are the ones its manifest names, never every
 * gap of its run. A new version rather than version 1 with more counts, so an older build skips the
 * cycle's review instead of reading units it cannot. The manifest is the single `manifest` ref, as
 * in version 1.
 */
export const PacketPublishedV2 = event(
  "packet.published@2",
  z
    .strictObject({
      /**
       * Whether the review is complete: every batch is published, nothing is pending and no gap
       * cut it short. A publication that leaves batches pending is never complete, which is not
       * version 1's meaning (every record of its one packet accepted).
       */
      complete: z.boolean(),
      ordinal: z.int().min(1),
      counts: z.strictObject({
        batches: tally,
        units: tally,
        sections: tally,
        contextReferences: tally,
        assessments: tally,
        deliveries: tally,
        dispositions: tally,
        comments: tally,
        gaps: tally,
        pending: z.strictObject({ batches: tally, sections: tally }),
        undecided: UndecidedCounts,
      }),
      added: z.strictObject({
        batches: tally,
        units: tally,
        sections: tally,
        undecided: UndecidedCounts,
      }),
    })
    .refine(
      (p) => undecidedTotal(p.counts.undecided) <= p.counts.sections,
      "no more sections are undecided than the review holds",
    )
    .refine(
      (p) => undecidedTotal(p.added.undecided) <= p.added.sections,
      "a publication adds no more undecided sections than sections",
    )
    .refine(
      (p) =>
        p.added.batches <= p.counts.batches &&
        p.added.units <= p.counts.units &&
        p.added.sections <= p.counts.sections &&
        Object.entries(p.added.undecided).every(
          ([cause, n]) =>
            Object.hasOwn(p.counts.undecided, cause) &&
            n <= p.counts.undecided[cause]!,
        ),
      "a publication adds no more than the review holds",
    )
    .refine(
      (p) =>
        !p.complete ||
        (p.counts.pending.batches === 0 && p.counts.pending.sections === 0),
      "a complete review has nothing still being judged",
    ),
  PacketPublished.shape.attribution,
).extend({ refs: PacketPublished.shape.refs });

/**
 * A gap the run disclosed (2.5, 10.42): scope missing, a stage that fell back or was cut off,
 * Graph unavailable, history not consulted (once per run, 10.3). Attributed to the run and, when
 * one caused it, the stage; units only when the gap is theirs.
 */
export const GapDisclosed = event(
  "gap.disclosed@1",
  z.strictObject({ kind: GapKind, detail: z.string().min(1).max(2_000) }),
  Attribution.extend({
    cycleId: Ulid,
    range: Range,
    runId: z.string().min(1).max(512),
  }),
);

/** Work has started, including work still in flight when a run stops. Additive for older readers. */
export const StageStarted = event(
  "stage.started@1",
  z.strictObject({ agent: z.string().min(1).max(512) }),
  Attribution.extend({
    cycleId: Ulid,
    range: Range,
    runId: z.string().min(1).max(512),
    stage: z.string().min(1).max(512),
  }),
);

/** Additive counters leave the existing strict stage and receipt payloads readable by older builds. */
export const ModelCallsCountedV2 = event(
  "model.calls-counted@2",
  ModelCallAttempts.extend({ agent: z.string().min(1).max(512).optional() }),
  Attribution.extend({
    cycleId: Ulid,
    range: Range,
    runId: z.string().min(1).max(512),
  }),
);

/** One stage's telemetry (10.32): attributed to the run, its stage and, when it has one, its batch. */
export const StageCompleted = event(
  "stage.completed@1",
  StageTelemetry,
  Attribution.extend({
    cycleId: Ulid,
    range: Range,
    runId: z.string().min(1).max(512),
    stage: z.string().min(1).max(512),
  }),
);

/**
 * A run ended and published what it completed, with its receipt (PU6, 10.32, 10.73). A receipt whose
 * lists would pass the payload cap carries them by reference: one durable `lists` blob, named by
 * `listsByReference`, and only then.
 */
export const RunCompleted = event(
  "run.completed@1",
  RunReceipt,
  Attribution.extend({
    cycleId: Ulid,
    range: Range,
    runId: z.string().min(1).max(512),
  }),
)
  .extend({
    refs: z
      .tuple([
        z.strictObject({
          ref: z
            .string()
            .regex(/^blob:[0-9a-f]{64}$/, "Expected blob:<sha256>"),
          role: z.literal("lists"),
        }),
      ])
      .optional(),
  })
  .refine(
    (e) =>
      (e.refs === undefined) === (e.payload.listsByReference === undefined),
    "a receipt names a lists blob exactly when its lists go by reference",
  );

/**
 * A proof record (11.3, 11.8; proposal §12, slice H4b): one artefact of observed proof, the commit
 * it observed and the range its recorder was working on, a capped claim of what it shows, the
 * validation requirement it serves, and the recorder, which is the event's actor (an agent session
 * or subagent) and its session. The artefact is the single `artefact` ref, a raw-capture blob until
 * a published packet cites it and Publish promotes it to durable (8.10, proposal §10.2). Records keep
 * every record and nothing supersedes one, so it carries no causation. Whether a record is current
 * for a unit is decided when it is read, from git objects (11.10), never stored here.
 */
export const ProofRecorded = event(
  "proof.recorded@1",
  ProofPayload,
  Attribution.extend({ range: Range, sessionId: SessionId }),
).extend({
  causation: z.never().optional(),
  refs: z.tuple([
    z.strictObject({
      ref: z.string().regex(/^blob:[0-9a-f]{64}$/, "Expected blob:<sha256>"),
      role: z.literal("artefact"),
    }),
  ]),
});

// ---------------------------------------------------------------------------------------------
// M5 feedback (proposal §7, FB1–FB4; 10.98, 10.100).
// ---------------------------------------------------------------------------------------------

/**
 * What a piece of feedback is on (FB1), always a Records event named by its ID: a unit (its
 * `unit.recorded` event), a finding (an agent's `comment.recorded`), a context reference (its
 * `context.referenced`), or a digest or delivery stop (its `delivery.recorded`).
 */
export const FeedbackTarget = z.enum([
  "unit",
  "finding",
  "reference",
  "digest",
]);

/** The event kinds each feedback target names. */
export const FEEDBACK_TARGET_KINDS = {
  unit: ["unit.recorded@1", "unit.recorded@2", "unit.recorded@3"],
  finding: [
    "comment.recorded@1",
    "comment.recorded@2",
    "comment.carried@1",
    "comment.recorded@3",
  ],
  reference: ["context.referenced@1", "context.referenced@2"],
  digest: ["delivery.recorded@1"],
} as const satisfies Record<
  z.infer<typeof FeedbackTarget>,
  ReadonlyArray<string>
>;

/** A finding judged as on the sheet (FB2). */
export const FindingJudgement = z.enum(["valid", "invalid", "unsure"]);

/** A context reference graded as on the sheet's margin cards, with "misleading" (FB2, 9.9). */
export const ReferenceGrade = z.enum([
  "necessary",
  "useful",
  "irrelevant",
  "misleading",
]);

const YesNo = z.enum(["yes", "no"]);

/** Fields every feedback answer carries, whatever it is on. */
const feedbackFields = {
  /** The event the answer is on; its kind must be the one `on` names (checked on append). */
  target: Ulid,
  /**
   * Whether the harness's call on the item (a unit's lane, a reference's grade, the agent's review)
   * was visible when the person answered (FB4, 10.100). The desk does not hide it, so desk answers
   * are not decide-then-reveal; this says, per answer, what the person could see. The review
   * delivery stop the person was reading at is never recorded (C4).
   */
  harnessCallVisible: z.boolean(),
  note: boundedText(4_000).optional(),
};

/** A unit's answer: the sheet's complexity, ease of validation, lane and verdict. */
const unitAnswer = z.strictObject({
  on: z.literal("unit"),
  ...feedbackFields,
  complexity: z.enum(["low", "high"]).optional(),
  easeOfValidation: z.enum(["easy", "hard"]).optional(),
  lane: Lane.optional(),
  verdict: Verdict.optional(),
});

const findingAnswer = z.strictObject({
  on: z.literal("finding"),
  ...feedbackFields,
  judged: FindingJudgement.optional(),
});

/** A reference's grade, with the other grade of an in-between answer (10.98). */
const referenceGradeFields = {
  grade: ReferenceGrade.optional(),
  /** The other grade of an in-between answer (10.98); only beside a different grade. */
  between: ReferenceGrade.optional(),
};

const inBetween = (a: {
  grade?: string | undefined;
  between?: string | undefined;
}) =>
  a.between === undefined || (a.grade !== undefined && a.grade !== a.between);
const IN_BETWEEN = "an in-between grade sits beside a different grade";

const digestAnswer = z.strictObject({
  on: z.literal("digest"),
  ...feedbackFields,
  accurate: YesNo.optional(),
  complete: YesNo.optional(),
  misleadingClaim: z.enum(["none", "some"]).optional(),
  neutralBeforeVerdict: YesNo.optional(),
});

/** Fields that say what the answer is on or what the person could see, never an answer. */
const NOT_ANSWERS = [
  "on",
  "target",
  "harnessCallVisible",
  "harnessGrade",
  "note",
];

const answersSomething = (a: Record<string, unknown>) =>
  a["note"] !== undefined ||
  Object.entries(a).some(
    ([key, value]) => !NOT_ANSWERS.includes(key) && value !== undefined,
  );
const ANSWERS_SOMETHING = "feedback answers at least one scale or gives a note";

/**
 * One answer on the sheet's scales (FB2): on a unit, complexity, ease of validation, lane and
 * verdict; on a finding, valid, invalid or unsure; on a reference, a grade with an optional second
 * grade when the person places it between two (10.98); on a digest, the four rubric answers. A
 * person may answer some scales and leave others, or give a note alone, but never nothing.
 */
export const FeedbackAnswer = z
  .discriminatedUnion("on", [
    unitAnswer,
    findingAnswer,
    z
      .strictObject({
        on: z.literal("reference"),
        ...feedbackFields,
        ...referenceGradeFields,
      })
      .refine(inBetween, IN_BETWEEN),
    digestAnswer,
  ])
  .refine(answersSomething, ANSWERS_SOMETHING);

/** A note's length, as the reference rubric asks it (10.107). */
export const NoteLength = z.enum(["too-short", "right", "too-long"]);

/**
 * Version 2 of the answer (10.107): a reference's answer keeps its one grade and gains five optional
 * rubric answers on its note, and the harness's grade the person saw. Each rubric answer is left
 * out when the person did not give it, so an unanswered row reads blank, never yes:
 *
 * - `saysWhy`: the note says why the reference is here;
 * - `tiedToLines`: it says what the reference means for these lines;
 * - `checkActionable`: its "before you decide" check names something the person can do; asked only
 *   when the reference has a check;
 * - `accurate`: the stance and the reason are true to the source;
 * - `length`: too short, right or too long.
 *
 * `harnessGrade` is the harness's grade on the reference as the card showed it, so it is given only
 * when the harness's call was visible; it is what the person saw, not an answer. Every other target's
 * answer is as in version 1, which older answers keep: they read with the rubric blank.
 */
export const FeedbackAnswerV2 = z
  .discriminatedUnion("on", [
    unitAnswer,
    findingAnswer,
    z
      .strictObject({
        on: z.literal("reference"),
        ...feedbackFields,
        ...referenceGradeFields,
        harnessGrade: ReferenceGrade.optional(),
        saysWhy: YesNo.optional(),
        tiedToLines: YesNo.optional(),
        checkActionable: YesNo.optional(),
        accurate: YesNo.optional(),
        length: NoteLength.optional(),
      })
      .refine(inBetween, IN_BETWEEN)
      .refine(
        (a) => a.harnessGrade === undefined || a.harnessCallVisible,
        "the harness's grade is recorded only when it was visible",
      ),
    digestAnswer,
  ])
  .refine(answersSomething, ANSWERS_SOMETHING);

/**
 * A person's feedback (vocabulary: Feedback; 10.100): the owner's instrument for the climbs. It
 * changes nothing in the review (FB3): it is never a disposition, never changes a lane or a unit's
 * closure and never ends a cycle; it is durable, so its note is held inline, not as a raw capture
 * (8.10). Its attribution is the target's own cycle, batch and units, so the unit and cycle
 * indexes find it. A correction is a new answer that supersedes the person's current one on the
 * same target (`causation.supersedes`), never an edit: the first answer is the one that supersedes
 * nothing, the final one the newest that nothing supersedes. The append transaction checks the
 * target, the attribution and that only a registered human records feedback and corrects only
 * their own.
 */
export const FeedbackRecorded = event(
  "feedback.recorded@1",
  FeedbackAnswer,
  Attribution.extend({
    cycleId: Ulid,
    batchId: Ulid.optional(),
    unitIds: UnitIds.optional(),
  }),
).extend({ refs: z.never().optional() });

/**
 * Version 2 of a person's feedback (10.107): the same event with the version 2 answer, the
 * reference rubric and the harness's grade the person saw. Desks record version 2; version 1
 * answers stay in the log and read with the rubric blank. The append transaction checks it as it
 * checks version 1.
 */
export const FeedbackRecordedV2 = event(
  "feedback.recorded@2",
  FeedbackAnswerV2,
  Attribution.extend({
    cycleId: Ulid,
    batchId: Ulid.optional(),
    unitIds: UnitIds.optional(),
  }),
).extend({ refs: z.never().optional() });

/**
 * A person cleared the Reviews page's default list ("Clear"), or undid it (`restore`). The
 * repository's latest one decides: after a clear, "Waiting on you" lists only the reviews run after
 * it, while what waits on a person still counts every review; after a restore, it lists what it
 * listed before. Nothing is deleted and All is unchanged. Older builds skip it (12.24).
 */
export const ReviewListCleared = event(
  "review-list.cleared@1",
  z.strictObject({ restore: z.literal(true).optional() }),
  z.strictObject({}),
).extend({ refs: z.never().optional() });

/**
 * How a git hook tied a change to who made it (D23). `ancestry`, `override` and `declared` name the
 * agent session, which is the event's actor. `declared` (8.13) is used only when the process table
 * could not be read: the session ID the harness sets in its shells named a live session here. It is
 * trusted less than ancestry, and `linkSource` names the variable it came from. `none` means the
 * process table was read and no recorded agent session owns the hook's ancestry, so the committer, a
 * human by git email, is the actor. For `unavailable` (the process table could not be read and no
 * declared session applied, as in agent sandboxes), `ambiguous` (several live sessions claim the
 * process) and `invalid-override` (a `NEUVE_SESSION` that names no supported harness or live
 * session), the actor is unknown and the event's actor is the reserved unresolved fingerprint.
 */
export const CommitLink = z.enum([
  "ancestry",
  "override",
  "declared",
  "none",
  "unavailable",
  "ambiguous",
  "invalid-override",
]);

/** The environment variable a declared link was read from, such as `CLAUDE_CODE_SESSION_ID`. */
export const LinkSource = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Expected an environment variable name");

/** A declared link names its source, and only a declared link has one. */
const linkSourceMatches = (payload: {
  readonly link: CommitLink;
  readonly linkSource?: string | undefined;
}) => (payload.link === "declared") === (payload.linkSource !== undefined);
const LINK_SOURCE_MESSAGE =
  "linkSource is required for a declared link and allowed only there";

/** A git identity as git recorded it; a fact about the commit, not an actor. Not validated as email. */
const GitIdentity = z.strictObject({
  name: z.string().max(256),
  email: z.string().max(320),
});

/**
 * A commit seen by the `post-commit` hook; enqueues its preparation job. `link` says who the actor is
 * (see `CommitLink`). This is how commits link to sessions in a repository without a trailer (8.1).
 */
export const CommitRecorded = event(
  "commit.recorded@1",
  z
    .strictObject({
      oid: GitOid,
      parents: z.array(GitOid).max(64),
      tree: GitOid,
      author: GitIdentity,
      committer: GitIdentity,
      link: CommitLink,
      linkSource: LinkSource.optional(),
    })
    .refine(linkSourceMatches, LINK_SOURCE_MESSAGE),
  Attribution.optional(),
);

/** The `post-rewrite` hook's old-to-new commit mapping after an amend or a rebase. */
export const CommitRewritten = event(
  "commit.rewritten@1",
  z
    .strictObject({
      rewrite: z.enum(["amend", "rebase"]),
      mappings: z
        .array(z.strictObject({ from: GitOid, to: GitOid }))
        .min(1)
        .max(1_024),
      committer: GitIdentity,
      link: CommitLink,
      linkSource: LinkSource.optional(),
    })
    .refine(linkSourceMatches, LINK_SOURCE_MESSAGE),
  Attribution.optional(),
);

const CaptureCounts = z.strictObject({
  records: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytes: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  calls: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  frames: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
/** New filings reserve headroom for the ceiling's checked arithmetic; stored rows keep their original contract. */
export const NewCaptureCounts = CaptureCounts.extend({
  records: z
    .int()
    .nonnegative()
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 12)),
  frames: z
    .int()
    .nonnegative()
    .max(Math.floor(Number.MAX_SAFE_INTEGER / 12)),
});
export const CaptureFiled = event(
  "capture.filed@1",
  z.strictObject({
    rawCapture: Sha256,
    runId: z.string().min(1).max(512),
    counts: CaptureCounts,
    sizes: z.strictObject({
      total: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      largest: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    checkpoint: z
      .strictObject({ version: z.literal(1), id: Sha256, nativeSha256: Sha256 })
      .nullable(),
  }),
  Attribution.optional(),
);
const CaptureOutcome = z.strictObject({
  rawCapture: Sha256,
  detectorVersion: z.literal("capture-scan-v1"),
  outcome: z.enum(["clean", "refused"]),
  record: Sha256,
  reason: z.string().max(4096).optional(),
});
export const CaptureSealed = event(
  "capture.sealed@1",
  CaptureOutcome,
  Attribution.optional(),
);
export const CaptureMarked = event(
  "capture.marked@1",
  CaptureOutcome,
  Attribution.optional(),
);

/** Every event kind Records accepts. Old versions stay in the union and are upcast on read. */
export const RecordEvent = z.discriminatedUnion("kind", [
  ActorRegistered,
  CaptureFiled,
  CaptureSealed,
  CaptureMarked,
  CycleOpened,
  CycleOpenedV2,
  CycleScopeSelected,
  CycleExternalContextSelected,
  CycleLocalScopeSelected,
  ReviewOriginRecorded,
  ReviewRequested,
  JudgementPreparationRequested,
  JudgementCounted,
  JudgementShadowChecked,
  BatchRecorded,
  UnitRecorded,
  UnitRecordedV2,
  UnitRecordedV3,
  ContextReferenced,
  ContextReferencedV2,
  AssessmentRecorded,
  AssessmentRecordedV2,
  AssessmentRecordedV3,
  AssessmentRecordedV4,
  DeliveryRecorded,
  DispositionRecorded,
  DispositionRecordedV2,
  DispositionRetracted,
  CommentRecorded,
  CommentRecordedV2,
  CommentRecordedV3,
  CommentCarried,
  DispositionCarried,
  LineageRecorded,
  PacketPublished,
  PacketPublishedV2,
  GapDisclosed,
  StageStarted,
  ModelCallsCountedV2,
  StageCompleted,
  RunCompleted,
  ProofRecorded,
  CommitRecorded,
  CommitRewritten,
  SessionStarted,
  SessionEnded,
  TurnStarted,
  TurnEnded,
  TurnSummarized,
  VentRecordedInline,
  VentRecorded,
  QueryRecorded,
  FeedbackRecorded,
  FeedbackRecordedV2,
  ReviewListCleared,
]);

/** An event as read back from the log: the producer's envelope plus the writer's order and time. */
export const StoredEvent = z.strictObject({
  seq: z.int().min(1),
  recordedAt: z.iso.datetime(),
  event: RecordEvent,
});

export type RecordEvent = z.infer<typeof RecordEvent>;
export type RecordEventKind = RecordEvent["kind"];
export type StoredEvent = z.infer<typeof StoredEvent>;
export type Lane = z.infer<typeof Lane>;
export type CommitLink = z.infer<typeof CommitLink>;
export type VentInput = z.infer<typeof VentInput>;
export type OwnedRange = z.infer<typeof OwnedRange>;
export type Citation = z.infer<typeof Citation>;
export type FindingKind = z.infer<typeof FindingKind>;
export type FindingKindV3 = z.infer<typeof FindingKindV3>;
export type ImpactEffect = z.infer<typeof ImpactEffect>;
export type UndecidedCause = z.infer<typeof UndecidedCause>;
export type UndecidedCounts = z.infer<typeof UndecidedCounts>;
export type FindingAbout = z.infer<typeof FindingAbout>;
export type FindingSignal = z.infer<typeof FindingSignal>;
export type FeedbackTarget = z.infer<typeof FeedbackTarget>;
export type FeedbackAnswer = z.infer<typeof FeedbackAnswer>;
export type FeedbackAnswerV2 = z.infer<typeof FeedbackAnswerV2>;
export type NoteLength = z.infer<typeof NoteLength>;
export type CheckpointState = z.infer<typeof CheckpointState>;
