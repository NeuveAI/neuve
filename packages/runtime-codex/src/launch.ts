/**
 * How a Codex process is started for a session and what each turn is set to: the design's mode
 * table ([tools](../../../process/proposals/codex-runtime.md#tools-codex-keeps-its-own-and-neuves-are-served-beside-them)).
 * Codex's configuration is fixed when its process starts, so the two configurations below are two
 * processes: the person's own Codex, and a clean one for a read-only turn.
 */
import { dirname, join } from "node:path";
import type { SessionPolicy, TurnWorkspace } from "@neuve/runtime";
import type { AskForApproval } from "./generated/v2/AskForApproval";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy";

/** The variable Neuve's tool server token is in; Codex's shell never passes it on. */
export const TOKEN_VARIABLE = "NEUVE_CODEX_TOOL_TOKEN";
export const NEUVE_SERVER = "neuve";
export const NEUVE_PLUGINS_SERVER = "neuve_plugins";
// A year: a call ends when its handler does, or the turn or the session ends.
const TOOL_TIMEOUT_SECONDS = 31_536_000;
export type ToolServers = Readonly<
  Partial<Record<typeof NEUVE_SERVER | typeof NEUVE_PLUGINS_SERVER, string>>
>;
/** OpenAI's key and address variables, removed so Codex uses its own login, as T3 Code does. */
export const REMOVED_ENVIRONMENT = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
  "CODEX_API_KEY",
  "CODEX_HOME",
  TOKEN_VARIABLE,
] as const;

export type CodexTokenCommand = readonly [command: string, ...args: string[]];

const chatgptPlan = ([command, ...args]: CodexTokenCommand) => [
  'model_provider="openai_chatgpt_plan"',
  `model_providers.openai_chatgpt_plan={name="ChatGPT plan",base_url="https://api.openai.com/v1",model_catalog_url="https://api.openai.com/v1/models",wire_api="responses",requires_openai_auth=false,supports_websockets=false,auth={command=${JSON.stringify(command)},args=${JSON.stringify(args)},timeout_ms=90000,refresh_interval_ms=0}}`,
  "features.api_key_model_discovery=true",
];

/** The person's settings and the skill flags derived from the startup probe. */
export interface OwnSettings {
  readonly mcpServers: ReadonlyArray<string>;
  readonly plugins: ReadonlyArray<string>;
  readonly apps: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<{
    readonly path: string;
    readonly enabled: Readonly<Record<Configuration, boolean>>;
  }>;
  /**
   * The person's own `shell_environment_policy.exclude`. A `-c` value replaces the setting, so
   * the token's variable is added to this list, never put in its place.
   */
  readonly exclude: ReadonlyArray<string>;
  readonly includeOnly?: ReadonlyArray<string>;
}
export type Configuration = "own" | "clean";

/** Features that run the person's additions, or reach outside the sandbox, off in a clean session. */
const PERSONAL_FEATURES = [
  "hooks",
  "apps",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "memories",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "in_app_local_automation",
  "skill_mcp_dependency_install",
  "tool_suggest",
];

/**
 * `-c` splits a key on every dot and takes quotes literally, so a name with a dot or a quote cannot
 * be switched off from the command line (the protocol facts). Such a name is returned, and the
 * clean session is refused rather than started with that setting on.
 */
