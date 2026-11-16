// Why: in the cloud (10.131) Codex runs in a Sandbox holding its own sign-in, and the gate's rules
// stay here: the box only reports and runs. So no prompt may reach the box before a probe of it
// passed the same checks as the Mac's, plus the pinned Linux install and a Codex home holding only
// the sign-in and the catalog. The box must be sent only placeholder paths, and a call must fail
// like a tool call when the install, the catalog or the home changed during it. The catalog Codex
// downloads on its first call is the one change allowed, once it passes the catalog checks.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "replay-cloud-"));
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
  runToolless,
  setCloudCaller,
} = await import("../src/pr-replay/codex.ts");
afterEach(() => setCloudCaller(undefined));

const entry = {
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
};
const cache = JSON.stringify({ models: [entry] });
const home = join(root, "codex-home");
mkdirSync(home);
writeFileSync(join(home, "models_cache.json"), cache);
pinCatalog(home);

const features = [
  ...DISABLED_FEATURES.map((name) => `${name}  stable  false`),
  ...[...SAFE_ENABLED_FEATURES].map((name) => `${name}  stable  true`),
].join("\n");

const facts = (over: Record<string, unknown> = {}) => ({
  installHash: PINNED_LINUX_INSTALL_HASH,
  modelsCache: null as string | null,
  modelsCacheSha256: null as string | null,
  homeFiles: ["auth.json"],
  ...over,
});
const probe = (over: Record<string, unknown> = {}) => ({
  version: `${PINNED_CODEX_VERSION}\n`,
  features,
  configSources: [],
  created: [],
  ...facts(),
  ...over,
});
const clean = '{"type":"thread.started"}\n{"type":"turn.completed"}\n';
const done = (after: Record<string, unknown> = {}, stdout = clean) => ({
  stdout,
  stderr: "",
  code: 0,
  timedOut: false,
  wallSeconds: 3,
  output: '{"ok":true}',
  after: facts(after),
  created: ["tmp"],
});

/**
 * A fresh fake box for a test (the gate forgets what it judged): it answers each request with the
 * next queued answer, and keeps what it was sent. `queue` adds answers later in the same test.
 */
const box = (answers: Array<unknown>) => {
  const sent: Array<Record<string, unknown>> = [];
  setCloudCaller(async (request) => {
    sent.push(request);
    return answers.shift();
  });
  return { sent, queue: (...more: Array<unknown>) => answers.push(...more) };
};

let runs = 0;
const run = () => {
  const runDir = join(root, `run-${++runs}`);
  mkdirSync(runDir);
  return {
    runDir,
    prompt: "the prompt",
    schema: { type: "object" },
    log: join(root, `log-${runs}.jsonl`),
    effort: "medium" as const,
  };
};

test("a judged probe, then a call with placeholder paths, gives the answer", async () => {
  const { sent } = box([probe(), done()]);
  const result = await runToolless(run(), []);
  expect(result.failure).toBeNull();
  expect(result.output).toEqual({ ok: true });
  expect(result.receipt.where).toBe("cloud");
  expect(sent.map((request) => request["command"])).toEqual(["probe", "exec"]);
  const exec = JSON.stringify(sent[1]);
  expect(exec).toContain("{RUN_DIR}");
  expect(exec).toContain("{CATALOG}");
  expect(exec).not.toContain(root);
  expect(sent[1]!["expect"]).toEqual({
    installHash: PINNED_LINUX_INSTALL_HASH,
    modelsCacheSha256: null,
  });
});

test("no prompt reaches a box that fails its probe", async () => {
  for (const [bad, message] of [
    [{ version: "codex-cli 0.165.0\n" }, "not codex-cli"],
    [{ installHash: "0".repeat(64) }, "not the pinned Linux build"],
    [
      { homeFiles: ["auth.json", "config.toml"] },
      "files the gate does not know",
    ],
    [
      { configSources: ["/signin/codex-home/x.toml"] },
      "configuration the gate does not see",
    ],
    [
      {
        features: features.replace(
          "shell_tool  stable  false",
          "shell_tool  stable  true",
        ),
      },
      "not list these features as off",
    ],
    [
      {
        modelsCache: JSON.stringify({
          models: [{ ...entry, tool_mode: "direct" }],
        }),
      },
      "not code_mode_only",
    ],
  ] as const) {
    const { sent } = box([probe(bad)]);
    await expect(runToolless(run(), [])).rejects.toThrow(message);
    expect(sent).toHaveLength(1);
  }
});

