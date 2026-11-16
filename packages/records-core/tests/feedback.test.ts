// Why (M5 S5): feedback is the owner's instrument for the climbs, and three things must hold for
// its answers to be worth reading back. Decoding: the desk writes and the climbs read answers on the
// sheet's scales through one schema, so a shape the sheet never had (a unit's scale on a finding, an
// in-between grade beside itself, an empty answer, no record of whether the harness's call was
// visible) must be refused, and a stored answer must decode back. Never a disposition: feedback
// that appended as a disposition, or superseded one, would let feedback close or reopen a unit,
// which 10.100 rules out (it changes nothing in the review). Supersession: a correction is a new
// answer, never an edit, so the read must give the first answer and the latest one, in any append
// order, and refuse a correction that forks the chain or corrects another person's answer.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  FeedbackAnswer,
  FeedbackAnswerV2,
  RecordEvent,
} from "@neuve/records-schema";
import {
  Admin,
  Dispositions,
  Feedback,
  HumanCommands,
  Identity,
  Log,
  mintUlid,
} from "../src/index.ts";
import { reviewEvents } from "./review-fixtures.ts";
import {
  agent,
  envelope,
  freshLocation,
  human,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const owner = { email: "owner@example.com", displayName: "Owner" };
const ownerId = Identity.humanFingerprint(owner.email);

const judged = (unitId: string) =>
  Effect.map(Dispositions.judge(unitId), (j) => ({
    lane: j.lane,
    needs: j.needs,
    closed: j.closed,
    closing: j.closing.map((d) => [d.eventId, d.verdict]),
    standing: j.standing === null ? null : j.standing.eventId,
  }));

const reviewState = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return {
    units: yield* sql`SELECT * FROM projection_units ORDER BY unit_id`,
    dispositions:
      yield* sql`SELECT * FROM projection_dispositions ORDER BY event_id`,
    current: yield* Dispositions.current({}),
  };
});

const kindsAppended = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    kind: string;
  }>`SELECT kind FROM events ORDER BY seq`;
  return rows.map((row) => row.kind);
});

