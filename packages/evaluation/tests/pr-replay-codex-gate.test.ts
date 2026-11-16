// Why: labelling runs Codex with no tools, and that rests on the gate: this exact Codex install,
// every tool feature listed once and off, nothing unknown on, the downloaded model catalog keeping
// every tool behind the code-mode host, and no configuration the gate cannot see. ChatGPT.app replaces the install in place, a truncated or doubled `features list` could hide
// a tool, and a config file beside the run could switch one on. So each way the gate must refuse is
// checked against a fake Codex, including an install that changes while it is being checked.
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "replay-gate-"));
const environment = { ...process.env };
afterAll(() => {
  // Later test files read the same variables: leave them as they were.
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});
const install = join(root, "install");
mkdirSync(install);
const fake = join(install, "codex");
process.env["NEUVE_CODEX_BINARY"] = fake;
process.env["NEUVE_CODEX_INSTALL_ROOT"] = install;
process.env["NEUVE_RESEARCH_ROOT"] = root;
const {
  DISABLED_FEATURES,
  PINNED_CODEX_VERSION,
  SAFE_ENABLED_FEATURES,
  checkCodexGate,
  configSources,
  pinCatalog,
  pinnedCatalogPath,
  runToolless,
} = await import("../src/pr-replay/codex.ts");

const home = join(root, "codex-home");
mkdirSync(home);

/** The model catalog Codex downloads into its home, with the labelling model's entry. */
const catalog = (entry: Record<string, unknown> | null, extra = 0) =>
  writeFileSync(
    join(home, "models_cache.json"),
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      models: [
        { slug: "another-model", tool_mode: "direct" },
        ...(entry === null ? [] : Array(1 + extra).fill(entry)),
      ],
    }),
  );
