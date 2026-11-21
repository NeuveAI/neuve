/**
 * Regenerates `src/generated/` from OpenAI's published app-server schema at one Codex release tag:
 * the TypeScript in `codex-rs/app-server-protocol/schema/typescript` there, which is the stable
 * surface (the experimental methods and fields are left out of it). No Codex program is run.
 *
 *   bun scripts/generate.ts <release tag, e.g. rust-v0.171.0-alpha.13> [--out <folder>] [--repin]
 *
 * The tag is resolved to its commit first, every file is fetched at that commit, and the commit is
 * recorded in each header. A tag can move: when the folder was generated from the same tag at
 * another commit, it refuses unless `--repin` is given. `--out` writes somewhere other than
 * `src/generated`, to compare a regeneration without touching the files the client imports.
 *
 * It keeps only what the client needs: the client requests, notifications and server requests
 * listed below and the types they import. `methods.ts` gives each kept method its types, and
 * lists every notification and server request name the release has, so that the client can tell
 * a message this release does not know from one it knows and has no use for.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const CLIENT_METHODS = [
  "initialize",
  "config/read",
  "configRequirements/read",
  "experimentalFeature/list",
  "model/list",
  "account/read",
  "account/rateLimits/read",
  "hooks/list",
  "skills/list",
  "app/list",
  "mcpServerStatus/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/read",
  "thread/archive",
  "thread/delete",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
];
/** A request without parameters names no type to derive its response from. */
const PARAMETERLESS: Record<string, string> = {
  "configRequirements/read": "v2/ConfigRequirementsReadResponse.ts",
};
const NOTIFICATIONS = [
  "error",
  "warning",
  "configWarning",
  "deprecationNotice",
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "thread/archived",
  "thread/deleted",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/mcpToolCall/progress",
  "hook/started",
  "hook/completed",
  "serverRequest/resolved",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "model/rerouted",
];

/** What a generated header records: the tag, and the commit it resolved to (or, in headers written
 * before commits were recorded, the tag object). */
const HEADER =
  /^\/\/ From OpenAI's Codex, (\S+) \((commit|tag object) ([0-9a-f]{40})\)/;

/**
 * Refuses a regeneration from the same tag at another commit than the one recorded, unless asked
 * to repin. A new tag, or a folder with no recorded header, is a deliberate update and passes.
 */
export const checkPin = (
  recordedHeader: string | undefined,
  tag: string,
  resolved: { readonly commit: string; readonly tagObject: string },
  repin: boolean,
) => {
  const recorded = HEADER.exec(recordedHeader ?? "");
  if (recorded === null || recorded[1] !== tag || repin) return;
  const expected =
    recorded[2] === "commit" ? resolved.commit : resolved.tagObject;
  if (recorded[3] !== expected)
    throw new Error(
      `${tag} now resolves to ${recorded[2]} ${expected}, not the ${recorded[3]} the types were generated from: the tag moved. Read what changed, then pass --repin to regenerate from it`,
    );
};

