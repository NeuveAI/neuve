import { storeLocationIn } from "@neuve/records-core";
import {
  runIn,
  value,
  scanCaptures,
} from "../../harness/tests/pi/capture/fixture.ts";
// Why (NEU-58): a fresh candidate is the pi port's scored review of the replay's cases, compared with
// the replay's first runs by the existing parity method. If its outputs could land on the research
// volume, a failed or capture-incomplete run could read as a quiet review, a reading or coding capture
// could be scored, or a changed baseline file could go unnoticed, the comparison would mislead the
// owner's gate. These drive the collector through its CLI over literal case folders.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureBlockers,
  loadSessionDumpReader,
  readCandidateCapture,
  type SessionDumpReader,
} from "../src/candidate/capture.ts";
import { candidateMain as actualCandidateMain } from "../src/candidate/cli.ts";
import { executionOf, Manifest } from "../src/candidate/manifest.ts";
import { readRun, runState } from "../src/harness-compare/full-test/parity.ts";
import { BlindPass } from "../src/pr-replay/matching.ts";
import {
  Confirmation,
  labellingDigest,
  matchingDigest,
} from "../src/pr-replay/parity.ts";
import { runToolless } from "../src/pr-replay/codex.ts";
import {
  runFolder,
  runPaths,
  treatmentWrite,
  writeRoot,
} from "../src/pr-replay/sources.ts";

import { Effect } from "effect";
import {
  setup,
  submit,
  usage,
} from "../../harness/tests/pi/stages/contract-fixture.ts";
import { ContractContextCapture } from "../../harness/src/pi/capture/contract-types.ts";
import {
  exportSnapshot,
  exportCapturedDump,
  captureRunDump,
  openCaptureJournal,
  readSessionDump,
} from "@neuve/harness/session-dump";

const candidateMain: typeof actualCandidateMain = (args, deps = {}) =>
  actualCandidateMain(args, { reader: async () => READER, ...deps });

const RUN_A = "01M5V9FNPH0GA6XREDPJR5KWC8";
const RUN_B = "01M5V9FNPH0GA6XREDPJR5KWC9";
const NOW = "2026-10-29T00:00:00.000Z";

let base = "";
let research = "";
let treatment = "";
const saved = {
  research: process.env["NEUVE_RESEARCH_ROOT"],
  treatment: process.env["NEUVE_TREATMENT_ROOT"],
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "candidate-")));
  research = join(base, "research");
  treatment = join(base, "treatment");
  mkdirSync(research);
  process.env["NEUVE_RESEARCH_ROOT"] = research;
  delete process.env["NEUVE_TREATMENT_ROOT"];
});

