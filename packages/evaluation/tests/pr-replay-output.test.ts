import { CaseRecord } from "../src/pr-replay/schema.ts";
import {
  matchCase,
  settleMatching,
  tiebreakMatching,
} from "../src/pr-replay/matching.ts";
import { settleConfirm } from "../src/pr-replay/confirm.ts";
import {
  RUBRICS,
  judgeRubric,
  promptDigest,
} from "../src/pr-replay/rubric-judge.ts";
import { TITLE_RUBRIC_QUESTIONS } from "../src/harness-compare/full-test/title-rubric.ts";
// These tests use real files because alias safety depends on filesystem open/rename behavior.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendOutput,
  treatmentWrite,
  writeOutput,
} from "../src/pr-replay/sources.ts";
import { writeJson } from "../src/pr-replay/parity.ts";
import {
  DISABLED_FEATURES,
  PINNED_CODEX_VERSION,
  PINNED_LINUX_INSTALL_HASH,
  SAFE_ENABLED_FEATURES,
  runToolless,
  setCloudCaller,
} from "../src/pr-replay/codex.ts";

const record = {
  version: 1,
  caseId: "github:pingdotgg/t3code:1",
  source: "t3code",
  provider: "github",
  number: 1,
  title: "a change",
  url: "https://github.com/pingdotgg/t3code/pull/1",
  author: "someone",
  createdAt: "2026-01-01T00:00:00Z",
  outcome: "merged",
  family: "f1",
  split: "development",
  era: "2026",
  control: null,
  selection: { score: 1, reasons: [] },
  firstRevision: null,
  later: null,
  size: null,
  capture: { at: "2026-01-01T00:00:00Z", files: [] },
  clone: null,
  checks: null,
  unavailable: null,
};

let base: string, research: string, treatment: string;
const environment = { ...process.env };
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "replay-output-"));
  research = join(base, "research");
  treatment = join(base, "treatment");
  mkdirSync(research);
  mkdirSync(treatment);
  process.env["NEUVE_RESEARCH_ROOT"] = research;
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
});
afterEach(() => {
  setCloudCaller(undefined);
  process.env = { ...environment };
  rmSync(base, { recursive: true, force: true });
});

test("whole candidate files refuse existing/dangling leaf aliases at every writer family", () => {
  for (const name of [
    "matching-key.json",
    "matching.json",
    "merit.json",
    "pass-a-0.json",
    "merit-regrade.json",
    "schema.json",
    "output.json",
    "events.jsonl",
    "confirmation.json",
    "report.json",
    "decided.json",
  ]) {
    for (const existing of [false, true]) {
      const protectedPath = join(research, `${existing}-${name}`);
      if (existing) writeFileSync(protectedPath, "baseline sentinel\n");
      const target = join(treatment, name);
      symlinkSync(protectedPath, target);
      expect(() => writeOutput(target, "candidate\n")).toThrow();
      expect(existsSync(protectedPath)).toBe(existing);
      if (existing)
        expect(readFileSync(protectedPath, "utf8")).toBe("baseline sentinel\n");
      unlinkSync(target);
    }
  }
});

test("full destination admission rejects research/outside ancestors and accepts inside aliases", () => {
  for (const target of [research, join(base, "outside")]) {
    mkdirSync(target, { recursive: true });
    const alias = join(treatment, "alias");
    symlinkSync(target, alias);
    expect(() => treatmentWrite(join(alias, "absent", "file.json"))).toThrow();
    expect(existsSync(join(target, "absent"))).toBe(false);
    unlinkSync(alias);
  }
  const inner = join(treatment, "inner");
  mkdirSync(inner);
  symlinkSync(inner, join(treatment, "alias"));
  writeOutput(join(treatment, "alias", "file.json"), "candidate\n");
  expect(readFileSync(join(inner, "file.json"), "utf8")).toBe("candidate\n");
});

test("replacement detaches hard-linked whole files, confirmation included, and remains resumable", () => {
  const protectedPath = join(research, "protected");
  writeFileSync(protectedPath, "baseline sentinel\n");
  const target = join(treatment, "merit.json");
  linkSync(protectedPath, target);
  writeOutput(target, "candidate one\n");
  writeOutput(target, "candidate two\n");
  expect(readFileSync(protectedPath, "utf8")).toBe("baseline sentinel\n");
  expect(readFileSync(target, "utf8")).toBe("candidate two\n");
  const confirmation = join(treatment, "confirmation.json");
  linkSync(protectedPath, confirmation);
  const oldPartial = `${confirmation}.partial-${process.pid}`;
  symlinkSync(protectedPath, oldPartial);
  writeJson(confirmation, { version: 1 });
  expect(JSON.parse(readFileSync(confirmation, "utf8"))).toEqual({
    version: 1,
  });
  expect(readFileSync(protectedPath, "utf8")).toBe("baseline sentinel\n");
  expect(lstatSync(oldPartial).isSymbolicLink()).toBe(true);
});

