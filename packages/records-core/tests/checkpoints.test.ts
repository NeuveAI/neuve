// Why (11.16-11.18): a checkpoint's proof state is the reader's only view of whether a requirement
// is proven, and nothing else re-derives it. A wrong order (Proven over Out of date, Out of date over
// Missing), a currency taken from a stale stored value instead of git at the read, an anchor index
// read off the wrong owned range, or a source that could not be checked read as current would each
// show a requirement as proven when it is not. The first case pins the rule's order at its
// boundaries; the second reads checkpoints the way the desk does, from Records and real git history
// in which a record's commit was rebased away and a file changed after another record.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RecordEvent } from "@neuve/records-schema";
import { Blobs, Checkpoints, Log, Proofs, mintUlid } from "../src/index.ts";
import {
  actor,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

const repositories: Array<string> = [];
afterAll(() => {
  removeTemporaryDirectories();
  for (const directory of repositories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const current = { status: "current" } as const;
const rebased = { status: "stale", reason: "not-in-history" } as const;

test("the proof state follows its order: missing, out of date, conflicting, proven, thin", () => {
  const applicable = {
    kinds: ["test-run", "screenshot"] as Array<
      "test-run" | "screenshot" | "log" | "telemetry"
    >,
    agree: true,
    testable: true,
  };
  const state = (
    input: Partial<Checkpoints.StateInput>,
    over: Partial<typeof applicable> & { untested?: string } = {},
  ) =>
    Checkpoints.proofState({
      records: [],
      sources: [],
      ...input,
      applicable: { ...applicable, ...over },
    });
  const both = [
    { kind: "test-run" as const, currency: current },
    { kind: "screenshot" as const, currency: current },
  ];
  // No record held is Missing, even when a source it rests on also changed.
  expect(state({ sources: ["changed"] }).state).toBe("missing");
  // One record not current, or one source changed, unchecked or not found, outranks the rest,
  // disagreement included: a refresh comes before judging what the records say.
  expect(state({ records: both }).state).toBe("proven");
  expect(
    state(
      { records: [...both, { kind: "log", currency: rebased }] },
      { agree: false },
    ).state,
  ).toBe("out-of-date");
  for (const source of ["changed", "unchecked", "unknown"] as const)
    expect(state({ records: both, sources: ["current", source] }).state).toBe(
      "out-of-date",
    );
  // A currency that could not be decided is never taken as current.
  expect(
    state({
      records: [
        both[0]!,
        { kind: "screenshot", currency: { status: "unchecked" } },
      ],
    }).state,
  ).toBe("out-of-date");
  // Records that disagree are Conflicting (11.19), which is unmet, ahead of Proven.
  const conflicting = state({ records: both }, { agree: false });
  expect(conflicting.state).toBe("conflicting");
  expect(Checkpoints.stateNote(conflicting)).toBe(
    "Its records disagree: a test run and a screenshot.",
  );
  expect(Checkpoints.isUnmet("conflicting")).toBe(true);
  expect(Checkpoints.isUnmet("thin")).toBe(false);
  // Proven needs a current test run wherever a test can check the behaviour (11.20).
  const screenshotAndLogs = [
    { kind: "screenshot" as const, currency: current },
    { kind: "log" as const, currency: current },
  ];
  const untested = state(
    { records: screenshotAndLogs },
    { kinds: ["screenshot", "log"] },
  );
  expect(untested).toMatchObject({ state: "thin", why: "no-test-run" });
  // Where no test can, the agent's reason is carried into the note.
  const reasoned = state(
    { records: screenshotAndLogs },
    {
      kinds: ["screenshot", "log"],
      testable: false,
      untested: "The change is a CSS colour, which only a screenshot shows.",
    },
  );
  expect(reasoned.state).toBe("proven");
  expect(Checkpoints.stateNote(reasoned)).toContain(
    "No test can check it: The change is a CSS colour, which only a screenshot shows.",
  );
  // Otherwise two kinds and every applicable kind; anything less is Thin.
  expect(state({ records: [both[0]!] }).state).toBe("thin");
  expect(
    state({ records: both }, { kinds: ["test-run", "screenshot", "log"] })
      .state,
  ).toBe("thin");
  // Two records of one kind are one kind of proof.
  expect(
    state({ records: [both[0]!, both[0]!] }, { kinds: ["test-run"] }).state,
  ).toBe("thin");
});

/** A repository: A adds a.ts and b.ts; B changes a.ts; head C changes b.ts; S, off B, left the branch. */
const history = () => {
  const repository = mkdtempSync(join(tmpdir(), "records-core-checkpoints-"));
  repositories.push(repository);
  const git = (...args: Array<string>) => {
    const run = Bun.spawnSync(
      [
        "git",
        "-C",
        repository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(repository, path), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  commit({ "a.ts": "1\n", "b.ts": "1\n" }, "A");
  const b = commit({ "a.ts": "2\n" }, "B");
  const c = commit({ "b.ts": "2\n" }, "C");
  git("checkout", "-q", "-b", "side", b);
  const s = commit({ "a.ts": "2\n", "c.ts": "1\n" }, "S, amended away");
  git("checkout", "-q", "main");
  return { repository, b, c, s };
};

type Of<K extends RecordEvent["kind"]> = Extract<RecordEvent, { kind: K }>;

test("checkpoints read now: currency from git at the packet's head, anchors from the unit's owned ranges, pins as the run found them", async () => {
  const { repository, b, c, s } = history();
  const location = freshLocation();
  const range = { baseRef: "main", baseOid: b, headOid: c };
  const proof = (kind: "test-run" | "screenshot" | "log", revision: string) =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(`${kind} at ${revision}\n`);
      const mediaType =
        kind === "screenshot" ? "image/png" : "text/plain; charset=utf-8";
      const stored = yield* (yield* Blobs.BlobStore).put({
        bytes,
        mediaType,
        retention: "raw-capture",
      });
      const event = {
        id: mintUlid(),
        kind: "proof.recorded@1",
        idempotencyKey: `proof:${mintUlid()}`,
        actor,
        occurredAt: "2026-10-23T10:00:00.000Z",
        attribution: { range, sessionId: "session-1" },
        refs: [{ ref: `blob:${stored.blob.hash}`, role: "artefact" }],
        payload: {
          kind,
          revision,
          claim: "It shows the change working.",
          requirement: { text: "The change works" },
          artefact: { mediaType, bytes: bytes.byteLength },
          worktree: { head: revision, scope: "tracked-tree", dirty: false },
        },
      };
      yield* Log.append([event]);
      return event.id;
    });
  const unitId = mintUlid();
  const recorded = (paths: ReadonlyArray<string>) =>
    ({
      id: mintUlid(),
      kind: "unit.recorded@2",
      idempotencyKey: "unit",
      actor,
      occurredAt: "2026-10-23T10:00:00.000Z",
      attribution: {
        cycleId: mintUlid(),
        batchId: mintUlid(),
        unitIds: [unitId],
      },
      payload: {
        title: "A unit",
        ownedRanges: [
          {
            kind: "lines",
            path: paths[0]!,
            side: "new",
            startLine: 1,
            endLine: 1,
          },
          { kind: "whole-nontext", path: "img.png", side: "new" },
          {
            kind: "lines",
            path: paths[0]!,
            side: "old",
            startLine: 1,
            endLine: 1,
          },
        ],
        grouping: { gapLines: 20 },
      },
    }) as unknown as Of<"unit.recorded@2">;
  const requirement = (
    proof: ReadonlyArray<string>,
    extra: Record<string, unknown> = {},
  ) => ({
    requirement: "The change works",
    cites: [],
    coverage: "shallow",
    proof,
    kinds: ["test-run", "screenshot"],
    agree: true,
    testable: true,
    anchors: [0],
    sources: [],
    ...extra,
  });
  const assessment = (
    kind: "assessment.recorded@2" | "assessment.recorded@3",
    requirements: ReadonlyArray<unknown>,
  ) =>
    ({
      kind,
      payload: { easeOfValidation: { level: "easy", requirements } },
    }) as unknown as Of<"assessment.recorded@3">;
  const pin = (
    source: string,
    status: Checkpoints.SourceStatus,
  ): Checkpoints.PinView => ({
    source,
    provider: "tracker",
    item: "NEU-1",
    title: "Revoke links",
    version: null,
    readAt: "2026-10-23T09:00:00.000Z",
    status,
    checkedAt: "2026-10-23T10:00:00.000Z",
  });

  const result = await runOn(
    location,
    Effect.gen(function* () {
      const testRun = yield* proof("test-run", b);
      const screenshot = yield* proof("screenshot", b);
      const amended = yield* proof("log", s);
      const check = Checkpoints.checkerFor(repository, c);
      const read = (
        a: ReturnType<typeof assessment>,
        paths: ReadonlyArray<string>,
        checker: typeof check | undefined,
      ) =>
        Checkpoints.unitCheckpoints({
          assessment: a,
          recorded: recorded(paths),
          pins: [pin("S1", "unchecked"), pin("S2", "current")],
          check: checker,
        });
      const v3 = assessment("assessment.recorded@3", [
        requirement([testRun, screenshot], { anchors: [0, 1, 2] }),
        requirement([testRun, screenshot, amended]),
        requirement([], { anchors: [] }),
        requirement([testRun, screenshot], { sources: ["S2"] }),
        requirement([testRun, screenshot], { sources: ["S1"] }),
        requirement([testRun, screenshot], { sources: ["S9"] }),
        requirement([mintUlid()]),
      ]);
      return {
        owningA: yield* read(v3, ["a.ts"], check),
        // b.ts changed in C, after both records' commit B.
        owningB: yield* read(v3, ["b.ts"], check),
        noRepository: yield* read(v3, ["a.ts"], undefined),
        v2: yield* read(
          assessment("assessment.recorded@2", [
            {
              ...requirement([testRun, screenshot]),
              coverage: "solid",
              kinds: undefined,
              agree: undefined,
              anchors: undefined,
              sources: undefined,
            },
          ]),
          ["a.ts"],
          check,
        ),
        ids: { testRun, screenshot, amended },
      };
    }).pipe(Effect.provide(Blobs.layer(location))),
  );
  const { owningA, owningB, noRepository, v2, ids } = result;
  expect(owningA.checkpoints.map((c) => c.proof)).toEqual([
    "proven",
    "out-of-date",
    "missing",
    "proven",
    "out-of-date",
    "out-of-date",
    "missing",
  ]);
  expect(owningA.checkpoints.map((c) => c.number)).toEqual([
    1, 2, 3, 4, 5, 6, 7,
  ]);
  // Indices into the unit's owned ranges: a whole non-text range is no line to anchor on.
  expect(owningA.checkpoints[0]!.anchors).toEqual([
    { path: "a.ts", side: "new", startLine: 1, endLine: 1 },
    { path: "a.ts", side: "old", startLine: 1, endLine: 1 },
  ]);
  expect(owningA.checkpoints[2]!.anchors).toEqual([]);
  expect(owningA.checkpoints[1]!.note).toContain(
    "no longer in the branch's history",
  );
  expect(owningA.checkpoints[4]!.note).toContain("couldn't be checked again");
  expect(owningA.proofCurrency[ids.testRun]).toEqual({ status: "current" });
  expect(owningA.proofCurrency[ids.amended]).toEqual(rebased);
  expect(owningB.checkpoints[0]!.proof).toBe("out-of-date");
  expect(owningB.checkpoints[0]!.note).toContain("changed after");
  expect(owningB.proofCurrency[ids.testRun]).toMatchObject({
    status: "stale",
    reason: "changed-after",
  });
  // Without git to ask, no record is taken as current.
  expect(noRepository.checkpoints[0]!.proof).toBe("out-of-date");
  expect(noRepository.proofCurrency[ids.testRun]).toEqual({
    status: "unchecked",
  });
  // Before anchors were recorded: none to show, and the assessed coverage stands in for kinds.
  expect(v2.checkpoints[0]!.anchors).toBeNull();
  expect(v2.checkpoints[0]!.proof).toBe("proven");
  // The plain-text rule: no record IDs, hashes or decision numbers in what the reader sees.
  for (const checkpoint of [...owningA.checkpoints, ...owningB.checkpoints])
    expect(checkpoint.note).not.toMatch(
      /\b[0-9A-HJKMNP-TV-Z]{26}\b|\b[0-9a-f]{12,}\b|\d+\.\d+/,
    );
  expect(Proofs.describeCurrency(rebased)).toBe(
    "stale: its commit is not in the head's history",
  );
});

// Why: the units stage stores each record's currency as `describeCurrency`'s words and Assemble reads
// them back. Reworded text would read as unchecked (Out of date) everywhere, silently; this pins that
// every currency survives the trip.
test("every currency's words read back as the same status and reason", () => {
  const currencies: ReadonlyArray<Proofs.Currency> = [
    { status: "current" },
    { status: "stale", reason: "not-in-history" },
    { status: "stale", reason: "unknown-revision" },
    {
      status: "stale",
      reason: "changed-after",
      changed: ["a.ts", "b, c.ts"],
      changedCount: 25,
    },
  ];
  for (const currency of currencies) {
    const back = Proofs.currencyFromDescription(
      Proofs.describeCurrency(currency),
    );
    expect(back.status).toBe(currency.status);
    if (currency.status === "stale")
      expect(back).toMatchObject({ reason: currency.reason });
  }
  expect(Proofs.currencyFromDescription(undefined)).toEqual({
    status: "unchecked",
  });
});