afterEach(() => {
  for (const [key, value] of [
    ["NEUVE_RESEARCH_ROOT", saved.research],
    ["NEUVE_TREATMENT_ROOT", saved.treatment],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(base, { recursive: true, force: true });
});

const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

const caseDir = (number: number) =>
  join(research, "cases", "t3code", String(number));

const writeCase = (number: number, control: "quiet" | null = null) => {
  mkdirSync(caseDir(number), { recursive: true });
  writeFileSync(
    join(caseDir(number), "case.json"),
    JSON.stringify({
      version: 1,
      caseId: `github:pingdotgg/t3code:${number}`,
      source: "t3code",
      provider: "github",
      number,
      title: "a change",
      url: `https://github.com/pingdotgg/t3code/pull/${number}`,
      author: "someone",
      createdAt: "2026-01-01T00:00:00Z",
      outcome: "merged",
      family: `f${number}`,
      split: "development",
      era: "2026",
      control,
      selection: { score: 1, reasons: [] },
      firstRevision: null,
      later: null,
      size: null,
      capture: { at: "2026-01-01T00:00:00Z", files: [] },
      clone: null,
      checks: null,
      unavailable: null,
    }),
  );
  const judged = (id: string) => ({
    id,
    isConcern: true,
    category: "correctness",
    substantive: true,
    response: "fixed",
    fixRevision: 2,
    validity: "valid",
    designDecision: false,
    rationale: "",
  });
  mkdirSync(join(caseDir(number), "labels"), { recursive: true });
  const threads =
    control === null ? ["t1", ...(number === 1 ? ["t2"] : [])] : [];
  writeFileSync(
    join(caseDir(number), "labels", "concerns.jsonl"),
    [
      ...threads.map((id) =>
        JSON.stringify({ id, a: judged(id), b: judged(id) }),
      ),
      // A thread the labellers never agreed on: unavailable, never a miss.
      JSON.stringify({ id: "u1", a: judged("u1"), b: null }),
    ].join("\n") + "\n",
  );
  return threads;
};

/** A run's matching (key, pairs, both passes) and, for concerns left unmatched, its confirmation. */
const writeLabels = (
  number: number,
  labels: string,
  concerns: ReadonlyArray<string>,
  caught: ReadonlyArray<string>,
) => {
  mkdirSync(labels, { recursive: true });
  const items = [
    ...concerns.map((ref, i) => ({
      id: `r${i}`,
      source: "reviewer",
      group: "concern",
      ref,
    })),
    { id: "n1", source: "neuve", group: "comment", ref: "b1.u1#1" },
  ];
  const pairs = concerns.flatMap((ref, i) =>
    caught.includes(ref) ? [`r${i}|n1`] : [],
  );
  writeFileSync(join(labels, "matching-key.json"), JSON.stringify({ items }));
  writeFileSync(
    join(labels, "matching.json"),
    JSON.stringify({
      pairs,
      summary: {
        substantiveConcerns: concerns.length,
        caught: concerns.length === 0 ? null : caught.length / concerns.length,
        caughtByAny:
          concerns.length === 0 ? null : caught.length / concerns.length,
        neuve: { items: 1 },
      },
    }),
  );
  const pass = BlindPass.parse({
    comments: pairs.map((pair) => {
      const [x, y] = pair.split("|");
      return { id: x, holds: "unsure", sameAs: [y], rationale: "" };
    }),
    verdicts: [],
  });
  for (const name of ["a", "b"]) {
    mkdirSync(join(labels, "matching", `pass-${name}`), { recursive: true });
    writeFileSync(
      join(labels, "matching", `pass-${name}`, "output.json"),
      JSON.stringify(pass),
    );
  }
  const missed = concerns.filter((ref) => !caught.includes(ref));
  if (missed.length > 0)
    writeFileSync(
      join(labels, "confirmation.json"),
      JSON.stringify(
        Confirmation.parse({
          version: 1,
          promptDigest: "a".repeat(64),
          matching: matchingDigest(labels),
          labelling: labellingDigest(join(caseDir(number), "labels")),
          run: null,
          concerns: missed.map((ref) => ({
            ref,
            standing: "missed",
            caught: null,
            agreed: false,
            by: null,
            votes: [],
          })),
        }),
      ),
    );
};

const receipt = (
  runId: string,
  changes: Record<string, unknown> = {},
  usage = { input: 1000, output: 100, cacheRead: 4000 },
) =>
  JSON.stringify({
    type: "receipt",
    runId,
    route: { model: "gpt-6.1-sol", effort: "high" },
    outcome: "completed",
    timeout: { lifetimeMs: 1_200_000, reached: false },
    stages: [
      { stage: "understand", agent: "understand", status: "computed" },
      { stage: "publish", agent: "publish", status: "computed" },
    ],
    totals: {
      modelCalls: 7,
      usage: { ...usage, cacheWrite5m: 0, cacheWrite1h: 0 },
    },
    packet: { complete: true, batches: [{}] },
    ...changes,
  });

const BUILD = {
  commit: "c1",
  productCommit: "p1",
  graph: "g1",
  dirty: false,
  deadlineS: 1200,
  settings: {
    version: 1,
    review: { route: "openai", effort: "high", deadline: 20 },
  },
  imageId: null,
  model: "gpt-6.1-sol",
  effort: "high",
  lifetimeMs: 1_200_000,
};

/** The replay's first run: run/cloud's receipt and build, copied to run/show.json as the replay was. */
const writeFirst = (number: number, show: string) => {
  const cloud = join(caseDir(number), "run", "cloud");
  mkdirSync(cloud, { recursive: true });
  writeFileSync(join(cloud, "show.json"), show);
  writeFileSync(join(cloud, "build.json"), JSON.stringify(BUILD));
  writeFileSync(join(caseDir(number), "run", "show.json"), show);
};

/** A candidate's run folder as app.py candidate leaves it: receipt, build record, dump facts and folder. */
const writeCandidate = (
  number: number,
  show: string | null,
  build: Record<string, unknown> = {},
  run = "candidate-1",
) => {
  const folder = join(treatment, "cases", "t3code", String(number), "run", run);
  mkdirSync(folder, { recursive: true });
  if (show !== null) writeFileSync(join(folder, "show.json"), show);
  writeFileSync(
    join(folder, "build.json"),
    JSON.stringify({
      ...BUILD,
      commit: "c9",
      productCommit: "p9",
      imageId: "im-9",
      candidate: { name: run, treatment },
      control: {
        run: "cloud",
        build: BUILD,
        showSha256: sha(
          readFileSync(join(caseDir(number), "run", "cloud", "show.json")),
        ),
      },
      declared: ["productCommit"],
      differences: ["productCommit", "imageId"],
      undeclared: [],
      policy: [],
      ...build,
    }),
  );
  if (show !== null) {
    writeFileSync(
      join(folder, "capture.json"),
      JSON.stringify({
        run: JSON.parse(show).runId,
        redaction: "portable",
        kind: "scored",
        snapshot: "s1",
        close: { mode: "ended", execution: "ended" },
      }),
    );
    const dump = join(
      folder,
      "capture",
      "portable",
      "scored",
      JSON.parse(show).runId,
      "s1",
    );
    mkdirSync(dump, { recursive: true });
    writeFileSync(
      join(dump, "manifest.json"),
      JSON.stringify({
        scan: {
          policy: "capture-scan-v1",
          rawCapture: "a".repeat(64),
          jobSeq: 1,
          attempt: 1,
        },
      }),
    );
  }
  return folder;
};

/** The reader's restored dump, as the capture lane's readSessionDump returns it. */
const restored = (
  runId: string,
  changes: {
    runKind?: string;
    version?: number;
    gaps?: Array<object>;
    stage?: string;
    status?: string;
  } = {},
) => {
  const tokens = {
    input: 900,
    output: 90,
    cacheRead: 3000,
    cacheWrite: 0,
    totalTokens: 3990,
  };
  const gaps = changes.gaps ?? [];
  return {
    source: "folder",
    manifest: {
      format: "neuve.session-dump",
      version: changes.version ?? 1,
      runId,
      runKind: changes.runKind ?? "scored",
      redaction: "portable",
      scan: { policy: "capture-scan-v1", rawCapture: "a".repeat(64) },
    },
    run: {
      runId,
      runKind: changes.runKind ?? "scored",
      status: changes.status ?? "completed",
      stages: [
        {
          stage: "dispose",
          status: changes.stage ?? "completed",
          totals: { tokens },
        },
      ],
      totals: { tokens },
      gaps,
      complete: !gaps.some(
        (gap) => (gap as { kind: string }).kind === "capture",
      ),
    },
    record: {
      snapshotId: "b".repeat(64),
      captureMark: {
        kind: "capture.marked@1",
        id: RUN_A,
        actor: "c".repeat(64),
        occurredAt: "2026-11-02T00:00:00.000Z",
        idempotencyKey: "synthetic-mark",
        payload: {
          rawCapture: "a".repeat(64),
          detectorVersion: "capture-scan-v1",
          outcome: "clean",
          record: "b".repeat(64),
        },
      },
      redaction: {
        mode: "portable",
        inspectionOnly: true,
        withheld: [],
        restrictedFiles: [],
      },
    },
    backup: { status: "unavailable", reason: "portable" },
  };
};

const readerOf =
  (dumps: Record<string, unknown>): SessionDumpReader =>
  async (directory) => {
    const found = Object.entries(dumps).find(([runId]) =>
      directory.includes(runId),
    );
    if (found === undefined) throw new Error(`DumpRejected: ${directory}`);
    return found[1];
  };

const writeSample = () => {
  const path = join(base, "sample.json");
  writeFileSync(
    path,
    JSON.stringify({
      seed: "test",
      concerns: [1, 2, 3].map((n) => `github:pingdotgg/t3code:${n}`),
      controls: ["github:pingdotgg/t3code:4"],
    }),
  );
  return path;
};

// One test for the three name lengths: a one-digit, a two-digit and a three-digit candidate.
test("a candidate of any number uses its treatment for capture and labels", () => {
  for (const run of ["candidate-1", "candidate-10", "candidate-123"]) {
    delete process.env["NEUVE_TREATMENT_ROOT"];
    const directory = caseDir(7);
    expect(runFolder(directory, "cloud-2")).toBe(
      join(directory, "run", "cloud-2"),
    );
    expect(() => runFolder(directory, run)).toThrow(
      "needs NEUVE_TREATMENT_ROOT",
    );
    process.env["NEUVE_TREATMENT_ROOT"] = join(research, "notes", "pi");
    expect(() => runFolder(directory, run)).toThrow(
      "overlaps the research volume",
    );
    process.env["NEUVE_TREATMENT_ROOT"] = treatment;
    expect(runFolder(directory, run)).toBe(
      join(treatment, "cases", "t3code", "7", "run", run),
    );
    // Labelling a candidate writes its labels under the treatment and reads the case's concern labels.
    expect(runPaths("t3code", 7, run)).toEqual({
      labels: join(treatment, "cases", "t3code", "7", "run", run, "labels"),
      show: join(treatment, "cases", "t3code", "7", "run", run, "show.json"),
      caseLabels: join(directory, "labels"),
    });
    // With a treatment set, the first run is still read (a confirmation's decoys), never written.
    expect(runPaths("t3code", 7).labels).toBe(join(directory, "labels"));
    expect(() => treatmentWrite(join(directory, "labels"))).toThrow(
      "labels are written under the treatment only",
    );
    expect(treatmentWrite(join(treatment, "cases"))).toBe(
      join(treatment, "cases"),
    );
  }
});

test("with a treatment set, the replay CLI runs only a candidate's labelling", () => {
  const cli = (...args: Array<string>) =>
    Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "..", "src", "pr-replay", "cli.ts"),
        ...args,
      ],
      {
        env: { ...process.env, NEUVE_TREATMENT_ROOT: treatment },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
  for (const [args, why] of [
    [
      ["concerns", "t3code", "7"],
      "concerns: with NEUVE_TREATMENT_ROOT set only a candidate's labelling runs",
    ],
    [
      ["match", "t3code", "7"],
      "match: with NEUVE_TREATMENT_ROOT set, name the candidate's run with --run candidate-<k>",
    ],
    [
      ["merit", "t3code", "7", "--run", "cloud-2"],
      "merit: with NEUVE_TREATMENT_ROOT set, name the candidate's run",
    ],
    [
      ["confirm", join(research, "notes", "c"), "1", "--run", "candidate-1"],
      "is on the research volume",
    ],
  ] as const) {
    const done = cli(...args);
    expect(done.exitCode).not.toBe(0);
    expect(done.stderr.toString()).toContain(why);
  }
  for (const run of [
    "candidate-0",
    "candidate-01",
    "candidate--10",
    "candidate-10/../cloud",
  ]) {
    const done = cli("match", "t3code", "7", "--run", run);
    expect(done.exitCode).not.toBe(0);
    expect(done.stderr.toString()).toContain("name the candidate's run");
  }
  writeCase(7);
  const concerns = readFileSync(join(caseDir(7), "labels/concerns.jsonl"));
  const folder = join(treatment, "cases/t3code/7/run/candidate-10");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "show.json"), JSON.stringify({ packet: null }));
  const admitted = cli("match", "t3code", "7", "--run", "candidate-10");
  // The missing first revision stops this fixture before a model can run, after output admission.
  expect(admitted.stderr.toString()).toContain("has no first revision");
  expect(admitted.stderr.toString()).not.toContain("name the candidate's run");
  expect(existsSync(join(folder, "labels"))).toBe(true);
  expect(readFileSync(join(caseDir(7), "labels/concerns.jsonl"))).toEqual(
    concerns,
  );
  expect(existsSync(join(caseDir(7), "run/candidate-10"))).toBe(false);
  expect(existsSync(join(research, "notes"))).toBe(false);
});

