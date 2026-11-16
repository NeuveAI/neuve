import { Effect, Option } from "effect";
import type {
  AssessedSection,
  CheckpointState,
  Citation,
  ProofKind,
  RecordEvent,
} from "@neuve/records-schema";
import { get } from "./log.ts";
import {
  currencyChecker,
  type Currency,
  type ProofGitFailed,
  type ProofRefused,
} from "./proofs.ts";

/**
 * Checkpoints (vocabulary: Checkpoint; 10.110, 11.16–11.18): each validation requirement as the
 * reviewer sees it, with its proof state. The state is set here, by code, from the proof records it
 * rests on and their currency for its unit, never by an agent; the harness's Assemble sets the
 * state it assesses lanes on with `proofState`, and the read model sets the state a reader sees with
 * the same rule when a packet is read, so currency is decided at each read and never stored (11.10).
 */

type Of<K extends RecordEvent["kind"]> = Extract<RecordEvent, { kind: K }>;

/** Why a state is what it is, for the words a reader or an agent is given. */
export type StateReason =
  | {
      readonly state: "missing";
      /** Whether the requirement names any proof record at all (11.21's untied items name none). */
      readonly named: boolean;
    }
  | {
      readonly state: "out-of-date";
      /** What is not current: a record (with its currency), or a pinned source. */
      readonly records: ReadonlyArray<RecordCurrency>;
      readonly sources: ReadonlyArray<SourceStatus>;
    }
  | { readonly state: "conflicting"; readonly kinds: ReadonlyArray<ProofKind> }
  | {
      readonly state: "proven";
      readonly kinds: ReadonlyArray<ProofKind>;
      /** Why no test applies, when the agent said none can check the behaviour (11.20). */
      readonly untested?: string | undefined;
    }
  | {
      readonly state: "thin";
      readonly why:
        "one-kind" | "kind-not-recorded" | "no-test-run" | "assessed";
      readonly kinds: ReadonlyArray<ProofKind>;
      /** Applicable kinds no record holds. */
      readonly absent: ReadonlyArray<ProofKind>;
    };

/** A record's currency for a unit, or `unchecked` when it could not be decided at this read. */
export type RecordCurrency = Currency | { readonly status: "unchecked" };

/** A pinned source's status as the run that published the packet found it (11.18). */
export type SourceStatus = "current" | "changed" | "unchecked" | "unknown";

export interface StateInput {
  /** The records the requirement names that Records holds, each with its currency for the unit. */
  readonly records: ReadonlyArray<{
    readonly kind: ProofKind;
    readonly currency: RecordCurrency;
  }>;
  /**
   * The applicable kinds the agent named (10.58) and whether the records agree; undefined for an
   * assessment recorded before checkpoints, whose coverage then stands in for them.
   */
  readonly applicable:
    | {
        readonly kinds: ReadonlyArray<ProofKind>;
        readonly agree: boolean;
        /**
         * Whether a test can check the behaviour (11.20); when it can't, `untested` is the agent's
         * reason, when it is known.
         */
        readonly testable: boolean;
        readonly untested?: string | undefined;
      }
    | { readonly assessedSolid: boolean };
  /** The pinned external sources it rests on (11.17). */
  readonly sources: ReadonlyArray<SourceStatus>;
  /** Whether the requirement names any record, held or not; true when not given. */
  readonly named?: boolean | undefined;
}

/**
 * The rule of 11.16, 11.19 and 11.20, in its order: Missing when no record it names is in Records;
 * Out of date when any record it rests on is not current for the unit, or a pinned source it rests
 * on changed or could not be checked (a refresh comes before any judgement of what the records say);
 * Conflicting when the records disagree; Proven when two or more kinds rest on it, every applicable
 * kind is recorded and, wherever a test can check the behaviour, a current test run is among them;
 * Thin otherwise. Missing, Out of date and Conflicting are unmet. An assessment recorded before
 * checkpoints (no kinds, agreement or testability) has its assessed coverage stand in for them.
 */