test("append refuses leaf symlinks and shared inodes while repeated normal appends retain the file", () => {
  const protectedPath = join(research, "protected");
  writeFileSync(protectedPath, "baseline sentinel\n");
  const target = join(treatment, "anchor-errors.jsonl");
  for (const linked of [protectedPath, join(research, "missing")]) {
    symlinkSync(linked, target);
    expect(() => appendOutput(target, "candidate\n")).toThrow();
    unlinkSync(target);
  }
  linkSync(protectedPath, target);
  expect(() => appendOutput(target, "candidate\n")).toThrow("one link");
  unlinkSync(target);
  expect(readFileSync(protectedPath, "utf8")).toBe("baseline sentinel\n");
  expect(existsSync(join(research, "missing"))).toBe(false);
  appendOutput(target, "first\n");
  const inode = lstatSync(target).ino;
  appendOutput(target, "second\n");
  expect(lstatSync(target).ino).toBe(inode);
  expect(readFileSync(target, "utf8")).toBe("first\nsecond\n");
});

test("Codex refuses a concrete schema/log alias before invoking its cloud boundary", async () => {
  process.env["NEUVE_LABEL_RUNNER"] = "cloud";
  const runDir = join(treatment, "pass");
  mkdirSync(runDir);
  const protectedPath = join(research, "sentinel");
  writeFileSync(protectedPath, "baseline sentinel\n");
  let calls = 0;
  setCloudCaller(async () => {
    calls++;
    throw new Error("unexpected cloud call");
  });
  for (const path of [
    join(runDir, "schema.json"),
    join(treatment, "log.jsonl"),
  ]) {
    symlinkSync(protectedPath, path);
    await expect(
      runToolless(
        {
          runDir,
          log: join(treatment, "log.jsonl"),
          prompt: "p",
          schema: {},
          effort: "medium",
        },
        [],
      ),
    ).rejects.toThrow("treatment only");
    unlinkSync(path);
  }
  expect(calls).toBe(0);
  expect(readFileSync(protectedPath, "utf8")).toBe("baseline sentinel\n");
});

test("public merit command rejects linked research targets and replaces hard links without model calls", () => {
  const caseDir = join(research, "cases/t3code/1");
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "case.json"), JSON.stringify(record));
  const labels = join(treatment, "cases/t3code/1/run/candidate-1/labels");
  mkdirSync(labels, { recursive: true });
  writeFileSync(join(dirname(labels), "show.json"), '{"packet":null}');
  writeFileSync(join(labels, "matching-key.json"), '{"items":[]}');
  writeFileSync(join(labels, "matching.json"), '{"pairs":[]}');
  const cli = () =>
    Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../src/pr-replay/cli.ts"),
        "merit",
        "t3code",
        "1",
        "--run",
        "candidate-1",
      ],
      { env: process.env, stdout: "pipe", stderr: "pipe" },
    );
  const output = join(labels, "merit.json");
  for (const existing of [false, true]) {
    const protectedPath = join(research, `${existing}.json`);
    if (existing) writeFileSync(protectedPath, "baseline sentinel\n");
    symlinkSync(protectedPath, output);
    expect(cli().exitCode).not.toBe(0);
    expect(existsSync(protectedPath)).toBe(existing);
    if (existing)
      expect(readFileSync(protectedPath, "utf8")).toBe("baseline sentinel\n");
    unlinkSync(output);
  }
  linkSync(join(research, "true.json"), output);
  expect(cli().exitCode).toBe(0);
  expect(cli().exitCode).toBe(0);
  expect(readFileSync(join(research, "true.json"), "utf8")).toBe(
    "baseline sentinel\n",
  );
  expect(JSON.parse(readFileSync(output, "utf8")).summary.items).toBe(0);
});

test("established non-treatment outputs still allow ordinary research writes", () => {
  delete process.env["NEUVE_TREATMENT_ROOT"];
  const output = join(research, "legacy");
  writeOutput(output, "first\n");
  appendOutput(output, "second\n");
  expect(readFileSync(output, "utf8")).toBe("first\nsecond\n");
});