test("labelling a candidate writes its logs to the treatment and never runs the Mac's labeller", async () => {
  // Why: the Mac's labeller writes into the research volume's Codex home.
  expect(writeRoot()).toBe(research);
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  mkdirSync(treatment);
  expect(writeRoot()).toBe(treatment);
  const saved = process.env["NEUVE_LABEL_RUNNER"];
  delete process.env["NEUVE_LABEL_RUNNER"];
  try {
    await expect(
      runToolless(
        {
          runDir: join(base, "run"),
          prompt: "p",
          schema: {},
          log: join(base, "log"),
          effort: "medium",
        },
        [],
      ),
    ).rejects.toThrow("label with NEUVE_LABEL_RUNNER=cloud");
  } finally {
    if (saved !== undefined) process.env["NEUVE_LABEL_RUNNER"] = saved;
  }
  expect(existsSync(join(base, "run"))).toBe(false);
});

test("a reading run is never labelled or scored", () => {
  expect(() => runPaths("t3code", 7, "reading-8")).toThrow("never scored");
  expect(() => runState(caseDir(7), "reading-8")).toThrow("never scored");
  expect(() => readRun(caseDir(7), "reading-9")).toThrow("never scored");
});

test("a receipt's execution is what it says ended, stage by stage", () => {
  const view = JSON.parse(receipt(RUN_A));
  expect(executionOf(view)).toEqual({ state: "completed" });
  expect(executionOf({ ...view, outcome: "timed-out" })).toEqual({
    state: "timed-out",
    why: "the run timed-out",
  });
  expect(
    executionOf({ ...view, packet: { complete: false, batches: [{}] } }),
  ).toEqual({
    state: "partial",
    why: "its packet is partial",
  });
  expect(
    executionOf({
      ...view,
      stages: [
        { stage: "dispose", agent: "dispose.b1.u1", status: "interrupted" },
        { stage: "publish", agent: "publish", status: "computed" },
      ],
    }),
  ).toEqual({
    state: "partial",
    why: "stages not done: dispose.b1.u1 interrupted",
  });
});

test("only a complete scored capture of the same run, ended in every stage, may be scored", async () => {
  const at = `/x/portable/scored/${RUN_A}/s1`;
  const read = (dump: unknown, redaction = "portable") =>
    readCandidateCapture(
      at,
      { runId: RUN_A, redaction },
      readerOf({ [RUN_A]: dump }),
    );
  const complete = await read(restored(RUN_A));
  expect(complete.status).toBe("complete");
  expect(captureBlockers(complete)).toEqual([]);
  expect(await read(restored(RUN_A, { runKind: "reading" }))).toEqual({
    status: "refused",
    why: "a reading run's capture is never scored as a review",
  });
  expect(await read(restored(RUN_A, { runKind: "coding" }))).toEqual({
    status: "refused",
    why: "a coding run's capture is never scored as a review",
  });
  expect(await read(restored(RUN_A, { version: 2 }))).toEqual({
    status: "refused",
    why: "unsupported dump neuve.session-dump version 2: this adapter reads neuve.session-dump version 1",
  });
  expect(await read(restored(RUN_B))).toEqual({
    status: "refused",
    why: `the dump is of run ${RUN_B}, the receipt's is ${RUN_A}`,
  });
  expect(await read(restored(RUN_A), "restricted")).toEqual({
    status: "refused",
    why: "the dump is portable (filed portable), its folder says restricted",
  });
  expect(
    await readCandidateCapture(
      at,
      { runId: RUN_A, redaction: "portable" },
      readerOf({}),
    ),
  ).toEqual({
    status: "unreadable",
    why: `the reader rejected ${at}: DumpRejected: ${at}`,
  });
  // complete ignores execution gaps: an open run (no run.end, leads still owed) or a stage cut off blocks.
  const ended = await read(
    restored(RUN_A, {
      stage: "cutoff",
      gaps: [
        { code: "run-end-missing", count: 1, detail: "", kind: "execution" },
        { code: "lead-fates-absent", count: 5, detail: "", kind: "execution" },
      ],
    }),
  );
  expect(ended.status).toBe("complete");
  expect(captureBlockers(ended)).toEqual([
    "captured stages not completed: dispose cutoff",
    "execution open: run-end-missing, lead-fates-absent",
  ]);
  const torn = await read(
    restored(RUN_A, {
      gaps: [{ code: "journal-torn", count: 1, detail: "", kind: "capture" }],
    }),
  );
  expect(captureBlockers(torn)).toEqual(["capture incomplete: journal-torn"]);
});

test("the reader comes from its public export or says it is unavailable", async () => {
  const reader = await loadSessionDumpReader("@neuve/harness/no-such-export");
  expect(typeof reader).toBe("string");
  expect(String(reader)).toStartWith(
    "capture reader unavailable: @neuve/harness/no-such-export is not exported",
  );
  expect(
    await readCandidateCapture(
      "/x",
      { runId: RUN_A, redaction: "portable" },
      String(reader),
    ),
  ).toEqual({
    status: "unreadable",
    why: String(reader),
  });
});

// Why: a complete declaration without provider wire evidence must never enter scoring.
for (const captureVersion of [undefined, 1, 2])
  test(`contract capture version ${String(captureVersion)} is refused before scoring`, async () => {
    const dump = restored(RUN_A);
    const contexts = ["find", "verify"].map((stage) => ({
      ...(captureVersion === undefined ? {} : { captureVersion }),
      coverage: "no-wire-capture",
      state: { contextKey: `${RUN_A}:1:${stage}` },
    }));
    const read = await readCandidateCapture(
      `/x/portable/scored/${RUN_A}/s1`,
      { runId: RUN_A, redaction: "portable" },
      readerOf({
        [RUN_A]: { ...dump, run: { ...dump.run, contractContexts: contexts } },
      }),
    );
    const why =
      captureVersion === 2
        ? `unsupported contract capture version: ${RUN_A}:1:find (version 2), ${RUN_A}:1:verify (version 2); this adapter reads version 1`
        : `no-wire-capture: contract contexts ${RUN_A}:1:find, ${RUN_A}:1:verify have no provider wire evidence; scoring refused`;
    expect(read).toEqual({ status: "refused", why });
    expect(captureBlockers(read)).toEqual([`capture refused: ${why}`]);
  });