test("feedback answers decode on the sheet's scales and nothing else", async () => {
  const target = mintUlid();
  const accepted = [
    {
      on: "unit",
      target,
      harnessCallVisible: true,
      complexity: "low",
      easeOfValidation: "hard",
      lane: "human-suggested",
      verdict: "approve",
    },
    { on: "finding", target, harnessCallVisible: false, judged: "unsure" },
    {
      on: "reference",
      target,
      harnessCallVisible: true,
      grade: "useful",
      between: "necessary",
      note: "Between useful and necessary,\nleaning useful.",
    },
    {
      on: "digest",
      target,
      harnessCallVisible: true,
      accurate: "no",
      complete: "no",
      misleadingClaim: "some",
      neutralBeforeVerdict: "no",
    },
    { on: "unit", target, harnessCallVisible: true, note: "A note alone." },
  ];
  const refused = {
    "a unit's scale on a finding": {
      on: "finding",
      target,
      harnessCallVisible: true,
      lane: "agentic",
    },
    "a grade the sheet never had": {
      on: "finding",
      target,
      harnessCallVisible: true,
      judged: "maybe",
    },
    "an in-between grade beside itself": {
      on: "reference",
      target,
      harnessCallVisible: true,
      grade: "useful",
      between: "useful",
    },
    "an in-between grade alone": {
      on: "reference",
      target,
      harnessCallVisible: true,
      between: "useful",
    },
    "nothing answered": { on: "digest", target, harnessCallVisible: true },
    "no record of the harness's call": {
      on: "finding",
      target,
      judged: "valid",
    },
    "a target that is not an event ID": {
      on: "finding",
      target: "unit-1",
      harnessCallVisible: true,
      judged: "valid",
    },
    "a lane outside the matrix": {
      on: "unit",
      target,
      harnessCallVisible: true,
      lane: "human-only",
    },
  };
  for (const answer of accepted)
    expect(FeedbackAnswer.safeParse(answer).success).toBe(true);
  const refusedNames = Object.entries(refused)
    .filter(([, answer]) => FeedbackAnswer.safeParse(answer).success)
    .map(([name]) => name);
  expect(refusedNames).toEqual([]);

  // The event: feedback carries no references (its note is inline and durable), and its kind is
  // its own, so a disposition kind never decodes a feedback payload.
  const event = envelope(
    "feedback.recorded@1",
    "feedback:decode",
    human,
    { cycleId: mintUlid() },
    accepted[1],
  );
  expect(RecordEvent.safeParse(event).success).toBe(true);
  expect(
    RecordEvent.safeParse({
      ...event,
      refs: [{ ref: `blob:${"0".repeat(64)}`, role: "note" }],
    }).success,
  ).toBe(false);
  expect(
    RecordEvent.safeParse({ ...event, kind: "disposition.recorded@2" }).success,
  ).toBe(false);

  // A stored answer reads back as it was recorded.
  const location = freshLocation();
  const fixture = reviewEvents();
  await runOn(location, Log.append(fixture.all));
  const finding = fixture.comments.defect.id;
  const recorded = await runOn(
    location,
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "finding",
        target: finding,
        harnessCallVisible: true,
        judged: "valid",
        note: "The mock hides the retry.",
      },
    }),
  );
  const stored = await runOn(location, Log.get(recorded.feedbackId));
  expect(stored._tag === "Some" && stored.value.event).toMatchObject({
    kind: "feedback.recorded@2",
    actor: ownerId,
    attribution: {
      cycleId: fixture.cycleId,
      unitIds: [fixture.units[1]],
    },
    payload: {
      on: "finding",
      target: finding,
      harnessCallVisible: true,
      judged: "valid",
      note: "The mock hides the retry.",
    },
  });
});

test("finding feedback on a carried comment succeeds and reads back", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  const fresh = RecordEvent.parse(fixture.comments.defect);
  if (fresh.kind !== "comment.recorded@2")
    throw new Error("fixture must contain a fresh comment");
  const carried = RecordEvent.parse({
    ...fresh,
    id: mintUlid(),
    kind: "comment.carried@1",
    idempotencyKey: "carried-finding-feedback",
    payload: {
      ...fresh.payload,
      lineage: "carried",
      from: {
        review: "earlier-review",
        cycle: mintUlid(),
        head: "a".repeat(40),
        judgement: "b".repeat(64),
        output: "c".repeat(64),
        savedMs: 100,
      },
    },
  });
  await runOn(location, Log.append([...fixture.all, carried]));
  const recorded = await runOn(
    location,
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "finding",
        target: carried.id,
        harnessCallVisible: true,
        judged: "valid",
      },
    }),
  );
  const stored = await runOn(location, Log.get(recorded.feedbackId));
  expect(stored._tag === "Some" && stored.value.event).toMatchObject({
    kind: "feedback.recorded@2",
    payload: { on: "finding", target: carried.id, judged: "valid" },
  });
});

