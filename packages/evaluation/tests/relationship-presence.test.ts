import { describe, expect, test } from "bun:test";

import { evaluateRelationshipStage } from "../src/external-validation-evaluator.ts";

describe("relationship presence and coverage", () => {
  test("a qualified observed edge satisfies presence with incomplete coverage", () => {
    const result = evaluateRelationshipStage(
      { present: ["caller-calls-helper"], absent: [] },
      [
        {
          id: "caller-calls-helper",
          kind: "observed",
          present: true,
          coverage: "incomplete",
        },
      ],
    );
    expect({
      passed: result.passed,
      complete: result.complete,
      requirements: result.requirements,
    }).toEqual({
      passed: true,
      complete: false,
      requirements: [
        {
          id: "caller-calls-helper",
          expected: "present",
          observed: "present",
          passed: true,
        },
      ],
    });
    expect([...result.present]).toEqual(["caller-calls-helper"]);
  });

  test("unobserved edges are unknown under incomplete coverage and absent under complete coverage", () => {
    for (const expected of ["present", "absent"] as const) {
      const expectations = {
        present: expected === "present" ? ["edge"] : [],
        absent: expected === "absent" ? ["edge"] : [],
      };
      const incomplete = evaluateRelationshipStage(expectations, [
        {
          id: "edge",
          kind: "observed",
          present: false,
          coverage: "incomplete",
        },
      ]);
      const complete = evaluateRelationshipStage(expectations, [
        { id: "edge", kind: "observed", present: false, coverage: "complete" },
      ]);
      expect(incomplete.requirements).toEqual([
        { id: "edge", expected, observed: "unknown", passed: false },
      ]);
      expect(incomplete.passed).toBe(false);
      expect(complete.requirements).toEqual([
        {
          id: "edge",
          expected,
          observed: "absent",
          passed: expected === "absent",
        },
      ]);
      expect(complete.passed).toBe(expected === "absent");
    }
  });

  test("observed presence defeats a negative expectation even when coverage is incomplete", () => {
    const result = evaluateRelationshipStage(
      { present: [], absent: ["edge"] },
      [{ id: "edge", kind: "observed", present: true, coverage: "incomplete" }],
    );
    expect(result.requirements).toEqual([
      { id: "edge", expected: "absent", observed: "present", passed: false },
    ]);
    expect(result.expectation.unexpectedlyPresent).toEqual(["edge"]);
    expect(result.passed).toBe(false);
  });

  test("invalid, unavailable, and errored responses cannot establish either polarity", () => {
    for (const kind of ["invalid", "unavailable", "error"] as const) {
      for (const expected of ["present", "absent"] as const) {
        const result = evaluateRelationshipStage(
          {
            present: expected === "present" ? ["edge"] : [],
            absent: expected === "absent" ? ["edge"] : [],
          },
          [{ id: "edge", kind }],
        );
        expect(result.requirements).toEqual([
          { id: "edge", expected, observed: kind, passed: false },
        ]);
        expect({
          passed: result.passed,
          complete: result.complete,
          errored: result.errored,
        }).toEqual({
          passed: false,
          complete: false,
          errored: kind === "error",
        });
      }
    }
  });

  test("omitted and duplicate requirement observations are invalid", () => {
    for (const observations of [
      [],
      [
        { id: "edge", kind: "observed", present: true, coverage: "complete" },
        { id: "edge", kind: "observed", present: false, coverage: "complete" },
      ],
    ] as const) {
      const result = evaluateRelationshipStage(
        { present: ["edge"], absent: [] },
        observations,
      );
      expect(result.requirements).toEqual([
        { id: "edge", expected: "present", observed: "invalid", passed: false },
      ]);
      expect(result.passed).toBe(false);
      expect(result.complete).toBe(false);
      expect([...result.present]).toEqual([]);
    }
  });
});