/** Four sample cases: one each that compares, that runs another policy, whose baseline timed out, and a control whose capture is incomplete. */
const writeCorpus = () => {
  // Case 1: the baseline caught t1 and missed t2; the candidate caught both. A repeat ran it too.
  writeLabels(1, join(caseDir(1), "labels"), writeCase(1), ["t1"]);
  writeFirst(1, receipt(RUN_A));
  const repeat = join(caseDir(1), "run", "cloud-2");
  mkdirSync(repeat, { recursive: true });
  writeFileSync(
    join(repeat, "show.json"),
    receipt(RUN_A, {}, { input: 1100, output: 120, cacheRead: 4000 }),
  );
  writeFileSync(join(repeat, "build.json"), JSON.stringify(BUILD));
  writeLabels(1, join(repeat, "labels"), ["t1", "t2"], ["t1"]);
  // Case 2: the baseline caught t1.
  writeLabels(2, join(caseDir(2), "labels"), writeCase(2), ["t1"]);
  writeFirst(2, receipt(RUN_A));
  // Case 3: the baseline timed out.
  writeLabels(3, join(caseDir(3), "labels"), writeCase(3), []);
  writeFirst(3, receipt(RUN_A, { outcome: "timed-out" }));
  // Case 4: a quiet control.
  writeLabels(4, join(caseDir(4), "labels"), writeCase(4, "quiet"), []);
  writeFirst(4, receipt(RUN_A));
};

const writeCandidates = () => {
  const one = writeCandidate(
    1,
    receipt(RUN_B, {}, { input: 1200, output: 150, cacheRead: 5000 }),
  );
  writeLabels(1, join(one, "labels"), ["t1", "t2"], ["t1", "t2"]);
  writeCandidate(2, receipt(RUN_B), {
    effort: "medium",
    differences: ["productCommit", "effort"],
    policy: ["effort"],
  });
  const three = writeCandidate(3, receipt(RUN_B));
  writeLabels(3, join(three, "labels"), ["t1"], ["t1"]);
  writeCandidate(4, receipt("01M5V9FNPH0GA6XREDPJR5KWCA"));
};

const READER = readerOf({
  [RUN_B]: restored(RUN_B),
  "01M5V9FNPH0GA6XREDPJR5KWCA": restored("01M5V9FNPH0GA6XREDPJR5KWCA", {
    gaps: [
      { code: "journal-interrupted", count: 1, detail: "", kind: "capture" },
    ],
  }),
});

const manifests = async (
  run = "candidate-1",
  comparison: ReadonlyArray<string> = [],
) => {
  const sample = writeSample();
  const baseline = join(base, "out", "baseline.json");
  const candidate = join(base, "out", "candidate.json");
  await candidateMain(
    [
      "manifest",
      "baseline",
      "--sample",
      sample,
      "--floor",
      "first:cloud-2",
      "--out",
      baseline,
    ],
    { now: () => NOW },
  );
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  const candidateSummary = await candidateMain(
    [
      "manifest",
      "candidate",
      "--sample",
      sample,
      "--run",
      run,
      ...comparison,
      "--out",
      candidate,
    ],
    { now: () => NOW, reader: async () => READER },
  );
  return { baseline, candidate, candidateSummary };
};

// Why: the typed refusal must reach the manifest's scoring eligibility, not just its capture field.
test("a no-wire contract capture leaves no scorable candidate run", async () => {
  writeCorpus();
  writeCandidates();
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  const sample = writeSample();
  const baseline = join(base, "contract-baseline.json");
  const candidate = join(base, "contract-candidate.json");
  const dump = restored(RUN_B);
  const why = `no-wire-capture: contract contexts ${RUN_B}:1:find have no provider wire evidence; scoring refused`;
  const reader = readerOf({
    [RUN_B]: {
      ...dump,
      run: {
        ...dump.run,
        contractContexts: [
          {
            captureVersion: 1,
            coverage: "no-wire-capture",
            state: { contextKey: `${RUN_B}:1:find` },
          },
        ],
      },
    },
  });
  const summary = await candidateMain(
    [
      "manifest",
      "candidate",
      "--sample",
      sample,
      "--run",
      "candidate-1",
      "--out",
      candidate,
    ],
    { reader: async () => reader },
  );
  const manifest = Manifest.parse(JSON.parse(readFileSync(candidate, "utf8")));
  expect(manifest.cases[0]?.runs[0]?.capture).toEqual({
    status: "refused",
    why,
  });
  expect(manifest.cases[0]?.runs[0]?.blockers).toEqual([
    `capture refused: ${why}`,
  ]);
  expect(
    manifest.cases
      .flatMap((row) => row.runs)
      .filter((run) => run.blockers.length === 0),
  ).toEqual([]);
  expect(summary).toContain('"scorable": 0');
  await candidateMain([
    "manifest",
    "baseline",
    "--sample",
    sample,
    "--floor",
    "first:cloud-2",
    "--out",
    baseline,
  ]);
  const out = join(base, "contract-comparison");
  await candidateMain(
    ["compare", "--baseline", baseline, "--candidate", candidate, "--out", out],
    { reader: async () => reader },
  );
  const report = JSON.parse(readFileSync(join(out, "compare.json"), "utf8"));
  expect(report.tokens.ratios).toEqual({ read: null, output: null });
  expect(report.parity.failed).toContainEqual(
    expect.objectContaining({
      caseId: "github:pingdotgg/t3code:1",
      run: "candidate-1",
    }),
  );
});

const writeEffortCandidate = (
  effort: "low" | "medium",
  build: Record<string, unknown> = {},
  changes: Record<string, unknown> = {},
) => {
  const folder = writeCandidate(
    1,
    receipt(
      RUN_B,
      { route: { model: BUILD.model, effort }, ...changes },
      { input: 1200, output: 150, cacheRead: 5000 },
    ),
    {
      effort,
      settings: {
        ...BUILD.settings,
        review: { ...BUILD.settings.review, effort },
      },
      differences: ["productCommit", "effort"],
      policy: ["effort"],
      ...build,
    },
  );
  writeLabels(1, join(folder, "labels"), ["t1", "t2"], ["t1", "t2"]);
  return folder;
};