test("feedback never appends as a disposition and never moves a lane, a closure or a disposition", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  const [, u2, u3] = fixture.units;
  await runOn(location, Log.append(fixture.all));
  const before = await runOn(
    location,
    Effect.all([judged(u2), judged(u3), reviewState]),
  );
  const kindsBefore = await runOn(location, kindsAppended);

  // The owner's call on a human-required unit says approve and agentic, and on the human-suggested
  // unit the opposite of the agent's request: neither is a disposition.
  const unitEvent = (unitId: string) =>
    fixture.structure.find(
      (e) =>
        e.kind === "unit.recorded@2" &&
        (e.attribution as { unitIds: Array<string> }).unitIds[0] === unitId,
    )!.id;
  await runOn(
    location,
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "unit",
        target: unitEvent(u3),
        harnessCallVisible: true,
        complexity: "low",
        easeOfValidation: "easy",
        lane: "agentic",
        verdict: "approve",
      },
    }),
  );
  await runOn(
    location,
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "unit",
        target: unitEvent(u2),
        harnessCallVisible: true,
        verdict: "approve",
      },
    }),
  );
  const after = await runOn(
    location,
    Effect.all([judged(u2), judged(u3), reviewState]),
  );
  const kindsAfter = await runOn(location, kindsAppended);

  // Feedback cannot supersede a disposition (which would retract it) or a packet (which would set
  // it aside), cannot be recorded by an agent, and cannot sit on a target of another kind.
  const answer = (target: string) => ({
    on: "unit",
    target,
    harnessCallVisible: true,
    lane: "agentic",
  });
  const unitOn = (unitId: string) => ({
    cycleId: fixture.cycleId,
    batchId: fixture.batchId,
    unitIds: [unitId],
  });
  const refusals = await runOn(
    location,
    Effect.all([
      Effect.flip(
        Log.append([
          envelope(
            "feedback.recorded@1",
            "feedback:retracts",
            ownerId,
            unitOn(u2),
            answer(unitEvent(u2)),
            { supersedes: fixture.dispositions.cited.id },
          ),
        ]),
      ),
      Effect.flip(
        Log.append([
          envelope(
            "feedback.recorded@1",
            "feedback:sets-aside",
            ownerId,
            unitOn(u2),
            answer(unitEvent(u2)),
            { supersedes: fixture.packet.id },
          ),
        ]),
      ),
      Effect.flip(
        Log.append([
          envelope("feedback.recorded@2", "feedback:agent", agent, unitOn(u3), {
            ...answer(unitEvent(u3)),
          }),
        ]),
      ),
      Effect.flip(
        HumanCommands.recordFeedback({
          person: owner,
          answer: {
            on: "unit",
            target: fixture.dispositions.cited.id,
            harnessCallVisible: true,
            verdict: "approve",
          },
        }),
      ),
      Effect.flip(
        Log.append([
          envelope(
            "feedback.recorded@1",
            "feedback:wrong-unit",
            ownerId,
            unitOn(u2),
            answer(unitEvent(u3)),
          ),
        ]),
      ),
    ]),
  );
  const final = await runOn(
    location,
    Effect.all([judged(u2), judged(u3), reviewState]),
  );

  expect(after).toEqual(before);
  expect(final).toEqual(before);
  expect(before[1]).toMatchObject({
    lane: "human-required",
    needs: "a-human-disposition",
    closed: false,
  });
  expect(before[0]).toMatchObject({
    closed: true,
    standing: fixture.dispositions.cited.id,
  });
  // Each command appended one feedback event and nothing else; the person was registered once.
  expect(kindsAfter.slice(kindsBefore.length)).toEqual([
    "actor.registered@1",
    "feedback.recorded@2",
    "feedback.recorded@2",
  ]);
  expect(
    refusals.map((r) => [
      r._tag,
      r._tag === "HumanCommandRefused"
        ? r.reason
        : r._tag === "WorkflowRuleViolation"
          ? r.rule
          : undefined,
    ]),
  ).toEqual([
    ["WorkflowRuleViolation", "feedback-supersedes-other"],
    ["WorkflowRuleViolation", "feedback-supersedes-other"],
    ["WorkflowRuleViolation", "feedback-not-human"],
    ["HumanCommandRefused", "unknown-feedback-target"],
    ["WorkflowRuleViolation", "feedback-attribution-mismatch"],
  ]);
});

