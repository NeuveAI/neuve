// Why: each attempt at a range opens its own cycle and shares one Understand across its lanes, so a
// lane file left by an earlier attempt must never be paired with a later one's (10.84's
// measurement would compare arms with different Understands, and nothing in the scores would show
// it). This walks a range through two attempts: the first stores one whole lane and one truncated
// lane, so the range is not done; the second attempt first moves both aside, and the range is done
// only once both lanes of the second attempt are stored.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rangeStored,
  startAttempt,
  type Lane,
} from "../src/harness-compare/runner.ts";

const out = mkdtempSync(join(tmpdir(), "harness-compare-attempts-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const lanes: ReadonlyArray<Lane> = [
  { slug: "e1-no-seed", candidate: "R(H3-E1)", env: {} },
  { slug: "e1-seeded", candidate: "R(H3-E1)", env: {} },
];

test("a second attempt never keeps a lane file from the first", () => {
  // Attempt 1: no-seed was whole, seeded was cut short.
  writeFileSync(join(out, "e1-no-seed.json.gz"), "attempt 1");
  writeFileSync(join(out, "e1-seeded.incomplete.json.gz"), "attempt 1");
  expect(rangeStored(out, lanes)).toBe(false);

  // Attempt 2 starts: both of attempt 1's files leave the range's folder, kept aside.
  const moved = startAttempt(out, lanes, "attempt-2");
  expect(moved.sort()).toEqual([
    "e1-no-seed.json.gz",
    "e1-seeded.incomplete.json.gz",
  ]);
  expect(existsSync(join(out, "e1-no-seed.json.gz"))).toBe(false);
  expect(existsSync(join(out, "e1-seeded.incomplete.json.gz"))).toBe(false);
  expect(
    existsSync(join(out, "superseded", "attempt-2", "e1-no-seed.json.gz")),
  ).toBe(true);

  // One lane of attempt 2 alone does not make the range done; both do.
  writeFileSync(join(out, "e1-seeded.json.gz"), "attempt 2");
  expect(rangeStored(out, lanes)).toBe(false);
  writeFileSync(join(out, "e1-no-seed.json.gz"), "attempt 2");
  expect(rangeStored(out, lanes)).toBe(true);
});
