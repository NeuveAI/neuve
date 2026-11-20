/**
 * The recorded proofs, in the order they may run, to be re-recorded after a Codex update:
 *
 * 1. `handshake`: `initialize` and `initialized` only.
 * 2. `names`: reads the names of the person's own MCP servers, plugins, apps and skills, which the
 *    launch configuration switches off one by one. Nothing is recorded; the names go to `--out`.
 * 3. `read-only`: every read-only request, under the launch configuration, recorded.
 *
 * There is no turn step: the read-only step shows that the model would not be left with only a
 * client's tools (PROTOCOL.md, at the top).
 */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { Answer, CodexConnection, ServerRequest } from "../src/client.ts";
import type { CodexFailure } from "../src/errors.ts";

export interface Step {
  /** Arguments after `app-server`. */
  readonly args: () => ReadonlyArray<string>;
  readonly answer: (request: ServerRequest) => Answer;
  /** False when the step's output is the text it returns, not the conversation. */
  readonly recorded: boolean;
  readonly run: (
    connection: CodexConnection,
    workdir: string,
  ) => Effect.Effect<string, CodexFailure>;
}

/** A request Codex sends during these steps is a surprise: refuse it. */
const refuse = (): Answer => ({
  error: { code: -32601, message: "not expected in this step" },
});

/**
 * Features 0.171.0-alpha.13 enables by default here that give the model a tool, load outside code,
 * or are not on the replay judge's safe list, each switched off. It is not yet the one list the
 * design asks for: it switches off twelve names the replay judge's Mac list
 * (`MAC_DISABLED_FEATURES` in packages/evaluation/src/pr-replay/codex.ts) does not, all enabled
 * by default in this release and absent or safe-listed when that list was made, and leaves out
 * two of that list's names (`plugin_discovery_prefetch`, `multi_agent_v2`) that are off by default
 * here. `unified_exec` is on the judge's safe list and is switched off here; Codex ignores that.
 */
export const DISABLED_FEATURES = [
  "tui_workspace",
  "shell_tool",
  "view_image",
  "sleep_tool",
  "unified_exec",
  "unified_exec_tty",
  "shell_snapshot",
  "untrusted_as_tool_output",
  "code_mode_host",
  "code_mode_host_grpc",
  "code_mode_host_output_truncation",
  "hooks",
  "multi_agent",
  "apps",
  "deferred_tool_world_state",
  "incremental_tools_legacy",
  "incremental_tools_legacy_gcp",
  "prediction_preserve_parent_tools",
  "tool_suggest",
  "plugins",
  "in_app_browser",
  "in_app_local_automation",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
  "remote_plugin",
  "plugin_sharing",
  "image_generation",
  "unified_image_budget",
  "skill_mcp_dependency_install",
  "skill_search",
  "guardian_include_additional_context",
  "goals",
  "reasoning_effort_override",
  "retain_client_tool_outputs",
  "workspace_dependencies",
  "memories",
];

/** The person's own settings to switch off by name. */
export interface OwnSettings {
  readonly mcpServers: ReadonlyArray<string>;
  readonly plugins: ReadonlyArray<string>;
  readonly apps: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
}
/** `-c` splits a key on every dot and takes quotes literally, so a name with a dot cannot be set. */
const key = (name: string) => {
  if (name.includes(".") || name.includes('"'))
    throw new Error(`a -c key cannot name ${JSON.stringify(name)}`);
  return name;
};

/** Arguments after `app-server` that should leave the model only a client's MCP tools. */
export const launchConfiguration = (own: OwnSettings) =>
  [
    ...DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
    'web_search="disabled"',
    ...own.mcpServers.map((name) => `mcp_servers.${key(name)}.enabled=false`),
    ...own.plugins.map((name) => `plugins.${key(name)}.enabled=false`),
    ...own.apps.map((name) => `apps.${key(name)}.enabled=false`),
    "apps._default.enabled=false",
    "skills.bundled.enabled=false",
    "skills.include_instructions=false",
    ...(own.skills.length === 0
      ? []
      : [
          `skills.config=[${own.skills
            .map((name) => `{name=${JSON.stringify(name)},enabled=false}`)
            .join(",")}]`,
        ]),
    "memories.use_memories=false",
    "memories.generate_memories=false",
    "agents.enabled=false",
    "notify=[]",
    'history.persistence="none"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'shell_environment_policy.inherit="none"',
    "project_doc_max_bytes=0",
    "check_for_update_on_startup=false",
    "analytics.enabled=false",
    "feedback.enabled=false",
  ].flatMap((setting) => ["-c", setting]);

const ownSettings = (): OwnSettings => {
  const path = process.env.NEUVE_CODEX_OWN_SETTINGS;
  if (path === undefined)
    throw new Error(
      "set NEUVE_CODEX_OWN_SETTINGS to the file the names step wrote",
    );
  return JSON.parse(readFileSync(path, "utf8")) as OwnSettings;
};

/**
 * Every read-only request, none of which sends a model request. `mcpServerStatus/list` is asked
 * only here, where the person's servers are switched off by name, since listing can start them.
 */
const readOnly = (connection: CodexConnection, workdir: string) =>
  Effect.gen(function* () {
    yield* connection.request("config/read", {
      includeLayers: true,
      cwd: workdir,
    });
    yield* connection.request("configRequirements/read");
    let cursor: string | null = null;
    do {
      const page: { nextCursor: string | null } = yield* connection.request(
        "experimentalFeature/list",
        { cursor, limit: 200 },
      );
      cursor = page.nextCursor;
    } while (cursor !== null);
    yield* connection.request("model/list", {
      includeHidden: true,
      limit: 200,
    });
    yield* connection.request("account/read", { refreshToken: false });
    yield* connection.request("hooks/list", { cwds: [workdir] });
    yield* connection.request("skills/list", { cwds: [workdir] });
    yield* connection.request("app/list", { limit: 200 });
    yield* connection.request("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
    });
    return "read-only requests under the launch configuration";
  });

/** The names the launch configuration needs, from the person's own configuration and skills. */
const names = (connection: CodexConnection, workdir: string) =>
  Effect.gen(function* () {
    const { config } = yield* connection.request("config/read", {
      cwd: workdir,
    });
    const settings = config as Record<string, unknown>;
    const keys = (value: unknown) => Object.keys((value ?? {}) as object);
    const skills = yield* connection.request("skills/list", {
      cwds: [workdir],
    });
    const own: OwnSettings = {
      mcpServers: keys(settings.mcp_servers),
      plugins: keys(settings.plugins),
      apps: keys(settings.apps).filter((name) => name !== "_default"),
      skills: [
        ...new Set(
          skills.data.flatMap((entry) =>
            entry.skills
              .filter((skill) => skill.scope === "user")
              .map((skill) => skill.name),
          ),
        ),
      ],
    };
    return JSON.stringify(own);
  });

export const steps = {
  handshake: {
    args: () => [],
    answer: refuse,
    recorded: true,
    run: () => Effect.succeed("initialize and initialized only"),
  },
  names: { args: () => [], answer: refuse, recorded: false, run: names },
  "read-only": {
    args: () => launchConfiguration(ownSettings()),
    answer: refuse,
    recorded: true,
    run: readOnly,
  },
} satisfies Record<string, Step>;
