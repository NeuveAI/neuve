// Publish must retain a requirement's Frame condition when it caps the event's six citations.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Log } from "@neuve/records-core";
import { codeFilledBatch } from "../src/link.ts";
import { publishPacket } from "../src/publish.ts";
import { inputsOf, hunk, put, storeFixture } from "./fixtures/link.ts";

const store = storeFixture("requirement-basis-");
test("a requirement citing six things keeps its basis among the six Records holds", async () => {
  const events = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx();
      const inputs = inputsOf(
        Array.from({ length: 6 }, (_, n) =>
          hunk(`h${n + 1}`, "a.ts", 10 + n * 2),
        ),
      );
      const assembled = codeFilledBatch(inputs);
      const unit = assembled.units[0]!;
      unit.assessment = {
        ...unit.assessment,
        status: "assessed",
        source: "agent",
        quadrant: "low-easy",
        complexity: { level: "low", factors: [] },
        validation: {
          level: "easy",
          requirements: [
            {
              requirement: "The requested behavior is checked.",
              basis: "D1",
              cites: ["h1", "h2", "h3", "h4", "h5", "h6"],
              kinds: ["test-run"],
              proof: [],
              agree: true,
              untested: "",
              coverage: "missing",
              coverageNote: "No proof recorded.",
              proofState: "missing",
              proofNote: "No proof recorded.",
              anchors: [],
              sources: [],
            },
          ],
        },
      };
      assembled.citations["D1"] = {
        kind: "obligation",
        ref: `computation:${inputs.keys.changeMap}`,
        entry: "D1",
      };
      const assembledKey = yield* put("test.assembled", assembled);
      yield* publishPacket(ctx, {
        candidates: [{ candidate: "g1", assembledKey, disposed: [] }],
        stages: [],
        sources: { manifest: null, changeMap: null, scope: null },
        strongestStratum: "plan",
      });
      return yield* Log.history({ cycleId: ctx.cycleId, limit: 1_000 });
    }),
  );
  const event = events.find(
    (row) => row.event.kind === "assessment.recorded@3",
  )?.event;
  expect(event?.kind).toBe("assessment.recorded@3");
  if (event?.kind !== "assessment.recorded@3")
    throw new Error("missing assessment");
  const requirement = event.payload.easeOfValidation.requirements[0]!;
  expect(requirement.cites).toHaveLength(6);
  expect(requirement.cites.map((cite) => cite.entry)).toContain("D1");
});
