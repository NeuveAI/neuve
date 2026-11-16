import { Checkpoints, Proofs } from "@neuve/records-core";
import type { CheckpointState, ProofKind } from "@neuve/records-schema";

/**
 * Proof state, set by code (11.16 to 11.21). An agent names which records a requirement rests on
 * and what kinds apply; it never sets a state or a coverage word. These functions are the only
 * writers of both, over the records the requirement names, their currency for the section's file
 * and the status of the pinned sources it rests on.
 */

/** A proof record as a requirement may name it: its kind and its currency for this section's file, in `Proofs.describeCurrency`'s words. */
export interface NamedProof {
  readonly kind: ProofKind;
  readonly currency: string | undefined;
}

/** What one requirement states about its proof, as the reading wrote it. */
export interface RequirementProof {
  readonly kinds: ReadonlyArray<ProofKind>;
  /** The proof record IDs it names. */
  readonly proof: ReadonlyArray<string>;
  readonly agree: boolean;
  readonly testable: boolean;
  /** Why no test can check it; empty when one can. */
  readonly untested: string;
}

/**
 * One requirement's proof state and coverage: the state from the shared rule
 * (`Checkpoints.proofState`), the coverage word from the state, a note in a few words for the run
 * log, and `proofNote`, the reader's sentence for the same state. A requirement that names no
 * record Records holds is Missing. It is excused from a test run only by an explicit "not
 * testable" with a stated reason.
 */
export const coverageOf = (
  requirement: RequirementProof,
  proofs: ReadonlyMap<string, NamedProof>,
  sources: ReadonlyArray<Checkpoints.SourceStatus> = [],
): {
  readonly coverage: "missing" | "shallow" | "solid";
  readonly note: string;
  readonly proofState: CheckpointState;
  readonly proofNote: string;
} => {
  const named = requirement.proof.flatMap((id) => {
    const proof = proofs.get(id);
    return proof === undefined ? [] : [proof];
  });
  const testable = requirement.testable || requirement.untested.trim() === "";
  const reason = Checkpoints.proofState({
    records: named.map((proof) => ({
      kind: proof.kind,
      currency: Proofs.currencyFromDescription(proof.currency),
    })),
    applicable: {
      // Where a test can check it, a test run is among the applicable kinds.
      kinds: [
        ...new Set([
          ...requirement.kinds,
          ...(testable ? ["test-run" as const] : []),
        ]),
      ],
      agree: requirement.agree,
      testable,
      untested: testable ? undefined : requirement.untested.trim(),
    },
    sources,
    named: requirement.proof.length > 0,
  });
  const stale = named.filter((proof) => proof.currency !== "current");
  const staleNote =
    stale.length === 0
      ? ""
      : `; ${stale.length} record(s) stale for this file (${[...new Set(stale.map((proof) => (proof.currency ?? "currency unknown").replace(/^stale: /, "")))].join("; ")})`;
  const sourceNote = sources.some((status) => status !== "current")
    ? `; a pinned source ${sources.includes("changed") ? "changed" : "could not be checked"}`
    : "";
  const note = (() => {
    switch (reason.state) {
      case "missing":
        return "no proof record serves it";
      case "out-of-date":
        return `out of date${staleNote}${sourceNote}`;
      case "conflicting":
        return `the records disagree (${reason.kinds.join(", ")})`;
      case "proven":
        return `current ${reason.kinds.join(" + ")} agree${reason.untested === undefined ? "" : "; no test applies"}`;
      case "thin":
        return reason.why === "no-test-run"
          ? "no current test run, though a test can check it"
          : reason.why === "one-kind"
            ? `one kind alone (${reason.kinds[0]})${reason.absent.length > 0 ? `; applicable ${reason.absent.join(", ")} not recorded` : ""}`
            : `applicable ${reason.absent.join(", ")} not recorded`;
    }
  })();
  return {
    coverage: Checkpoints.coverageOfState(reason.state),
    note,
    proofState: reason.state,
    proofNote: Checkpoints.stateNote(reason),
  };
};

/** A proof record as a row's check reads it: its kind, what its recorder says it serves, and its currency for the file. */
export interface RowProof extends NamedProof {
  readonly id: string;
  readonly requirement: string;
}

/** A done-when row a file is judged on, and the requirements tied to it with the records they name. */
export interface RowBasis {
  readonly row: string;
  readonly text: string;
  readonly requirements: ReadonlyArray<{
    readonly requirement: string;
    readonly kinds: ReadonlyArray<string>;
    readonly proof: ReadonlyArray<string>;
  }>;
}

const plain = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Whether a proof record serves a row: one of the row's requirements names it, or its recorder
 * named the row or one of its requirements as what it serves. Two current records that serve
 * something else never make a row met.
 */
export const servesRow = (
  proof: Pick<RowProof, "id" | "requirement">,
  row: RowBasis | undefined,
) => {
  if (row === undefined) return false;
  if (row.requirements.some((r) => r.proof.includes(proof.id))) return true;
  const served = plain(proof.requirement);
  return [row.text, ...row.requirements.map((r) => r.requirement)].some(
    (text) => plain(text) === served,
  );
};

/**
 * Why a row cannot read `met` on the proof records it cites, or undefined when it can: two or more
 * kinds of proof in records current for this file, every one serving the row, covering every kind
 * its requirements name, and no stale record among them. A code reading or a test's existence never
 * makes a row met. The words go back to the reading in a repair turn.
 */
export const metProblem = (
  criterion: { readonly row: string; readonly cites: ReadonlyArray<string> },
  row: RowBasis | undefined,
  proofs: ReadonlyMap<string, RowProof>,
): string | undefined => {
  const cited = criterion.cites.flatMap((id) => {
    const proof = proofs.get(id);
    return proof === undefined ? [] : [proof];
  });
  const current = cited.filter((proof) => proof.currency === "current");
  const kinds = [...new Set(current.map((proof) => proof.kind as string))];
  const stale = cited.filter((proof) => proof.currency !== "current");
  const elsewhere = cited.filter((proof) => !servesRow(proof, row));
  if (elsewhere.length > 0)
    return `${criterion.row} cites ${elsewhere.map((p) => p.id).join(", ")}, which serve${elsewhere.length === 1 ? "s" : ""} another requirement (${elsewhere.map((p) => `"${p.requirement.slice(0, 80)}"`).join("; ")}); a row is met only on proof that serves it. The records that serve ${criterion.row} are ${[...new Set(row?.requirements.flatMap((r) => r.proof))].join(", ") || "none"}`;
  if (stale.length > 0)
    return `${criterion.row} cites ${stale.map((p) => p.id).join(", ")}, not current for this file (${stale.map((p) => p.currency ?? "unknown").join("; ")}); stale proof leaves a row at no-evidence`;
  if (kinds.length < 2)
    return `${criterion.row} is met only on two or more kinds of proof, current for this file, that agree; it cites ${kinds.length === 0 ? "none" : `only ${kinds[0]}`}. Mark it no-evidence, or not-met if the change fails it`;
  const applicable = [...new Set(row?.requirements.flatMap((r) => r.kinds))];
  const absent = applicable.filter((kind) => !kinds.includes(kind));
  if (absent.length > 0)
    return `${criterion.row}'s requirements name ${absent.join(", ")} proof, which it does not cite current; mark it no-evidence unless that kind is recorded`;
  return undefined;
};
