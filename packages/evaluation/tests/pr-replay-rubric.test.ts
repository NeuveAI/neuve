// Why: the title rubric decides whether a titles candidate is kept (10.139), and the lead-line and
// digest rubrics are read the same way, so each item must be judged blind by the replay's labellers:
// two passes in opposite orders, a third over the whole chunk where they differ, the majority
// deciding each question (10.135), a majority of unsure staying unsure, and a pass that leaves an
// item out never padded but run again. Each items file is judged on its own rubric's questions and
// fields, and a file mixing rubrics is refused. A paired comparison holds only within one prompt
// wording, so each pass and decision names its wording's digest and nothing judged under another is
// reused; and a busy labeller must stop a run as a refusal, not a failed round.
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

const root = mkdtempSync(join(tmpdir(), "replay-rubric-"));
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
const { TITLE_RUBRIC_QUESTIONS } =
  await import("../src/harness-compare/full-test/title-rubric.ts");
const { LEAD_RUBRIC_QUESTIONS } =
  await import("../src/harness-compare/full-test/leads-compare.ts");
const { DIGEST_RUBRIC_QUESTIONS } =
  await import("../src/harness-compare/full-test/digests-compare.ts");
const { RUBRICS, decideRubric, judgeRubric, promptDigest, rubricOfItems } =
  await import("../src/pr-replay/rubric-judge.ts");
afterEach(() => setCloudCaller(undefined));

// The cloud labeller, faked as the cloud tests fake it.
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
const probeAnswer = {
  version: `${PINNED_CODEX_VERSION}\n`,
  features: [
    ...DISABLED_FEATURES.map((name) => `${name}  stable  false`),
    ...[...SAFE_ENABLED_FEATURES].map((name) => `${name}  stable  true`),
  ].join("\n"),
  configSources: [],
  created: [],
  ...facts,
};
const done = {
  stdout: '{"type":"turn.completed"}\n',
  stderr: "",
  code: 0,
  timedOut: false,
  wallSeconds: 1,
  after: facts,
  created: [],
};

const item = (id: string, title: string) => ({
  id,
  title,
  changes: [`${title}.`],
  paths: ["a.go"],
});
const yes = {
  namesMain: "yes",
  coversRest: "not-applicable",
  oneStatement: "yes",
  whereToLook: "yes",
  reason: "",
};

test("each chunk is judged twice, a third settles its ties, and decided.json waits for every chunk", async () => {
  const items = join(root, "items.json");
  writeFileSync(
    items,
    JSON.stringify({
      version: 1,
      questions: [...TITLE_RUBRIC_QUESTIONS],
      chunks: [
        [item("t000000000001", "First"), item("t000000000002", "Second")],
        [item("t000000000003", "Third")],
      ],
    }),
  );
  const folder = join(root, "rubric");
  const answers: Record<
    string,
    Array<Record<string, Record<string, string>>>
  > = {
    // Chunk 0: a and b differ on t1's namesMain, so a third pass runs over the whole chunk.
    t000000000001: [
      {},
      { namesMain: "no", reason: "names a helper" } as never,
      { namesMain: "no", reason: "only the helper" } as never,
    ],
    // Both unsure on whereToLook: it stays unsure.
    t000000000002: [
      { whereToLook: "unsure" } as never,
      { whereToLook: "unsure" } as never,
      {},
    ],
  };
  const seen: Record<string, number> = {};
  const prompts: Array<string> = [];
  let dropOnce = true;
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    const prompt = String(request["prompt"]);
    prompts.push(prompt);
    const block = prompt.slice(
      prompt.indexOf("ITEMS>>>\n") + 9,
      prompt.lastIndexOf("\n<<<END"),
    );
    const shown = JSON.parse(block) as Array<{ id: string }>;
    const key = shown
      .map((one) => one.id)
      .sort()
      .join(",");
    const call = (seen[key] = (seen[key] ?? -1) + 1);
    // The third chunk's first pass leaves its title out once: it must run again, never be padded.
    if (key === "t000000000003" && dropOnce) {
      dropOnce = false;
      return { ...done, output: JSON.stringify({ answers: [] }) };
    }
    return {
      ...done,
      output: JSON.stringify({
        answers: shown.map((one) => ({
          id: one.id,
          ...yes,
          ...((answers[one.id]?.[call] as object) ?? {}),
        })),
      }),
    };
  });
  const first = await judgeRubric(items, folder);
  expect(first).toMatchObject({
    chunks: 2,
    done: [0],
    failed: [1],
    thirds: 1,
    decided: null,
  });
  expect(existsSync(join(folder, "decided.json"))).toBe(false);
  // Pass b reads pass a's order reversed.
  const order = (prompt: string) =>
    [...prompt.matchAll(/"id": "(t[0-9a-f]{12})"/g)].map(([, id]) => id);
  expect(order(prompts[1]!)).toEqual([...order(prompts[0]!)].reverse());
  for (const prompt of prompts)
    for (const question of TITLE_RUBRIC_QUESTIONS)
      expect(prompt).toContain(question);
  const second = await judgeRubric(items, folder);
  expect(second).toMatchObject({ done: [1], failed: [], decided: 3 });
  const decided = JSON.parse(
    readFileSync(join(folder, "decided.json"), "utf8"),
  );
  expect(decided.version).toBe(1);
  const byId = Object.fromEntries(
    decided.answers.map((one: { id: string }) => [one.id, one]),
  );
  expect(byId["t000000000001"]).toMatchObject({
    namesMain: "no",
    oneStatement: "yes",
    reason: "names a helper | only the helper",
  });
  expect(byId["t000000000002"]).toMatchObject({
    whereToLook: "unsure",
    namesMain: "yes",
    reason: "",
  });
  expect(byId["t000000000003"]).toMatchObject(yes);
});

