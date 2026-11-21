import {
  assessLocalGitEnvironment,
  describeGitReadAssessment,
  requireOfflineGitRead,
  GitReadRefusal,
  OFFLINE_GIT_FIX,
} from "@neuve/graph-client";
import { constants, existsSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Option } from "effect";
import { Route, RouteProvider, Settings } from "@neuve/harness";
import { settingsRoute } from "@neuve/harness/request";
import { findProgram } from "@neuve/runtime";
import { resolveStoreLocation, Worker } from "@neuve/records-core";
import { isCompiled } from "../../../packages/harness/src/compiled.ts";
import { discoverGraphBinary } from "./graph-query.ts";
import { readInstalledManifest } from "./installed-copy.ts";
import {
  diagnoseDesk,
  reinstallFix,
  releasePrefix,
  SOURCE_DESK_FIX,
} from "./review-desk-config.ts";
import { repositorySetup } from "./setup-status.ts";
import { storeSetupLayout } from "./installation.ts";
import {
  machineSteps,
  machineStepsRecord,
  pendingSteps,
  repositorySteps,
  repositoryStepsRecord,
} from "./setup-steps.ts";
import { defaultHookFile, inspectCapture } from "./capture/setup-hooks.ts";
import { quote } from "./shell-quote.ts";
import { inspectSkillForDoctor } from "./skills-cli.ts";
import {
  findAgentPrograms,
  headline,
  installAdvice,
  type Finding,
  type Surroundings,
} from "./agent-programs.ts";
import { gitAvailability, xcodeToolsPath } from "./git-available.ts";

/**
 * `neuve doctor`: what a review needs on this machine and in this repository, each with the exact
 * fix. It only reads: no store is created, no worker is started, nothing is written, no network
 * request is made of its own, and a credential is named but its value never printed. The programs it starts
 * are named: Git and the Graph engine for their versions, `claude --version`, and the Codex the
 * codex account runs (the stored path, else the PATH's `codex`), once as its app server for its
 * version, which sends no model request.
 */
export type DoctorCheck = Readonly<{
  check: string;
  status: "ok" | "missing" | "warning";
  detail: string;
  fix?: string;
}>;

const ok = (check: string, detail: string): DoctorCheck => ({
  check,
  status: "ok",
  detail,
});

export const formatDoctorCheck = (line: DoctorCheck) =>
  `${line.status.padEnd(7)} ${line.check}: ${line.detail}${line.fix === undefined ? "" : `\n        Fix: ${line.fix}`}`;

const run = async (argv: readonly string[]) => {
  const child = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), exitCode };
};

