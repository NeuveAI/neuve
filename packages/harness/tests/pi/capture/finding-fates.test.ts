// Why (12.41): the journal reader must distinguish settled findings, missing fates and no findings.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDump } from "../../../src/pi/capture/build.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import type { CaptureEvent } from "../../../src/pi/capture/types.ts";

const directory = mkdtempSync(join(tmpdir(), "finding-fates-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const read = async (
  name: string,
  findingIds: string[],
  fates: ReadonlyArray<{
    id: string;
    stage: "find" | "verify" | "publish";
    fate: "dropped" | "withheld" | "handed-on" | "published";
    reason?: string;
    publicationId?: string;
  }> = [],
) => {
  const scope = { runId: name };
  const folder = join(directory, name);
  const journal = openCaptureJournal(folder, name);
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "fixture",
    route: "chatgpt",
    pricing: "subscription",
  });
  journal.capture({
    type: "findings.returned",
    scope: { ...scope, stage: "find" },
    findingIds,
  });
  for (const { id, stage, ...fate } of fates)
    journal.capture({
      type: "lead.fate",
      scope: { ...scope, stage },
      leadId: id,
      handoff: stage,
      ...fate,
    } satisfies CaptureEvent);
  journal.capture({ type: "run.end", scope, status: "completed" });
  journal.close();
  return (await buildDump({ runId: name, journal: folder })).run;
};

test("a shape journal settles findings across dedupe, Verify and Publish without lead gaps", async () => {
  const run = await read(
    "settled",
    ["f1", "f2", "f3", "f4", "f5"],
    [
      { id: "f1", stage: "verify", fate: "dropped", reason: "duplicate" },
      { id: "f2", stage: "verify", fate: "dropped", reason: "not-verified" },
      { id: "f3", stage: "verify", fate: "withheld", reason: "unverified" },
      { id: "f4", stage: "find", fate: "handed-on" },
      { id: "f5", stage: "find", fate: "handed-on" },
      {
        id: "f4",
        stage: "publish",
        fate: "published",
        publicationId: "comment-4",
      },
      { id: "f5", stage: "publish", fate: "withheld", reason: "no-comment" },
    ],
  );
  expect(run.gaps).toEqual([]);
  expect(run.complete).toBe(true);
  expect(run.leads.open).toEqual([]);
  expect(run.leads.ledger.map((lead) => [lead.leadId, lead.final])).toEqual([
    ["f1", "dropped"],
    ["f2", "dropped"],
    ["f3", "withheld"],
    ["f4", "published"],
    ["f5", "withheld"],
  ]);
  expect(run.leads.ledger[3]?.fates.at(-1)?.publicationId).toBe("comment-4");
});

test("returned findings with no fates still disclose absent fates", async () => {
  const run = await read("absent", ["f1"]);
  expect(run.gaps.map((gap) => [gap.code, gap.count])).toEqual([
    ["lead-fates-absent", 1],
    ["leads-open", 1],
  ]);
  expect(run.complete).toBe(false);
  expect(run.leads.open).toEqual(["f1"]);
});

test("zero returned findings produce neither lead gap", async () => {
  const run = await read("empty", []);
  expect(run.gaps).toEqual([]);
  expect(run.leads.ledger).toEqual([]);
  expect(run.complete).toBe(true);
});

// Why: one captured fate must not hide a different finding whose handoff was lost.
test("a partially captured set retains the finding without a fate as open", async () => {
  const run = await read(
    "partial",
    ["f1", "f2"],
    [{ id: "f1", stage: "verify", fate: "dropped", reason: "duplicate" }],
  );
  expect(run.gaps.map((gap) => [gap.code, gap.count])).toEqual([
    ["leads-open", 1],
  ]);
  expect(run.leads.open).toEqual(["f2"]);
});