test("matching settlement, confirmation reports and cached rubric decisions admit their final leaves", async () => {
  const protectedPath = join(research, "sentinel");
  writeFileSync(protectedPath, "baseline sentinel\n");
  const labels = join(treatment, "cases/t3code/1/run/candidate-1/labels");
  mkdirSync(labels, { recursive: true });
  symlinkSync(protectedPath, join(labels, "matching.json"));
  const caseLabels = join(research, "cases/t3code/1/labels");
  mkdirSync(caseLabels, { recursive: true });
  writeFileSync(
    join(caseLabels, "rework.json"),
    JSON.stringify({
      version: 1,
      caseId: record.caseId,
      firstLines: 0,
      landed: null,
      windowEnd: null,
      untracked: 0,
      lines: {},
      notes: [],
    }),
  );
  const matching = () =>
    settleMatching(CaseRecord.parse(record), {
      run: "candidate-1",
      key: { seed: 1, items: [], verdicts: [], unplaced: [] },
      diffs: [],
      passes: { a: null, b: null },
      failures: [],
      receipts: [],
      substantive: new Set(),
    });
  await expect(matching()).rejects.toThrow("treatment only");
  unlinkSync(join(labels, "matching.json"));
  await matching();
  expect(
    JSON.parse(readFileSync(join(labels, "matching.json"), "utf8")).summary
      .caseId,
  ).toBe(record.caseId);
  const folder = join(treatment, "confirm");
  mkdirSync(folder);
  writeFileSync(
    join(folder, "key.json"),
    JSON.stringify({
      run: "candidate-1",
      cases: [],
      keys: [],
      matchedOutsideWindow: 0,
    }),
  );
  writeFileSync(join(folder, "decided.json"), '{"version":1,"answers":[]}');
  symlinkSync(protectedPath, join(folder, "report.json"));
  expect(() => settleConfirm(folder)).toThrow("treatment only");
  const rubric = join(treatment, "rubric");
  mkdirSync(rubric);
  const items = join(rubric, "items.json");
  writeFileSync(
    items,
    JSON.stringify({
      version: 1,
      questions: TITLE_RUBRIC_QUESTIONS,
      chunks: [
        [
          {
            id: "t000000000001",
            title: "Change",
            changes: ["Change."],
            paths: ["a.ts"],
          },
        ],
      ],
    }),
  );
  writeFileSync(
    join(rubric, "decided-0.json"),
    JSON.stringify({
      promptDigest: promptDigest(RUBRICS.t),
      answers: [
        {
          id: "t000000000001",
          namesMain: "yes",
          coversRest: "not-applicable",
          oneStatement: "yes",
          whereToLook: "yes",
          reason: "",
        },
      ],
    }),
  );
  symlinkSync(protectedPath, join(rubric, "decided.json"));
  await expect(judgeRubric(items, rubric)).rejects.toThrow("treatment only");
  expect(readFileSync(protectedPath, "utf8")).toBe("baseline sentinel\n");
});

const titleItem = {
  id: "t000000000001",
  title: "Change",
  changes: ["Change."],
  paths: ["a.ts"],
};

test("rubric admits every chunk, cached pass, conditional third, log and model leaf before any cloud call", async () => {
  process.env["NEUVE_LABEL_RUNNER"] = "cloud";
  const folder = join(treatment, "rubric-plan");
  mkdirSync(folder);
  const items = join(folder, "items.json");
  writeFileSync(
    items,
    JSON.stringify({
      version: 1,
      questions: TITLE_RUBRIC_QUESTIONS,
      chunks: [[titleItem], [{ ...titleItem, id: "t000000000002" }]],
    }),
  );
  const names = ["decided.json"];
  for (const at of [0, 1]) {
    names.push(`decided-${at}.json`, `chunk-${at}.claim`);
    for (const pass of ["a", "b", "c"])
      names.push(
        `pass-${pass}-${at}.json`,
        `pass-${pass}-${at}`,
        `pass-${pass}-${at}/schema.json`,
        `pass-${pass}-${at}/output.json`,
        `rubric-${pass}-${at}.jsonl`,
      );
  }
  let calls = 0;
  setCloudCaller(async () => {
    calls++;
    throw new Error("unexpected cloud call");
  });
  for (const existing of [false, true]) {
    const sentinel = join(research, `rubric-${existing}`);
    if (existing) writeFileSync(sentinel, "{}\n");
    for (const name of names) {
      const path = join(folder, name);
      mkdirSync(dirname(path), { recursive: true });
      rmSync(path, { recursive: true, force: true });
      symlinkSync(sentinel, path);
      await expect(judgeRubric(items, folder)).rejects.toThrow();
      expect(calls).toBe(0);
      expect(existsSync(sentinel)).toBe(existing);
      if (existing) expect(readFileSync(sentinel, "utf8")).toBe("{}\n");
      unlinkSync(path);
    }
  }
});

