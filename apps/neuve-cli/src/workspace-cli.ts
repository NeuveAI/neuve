import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { nativeReviewCallbacks } from "./workspace-native-review";
import { rearmWaitingReviews } from "./review-worker";
import { workspaceNativeSources } from "./workspace-native-sources.ts";
import { routeHostModels, routeModelRef } from "./workspace-models.ts";
import {
  workspaceChatModels,
  productionChatSources,
} from "./workspace-chat-runtime.ts";
import { configureRuntime } from "@ace/host/runtime-hooks";
import { GIT_LOCAL, workspaceSettingsEnvironment } from "@ace/host/host-config";
import { planningConnections } from "./workspace-linear.ts";
import { startHost, type Host } from "@ace/host/host";
import {
  configureReviewRoutes,
  reviewBase,
  serveCodingUi,
  type ReviewResolver,
} from "@ace/host/app-gateway";
import { GatewayClient } from "@ace/host/private-gateway-client";
import type { Project } from "@ace/host/protocol";
import type { ReviewHistoryQuery } from "@ace/host/extension-protocol";
import {
  routeModel,
  settingsRoute,
  type AnyRouteConfig,
} from "@neuve/harness/coding";
import { Identity } from "@neuve/records-core";
import {
  writeWorkspaceRuntime,
  workspaceConfiguration,
  writeCarriedSkill,
  workspaceDirectories,
  requireWorkspaceBun,
} from "./workspace-runtime.ts";
import {
  readStorageProfile,
  StorageProfile,
  StorageRefused,
  prepareStorage,
  spawnEnvironment,
  validateStorageProfile,
  validateWorkspaceProject,
  type ValidatedStorage,
} from "../../../scripts/pi-storage.ts";
import { webEnvironment } from "../../../scripts/web-command.ts";
import { announcedChild, closeChild } from "./workspace-child.ts";
import { buildReviewWeb, ReviewWebs } from "./workspace-review-build.ts";
import { requestRangeReview } from "./review-cli.ts";
import { parseWorkspaceOptions, workspaceReady } from "./workspace-launch.ts";
import { nameDiagnosticPath } from "./records-cli.ts";
import {
  aceReviewDestination,
  codingReturnUrl,
  reviewAt,
  reviewHistory,
  reviewOrigin,
} from "./workspace-review-links.ts";
import {
  ExternalReviewSourceSchema,
  GitOid,
  ReviewOriginSchema,
} from "@neuve/records-schema";
import { Effect } from "effect";
import { Git } from "@neuve/harness";
export { codingWorkerSetup } from "./workspace-worker.ts";

export const WORKSPACE_HELP = `Usage: neuve workspace [--profile <pi-transition|local|profile.json>] [--source <checkout>] [--repo <path>] [--port <n>] [--web-port <n>] [--user <name>] [--loopback]
       neuve workspace lane [stop]
Starts Neuve's coding home. Neuve reviews open under its /review/ paths.
Neuve's configured team discovery and tailnet listeners remain active by default.
--loopback keeps this host off the tailnet, peers, team directory and lobby presence.
The coding web listener always stays on loopback.
Storage defaults to pi-transition for its declared clone and worktrees; elsewhere it is local.
--source <checkout> picks the Neuve checkout to run.
Without it, the installed CLI runs the canonical clone of the --profile you pass, or the pi-transition clone if you pass none.
The installed CLI needs --source <checkout> with --profile local.
bun workspace from a Neuve checkout runs that checkout.
The current directory is opened by default.
--repo opens and selects that project; otherwise Neuve keeps its usual project selection.
The coding web app defaults to loopback port 4141. --web-port overrides it; 0 selects a free port.
The host defaults to a free loopback port. Ctrl-C stops owned processes.
The configured review route supplies the coding model and its default reasoning effort.`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const portOf = (
  name: "--port" | "--web-port",
  value: string | undefined,
): number => {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value) || Number(value) > 65_535)
    throw new Error(`${name} takes an integer from 0 to 65535.`);
  return Number(value);
};

type OwnedChild = { child: Bun.Subprocess; log: string };
type Web = OwnedChild & { project: string; url: string };

export async function runWorkspaceCli(
  args: readonly string[],
): Promise<number> {
  try {
    return await workspace(args);
  } catch (error) {
    if (!(error instanceof StorageRefused)) throw error;
    writeSync(2, `neuve workspace: ${error.message}\n`);
    return 1;
  }
}