test("a correction supersedes the person's current answer, and the read gives the first and the latest", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  await runOn(location, Log.append(fixture.all));
  const reference = fixture.structure.find(
    (e) => e.kind === "context.referenced@2",
  )!;
  const digest = fixture.delivery[0]!;
  const grade = (
    grade: "necessary" | "useful" | "irrelevant",
    note: string,
    between?: "necessary" | "useful",
  ) =>
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "reference",
        target: reference.id,
        harnessCallVisible: false,
        grade,
        ...(between === undefined ? {} : { between }),
        note,
      },
    });
  const first = await runOn(location, grade("irrelevant", "Off topic."));
  const second = await runOn(
    location,
    grade("useful", "On reflection, useful.", "necessary"),
  );
  const third = await runOn(location, grade("necessary", "It is necessary."));
  // Another person's answer on the same target is their own chain.
  const other = await runOn(
    location,
    HumanCommands.recordFeedback({
      person: { email: "second@example.com" },
      answer: {
        on: "reference",
        target: reference.id,
        harnessCallVisible: true,
        grade: "irrelevant",
      },
    }),
  );
  await runOn(
    location,
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "digest",
        target: digest.id,
        harnessCallVisible: true,
        accurate: "yes",
        complete: "no",
        note: "Needs wider context.",
      },
    }),
  );

  // A correction must name the person's current answer: a second first answer, a correction of a
  // superseded answer, and a correction of another person's answer would each fork the chain.
  const refused = (key: string, causation?: { supersedes: string }) =>
    Effect.flip(
      Log.append([
        envelope(
          "feedback.recorded@1",
          key,
          ownerId,
          reference.attribution as Record<string, unknown>,
          {
            on: "reference",
            target: reference.id,
            harnessCallVisible: true,
            grade: "useful",
          },
          causation,
        ),
      ]),
    );
  const forks = await runOn(
    location,
    Effect.all([
      refused("feedback:second-first"),
      refused("feedback:stale", { supersedes: first.feedbackId }),
      refused("feedback:other", { supersedes: other.feedbackId }),
    ]),
  );

  const read = await runOn(location, Feedback.answers({ actorId: ownerId }));
  const exported = await runOn(
    location,
    Feedback.sheetAnswers({
      actorId: ownerId,
      cycleId: fixture.cycleId,
      readAt: "2026-10-22T12:00:00.000Z",
    }),
  );
  // Any append order projects the same rows: a rebuild replays the log and reads the same.
  const rebuilt = await runOn(location, Admin.rebuild);
  const reread = await runOn(location, Feedback.answers({ actorId: ownerId }));

  expect(second.replaced).toBe(first.feedbackId);
  expect(third.replaced).toBe(second.feedbackId);
  expect(other.replaced).toBeUndefined();
  expect(forks.map((f) => ("rule" in f ? f.rule : f._tag))).toEqual([
    "feedback-not-superseding",
    "feedback-supersedes-other",
    "feedback-supersedes-other",
  ]);
  expect(
    read.map((t) => [t.on, t.target, t.first.eventId, t.final?.eventId]),
  ).toEqual([
    ["reference", reference.id, first.feedbackId, third.feedbackId],
    ["digest", digest.id, expect.any(String), undefined],
  ]);
  expect(exported).toMatchObject({
    method: "desk",
    decideThenReveal: false,
    answered: 2,
    answers: {
      [`reference:${reference.id}`]: {
        kind: "margin-card",
        first: "irrelevant",
        firstBetween: null,
        note: "Off topic.",
        harnessCallVisible: false,
        final: "necessary",
        finalBetween: null,
        finalNote: "It is necessary.",
        finalHarnessCallVisible: false,
      },
      [`digest:${digest.id}`]: {
        kind: "batch-digest",
        content: "batch-digest",
        rubric: {
          accurate: "yes",
          complete: "no",
          misleadingClaim: null,
          neutralBeforeVerdict: null,
          note: "Needs wider context.",
        },
        harnessCallVisible: true,
      },
    },
  });
  expect(rebuilt.beforeCombined).toBe(rebuilt.afterCombined);
  expect(reread).toEqual(read);
});

