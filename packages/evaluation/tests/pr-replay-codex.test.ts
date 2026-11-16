// Why: the concern labeller reads review threads anyone can write, so it runs Codex with no tools,
// and its run fails unless the event log holds only known events and the model's own text. That
// rule must fail closed: anything malformed or unknown is a failure. And the Codex home must never
// fall back to the owner's own, nor escape the research volume through a symlink. Both are checked
// here without running a model.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISABLED_FEATURES,
  SAFE_ENABLED_FEATURES,
  configFlags,
  eventProblems,
  labelCodexHome,
} from "../src/pr-replay/codex.ts";

const item = (type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "item.completed", item: { type, ...extra } });

test("a tool-less run's events pass: known events, the model's text, the code-mode notice", () => {
  expect(
    eventProblems(
      [
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        item("error", {
          message:
            "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed.",
        }),
        JSON.stringify({ type: "turn.started" }),
        item("reasoning", { text: "…" }),
        item("agent_message", { text: "{}" }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
        "",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("anything else fails closed", () => {
  const cases: Array<[string, string]> = [
    [item("command_execution"), "command_execution"],
    [item("file_change"), "file_change"],
    [item("mcp_tool_call"), "mcp_tool_call"],
    [item("web_search"), "web_search"],
    [item("error", { message: "something else" }), "an error item"],
    [JSON.stringify({ type: "item.completed" }), "an item without a type"],
    [
      JSON.stringify({ type: "item.completed", item: { type: 3 } }),
      "an item without a type",
    ],
    [JSON.stringify({ type: "turn.failed" }), "event turn.failed"],
    [JSON.stringify({ type: "error", message: "x" }), "event error"],
    [JSON.stringify({ item: { type: "agent_message" } }), "event undefined"],
    [` ${item("command_execution")}`, "a line that is not a JSON event"],
    ["warning: something", "a line that is not a JSON event"],
    ["{not json", "an unparsed event"],
  ];
  for (const [line, problem] of cases)
    expect(eventProblems(line)).toEqual([problem]);
});

test("the shell, code mode and web search are configured off, and never allowed on", () => {
  expect(DISABLED_FEATURES).toContain("shell_tool");
  expect(DISABLED_FEATURES).toContain("code_mode_host");
  expect(SAFE_ENABLED_FEATURES.has("shell_tool")).toBe(false);
  expect(SAFE_ENABLED_FEATURES.has("code_mode_host")).toBe(false);
  const root = mkdtempSync(join(tmpdir(), "replay-flags-"));
  const before = { ...process.env };
  try {
    process.env["NEUVE_RESEARCH_ROOT"] = root;
    // The getter resolves the pinned catalog's folder and refuses when it does not exist yet.
    expect(() => configFlags()).toThrow("run pin-catalog first");
    mkdirSync(join(root, "codex-catalog"));
    expect(configFlags()).toContain('web_search="disabled"');
    expect(configFlags()).toContain("features.code_mode_host=false");
    expect(configFlags().join(" ")).toContain("model_catalog_json=");
  } finally {
    process.env = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the labelling Codex home must be set and really inside the research volume", () => {
  const root = mkdtempSync(join(tmpdir(), "replay-codex-"));
  const outside = mkdtempSync(join(tmpdir(), "replay-codex-outside-"));
  const before = { ...process.env };
  try {
    process.env["NEUVE_RESEARCH_ROOT"] = root;
    mkdirSync(join(root, "codex-home"));
    symlinkSync(outside, join(root, "linked-home"));
    delete process.env["NEUVE_LABEL_CODEX_HOME"];
    expect(() => labelCodexHome()).toThrow("set NEUVE_LABEL_CODEX_HOME");
    for (const home of [
      outside,
      `${root}-other`,
      join(root, "missing"),
      join(root, "linked-home"),
    ]) {
      process.env["NEUVE_LABEL_CODEX_HOME"] = home;
      expect(() => labelCodexHome()).toThrow("must be an existing folder");
    }
    process.env["NEUVE_LABEL_CODEX_HOME"] = join(root, "codex-home");
    expect(labelCodexHome()).toEndWith("/codex-home");
  } finally {
    process.env = before;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
