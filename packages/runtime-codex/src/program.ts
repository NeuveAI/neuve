/**
 * Finding the person's Codex. At run time: the path the person set, and only that, or else the
 * one `codex` the PATH resolves to. Once, when asked, discovery in the order the
 * [Codex runtime design](../../../process/proposals/codex-runtime.md#the-probe) gives: every `codex` on the PATH, then OpenAI's desktop apps, found by
 * their identifier and read through the manifest inside them for the program it declares. Each
 * candidate is asked the version question as the app server; the first that answers as Codex at a
 * version not marked broken is used, and every other is reported and skipped. What is looked for
 * is data, in `program.json`; no install location is written in code.
 */
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findProgram } from "@neuve/runtime";
import { Duration, Effect, Exit } from "effect";
import { z } from "zod";
import { connect, type CodexConnection } from "./client.ts";
import * as Decode from "./decode.ts";
import {
  codexEnvironment,
  launchArguments,
  type CodexTokenCommand,
} from "./launch.ts";
import program from "./program.json" with { type: "json" };
import { CodexProcess } from "./services.ts";
import { judge, versionOf } from "./version.ts";

export const PROGRAM = program;
export type Found = "set" | "path" | "app";
export interface Candidate {
  readonly path: string;
  readonly found: Found;
}
/** What one candidate answered. */
export type Asked =
  | {
      readonly candidate: Candidate;
      readonly kind: "codex";
      readonly version: string;
    }
  | { readonly candidate: Candidate; readonly kind: "missing" | "unrecognized" }
  | {
      readonly candidate: Candidate;
      readonly kind: "broken";
      readonly version: string;
    };

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Every file named for the program on the PATH, in the PATH's order. */
export const onPath = (path: string | undefined): ReadonlyArray<string> =>
  (path ?? "")
    .split(delimiter)
    .filter((folder) => folder.startsWith("/"))
    .map((folder) => join(folder, program.name))
    .filter(executable);

/**
 * Whether installed apps are looked for at all: OpenAI's desktop apps, their identifiers and
 * their property lists are macOS's, so on any other system discovery asks the PATH alone and
 * starts no macOS tool. Read when asked, so a test can run the same code as another system.
 */
export const appsLookedFor = (platform: string = process.platform) =>
  platform === "darwin";

/** An app's bundle identifier, read from its property list. */
export type IdentifierReader = (app: string) => string | undefined;
/** macOS's own reader of an app's property list, `plutil`; nothing on another system. */
export const plistIdentifier: IdentifierReader = (app) => {
  if (!appsLookedFor()) return undefined;
  const plist = join(app, "Contents", "Info.plist");
  if (!existsSync(plist)) return undefined;
  const read = Bun.spawnSync(
    [
      "/usr/bin/plutil",
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      plist,
    ],
    {
      stdin: "ignore",
      stderr: "ignore",
    },
  );
  return read.exitCode === 0 ? read.stdout.toString().trim() : undefined;
};
const Manifest = z.looseObject({
  layoutVersion: z.number(),
  entrypoint: z.string().min(1),
});

/**
 * The program each of OpenAI's apps declares, the machine's Applications folder before the
 * person's and then by name. The app is matched by its identifier; the program is the one its
 * manifest names, accepted by T3 Code's rule: the layout this Neuve knows, and an entry point that
 * is exactly the program in the package's own `bin` folder once links are followed. An app with
 * a manifest of another layout is reported and skipped.
 */
/** The two Applications folders, the machine's and the person's. */
export const applicationFolders = (home = homedir()) =>
  appsLookedFor()
    ? program.applicationFolders.map((folder) =>
        folder.startsWith("~/") ? join(home, folder.slice(2)) : folder,
      )
    : [];
export const inApps = (
  folders: ReadonlyArray<string> = applicationFolders(),
  report: (app: string, why: string) => void = () => {},
  identifierOf: IdentifierReader = plistIdentifier,
): ReadonlyArray<string> =>
  folders
    .flatMap((folder) => {
      try {
        return readdirSync(folder)
          .filter((name) => name.endsWith(".app"))
          .sort()
          .map((name) => join(folder, name));
      } catch {
        return [];
      }
    })
    .flatMap((app) => {
      // The identifier first, so an app of OpenAI's without a manifest is reported, not passed over.
      const identifier = identifierOf(app);
      if (identifier === undefined || !program.identifiers.includes(identifier))
        return [];
      const resources = join(app, "Contents", "Resources");
      let manifest: string | undefined;
      try {
        manifest = readdirSync(resources)
          .map((entry) => join(resources, entry, program.manifest))
          .find(existsSync);
      } catch {
        manifest = undefined;
      }
      if (manifest === undefined) {
        report(app, "it has no manifest naming its Codex");
        return [];
      }
      const folder = join(manifest, "..");
      let parsed: z.infer<typeof Manifest>;
      try {
        parsed = Manifest.parse(JSON.parse(readFileSync(manifest, "utf8")));
      } catch {
        report(app, "its manifest could not be read");
        return [];
      }
      const entry = real(join(folder, parsed.entrypoint));
      if (
        parsed.layoutVersion !== program.layoutVersion ||
        entry !== join(real(join(folder, "bin")), program.name)
      ) {
        report(app, "a layout this Neuve does not know");
        return [];
      }
      return executable(entry) ? [entry] : [];
    });