// Why (10.107): feedback on a context reference gains the note's rubric and the harness's grade as
// a second version of the answer. Version 1's answer is strict, so an older reader would refuse new
// fields: the rubric must live only in version 2, and version 1 answers must still decode and
// export, with every rubric row blank. The climbs count the rubric's rows, so an unanswered row
// must export as null and never as yes; the harness's grade is what the card showed, never an
// answer of its own, and is recorded only when it was visible. And like every feedback answer, a
// rubric changes nothing in the review.
test("version 2 carries the reference rubric and the harness's grade; version 1 still decodes", () => {
  const target = mintUlid();
  const rubric = {
    on: "reference",
    target,
    harnessCallVisible: true,
    harnessGrade: "necessary",
    grade: "useful",
    between: "necessary",
    saysWhy: "yes",
    tiedToLines: "no",
    checkActionable: "yes",
    accurate: "yes",
    length: "too-long",
  };
  const accepted = {
    "the full rubric": rubric,
    "a rubric row alone": {
      on: "reference",
      target,
      harnessCallVisible: false,
      tiedToLines: "no",
    },
    "a version 1 answer": {
      on: "reference",
      target,
      harnessCallVisible: true,
      grade: "irrelevant",
    },
    "another target's answer, as in version 1": {
      on: "digest",
      target,
      harnessCallVisible: true,
      accurate: "yes",
    },
  };
  const refused = {
    "the harness's grade alone, which is not an answer": {
      on: "reference",
      target,
      harnessCallVisible: true,
      harnessGrade: "useful",
    },
    "the harness's grade when it was not visible": {
      on: "reference",
      target,
      harnessCallVisible: false,
      harnessGrade: "useful",
      grade: "useful",
    },
    "a length outside the rubric": {
      on: "reference",
      target,
      harnessCallVisible: false,
      length: "fine",
    },
    "a rubric row on a finding": {
      on: "finding",
      target,
      harnessCallVisible: true,
      saysWhy: "yes",
    },
    "an in-between grade beside itself": {
      ...rubric,
      between: "useful",
    },
  };
  const wronglyRefused = Object.entries(accepted)
    .filter(([, answer]) => !FeedbackAnswerV2.safeParse(answer).success)
    .map(([name]) => name);
  const wronglyAccepted = Object.entries(refused)
    .filter(([, answer]) => FeedbackAnswerV2.safeParse(answer).success)
    .map(([name]) => name);
  expect(wronglyRefused).toEqual([]);
  expect(wronglyAccepted).toEqual([]);
  // Version 1 stays as it was: it refuses the rubric, so the rubric is only ever version 2.
  expect(FeedbackAnswer.safeParse(rubric).success).toBe(false);
  // Both event versions decode from the log; each version takes its own answer.
  const attribution = { cycleId: mintUlid() };
  const v1 = envelope(
    "feedback.recorded@1",
    "feedback:v1",
    human,
    attribution,
    {
      on: "reference",
      target,
      harnessCallVisible: false,
      grade: "useful",
    },
  );
  expect(RecordEvent.safeParse(v1).success).toBe(true);
  expect(
    RecordEvent.safeParse(
      envelope(
        "feedback.recorded@2",
        "feedback:v2",
        human,
        attribution,
        rubric,
      ),
    ).success,
  ).toBe(true);
  expect(
    RecordEvent.safeParse(
      envelope(
        "feedback.recorded@1",
        "feedback:v1-rubric",
        human,
        attribution,
        rubric,
      ),
    ).success,
  ).toBe(false);
});

