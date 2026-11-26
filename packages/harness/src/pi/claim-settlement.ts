import {
  defineDoc,
  type JsonObject,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { canonicalJson, sha256Hex } from "@neuve/records-core";

const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

import type { ClaimAnchor, ClaimRegistration } from "../toolkit.ts";
export type { ClaimAnchor, ClaimRegistration } from "../toolkit.ts";

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
  readonly task: number | null;
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
  /** A retained specific check from an earlier native host, never a new independent vote. */
  readonly retainedVerification?: {
    readonly task: number | null;
    readonly key: string | null;
    readonly outcome: "confirmed" | "refuted" | "unconfirmed";
  };
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
    if (assignment.task !== null && tasks.has(assignment.task))
      throw new Error("A reviewer task has multiple assignments");
    if (assignment.task !== null) tasks.add(assignment.task);
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

/** Exact retained report/basis reuse only; never anchor or semantic grouping. */
export const registeredClaim = (
  state: ClaimSettlement,
  registration: ClaimRegistration,
) =>
  Object.values(state.claims).find(
    (held) =>
      held.producer.assignment === registration.assignment &&
      held.key === registration.claim.key &&
      canonicalJson([held.report, held.basis]) ===
        canonicalJson([registration.claim.report, registration.claim.basis]),
  );

export const findRegisteredClaim = async (
  tx: Tx,
  review: TaskId,
  registration: ClaimRegistration,
) => {
  const state = (await tx.doc(ClaimSettlementDoc)).reviews[String(review)];
  const held =
    state === undefined ? undefined : registeredClaim(state, registration);
  return held === undefined ? undefined : copyJson(held);
};

/** Restore only after the caller validates permanent source/basis and creates a current check. */
export const restoreClaim = async (
  tx: Tx,
  review: TaskId,
  original: RegisteredClaim,
) => {
  const state = (await tx.doc(ClaimSettlementDoc)).reviews[String(review)];
  if (state === undefined)
    throw new Error("Restore requires settled assignment ownership");
  const destination = claimDestination(state, original.anchor);
  const claim: RegisteredClaim = copyJson({
    ...original,
    destination,
    timing:
      destination.status === "unassigned"
        ? "unknown-ownership"
        : state.closed[destination.batchId] === undefined
          ? "incoming"
          : "later-review-information",
  });
  const held = state.claims[claim.id];
  if (held !== undefined && canonicalJson(held) !== canonicalJson(claim))
    throw new Error("Restored claim changed on native replay");
  state.claims[claim.id] = claim;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Current transport ownership never manufactures missing historical reviewer attribution. */
const originalAttribution = (
  state: ClaimSettlement,
  registration: ClaimRegistration,
  task: number,
) => {
  if (registration.claim.report["observation"] === undefined)
    return { task, source: state.source }; // A new native DTO, not a retained comprehensive answer.
  const origin = object(registration.claim.basis["origin"]);
  const producer = object(registration.claim.basis["producer"]);
  const source = object(registration.claim.basis["source"]);
  if (
    origin === undefined ||
    !Number.isSafeInteger(origin["assignmentTask"]) ||
    !Number.isSafeInteger(origin["reviewTask"]) ||
    Number(origin["assignmentTask"]) < 0 ||
    Number(origin["reviewTask"]) < 0 ||
    producer === undefined ||
    source === undefined
  )
    throw new Error(
      "Retained comprehensive report has no trustworthy original reviewer origin",
    );
  const text = (key: string) => {
    const value = producer[key];
    if (typeof value !== "string" || value === "")
      throw new Error("Original reviewer attribution is missing");
    return value;
  };
  const runId = text("run"),
    runKey = text("review"),
    cycle = text("cycle"),
    head = text("head");
  if (state.source["runKey"] !== undefined && state.source["runKey"] !== runKey)
    throw new Error(
      "Retained reviewer configuration differs from the current keyed work",
    );
  for (const [prepared, retained] of [
    ["plan", "plan"],
    ["manifestKey", "manifest"],
    ["frameKey", "frame"],
    ["mapKey", "map"],
  ] as const)
    if (
      state.source[prepared] !== undefined &&
      state.source[prepared] !== source[retained]
    )
      throw new Error(
        "Retained claim source differs from the current immutable assignment",
      );
  if (
    state.source["head"] !== undefined &&
    state.source["head"] !== producer["head"]
  )
    throw new Error(
      "Retained claim head differs from the current reviewed source",
    );
  return {
    task: Number(origin["assignmentTask"]),
    source: copyJson({
      ...state.source,
      runId,
      runKey,
      cycle,
      head,
      origin: {
        reviewTask: Number(origin["reviewTask"]),
        assignmentTask: Number(origin["assignmentTask"]),
      },
    }),
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
  const prior = registeredClaim(state, registration);
  if (prior !== undefined) {
    if (
      prior.verificationTask === null &&
      prior.retainedVerification !== undefined &&
      verificationTask !== null
    ) {
      const linked = copyJson({ ...prior, verificationTask });
      state.claims[prior.id] = linked;
      return linked;
    }
    if (prior.verificationTask !== verificationTask)
      throw new Error(
        "A recorded claim cannot change verification task during replay",
      );
    return prior;
  }
  const { anchor, key } = registration.claim;
  if (
    !/^[0-9a-f]{64}$/.test(key) ||
    !Number.isSafeInteger(anchor.startLine) ||
    !Number.isSafeInteger(anchor.endLine) ||
    anchor.startLine < 1 ||
    anchor.endLine < anchor.startLine
  )
    throw new Error("A claim needs a valid key and primary changed anchor");
  const original = originalAttribution(state, registration, producerTask);
  const id =
    registration.claim.report["observation"] === undefined
      ? `${producerTask}:${key}`
      : `report:${sha256Hex(canonicalJson([producer.assignmentId, registration.claim.report, registration.claim.basis]))}`;
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
    producer: { assignment: producer.assignmentId, task: original.task },
    source: original.source,
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

/** Exact registered observation and its specific check, never a sibling verdict. */
export type RoutedClaim = {
  readonly claim: RegisteredClaim;
  readonly verification: {
    readonly key: string | null;
    readonly reached: boolean;
  };
  readonly information?: string;
};