/**
 * What run time asks, as T3 Code does: the path the person set, and only that; else the one
 * `codex` the PATH resolves to. Nothing else is looked for: that is discovery's, run once.
 */
export const runtimeCandidates = (
  setting: string | undefined,
  path: string | undefined,
): ReadonlyArray<Candidate> => {
  if (setting !== undefined) return [{ path: setting, found: "set" }];
  const first = findProgram(program.name, undefined, path ?? "");
  return first === undefined ? [] : [{ path: first, found: "path" }];
};

/**
 * Discovery's candidates, for the one step that looks for Codex and stores it (`neuve auth
 * program codex --find`, which setup also runs): the path the person already set, then every
 * `codex` on the PATH, in order, then OpenAI's apps, each file once.
 */
export const discoveryCandidates = (
  path: string | undefined,
  apps: () => ReadonlyArray<string>,
  setting?: string,
): ReadonlyArray<Candidate> => {
  const seen = new Set<string>();
  const list: Candidate[] = [];
  const add = (file: string, found: Found) => {
    const key = real(file);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ path: file, found });
  };
  if (setting !== undefined) add(setting, "set");
  for (const file of onPath(path)) add(file, "path");
  for (const file of apps()) add(file, "app");
  return list;
};

export interface FindOptions {
  readonly candidates: ReadonlyArray<Candidate>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly codexHome: string | undefined;
  readonly tokenCommand?: CodexTokenCommand | undefined;
  readonly broken?: ReadonlyArray<string> | undefined;
  readonly handshakeTimeout?: Duration.Input | undefined;
}

/**
 * Asks each candidate in order, as its app server with the person's additions switched off and
 * nothing of a session (no token, no tool server, a temporary folder), until one answers as Codex.
 * Runs `use` on that one before it is stopped. Every candidate's answer is returned.
 */
export const findCodex = <A, E>(
  options: FindOptions,
  use: (
    connection: CodexConnection,
    candidate: Candidate,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const tried: Asked[] = [];
    for (const candidate of options.candidates) {
      if (!executable(candidate.path)) {
        tried.push({ candidate, kind: "missing" });
        continue;
      }
      const outcome = yield* Effect.scoped(
        Effect.gen(function* () {
          const connected = yield* connect({
            program: candidate.path,
            args: launchArguments(
              "clean",
              {
                mcpServers: [],
                plugins: [],
                apps: [],
                skills: [],
                exclude: [],
              },
              undefined,
              options.tokenCommand,
            ),
            env: codexEnvironment(
              options.environment,
              options.codexHome,
              undefined,
            ),
            cwd: tmpdir(),
            clientInfo: { name: "neuve", title: "Neuve", version: "0.1.0" },
            answer: () =>
              Effect.succeed({
                error: { code: -32601, message: "Neuve does not answer this" },
              }),
            handshakeTimeout: options.handshakeTimeout ?? "10 seconds",
            stopWait: "2 seconds",
          }).pipe(Effect.exit);
          if (Exit.isFailure(connected))
            return { asked: { candidate, kind: "unrecognized" } as Asked };
          const answered = Decode.Initialize.safeParse(
            connected.value.initialize,
          );
          const verdict = judge(
            answered.success ? versionOf(answered.data.userAgent) : undefined,
            options.broken,
          );
          // A program that names no Codex release did not answer as Codex.
          if (verdict.version === "unknown")
            return { asked: { candidate, kind: "unrecognized" } as Asked };
          if (verdict.kind === "broken")
            return {
              asked: {
                candidate,
                kind: "broken",
                version: verdict.version,
              } as Asked,
            };
          if (verdict.kind === "unsupported")
            yield* Effect.logWarning("codex version", {
              advice: verdict.advice,
            });
          const value = yield* use(connected.value, candidate);
          return {
            asked: {
              candidate,
              kind: "codex",
              version: verdict.version,
            } as Asked,
            value,
          };
        }),
      );
      tried.push(outcome.asked);
      if (outcome.asked.kind !== "codex") {
        yield* Effect.logWarning("codex candidate skipped", {
          found: candidate.found,
          answered: outcome.asked.kind,
        });
        continue;
      }
      return {
        tried,
        found: { asked: outcome.asked, value: outcome.value as A },
      };
    }
    return { tried, found: undefined };
  }) as Effect.Effect<
    {
      readonly tried: ReadonlyArray<Asked>;
      readonly found:
        | {
            readonly asked: Extract<Asked, { kind: "codex" }>;
            readonly value: A;
          }
        | undefined;
    },
    E,
    CodexProcess
  >;