test("the export puts the rubric and the harness's grade beside the owner's grade; blank rows stay null", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  const [, u2, u3] = fixture.units;
  await runOn(location, Log.append(fixture.all));
  const before = await runOn(
    location,
    Effect.all([judged(u2), judged(u3), reviewState]),
  );
  const kindsBefore = await runOn(location, kindsAppended);
  const current = fixture.structure.find(
    (e) => e.kind === "context.referenced@2",
  )!;
  const older = fixture.structure.find(
    (e) => e.kind === "context.referenced@1",
  )!;

  // A desk answer: the grade, three of the five rows, and the harness's grade it showed. The
  // reference has no check, so its row is never asked and stays blank.
  const first = await runOn(
    location,
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "reference",
        target: current.id,
        harnessCallVisible: true,
        harnessGrade: "necessary",
        grade: "useful",
        between: "necessary",
        saysWhy: "yes",
        tiedToLines: "no",
        length: "too-long",
      },
    }),
  );
  // A correction answers one more row and changes the grade.
  const corrected = await runOn(
    location,
    HumanCommands.recordFeedback({
      person: owner,
      answer: {
        on: "reference",
        target: current.id,
        harnessCallVisible: true,
        harnessGrade: "necessary",
        grade: "necessary",
        saysWhy: "yes",
        tiedToLines: "no",
        accurate: "no",
        length: "right",
        note: "The stance is wrong.",
      },
    }),
  );
  // An answer the desk recorded before the rubric, as version 1.
  await runOn(
    location,
    Log.append([
      envelope(
        "feedback.recorded@1",
        "feedback:before-the-rubric",
        ownerId,
        older.attribution as Record<string, unknown>,
        {
          on: "reference",
          target: older.id,
          harnessCallVisible: true,
          grade: "irrelevant",
        },
      ),
    ]),
  );
  const stored = await runOn(location, Log.get(first.feedbackId));
  const exported = await runOn(
    location,
    Feedback.sheetAnswers({
      actorId: ownerId,
      cycleId: fixture.cycleId,
      readAt: "2026-10-23T12:00:00.000Z",
    }),
  );
  const after = await runOn(
    location,
    Effect.all([judged(u2), judged(u3), reviewState]),
  );
  const kindsAfter = await runOn(location, kindsAppended);

  expect(corrected.replaced).toBe(first.feedbackId);
  expect(stored._tag === "Some" && stored.value.event.kind).toBe(
    "feedback.recorded@2",
  );
  const answers = exported.answers as Record<string, Record<string, unknown>>;
  expect(answers[`reference:${current.id}`]).toEqual({
    kind: "margin-card",
    referenceId: current.id,
    cycleId: fixture.cycleId,
    unitIds: [u2],
    first: "useful",
    firstBetween: "necessary",
    firstRubric: {
      saysWhy: "yes",
      tiedToLines: "no",
      checkActionable: null,
      accurate: null,
      length: "too-long",
    },
    harnessGrade: "necessary",
    firstAt: expect.any(String),
    note: null,
    harnessCallVisible: true,
    final: "necessary",
    finalBetween: null,
    finalRubric: {
      saysWhy: "yes",
      tiedToLines: "no",
      checkActionable: null,
      accurate: "no",
      length: "right",
    },
    finalAt: expect.any(String),
    finalNote: "The stance is wrong.",
    finalHarnessCallVisible: true,
  });
  // The older answer reads with the rubric blank, and no harness's grade was recorded with it.
  expect(answers[`reference:${older.id}`]).toMatchObject({
    first: "irrelevant",
    firstRubric: {
      saysWhy: null,
      tiedToLines: null,
      checkActionable: null,
      accurate: null,
      length: null,
    },
    harnessGrade: null,
    harnessCallVisible: true,
  });
  // No row anywhere in the export reads yes unless the person answered yes.
  const yeses = JSON.stringify(exported).match(/"yes"/g) ?? [];
  expect(yeses.length).toBe(2);
  // Nothing in the review moved, and only feedback was appended.
  expect(after).toEqual(before);
  expect(kindsAfter.slice(kindsBefore.length)).toEqual([
    "actor.registered@1",
    "feedback.recorded@2",
    "feedback.recorded@2",
    "feedback.recorded@1",
  ]);
});