// Why (NEU-111): both permitted levels must reach the existing quality comparison, with their
// receipt efforts visible beside token ratios, without modifying the pinned high-effort baseline.
for (const effort of ["low", "medium"] as const)
  test(`a declared ${effort} effort-only difference is scored and labelled in every output`, async () => {
    writeCorpus();
    writeEffortCandidate(effort);
    const args = ["--effort-comparison", effort];
    const { baseline, candidate, candidateSummary } = await manifests(
      "candidate-1",
      args,
    );
    expect(candidateSummary).toContain(
      `candidate manifest (${effort} effort comparison):`,
    );
    const manifest = Manifest.parse(
      JSON.parse(readFileSync(candidate, "utf8")),
    );
    expect(manifest.effortComparison).toBe(effort);
    expect(manifest.cases[0]!.runs[0]!.route?.effort).toBe(effort);
    expect(manifest.cases[0]!.runs[0]!.blockers).toEqual([]);
    const out = join(base, "out", "compare");
    const summary = await candidateMain([
      "compare",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      out,
      ...args,
    ]);
    expect(summary).toContain(`(${effort} effort comparison)`);
    const report = JSON.parse(readFileSync(join(out, "compare.json"), "utf8"));
    expect(report.effortComparison).toBe(effort);
    expect(report.efforts).toEqual({ baseline: ["high"], candidate: [effort] });
    expect(
      report.parity.failed.some(
        (f: { caseId: string; run: string }) =>
          f.caseId.endsWith(":1") && f.run === "candidate-1",
      ),
    ).toBe(false);
    expect(report.tokens.ratios).toEqual({
      read: { cases: 1, min: 1.24, median: 1.24, max: 1.24 },
      output: { cases: 1, min: 1.5, median: 1.5, max: 1.5 },
    });
    const markdown = readFileSync(join(out, "compare.md"), "utf8");
    expect(markdown.split("\n")[0]).toBe(
      `# candidate-1, declared ${effort} effort, against the replay's first runs (high effort)`,
    );
    expect(markdown).toContain(`| Baseline (high effort) caught |`);
    expect(markdown).toContain(`| Candidate (${effort} effort) caught |`);
    expect(markdown).toContain(
      `## Tokens: Baseline (high effort); Candidate (${effort} effort)`,
    );
    expect(markdown).toContain('"median": 1.24');
    expect(JSON.parse(readFileSync(baseline, "utf8"))).not.toHaveProperty(
      "effortComparison",
    );
  });

// Why (NEU-111): the receipt, rather than the build's claimed effort, must match the named arm.
test("a mismatched receipt effort remains unscorable despite an effort-only policy record", async () => {
  writeCorpus();
  writeEffortCandidate(
    "medium",
    {},
    { route: { model: BUILD.model, effort: "low" } },
  );
  const { candidate } = await manifests("candidate-1", [
    "--effort-comparison",
    "medium",
  ]);
  const manifest = Manifest.parse(JSON.parse(readFileSync(candidate, "utf8")));
  expect(manifest.cases[0]!.runs[0]!.blockers).toEqual([
    "run policy differs from the replay run: effort",
    "receipt effort low does not match --effort-comparison medium",
  ]);
});

// Why (NEU-111): matching low and medium receipts still need the explicit opt-in to waive policy.
for (const effort of ["low", "medium"] as const)
  test(`without the flag a matching ${effort} receipt keeps the original policy refusal`, async () => {
    writeCorpus();
    writeEffortCandidate(effort);
    const { baseline, candidate } = await manifests();
    const manifest = Manifest.parse(
      JSON.parse(readFileSync(candidate, "utf8")),
    );
    expect(manifest).not.toHaveProperty("effortComparison");
    expect(manifest.cases[0]!.runs[0]!.blockers).toEqual([
      "run policy differs from the replay run: effort",
    ]);
    const out = join(base, "out", "compare");
    await candidateMain([
      "compare",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      out,
    ]);
    const report = JSON.parse(readFileSync(join(out, "compare.json"), "utf8"));
    expect(report).not.toHaveProperty("effortComparison");
    expect(report).not.toHaveProperty("efforts");
    expect(report.tokens.ratios).toEqual({ read: null, output: null });
    const markdown = readFileSync(join(out, "compare.md"), "utf8");
    expect(markdown.split("\n")[0]).toBe(
      "# candidate-1 against the replay's first runs",
    );
    expect(markdown).toContain(
      "| Group | Baseline caught | Baseline missed | Baseline lost | Candidate caught | Candidate missed | Candidate lost | Candidate not in mix |",
    );
    expect(markdown).toContain("\n## Tokens\n");
  });

// Why (NEU-111): opting into effort must not waive another policy or any existing admission blocker.
for (const [name, build, changes, blocker] of [
  [
    "model",
    { policy: ["effort", "model"] },
    { route: { model: "another-model", effort: "medium" } },
    "run policy differs from the replay run: effort, model",
  ],
  [
    "lifetime",
    { policy: ["effort", "lifetimeMs"] },
    { timeout: { lifetimeMs: 600_000, reached: false } },
    "run policy differs from the replay run: effort, lifetimeMs",
  ],
  [
    "undeclared build",
    { undeclared: ["graph"] },
    {},
    "undeclared build differences: graph",
  ],
  [
    "duplicate effort policy",
    { policy: ["effort", "effort"] },
    {},
    "run policy differs from the replay run: effort, effort",
  ],
  [
    "partial execution",
    {},
    { packet: { complete: false, batches: [{}] } },
    "execution partial: its packet is partial",
  ],
  [
    "incomplete capture",
    {},
    { runId: "01M5V9FNPH0GA6XREDPJR5KWCA" },
    "capture incomplete: journal-interrupted",
  ],
  [
    "control receipt",
    { control: { showSha256: "0".repeat(64) } },
    {},
    "its control's receipt (run/cloud/show.json) is not the one it was compared with",
  ],
] as const)
  test(`the effort opt-in preserves the ${name} blocker`, async () => {
    writeCorpus();
    writeEffortCandidate("medium", build, changes);
    const { candidate } = await manifests("candidate-1", [
      "--effort-comparison",
      "medium",
    ]);
    const manifest = Manifest.parse(
      JSON.parse(readFileSync(candidate, "utf8")),
    );
    expect(manifest.cases[0]!.runs[0]!.blockers).toEqual([blocker]);
  });

// Why (NEU-111): an opted-in manifest must never silently enable a comparison without the same opt-in.
test("compare requires the same effort declaration as the candidate manifest", async () => {
  writeCorpus();
  writeEffortCandidate("medium");
  const { baseline, candidate } = await manifests("candidate-1", [
    "--effort-comparison",
    "medium",
  ]);
  for (const args of [[], ["--effort-comparison", "low"]]) {
    const out = join(base, "refused");
    await expect(
      candidateMain([
        "compare",
        "--baseline",
        baseline,
        "--candidate",
        candidate,
        "--out",
        out,
        ...args,
      ]),
    ).rejects.toThrow("collect and compare with the same explicit effort");
    expect(existsSync(out)).toBe(false);
  }
});

// Why (NEU-111): a typo or a missing value must not silently fall back to the unchanged policy gate.
test("effort-comparison accepts only low or medium on candidate manifest and compare", async () => {
  for (const command of [["manifest", "candidate"], ["compare"]])
    for (const value of [[], ["high"], ["Medium"], ["--out"]])
      await expect(
        candidateMain([...command, "--effort-comparison", ...value]),
      ).rejects.toThrow();
  await expect(
    candidateMain(["manifest", "baseline", "--effort-comparison", "medium"]),
  ).rejects.toThrow("--effort-comparison is for manifest candidate or compare");
});

test("the candidate manifest keeps every case, each with why it may or may not be scored", async () => {
  writeCorpus();
  writeCandidates();
  const { baseline, candidate } = await manifests();
  const read = Manifest.parse(JSON.parse(readFileSync(candidate, "utf8")));
  expect(read).not.toHaveProperty("effortComparison");
  expect(
    read.cases.map((c) => [
      c.caseId,
      c.runs[0]!.execution.state,
      c.runs[0]!.blockers,
    ]),
  ).toEqual([
    ["github:pingdotgg/t3code:1", "completed", []],
    [
      "github:pingdotgg/t3code:2",
      "completed",
      ["run policy differs from the replay run: effort"],
    ],
    ["github:pingdotgg/t3code:3", "completed", []],
    [
      "github:pingdotgg/t3code:4",
      "completed",
      ["capture incomplete: journal-interrupted"],
    ],
  ]);
  const counts = read.counts["candidate-1"] as Record<string, number>;
  expect([
    counts["cases"],
    counts["receiptPresent"],
    counts["completed"],
    counts["scorable"],
    counts["matched"],
  ]).toEqual([4, 4, 4, 2, 2]);
  const first = Manifest.parse(JSON.parse(readFileSync(baseline, "utf8")))
    .counts["first"] as Record<string, number>;
  // A receipt present is not a review completed: case 3's timed out.
  expect([
    first["receiptPresent"],
    first["completed"],
    first["timed-out"],
  ]).toEqual([4, 3, 1]);
  expect(read.cases[0]!.threads).toEqual({
    rows: 3,
    labelled: 2,
    unlabelled: 1,
    substantive: 2,
  });
});

