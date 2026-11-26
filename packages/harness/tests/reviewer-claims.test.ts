// Why: incremental claims are the only general-review source. Registration must preserve the
// original evidence and producer even for cross-boundary and unknown anchors and after interruption.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { ToolState } from "../src/pi/stages/contract-schema.ts";
import { defineTool, READ_ONLY, type ChildRequest } from "../src/toolkit.ts";
import {
  reviewerClaims,
  reviewClaimKey,
  recordedClaimTask,
  type ReviewObservation,
} from "../src/readings/reviewer-claims.ts";

const observation = (path = "owned"): ReviewObservation => ({
  anchor: { path, side: "new", startLine: 2, endLine: 2 },
  kind: "defect",
  text: "Hook is called after an early return",
  fails: "A render changing branch changes the hook order",
  evidence: ["section.1"],
  row: null,
});
const build = () =>
  reviewerClaims({
    initial: [
      {
        reference: "section.1",
        text: "+ n2 if (loading) return null;\n+ n3 useState(false);",
      },
    ],
    resolve: (anchor) => ({
      section: anchor.path === "unknown" ? null : "section-key",
      ownership:
        anchor.path === "owned"
          ? "owned"
          : anchor.path === "unknown"
            ? "unknown"
            : "cross-boundary",
    }),
    child: (claim): ChildRequest => ({
      owner: 1,
      task: "verify",
      name: `claim.${claim.key}`,
      input: { claim },
      attributes: {},
      kind: "verify-claim",
      inputs: {},
    }),
  });

test("hook-order failure is recorded once and duplicate calls reuse the same Verify child", async () => {
  const ledger = build();
  const first = await Effect.runPromise(ledger.tool.handle(observation()));
  const replay = await Effect.runPromise(ledger.tool.handle(observation()));
  expect(ledger.claims()).toHaveLength(1);
  expect(first.child).toEqual(replay.child);
  expect(first.text).toContain("not verification");
});

test("retained ledger reload preserves exact reports and does not drop cross-boundary or unknown ownership", async () => {
  const ledger = build();
  await Effect.runPromise(ledger.tool.handle(observation("neighbor")));
  await Effect.runPromise(ledger.tool.handle(observation("unknown")));
  const state = ToolState.parse(ledger.state.save());
  const resumed = build();
  resumed.state.load(state, 4);
  expect(resumed.claims()).toEqual(ledger.claims());
  expect(resumed.claims().map((claim) => claim.ownership)).toEqual([
    "cross-boundary",
    "unknown",
  ]);
  expect(recordedClaimTask(resumed.claims()[0]!)).toContain("useState(false)");
});

test("only actual prepared or returned source is accepted as a claim basis", async () => {
  const ledger = build();
  const invalid = await Effect.runPromise(
    ledger.tool.handle({ ...observation(), evidence: ["invented source"] }),
  );
  expect(invalid.error).toBe("UnknownEvidence");
  expect(ledger.claims()).toEqual([]);
  const tool = defineTool({
    name: "scope_section",
    description: "Read prepared scope",
    input: z.strictObject({}),
    hints: READ_ONLY,
    handle: () => Effect.succeed({ text: "actual scope excerpt" }),
  });
  const read = await Effect.runPromise(
    ledger.readingTools([tool])[0]!.handle({}),
  );
  const ref = read.text.split("\n")[0]!.replace("Evidence reference: ", "");
  await Effect.runPromise(
    ledger.tool.handle({ ...observation(), evidence: [ref] }),
  );
  expect(ledger.claims()[0]!.evidence).toEqual([
    { reference: ref, text: "actual scope excerpt" },
  ]);
});

test("same-line distinct failure paths and different defects retain separate claims", () => {
  const first = observation();
  expect(reviewClaimKey(first)).not.toBe(
    reviewClaimKey({
      ...first,
      fails: "A different boundary fails independently",
    }),
  );
  expect(reviewClaimKey(first)).not.toBe(
    reviewClaimKey({
      ...first,
      text: "An unrelated failure at the same anchor",
    }),
  );
});

test("recording has no five-finding quota and own state is paged without sibling verdicts", async () => {
  const ledger = build();
  for (let at = 0; at < 10; at++)
    await Effect.runPromise(
      ledger.tool.handle({
        ...observation(),
        text: `Independent concern ${at}`,
      }),
    );
  expect(ledger.claims()).toHaveLength(10);
  const page = await Effect.runPromise(ledger.stateTool.handle({ page: 1 }));
  expect(page.paged).toBe(true);
  expect(page.text).not.toContain("Independent concern 9");
  expect(page.text).toContain("not verification or resolution");
});
