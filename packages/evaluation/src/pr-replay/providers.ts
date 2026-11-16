import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Read-only access to the providers and to git. GitHub goes through `gh api` with the owner's
 * existing login (never a token this code reads); Gerrit through its anonymous REST API. Nothing
 * here posts anywhere: every GitHub call is a GET, and Gerrit is only ever fetched.
 */

const decoder = new TextDecoder();

export class CommandFailed extends Error {
  override readonly name = "CommandFailed";
}

export const run = (
  argv: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly allowFailure?: boolean } = {},
) => {
  const child = Bun.spawnSync([...argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const stdout = decoder.decode(child.stdout);
  if (child.exitCode !== 0 && options.allowFailure !== true)
    throw new CommandFailed(
      `${argv.slice(0, 4).join(" ")} exited ${child.exitCode}: ${decoder.decode(child.stderr).slice(-600)}`,
    );
  return { stdout, code: child.exitCode };
};

export const git = (
  directory: string,
  args: ReadonlyArray<string>,
  allowFailure = false,
) => run(["git", "-C", directory, ...args], { allowFailure });

/**
 * One GitHub read. `paginate` returns every page's items as one array. Only the GraphQL endpoint is
 * ever POSTed to, and only with a query: GraphQL reads go over POST, and a mutation is refused here.
 */
export const github = (
  path: string,
  options: {
    readonly paginate?: boolean;
    readonly fields?: Record<string, string>;
    readonly method?: "GET" | "POST";
  } = {},
): unknown => {
  const method = options.method ?? "GET";
  if (
    method === "POST" &&
    (path !== "graphql" ||
      /^\s*mutation\b/.test(options.fields?.["query"] ?? ""))
  )
    throw new Error("only GraphQL queries may be POSTed");
  const argv = ["gh", "api", "-X", method, path];
  for (const [key, value] of Object.entries(options.fields ?? {}))
    argv.push("-f", `${key}=${value}`);
  if (options.paginate === true) argv.push("--paginate", "--slurp");
  const parsed = JSON.parse(run(argv).stdout) as unknown;
  return options.paginate === true
    ? (parsed as Array<unknown>).flatMap((page) =>
        Array.isArray(page) ? page : [page],
      )
    : parsed;
};

let lastGerritCall = 0;

/** One Gerrit REST GET, paced at two calls a second, with Gerrit's `)]}'` guard stripped. */
export const gerrit = async (host: string, path: string): Promise<unknown> => {
  const wait = lastGerritCall + 500 - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  lastGerritCall = Date.now();
  const response = await fetch(`https://${host}${path}`);
  if (!response.ok)
    throw new CommandFailed(`Gerrit ${path} answered ${response.status}`);
  const text = await response.text();
  return JSON.parse(text.slice(text.indexOf("\n") + 1));
};

export const sha256 = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Writes one captured body and returns its manifest entry. */
export const keep = (directory: string, name: string, body: unknown) => {
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(path, text);
  return { name, bytes: Buffer.byteLength(text), sha256: sha256(text) };
};
