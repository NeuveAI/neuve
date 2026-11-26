import {
  defineDoc,
  type JsonObject,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { canonicalJson } from "@neuve/records-core";

const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Execution bookkeeping only. Records owns retained reports and publication facts. */
export type ClaimAnchor = {
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
};
export type ClaimRegistration = {
  readonly assignment: string;
  readonly claim: {
    readonly key: string;
    readonly anchor: ClaimAnchor;
    /** The exact attributed report, not an inferred destination judgment. */
    readonly report: JsonObject;
    /** Exact source/evidence references the producer used, validated by its tool. */
    readonly basis: JsonObject;
  };
};
export type SettlementOwner = {
  readonly assignmentId: string;
  readonly sectionKey: string;
  readonly batchId: string;
};
export type SettlementSection = {
  readonly key: string;
  readonly path: string;
  readonly renamedFrom: string | null;
  readonly owned: Array<Omit<ClaimAnchor, "path">>;
};
export type SettlementAssignment = {
  readonly assignmentId: string;
  readonly batchId: string;
  readonly task: number;
  readonly sections: Array<SettlementSection>;
};
export type ClaimDestination =
  | ({ readonly status: "owned" } & SettlementOwner)
  | {
      readonly status: "unassigned";
      readonly reason: "unknown" | "ambiguous" | "unread";
      readonly sectionKeys: Array<string>;
    };
export type RegisteredClaim = ClaimRegistration["claim"] & {
  readonly id: string;
  readonly producer: { readonly assignment: string; readonly task: number };
  readonly source: JsonObject;
  readonly verificationTask: number | null;
  readonly destination: ClaimDestination;
  readonly timing:
    "incoming" | "later-review-information" | "unknown-ownership";
};
export type PublicationBasis = {
  readonly claims: Array<string>;
  /** Immutable selected publisher input. A close is not a Records publication receipt. */
  readonly input: JsonObject;
};
export type ClaimSettlement = {
  readonly source: JsonObject;
  readonly assignments: Array<SettlementAssignment>;
  readonly unread: Array<SettlementSection>;
  claims: { [id: string]: RegisteredClaim };
  closed: { [batchId: string]: PublicationBasis };
};
export const ClaimSettlementDoc = defineDoc<{
  reviews: { [review: string]: ClaimSettlement };
}>({
  kind: "neuve.claim-settlement",
  version: 1,
  scope: "session",
  initial: () => ({ reviews: {} }),
});

/** Initialize with authoritative prepared assignments, inside their creation commit. */
export const initializeClaimSettlement = async (
  tx: Tx,
  review: TaskId,
  input: Pick<ClaimSettlement, "source" | "assignments" | "unread"> & {
    /** From the existing Records publication chain, including earlier follow-on runs. */
    readonly frozenBatches?: ReadonlyArray<string>;
  },
) => {
  const doc = await tx.doc(ClaimSettlementDoc);
  const held = doc.reviews[String(review)];
  if (held !== undefined) {
    if (
      canonicalJson([held.source, held.assignments, held.unread]) !==
      canonicalJson([input.source, input.assignments, input.unread])
    )
      throw new Error("A review cannot replace its claim ownership map");
    return;
  }
  const tasks = new Set<number>();
  const sections = new Set<string>();
  for (const assignment of input.assignments) {
    if (tasks.has(assignment.task))
      throw new Error("A reviewer task has multiple assignments");
    tasks.add(assignment.task);
    for (const section of assignment.sections) {
      if (sections.has(section.key))
        throw new Error("A section has multiple primary owners");
      sections.add(section.key);
    }
  }
  doc.reviews[String(review)] = copyJson({
    source: input.source,
    assignments: input.assignments,
    unread: input.unread,
    claims: {},
    closed: Object.fromEntries(
      (input.frozenBatches ?? []).map((batch) => [
        batch,
        { claims: [], input: { frozenInRecords: true } },
      ]),
    ),
  });
};

const intersects = (section: SettlementSection, anchor: ClaimAnchor) =>
  (section.path === anchor.path ||
    (anchor.side === "old" && section.renamedFrom === anchor.path)) &&
  section.owned.some(
    (range) =>
      range.side === anchor.side &&
      range.startLine <= anchor.endLine &&
      anchor.startLine <= range.endLine,
  );

/** Only primary changed rows route an observation; nearby context never acquires ownership. */
export const claimDestination = (
  state: Pick<ClaimSettlement, "assignments" | "unread">,
  anchor: ClaimAnchor,
): ClaimDestination => {
  const owned = state.assignments.flatMap((assignment) =>
    assignment.sections
      .filter((section) => intersects(section, anchor))
      .map((section) => ({
        assignmentId: assignment.assignmentId,
        sectionKey: section.key,
        batchId: assignment.batchId,
      })),
  );
  const unread = state.unread.filter((section) => intersects(section, anchor));
  if (owned.length === 1 && unread.length === 0)
    return { status: "owned", ...owned[0]! };
  return {
    status: "unassigned",
    reason:
      owned.length + unread.length > 1
        ? "ambiguous"
        : unread.length > 0
          ? "unread"
          : "unknown",
    sectionKeys: [
      ...owned.map((entry) => entry.sectionKey),
      ...unread.map((entry) => entry.key),
    ],
  };
};

/** Pure transition, shared by native commits and race/replay contract tests. */
export const registerInSettlement = (
  state: ClaimSettlement,
  producerTask: number,
  registration: ClaimRegistration,
  verificationTask: number | null,
): RegisteredClaim => {
  const producer = state.assignments.find(
    (assignment) => assignment.task === producerTask,
  );
  if (
    producer === undefined ||
    producer.assignmentId !== registration.assignment
  )
    throw new Error("The recording task does not own the prepared assignment");
  const { anchor, key } = registration.claim;
  if (
    !/^[0-9a-f]{64}$/.test(key) ||
    !Number.isSafeInteger(anchor.startLine) ||
    !Number.isSafeInteger(anchor.endLine) ||
    anchor.startLine < 1 ||
    anchor.endLine < anchor.startLine
  )
    throw new Error("A claim needs a valid key and primary changed anchor");
  const id = `${producerTask}:${key}`;
  const held = state.claims[id];
  if (held !== undefined) {
    if (
      canonicalJson([
        held.key,
        held.anchor,
        held.report,
        held.basis,
        held.verificationTask,
      ]) !==
      canonicalJson([
        key,
        anchor,
        registration.claim.report,
        registration.claim.basis,
        verificationTask,
      ])
    )
      throw new Error("A recorded claim cannot change during replay");
    return held;
  }
  const destination = claimDestination(state, anchor);
  const claim: RegisteredClaim = copyJson({
    ...registration.claim,
    id,
    producer: { assignment: producer.assignmentId, task: producerTask },
    source: state.source,
    verificationTask,
    destination,
    timing:
      destination.status === "unassigned"
        ? "unknown-ownership"
        : state.closed[destination.batchId] === undefined
          ? "incoming"
          : "later-review-information",
  });
  state.claims[id] = claim;
  return claim;
};

/** Called in the SAME commit as the Verify child and recorded tool result. */
export const registerClaim = async (
  tx: Tx,
  review: TaskId,
  producerTask: number,
  registration: ClaimRegistration,
  verificationTask: number | null,
) => {
  const doc = await tx.doc(ClaimSettlementDoc);
  const state = doc.reviews[String(review)];
  if (state === undefined)
    throw new Error("Claim recording requires a prepared ownership map");
  return copyJson(
    registerInSettlement(state, producerTask, registration, verificationTask),
  );
};

export const batchClaims = (state: ClaimSettlement, batchId: string) =>
  Object.values(state.claims)
    .filter(
      (claim) =>
        claim.timing === "incoming" &&
        claim.destination.status === "owned" &&
        claim.destination.batchId === batchId,
    )
    .sort((a, b) => a.id.localeCompare(b.id));

export type CloseResult =
  | { readonly status: "closed"; readonly basis: PublicationBasis }
  | {
      readonly status: "changed";
      readonly claims: ReadonlyArray<RegisteredClaim>;
    }
  | { readonly status: "waiting"; readonly tasks: ReadonlyArray<number> };

/**
 * Serialized publication-basis selection. `observed` names claims included in the built input;
 * `terminal` contains only tasks actually observed terminal, never an assumed verification result.
 * A newly registered claim invalidates a stale build, even if its check already completed.
 */
export const closeInSettlement = (
  state: ClaimSettlement,
  batchId: string,
  observed: ReadonlyArray<string>,
  terminal: ReadonlySet<number>,
  input: JsonObject,
): CloseResult => {
  const closed = state.closed[batchId];
  if (closed !== undefined) return { status: "closed", basis: closed };
  const claims = batchClaims(state, batchId);
  const ids = claims.map((claim) => claim.id);
  if (canonicalJson([...observed].sort()) !== canonicalJson(ids.slice().sort()))
    return { status: "changed", claims };
  const tasks = [
    ...new Set(
      claims.flatMap((claim) =>
        claim.verificationTask === null || terminal.has(claim.verificationTask)
          ? []
          : [claim.verificationTask],
      ),
    ),
  ];
  if (tasks.length > 0) return { status: "waiting", tasks };
  const basis = copyJson({ claims: ids, input });
  state.closed[batchId] = basis;
  return { status: "closed", basis };
};
