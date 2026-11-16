// Why (NEU-148): the review task's checkpoints name stage keys of the new shape (a manifest without
// leads), since version 5 the readings' plan task, which version 4's `find+fill` phase did the
// work of, and since version 6 the publish phase's batches and their waiters; so a review stored
// mid-run by an earlier version must restart from Precompute and never resume into a phase whose
// checkpoint it does not have.
import { expect, test } from "bun:test";
import {
  REVIEW_TASK_VERSION,
  reviewTask,
  type ReviewStagesPort,
} from "../../src/pi/review-task.ts";

const unused = async (): Promise<never> => {
  throw new Error("not called by this test");
};
const port: ReviewStagesPort = {
  front: unused,
  finder: unused,
  precompute: unused,
  fill: unused,
  link: unused,
  publish: unused,
};

test("a review stored by the earlier version restarts from Precompute", () => {
  const { definition } = reviewTask(port);
  expect(definition.version).toBe(REVIEW_TASK_VERSION);
  expect(REVIEW_TASK_VERSION).toBe(6);
  const input = {
    range: {
      baseRef: "main",
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
    },
    cutoffAt: 1,
  };
  // A version-5 checkpoint in the link phase, with its finders and its readings' plan task, and
  // none of the batches and waiters a version-6 link checkpoint may name.
  const previous = definition.migrate!(
    input,
    {
      phase: "link",
      stages: [],
      sources: {},
      frameKey: "f",
      mapKey: "m",
      manifestKey: "k",
      finders: [{ lens: "correctness", task: 7 }],
      plan: 8,
      fill: null,
    },
    5,
  );
  expect(previous.checkpoint).toEqual(definition.initial(previous.input));
  expect(previous.input).toEqual(input as never);
  // A version-2 checkpoint in the link phase, with its finders.
  const migrated = definition.migrate!(
    input,
    {
      phase: "link",
      stages: [],
      sources: {},
      frameKey: "f",
      mapKey: "m",
      manifestKey: "k",
      finders: [{ lens: "correctness", task: 7 }],
      fill: null,
    },
    2,
  );
  expect(migrated.checkpoint).toEqual(definition.initial(migrated.input));
  expect(migrated.input).toEqual(input as never);
});

// Why: a version-4 review stored in `find+fill` would resume into a phase that no longer plans, and
// would never get the readings it was to prepare there; it restarts from Precompute instead.
test("a review stored by version 4 in find+fill restarts from Precompute", () => {
  const { definition } = reviewTask(port);
  const input = {
    range: {
      baseRef: "main",
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
    },
    cutoffAt: 1,
  };
  const migrated = definition.migrate!(
    input,
    {
      phase: "find+fill",
      stages: [],
      sources: {},
      frameKey: "f",
      mapKey: "m",
      manifestKey: "k",
      finders: [{ lens: "correctness", task: 9 }],
    },
    4,
  );
  expect(migrated.checkpoint).toEqual({ phase: "precompute" });
  expect(migrated.input).toEqual(input as never);
});
