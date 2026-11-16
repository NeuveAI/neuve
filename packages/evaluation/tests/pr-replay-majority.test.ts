// Why: under 10.135 a third pass breaks the labelling passes' ties and the majority counts, in
// concern labelling, post-merge judging and blind matching alike. A 2–1 majority must decide, three
// different answers or a majority of "unsure" must leave the item unjudged, and the third pass must
// be independent: it sees exactly the prompt the first two would have, over the tied items alone,
// and nothing of what they answered.
import { afterAll, afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Judgement } from "../src/pr-replay/concerns.ts";
import type { CaseRecord } from "../src/pr-replay/schema.ts";
import type { Thread } from "../src/pr-replay/threads.ts";

const root = mkdtempSync(join(tmpdir(), "replay-majority-"));
const environment = { ...process.env };
afterAll(() => {
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});
process.env["NEUVE_RESEARCH_ROOT"] = root;
process.env["NEUVE_LABEL_RUNNER"] = "cloud";
const {
  DISABLED_FEATURES,
  PINNED_CODEX_VERSION,
  PINNED_LINUX_INSTALL_HASH,
  SAFE_ENABLED_FEATURES,
  pinCatalog,
  setCloudCaller,
} = await import("../src/pr-replay/codex.ts");
const { majority, needsThird } = await import("../src/pr-replay/majority.ts");
const { decideThread, promptFor, settleConcerns } =
  await import("../src/pr-replay/concerns.ts");
const { afterMergePrompt, settleAfterMerge } =
  await import("../src/pr-replay/aftermerge.ts");
const { blindPrompt, mergeBlind, settleMatching } =
  await import("../src/pr-replay/matching.ts");
afterEach(() => setCloudCaller(undefined));