const generate = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" }, repin: { type: "boolean" } },
  });
  const tag = positionals[0];
  if (tag === undefined || !/^rust-v\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/.test(tag))
    throw new Error(
      "usage: bun scripts/generate.ts <rust-vX.Y.Z tag> [--out <folder>] [--repin]",
    );
  const out = resolve(values.out ?? join(import.meta.dir, "../src/generated"));
  const api = async (path: string) => {
    const response = await fetch(
      `https://api.github.com/repos/openai/codex/${path}`,
    );
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return (await response.json()) as { object: { sha: string; type: string } };
  };
  const ref = (await api(`git/ref/tags/${tag}`)).object;
  const commit =
    ref.type === "tag"
      ? (await api(`git/tags/${ref.sha}`)).object.sha
      : ref.sha;
  const methodsFile = join(out, "methods.ts");
  checkPin(
    existsSync(methodsFile) ? readFileSync(methodsFile, "utf8") : undefined,
    tag,
    { commit, tagObject: ref.sha },
    values.repin === true,
  );
  const raw = `https://raw.githubusercontent.com/openai/codex/${commit}/`;
  const schema = "codex-rs/app-server-protocol/schema/typescript/";

  const fetched = new Map<string, string>();
  const fetchText = async (path: string) => {
    const response = await fetch(raw + path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.text();
  };
  /** Fetches a schema file and everything it imports, depth first. */
  /** A path the schema names, refused unless it stays inside the schema folder. */
  const inside = (path: string) => {
    if (
      path.startsWith("..") ||
      isAbsolute(path) ||
      !/^[\w/.-]+\.ts$/.test(path)
    )
      throw new Error(`the schema names a path outside its folder: ${path}`);
    return path;
  };
  const follow = async (path: string): Promise<void> => {
    inside(path);
    if (fetched.has(path)) return;
    const text = await fetchText(schema + path);
    fetched.set(path, text);
    for (const match of text.matchAll(/from "(\.{1,2}\/[^"]+)"/g))
      await follow(`${normalize(join(dirname(path), match[1]!))}.ts`);
  };

  /** The `"method"` members of a generated union, with their params type when there is one. */
  const members = (text: string) =>
    [...text.matchAll(/\{ "method": "([^"]+)"([^}]*)\}/g)].map((match) => ({
      method: match[1]!,
      params: /"?params"?\??: (\w+)/.exec(match[2]!)?.[1],
    }));
  const pathOf = (text: string, type: string) => {
    const found = new RegExp(
      `import type \\{ ${type} \\} from "\\./([^"]+)"`,
    ).exec(text);
    if (found === null) throw new Error(`no import for ${type}`);
    return `${found[1]}.ts`;
  };
  const typeOf = (path: string) =>
    path.replace(/^.*\//, "").replace(/\.ts$/, "");
  const importLine = (path: string) =>
    `import type { ${typeOf(path)} } from "./${path.replace(/\.ts$/, "")}";`;

  const unions = {
    client: await fetchText(`${schema}ClientRequest.ts`),
    notification: await fetchText(`${schema}ServerNotification.ts`),
    request: await fetchText(`${schema}ServerRequest.ts`),
  };
  /** A response type a server request may lack: it is kept when the schema has it. */
  const followIfThere = async (path: string) => {
    try {
      await follow(path);
      return path;
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("HTTP 404"))
        return undefined;
      throw error;
    }
  };
  const pick = async (
    union: string,
    methods: ReadonlyArray<string>,
    response?: (method: string, params: string) => string,
    optional = false,
  ) => {
    const all = members(union);
    const kept: Array<{ method: string; params?: string; response?: string }> =
      [];
    for (const method of methods) {
      const member = all.find((entry) => entry.method === method);
      if (member === undefined)
        throw new Error(`${tag} has no stable ${method}`);
      const params =
        member.params === undefined || member.params === "undefined"
          ? undefined
          : pathOf(union, member.params);
      if (params !== undefined) await follow(params);
      const named = response?.(method, params ?? "");
      const answer =
        named === undefined
          ? undefined
          : optional
            ? await followIfThere(named)
            : (await follow(named), named);
      kept.push({
        method,
        ...(params === undefined ? {} : { params }),
        ...(answer === undefined ? {} : { response: answer }),
      });
    }
    return kept;
  };
  const client = await pick(
    unions.client,
    CLIENT_METHODS,
    (method, params) =>
      PARAMETERLESS[method] ?? params.replace(/Params\.ts$/, "Response.ts"),
  );
  const notifications = await pick(unions.notification, NOTIFICATIONS);
  const requests = await pick(
    unions.request,
    members(unions.request).map((entry) => entry.method),
    (_method, params) => params.replace(/Params\.ts$/, "Response.ts"),
    true,
  );
  const header = (from: string) =>
    [
      `// From OpenAI's Codex, ${tag} (commit ${commit}),`,
      `// ${from}. Apache-2.0; see LICENSE here.`,
      "// Regenerate with packages/runtime-codex/scripts/generate.ts; do not edit by hand.",
      "",
    ].join("\n");
  // Everything is fetched before anything is deleted, so a failed fetch leaves the old files.
  const license = await fetchText("LICENSE");
  const noticeResponse = await fetch(`${raw}NOTICE`);
  const notice = noticeResponse.ok ? await noticeResponse.text() : undefined;
  const write = (path: string, text: string) => {
    const target = resolve(out, inside(path));
    if (!target.startsWith(`${resolve(out)}${sep}`))
      throw new Error(`refusing to write outside src/generated: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const writeLegal = (name: string, text: string) =>
    writeFileSync(join(out, name), text);
  const paramsType = (path?: string) =>
    path === undefined ? "undefined" : typeOf(path);
  const names = (union: string) =>
    JSON.stringify(members(union).map((entry) => entry.method));
  const methods = [
    header(`the unions in ${schema}`).replace(
      "do not edit by hand.",
      "this file is written by it.",
    ),
    ...[...client, ...notifications, ...requests]
      .flatMap((entry) => [entry.params, entry.response])
      .filter((path): path is string => path !== undefined)
      .filter((path, index, all) => all.indexOf(path) === index)
      .map(importLine),
    "",
    `export const RELEASE = ${JSON.stringify(tag.replace(/^rust-v/, ""))};`,
    "",
    "/** The client requests kept, with their parameter and response types. */",
    "export type ClientMethods = {",
    ...client.map(
      (entry) =>
        `  ${JSON.stringify(entry.method)}: { params: ${paramsType(entry.params)}; response: ${typeOf(entry.response!)} };`,
    ),
    "};",
    "",
    "/** The notifications the client reads, with their parameter types. */",
    "export type Notifications = {",
    ...notifications.map(
      (entry) =>
        `  ${JSON.stringify(entry.method)}: ${paramsType(entry.params)};`,
    ),
    "};",
    `export const READ_NOTIFICATIONS: ReadonlySet<string> = new Set(${JSON.stringify(NOTIFICATIONS)});`,
    "",
    "/** Every request the server can send, with its parameter type. */",
    "export type ServerRequests = {",
    ...requests.map(
      (entry) =>
        `  ${JSON.stringify(entry.method)}: ${paramsType(entry.params)};`,
    ),
    "};",
    "",
    "/** The answer each server request takes, where the schema names one. */",
    "export type ServerResponses = {",
    ...requests
      .filter((entry) => entry.response !== undefined)
      .map(
        (entry) =>
          `  ${JSON.stringify(entry.method)}: ${typeOf(entry.response!)};`,
      ),
    "};",
    "",
    "/** Every notification name this release's server has. */",
    `export const SERVER_NOTIFICATIONS: ReadonlySet<string> = new Set(${names(unions.notification)});`,
    "",
    "/** Every request name this release's server has. */",
    `export const SERVER_REQUESTS: ReadonlySet<string> = new Set(${names(unions.request)});`,
    "",
  ];
  rmSync(out, { recursive: true, force: true });
  for (const [path, text] of [...fetched].sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    write(path, header(schema + path) + text);
  write("methods.ts", methods.join("\n"));
  writeLegal("LICENSE", license);
  if (notice !== undefined) writeLegal("NOTICE", notice);
  console.log(`${fetched.size} schema files from ${tag} at ${commit}`);
};

if (import.meta.main) await generate();