export const proofState = (input: StateInput): StateReason => {
  if (input.records.length === 0)
    return { state: "missing", named: input.named ?? true };
  const staleRecords = input.records
    .map((record) => record.currency)
    .filter((currency) => currency.status !== "current");
  const staleSources = input.sources.filter((status) => status !== "current");
  if (staleRecords.length > 0 || staleSources.length > 0)
    return {
      state: "out-of-date",
      records: staleRecords,
      sources: staleSources,
    };
  const kinds = [...new Set(input.records.map((record) => record.kind))];
  if (!("kinds" in input.applicable))
    return input.applicable.assessedSolid
      ? { state: "proven", kinds }
      : { state: "thin", why: "assessed", kinds, absent: [] };
  if (!input.applicable.agree) return { state: "conflicting", kinds };
  const absent = input.applicable.kinds.filter((kind) => !kinds.includes(kind));
  const tested = !input.applicable.testable || kinds.includes("test-run");
  if (kinds.length >= 2 && absent.length === 0 && tested)
    return input.applicable.testable
      ? { state: "proven", kinds }
      : { state: "proven", kinds, untested: input.applicable.untested };
  return {
    state: "thin",
    why:
      kinds.length === 1
        ? "one-kind"
        : absent.length > 0
          ? "kind-not-recorded"
          : "no-test-run",
    kinds,
    absent,
  };
};

/** Whether a state leaves its checkpoint unmet (11.19): Missing, Out of date or Conflicting. */
export const isUnmet = (state: CheckpointState) =>
  state === "missing" || state === "out-of-date" || state === "conflicting";

/** The coverage word an assessment records beside the state (10.58): Proven is solid coverage, Thin, Out of date and Conflicting are shallow. */
export const coverageOfState = (state: CheckpointState) =>
  state === "proven" ? "solid" : state === "missing" ? "missing" : "shallow";

const KIND_WORDS: Readonly<Record<ProofKind, string>> = {
  "static-analysis": "a static check",
  "test-run": "a test run",
  telemetry: "telemetry",
  log: "logs",
  screenshot: "a screenshot",
  video: "a video",
};

const listed = (words: ReadonlyArray<string>) =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** Why a record is not current, in a reader's words. */
const recordWords = (currency: RecordCurrency) => {
  if (currency.status === "current") return undefined;
  if (currency.status === "unchecked")
    return "whether a proof record it rests on is still current couldn't be checked";
  switch (currency.reason) {
    case "not-in-history":
      return "a proof record it rests on was taken on a commit that is no longer in the branch's history (rebased, amended or force-pushed away)";
    case "changed-after":
      return "the files it covers changed after a proof record it rests on was taken";
    case "unknown-revision":
      return "a proof record it rests on was taken on a commit this repository doesn't have";
  }
};

const SOURCE_WORDS: Readonly<Record<SourceStatus, string | undefined>> = {
  current: undefined,
  changed: "the ticket it rests on changed after it was read",
  unchecked: "the ticket it rests on couldn't be checked again",
  unknown: "the ticket it rests on couldn't be found in the review's record",
};

/**
 * What a state rests on, in plain words for the reader (the plain-text rule: no codes, IDs or
 * handles). Out of date names every reason, so the reader sees what a refresh needs.
 */
export const stateNote = (reason: StateReason) => {
  switch (reason.state) {
    case "missing":
      return reason.named
        ? "No proof record it names is in Records."
        : "Nothing names what proves it.";
    case "out-of-date": {
      const why = [
        ...new Set([
          ...reason.records.flatMap((c) => recordWords(c) ?? []),
          ...reason.sources.flatMap((s) => SOURCE_WORDS[s] ?? []),
        ]),
      ];
      return `Out of date: ${listed(why)}.`;
    }
    case "conflicting":
      return `Its records disagree: ${listed(reason.kinds.map((k) => KIND_WORDS[k]))}.`;
    case "proven":
      return `Its kinds of proof agree and are current: ${listed(reason.kinds.map((k) => KIND_WORDS[k]))}.${reason.untested === undefined ? "" : ` No test can check it: ${reason.untested.trim().replace(/\.$/, "")}.`}`;
    case "thin":
      switch (reason.why) {
        case "no-test-run":
          return "No current test run is recorded, and a test can check it.";
        case "one-kind":
          return `One kind of proof alone: ${KIND_WORDS[reason.kinds[0]!]}${reason.absent.length === 0 ? "" : `; not recorded: ${listed(reason.absent.map((k) => KIND_WORDS[k]))}`}.`;
        case "kind-not-recorded":
          return `Not recorded: ${listed(reason.absent.map((k) => KIND_WORDS[k]))}.`;
        case "assessed":
          return "Its proof doesn't cover every applicable kind in agreement.";
      }
  }
};

