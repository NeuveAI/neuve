import { startCaptureWorker } from "./worker-cli.ts";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  closeSync,
  readFileSync,
  mkdirSync,
  openSync,
  realpathSync,
  lstatSync,
  writeSync,
} from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { nativeReviewCallbacks } from "./workspace-native-review";
import { rearmWaitingReviews, keepWorkerFor } from "./review-worker";
import { workspaceNativeSources } from "./workspace-native-sources.ts";
import { routeHostModels, routeModelRef } from "./workspace-models.ts";
import {
  claudeDefaultModel,
  workspaceChatRuntime,
  workspaceChatModels,
  productionChatSources,
  type ChatRuntimeSources,
  type WorkerChatRuntime,
} from "./workspace-chat-runtime.ts";
import { configureRuntime } from "@ace/host/runtime-hooks";
import { GIT_LOCAL, workspaceSettingsEnvironment } from "@ace/host/host-config";
import { checkpointNativeAuthority } from "@neuve/harness/native-source-authority";
import {
  nativeReview,
  configureReviewPreparation,
} from "@ace/host/native-review";
import { CommitPrepare } from "@neuve/harness";
import type { LinearMcpSession } from "@neuve/harness/linear-planning";
import {
  planningConnections,
  workspaceLinearPlanning,
} from "./workspace-linear.ts";
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
  runWorker,
  type WorkerContext,
  type WorkerSetup,
} from "@ace/host/worker";
import {
  CaptureFailed,
  SourceOwnership,
  codingRouteLimits,
  openManagedCredentialInspection,
  privateInspectionDirectory,
  type PrivateInspection,
  fullOutputPath,
  openCaptureJournal,
  openRouteAdmission,
  routeModel,
  routeToolArguments,
  settingsRoute,
  type AnyRouteConfig,
  type CaptureJournal,
  type RouteAdmission,
  type RouteModelsOptions,
} from "@neuve/harness/coding";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Identity,
  Store,
  Starter,
  storeLocationIn,
} from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { captureRunDump } from "@neuve/harness/session-dump";
import { workspaceCaptureModels } from "./workspace-capture-models.ts";
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
import { collectPublicQueryResult, runQueryGraph } from "./graph-query.ts";
import type { PublicQueryEvent, RepositoryPath, Revision } from "./domain.ts";

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