// The cloud labeller, faked as the cloud tests fake it: a probe that passes, then each call's answer.
const home = join(root, "codex-home");
mkdirSync(home);
writeFileSync(
  join(home, "models_cache.json"),
  JSON.stringify({
    models: [
      {
        slug: "gpt-6.1-sol",
        tool_mode: "code_mode_only",
        experimental_supported_tools: ["send_user_message_async", "clock"],
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
pinCatalog(home);
const facts = {
  installHash: PINNED_LINUX_INSTALL_HASH,
  modelsCache: null,
  modelsCacheSha256: null,
  homeFiles: ["auth.json"],
};
const probe = {
  version: `${PINNED_CODEX_VERSION}\n`,
  features: [
    ...DISABLED_FEATURES.map((name) => `${name}  stable  false`),
    ...[...SAFE_ENABLED_FEATURES].map((name) => `${name}  stable  true`),
  ].join("\n"),
  configSources: [],
  created: [],
  ...facts,
};
/** Answers each call with `answer(prompt)` and keeps the prompts the third pass was sent. */
const thirdPass = (answer: (prompt: string) => unknown) => {
  const prompts: Array<string> = [];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probe;
    prompts.push(String(request["prompt"]));
    return {
      stdout: '{"type":"turn.completed"}\n',
      stderr: "",
      code: 0,
      timedOut: false,
      wallSeconds: 1,
      output: JSON.stringify(answer(String(request["prompt"]))),
      after: facts,
      created: [],
    };
  });
  return prompts;
};
/** A prompt with its random block tag replaced, so two prompts over the same data compare equal. */
const untagged = (prompt: string) => prompt.replace(/\b[0-9a-f]{32}\b/g, "TAG");

const readRows = (at: CaseRecord) =>
  readFileSync(
    join(
      root,
      "cases",
      "entire-cli",
      String(at.number),
      "labels",
      "concerns.jsonl",
    ),
    "utf8",
  )
    .split("\n")
    .filter((line) => line !== "")
    .map(
      (line) =>
        JSON.parse(line) as {
          id: string;
          c: Judgement | null;
          label: Judgement | null;
        },
    );

let cases = 0;
const record = () => {
  const number = ++cases;
  mkdirSync(join(root, "cases", "entire-cli", String(number), "labels"), {
    recursive: true,
  });
  return {
    caseId: `github:entireio/cli:${number}`,
    source: "entire-cli",
    number,
    family: "entire-cli",
    provider: "github",
    title: "A change",
  } as unknown as CaseRecord;
};

const judge = (over: Partial<Judgement> = {}): Judgement => ({
  id: "t",
  isConcern: true,
  category: "correctness",
  substantive: true,
  response: "fixed",
  fixRevision: 2,
  validity: "valid",
  designDecision: false,
  rationale: "",
  ...over,
});

test("two of three decide; three different answers or a majority of unsure decide nothing", () => {
  expect(majority("fix", "refactor", "fix", "unsure")).toEqual({
    value: "fix",
    why: null,
    brokenByThird: true,
  });
  expect(majority("fix", "fix", null, "unsure").value).toBe("fix");
  expect(majority("fix", "refactor", "test", "unsure")).toMatchObject({
    value: null,
    why: "split",
  });
  expect(majority("unsure", "fix", "unsure", "unsure")).toMatchObject({
    value: null,
    why: "unsure",
  });
  // A tie the third pass could not break, because it gave no answer either.
  expect(majority("fix", "refactor", null, "unsure").why).toBe("missing");
  expect(majority("fix", null, "fix", "unsure").value).toBe("fix");
  // Two agreeing answers need no third, "unsure" included: it could not change the majority.
  expect(needsThird("unsure", "unsure")).toBe(false);
  expect(needsThird("fix", null)).toBe(true);
});

test("a thread's label is decided field by field, and validity only for a concern", () => {
  const twoToOne = decideThread(
    judge({ response: "fixed" }),
    judge({ response: "answered" }),
    judge({ response: "fixed" }),
  );
  expect(twoToOne.label?.response).toBe("fixed");
  expect(twoToOne.brokenByThird).toEqual(["response"]);
  const split = decideThread(
    judge({ response: "fixed" }),
    judge({ response: "answered" }),
    judge({ response: "unresolved" }),
  );
  expect(split.label).toBeNull();
  expect(split.unjudged).toEqual({ response: "split" });
  const unsure = decideThread(
    judge({ validity: "unsure" }),
    judge({ validity: "valid" }),
    judge({ validity: "unsure" }),
  );
  expect(unsure.label).toBeNull();
  expect(unsure.unjudged).toEqual({ validity: "unsure" });
  // No concern by majority: whether it was right does not matter, and "unsure" is no obstacle.
  const notConcern = judge({
    isConcern: false,
    substantive: false,
    response: "not-applicable",
    validity: "unsure",
  });
  expect(decideThread(notConcern, notConcern, null).label?.isConcern).toBe(
    false,
  );
});

test("concerns: the third pass reads the same prompt, blind to the first two, and counts only on their ties", async () => {
  const at = record();
  const threads = ["t1", "t2", "t3"].map(
    (id) =>
      ({ id, kind: "inline", revision: 1, messages: [] }) as unknown as Thread,
  );
  const revisions = [{ number: 1, commit: "abc" }];
  const diffs = [{ name: "r1-r2.diff", text: "diff --git a/x b/x" }];
  const said = (pass: string, over: Partial<Judgement>) =>
    judge({ ...over, rationale: `PASS-${pass}-SAID-THIS` });
  const rows = [
    // Agreed: no third pass.
    { id: "t1", a: said("A", { id: "t1" }), b: said("B", { id: "t1" }) },
    // Tied on the response.
    {
      id: "t2",
      a: said("A", { id: "t2", response: "fixed" }),
      b: said("B", { id: "t2", response: "answered" }),
    },
    // One pass gave no answer.
    { id: "t3", a: null, b: said("B", { id: "t3", substantive: false }) },
  ].map((row) => ({
    ...row,
    kind: "inline" as const,
    revision: 1,
    opener: "person" as const,
    firstRevisionKey: `a.ts:new:${row.id.slice(1)}`,
  }));
  const prompts = thirdPass(() => ({
    threads: [
      // On t1 the first two agreed: the third's different answer never counts.
      judge({ id: "t1", isConcern: false, rationale: "third" }),
      judge({ id: "t2", response: "fixed", rationale: "third" }),
      judge({ id: "t3", substantive: false, rationale: "third" }),
    ],
  }));
  const summary = await settleConcerns(
    at,
    rows,
    { threads, revisions, diffs },
    [],
    { a: null, b: null },
  );
  // The same prompt as the first two: every thread, in the original order.
  expect(prompts).toHaveLength(1);
  expect(untagged(prompts[0]!)).toBe(
    untagged(promptFor(at, threads, revisions, diffs)),
  );
  expect(prompts[0]).not.toContain("PASS-");
  expect(summary.judged).toBe(3);
  expect(summary.thirdPass).toEqual({ threads: 2, decided: 2 });
  const rowsOut = readRows(at);
  expect(rowsOut.find((row) => row.id === "t1")!.c).toBeNull();
  expect(rowsOut.find((row) => row.id === "t1")!.label!.isConcern).toBe(true);
});

test("post-merge: only the commits the first two disagree on go to the third pass", async () => {
  const at = record();
  const commits = [
    { commit: "c1", subject: "Fix it", diff: "DIFF-ONE" },
    { commit: "c2", subject: "Tidy", diff: "DIFF-TWO" },
    { commit: "c3", subject: "More", diff: "DIFF-THREE" },
  ];
  const prompts = thirdPass(() => ({
    commits: [
      { commit: "c2", kind: "refactor", rationale: "" },
      { commit: "c3", kind: "test", rationale: "" },
    ],
  }));
  const { record: judged } = await settleAfterMerge(
    at,
    commits,
    [
      { a: "fix", b: "fix" },
      { a: "refactor", b: "fix" },
      { a: "unsure", b: "fix" },
    ],
    [],
    [],
  );
  expect(prompts).toHaveLength(1);
  expect(untagged(prompts[0]!)).toBe(
    untagged(afterMergePrompt([commits[1]!, commits[2]!])),
  );
  expect(judged.commits.map((commit) => commit.kind)).toEqual([
    "fix",
    "refactor",
    // fix, unsure and test: three answers, no majority.
    null,
  ]);
  expect(judged.commits[1]!.brokenByThird).toBe(true);
});

test("matching: a blind third pass over every comment breaks holds, verdicts and lone pairs", async () => {
  const at = record();
  writeFileSync(
    join(
      root,
      "cases",
      "entire-cli",
      String(at.number),
      "labels",
      "rework.json",
    ),
    JSON.stringify({
      version: 1,
      caseId: at.caseId,
      firstLines: 2,
      landed: null,
      windowEnd: null,
      untracked: 0,
      lines: {},
      notes: [],
    }),
  );
  const item = (id: string, source: "neuve" | "reviewer", line: number) => ({
    id,
    source,
    group: source === "neuve" ? ("comment" as const) : ("reviewer" as const),
    ref: source === "neuve" ? `ref-${id}` : `t-${id}`,
    repeats: [],
    path: "a.ts",
    line,
    anchoredTo: "line" as const,
    text: `TEXT-${id}`,
  });
  const items = [
    item("n1", "neuve", 1),
    item("r1", "reviewer", 1),
    item("n2", "neuve", 5),
  ];
  const verdicts = [
    { id: "v1", unit: "u1", verdict: "approve" as const, lines: ["a.ts:1-2"] },
  ];
  const first = (pairs: boolean, n2: "plausible" | "invalid") => ({
    comments: [
      {
        id: "n1",
        holds: "plausible" as const,
        sameAs: pairs ? ["r1"] : [],
        rationale: "FIRST-TWO",
      },
      {
        id: "r1",
        holds: "plausible" as const,
        sameAs: [],
        rationale: "FIRST-TWO",
      },
      { id: "n2", holds: n2, sameAs: [], rationale: "FIRST-TWO" },
    ],
    verdicts: [
      { id: "v1", judgement: "consistent" as const, rationale: "FIRST-TWO" },
    ],
  });
  const prompts = thirdPass(() => ({
    comments: [
      { id: "n1", holds: "plausible", sameAs: ["r1"], rationale: "" },
      { id: "r1", holds: "plausible", sameAs: [], rationale: "" },
      { id: "n2", holds: "invalid", sameAs: [], rationale: "" },
    ],
    verdicts: [],
  }));
  const diffs = [{ name: "r0-r1", text: "DIFF" }];
  const summary = await settleMatching(at, {
    key: { seed: 7, items, verdicts, unplaced: [] },
    diffs,
    passes: { a: first(true, "plausible"), b: first(false, "invalid") },
    failures: [],
    receipts: [],
    substantive: new Set(["t-r1"]),
  });
  // The third pass reads every comment and verdict; the tie set is the lone pair's two comments and
  // n2's holds, not the agreed verdict.
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).not.toContain("FIRST-TWO");
  expect(prompts[0]).toContain('"id": "v1"');
  for (const id of ["n1", "r1", "n2"])
    expect(prompts[0]).toContain(`TEXT-${id}`);
  expect(summary.thirdPass).toEqual({ comments: 3, verdicts: 0, pairs: 1 });
  // a and c name the pair: two of three, so r1 is caught by n1.
  expect(summary.caught).toBe(1);
  expect(summary.notJudged.comments.brokenByThird).toBe(1);
  // The prompt is the blind prompt over every comment and verdict, in an order of its own.
  expect(untagged(prompts[0]!).length).toBe(
    untagged(blindPrompt(items, verdicts, diffs, "a".repeat(32))).length,
  );
});

test("a pair only one of three passes names never counts", () => {
  const item = (id: string, source: "neuve" | "reviewer") => ({
    id,
    source,
    group: source === "neuve" ? ("comment" as const) : ("reviewer" as const),
    ref: id,
    repeats: [],
    path: "a.ts",
    line: 1,
    anchoredTo: "line" as const,
    text: "",
  });
  const pass = (pair: boolean) => ({
    comments: [
      {
        id: "n1",
        holds: "plausible" as const,
        sameAs: pair ? ["r1"] : [],
        rationale: "",
      },
      { id: "r1", holds: "plausible" as const, sameAs: [], rationale: "" },
    ],
    verdicts: [],
  });
  const key = {
    items: [item("n1", "neuve"), item("r1", "reviewer")],
    verdicts: [],
    substantive: new Set(["r1"]),
  };
  expect(mergeBlind(pass(true), pass(false), key, pass(false)).pairs).toEqual(
    [],
  );
  expect(mergeBlind(pass(true), pass(false), key, pass(true)).pairs).toEqual([
    "n1|r1",
  ]);
});

const { tiebreakConcerns } = await import("../src/pr-replay/concerns.ts");
const { tiebreakAfterMerge } = await import("../src/pr-replay/aftermerge.ts");
const { tiebreakMatching, shuffled } =
  await import("../src/pr-replay/matching.ts");
const { lineEvidence, threadClass } =
  await import("../src/pr-replay/evidence.ts");

const labelsOf = (at: CaseRecord) =>
  join(root, "cases", "entire-cli", String(at.number), "labels");

/** A case labelled before 10.135: its stored rows and summary, two threads tied on one field. */
const storedConcerns = (
  at: CaseRecord,
  over: { a?: Judgement | null; b?: Judgement | null } = {},
) => {
  const rows = [
    { id: "t1", a: judge({ id: "t1" }), b: judge({ id: "t1" }) },
    {
      id: "t2",
      a: "a" in over ? over.a! : judge({ id: "t2", response: "fixed" }),
      b: "b" in over ? over.b! : judge({ id: "t2", response: "answered" }),
    },
  ].map((row) => ({
    ...row,
    kind: "inline",
    revision: 1,
    opener: "person",
    firstRevisionKey: `a.ts:new:${row.id.slice(1)}`,
    agreed: false,
  }));
  writeFileSync(
    join(labelsOf(at), "concerns.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(
    join(labelsOf(at), "concerns-summary.json"),
    JSON.stringify({ receipts: [], problems: { a: null, b: null } }),
  );
};
const inputsFor = (threads: Array<Partial<Thread>>) => () => ({
  threads: threads.map(
    (thread) =>
      ({
        kind: "inline",
        revision: 1,
        messages: [{ actorKind: "person" }],
        anchor: { firstRevisionKey: `a.ts:new:${thread.id!.slice(1)}` },
        ...thread,
      }) as unknown as Thread,
  ),
  revisions: [{ number: 1, commit: "abc" }],
  diffs: [],
});

test("the concerns tie-break runs once, refuses changed threads, and a failed third pass can be retried", async () => {
  const at = record();
  storedConcerns(at);
  // A thread now opened on another revision, or a new one: the stored passes judged other threads.
  await expect(
    tiebreakConcerns(at, inputsFor([{ id: "t1" }, { id: "t2", revision: 2 }])),
  ).rejects.toThrow("changed or went");
  await expect(
    tiebreakConcerns(at, inputsFor([{ id: "t1" }, { id: "t2" }, { id: "t3" }])),
  ).rejects.toThrow("1 are new");
  // A third pass that gives nothing: no mark, so it runs again.
  let calls = thirdPass(() => ({ wrong: true }));
  const failed = await tiebreakConcerns(
    at,
    inputsFor([{ id: "t1" }, { id: "t2" }]),
  );
  expect(calls).toHaveLength(1);
  expect("thirdPass" in failed).toBe(false);
  calls = thirdPass(() => ({
    threads: [judge({ id: "t2", response: "fixed" })],
  }));
  const broken = await tiebreakConcerns(
    at,
    inputsFor([{ id: "t1" }, { id: "t2" }]),
  );
  expect(calls).toHaveLength(1);
  expect(broken).toMatchObject({ thirdPass: { threads: 1, decided: 1 } });
  // Already broken: left as it is, with no call.
  calls = thirdPass(() => ({ threads: [] }));
  expect(
    await tiebreakConcerns(at, inputsFor([{ id: "t1" }, { id: "t2" }])),
  ).toMatchObject({
    skipped: "already broken",
  });
  expect(calls).toHaveLength(0);
});

test("a case where neither first pass judged anything gets no third pass", async () => {
  const at = record();
  storedConcerns(at, { a: null, b: null });
  writeFileSync(
    join(labelsOf(at), "concerns.jsonl"),
    ["t1", "t2"]
      .map((id) =>
        JSON.stringify({
          id,
          kind: "inline",
          revision: 1,
          opener: "person",
          firstRevisionKey: `a.ts:new:${id.slice(1)}`,
          a: null,
          b: null,
        }),
      )
      .join("\n") + "\n",
  );
  const calls = thirdPass(() => ({ threads: [] }));
  const summary = await tiebreakConcerns(
    at,
    inputsFor([{ id: "t1" }, { id: "t2" }]),
  );
  expect(calls).toHaveLength(0);
  expect(summary).toMatchObject({
    judged: 0,
    problems: { c: "no first passes" },
  });
  expect("thirdPass" in summary).toBe(false);
});

test("post-merge: agreed unsure counts as no kind; the tie-break refuses changed commits and runs once", async () => {
  const at = record();
  const commits = [
    { commit: "c1", subject: "s", diff: "D1" },
    { commit: "c2", subject: "s", diff: "D2" },
  ];
  let calls = thirdPass(() => ({ commits: [] }));
  const { record: judged } = await settleAfterMerge(
    at,
    commits,
    [
      { a: "unsure", b: "unsure" },
      { a: "fix", b: "fix" },
    ],
    [],
    [],
  );
  expect(calls).toHaveLength(0);
  expect(judged.commits.map((commit) => commit.kind)).toEqual([null, "fix"]);
  // Stored before 10.135, with a tie on c2.
  writeFileSync(
    join(labelsOf(at), "aftermerge.json"),
    JSON.stringify({
      version: 1,
      caseId: at.caseId,
      commits: [
        { commit: "c1", subject: "s", a: "fix", b: "fix", kind: "fix" },
        { commit: "c2", subject: "s", a: "fix", b: "refactor", kind: null },
      ],
      failures: [],
    }),
  );
  await expect(tiebreakAfterMerge(at, () => [commits[0]!])).rejects.toThrow(
    "changed",
  );
  calls = thirdPass(() => ({
    commits: [{ commit: "c2", kind: "refactor", rationale: "" }],
  }));
  const broken = await tiebreakAfterMerge(at, () => commits);
  expect(calls).toHaveLength(1);
  expect(broken.record.commits[1]).toMatchObject({
    kind: "refactor",
    brokenByThird: true,
  });
  calls = thirdPass(() => ({ commits: [] }));
  expect(await tiebreakAfterMerge(at, () => commits)).toMatchObject({
    skipped: "already broken",
  });
  expect(calls).toHaveLength(0);
});

test("the matching tie-break refuses passes that are not the key's, and counts only substantive concerns outside the mix", async () => {
  const at = record();
  const labels = labelsOf(at);
  writeFileSync(
    join(labels, "rework.json"),
    JSON.stringify({
      version: 1,
      caseId: at.caseId,
      firstLines: 1,
      landed: null,
      windowEnd: null,
      untracked: 0,
      lines: {},
      notes: [],
    }),
  );
  const blind = (id: string, source: "neuve" | "reviewer") => ({
    id,
    source,
    group: source === "neuve" ? "comment" : "reviewer",
    ref: source === "neuve" ? `u#${id}` : "t1",
    repeats: [],
    path: "a.ts",
    line: 1,
    anchoredTo: "line",
    text: id,
  });
  const key = {
    seed: 1,
    items: [blind("n1", "neuve"), blind("r1", "reviewer")],
    verdicts: [],
    unplaced: [],
  };
  writeFileSync(join(labels, "matching-key.json"), JSON.stringify(key));
  writeFileSync(
    join(labels, "matching.json"),
    JSON.stringify({ summary: { failures: [], receipts: [] } }),
  );
  const output = (pass: string, ids: Array<string>) => {
    mkdirSync(join(labels, "matching", `pass-${pass}`), { recursive: true });
    writeFileSync(
      join(labels, "matching", `pass-${pass}`, "output.json"),
      JSON.stringify({
        comments: ids.map((id) => ({
          id,
          holds: "plausible",
          sameAs: [],
          rationale: "",
        })),
        verdicts: [],
      }),
    );
  };
  // Three threads opened on revision 1: t1 in the mix; t2 substantive and t3 not, both judged later.
  const concern = (id: string, substantive: boolean) =>
    JSON.stringify({
      id,
      opener: "person",
      firstRevisionKey: `a.ts:new:${id.slice(1)}`,
      a: judge({ id, substantive }),
      b: judge({ id, substantive }),
    });
  writeFileSync(
    join(labels, "concerns.jsonl"),
    [concern("t1", true), concern("t2", true), concern("t3", false)].join(
      "\n",
    ) + "\n",
  );
  const load = () => ({
    diffs: [],
    firstRevision: new Set(["t1", "t2", "t3"]),
  });
  output("a", ["n1", "r1"]);
  output("b", ["n1", "stranger"]);
  await expect(tiebreakMatching(at, load)).rejects.toThrow(
    "does not belong to the stored key",
  );
  output("b", ["n1", "r1"]);
  const calls = thirdPass(() => ({ comments: [], verdicts: [] }));
  const summary = await tiebreakMatching(at, load);
  // The passes agreed on everything: no third pass.
  expect(calls).toHaveLength(0);
  expect(summary).toMatchObject({ concernsNotInMix: 1 });
});

// Why (parity, 10.141): a repeat run is matched against the same reviewer concerns as its case's first
// run, so its matching reads the case's own concern labels and rework map, writes only into its run
// folder, and counts the same substantive set, the count the lanes thread's parity reader checks a
// run's matching against.
test("another run of a case is matched in its own folder, against the case's concern labels", async () => {
  const at = record();
  const labels = labelsOf(at);
  const runLabels = join(labels, "..", "run", "cloud-2", "labels");
  mkdirSync(runLabels, { recursive: true });
  writeFileSync(
    join(labels, "rework.json"),
    JSON.stringify({
      version: 1,
      caseId: at.caseId,
      firstLines: 1,
      landed: null,
      windowEnd: null,
      untracked: 0,
      lines: {},
      notes: [],
    }),
  );
  const concern = (id: string, substantive: boolean) =>
    JSON.stringify({
      id,
      opener: "person",
      firstRevisionKey: `a.ts:new:${id.slice(1)}`,
      a: judge({ id, substantive }),
      b: judge({ id, substantive }),
    });
  writeFileSync(
    join(labels, "concerns.jsonl"),
    [concern("t1", true), concern("t2", false)].join("\n") + "\n",
  );
  const blind = (id: string, source: "neuve" | "reviewer", ref: string) => ({
    id,
    source,
    group: source === "neuve" ? "comment" : "reviewer",
    ref,
    repeats: [],
    path: "a.ts",
    line: 1,
    anchoredTo: "line",
    text: id,
  });
  writeFileSync(
    join(runLabels, "matching-key.json"),
    JSON.stringify({
      seed: 1,
      items: [
        blind("n1", "neuve", "u#n1"),
        blind("r1", "reviewer", "t1"),
        blind("r2", "reviewer", "t2"),
      ],
      verdicts: [],
      unplaced: [],
    }),
  );
  writeFileSync(
    join(runLabels, "matching.json"),
    JSON.stringify({ summary: { failures: [], receipts: [] } }),
  );
  for (const pass of ["a", "b"]) {
    mkdirSync(join(runLabels, "matching", `pass-${pass}`), { recursive: true });
    writeFileSync(
      join(runLabels, "matching", `pass-${pass}`, "output.json"),
      JSON.stringify({
        comments: ["n1", "r1", "r2"].map((id) => ({
          id,
          holds: "plausible",
          sameAs: id === "n1" ? ["r1"] : [],
          rationale: "",
        })),
        verdicts: [],
      }),
    );
  }
  thirdPass(() => ({ comments: [], verdicts: [] }));
  await tiebreakMatching(
    at,
    () => ({ diffs: [], firstRevision: new Set(["t1", "t2"]) }),
    "cloud-2",
  );
  const written = JSON.parse(
    readFileSync(join(runLabels, "matching.json"), "utf8"),
  );
  // t1 is the case's one substantive concern, and the run's matching caught it.
  expect(written.summary).toMatchObject({
    substantiveConcerns: 1,
    caughtByAny: 1,
  });
  // Nothing of the run's reached the case's first-run labels.
  expect(existsSync(join(labels, "matching.json"))).toBe(false);
  await expect(tiebreakMatching(at, undefined, "../escape")).rejects.toThrow(
    "is not a run folder's name",
  );
});

test("a line keeps needing a person beside an unsettled thread, and a thread's class is one some pass gave", () => {
  const row = (
    id: string,
    key: string,
    a: Judgement | null,
    b: Judgement | null,
    c: Judgement | null = null,
  ) => ({
    id,
    opener: "person" as const,
    firstRevisionKey: key,
    a,
    b,
    c,
  });
  const discussed = judge({ response: "answered" });
  const needs = judge();
  const nit = judge({ substantive: false });
  const none = judge({
    isConcern: false,
    substantive: false,
    response: "not-applicable",
    validity: "unsure",
  });
  // Three passes, three classes: no majority.
  expect(threadClass(row("x", "k", needs, discussed, nit)).open).toBe(true);
  // Two passes give needs-person by different fields: needs-person, a class two passes gave.
  const byDecision = judge({ response: "unresolved", designDecision: true });
  const decided = threadClass(row("y", "k", needs, byDecision, none));
  expect(decided).toMatchObject({
    open: false,
    found: { class: "needs-person" },
  });
  const { lines, disputed } = lineEvidence(
    [
      // An unsettled thread beside an after-merge fix: the line already needs a person, so it stays.
      row("u1", "a.ts:new:1", needs, discussed, nit),
      // An unsettled thread on a line that is only discussed: held back.
      row("u2", "a.ts:new:2", needs, discussed, nit),
      row("d2", "a.ts:new:2", discussed, discussed),
    ],
    new Map([["a.ts:new:1", "abc"]]),
    [],
  );
  expect(lines["a.ts:new:1"]?.class).toBe("needs-person");
  expect(lines["a.ts:new:2"]).toBeUndefined();
  expect(disputed).toBe(1);
});

test("matching's third pass sees every comment and verdict, in its own seeded order, not the first two's", async () => {
  const at = record();
  writeFileSync(
    join(labelsOf(at), "rework.json"),
    JSON.stringify({
      version: 1,
      caseId: at.caseId,
      firstLines: 1,
      landed: null,
      windowEnd: null,
      untracked: 0,
      lines: {},
      notes: [],
    }),
  );
  const ids = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"];
  const items = ids.map((id, n) => ({
    id,
    source: "neuve" as const,
    group: "comment" as const,
    ref: id,
    repeats: [],
    path: "a.ts",
    line: n + 1,
    anchoredTo: "line" as const,
    text: `TEXT-${id}`,
  }));
  const verdicts = ["v1", "v2", "v3"].map((id) => ({
    id,
    unit: id,
    verdict: "approve" as const,
    lines: [],
  }));
  // One tie, on c1's holds: the third pass must still read all eight comments and all three verdicts.
  const pass = (c1: "plausible" | "invalid") => ({
    comments: ids.map((id) => ({
      id,
      holds: id === "c1" ? c1 : "plausible",
      sameAs: [],
      rationale: "",
    })),
    verdicts: verdicts.map(({ id }) => ({
      id,
      judgement: "consistent" as const,
      rationale: "",
    })),
  });
  const prompts = thirdPass(() => ({ comments: [], verdicts: [] }));
  const seed = 99;
  await settleMatching(at, {
    key: { seed, items, verdicts, unplaced: [] },
    diffs: [],
    passes: { a: pass("plausible"), b: pass("invalid") },
    failures: [],
    receipts: [],
    substantive: new Set(),
  });
  const order = (prompt: string) =>
    [...prompt.matchAll(/TEXT-(c\d)/g)].map((found) => found[1]!);
  const verdictOrder = (prompt: string) =>
    [...prompt.matchAll(/"id": "(v\d)"/g)].map((found) => found[1]!);
  const seen = order(prompts[0]!);
  expect([...seen].sort()).toEqual(ids);
  expect(verdictOrder(prompts[0]!).sort()).toEqual(["v1", "v2", "v3"]);
  // Its own order: neither pass a's (the seeded shuffle) nor pass b's (that reversed).
  const first = shuffled(items, seed).map((item) => item.id);
  expect(seen).not.toEqual(first);
  expect(seen).not.toEqual([...first].reverse());
  expect(seen).toEqual(
    shuffled(items, seed ^ 0x9e3779b9).map((item) => item.id),
  );
});

test("a thread's class is strong only when every pass that gave it held it strong", () => {
  const bot = (response: "fixed" | "acknowledged-not-fixed") =>
    judge({ response, validity: "valid", substantive: false });
  const row = (a: Judgement, b: Judgement) => ({
    id: "t",
    opener: "bot" as const,
    firstRevisionKey: "a.ts:new:1",
    a,
    b,
    c: null,
  });
  // A confirmed bot finding: fixed is strong, acknowledged only is weak.
  expect(threadClass(row(bot("fixed"), bot("fixed")))).toMatchObject({
    found: { class: "agent-catchable", strength: "strong" },
  });
  expect(
    threadClass(row(bot("fixed"), bot("acknowledged-not-fixed"))),
  ).toMatchObject({
    found: { class: "agent-catchable", strength: "weak" },
  });
});

// Why: adopted style, naming and maintainability nits were labelled design decisions under 10.132,
// so their lines needed a person, against 10.128 where nits are agent work (the lanes thread's read
// of 26 October). The definition now says so, in labelling and in the audit, and labelled cases get
// the field again from fresh passes, without moving any other field, which matching is built on.
const { redecideDesign, promptFor: concernPrompt } =
  await import("../src/pr-replay/concerns.ts");
const { CLASS_DEFINITIONS } = await import("../src/pr-replay/audit.ts");

test("an adopted nit is no design decision, in the labelling prompt and the audit's definitions", () => {
  const prompt = concernPrompt(record(), [], [], []);
  expect(prompt).toContain(
    "A design decision is a choice about behaviour, interface or architecture",
  );
  expect(prompt).toContain("is not a design decision");
  expect(CLASS_DEFINITIONS["needs-person"]).toContain(
    "is not a design decision",
  );
  expect(CLASS_DEFINITIONS["agent-catchable"]).toContain(
    "extracting a constant",
  );
});

test("the design decision is decided again by fresh passes, every other field left as it was", async () => {
  const at = record();
  // A renamed test: both stored passes called it a design decision; t2's passes tied on another field.
  const nit = judge({
    substantive: false,
    response: "fixed",
    designDecision: true,
  });
  const rows = [
    { id: "t1", a: { ...nit, id: "t1" }, b: { ...nit, id: "t1" } },
    {
      id: "t2",
      a: { ...nit, id: "t2", response: "fixed" as const },
      b: { ...nit, id: "t2", response: "answered" as const },
      c: { ...nit, id: "t2", response: "fixed" as const },
    },
  ].map((row) => ({
    ...row,
    kind: "inline",
    revision: 1,
    opener: "person",
    firstRevisionKey: `a.ts:new:${row.id.slice(1)}`,
    label: { ...nit, id: row.id },
  }));
  writeFileSync(
    join(labelsOf(at), "concerns.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(
    join(labelsOf(at), "concerns-summary.json"),
    JSON.stringify({
      receipts: [],
      problems: {},
      thirdPass: { threads: 1, decided: 1 },
    }),
  );
  // Fresh pass a: t1 still a decision; fresh b: none (a tie on t1, which the third breaks against a);
  // t2 none from both.
  const fresh = (decisions: Record<string, boolean>) => ({
    threads: Object.entries(decisions).map(([id, designDecision]) =>
      judge({ id, substantive: true, response: "unresolved", designDecision }),
    ),
  });
  const calls = [
    fresh({ t1: true, t2: false }),
    fresh({ t1: false, t2: false }),
    fresh({ t1: false, t2: true }),
  ];
  const prompts = thirdPass(() => calls.shift());
  const result = await redecideDesign(
    at,
    inputsFor([{ id: "t1" }, { id: "t2" }]),
  );
  expect(prompts).toHaveLength(3);
  expect(result).toMatchObject({
    designRedecided: { threads: 2, tied: 1, changed: 2 },
  });
  // The fresh passes called both threads substantive, the stored majority neither: logged, not taken.
  expect(result).toMatchObject({
    designRedecided: {
      freshDisagrees: { compared: 2, substantive: 2, isConcern: 0 },
    },
  });
  const out = readRows(at) as unknown as Array<{
    id: string;
    a: Judgement;
    b: Judgement;
    c: Judgement | null;
    label: Judgement;
    designDecisionBefore: { label: boolean };
  }>;
  const t1 = out.find((row) => row.id === "t1")!;
  const t2 = out.find((row) => row.id === "t2")!;
  // t1: fresh a true, b false, third false: no design decision, the third's vote and not a's. Its
  // other fields are the stored ones.
  expect(t1.label.designDecision).toBe(false);
  expect([t1.a.substantive, t1.a.response, t1.label.response]).toEqual([
    false,
    "fixed",
    "fixed",
  ]);
  expect(t1.c?.designDecision).toBe(false);
  expect(t1.designDecisionBefore.label).toBe(true);
  // t2: the fresh passes agreed (none); its stored third keeps its own response vote.
  expect(t2.label).toMatchObject({ designDecision: false, response: "fixed" });
  // Already redecided: left as it is.
  expect(
    await redecideDesign(at, inputsFor([{ id: "t1" }, { id: "t2" }])),
  ).toMatchObject({
    skipped: "already redecided",
  });
});

test("redecide never makes a vote: a fresh tie with no stored third, where the passes differ elsewhere, is held back", async () => {
  const at = record();
  const nit = judge({
    substantive: false,
    response: "fixed",
    designDecision: true,
  });
  // Stored a and b differ on substantive and there is no stored third: a copy of a would decide it.
  const rows = [
    {
      id: "t1",
      kind: "inline",
      revision: 1,
      opener: "person",
      firstRevisionKey: "a.ts:new:1",
      a: { ...nit, id: "t1", substantive: true },
      b: { ...nit, id: "t1", substantive: false },
    },
  ];
  writeFileSync(
    join(labelsOf(at), "concerns.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(
    join(labelsOf(at), "concerns-summary.json"),
    JSON.stringify({
      receipts: [],
      problems: {},
      thirdPass: { threads: 0, decided: 0 },
    }),
  );
  const fresh = (designDecision: boolean) => ({
    threads: [judge({ id: "t1", designDecision })],
  });
  const calls = [fresh(false), fresh(true), fresh(false)];
  const prompts = thirdPass(() => calls.shift());
  await redecideDesign(at, inputsFor([{ id: "t1" }]));
  const row = readRows(at)[0]! as unknown as {
    c: Judgement | null;
    label: Judgement | null;
  };
  expect(row.c).toBeNull();
  expect(row.label).toBeNull();
  // The two fresh passes read the threads in opposite orders (one thread here: same text), and the
  // third reads them in the original order.
  expect(prompts).toHaveLength(3);
});

test("redecide refuses a case not yet tie-broken, and threads that moved since labelling", async () => {
  const at = record();
  const rows = [
    {
      id: "t1",
      kind: "inline",
      revision: 1,
      opener: "person",
      firstRevisionKey: "a.ts:new:1",
      a: judge({ id: "t1" }),
      b: judge({ id: "t1" }),
    },
    {
      id: "t2",
      kind: "inline",
      revision: 1,
      opener: "person",
      firstRevisionKey: "a.ts:new:2",
      a: judge({ id: "t2" }),
      b: judge({ id: "t2" }),
    },
  ];
  writeFileSync(
    join(labelsOf(at), "concerns.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(
    join(labelsOf(at), "concerns-summary.json"),
    JSON.stringify({ receipts: [], problems: {} }),
  );
  await expect(
    redecideDesign(at, inputsFor([{ id: "t1" }, { id: "t2" }])),
  ).rejects.toThrow("run tiebreak first");
  writeFileSync(
    join(labelsOf(at), "concerns-summary.json"),
    JSON.stringify({
      receipts: [],
      problems: {},
      thirdPass: { threads: 0, decided: 0 },
    }),
  );
  await expect(
    redecideDesign(at, inputsFor([{ id: "t1" }, { id: "t2", revision: 2 }])),
  ).rejects.toThrow("changed or went");
  // The fresh passes read the threads in opposite orders.
  const prompts = thirdPass(() => ({
    threads: [judge({ id: "t1" }), judge({ id: "t2" })],
  }));
  await redecideDesign(at, inputsFor([{ id: "t1" }, { id: "t2" }]));
  const order = (prompt: string) =>
    [...prompt.matchAll(/"id": "(t\d)"/g)].map((found) => found[1]);
  expect(order(prompts[0]!)).toEqual(["t1", "t2"]);
  expect(order(prompts[1]!)).toEqual(["t2", "t1"]);
});

test("a fresh pass that leaves a thread out leaves the case to run again", async () => {
  const at = record();
  const rows = ["t1", "t2"].map((id) => ({
    id,
    kind: "inline",
    revision: 1,
    opener: "person",
    firstRevisionKey: `a.ts:new:${id.slice(1)}`,
    a: judge({ id }),
    b: judge({ id }),
  }));
  writeFileSync(
    join(labelsOf(at), "concerns.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  writeFileSync(
    join(labelsOf(at), "concerns-summary.json"),
    JSON.stringify({
      receipts: [],
      problems: {},
      thirdPass: { threads: 0, decided: 0 },
    }),
  );
  thirdPass(() => ({ threads: [judge({ id: "t1" })] }));
  expect(
    await redecideDesign(at, inputsFor([{ id: "t1" }, { id: "t2" }])),
  ).toMatchObject({
    incomplete: true,
    failed: "design pass a",
  });
});