// ---------------------------------------------------------------------------------------------
// At read time: a published unit's checkpoints (the read model)
// ---------------------------------------------------------------------------------------------

/** An owned line range a checkpoint is anchored on, as the desk places its marker. */
export interface AnchorLines {
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

/** A pinned source a checkpoint rests on, as the assembled batch holds it (11.17). */
export interface PinView {
  readonly source: string;
  readonly provider: string;
  readonly item: string;
  readonly title: string;
  readonly version: string | null;
  readonly readAt: string;
  readonly status: SourceStatus;
  readonly checkedAt: string | null;
}

/**
 * One checkpoint as a reader sees it. The fields the desk's `Checkpoint` names (`number`,
 * `requirement`, `proof`, `note`) keep its names, so the projection maps them directly.
 */
export interface Checkpoint {
  /** Its place among the unit's checkpoints, from 1. */
  readonly number: number;
  /** The requirement as the harness wrote it. */
  readonly requirement: string;
  /** Its proof state at this read (11.16). */
  readonly proof: CheckpointState;
  /** What the state rests on, in plain words. */
  readonly note: string;
  /** The applicable kinds the agent named; undefined for an assessment recorded before checkpoints. */
  readonly kinds: ReadonlyArray<ProofKind> | undefined;
  /** Every record it names, whether Records holds it, and its currency for the unit at this read. */
  readonly records: ReadonlyArray<{
    readonly eventId: string;
    readonly kind: ProofKind | undefined;
    readonly held: boolean;
    readonly currency: RecordCurrency | undefined;
  }>;
  /**
   * The owned lines that meet it (11.17). Empty when it reaches no owned line: it is anchored to
   * its unit as a whole and shows in the briefing only. Null when its assessment was recorded
   * before anchors were.
   */
  readonly anchors: ReadonlyArray<AnchorLines> | null;
  /** The pinned external sources it rests on, with their status (11.18). */
  readonly sources: ReadonlyArray<PinView>;
  readonly cites: ReadonlyArray<Citation>;
}

/** Whole-unit and line anchors from a version 3 requirement's indices into the unit's owned ranges. */
const anchorsOf = (
  indices: ReadonlyArray<number>,
  recorded: Of<"unit.recorded@2"> | undefined,
): ReadonlyArray<AnchorLines> =>
  indices.flatMap((index) => {
    const range = recorded?.payload.ownedRanges[index];
    return range === undefined || range.kind !== "lines"
      ? []
      : [
          {
            path: range.path,
            side: range.side,
            startLine: range.startLine,
            endLine: range.endLine,
          },
        ];
  });

/** A unit's owned paths on either side, for the currency check (11.10). */
const ownedPathsOf = (recorded: Of<"unit.recorded@2"> | undefined) => [
  ...new Set((recorded?.payload.ownedRanges ?? []).map((range) => range.path)),
];

/** One requirement as the shared rule below reads it, from whichever assessment version holds it. */
interface RequirementInput {
  readonly requirement: string;
  readonly proof: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<string>;
  readonly applicable: StateInput["applicable"];
  readonly kinds: ReadonlyArray<ProofKind> | undefined;
  readonly anchors: ReadonlyArray<AnchorLines> | null;
}

type Checker =
  | ((
      revision: string,
      ownedPaths: ReadonlyArray<string>,
    ) => Effect.Effect<Currency, ProofGitFailed | ProofRefused>)
  | undefined;

/**
 * The checkpoints of a unit's requirements, their states set now, and each named record's
 * currency: the one rule both assessment shapes go through.
 */
const checkpointsOf = (
  requirements: ReadonlyArray<RequirementInput>,
  ownedPaths: ReadonlyArray<string>,
  pinList: ReadonlyArray<PinView>,
  check: Checker,
) =>
  Effect.gen(function* () {
    const currencyOf = new Map<
      string,
      {
        kind: ProofKind | undefined;
        held: boolean;
        currency: RecordCurrency | undefined;
      }
    >();
    for (const id of new Set(requirements.flatMap((r) => r.proof))) {
      const held = yield* get(id);
      if (Option.isNone(held) || held.value.event.kind !== "proof.recorded@1") {
        currencyOf.set(id, {
          kind: undefined,
          held: false,
          currency: undefined,
        });
        continue;
      }
      const proof = held.value.event;
      const currency: RecordCurrency =
        check === undefined || ownedPaths.length === 0
          ? { status: "unchecked" }
          : yield* check(proof.payload.revision, ownedPaths).pipe(
              Effect.orElseSucceed((): RecordCurrency => ({
                status: "unchecked",
              })),
            );
      currencyOf.set(id, { kind: proof.payload.kind, held: true, currency });
    }
    const pins = new Map(pinList.map((pin) => [pin.source, pin]));
    const checkpoints = requirements.map(
      (r, index): Omit<Checkpoint, "cites"> => {
        const records = r.proof.map((eventId) => ({
          eventId,
          ...currencyOf.get(eventId)!,
        }));
        const sources = r.sources.map(
          (source): PinView =>
            pins.get(source) ?? {
              source,
              provider: "",
              item: "",
              title: "",
              version: null,
              readAt: "",
              status: "unknown",
              checkedAt: null,
            },
        );
        const reason = proofState({
          records: records.flatMap((record) =>
            record.held
              ? [{ kind: record.kind!, currency: record.currency! }]
              : [],
          ),
          applicable: r.applicable,
          sources: sources.map((pin) => pin.status),
          named: r.proof.length > 0,
        });
        return {
          number: index + 1,
          requirement: r.requirement,
          proof: reason.state,
          note: stateNote(reason),
          kinds: r.kinds,
          records,
          anchors: r.anchors,
          sources,
        };
      },
    );
    return {
      checkpoints,
      proofCurrency: Object.fromEntries(
        [...currencyOf].flatMap(([id, held]) =>
          held.currency === undefined ? [] : [[id, held.currency]],
        ),
      ) as Readonly<Record<string, RecordCurrency>>,
    };
  });

/**
 * A published unit's checkpoints, their states set now: each named record's currency is checked
 * against the packet's head with git when `repository` is given, else it is unchecked, which
 * reads Out of date (a currency that could not be decided is never taken as current). Pins come
 * from the assembled batch the packet names. Also returns each named record's currency, so the
 * desk can show which record is out of date.
 */
export const unitCheckpoints = (options: {
  readonly assessment:
    Of<"assessment.recorded@2"> | Of<"assessment.recorded@3"> | undefined;
  readonly recorded: Of<"unit.recorded@2"> | undefined;
  readonly pins: ReadonlyArray<PinView>;
  /**
   * Each requirement's reason why no test can check it, by its place, from the assembled batch
   * (11.20); the event carries only whether a test can.
   */
  readonly untested?: ReadonlyArray<string | undefined> | undefined;
  readonly check: Checker;
}) =>
  Effect.gen(function* () {
    const requirements =
      (options.assessment?.payload.easeOfValidation.requirements as
        | ReadonlyArray<
            Of<"assessment.recorded@3">["payload"]["easeOfValidation"]["requirements"][number]
          >
        | undefined) ?? [];
    const { checkpoints, proofCurrency } = yield* checkpointsOf(
      requirements.map((r, index): RequirementInput => {
        const v3 = r.kinds !== undefined;
        return {
          requirement: r.requirement,
          proof: r.proof,
          sources: r.sources ?? [],
          applicable: v3
            ? {
                kinds: r.kinds,
                agree: r.agree,
                testable: r.testable,
                untested: options.untested?.[index],
              }
            : { assessedSolid: r.coverage === "solid" },
          kinds: v3 ? r.kinds : undefined,
          anchors: v3 ? anchorsOf(r.anchors, options.recorded) : null,
        };
      }),
      ownedPathsOf(options.recorded),
      options.pins,
      options.check,
    );
    return {
      checkpoints: checkpoints.map((checkpoint, index): Checkpoint => ({
        ...checkpoint,
        cites: requirements[index]!.cites,
      })),
      proofCurrency,
    };
  });

/**
 * A checkpoint of an `assessment.recorded@4` unit: one distinct requirement of its sections'
 * judgements, anchored by the union of the lines its sections in the unit tie it to. Its
 * citations are the local IDs the judgement holds.
 */
export interface SectionCheckpoint extends Omit<Checkpoint, "cites"> {
  /**
   * The key of the section that places it: the unit's first, in section order, that ties it to
   * lines, or, for a requirement no section ties to a line, the packet's first section holding it
   * in the order units are listed in.
   */
  readonly section: string;
  readonly cites: ReadonlyArray<string>;
}

type JudgedRequirement = NonNullable<
  AssessedSection["assess"]
>["easeOfValidation"]["requirements"][number];

/** A section as the placement reads it: its judgement entry and its owned ranges, for line order. */
export interface PlacedSection {
  readonly entry: AssessedSection;
  readonly ownedRanges: ReadonlyArray<{
    readonly path: string;
    readonly side: string;
    readonly startLine?: number;
  }>;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const asSet = (values: ReadonlyArray<string>) => [...new Set(values)].sort();

/**
 * What identifies a requirement among a batch's sections: its text trimmed, with each run of
 * whitespace made one space, and lower-cased, and its cites, kinds and proof, each as a set.
 * Anchors are not part of it: every section of a class holds the class's requirements, each tied
 * to its own lines.
 */
export const requirementIdentity = (r: {
  readonly requirement: string;
  readonly cites: ReadonlyArray<string>;
  readonly kinds: ReadonlyArray<string>;
  readonly proof: ReadonlyArray<string>;
}) =>
  JSON.stringify([
    r.requirement.trim().replace(/\s+/g, " ").toLowerCase(),
    asSet(r.cites),
    asSet(r.kinds),
    asSet(r.proof),
  ]);

/** A section's place in the order units are listed in: its path, then its first new-side line. */
const lineOrder = (section: PlacedSection) => {
  const first = section.ownedRanges
    .filter((range) => range.side === "new" && range.startLine !== undefined)
    .sort((a, b) => compare(a.path, b.path) || a.startLine! - b.startLine!)[0];
  return {
    path: first?.path ?? section.ownedRanges[0]?.path ?? "",
    line: first?.startLine ?? Number.POSITIVE_INFINITY,
  };
};

const byLines = (a: AnchorLines, b: AnchorLines) =>
  a.startLine - b.startLine ||
  a.endLine - b.endLine ||
  compare(a.path, b.path) ||
  compare(a.side, b.side);

/**
 * Where each distinct requirement of a packet's version 4 units lands, one list per unit (the
 * coordinator's ruling of 13 November): once on each unit where some section ties it to lines,
 * anchored by the union of those sections' lines in that unit, in line order, under the unit's
 * first section in section order that ties it. A unit whose sections hold it on no line gets none
 * of it. A requirement no section of the packet ties to a line is kept once, with no anchors (its
 * unit as a whole), on the unit holding the packet's first section that holds it, in the order
 * units are listed in (path, then the new side's start line; a tie keeps the earlier). The whole
 * packet is read at once, since an Assess class can span batches: reading groups follow
 * directories, not Map groups. A unit's requirements keep the order of their first appearance in
 * its sections. Copies of one requirement are folded strictest first: it agrees only when every
 * copy agrees, is testable when any copy is, and its reason no test applies is the first copy's
 * that gives one; the placing section's copy gives the rest.
 */
export const placeRequirements = (
  units: ReadonlyArray<ReadonlyArray<PlacedSection>>,
) => {
  const occurrences = units.map((sections) =>
    sections.flatMap((section, at) =>
      (section.entry.assess?.easeOfValidation.requirements ?? []).map(
        (requirement) => ({
          id: requirementIdentity(requirement),
          section,
          at,
          requirement,
        }),
      ),
    ),
  );
  const tied = new Set<string>();
  const folded = new Map<
    string,
    { agree: boolean; testable: boolean; untested: string | undefined }
  >();
  for (const o of occurrences.flat()) {
    if (o.requirement.anchors.length > 0) tied.add(o.id);
    const was = folded.get(o.id);
    folded.set(o.id, {
      agree: (was?.agree ?? true) && o.requirement.agree,
      testable: (was?.testable ?? false) || o.requirement.testable,
      untested: was?.untested || o.requirement.untested || undefined,
    });
  }
  const home = new Map<
    string,
    { unit: number; at: number; path: string; line: number }
  >();
  occurrences.forEach((held, unit) => {
    for (const o of held) {
      if (tied.has(o.id)) continue;
      const here = { unit, at: o.at, ...lineOrder(o.section) };
      const best = home.get(o.id);
      const order =
        best === undefined
          ? -1
          : compare(here.path, best.path) || here.line - best.line;
      if (order < 0) home.set(o.id, here);
    }
  });
  const withFold = (id: string, requirement: JudgedRequirement) => {
    const fold = folded.get(id)!;
    return {
      ...requirement,
      agree: fold.agree,
      testable: fold.testable,
      ...(fold.untested === undefined ? {} : { untested: fold.untested }),
    };
  };
  return occurrences.map((held, unit) =>
    [...new Set(held.map((o) => o.id))].flatMap((id) => {
      const mine = held.filter((o) => o.id === id);
      if (!tied.has(id)) {
        const at = home.get(id)!;
        if (at.unit !== unit) return [];
        const first = mine.find((o) => o.at === at.at)!;
        return [
          {
            section: first.section.entry.key,
            requirement: withFold(id, first.requirement),
            anchors: [] as ReadonlyArray<AnchorLines>,
          },
        ];
      }
      const placing = mine.filter((o) => o.requirement.anchors.length > 0);
      if (placing.length === 0) return [];
      const anchors = new Map<string, AnchorLines>();
      for (const o of placing)
        for (const anchor of o.requirement.anchors) {
          const lines: AnchorLines = {
            path: anchor.path,
            side: anchor.side,
            startLine: anchor.startLine,
            endLine: anchor.endLine,
          };
          anchors.set(JSON.stringify(lines), lines);
        }
      return [
        {
          section: placing[0]!.section.entry.key,
          requirement: withFold(id, placing[0]!.requirement),
          anchors: [...anchors.values()].sort(byLines),
        },
      ];
    }),
  );
};

/**
 * The checkpoints of a packet's `assessment.recorded@4` units, one result per unit in the order
 * given: each distinct requirement where `placeRequirements` puts it, its state set now by the
 * same rule as `unitCheckpoints`, from the records named, their currency for the unit and its
 * batch's pins. A section no agent assessed contributes none. A requirement's `untested` is the
 * reason no test can check it, as the assembled batch gives it for earlier versions. A unit's
 * `ownedPaths` are its own, from its sections blob; none leaves every record's currency unchecked.
 */
export const sectionCheckpoints = (options: {
  readonly units: ReadonlyArray<{
    readonly sections: ReadonlyArray<PlacedSection>;
    readonly ownedPaths: ReadonlyArray<string>;
    /** The pins of the unit's batch. */
    readonly pins: ReadonlyArray<PinView>;
  }>;
  readonly check: Checker;
}) => {
  const placed = placeRequirements(options.units.map((unit) => unit.sections));
  return Effect.forEach(options.units, (unit, index) =>
    Effect.gen(function* () {
      const requirements = placed[index]!;
      const { checkpoints, proofCurrency } = yield* checkpointsOf(
        requirements.map(({ requirement: r, anchors }): RequirementInput => ({
          requirement: r.requirement,
          proof: r.proof,
          sources: r.sources,
          applicable: {
            kinds: r.kinds,
            agree: r.agree,
            testable: r.testable,
            untested: r.untested || undefined,
          },
          kinds: r.kinds,
          anchors,
        })),
        [...new Set(unit.ownedPaths)],
        unit.pins,
        options.check,
      );
      return {
        checkpoints: checkpoints.map((checkpoint, at): SectionCheckpoint => ({
          ...checkpoint,
          section: requirements[at]!.section,
          cites: requirements[at]!.requirement.cites,
        })),
        proofCurrency,
      };
    }),
  );
};

/** A currency checker for a packet's head, or none when no repository is given. */
export const checkerFor = (repository: string | undefined, headOid: string) =>
  repository === undefined
    ? undefined
    : currencyChecker({ repository, headOid });