const safeEntry = {
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
catalog(safeEntry);
pinCatalog(home);

/**
 * A fake Codex printing a version and a features table; each install differs, so the gate checks
 * it afresh. With `changeWhileListing`, listing its features rewrites the install; with
 * `changeWhileRunning`, an exec does, after the gate passed; with `directToolsWhileRunning`, an exec
 * rewrites the model catalog to offer tools directly.
 */
const put = (
  version: string,
  rows: ReadonlyArray<string>,
  changeWhileListing = false,
  changeWhileRunning = false,
  directToolsWhileRunning = false,
) => {
  writeFileSync(join(root, "version.txt"), `${version}\n`);
  writeFileSync(join(root, "features.txt"), `${rows.join("\n")}\n`);
  const touch = changeWhileListing
    ? `echo changed >> "${join(install, "codex-package.json")}"; `
    : "";
  // Faults an exec can show, once each, by a marker file: a failure Codex reports, or a tool call.
  const execFaults =
    `[ -f "${join(root, "fail-once")}" ] && { rm "${join(root, "fail-once")}"; echo '{"type":"error","message":"stream disconnected before completion"}'; echo '{"type":"turn.failed","error":{"message":"stream disconnected"}}'; exit 1; }; ` +
    `[ -f "${join(root, "tool")}" ] && { echo '{"type":"item.completed","item":{"type":"command_execution","command":"cat x"}}'; }; `;
  const changeOnExec =
    (changeWhileRunning
      ? `echo changed >> "${join(install, "codex-package.json")}"; `
      : "") +
    (directToolsWhileRunning
      ? `printf '%s' '${JSON.stringify({ models: [{ ...safeEntry, tool_mode: "direct" }] })}' > "${join(home, "models_cache.json")}"; `
      : "");
  writeFileSync(
    fake,
    `#!/bin/sh\n# ${Math.random()}\nout=""; prev=""\nfor a in "$@"; do\n  [ "$a" = "--version" ] && exec cat "${join(root, "version.txt")}"\n  [ "$a" = "features" ] && { ${touch}exec cat "${join(root, "features.txt")}"; }\n  [ "$prev" = "--output-last-message" ] && out="$a"\n  prev="$a"\ndone\nif [ -n "$out" ]; then cat > /dev/null; ${changeOnExec}${execFaults}echo '{"ok":true}' > "$out"; echo '{"type":"thread.started"}'; echo '{"type":"turn.completed"}'; exit 0; fi\nexit 2\n`,
  );
  chmodSync(fake, 0o755);
};

const good = [
  ...DISABLED_FEATURES.map((name) => `${name}  stable  false`),
  ...[...SAFE_ENABLED_FEATURES].map(
    (name) => `${name}  under development  true`,
  ),
];

test("the probed version with every tool feature off once passes", async () => {
  put(PINNED_CODEX_VERSION, good);
  expect(await checkCodexGate(home)).toMatch(/^[0-9a-f]{64}$/);
});

test("each way the install can be unsafe refuses, checked afresh on every change", async () => {
  const refusals: Array<[string, () => void]> = [
    [
      "not list these features as off",
      () => put(PINNED_CODEX_VERSION, good.slice(1)),
    ],
    [
      "not list these features as off",
      () =>
        put(PINNED_CODEX_VERSION, [
          ...good.slice(1),
          `${DISABLED_FEATURES[0]}  stable  true`,
        ]),
    ],
    [
      "more than once",
      () =>
        put(PINNED_CODEX_VERSION, [
          `${DISABLED_FEATURES[0]}  stable  true`,
          ...good,
        ]),
    ],
    [
      "not known to be safe",
      () => put(PINNED_CODEX_VERSION, [...good, "new_tool  stable  true"]),
    ],
    ["probe the new version", () => put("codex-cli 9.9.9", good)],
    ["changed during the gate", () => put(PINNED_CODEX_VERSION, good, true)],
  ];
  for (const [message, setUp] of refusals) {
    setUp();
    await expect(checkCodexGate(home)).rejects.toThrow(message);
  }
  put(PINNED_CODEX_VERSION, good);
  expect(await checkCodexGate(home)).toMatch(/^[0-9a-f]{64}$/);
});

test("runs are pinned to a local catalog of the model alone, with no experimental tools", async () => {
  put(PINNED_CODEX_VERSION, good);
  const pinned = JSON.parse(readFileSync(pinnedCatalogPath(), "utf8"));
  expect(pinned.models).toHaveLength(1);
  expect(pinned.models[0].experimental_supported_tools).toEqual([]);
  const pin = (models: ReadonlyArray<unknown>) =>
    writeFileSync(pinnedCatalogPath(), JSON.stringify({ models }));
  const refusals: Array<[string, () => void]> = [
    ["no model catalog", () => rmSync(pinnedCatalogPath())],
    ["2 models", () => pin([pinned.models[0], { slug: "other" }])],
    [
      "not code_mode_only",
      () => pin([{ ...pinned.models[0], tool_mode: "direct" }]),
    ],
    [
      "experimental tools",
      () =>
        pin([{ ...pinned.models[0], experimental_supported_tools: ["clock"] }]),
    ],
  ];
  for (const [message, setUp] of refusals) {
    setUp();
    await expect(checkCodexGate(home)).rejects.toThrow(message);
  }
  pinCatalog(home);
  expect(await checkCodexGate(home)).toMatch(/^[0-9a-f]{64}$/);
});

test("a pinned catalog folder that leads outside the research volume refuses", () => {
  const outside = mkdtempSync(join(tmpdir(), "replay-gate-outside-"));
  const folder = join(root, "codex-catalog");
  const kept = join(root, "codex-catalog-kept");
  try {
    renameSync(folder, kept);
    symlinkSync(outside, folder);
    expect(() => pinnedCatalogPath()).toThrow("leads outside");
  } finally {
    rmSync(folder, { force: true });
    renameSync(kept, folder);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the model's catalog entry must keep every tool behind code mode", async () => {
  put(PINNED_CODEX_VERSION, good);
  const refusals: Array<[string, () => void]> = [
    ["0 entries", () => catalog(null)],
    ["2 entries", () => catalog(safeEntry, 1)],
    [
      "not code_mode_only",
      () => catalog({ ...safeEntry, tool_mode: "direct" }),
    ],
    [
      "experimental tools",
      () =>
        catalog({
          ...safeEntry,
          experimental_supported_tools: ["clock", "read_file"],
        }),
    ],
    [
      "experimental tools",
      () => catalog({ ...safeEntry, experimental_supported_tools: undefined }),
    ],
    [
      "an upgrade",
      () => catalog({ ...safeEntry, upgrade: { model: "other" } }),
    ],
    ["an upgrade", () => catalog({ ...safeEntry, upgrade: undefined })],
    ["shell_type", () => catalog({ ...safeEntry, shell_type: "local" })],
    [
      "node_repl_disabled",
      () => catalog({ ...safeEntry, node_repl_disabled: true }),
    ],
    [
      "web_search_tool_type",
      () => catalog({ ...safeEntry, web_search_tool_type: "text" }),
    ],
  ];
  for (const [message, setUp] of refusals) {
    setUp();
    await expect(checkCodexGate(home)).rejects.toThrow(message);
  }
  catalog(safeEntry);
  expect(await checkCodexGate(home)).toMatch(/^[0-9a-f]{64}$/);
});

test("configuration the gate cannot see is found: a .toml in the Codex home or a .codex above the run", () => {
  const runDir = join(root, "case", "labels", "pass-a");
  mkdirSync(runDir, { recursive: true });
  expect(configSources(home, runDir)).toEqual([]);
  for (const name of ["config.toml", "managed_config.toml", "x.config.toml"]) {
    writeFileSync(join(home, name), "");
    expect(configSources(home, runDir)).toEqual([join(home, name)]);
    rmSync(join(home, name));
  }
  mkdirSync(join(root, "case", ".codex"));
  const found = join(realpathSync(join(root, "case")), ".codex");
  expect(configSources(home, runDir)).toEqual([found]);
  // A run folder reached through a symlink is walked from its real path.
  const linked = join(root, "elsewhere");
  mkdirSync(linked);
  symlinkSync(runDir, join(linked, "pass-a"));
  expect(configSources(home, join(linked, "pass-a"))).toEqual([found]);
});

test("an install that changes during a run discards the run's answer and log", async () => {
  process.env["NEUVE_RESEARCH_ROOT"] = root;
  process.env["NEUVE_LABEL_CODEX_HOME"] = home;
  const run = (name: string) => {
    const runDir = join(root, "runs", name);
    mkdirSync(runDir, { recursive: true });
    return {
      runDir,
      prompt: "label",
      schema: { type: "object" },
      log: join(root, "runs", `${name}.jsonl`),
      effort: "medium" as const,
    };
  };
  put(PINNED_CODEX_VERSION, good);
  const clean = await runToolless(run("clean"));
  expect(clean.failure).toBeNull();
  expect(clean.output).toEqual({ ok: true });
  put(PINNED_CODEX_VERSION, good, false, false, true);
  const turned = await runToolless(run("turned"));
  expect(turned.failure).toContain("model catalog");
  expect(turned.output).toBeNull();
  expect(existsSync(join(root, "runs", "turned.jsonl"))).toBe(false);
  catalog(safeEntry);
  put(PINNED_CODEX_VERSION, good, false, true);
  const changed = await runToolless(run("changed"));
  expect(changed.failure).toContain(
    "install or model catalog changed during the run",
  );
  expect(changed.output).toBeNull();
  expect(existsSync(join(root, "runs", "changed", "output.json"))).toBe(false);
  expect(existsSync(join(root, "runs", "changed.jsonl"))).toBe(false);
});

test("a run Codex failed on its own is retried; a run that called a tool never is", async () => {
  process.env["NEUVE_RESEARCH_ROOT"] = root;
  process.env["NEUVE_LABEL_CODEX_HOME"] = home;
  put(PINNED_CODEX_VERSION, good);
  const run = (name: string) => {
    const runDir = join(root, "retries", name);
    mkdirSync(runDir, { recursive: true });
    return {
      runDir,
      prompt: "label",
      schema: { type: "object" },
      log: join(root, "retries", `${name}.jsonl`),
      effort: "medium" as const,
    };
  };
  writeFileSync(join(root, "fail-once"), "");
  const retried = await runToolless(run("server"), [0, 0]);
  expect(retried.failure).toBeNull();
  expect(retried.receipt.attempts).toBe(2);
  writeFileSync(join(root, "fail-once"), "");
  const given = await runToolless(run("given-up"), []);
  expect(given.failure).toContain(
    "Codex said: stream disconnected before completion",
  );
  expect(given.output).toBeNull();
  writeFileSync(join(root, "tool"), "");
  const tool = await runToolless(run("tool"), [0, 0]);
  rmSync(join(root, "tool"));
  expect(tool.failure).toContain("command_execution");
  expect(tool.failure).not.toContain("Codex said");
  expect(tool.receipt.attempts).toBe(1);
  expect(existsSync(join(root, "retries", "tool.jsonl"))).toBe(false);
});
