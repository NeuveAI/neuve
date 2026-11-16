// Why: a lead attached to two units reaches Publish once per target, and the ledger kept one final
// fate per lead from whichever event came last: a unit withheld after another was published, or a
// late hand-off, erased the publication and reopened the lead. This drives the stage producer's
// event shape through the public leaf (journal, direct export, folder reader) in both orders.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  exportSnapshot,
  openCaptureJournal,
  readSessionDump,
  type RunDump,
} from "@neuve/harness/session-dump";
import type { CaptureEvent } from "../../../src/pi/capture/types.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-capture-targets-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const root = join(directory, "datasets");
mkdirSync(root);

type Lead = RunDump["leads"]["ledger"][number];

const publish = (
  runId: string,
  fields: Partial<Extract<CaptureEvent, { type: "lead.fate" }>>,
): CaptureEvent => ({
  type: "lead.fate",
  scope: { runId, stage: "publish" },
  leadId: "p1.e1",
  handoff: "publish",
  fate: "published",
  ...fields,
});

const A = {
  fate: "published",
  referenceId: "ref-A",
  publicationId: "actual-record-A",
} as const;
const B = { fate: "withheld", referenceId: "ref-B", reason: "anchor" } as const;
const LATE = [
  { stage: "assemble", handoff: "assemble", fate: "attached", unitId: "u3" },
  { stage: "dispose", handoff: "dispose", fate: "handed-on", findId: "f9" },
] as const;

/** One run's lead ledger as the folder reader returns it, from the fates given in order. */
const ledgerOf = async (
  runId: string,
  fates: ReadonlyArray<(runId: string) => CaptureEvent>,
) => {
  const journal = join(directory, runId);
  const scope = { runId };
  const capture = openCaptureJournal(journal, runId);
  capture.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  for (const fate of fates) capture.capture(fate(runId));
  capture.capture({ type: "run.end", scope, status: "completed" });
  capture.close();
  const filed = await exportSnapshot({
    runId,
    journal,
    root,
    retention: { policy: "lead target fixture" },
  });
  return (await Effect.runPromise(readSessionDump(filed.directory))).run.leads;
};

test("a lead published for one target and withheld for another stays published in either order and after later hand-offs, with every target's history", async () => {
  const toA = (runId: string) => publish(runId, A);
  const toB = (runId: string) => publish(runId, B);
  const late = LATE.map(
    ({ stage, ...fields }) =>
      (runId: string) =>
        publish(runId, { scope: { runId, stage }, ...fields }),
  );
  const atA: Lead["fates"][number] = {
    seq: expect.any(Number),
    stage: "publish",
    handoff: "publish",
    fate: "published",
    referenceId: "ref-A",
    publicationId: "actual-record-A",
  };
  const atB: Lead["fates"][number] = {
    seq: expect.any(Number),
    stage: "publish",
    handoff: "publish",
    fate: "withheld",
    referenceId: "ref-B",
    reason: "anchor",
  };
  const later: Lead["fates"] = [
    {
      seq: expect.any(Number),
      stage: "assemble",
      handoff: "assemble",
      fate: "attached",
      unitId: "u3",
    },
    {
      seq: expect.any(Number),
      stage: "dispose",
      handoff: "dispose",
      fate: "handed-on",
      findId: "f9",
    },
  ];
  const summary: Pick<Lead, "targets" | "terminal" | "final"> = {
    targets: [
      { referenceId: "ref-A", terminal: ["published"] },
      { referenceId: "ref-B", terminal: ["withheld"] },
    ],
    terminal: ["published", "withheld"],
    final: "published",
  };

  const ab = await ledgerOf("RUN_AB", [toA, toB]);
  const ba = await ledgerOf("RUN_BA", [toB, toA]);
  const after = await ledgerOf("RUN_LATE", [toA, toB, ...late]);
  expect(ab.ledger).toEqual([
    { leadId: "p1.e1", fates: [atA, atB], ...summary },
  ]);
  expect(ba.ledger).toEqual([
    { leadId: "p1.e1", fates: [atB, atA], ...summary },
  ]);
  expect(after.ledger).toEqual([
    { leadId: "p1.e1", fates: [atA, atB, ...later], ...summary },
  ]);
  for (const leads of [ab, ba, after]) expect(leads.open).toEqual([]);
});

test("different terminal fates with nothing published are all kept and no single one is chosen; a target with none is open", async () => {
  const leads = await ledgerOf("RUN_UNDECIDED", [
    (runId) => publish(runId, B),
    (runId) =>
      publish(runId, {
        scope: { runId, stage: "investigate" },
        handoff: "investigate",
        fate: "dropped",
      }),
    (runId) =>
      publish(runId, {
        leadId: "p2.e1",
        fate: "handed-on",
        referenceId: "ref-C",
      }),
  ]);
  expect(
    leads.ledger.map(({ leadId, targets, terminal, final }) => ({
      leadId,
      targets,
      terminal,
      final,
    })),
  ).toEqual([
    {
      leadId: "p1.e1",
      targets: [{ referenceId: "ref-B", terminal: ["withheld"] }],
      terminal: ["dropped", "withheld"],
      final: null,
    },
    {
      leadId: "p2.e1",
      targets: [{ referenceId: "ref-C", terminal: [] }],
      terminal: [],
      final: null,
    },
  ]);
  expect(leads.open).toEqual(["p2.e1"]);
});