test("a missing, damaged or malformed receipt is its own state, never a completed review", async () => {
  writeCorpus();
  writeCandidates();
  rmSync(
    join(treatment, "cases", "t3code", "1", "run", "candidate-1", "show.json"),
  );
  writeFileSync(
    join(
      treatment,
      "cases",
      "t3code",
      "1",
      "run",
      "candidate-1",
      "show.damaged.json",
    ),
    "{",
  );
  writeFileSync(
    join(treatment, "cases", "t3code", "3", "run", "candidate-1", "show.json"),
    '{"type":"receipt"}',
  );
  rmSync(
    join(
      treatment,
      "cases",
      "t3code",
      "4",
      "run",
      "candidate-1",
      "capture.json",
    ),
  );
  // Case 2's snapshot is a held close: a partial run, named as such.
  const two = join(
    treatment,
    "cases",
    "t3code",
    "2",
    "run",
    "candidate-1",
    "capture.json",
  );
  writeFileSync(
    two,
    JSON.stringify({
      ...JSON.parse(readFileSync(two, "utf8")),
      close: { mode: "held", execution: "open" },
    }),
  );
  const { candidate } = await manifests();
  const runs = Manifest.parse(
    JSON.parse(readFileSync(candidate, "utf8")),
  ).cases.map((c) => c.runs[0]!);
  expect(runs[0]!.execution).toEqual({
    state: "malformed",
    why: "its receipt arrived damaged",
  });
  expect(runs[2]!.execution.state).toBe("malformed");
  expect(runs[1]!.blockers).toContain(
    "its snapshot is the held close, execution open: a partial run",
  );
  expect(runs[3]!.capture).toEqual({
    status: "missing",
    why: "no capture.json: no session dump was transferred",
  });
});

test("the comparison keeps every concern case in the denominator and lists what may regress", async () => {
  writeCorpus();
  writeCandidates();
  const { baseline, candidate } = await manifests();
  const out = join(base, "out", "compare");
  await candidateMain([
    "compare",
    "--baseline",
    baseline,
    "--candidate",
    candidate,
    "--out",
    out,
  ]);
  const report = JSON.parse(readFileSync(join(out, "compare.json"), "utf8"));
  expect(report.denominator.total).toEqual({
    baseline: { caught: 2, missed: 1, lost: 1, notInMix: 0 },
    candidate: { caught: 3, missed: 0, lost: 1, notInMix: 0 },
  });
  expect(
    report.parity.failed.map(
      (f: { caseId: string; run: string }) => `${f.caseId} ${f.run}`,
    ),
  ).toEqual([
    "github:pingdotgg/t3code:2 candidate-1",
    "github:pingdotgg/t3code:3 first",
    "github:pingdotgg/t3code:4 candidate-1",
  ]);
  expect([
    report.parity.caught.baseline,
    report.parity.caught.candidate,
  ]).toEqual([0.5, 1]);
  expect(report.flips).toEqual([
    {
      caseId: "github:pingdotgg/t3code:1",
      source: "t3code",
      ref: "t2",
      kind: "correctness",
      baseline: false,
      candidate: true,
    },
  ]);
  expect(report.unavailableLabels.bySource).toEqual({
    t3code: { threads: 8, unlabelled: 4 },
  });
  expect(report.tokens.baseline).toMatchObject({
    runs: 1,
    input: 1000,
    output: 100,
    cacheRead: 4000,
  });
  expect(report.tokens.candidate).toMatchObject({
    runs: 1,
    input: 1200,
    output: 150,
    cacheRead: 5000,
  });
  expect(report.tokens.ratios).toEqual({
    read: { cases: 1, min: 1.24, median: 1.24, max: 1.24 },
    output: { cases: 1, min: 1.5, median: 1.5, max: 1.5 },
  });
  expect(report.tokens.floor).toEqual([
    {
      pair: "first:cloud-2",
      ratios: {
        read: { cases: 1, min: 1.02, median: 1.02, max: 1.02 },
        output: { cases: 1, min: 1.2, median: 1.2, max: 1.2 },
      },
    },
  ]);
  expect(report.unresolved).toEqual([
    "github:pingdotgg/t3code:2: the baseline completed, the candidate may not be scored (run policy differs from the replay run: effort)",
    "github:pingdotgg/t3code:4: the baseline completed, the candidate may not be scored (capture incomplete: journal-interrupted)",
    "1 candidate capture(s) disclose journal-interrupted (capture incomplete)",
  ]);
  expect(readFileSync(join(out, "compare.md"), "utf8")).toContain(
    "| All | 2 | 1 | 1 | 3 | 0 | 1 | 0 |",
  );
});

test("a baseline file changed since its manifest stops the comparison before anything is read", async () => {
  writeCorpus();
  writeCandidates();
  const { baseline, candidate } = await manifests();
  writeFileSync(join(caseDir(2), "labels", "merit.json"), "{}");
  writeFileSync(
    join(caseDir(1), "run", "show.json"),
    receipt(RUN_A, { outcome: "timed-out" }),
  );
  const out = join(base, "out", "compare");
  await expect(
    candidateMain([
      "compare",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      out,
    ]),
  ).rejects.toThrow(
    `2 file(s) differ from the manifests; nothing compared:\nbaseline: ${join(caseDir(1), "run", "show.json")}: changed\nbaseline: ${join(caseDir(2), "labels", "merit.json")}: appeared`,
  );
  expect(existsSync(out)).toBe(false);
  await expect(candidateMain(["verify", baseline])).rejects.toThrow(
    "2 file(s) differ",
  );
});

const writeFloorCase = (number: number) => {
  const concerns = writeCase(number);
  writeLabels(number, join(caseDir(number), "labels"), concerns, concerns);
  writeFirst(number, receipt(RUN_A));
  const repeat = join(caseDir(number), "run", "cloud-2");
  mkdirSync(repeat, { recursive: true });
  writeFileSync(join(repeat, "show.json"), receipt(RUN_A));
  writeLabels(number, join(repeat, "labels"), concerns, concerns);
};

