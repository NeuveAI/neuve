import { z } from "zod";
import { ActorId, GitOid, Ulid } from "./envelope.ts";
import { Sha256 } from "./computations.ts";

/**
 * Proof records (11.3, 11.8; proposal §12, slice H4b): observed proof that a change works, kept in
 * Records so the harness and the inner-loop reviewer judge a range against it. Verification is
 * convergence (11.1): one record is one kind of proof, and a requirement is solid only when every
 * applicable kind agrees. `static-analysis` is the output of an analyser the repository declares,
 * such as a type checker or linter.
 */
export const ProofKind = z.enum([
  "static-analysis",
  "test-run",
  "telemetry",
  "log",
  "screenshot",
  "video",
]);

/** Media types each kind's artefact may have: images, video, or text output. */
export const PROOF_MEDIA_TYPES = {
  screenshot: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/webm", "video/mp4"],
  "static-analysis": [
    "text/plain; charset=utf-8",
    "application/json",
    "application/x-ndjson",
  ],
  "test-run": [
    "text/plain; charset=utf-8",
    "application/json",
    "application/x-ndjson",
  ],
  telemetry: [
    "text/plain; charset=utf-8",
    "application/json",
    "application/x-ndjson",
  ],
  log: [
    "text/plain; charset=utf-8",
    "application/json",
    "application/x-ndjson",
  ],
} as const satisfies Record<z.infer<typeof ProofKind>, ReadonlyArray<string>>;

/** Whether a media type is allowed for a kind. */
export const mediaTypeFits = (kind: ProofKind, mediaType: string) =>
  (PROOF_MEDIA_TYPES[kind] as ReadonlyArray<string>).includes(mediaType);

/** Largest artefact a proof record stores (64 MiB): a short screen recording fits. */
export const PROOF_ARTEFACT_MAX_BYTES = 64 * 1_048_576;

/**
 * Text whose canonical JSON takes at most 3 bytes per character: no control character but tab and
 * newline, so a cap on characters bounds the bytes an event can take.
 */
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(
      /^[^\u0000-\u0008\u000b-\u001f\u007f]*$/,
      "Expected no control characters but tab and newline",
    )
    .regex(/\S/, "Expected some text");

/** Longest claim, in characters: one or two sentences of what the artefact shows. */
export const PROOF_CLAIM_MAX = 500;
export const ProofClaim = boundedText(PROOF_CLAIM_MAX);

/**
 * The validation requirement a record serves (vocabulary: Validation requirement). When the cycle's
 * scope snapshot names it, `scopeItem` is that obligation's or definition-of-done item's identifier;
 * otherwise the recorder's own words, which Assemble matches to a unit's requirements.
 */
export const ProofRequirement = z.strictObject({
  text: boundedText(300),
  scopeItem: z
    .string()
    .regex(
      /^[\x21-\x7e]{1,128}$/,
      "Expected at most 128 printable ASCII characters",
    )
    .optional(),
});

/** The artefact as the record states it; its hash is the record's single `artefact` ref. */
export const ProofArtefact = z.strictObject({
  mediaType: z.string().min(1).max(128),
  bytes: z.int().min(1).max(PROOF_ARTEFACT_MAX_BYTES),
});

/**
 * The recorder's working tree when the proof was recorded: the commit checked out (`head`), and
 * whether tracked files had uncommitted changes, among the unit's owned paths when the recorder
 * named them, else anywhere in the tracked tree. A dirty tree, or a head other than the revision,
 * means the artefact may have observed code no commit holds; readers weigh it (10.63, 11.10).
 */
export const ProofWorktree = z.strictObject({
  head: GitOid,
  scope: z.enum(["owned-paths", "tracked-tree"]),
  dirty: z.boolean(),
});

/** The payload of `proof.recorded@1`. The revision is the commit the artefact observed. */
export const ProofPayload = z
  .strictObject({
    kind: ProofKind,
    revision: GitOid,
    claim: ProofClaim,
    requirement: ProofRequirement,
    artefact: ProofArtefact,
    worktree: ProofWorktree,
  })
  .refine(
    (p) => mediaTypeFits(p.kind, p.artefact.mediaType),
    "the artefact's media type does not fit the proof kind",
  );

/** A revision as a person or agent names it: an OID, a branch, `HEAD~2`; resolved by git. */
const Revision = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[^\s-][^\s]*$/,
    "Expected a revision with no spaces or leading dash",
  );

/**
 * What `neuve proof record` and the MCP `record_proof` tool take. Exactly one of `file` (a file the
 * agent saved, such as a Chrome DevTools MCP screenshot) or `text` (output to keep as text) gives
 * the artefact.
 */
export const ProofInput = z
  .strictObject({
    kind: ProofKind.describe(
      "static-analysis (a declared analyser's output, such as the type checker), test-run, telemetry, log, screenshot or video.",
    ),
    range: z
      .string()
      .min(3)
      .max(520)
      .regex(/^[^\s-][^\s]*\.\.[^\s]+$/, "Expected <base>..<head>")
      .describe("The commit range you are working on, as <base>..<head>."),
    revision: Revision.optional().describe(
      "The commit the artefact observed. Defaults to the range's head; it must be in the head's history.",
    ),
    claim: ProofClaim.describe(
      "What the artefact shows, in one or two plain sentences.",
    ),
    requirement: boundedText(300).describe(
      "The validation requirement this proof serves, in your words or as the scope names it.",
    ),
    scopeItem: ProofRequirement.shape.scopeItem.describe(
      "The scope's identifier for that requirement, when the scope gives one.",
    ),
    file: z
      .string()
      .min(1)
      .max(4_096)
      .optional()
      .describe(
        "Absolute path of the artefact you saved (a screenshot, video, log or test output), inside the repository's working tree (not git-ignored, not under .git) or a temp folder.",
      ),
    text: z
      .string()
      .min(1)
      .max(1_048_576)
      .optional()
      .describe(
        "The artefact as text, instead of a file (logs and outputs only).",
      ),
    mediaType: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "The artefact's media type, when its file extension does not say it.",
      ),
    ownedPaths: z
      .array(z.string().min(1).max(4_096))
      .min(1)
      .max(1_024)
      .optional()
      .describe(
        "The repository paths the proven unit owns, so the record says whether they had uncommitted changes. Without them the whole tracked tree is checked.",
      ),
  })
  .refine(
    (input) => (input.file === undefined) !== (input.text === undefined),
    "Give exactly one of file or text",
  );

/** One row of `projection_proofs`: a proof record's facts, without its claim or requirement text. */
export const ProofView = z.strictObject({
  eventId: Ulid,
  kind: ProofKind,
  revision: GitOid,
  baseOid: GitOid,
  headOid: GitOid,
  cycleId: Ulid.nullable(),
  actorId: ActorId,
  sessionId: z.string(),
  artefactHash: Sha256,
  mediaType: z.string(),
  bytes: z.int().min(1),
  scopeItem: z.string().nullable(),
  worktreeHead: GitOid,
  worktreeScope: ProofWorktree.shape.scope,
  worktreeDirty: z.union([z.literal(0), z.literal(1)]),
});

export type ProofKind = z.infer<typeof ProofKind>;
export type ProofInput = z.infer<typeof ProofInput>;
export type ProofPayload = z.infer<typeof ProofPayload>;
export type ProofRequirement = z.infer<typeof ProofRequirement>;
export type ProofWorktree = z.infer<typeof ProofWorktree>;
export type ProofView = z.infer<typeof ProofView>;