test("the first call's downloaded catalog is allowed once it passes; a change after is not", async () => {
  const sha = "a".repeat(64);
  const { sent, queue } = box([
    probe(),
    done({
      modelsCache: cache,
      modelsCacheSha256: sha,
      homeFiles: ["auth.json", "models_cache.json"],
    }),
  ]);
  expect((await runToolless(run(), [])).failure).toBeNull();
  // The next call, unprobed, expects that catalog; one that changed during it fails like a tool call.
  queue(
    done({
      modelsCache: cache,
      modelsCacheSha256: "b".repeat(64),
      homeFiles: ["auth.json", "models_cache.json"],
    }),
  );
  const changed = await runToolless(run(), []);
  expect(changed.failure).toContain("the model catalog changed during the run");
  expect(changed.output).toBeNull();
  expect(sent.map((request) => request["command"])).toEqual([
    "probe",
    "exec",
    "exec",
  ]);
  expect(
    (sent[2]!["expect"] as { modelsCacheSha256: string }).modelsCacheSha256,
  ).toBe(sha);
});

test("an install or home that changed during a call fails it, and the next call is probed again", async () => {
  const { sent, queue } = box([probe(), done({ installHash: "c".repeat(64) })]);
  const result = await runToolless(run(), []);
  expect(result.failure).toContain("failed its checks after the run");
  queue(probe(), done({ homeFiles: ["auth.json", "sessions"] }));
  expect((await runToolless(run(), [])).failure).toContain(
    "files the gate does not know",
  );
  expect(sent.map((request) => request["command"])).toEqual([
    "probe",
    "exec",
    "probe",
    "exec",
  ]);
});

test("a refused call is judged again once; a tool call's answer is discarded", async () => {
  const { sent, queue } = box([
    probe(),
    { refused: "moved", ...facts() },
    probe(),
    done(),
  ]);
  expect((await runToolless(run(), [])).failure).toBeNull();
  expect(sent.map((request) => request["command"])).toEqual([
    "probe",
    "exec",
    "probe",
    "exec",
  ]);
  queue(
    done(
      {},
      `${clean}{"type":"item.completed","item":{"type":"command_execution"}}\n`,
    ),
  );
  const tool = await runToolless(run(), []);
  expect(tool.failure).toContain("command_execution");
  expect(tool.output).toBeNull();
});

test("what Codex made is named in the receipt, and a stopped box stops the run", async () => {
  const { queue } = box([probe(), done()]);
  expect((await runToolless(run(), [])).receipt.codexCreated).toEqual(["tmp"]);
  queue({ stopped: "auth.json in the Codex home is a link or a folder" });
  await expect(runToolless(run(), [])).rejects.toThrow("stopped");
});

// Why: a call cut off by the Sandbox's lifetime left an unreset home on the volume (26 October).
// The receipt must show the Sandbox's age and the home as the call found it, and label.py's
// refusal to start a call no Sandbox can fit must stop the run like any stop.
test("the receipt shows the Sandbox's age and the home as found; no fitting Sandbox stops the run", async () => {
  const labeller = { sandbox: "sb-1", ageS: 4_000, fresh: false };
  const { queue } = box([
    probe(),
    { ...done(), homeBefore: ["auth.json", "state_5.sqlite"], labeller },
  ]);
  const { receipt } = await runToolless(run(), []);
  expect(receipt.labeller).toEqual(labeller);
  expect(receipt.codexHomeBefore).toEqual(["auth.json", "state_5.sqlite"]);
  // Which code wrote the record: this checkout's commit and whether its tree had any change.
  expect(receipt.orchestrator).toMatchObject({ dirty: expect.any(Boolean) });
  expect(receipt.orchestrator.commit).toMatch(/^[0-9a-f]{40}$/);
  queue({ stopped: "no labelling Sandbox fits the call: its age is unknown" });
  await expect(runToolless(run(), [])).rejects.toThrow(
    "no labelling Sandbox fits the call",
  );
});

// Why: the gate is judged once per process and cached. Each labeller has its own Sandbox and Codex
// home, so a call on another labeller must be probed afresh, never run on the other's judgement.
test("a call on another labeller is probed afresh, never on the cached gate", async () => {
  const { sent, queue } = box([probe(), done()]);
  process.env["NEUVE_LABELLER"] = "1";
  try {
    expect((await runToolless(run(), [])).failure).toBeNull();
    queue(done());
    expect((await runToolless(run(), [])).failure).toBeNull();
    process.env["NEUVE_LABELLER"] = "2";
    queue(probe(), done());
    expect((await runToolless(run(), [])).failure).toBeNull();
    expect(sent.map((request) => request["command"])).toEqual([
      "probe",
      "exec",
      "exec",
      "probe",
      "exec",
    ]);
  } finally {
    delete process.env["NEUVE_LABELLER"];
  }
});