test.each([
  [
    "changed floor labels",
    () => writeFileSync(join(caseDir(5), "labels", "matching.json"), "{}"),
    "matching.json: changed",
  ],
  [
    "changed matching pass",
    () =>
      writeFileSync(
        join(caseDir(5), "labels", "matching", "pass-a", "output.json"),
        "{}",
      ),
    "output.json: changed",
  ],
  [
    "new matching pass",
    () => {
      const folder = join(caseDir(5), "labels", "matching", "pass-c");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "output.json"), "{}");
    },
    "output.json: appeared",
  ],
  [
    "newly eligible labels",
    () =>
      writeFileSync(
        join(caseDir(6), "run", "cloud-2", "labels", "matching.json"),
        "{}",
      ),
    "matching.json: appeared",
  ],
  [
    "newly eligible receipt",
    () => {
      const folder = join(caseDir(7), "run", "cloud-2");
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "show.json"), receipt(RUN_A));
    },
    "show.json: appeared",
  ],
  ["new development case", () => writeFloorCase(8), "floor universe: appeared"],
] as const)(
  "the pinned floor rejects %s outside the comparison sample",
  async (_name, mutate, why) => {
    writeCorpus();
    writeCandidates();
    writeFloorCase(5);
    writeFloorCase(6);
    rmSync(join(caseDir(6), "run", "cloud-2", "labels", "matching.json"));
    writeCase(7);
    const { baseline, candidate } = await manifests();
    const pinned = Manifest.parse(JSON.parse(readFileSync(baseline, "utf8")));
    const out = join(base, "out", "before");
    const compare = (destination: string) =>
      candidateMain([
        "compare",
        "--baseline",
        baseline,
        "--candidate",
        candidate,
        "--out",
        destination,
      ]);
    await compare(out);
    const report = JSON.parse(readFileSync(join(out, "compare.json"), "utf8"));
    expect(pinned.floorUniverse?.map((entry) => entry.caseId).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map(
        (number) => `github:pingdotgg/t3code:${number}`,
      ),
    );
    expect(pinned.cases).toHaveLength(4);
    expect(pinned.sample?.cases).toBe(4);
    expect(pinned.counts["first"]).toMatchObject({ cases: 4 });
    expect(report.denominator.total).toEqual({
      baseline: { caught: 2, missed: 1, lost: 1, notInMix: 0 },
      candidate: { caught: 3, missed: 0, lost: 1, notInMix: 0 },
    });
    expect(report.parity.floor.cases).toBe(2);
    mutate();
    await expect(candidateMain(["verify", baseline])).rejects.toThrow(why);
    const after = join(base, "out", "after");
    await expect(compare(after)).rejects.toThrow(why);
    expect(existsSync(after)).toBe(false);
  },
);

test("the public dump reader keeps its typed rejection reason", async () => {
  const reader = await loadSessionDumpReader();
  expect(typeof reader).toBe("function");
  const directory = join(base, "missing-dump");
  expect(
    await readCandidateCapture(
      directory,
      { runId: RUN_A, redaction: "portable" },
      reader,
    ),
  ).toEqual({
    status: "unreadable",
    why: `the reader rejected ${directory}: no such directory`,
  });
});

test("an unmatched scorable candidate stops the comparison even where its baseline failed", async () => {
  writeCorpus();
  writeCandidates();
  rmSync(
    join(treatment, "cases", "t3code", "3", "run", "candidate-1", "labels"),
    { recursive: true },
  );
  const { baseline, candidate } = await manifests();
  await expect(
    candidateMain([
      "compare",
      "--baseline",
      baseline,
      "--candidate",
      candidate,
      "--out",
      join(base, "c"),
    ]),
  ).rejects.toThrow(
    "1 scorable run(s) are not matched yet; match (and confirm) them before comparing:\n- github:pingdotgg/t3code:3 (candidate-1)",
  );
});

test("nothing is written into the research volume, and nothing twice", async () => {
  writeCorpus();
  const sample = writeSample();
  await expect(
    candidateMain([
      "manifest",
      "baseline",
      "--sample",
      sample,
      "--floor",
      "first:cloud-2",
      "--out",
      join(research, "m.json"),
    ]),
  ).rejects.toThrow("inside the research volume");
  const out = join(base, "m.json");
  await candidateMain(
    [
      "manifest",
      "baseline",
      "--sample",
      sample,
      "--floor",
      "first:cloud-2",
      "--out",
      out,
    ],
    { now: () => NOW },
  );
  await expect(
    candidateMain([
      "manifest",
      "baseline",
      "--sample",
      sample,
      "--floor",
      "first:cloud-2",
      "--out",
      out,
    ]),
  ).rejects.toThrow("is written once");
  expect(await candidateMain(["verify", out])).toBe(
    `${out}: every file as recorded`,
  );
});

test("manifest output refuses research aliases before creating absent descendants", async () => {
  mkdirSync(join(research, "cases"));
  const alias = join(base, "outside-alias");
  symlinkSync(research, alias, "dir");
  const researchAlias = join(base, "research-alias");
  symlinkSync(research, researchAlias, "dir");
  process.env["NEUVE_RESEARCH_ROOT"] = researchAlias;
  for (const suffix of ["manifest.json", "absent/nested/manifest.json"]) {
    await expect(
      candidateMain(["manifest", "inventory", "--out", join(alias, suffix)]),
    ).rejects.toThrow("inside the research volume");
  }
  expect(readdirSync(research)).toEqual(["cases"]);
});

test("manifest output accepts fresh outside descendants and outside directory aliases", async () => {
  mkdirSync(join(research, "cases"));
  const outside = join(base, "outside");
  mkdirSync(outside);
  const alias = join(base, "outside-alias");
  symlinkSync(outside, alias, "dir");
  for (const directory of [outside, alias]) {
    const out = join(
      directory,
      directory === outside ? "ordinary" : "alias",
      "nested",
      "manifest.json",
    );
    await candidateMain(["manifest", "inventory", "--out", out]);
    expect(JSON.parse(readFileSync(out, "utf8")).cases).toEqual([]);
    await expect(
      candidateMain(["manifest", "inventory", "--out", out]),
    ).rejects.toThrow("written once");
  }
  expect(readdirSync(research)).toEqual(["cases"]);
});

test("a dangling output ancestor is refused without creating its research target", async () => {
  mkdirSync(join(research, "cases"));
  const alias = join(base, "dangling-alias");
  symlinkSync(join(research, "absent"), alias, "dir");
  await expect(
    candidateMain([
      "manifest",
      "inventory",
      "--out",
      join(alias, "nested", "manifest.json"),
    ]),
  ).rejects.toThrow();
  expect(readdirSync(research)).toEqual(["cases"]);
});

const publicCaptureFixture = async (nativeDatabase?: string) => {
  writeLabels(1, join(caseDir(1), "labels"), writeCase(1), ["t1"]);
  writeFirst(1, receipt(RUN_A));
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  const folder = writeCandidate(1, receipt(RUN_B));
  const journal = join(base, "journal");
  const capture = openCaptureJournal(journal, RUN_B);
  capture.capture({
    type: "run.start",
    scope: { runId: RUN_B },
    runKind: "scored",
    sourceRevision: "synthetic",
    route: "openai",
    pricing: "subscription",
  });
  // Why (12.41): this fixture is incomplete because a returned finding has no fate.
  capture.capture({
    type: "findings.returned",
    scope: { runId: RUN_B, stage: "find" },
    findingIds: ["correctness.1"],
  });
  capture.capture({
    type: "artifact",
    scope: { runId: RUN_B },
    name: "synthetic.txt",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("synthetic artifact\n"),
  });
  capture.capture({
    type: "run.end",
    scope: { runId: RUN_B },
    status: "completed",
  });
  capture.close();
  const location = storeLocationIn(join(base, "capture-records"));
  const inStore = runIn(location);
  const raw = value(
    await inStore(captureRunDump({ runId: RUN_B, journal, nativeDatabase })),
  );
  value(await inStore(scanCaptures(location)));
  const dumped = value(
    await inStore(
      exportCapturedDump({
        capture: raw.capture,
        root: join(folder, "capture"),
        retention: { policy: "synthetic" },
      }),
    ),
  );
  writeFileSync(
    join(folder, "capture.json"),
    JSON.stringify({
      run: RUN_B,
      redaction: "restricted",
      kind: "scored",
      snapshot: dumped.snapshotId,
      close: { mode: "ended", execution: "ended" },
    }),
  );
  const tar = Bun.spawnSync([
    "tar",
    "-C",
    join(folder, "capture"),
    "-cf",
    join(folder, "capture.tar"),
    `restricted/scored/${RUN_B}/${dumped.snapshotId}`,
  ]);
  expect(tar.exitCode).toBe(0);
  const sample = join(base, "public-sample.json");
  writeFileSync(
    sample,
    JSON.stringify({
      seed: "synthetic",
      concerns: ["github:pingdotgg/t3code:1"],
      controls: [],
    }),
  );
  const baseline = join(base, "baseline.json");
  const candidate = join(base, "candidate.json");
  await actualCandidateMain([
    "manifest",
    "baseline",
    "--sample",
    sample,
    "--floor",
    "first:cloud-2",
    "--out",
    baseline,
  ]);
  await actualCandidateMain([
    "manifest",
    "candidate",
    "--sample",
    sample,
    "--run",
    "candidate-1",
    "--out",
    candidate,
  ]);
  const restored = await Effect.runPromise(readSessionDump(dumped.directory));
  return { folder, directory: dumped.directory, restored, baseline, candidate };
};