const PROFILE_VARIABLE = "NEUVE_WORKSPACE_PROFILE";
const SOURCE_VARIABLE = "NEUVE_WORKSPACE_SOURCE";
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Raw storage closes only after this hook returns, including when capture fails. */
export function codingWorkerSetup(
  storage: Pick<ValidatedStorage, "paths">,
  route: AnyRouteConfig = settingsRoute(),
  transport: Pick<
    RouteModelsOptions,
    "auth" | "baseUrl" | "fetch" | "stallLimits"
  > = {},
  chatSources?: ChatRuntimeSources,
): WorkerSetup {
  const chatRuntimes = new Map<string, WorkerChatRuntime>();
  const openingChats = new Map<string, Promise<WorkerChatRuntime>>();
  let accountRoute: Awaited<ReturnType<typeof codingRouteLimits>>;
  const routeLimits = new SharedWork<AnyRouteConfig>();
  const resolveChatRoute = async (worker: WorkerContext) => {
    if (accountRoute || route.provider === "claude")
      return accountRoute ?? route;
    const { outcome } = await routeLimits.run({
      scope: "coding-route-limits",
      key: route.model,
      run: async () => {
        accountRoute = await codingRouteLimits(
          route,
          { ...transport, admission: directAdmission(worker) },
          (fields) =>
            process.stderr.write(
              `${JSON.stringify({ event: "model-limits.resolved", ...fields })}\n`,
            ),
        );
        return { kind: "succeeded", value: accountRoute ?? route };
      },
    });
    if (outcome.kind === "failed") throw outcome.error;
    return outcome.value;
  };
  configureReviewPreparation(async (project, range) => {
    const job = await CommitPrepare.requestRangePreparation(project, range);
    await keepWorkerFor({ project, job });
  });
  const reviewSessions = new Map<string, ReturnType<typeof nativeReview>>();
  const journals = new Map<string, CaptureJournal>();
  const planningSessions = new Map<
    string,
    {
      client: LinearMcpSession;
      pending: Set<Promise<unknown>>;
    }
  >();
  const inspections = new Map<
    string,
    { owner: SourceOwnership; authority: PrivateInspection }
  >();
  const inspection = (worker: WorkerContext) => {
    const held = inspections.get(worker.sessionId);
    if (!held)
      throw new Error(
        "Coding source must be acquired before native storage opens",
      );
    return held.authority;
  };
  const admissions = new Map<string, RouteAdmission>();
  // A Claude route runs through its account's Claude Code, which keeps its own limits: there is no
  // direct provider's retry deadline to persist.
  const admission = (worker: WorkerContext): { admission?: RouteAdmission } => {
    if (route.provider === "claude") return {};
    return { admission: directAdmission(worker) };
  };
  const directAdmission = (worker: WorkerContext) => {
    const known = admissions.get(worker.sessionId);
    if (known) return known;
    const opened = openRouteAdmission({
      path: join(worker.stateDirectory, "route-admission.json"),
      route,
      ...transport,
    });
    admissions.set(worker.sessionId, opened);
    return opened;
  };
  const journal = (worker: WorkerContext) => {
    const known = journals.get(worker.sessionId);
    if (known) return known;
    inspection(worker);
    const opened = openCaptureJournal(
      join(worker.stateDirectory, "capture"),
      worker.sessionId,
      {
        spillRoots: [realpathSync(tmpdir())],
        onCaptureLoss: reportCaptureLoss(worker),
        allowCredentialLoss: true,
      },
    );
    journals.set(worker.sessionId, opened);
    try {
      opened.capture({
        type: "run.start",
        scope: { runId: worker.sessionId },
        runKind: "coding",
        sourceRevision: {
          status: "not-applicable",
          reason:
            "A coding session spans mutable project work and has no single reviewed revision.",
        },
        route: `${route.provider}/${route.model}`,
        pricing: route.price === null ? "subscription" : "metered",
      });
    } catch (error) {
      if (!captureWriteFailure(error)) throw error;
    }
    return opened;
  };
  const captureWriteFailure = (
    error: unknown,
  ): error is CaptureFailed & { readonly kind: "full" | "io" } =>
    error instanceof CaptureFailed &&
    (error.kind === "full" || error.kind === "io");
  type CallLoss = Parameters<
    NonNullable<RouteModelsOptions["capture"]["recordLoss"]>
  >[0];
  const reportCaptureLoss =
    (worker: WorkerContext) =>
    (
      loss:
        | CallLoss
        | (Pick<CallLoss, "at" | "kind" | "reason"> & {
            event: "session.bind";
            conversationId: number;
          }),
      persisted: boolean,
    ) => {
      writeSync(
        2,
        `${JSON.stringify({ type: "capture.loss", runId: worker.sessionId, ...loss, persisted })}\n`,
      );
    };
  return {
    async query(
      _worker,
      { repository, revision, branch, question, scope, requester, plan },
    ) {
      const events: PublicQueryEvent[] = [];
      const { state } = await runQueryGraph(
        {
          repository: repository as RepositoryPath,
          revision: revision as Revision,
          ...(branch === undefined ? {} : { branch }),
          question,
          scope,
          maxResults: 8,
          maxContextBytes: 16_000,
          relationships: [],
        },
        {
          requester,
          plan,
          checkedScope: true,
          emit: async (event) => {
            events.push(event);
          },
        },
      );
      if (state.kind === "plan_changed") {
        return {
          refusal:
            "The approved plan changed while the host read it. Retry the call.",
        };
      }
      if (state.kind === "scope_refused") return { refusal: state.reason };
      return { ...collectPublicQueryResult(events), state };
    },
    checkpoint(worker, request) {
      return checkpointNativeAuthority(inspection(worker), {
        nativeDatabase: request.nativeDatabase,
        nativeSha256: request.nativeSha256,
        runId: worker.sessionId,
        journal: join(worker.stateDirectory, "capture"),
      });
    },
    review(worker) {
      const adapter = nativeReview(worker.sessionId);
      reviewSessions.set(worker.sessionId, adapter);
      return adapter.review;
    },
    planning(worker) {
      const { client, read: planning } = workspaceLinearPlanning({
        captureMcp(call) {
          const bytes = new TextEncoder().encode(JSON.stringify(call));
          journal(worker).capture({
            type: "artifact",
            scope: { runId: worker.sessionId },
            name: `linear-mcp/${createHash("sha256").update(bytes).digest("hex")}.json`,
            mediaType: "application/json",
            bytes,
          });
        },
        capturePlanning(call) {
          const bytes = new TextEncoder().encode(JSON.stringify(call));
          journal(worker).capture({
            type: "artifact",
            scope: { runId: worker.sessionId },
            name: `linear-planning/${createHash("sha256").update(bytes).digest("hex")}.json`,
            mediaType: "application/json",
            bytes,
          });
        },
      });
      const pending = new Set<Promise<unknown>>();
      planningSessions.set(worker.sessionId, { client, pending });
      return (request, context) => {
        const task = planning(request, context);
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task),
        );
        return task;
      };
    },
    openSource(worker) {
      const database = join(worker.stateDirectory, "channel.sqlite");
      try {
        const info = lstatSync(database);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error("Coding native source aliases are unsupported");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
      const owner = SourceOwnership.acquire(worker.stateDirectory);
      try {
        const authority = openManagedCredentialInspection({
          ownership: owner,
          source: worker.stateDirectory,
          directory: privateInspectionDirectory(
            worker.stateDirectory,
            dirname(storage.paths.state),
          ),
          journal: join(worker.stateDirectory, "capture"),
          nativeDatabase: database,
          excludedRoots: [
            storage.paths.state,
            storage.paths.captures,
            storage.paths.tmp,
          ],
        });
        inspections.set(worker.sessionId, { owner, authority });
        let cleanup:
          | { kind: "ready" | "closing" | "closed" }
          | { kind: "failed"; error: unknown } = { kind: "ready" };
        return () => {
          if (cleanup.kind === "failed") throw cleanup.error;
          if (cleanup.kind !== "ready") return;
          cleanup = { kind: "closing" };
          const errors: unknown[] = [];
          try {
            authority.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            owner.release();
          } catch (error) {
            errors.push(error);
          }
          inspections.delete(worker.sessionId);
          if (errors.length > 0) {
            const error =
              errors.length === 1
                ? errors[0]
                : new AggregateError(
                    errors,
                    "Coding authority and source cleanup failed",
                  );
            cleanup = { kind: "failed", error };
            throw error;
          }
          cleanup = { kind: "closed" };
        };
      } catch (error) {
        try {
          owner.release();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Coding authority startup and source cleanup failed",
          );
        }
        throw error;
      }
    },
    async models(worker, defaults) {
      const existing = chatRuntimes.get(worker.sessionId);
      if (existing) return existing.models;
      const pending = openingChats.get(worker.sessionId);
      if (pending) return (await pending).models;
      const opening = (async () => {
        const capture = journal(worker).capture;
        const credentialInspection = inspection(worker);
        const models = workspaceCaptureModels(defaults, {
          ...transport,
          route: await resolveChatRoute(worker),
          ...admission(worker),
          capture,
          credentialInspection,
          runId: worker.sessionId,
          sessionAffinity: worker.sessionId,
        });
        return workspaceChatRuntime(
          models,
          worker.stateDirectory,
          chatSources,
          worker.sessionId,
        );
      })();
      openingChats.set(worker.sessionId, opening);
      const runtime = await opening;
      chatRuntimes.set(worker.sessionId, runtime);
      return runtime.models;
    },
    routeModel: routeModelRef(route),
    ...(route.provider === "claude"
      ? {
          // The host has no default on a Claude route (`routeCodingDefaults`): the account's row
          // for the route's model is read when a chat with no model named runs.
          async defaultModel() {
            return claudeDefaultModel(
              route,
              chatSources?.statuses.current() ?? [],
            );
          },
        }
      : {}),
    extensions(worker) {
      const runtime = chatRuntimes.get(worker.sessionId);
      return {
        extensions: runtime?.extensions ?? [],
        ...(runtime
          ? { attach: runtime.attach, ownTools: runtime.ownTools }
          : {}),
      };
    },
    nonTurnModels(worker, purpose, conversationId, defaults) {
      return workspaceCaptureModels(defaults, {
        ...transport,
        route: accountRoute ?? route,
        ...admission(worker),
        capture: journal(worker).capture,
        credentialInspection: inspection(worker),
        runId: worker.sessionId,
        sessionAffinity: worker.sessionId,
        purpose,
        conversationId,
      });
    },
    onConversation(worker, conversationId) {
      try {
        journal(worker).capture({
          type: "session.bind",
          scope: { runId: worker.sessionId, conversationId },
        });
      } catch (error) {
        if (!captureWriteFailure(error)) throw error;
        reportCaptureLoss(worker)(
          {
            event: "session.bind",
            conversationId,
            kind: error.kind,
            reason: error.lossReason,
            at: new Date().toISOString(),
          },
          false,
        );
      }
    },
    priced: (model) =>
      [...chatRuntimes.values()].some((runtime) => runtime.owns(model.provider))
        ? false
        : model.provider === route.provider && model.modelId === route.model
          ? route.price !== null
          : true,
    tool(worker, tool) {
      const prepare = routeToolArguments(route);
      return {
        ...tool,
        ...(prepare === undefined
          ? {}
          : {
              prepareArguments(args: unknown) {
                const repaired = prepare(args, tool.parameters);
                return tool.prepareArguments
                  ? tool.prepareArguments(repaired)
                  : repaired;
              },
            }),
        async execute(args, api, context) {
          if (tool.name !== "bash") return tool.execute(args, api, context);
          const diagnostics: Parameters<typeof fullOutputPath>[0][number][] =
            [];
          try {
            return await tool.execute(
              args,
              {
                ...api,
                diagnostic(value) {
                  if (value.code !== undefined)
                    diagnostics.push({
                      code: value.code,
                      message: value.message,
                    });
                  api.diagnostic(value);
                },
              },
              context,
            );
          } finally {
            const path = fullOutputPath(diagnostics);
            if (path !== undefined)
              await journal(worker).ingest({
                scope: {
                  runId: worker.sessionId,
                  conversationId: api.conversationId,
                },
                name: `bash-${api.callId}-full-output`,
                mediaType: "text/plain",
                path,
              });
          }
        },
      };
    },
    async close({ worker, reads }) {
      const runtime =
        chatRuntimes.get(worker.sessionId) ??
        (await openingChats.get(worker.sessionId)?.catch(() => undefined));
      await runtime?.close();
      chatRuntimes.delete(worker.sessionId);
      openingChats.delete(worker.sessionId);
      if (!chatRuntimes.size && !openingChats.size)
        await chatSources?.close?.();
      reviewSessions.get(worker.sessionId)?.close();
      reviewSessions.delete(worker.sessionId);
      const planning = planningSessions.get(worker.sessionId);
      if (planning) {
        await planning.client.close();
        await Promise.allSettled([...planning.pending]);
        planningSessions.delete(worker.sessionId);
      }
      const journalDirectory = join(worker.stateDirectory, "capture");
      const admissionPath = join(worker.stateDirectory, "route-admission.json");
      try {
        const captured = journal(worker);
        try {
          captured.capture({
            type: "artifact",
            scope: { runId: worker.sessionId },
            name: "route-admission.json",
            mediaType: "application/json",
            bytes: readFileSync(admissionPath),
          });
        } catch (cause) {
          if (!(
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          ))
            throw cause;
        } finally {
          captured.close();
        }
      } catch (error) {
        if (!captureWriteFailure(error)) throw error;
      } finally {
        journals.delete(worker.sessionId);
      }
      const started = performance.now();
      const location = storeLocationIn(join(storage.paths.captures, "coding"));
      const snapshot = await Effect.runPromise(
        Effect.andThen(
          Store.prepareForWrite,
          captureRunDump({
            runId: worker.sessionId,
            journal: journalDirectory,
            credentialInspection: inspection(worker),
            nativeDatabase: join(worker.stateDirectory, "channel.sqlite"),
            close: "held",
          }),
        ).pipe(
          Effect.provide(Blobs.layer(location)),
          Effect.provide(Store.layer(location, { create: true })),
          Effect.provide(BunFileSystem.layer),
        ),
      );
      const command = Bun.main.startsWith("/$bunfs/")
        ? [process.execPath]
        : [
            process.execPath,
            ...Starter.sourceRunFlags(),
            fileURLToPath(new URL("./cli.ts", import.meta.url)),
          ];
      await Effect.runPromise(
        startCaptureWorker(location, command).pipe(
          Effect.provide(BunFileSystem.layer),
        ),
      );
      writeSync(
        2,
        `${JSON.stringify({ type: "run.snapshot", runId: worker.sessionId, snapshotId: snapshot.snapshotId, capture: snapshot.capture, store: location.directory, pendingScan: true, durationMs: performance.now() - started })}\n`,
      );
    },
  };
}

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
  if (args[0] === "worker") {
    const { HostConfigSchema, CONFIG_VARIABLE } =
      await import("@ace/host/host-config");
    const configuration = HostConfigSchema.parse(
      JSON.parse(process.env[CONFIG_VARIABLE] ?? "null"),
    );
    const profile = StorageProfile.parse(
      JSON.parse(configuration.environment[PROFILE_VARIABLE] ?? "null"),
    );
    const source = configuration.environment[SOURCE_VARIABLE];
    if (source === undefined)
      throw new Error("A workspace worker requires its launcher configuration");
    const storage = await validateStorageProfile(profile, { checkout: source });
    await runWorker(
      codingWorkerSetup(
        storage,
        undefined,
        undefined,
        productionChatSources({
          home:
            configuration.environment.HOME ??
            (await import("node:os")).homedir(),
          carriedSkills: configuration.skills,
        }),
      ),
    );
    return 0;
  }
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