export const unaddressable = (own: OwnSettings): string | undefined =>
  [...own.mcpServers, ...own.plugins, ...own.apps].find((name) =>
    /[."=\s]/.test(name),
  );

const flags = (settings: ReadonlyArray<string>) =>
  settings.flatMap((setting) => ["-c", setting]);

/**
 * The arguments after `app-server`. Both configurations serve Neuve's HTTP tools (when the session
 * has any), approved without asking, with no limit on how long a call takes, and keep the token's
 * variable out of every command Codex runs. Codex's own question tool is off in both: a question
 * for the person goes through Neuve's own tool, and nothing in a Neuve session answers Codex's.
 */
export const launchArguments = (
  configuration: Configuration,
  own: OwnSettings,
  toolServers: ToolServers | undefined,
  tokenCommand?: CodexTokenCommand,
  environment?: SessionPolicy["environment"],
  mcpServers?: SessionPolicy["mcpServers"],
): ReadonlyArray<string> => {
  const variables = Object.entries(environment ?? {});
  const includeOnly = own.includeOnly ?? [];
  const reserved = new Set(own.mcpServers);
  const pluginServers =
    configuration === "own"
      ? Object.entries(mcpServers ?? {}).flatMap(([name, server]) => {
          const preferred = `neuve_${name.replace(/[^A-Za-z0-9_]/gu, "_")}`;
          let alias = preferred;
          for (let count = 2; reserved.has(alias); count++)
            alias = `${preferred}_${count}`;
          reserved.add(alias);
          const prefix = `mcp_servers.${alias}`;
          const env = Object.entries(server.env ?? {})
            .map(
              ([key, value]) =>
                `${JSON.stringify(key)}=${JSON.stringify(value)}`,
            )
            .join(",");
          return [
            `${prefix}.command=${JSON.stringify(server.command)}`,
            `${prefix}.args=${JSON.stringify(server.args ?? [])}`,
            ...(env === "" ? [] : [`${prefix}.env={${env}}`]),
            `${prefix}.default_tools_approval_mode="approve"`,
            ...(server.direct
              ? [
                  `${prefix}.omit_tools_from=["deferred","code_mode"]`,
                  `${prefix}.tool_timeout_sec=${TOOL_TIMEOUT_SECONDS}`,
                ]
              : []),
          ];
        })
      : [];
  return flags([
    ...(tokenCommand === undefined ? [] : chatgptPlan(tokenCommand)),
    ...variables.map(
      ([name, value]) =>
        `shell_environment_policy.set.${name}=${JSON.stringify(value)}`,
    ),
    ...pluginServers,
    ...(variables.length === 0 || includeOnly.length === 0
      ? []
      : [
          `shell_environment_policy.include_only=${JSON.stringify([...new Set([...includeOnly, ...Object.keys(environment ?? {})])])}`,
        ]),
    ...Object.entries(toolServers ?? {}).flatMap(([name, url]) => [
      `mcp_servers.${name}.url=${JSON.stringify(url)}`,
      `mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(TOKEN_VARIABLE)}`,
      `mcp_servers.${name}.default_tools_approval_mode="approve"`,
      `mcp_servers.${name}.tool_timeout_sec=${TOOL_TIMEOUT_SECONDS}`,
      ...(name === NEUVE_SERVER
        ? [`mcp_servers.${name}.omit_tools_from=["deferred","code_mode"]`]
        : []),
    ]),
    ...(toolServers === undefined
      ? []
      : [
          `shell_environment_policy.exclude=${JSON.stringify([...own.exclude, TOKEN_VARIABLE])}`,
        ]),
    "tools.experimental_request_user_input.enabled=false",
    "skills.bundled.enabled=false",
    ...(own.skills.length === 0
      ? []
      : [
          `skills.config=[${own.skills
            .map(
              ({ path, enabled }) =>
                `{path=${JSON.stringify(path)},enabled=${enabled[configuration]}}`,
            )
            .join(",")}]`,
        ]),
    ...(configuration === "own"
      ? []
      : [
          ...PERSONAL_FEATURES.map((feature) => `features.${feature}=false`),
          'web_search="disabled"',
          ...own.mcpServers.map((name) => `mcp_servers.${name}.enabled=false`),
          ...own.plugins.map((name) => `plugins.${name}.enabled=false`),
          ...own.apps.map((name) => `apps.${name}.enabled=false`),
          "apps._default.enabled=false",
          "memories.use_memories=false",
          "memories.generate_memories=false",
          "notify=[]",
        ]),
  ]);
};

/**
 * Codex asks nothing. T3 Code sends a granular policy here that lets only an MCP server's prompt
 * through (`CodexAdapterV2.ts`, lines 778–787), but Codex accepts it only from a client on its
 * experimental surface ("askForApproval.granular requires experimentalApi capability", seen live),
 * and Neuve stays on the stable one. Under `never` Codex itself declines another server's prompt,
 * and the declined call reaches Neuve as a failed piece of work; Neuve's own tools need no prompt,
 * since their server is configured to approve them.
 */
const UNATTENDED: AskForApproval = "never";

export interface TurnSettings {
  readonly configuration: Configuration;
  readonly approvalPolicy: AskForApproval;
  readonly sandboxPolicy: SandboxPolicy;
}

export interface GitWorktree {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly head: string;
}

const worktreeWriteRoots = (git: GitWorktree | undefined): string[] => {
  if (
    !git ||
    git.gitDir === git.commonDir ||
    !git.head.startsWith("refs/heads/")
  )
    return [];
  const refFolder = dirname(git.head);
  if (refFolder === "refs/heads") return [];
  // Only the host or person can move HEAD, so it can name the channel for the next turn.
  return [
    ...[
      "index",
      "index.lock",
      "HEAD.lock",
      "ORIG_HEAD",
      "ORIG_HEAD.lock",
      "COMMIT_EDITMSG",
      "logs",
    ].map((entry) => join(git.gitDir, entry)),
    join(git.commonDir, "objects"),
    join(git.commonDir, refFolder),
    join(git.commonDir, "logs", refFolder),
  ];
};

/**
 * Read-only turns run clean and ask nothing. Write turns can write in the chat's folder and,
 * in a work lane, the Git paths needed to commit on the channel's branch. The sandbox protects
 * hooks, Git settings, packed-refs, branches outside the channel, and the lane's HEAD, commondir,
 * gitdir, and config.worktree. Attended write turns ask on request. Unattended turns ask nothing.
 */
export const turnSettings = (
  workspace: TurnWorkspace,
  approvals: SessionPolicy["approvalPolicy"],
  git?: GitWorktree,
): TurnSettings =>
  workspace.access === "read-only"
    ? {
        configuration: "clean",
        approvalPolicy: UNATTENDED,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }
    : {
        configuration: "own",
        approvalPolicy: approvals === "ask" ? "on-request" : UNATTENDED,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspace.folder, ...worktreeWriteRoots(git)],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      };

/** The person's environment for Codex, as T3 Code gives it, with the account's Codex home. */
export const codexEnvironment = (
  base: Readonly<Record<string, string | undefined>>,
  codexHome: string | undefined,
  /** Only a process that serves Neuve's tools is given the token. */
  token: string | undefined,
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...base };
  for (const name of REMOVED_ENVIRONMENT) delete env[name];
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  if (token !== undefined) env[TOKEN_VARIABLE] = token;
  return env;
};
