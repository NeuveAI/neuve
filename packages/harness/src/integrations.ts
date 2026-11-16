import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { settingsPath } from "./settings.ts";

/**
 * The user's integrations (10.5, 10.52): scope sources reached through MCP servers that Neuve
 * proxies, each defined in full in one user-level file that is never committed, beside the user's
 * Neuve settings (`settings.ts`), and found from the home directory only. The repository's
 * `.mcp.json` is never read, so no commit in a reviewed range can change what the worker starts or
 * where a key goes.
 *
 * Each server names its pinned URL or absolute command, the tools agents may use (only read-only
 * ones: the server's own `readOnlyHint` is not trusted on its own), and the names of the variables
 * it may receive. `${NAME}` expands only for a listed name, from the user's environment at the call,
 * and only into that server's process or request. Neuve stores no credential and no OAuth token: a
 * server that needs OAuth is reached through a bridge the user runs that keeps its own tokens.
 */

export const integrationsPath = (home = homedir()) =>
  join(settingsPath(home), "..", "integrations.json");

const VariableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** What a response field holds when the server's item names it an identifier (10.24). */
export const IdentifierClass = z.enum(["key", "url", "person", "email", "id"]);
export type IdentifierClass = z.infer<typeof IdentifierClass>;

const Transport = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    /** An absolute path: a name would be looked up on a PATH the reviewed repository may change. */
    command: z.string().refine(isAbsolute, "an absolute path"),
    args: z.array(z.string()).max(64).optional(),
    env: z.record(VariableName, z.string()).optional(),
  }),
  z.strictObject({
    type: z.literal("http"),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(z.string().min(1), z.string()).optional(),
  }),
]);

const PlanningFixedArguments = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
  z.union([z.string().max(1000), z.boolean(), z.number().finite()]),
);
const PlanningArgument = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
export const PlanningMapping = z.strictObject({
  sourceSchema: z.literal("linear-v1"),
  search: z.strictObject({
    tool: z.string().min(1),
    queryArgument: PlanningArgument,
    cursorArgument: PlanningArgument.optional(),
    fixedArguments: PlanningFixedArguments.optional(),
  }),
  issue: z.strictObject({
    tool: z.string().min(1),
    idArgument: PlanningArgument,
    fixedArguments: PlanningFixedArguments.optional(),
  }),
  dependencies: z.strictObject({
    tool: z.string().min(1),
    idArgument: PlanningArgument,
    cursorArgument: PlanningArgument.optional(),
    fixedArguments: PlanningFixedArguments.optional(),
  }),
});
export type PlanningMapping = z.infer<typeof PlanningMapping>;

export const IntegrationServer = z
  .strictObject({
    transport: Transport,
    /** Names of the environment variables this server may receive; nothing else expands. */
    variables: z.array(VariableName).max(32),
    /** The read-only tools agents may call; anything else the server lists is not proxied. */
    tools: z.array(z.string().min(1)).min(1).max(32),
    /** How the cycle-start fetch reads one item named by a key in the branch, commits or plan. */
    fetch: z
      .strictObject({
        tool: z.string().min(1),
        argument: z.string().min(1),
        /** Key prefixes this server answers for, such as `NEU`; without them every key shape is tried. */
        keyPrefixes: z
          .array(z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/))
          .max(32)
          .optional(),
      })
      .optional(),
    /** Response fields that are identifiers (10.24), by field name, with what each holds. */
    identifiers: z.record(z.string().min(1), IdentifierClass),
    planning: PlanningMapping.optional(),
  })
  .refine(
    (server) =>
      server.fetch === undefined || server.tools.includes(server.fetch.tool),
    "fetch.tool must be one of the allowed tools",
  )
  .refine(
    (server) =>
      server.planning === undefined ||
      [
        server.planning.search.tool,
        server.planning.issue.tool,
        server.planning.dependencies.tool,
      ].every((tool) => server.tools.includes(tool)),
    "Every planning operation must be in the read-only allowlist",
  );
export type IntegrationServer = z.infer<typeof IntegrationServer>;

export const IntegrationFile = z.strictObject({
  version: z.literal(1),
  servers: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    IntegrationServer,
  ),
});
export type IntegrationFile = z.infer<typeof IntegrationFile>;

/** The file's state: absent, invalid (refused loudly, with zod's words), or the servers. */
export type Integrations =
  | { readonly status: "absent"; readonly path: string }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly status: "configured";
      readonly path: string;
      readonly file: IntegrationFile;
    };

export const readIntegrations = (path = integrationsPath()): Integrations => {
  if (!existsSync(path)) return { status: "absent", path };
  try {
    const parsed = IntegrationFile.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success
      ? { status: "configured", path, file: parsed.data }
      : { status: "invalid", path, reason: z.prettifyError(parsed.error) };
  } catch (error) {
    return {
      status: "invalid",
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Why a server cannot be used as written. */
export class UnlistedVariable extends Error {
  readonly _tag = "UnlistedVariable";
}

/**
 * Expands `${NAME}` in one value: only listed names, each from the environment now. An unlisted
 * name refuses the server; a listed name that is not set expands to none, which the caller reports.
 */
export const expand = (
  value: string,
  listed: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { readonly value: string; readonly unset: ReadonlyArray<string> } => {
  const unset: Array<string> = [];
  const expanded = value.replace(/\$\{([^}]*)\}/g, (_, name: string) => {
    if (!listed.includes(name))
      throw new UnlistedVariable(
        `\${${name}} is not among the server's listed variables`,
      );
    const found = environment[name];
    if (found === undefined || found === "") {
      unset.push(name);
      return "";
    }
    return found;
  });
  return { value: expanded, unset };
};

/** The servers whose `fetch` reads items, in file order. */
export const fetchingServers = (integrations: Integrations) =>
  integrations.status === "configured"
    ? Object.entries(integrations.file.servers).filter(
        ([, server]) => server.fetch !== undefined,
      )
    : [];
