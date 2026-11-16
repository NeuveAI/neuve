// Why: the feedback target lists name the new unit and comment versions, and two files this lane
// does not edit read them (the person's command and the append rule). Feedback on a
// `unit.recorded@3` and on a `comment.recorded@3` must be accepted through both, with the
// target's own attribution.
import { afterAll, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { HumanCommands, Log } from "../src/index.ts";
import { newShapeReview } from "./review-fixtures.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

test("feedback on a version 3 unit and on a version 3 comment is accepted with the target's attribution", async () => {
  const location = freshLocation();
  const fixture = newShapeReview();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append(fixture.all);
      const person = { email: "owner@example.com" };
      const unit = yield* HumanCommands.recordFeedback({
        person,
        answer: {
          on: "unit",
          target: fixture.events.units.large.id,
          harnessCallVisible: true,
          lane: "human-required",
        },
      });
      const finding = yield* HumanCommands.recordFeedback({
        person,
        answer: {
          on: "finding",
          target: fixture.events.impact.id,
          harnessCallVisible: true,
          judged: "valid",
        },
      });
      return {
        unit: yield* Log.get(unit.feedbackId),
        finding: yield* Log.get(finding.feedbackId),
      };
    }),
  );
  expect(Option.getOrUndefined(read.unit)?.event).toMatchObject({
    kind: "feedback.recorded@2",
    attribution: {
      cycleId: fixture.cycleId,
      batchId: fixture.batches[0],
      unitIds: [fixture.units.large],
    },
    payload: { on: "unit", target: fixture.events.units.large.id },
  });
  expect(Option.getOrUndefined(read.finding)?.event).toMatchObject({
    attribution: { cycleId: fixture.cycleId, unitIds: [fixture.units.large] },
    payload: { on: "finding", target: fixture.events.impact.id },
  });
});