// Why: inspection still needs the durable observations that scoring refuses.
test("the public reader retains a contract capture that the evaluator refuses", async () => {
  const w = await setup("evaluation-inspection", [
    async (turn) => {
      const call = submit(`submit-${turn.turnId}`, 2);
      await turn.message([call], { usage });
      await turn.charge(usage);
      await turn.invoke(call, turn.signal);
    },
  ]);
  try {
    await w.start();
    const { directory, restored } = await publicCaptureFixture(w.run.database);
    const contexts = restored.run.contractContexts;
    expect(contexts).toHaveLength(1);
    expect(contexts?.[0]).toMatchObject({
      captureVersion: 1,
      coverage: "no-wire-capture",
    });
    const { captureVersion: _, ...legacy } = ContractContextCapture.parse(
      contexts?.[0],
    );
    expect(ContractContextCapture.parse(legacy).captureVersion).toBe(1);
    const reader = await loadSessionDumpReader();
    const read = await readCandidateCapture(
      directory,
      { runId: RUN_B, redaction: "restricted" },
      reader,
    );
    expect(read).toEqual({
      status: "refused",
      why: `no-wire-capture: contract contexts ${contexts?.[0]?.state.contextKey} have no provider wire evidence; scoring refused`,
    });
  } finally {
    await w.close();
  }
});

test("an unchanged public export with its normal tar verifies and retains its incomplete case", async () => {
  const { candidate, baseline } = await publicCaptureFixture();
  expect(await actualCandidateMain(["verify", candidate])).toContain(
    "every file as recorded",
  );
  const manifest = Manifest.parse(JSON.parse(readFileSync(candidate, "utf8")));
  expect(manifest.cases[0]!.runs[0]!.capture?.status).toBe("incomplete");
  const out = join(base, "public-report");
  await actualCandidateMain([
    "compare",
    "--baseline",
    baseline,
    "--candidate",
    candidate,
    "--out",
    out,
  ]);
  const report = JSON.parse(readFileSync(join(out, "compare.json"), "utf8"));
  expect(report.cases).toBe(1);
  expect(report.parity.failed).toHaveLength(1);
});

for (const shape of ["changed", "removed", "linked"] as const)
  test(`public capture closure ${shape} paths refuse verification and comparison with an unchanged tar`, async () => {
    const { candidate, baseline, directory, restored } =
      await publicCaptureFixture();
    const paths = [
      "export.json",
      "manifest.json",
      ...new Set(
        restored.manifest.files.map((file) => `objects/${file.sha256}`),
      ),
    ];
    for (const relative of paths) {
      const path = join(directory, relative);
      const bytes = readFileSync(path);
      if (shape === "changed")
        writeFileSync(
          path,
          relative === "export.json"
            ? `${bytes.toString().trim()}\n\n`
            : "changed\n",
        );
      else {
        rmSync(path);
        if (shape === "linked") {
          const replacement = join(base, "substitute");
          writeFileSync(replacement, bytes);
          symlinkSync(replacement, path);
        }
      }
      await expect(
        actualCandidateMain(["verify", candidate]),
      ).rejects.toThrow();
      const out = join(base, "refused-report");
      await expect(
        actualCandidateMain([
          "compare",
          "--baseline",
          baseline,
          "--candidate",
          candidate,
          "--out",
          out,
        ]),
      ).rejects.toThrow();
      expect(existsSync(out)).toBe(false);
      rmSync(path, { force: true });
      writeFileSync(path, bytes);
    }
    expect(await actualCandidateMain(["verify", candidate])).toContain(
      "every file as recorded",
    );
    const unexpected = join(directory, "objects", "0".repeat(64));
    writeFileSync(unexpected, "unexpected");
    await expect(actualCandidateMain(["verify", candidate])).rejects.toThrow(
      "capture facts changed",
    );
  });

test("version 2 manifests explicitly require re-collection with the same sample and floor", async () => {
  const path = join(base, "v2.json");
  writeFileSync(path, JSON.stringify({ version: 2 }));
  await expect(actualCandidateMain(["verify", path])).rejects.toThrow(
    "re-collect with the same sample and floor",
  );
});

test("invalid candidate names and escaping runs never fall back to the research volume", () => {
  for (const run of [
    "candidate-0",
    "candidate-01",
    "candidate-010",
    "candidate--1",
    "candidate-10/../cloud",
    "../candidate-10",
    "candidate-10\\outside",
    "candidate-10\n",
    "candidate-10\0",
    "..",
    ".",
  ]) {
    expect(() => runFolder(caseDir(7), run)).toThrow();
    process.env["NEUVE_TREATMENT_ROOT"] = treatment;
    expect(() => runFolder(caseDir(7), run)).toThrow();
    delete process.env["NEUVE_TREATMENT_ROOT"];
  }
  expect(readdirSync(research)).toEqual([]);
  expect(existsSync(treatment)).toBe(false);
});

test("candidate-10 is manifested with its treatment capture and matching labels", async () => {
  writeCorpus();
  const folder = writeCandidate(1, receipt(RUN_B), {}, "candidate-10");
  writeLabels(1, join(folder, "labels"), ["t1", "t2"], ["t1", "t2"]);
  const { candidate } = await manifests("candidate-10");
  const read = Manifest.parse(JSON.parse(readFileSync(candidate, "utf8")));
  expect(read.counts["candidate-10"]).toMatchObject({
    cases: 4,
    receiptPresent: 1,
    completed: 1,
    scorable: 1,
    matched: 1,
  });
  expect(read.cases[0]!.runs[0]!.blockers).toEqual([]);
  expect(read.cases[0]!.runs[0]!.execution.state).toBe("completed");
  expect(existsSync(join(caseDir(1), "run", "candidate-10"))).toBe(false);
});

test("the candidate manifest CLI refuses malformed and escaping run names before writing", async () => {
  writeCorpus();
  const sample = writeSample();
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  const out = join(base, "refused.json");
  for (const run of [
    "candidate-0",
    "candidate-01",
    "candidate--10",
    "candidate-10/../cloud",
    "../candidate-10",
  ]) {
    await expect(
      candidateMain([
        "manifest",
        "candidate",
        "--sample",
        sample,
        "--run",
        run,
        "--out",
        out,
      ]),
    ).rejects.toThrow("--run takes candidate-<k>");
    expect(existsSync(out)).toBe(false);
  }
});