async function workspace(args: readonly string[]): Promise<number> {
  delete process.env[Identity.ACE_CHAT_VARIABLE];
  if (args[0] === "lane")
    return (await import("./workspace-lane.ts")).workspaceLane(args.slice(1));
  const remaining = [...args];
  let requestedSource: string | undefined;
  for (let index = 0; index < remaining.length; index++) {
    const argument = remaining[index];
    if (argument !== "--source" && !argument?.startsWith("--source=")) continue;
    if (requestedSource !== undefined)
      throw new Error("Duplicate option --source");
    requestedSource =
      argument === "--source" ? remaining[index + 1] : argument.slice(9);
    if (!requestedSource || requestedSource.startsWith("--"))
      throw new Error("Missing value for --source");
    remaining.splice(index, argument === "--source" ? 2 : 1);
    index--;
  }
  const values = parseWorkspaceOptions(remaining);
  if (values.help) {
    writeSync(1, `${WORKSPACE_HELP}\n`);
    return 0;
  }
  const hostPort = portOf("--port", values.port);
  const webPort = portOf("--web-port", values["web-port"] ?? "4141");
  const compiledDefault =
    Bun.main.startsWith("/$bunfs/") && requestedSource === undefined;
  if (compiledDefault && values.profile === "local")
    throw new Error(
      "With --profile local, the installed CLI needs --source <checkout>. Or run bun workspace from your Neuve checkout.",
    );
  let source: string | undefined;
  let profile: StorageProfile;
  let validated: ValidatedStorage;
  try {
    const selectedProfile = compiledDefault
      ? await readStorageProfile("", values.profile ?? "pi-transition")
      : undefined;
    const candidate =
      requestedSource ??
      selectedProfile?.paths.canonicalClone ??
      resolve(import.meta.dir, "../../..");
    // Preserve the pinned volume refusal before resolving a profile's missing clone.
    const selectedStorage =
      selectedProfile === undefined
        ? undefined
        : await validateStorageProfile(selectedProfile, {
            checkout: candidate,
          });
    source = await realpath(candidate).catch((error) => {
      if (requestedSource === undefined) throw error;
      throw new Error(
        nameDiagnosticPath(error, "--source", candidate, resolve(candidate)),
      );
    });
    profile =
      selectedProfile ?? (await readStorageProfile(source, values.profile));
    validated =
      selectedStorage ??
      (await validateStorageProfile(profile, { checkout: source }));
  } catch (error) {
    if (
      values.profile !== undefined &&
      error instanceof StorageRefused &&
      error.reason === "profile-malformed" &&
      error.path === values.profile
    )
      error.message = nameDiagnosticPath(
        error,
        "--profile",
        values.profile,
        resolve(values.profile),
      );
    if (
      requestedSource !== undefined &&
      error instanceof StorageRefused &&
      error.path === source
    )
      error.message = nameDiagnosticPath(error, "--source", source);
    if (
      compiledDefault &&
      values.profile === undefined &&
      error instanceof StorageRefused &&
      error.reason === "volume-absent"
    )
      error.message +=
        " The installed CLI defaults to the pi-transition profile. Run bun workspace from your Neuve checkout, or pass --source <checkout>.";
    throw error;
  }
  const repository = await validateWorkspaceProject(
    values.repo ?? process.cwd(),
    validated,
  ).catch((error: unknown) => {
    if (values.repo !== undefined && error instanceof Error)
      error.message = nameDiagnosticPath(
        error,
        "--repo",
        values.repo,
        resolve(values.repo),
        ...(error instanceof StorageRefused ? [error.path] : []),
      );
    throw error;
  });
  const route = settingsRoute();
  const user = values.user ?? process.env.USER ?? process.env.LOGNAME;
  if (
    !user ||
    !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(user) ||
    user.startsWith("agent@")
  )
    throw new Error("--user must name the human workspace owner");
  const executable = Bun.main.startsWith("/$bunfs/")
    ? Bun.which("bun")
    : process.execPath;
  if (executable === null)
    throw new Error("The workspace web app requires Bun on PATH");
  requireWorkspaceBun(executable);
  const storage = await prepareStorage(validated);
  const { home } = workspaceDirectories(storage);
  const aceSettings = profile.isolatedProject
    ? workspaceSettingsEnvironment(home)
    : {};
  const environment = spawnEnvironment(storage, process.env);
  Object.assign(environment, aceSettings);
  // Git hook variables must not point either Records or Vite at the caller's index.
  for (const key of GIT_LOCAL) delete environment[key];
  const webs = new ReviewWebs<Web>();
  const children = new Set<OwnedChild>();
  const abort = new AbortController();
  let host: Host | undefined;
  let coding: Awaited<ReturnType<typeof serveCodingUi>> | undefined;
  let stopping = false;
  let failure: unknown;
  let release: () => void = () => {};
  const done = new Promise<void>((resolveDone) => {
    release = resolveDone;
  });
  const stop = (error?: unknown) => {
    if (error !== undefined) failure ??= error;
    stopping = true;
    abort.abort();
    release();
  };
  const onSignal = () => stop();
  const onInputEnd = () => stop();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  if (!process.stdin.isTTY) {
    process.stdin.once("end", onInputEnd);
    process.stdin.resume();
  }
  const ensureReviewWeb = async (project: string): Promise<Web> => {
    const actual = await validateWorkspaceProject(project, storage);
    if (stopping || !host) throw new Error("The workspace is shutting down");
    return webs.open(actual, async () => {
      const buildLifetime = new AbortController();
      try {
        if (stopping || !host)
          throw new Error("The workspace is shutting down");

        const key = createHash("sha256")
          .update(actual)
          .digest("hex")
          .slice(0, 16);
        const log = join(home, `web-${key}.log`);
        const directory = await buildReviewWeb({
          source,
          repository: actual,
          lifetime: buildLifetime.signal,
          processSignal: abort.signal,
          base: reviewBase(actual),
          builds: storage.paths.builds,
          cache: storage.paths.cache,
          temporary: storage.paths.tmp,
          executable,
          environment,
          log,
          signal: abort.signal,
        });
        const env = {
          ...webEnvironment({
            ...environment,
            NEUVE_REPOSITORY: actual,
            NEUVE_HOST_URL: host.url,
            NEUVE_HOST_TOKEN_FILE: join(home, "host.token"),
          }),
          ...aceSettings,
          ...storage.environment,
          NODE_ENV: "production",
          NEUVE_REVIEW_BASE: reviewBase(actual),
          ...(coding === undefined ? {} : { NEUVE_CODING_URL: coding.url }),
          ...(environment.NEUVE_OPENAI_TOKEN_COMMAND === undefined
            ? {}
            : {
                NEUVE_OPENAI_TOKEN_COMMAND:
                  environment.NEUVE_OPENAI_TOKEN_COMMAND,
              }),
          ...(route.provider === "anthropic" &&
          environment[route.credentialVariable] !== undefined
            ? {
                [route.credentialVariable]:
                  environment[route.credentialVariable],
              }
            : {}),
        };
        const started = await announcedChild({
          command: [
            executable,
            "--no-env-file",
            join(source, "apps/neuve-web/apps/web/serve.ts"),
            directory,
          ],
          cwd: join(source, "apps/neuve-web/apps/web"),
          env,
          base: reviewBase(actual),
          log,
          signal: abort.signal,
        });
        const web: Web = { ...started, project: actual };
        const { child } = web;
        children.add(web);
        void child.exited.then(() => {
          buildLifetime.abort();
          children.delete(web);
        });
        if (stopping) {
          await closeChild(child);
          throw new Error("The workspace is shutting down");
        }
        return web;
      } catch (error) {
        buildLifetime.abort();
        throw error;
      }
    });
  };
  const buildCodingUi = async () => {
    if (stopping) throw new Error("The workspace is shutting down");
    const directory = join(
      storage.paths.builds,
      "ace-app",
      String(process.pid),
    );
    const cache = join(storage.paths.cache, "ace-app", String(process.pid));
    mkdirSync(directory, { recursive: true });
    const appRoot = join(source, "apps/app");
    const configFile = join(directory, "vite.config.ts");
    const outputDirectory = join(directory, "dist");
    await writeFile(
      configFile,
      `import config from ${JSON.stringify(join(appRoot, "vite.config.ts"))};\nexport default {...config, cacheDir: ${JSON.stringify(cache)}, build: {...config.build, outDir: ${JSON.stringify(outputDirectory)}, emptyOutDir: true}};\n`,
    );
    const log = join(home, "ace-app-build.log");
    const output = openSync(log, "a", 0o600);
    let child: Bun.Subprocess;
    try {
      child = Bun.spawn(
        [
          executable,
          "--no-env-file",
          "--bun",
          "vite",
          "build",
          "--config",
          configFile,
          "--configLoader",
          "native",
        ],
        {
          cwd: appRoot,
          env: environment,
          stdin: "ignore",
          stdout: output,
          stderr: output,
        },
      );
    } finally {
      closeSync(output);
    }
    children.add({ child, log });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (abort.signal.aborted) cancel();
      const code = await child.exited;
      if (stopping) throw new Error("The workspace is shutting down");
      if (code !== 0)
        throw new Error(`Neuve app build exited ${code}. See ${log}`);
      return outputDirectory;
    } finally {
      abort.signal.removeEventListener("abort", cancel);
      clearTimeout(killTimer);
    }
  };
  const resolveReview: ReviewResolver = async (key) => {
    if (stopping || !host) return;
    for (const [project, web] of webs) {
      if (reviewBase(project) === `/review/${key}/`) return (await web).url;
    }
    // A saved tab can open before any review destination has started its BFF.
    const client = new GatewayClient(host.url, host.token);
    try {
      const projects = await new Promise<Project[]>(
        (resolveProjects, reject) => {
          const timer = setTimeout(
            () => reject(new Error("The host did not list connected projects")),
            15_000,
          );
          client.onOpen = () => {
            void client
              .request<Project[]>({ op: "projects" })
              .then(resolveProjects, reject)
              .finally(() => clearTimeout(timer));
          };
        },
      );
      const project = projects.find(
        ({ path }) => reviewBase(path) === `/review/${key}/`,
      );
      if (project) return (await ensureReviewWeb(project.path)).url;
    } finally {
      client.close();
    }
  };
  const returnTo = (
    project: string,
    origin?: Parameters<typeof codingReturnUrl>[2],
  ) => {
    if (!coding) throw new Error("The coding home is unavailable");
    return codingReturnUrl(coding.url, project, origin);
  };
  const reviewDestination = (
    project: string,
    reference: string,
    back: string,
  ) => {
    if (!coding) throw new Error("The coding home is unavailable");
    return aceReviewDestination(coding.url, project, reference, back);
  };
  try {
    const app = await buildCodingUi();
    configureReviewRoutes(resolveReview);
    const chatSources = productionChatSources({
      home: (await import("node:os")).homedir(),
      environment,
    });
    configureRuntime({
      nativeSources: workspaceNativeSources(storage),
      channelProvenance: true,
      checkAccounts: chatSources.checkAccounts,
    });
    const chatModels = await workspaceChatModels(undefined, chatSources);
    abort.signal.addEventListener(
      "abort",
      () => void chatModels.close().finally(() => chatSources.close()),
      {
        once: true,
      },
    );
    const configuration = workspaceConfiguration({
      storage,
      environment,
      profile,
      source,
      user,
      port: hostPort,
      route,
      app,
    });
    const hostConfig = {
      ...configuration,
      ...(await writeCarriedSkill(configuration.home)),
    };
    host = await startHost({
      loopback: values.loopback ?? false,
      ...nativeReviewCallbacks(
        async (project, reference) => {
          const web = await ensureReviewWeb(project);
          return reviewDestination(
            web.project,
            reference,
            returnTo(project, await reviewOrigin(project, reference)),
          );
        },
        async (project) => {
          const actual = await validateWorkspaceProject(project, storage);
          await ensureReviewWeb(project);
          return actual;
        },
      ),
      config: hostConfig,
      models: () => [
        ...routeHostModels(route, () =>
          route.provider === "claude"
            ? []
            : getSupportedThinkingLevels(routeModel(route)),
        ),
        ...chatModels.current(),
      ],
      planningConnections,
      ...{
        async reviewHistory(query: ReviewHistoryQuery) {
          const reviews = await reviewHistory(query);
          if (!reviews.length) return [];
          const web = await ensureReviewWeb(query.project);
          return reviews.map(
            ({ reference, base, head, association, origin }) => ({
              reference,
              base,
              head,
              association,
              url: reviewDestination(
                web.project,
                reference,
                returnTo(query.project, origin),
              ),
            }),
          );
        },
      },
      async reviewLink(project, reference) {
        const accepted = await reviewAt(project, reference);
        if (accepted === undefined)
          throw new Error("Records does not hold this review cycle");
        return reviewDestination(
          (await ensureReviewWeb(project)).project,
          accepted.reference,
          returnTo(project, await reviewOrigin(project, reference)),
        );
      },
      async review(handoff) {
        const base = GitOid.parse(handoff.base);
        const head = GitOid.parse(handoff.head);
        const actual = await validateWorkspaceProject(handoff.project, storage);
        const commits = await Effect.runPromise(
          Effect.all([
            Git.resolveCommit(actual, base),
            Git.resolveCommit(actual, head),
          ]),
        );
        if (commits[0] !== base || commits[1] !== head)
          throw new Error(
            "The submitted source objects do not match the requested review range",
          );
        const origin =
          "origin" in handoff && handoff.origin !== undefined
            ? ReviewOriginSchema.parse(handoff.origin)
            : undefined;
        const externalSources =
          "externalSources" in handoff && handoff.externalSources !== undefined
            ? ExternalReviewSourceSchema.array()
                .max(16)
                .parse(handoff.externalSources)
            : undefined;
        const web = await ensureReviewWeb(handoff.project);
        const { request } = await requestRangeReview(
          web.project,
          `${base}..${head}`,
          {
            branchCheckout: handoff.cwd,
            ...(origin === undefined ? {} : { origin }),
            ...(externalSources === undefined ? {} : { externalSources }),
            ...(handoff.source
              ? {
                  scopeSource: {
                    server: handoff.source.connection,
                    item: handoff.source.key,
                    workspace: handoff.source.workspace,
                  },
                }
              : {}),
          },
        );
        return {
          reference: request.cycleId,
          url: reviewDestination(
            web.project,
            request.cycleId,
            returnTo(handoff.project, origin),
          ),
          base: request.range.baseOid,
          head: request.range.headOid,
          ...(request.association === undefined
            ? {}
            : { association: request.association }),
        };
      },
    });
    const { config } = await import("@ace/host/host-config");
    if (stopping)
      throw (
        failure ?? new DOMException("Workspace startup cancelled", "AbortError")
      );
    coding = await serveCodingUi({
      host,
      directory: app,
      port: webPort,
      review: resolveReview,
    });
    await writeWorkspaceRuntime(profile, source, config, coding.url);
    // Reviews this build queued before the host last stopped get a worker of this build again.
    if (!profile.isolatedProject)
      void rearmWaitingReviews({
        within: storage.volume?.mountPoint ?? "/",
      }).catch(() => undefined);
    const client = new GatewayClient(host.url, host.token);
    let project: Project;
    try {
      project = await new Promise<Project>((resolveOpen, rejectOpen) => {
        const timer = setTimeout(
          () =>
            finish({
              error: new Error(
                "The coding host did not open the initial project",
              ),
            }),
          15_000,
        );
        const cancel = () =>
          finish({ error: new Error("The workspace is shutting down") });
        const finish = (result: { project: Project } | { error: unknown }) => {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", cancel);
          if ("project" in result) resolveOpen(result.project);
          else rejectOpen(result.error);
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        client.onOpen = () => {
          void client
            .request<Project>({ op: "project-open", path: repository })
            .then(
              (project) => finish({ project }),
              (error: unknown) => finish({ error }),
            );
        };
        if (abort.signal.aborted) cancel();
      });
    } finally {
      client.close();
    }
    const ready = workspaceReady({
      url: host.url,
      tokenFile: join(home, "host.token"),
      web: coding.url,
      repository,
      pid: process.pid,
      project,
      repo: values.repo,
    });
    writeSync(1, `${JSON.stringify(ready)}\n`);
    if (profile.isolatedProject && process.connected) process.send?.(ready);
    void chatSources.checkAccounts().catch((error: unknown) => {
      if (!abort.signal.aborted)
        console.warn(
          `neuve workspace: could not check accounts: ${message(error)}`,
        );
    });
    await done;
  } catch (error) {
    if (!stopping || failure !== undefined) failure ??= error;
  } finally {
    stopping = true;
    abort.abort();
    configureReviewRoutes(undefined);
    try {
      await coding?.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await host?.close();
    } catch (error) {
      failure ??= error;
    }
    await Promise.allSettled([...webs.values()]);
    await Promise.all([...children].map(({ child }) => closeChild(child)));
    for (const signal of signals) process.off(signal, onSignal);
    process.stdin.off("end", onInputEnd);
    process.stdin.pause();
  }
  if (failure !== undefined) {
    writeSync(2, `neuve workspace: ${message(failure)}\n`);
    return 1;
  }
  return 0;
}