test("matching admits all first and third pass outputs and its summary before any cloud call", async () => {
  process.env["NEUVE_LABEL_RUNNER"] = "cloud";
  const folder = join(treatment, "cases/t3code/1/run/candidate-1/labels");
  mkdirSync(folder, { recursive: true });
  const names = ["matching-key.json", "matching.json"];
  for (const pass of ["a", "b", "c"])
    names.push(
      `matching/pass-${pass}`,
      `matching/pass-${pass}/schema.json`,
      `matching/pass-${pass}/output.json`,
      `logs/matching-${pass}.jsonl`,
    );
  let calls = 0;
  setCloudCaller(async () => {
    calls++;
    throw new Error("unexpected cloud call");
  });
  for (const existing of [false, true]) {
    const sentinel = join(research, `matching-${existing}`);
    if (existing) writeFileSync(sentinel, "{}\n");
    for (const name of names) {
      const path = join(folder, name);
      mkdirSync(dirname(path), { recursive: true });
      rmSync(path, { recursive: true, force: true });
      symlinkSync(sentinel, path);
      await expect(
        matchCase(CaseRecord.parse(record), "candidate-1"),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(existsSync(sentinel)).toBe(existing);
      if (existing) expect(readFileSync(sentinel, "utf8")).toBe("{}\n");
      unlinkSync(path);
    }
  }
});

const cloudFixture = () => {
  mkdirSync(join(research, "codex-catalog"), { recursive: true });
  writeFileSync(
    join(research, "codex-catalog/gpt-6.1-sol.json"),
    JSON.stringify({
      models: [
        {
          slug: "gpt-6.1-sol",
          tool_mode: "code_mode_only",
          experimental_supported_tools: [],
          upgrade: null,
          shell_type: "unified_exec",
          apply_patch_tool_type: "freeform",
          supports_search_tool: true,
          node_repl_disabled: false,
          multi_agent_version: "v2",
          web_search_tool_type: "text_and_image",
        },
      ],
    }),
  );
  const facts = {
    installHash: PINNED_LINUX_INSTALL_HASH,
    modelsCache: null,
    modelsCacheSha256: null,
    homeFiles: ["auth.json"],
  };
  const probe = {
    ...facts,
    version: `${PINNED_CODEX_VERSION}\n`,
    features: [
      ...DISABLED_FEATURES.map((name) => `${name} stable false`),
      ...[...SAFE_ENABLED_FEATURES].map((name) => `${name} stable true`),
    ].join("\n"),
    configSources: [],
    created: [],
  };
  const done = (output: unknown) => ({
    stdout: '{"type":"turn.completed"}\n',
    stderr: "",
    code: 0,
    timedOut: false,
    wallSeconds: 1,
    output: JSON.stringify(output),
    after: facts,
    created: [],
  });
  return { probe, done };
};

test("valid treatment rubric runs its conditional third pass, detaches a summary hardlink and resumes without cloud calls", async () => {
  process.env["NEUVE_LABEL_RUNNER"] = "cloud";
  const cloud = cloudFixture();
  const folder = join(treatment, "valid-rubric");
  mkdirSync(folder);
  const items = join(folder, "items.json");
  writeFileSync(
    items,
    JSON.stringify({
      version: 1,
      questions: TITLE_RUBRIC_QUESTIONS,
      chunks: [[titleItem]],
    }),
  );
  const sentinel = join(research, "hardlink-summary");
  writeFileSync(sentinel, "baseline sentinel\n");
  linkSync(sentinel, join(folder, "decided.json"));
  const requests: string[] = [];
  let passes = 0;
  setCloudCaller(async (request) => {
    requests.push(String(request["command"]));
    if (request["command"] === "probe") return cloud.probe;
    passes++;
    return cloud.done({
      answers: [
        {
          id: titleItem.id,
          namesMain: passes === 2 ? "no" : "yes",
          coversRest: "not-applicable",
          oneStatement: "yes",
          whereToLook: "yes",
          reason: passes === 2 ? "The title omits the change." : "",
        },
      ],
    });
  });
  expect(await judgeRubric(items, folder)).toMatchObject({
    thirds: 1,
    decided: 1,
    failed: [],
  });
  expect(requests).toEqual(["probe", "exec", "exec", "exec"]);
  expect(readFileSync(sentinel, "utf8")).toBe("baseline sentinel\n");
  expect(
    JSON.parse(readFileSync(join(folder, "decided.json"), "utf8")).answers[0]
      .namesMain,
  ).toBe("yes");
  expect(await judgeRubric(items, folder)).toMatchObject({
    decided: 1,
    done: [],
  });
  expect(requests).toHaveLength(4);
  rmSync(join(folder, "decided-0.json"));
  expect(await judgeRubric(items, folder)).toMatchObject({
    thirds: 1,
    decided: 1,
  });
  expect(requests).toHaveLength(4);
});

test("matching summary admission precedes an actual third pass, whose valid treatment output can settle", async () => {
  process.env["NEUVE_LABEL_RUNNER"] = "cloud";
  const cloud = cloudFixture();
  const directory = join(treatment, "cases/t3code/1/run/candidate-1/labels");
  const caseLabels = join(research, "cases/t3code/1/labels");
  mkdirSync(directory, { recursive: true });
  mkdirSync(caseLabels, { recursive: true });
  writeFileSync(join(caseLabels, "concerns.jsonl"), "");
  writeFileSync(
    join(caseLabels, "rework.json"),
    JSON.stringify({
      version: 1,
      caseId: record.caseId,
      firstLines: 0,
      landed: null,
      windowEnd: null,
      untracked: 0,
      lines: {},
      notes: [],
    }),
  );
  const item = {
    id: "n1",
    source: "neuve",
    group: "comment",
    ref: "comment-1",
    repeats: [],
    path: "a.ts",
    line: 1,
    anchoredTo: "line",
    text: "A concern",
  };
  writeFileSync(
    join(directory, "matching-key.json"),
    JSON.stringify({ seed: 1, items: [item], verdicts: [], unplaced: [] }),
  );
  const answer = (holds: string) => ({
    comments: [
      { id: "n1", holds, sameAs: [], rationale: "The change confirms it." },
    ],
    verdicts: [],
  });
  for (const [pass, holds] of [
    ["a", "plausible"],
    ["b", "invalid"],
  ]) {
    const run = join(directory, "matching", `pass-${pass}`);
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "output.json"), JSON.stringify(answer(holds!)));
  }
  const sentinel = join(research, "matching-summary");
  const summary = JSON.stringify({ summary: { failures: [], receipts: [] } });
  writeFileSync(sentinel, summary);
  symlinkSync(sentinel, join(directory, "matching.json"));
  const requests: string[] = [];
  setCloudCaller(async (request) => {
    requests.push(String(request["command"]));
    return request["command"] === "probe"
      ? cloud.probe
      : cloud.done(answer("plausible"));
  });
  const run = () =>
    tiebreakMatching(
      CaseRecord.parse(record),
      () => ({ diffs: [], firstRevision: new Set() }),
      "candidate-1",
    );
  await expect(run()).rejects.toThrow("treatment only");
  expect(requests).toEqual([]);
  expect(readFileSync(sentinel, "utf8")).toBe(summary);
  unlinkSync(join(directory, "matching.json"));
  linkSync(sentinel, join(directory, "matching.json"));
  expect(await run()).toMatchObject({ caseId: record.caseId });
  expect(requests).toEqual(["probe", "exec"]);
  expect(readFileSync(sentinel, "utf8")).toBe(summary);
  expect(await run()).toMatchObject({ skipped: "already broken" });
  expect(requests).toHaveLength(2);
});

