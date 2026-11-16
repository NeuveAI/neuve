import { expect, test } from "bun:test";
import { reviewPriority } from "../src/pi/priority.ts";
import { routeByName, StepEffort, stepEffortOf } from "../src/route.ts";

// Why: the briefing's calls must wait in the readings band at their group's rank, never as a
// review's own step, or they would take the turn reserve's slots and pass the finders.
test("a briefing call waits in the readings band at its rank, after lane review by stage", () => {
  expect(reviewPriority("brief", false, 7)).toEqual({
    class: "interactive",
    position: "new",
    stage: 60,
    reading: { rank: 7 },
  });
  expect(reviewPriority("brief", true, 7).position).toBe("continuation");
  expect(reviewPriority("brief", false).stage).toBeGreaterThan(
    reviewPriority("lane-review", false).stage,
  );
  expect(reviewPriority("brief", false).stage).toBeLessThan(
    reviewPriority("verify", false).stage,
  );
});

// Why: the measuring run sets the briefing's effort by `review.stepEffort.brief`; an unknown kind
// is refused at the boundary, so `brief` must be a kind the setting accepts.
test("review.stepEffort accepts brief and a route gives a briefing step that effort", () => {
  expect(StepEffort.parse({ brief: "low" })).toEqual({ brief: "low" });
  const route = routeByName("anthropic", "high", undefined, { brief: "low" });
  expect(stepEffortOf(route, "brief")).toBe("low");
  expect(stepEffortOf(routeByName("anthropic", "high"), "brief")).toBe("high");
});