const executable = async (path: string) => {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const real = (path: string) => realpath(path).catch(() => resolve(path));

/** Each `neuve` on PATH in order, then the two install places, by where they land on disk. */
export const neuveCopies = async (
  path = process.env["PATH"] ?? "",
  home = homedir(),
) => {
  const copies: Array<{ path: string; real: string; onPath: boolean }> = [];
  const add = async (candidate: string, onPath: boolean) => {
    if (!(await executable(candidate))) return;
    const at = await real(candidate);
    if (!copies.some((copy) => copy.real === at))
      copies.push({ path: candidate, real: at, onPath });
  };
  for (const directory of path.split(delimiter))
    if (directory !== "") await add(join(directory, "neuve"), true);
  await add(join(releasePrefix(home), "bin/neuve"), false);
  await add(join(home, ".local/bin/neuve"), false);
  return copies;
};

/** How doctor names an installed copy, by where it is. */
const copyKind = async (path: string, home: string) => {
  const prefix = dirname(dirname(path));
  if (prefix === (await real(releasePrefix(home))))
    return "the release install";
  if (prefix === (await real(join(home, ".local"))))
    return "the install from source";
  return "another copy";
};

/** Where `claude` is on PATH, as the Claude Code runtime finds it, or undefined. */
export const findClaude = (path = process.env["PATH"] ?? "") =>
  findProgram("claude", undefined, path);

/**
 * The review route the settings name, and whether this shell can use it. For the Claude route
 * doctor only looks for `claude` on PATH: checking the sign-in opens Claude Code, which can reach
 * the network, so that is left to `neuve auth status claude --check`.
 */
export const checkSignIn = (
  repository: string | undefined,
  home = homedir(),
  available = RouteProvider.credentialPresent,
  claude: () => string | undefined = findClaude,
): DoctorCheck => {
  const path = Settings.settingsPath(home);
  let settings: Option.Option<Settings.Settings>;
  try {
    settings = Settings.readSettings(path);
  } catch {
    return {
      check: "sign-in",
      status: "missing",
      detail: `Neuve can't read its settings at ${path}`,
      fix: `Correct or remove ${path}, then run neuve doctor`,
    };
  }
  const route = settingsRoute(settings);
  const named = Settings.reviewRoute(settings);
  const which = `${route.provider === "openai" ? "the OpenAI route" : route.provider === "claude" ? "your Claude subscription through Claude Code" : "the Anthropic route"} (${named === undefined ? `the default; ${path} names none` : `review.route in ${path}`})`;
  const restart =
    repository === undefined
      ? "neuve worker stop && neuve worker start"
      : `neuve worker stop --repo ${quote(repository)} && neuve worker start --repo ${quote(repository)}`;
  if (route.provider === "claude") {
    const found = claude();
    return found === undefined
      ? {
          check: "sign-in",
          status: "missing",
          detail: `Reviews use ${which}, and Claude Code isn't installed: there's no claude on PATH. A review waits until a worker has it`,
          fix: "install Claude Code, then run claude auth login && neuve auth status claude --check",
        }
      : ok(
          "sign-in",
          `Reviews use ${which}. Claude Code is at ${found}. Doctor doesn't open it, so it doesn't check the sign-in: neuve auth status claude --check does, without spending usage`,
        );
  }
  if (available(route))
    return ok(
      "sign-in",
      `Reviews use ${which}. ${Route.credentialName(route)} is available in this shell`,
    );
  if (route.provider === "openai")
    return {
      check: "sign-in",
      status: "missing",
      detail: `Reviews use ${which}, and this machine isn't signed in to it (${RouteProvider.OpenAiAuth.signInProblem() ?? "the sign-in could not be read"}). A review waits until a worker has the sign-in`,
      fix: `neuve auth login openai && ${restart}`,
    };
  return {
    check: "sign-in",
    status: "missing",
    detail: `Reviews use ${which}, and ${Route.credentialName(route)} isn't set in this shell. A review waits until a worker has it`,
    fix: `set ${Route.credentialName(route)} to an Anthropic API key (an API key, not a Claude subscription token) in this shell, then run ${restart}. Or sign in with ChatGPT instead: neuve setup ${repository === undefined ? "" : `--repo ${quote(repository)} `}--route openai && neuve auth login openai && ${restart}`,
  };
};

/** Records' error for a store that changed while it was read without its WAL. */
const changedDuringRead = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "StoreChangedDuringRead";

/** What a read-only look at the repository's worker socket shows. */
const checkWorker = async (repository: string): Promise<DoctorCheck> => {
  const status = `neuve worker status --repo ${quote(repository)}`;
  try {
    const location = await Effect.runPromise(resolveStoreLocation(repository));
    const legacy = await Effect.runPromise(
      Effect.result(Worker.hasLegacyWorkerClaim(location)),
    );
    // A store a worker writes while doctor reads it can't say which worker holds it (NEU-149).
    if (legacy._tag === "Failure" && changedDuringRead(legacy.failure))
      return {
        check: "worker",
        status: "warning",
        detail:
          "The store changed while doctor read it, so doctor can't tell which worker holds it. Run neuve doctor again",
        fix: status,
      };
    if (legacy._tag === "Failure") throw legacy.failure;
    if (legacy.success)
      return {
        check: "worker",
        status: "warning",
        detail: "An older Neuve build's worker holds this repository's store",
        fix: status,
      };
    // The worker's socket lives in the user's private folder, which a worker's start creates: a
    // missing folder means no worker, and an existing one is only read.
    if (!existsSync(`/tmp/neuve-${process.getuid?.() ?? 0}`))
      return ok(
        "worker",
        "No worker is running. neuve review starts one when this shell has the sign-in",
      );
    const socket = await Effect.runPromise(Worker.socketPathFor(location));
    const reach = await Effect.runPromise(Worker.reachWorker(socket, "status"));
    if (Worker.isLive(reach))
      return ok("worker", `A worker is running for ${repository}`);
    if (
      reach._tag === "Absent" ||
      (reach._tag === "Refused" && reach.code === "ECONNREFUSED")
    )
      return ok(
        "worker",
        "No worker is running. neuve review starts one when this shell has the sign-in",
      );
    return {
      check: "worker",
      status: "warning",
      detail: `Doctor can't tell whether a worker is running (${reach.code})`,
      fix: status,
    };
  } catch {
    return {
      check: "worker",
      status: "warning",
      detail: "Doctor can't read this repository's worker state",
      fix: status,
    };
  }
};

/**
 * Git, and on macOS the command-line tools that carry it. Without them `/usr/bin/git` only opens
 * Apple's installer, so it isn't run, and `usable` tells the checks after it to leave Git alone.
 */
const checkGit = async (
  platform = process.platform,
): Promise<{ checks: DoctorCheck[]; usable: boolean }> => {
  const checks: DoctorCheck[] = [];
  if (platform === "darwin") {
    const tools = xcodeToolsPath();
    checks.push(
      tools !== undefined
        ? ok("Xcode command-line tools", tools)
        : {
            check: "Xcode command-line tools",
            status: "missing",
            detail:
              "The Xcode command-line tools, which carry Git, aren't installed",
            fix: "xcode-select --install",
          },
    );
  }
  const available = gitAvailability(platform);
  if (!available.usable) {
    checks.push({
      check: "Git",
      status: "missing",
      detail: available.detail,
      fix: available.fix,
    });
    return { checks, usable: false };
  }
  const version = await run([available.git, "--version"]).catch(
    () => undefined,
  );
  checks.push(
    version?.exitCode === 0
      ? ok("Git", `${version.stdout} (${available.git})`)
      : {
          check: "Git",
          status: "missing",
          detail: `${available.git} could not run`,
          fix:
            platform === "darwin"
              ? "xcode-select --install"
              : "Install Git with your system's package manager",
        },
  );
  return { checks, usable: version?.exitCode === 0 };
};

export const inspectDoctor = async (input: {
  repository: string;
  version: string;
  executable?: string;
  home?: string;
  path?: string;
  /** For tests: Codex's discovery, in place of the real one. */
  findCodex?: Surroundings["findCodex"];
  /** Each agent's hook file; the person's by default, under `home`. */
  hookFiles?: Parameters<typeof inspectCapture>[1];
}) => {
  const home = input.home ?? homedir();
  const fromSource = !isCompiled();
  const self = await real(input.executable ?? process.execPath);
  const prefix = fromSource ? undefined : resolve(dirname(self), "..");
  const fix =
    prefix === undefined ? SOURCE_DESK_FIX : await reinstallFix(prefix, home);
  const checks: DoctorCheck[] = [];

  // This copy, and the files its install recorded.
  if (prefix === undefined)
    checks.push({
      check: "neuve",
      status: "warning",
      detail: `neuve ${input.version} runs from source with ${self}`,
      fix: SOURCE_DESK_FIX,
    });
  else {
    const manifest = readInstalledManifest(
      join(prefix, "lib/neuve/install.json"),
    );
    const files =
      typeof manifest === "string"
        ? []
        : [
            manifest.cli.path,
            manifest.graph.path,
            ...(manifest.semantic === undefined
              ? []
              : [
                  manifest.semantic.encoder.path,
                  manifest.semantic.reranker.path,
                ]),
          ];
    const lost: string[] = [];
    for (const file of files)
      if (!(await stat(file).catch(() => undefined))?.isFile()) lost.push(file);
    checks.push(
      manifest === "unreadable"
        ? {
            check: "neuve",
            status: "warning",
            detail: `neuve ${input.version} at ${self}; its install record ${join(prefix, "lib/neuve/install.json")} can't be read`,
            fix,
          }
        : lost.length > 0
          ? {
              check: "neuve",
              status: "missing",
              detail: `neuve ${input.version} at ${self}; installed files are missing: ${lost.join(", ")}`,
              fix,
            }
          : ok("neuve", `neuve ${input.version} at ${self}`),
    );
  }

  // Which copy `neuve` runs, and any other copy it could be confused with.
  const copies = await neuveCopies(input.path ?? process.env["PATH"], home);
  const first = copies.find((copy) => copy.onPath);
  const others = copies.filter(
    (copy) => copy !== first && (prefix === undefined || copy.real !== self),
  );
  const named = async (copy: { path: string; real: string }) =>
    `${copy.path}${copy.real === copy.path ? "" : `, a link to ${copy.real}`} (${await copyKind(copy.real, home)})`;
  const otherText = (await Promise.all(others.map(named))).join(", ");
  if (first === undefined)
    checks.push({
      check: "PATH",
      status: "missing",
      detail: "There's no neuve on PATH",
      ...(prefix === undefined
        ? {}
        : { fix: `export PATH=${quote(join(prefix, "bin"))}:"$PATH"` }),
    });
  else if (prefix !== undefined && first.real !== self)
    checks.push({
      check: "PATH",
      status: "missing",
      detail: `neuve on PATH runs ${await named(first)}, not this copy`,
      fix: `export PATH=${quote(join(prefix, "bin"))}:"$PATH", or remove the other copy`,
    });
  else
    checks.push({
      check: "PATH",
      status: others.length === 0 ? "ok" : "warning",
      detail: `neuve on PATH runs ${await named(first)}${others.length === 0 ? "" : `. Another copy is also installed: ${otherText}. The first one on PATH wins`}`,
      ...(others.length === 0
        ? {}
        : {
            fix: "Remove the copy you don't use, or put the one you want first on PATH",
          }),
    });

  const git = await checkGit();
  checks.push(...git.checks);

  // The Graph engine and the review desk beside this copy.
  try {
    const graph = await discoverGraphBinary({
      override: process.env["NEUVE_GRAPH_BINARY"],
      executable: self,
    });
    const version = await run([graph, "version"]).catch(() => undefined);
    checks.push(
      version?.exitCode === 0
        ? ok("Graph engine", `${graph} (${version.stdout})`)
        : {
            check: "Graph engine",
            status: "missing",
            detail: `${graph} could not run`,
            fix:
              process.env["NEUVE_GRAPH_BINARY"] === undefined
                ? fix
                : "Point NEUVE_GRAPH_BINARY at a working engine, or run unset NEUVE_GRAPH_BINARY",
          },
    );
  } catch {
    checks.push({
      check: "Graph engine",
      status: "missing",
      detail:
        process.env["NEUVE_GRAPH_BINARY"] === undefined
          ? `There's no Graph engine beside ${self}`
          : `NEUVE_GRAPH_BINARY doesn't name an engine: ${process.env["NEUVE_GRAPH_BINARY"]}`,
      fix:
        process.env["NEUVE_GRAPH_BINARY"] === undefined
          ? fix
          : "Point NEUVE_GRAPH_BINARY at a working engine, or run unset NEUVE_GRAPH_BINARY",
    });
  }
  const desk = await diagnoseDesk(input.version, self, fromSource);
  checks.push(
    desk.kind === "ready"
      ? ok("review desk", desk.directory)
      : {
          check: "review desk",
          status: "missing",
          detail: desk.detail,
          fix: desk.fix,
        },
  );

  // The repository: setup, then the sign-in its reviews use and its worker.
  let repository: string | undefined;
  const top = git.usable
    ? await run([
        "git",
        "-C",
        resolve(input.repository),
        "rev-parse",
        "--show-toplevel",
      ]).catch(() => undefined)
    : undefined;
  if (top?.exitCode === 0 && top.stdout !== "")
    repository = await real(top.stdout);
  if (!git.usable)
    checks.push({
      check: "repository",
      status: "missing",
      detail: `Doctor can't look at ${resolve(input.repository)} until Git works`,
      fix: "Fix Git first (above), then run neuve doctor again",
    });
  else if (repository === undefined)
    checks.push({
      check: "repository",
      status: "missing",
      detail: `${resolve(input.repository)} isn't inside a Git repository`,
      fix: "Run neuve doctor in the repository you want to review, or pass --repo <path>",
    });
  else {
    try {
      const assessment = await assessLocalGitEnvironment(repository);
      requireOfflineGitRead(assessment);
      checks.push(
        ok("offline Git reads", describeGitReadAssessment(assessment)),
      );
    } catch (error) {
      checks.push({
        check: "offline Git reads",
        status: "missing",
        detail: error instanceof Error ? error.message : String(error),
        fix:
          error instanceof GitReadRefusal &&
          error.reason === "unsupported-suppression"
            ? OFFLINE_GIT_FIX
            : "Fix the repository's Git configuration, then run neuve doctor again",
      });
    }
    const installation = await repositorySetup(repository);
    if (installation === undefined)
      checks.push({
        check: "setup",
        status: "missing",
        detail: `Neuve isn't set up in ${repository}`,
        fix: `neuve setup --repo ${quote(repository)}`,
      });
    else {
      // Setup records the copy and the engine that ran it; a later install elsewhere leaves them behind.
      const linked = await realpath(installation.cliBinary).catch(
        () => undefined,
      );
      const engine = await executable(installation.graphBinary);
      checks.push(
        linked === undefined || !engine
          ? {
              check: "setup",
              status: "missing",
              detail: `Neuve's setup in ${repository} records a CLI or Graph engine that is gone`,
              fix: `neuve setup --repo ${quote(repository)}`,
            }
          : prefix !== undefined && linked !== self
            ? {
                check: "setup",
                status: "warning",
                detail: `Neuve is set up in ${repository} with another copy, ${linked}`,
                fix: `neuve setup --repo ${quote(repository)}, to use this one`,
              }
            : ok("setup", `Neuve is set up in ${repository}`),
      );
      checks.push(await stepsCheck(repository, home));
      checks.push(
        await captureCheck(
          repository,
          input.hookFiles ?? ((harness) => defaultHookFile(harness, home)),
        ),
      );
    }
  }
  // The agent programs, in setup's words; only what run time would start is asked. The sign-in
  // check reads the same look's claude.
  const agents = await findAgentPrograms("check", {
    path: input.path ?? process.env["PATH"] ?? "",
    home,
    ...(input.findCodex === undefined ? {} : { findCodex: input.findCodex }),
  });
  checks.push(
    checkSignIn(
      repository,
      home,
      RouteProvider.credentialPresent,
      () =>
        agents.find((finding) => finding.program.id === "claude-code")?.found
          ?.path,
    ),
  );
  if (repository !== undefined) checks.push(await checkWorker(repository));
  for (const finding of agents) checks.push(agentCheck(finding));
  // The agent skill is optional: a warning only when an installed copy is older than this CLI,
  // didn't finish installing, or isn't safe to update; never "missing".
  checks.push(
    await inspectSkillForDoctor({
      home,
      version: input.version,
      quote,
      ...(repository === undefined ? {} : { repository }),
    }),
  );
  return {
    checks,
    exitCode: checks.some((check) => check.status === "missing") ? 1 : 0,
  };
};

export const DOCTOR_HELP = `Usage: neuve doctor [--repo <path>] [--json]
  Check what a review needs: this copy of neuve and which copy is first on PATH, Git, the
  Graph engine and the review desk beside the CLI, setup in the repository, the model
  sign-in, the background worker, the agent programs setup looks for, and whether the
  installed Neuve skill is older than this neuve. Each problem comes with its fix. It only
  reads, makes no network request of its own, and names credentials without printing them.
  The programs it starts, only to ask their versions: Git, the Graph engine, claude --version,
  and the Codex the codex account runs (the stored path, else the codex on PATH), once as its
  app server, with no model request. Exits 1 when something is missing.
`;

/**
 * Capture in the repository: absent is said plainly, and a part that `neuve setup hooks` would
 * change, such as a hook running a program that is gone, is a finding rather than "set up". A hook
 * entry Neuve can't read surely is named, never called gone.
 */
const captureCheck = async (
  repository: string,
  hookFiles: Parameters<typeof inspectCapture>[1],
): Promise<DoctorCheck> => {
  const found = await inspectCapture(repository, hookFiles);
  const fix = `neuve setup hooks --repo ${quote(repository)}`;
  const parts = found?.parts ?? [];
  const off = parts.filter(
    (part) => part.state === "update" || part.state === "missing",
  );
  const unclear = parts
    .filter((part) => part.state === "unclear")
    .map((part) => `${part.path}: ${part.why}`);
  const said = off
    .map(
      (part) =>
        `${part.path} ${part.state === "missing" ? "is missing" : "needs an update"}: ${part.why}`,
    )
    .concat(unclear)
    .join("; ");
  if (found === undefined || !found.configured)
    return {
      check: "capture",
      status: "warning",
      detail: `Capture isn't set up in ${repository}: it has no capture.json or Git hooks${said === "" ? "" : `. ${said}`}`,
      fix,
    };
  if (off.length > 0)
    return { check: "capture", status: "warning", detail: said, fix };
  return ok(
    "capture",
    unclear.length === 0
      ? "Every capture hook is as neuve setup hooks writes it"
      : `Every capture hook Neuve can judge is as neuve setup hooks writes it. ${said}`,
  );
};

/**
 * Setup's named steps on this machine and in the repository: those waiting, those considered and
 * why, or a record left alone, in the words neuve setup upgrade uses.
 */
const stepsCheck = async (
  repository: string,
  home: string,
): Promise<DoctorCheck> => {
  const layout = await storeSetupLayout(repository);
  const nothing = async () => [];
  const scopes = [
    await pendingSteps(
      machineSteps(async () => "checked"),
      machineStepsRecord(home),
    ),
    ...(layout === undefined
      ? []
      : [
          await pendingSteps(
            repositorySteps(layout.directory, nothing),
            repositoryStepsRecord(layout.directory),
          ),
        ]),
  ];
  const left = scopes.flatMap((scope) =>
    scope.left === undefined ? [] : [scope.left],
  );
  const waiting = scopes.flatMap((scope) =>
    scope.waiting.map((step) => step.does),
  );
  const considered = scopes.flatMap((scope) =>
    scope.considered.map(
      ({ step, reason }) => `setup ${step.does}: not done, as ${reason}`,
    ),
  );
  if (left.length > 0)
    return {
      check: "setup steps",
      status: "warning",
      detail: `Setup's steps are left as they are: ${left.join("; ")}`,
      fix: "Do what the message says, then run neuve doctor again",
    };
  if (waiting.length > 0)
    return {
      check: "setup steps",
      status: "warning",
      detail: `Not applied yet: setup ${waiting.join("; ")}`,
      fix: `neuve setup --repo ${quote(repository)}, at a terminal`,
    };
  return ok(
    "setup steps",
    considered.length === 0
      ? "Every setup step of this neuve is applied"
      : `Every setup step of this neuve was considered. ${considered.join("; ")}; neuve setup tries again`,
  );
};

/**
 * One agent program, in setup's words. A stored path that no longer answers is a warning that
 * offers setup's look again; a program not found is fine, since each is optional, with its install.
 */
const agentCheck = (finding: Finding): DoctorCheck => {
  const name = finding.program.name;
  if (finding.found !== undefined) return ok(name, headline(finding));
  const asked = finding.lines.map((line) => line.trim()).join("; ");
  const detail = `${headline(finding)}${asked === "" ? "" : `: ${asked}`}`;
  if (finding.problem !== undefined)
    return {
      check: name,
      status: "warning",
      detail,
      fix: "Fix what the message names, then run neuve doctor again",
    };
  return finding.stale !== undefined
    ? {
        check: name,
        status: "warning",
        detail: `${detail}. The path stored for it, ${finding.stale}, no longer answers`,
        fix: "neuve setup, which looks for it again",
      }
    : ok(
        name,
        `${detail}. It is optional: ${installAdvice(finding)}, or run neuve setup to look for it`,
      );
};

export const runDoctor = async (args: readonly string[], version: string) => {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    await Bun.write(Bun.stdout, DOCTOR_HELP);
    return 0;
  }
  const result = await inspectDoctor({
    repository: values.repo ?? process.cwd(),
    version,
  });
  await Bun.write(
    Bun.stdout,
    values.json === true
      ? `${JSON.stringify(result)}\n`
      : `${result.checks.map(formatDoctorCheck).join("\n")}\n`,
  );
  return result.exitCode;
};