test("Codex admits deterministic operational destinations before the substituted cloud boundary", async () => {
  process.env["NEUVE_LABEL_RUNNER"] = "cloud";
  let calls = 0;
  setCloudCaller(async () => {
    calls++;
    throw new Error("unexpected cloud call");
  });
  const sentinel = join(research, "operational-sentinel");
  writeFileSync(sentinel, "baseline sentinel\n");
  const runDir = join(treatment, "model");
  mkdirSync(runDir);
  const run = () =>
    runToolless(
      {
        runDir,
        log: join(treatment, "model.jsonl"),
        prompt: "p",
        schema: {},
        effort: "medium",
      },
      [],
    );
  for (const name of [
    "tmp/uv-cache",
    "tmp/modal-venv",
    "cloud-failures",
    "labeller-events.jsonl",
  ]) {
    const path = join(treatment, name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(sentinel, path);
    await expect(run()).rejects.toThrow("treatment only");
    expect(calls).toBe(0);
    unlinkSync(path);
  }
  linkSync(sentinel, join(treatment, "labeller-events.jsonl"));
  await expect(run()).rejects.toThrow("one link");
  expect(calls).toBe(0);
  expect(readFileSync(sentinel, "utf8")).toBe("baseline sentinel\n");
  unlinkSync(join(treatment, "labeller-events.jsonl"));
  mkdirSync(join(runDir, "output.json"));
  await expect(run()).rejects.toThrow("regular file");
  expect(calls).toBe(0);
});