test("a split no third settles is unsure", () => {
  const pass = (namesMain: string) =>
    ({ answers: [{ id: "t000000000009", ...yes, namesMain }] }) as never;
  expect(
    decideRubric(
      RUBRICS.t,
      ["t000000000009"],
      [pass("yes"), pass("no"), null],
    )[0]!.namesMain,
  ).toBe("unsure");
});

/** A fake labeller answering every item it is shown with `answer`, and keeping each prompt. */
const answering = (answer: (id: string) => Record<string, string>) => {
  const prompts: Array<string> = [];
  setCloudCaller(async (request) => {
    if (request["command"] === "probe") return probeAnswer;
    const prompt = String(request["prompt"]);
    prompts.push(prompt);
    const shown = JSON.parse(
      prompt.slice(
        prompt.indexOf("ITEMS>>>\n") + 9,
        prompt.lastIndexOf("\n<<<END"),
      ),
    ) as Array<{ id: string }>;
    return {
      ...done,
      output: JSON.stringify({
        answers: shown.map((one) => ({ id: one.id, ...answer(one.id) })),
      }),
    };
  });
  return prompts;
};

test("lead lines are judged on the lead rubric's questions and decided into its file", async () => {
  const items = join(root, "leads.json");
  writeFileSync(
    items,
    JSON.stringify({
      version: 1,
      questions: [...LEAD_RUBRIC_QUESTIONS],
      chunks: [
        [
          {
            id: "l000000000001",
            lead: "The suite is renamed.",
            sections: [
              { title: "Rename the suite", facts: "The label changes." },
            ],
          },
        ],
      ],
    }),
  );
  const prompts = answering(() => ({
    together: "yes",
    supported: "no",
    addsNothing: "yes",
    reason: "the sections never say renamed",
  }));
  const folder = join(root, "leads");
  expect(await judgeRubric(items, folder)).toMatchObject({
    done: [0],
    thirds: 0,
    decided: 1,
  });
  for (const question of LEAD_RUBRIC_QUESTIONS)
    expect(prompts[0]).toContain(question);
  expect(prompts[0]).toContain("lead lines");
  const digest = promptDigest(RUBRICS.l);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(digest).not.toBe(promptDigest(RUBRICS.t));
  expect(
    JSON.parse(readFileSync(join(folder, "pass-a-0.json"), "utf8"))
      .promptDigest,
  ).toBe(digest);
  expect(
    JSON.parse(readFileSync(join(folder, "decided.json"), "utf8")),
  ).toEqual({
    version: 1,
    promptDigest: digest,
    answers: [
      {
        id: "l000000000001",
        together: "yes",
        supported: "no",
        addsNothing: "yes",
        reason: "the sections never say renamed",
      },
    ],
  });
});

test("a digest's misleading claim needs its reason; a file mixing rubrics is refused", () => {
  const pass = (misleadingClaim: string, reason: string) =>
    ({
      answers: [
        {
          id: "d000000000001",
          accurate: "yes",
          complete: "yes",
          misleadingClaim,
          neutralBeforeVerdict: "yes",
          reason,
        },
      ],
    }) as never;
  expect(
    decideRubric(
      RUBRICS.d,
      ["d000000000001"],
      [pass("some", "overstates the fix"), pass("some", "calls it safe"), null],
    )[0],
  ).toMatchObject({
    misleadingClaim: "some",
    reason: "overstates the fix | calls it safe",
  });
  expect(RUBRICS.d.questions).toEqual(DIGEST_RUBRIC_QUESTIONS);
  // A lead among titles parses as neither, and an ID no rubric owns names none.
  expect(() =>
    rubricOfItems({
      version: 1,
      questions: [],
      chunks: [
        [item("t000000000001", "First")],
        [{ id: "l000000000001", lead: "x", sections: [] }],
      ],
    }),
  ).toThrow();
  expect(() =>
    rubricOfItems({ version: 1, questions: [], chunks: [[{ id: "x1" }]] }),
  ).toThrow(
    "not a title, lead, digest, match-check, miss-cause, confirmation, category or harness-study rubric's",
  );
});

test("a pass or decision kept under other wording is judged again; a busy labeller stops the run", async () => {
  const items = join(root, "reworded.json");
  writeFileSync(
    items,
    JSON.stringify({
      version: 1,
      questions: [...TITLE_RUBRIC_QUESTIONS],
      chunks: [[item("t000000000011", "Eleventh")]],
    }),
  );
  const folder = join(root, "reworded");
  const prompts = answering(() => yes);
  expect(await judgeRubric(items, folder)).toMatchObject({ decided: 1 });
  expect(prompts).toHaveLength(2);
  // The same wording reuses everything; a decision and passes under another are judged again.
  expect(await judgeRubric(items, folder)).toMatchObject({ done: [] });
  for (const name of ["pass-a-0.json", "pass-b-0.json", "decided-0.json"]) {
    const path = join(folder, name);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({ ...saved, promptDigest: "0".repeat(64) }),
    );
  }
  expect(await judgeRubric(items, folder)).toMatchObject({
    done: [0],
    decided: 1,
  });
  expect(prompts).toHaveLength(4);
  // A labeller another call holds refuses: the run stops with busy set, its claim released.
  const busyFolder = join(root, "busy");
  setCloudCaller(async () => ({
    busy: "another labelling call holds the sign-in",
  }));
  expect(await judgeRubric(items, busyFolder)).toMatchObject({
    done: [],
    failed: [],
    busy: true,
    decided: null,
  });
  expect(existsSync(join(busyFolder, "chunk-0.claim"))).toBe(false);
});
