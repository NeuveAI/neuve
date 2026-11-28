import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import { CONFIG_VARIABLE, HostConfigSchema } from "@ace/host/host-config";
import {
  configureReviewPreparation,
  nativeReview,
} from "@ace/host/native-review";
import {
  runWorker,
  type WorkerContext,
  type WorkerSetup,
} from "@ace/host/worker";
import {
  CaptureFailed,
  SourceOwnership,
  codingRouteLimits,
  createRouteModels,
  openManagedCredentialInspection,
  privateInspectionDirectory,
  type PrivateInspection,
  fullOutputPath,
  openCaptureJournal,
  openRouteAdmission,
  routeToolArguments,
  settingsRoute,
  type AnyRouteConfig,
  type CaptureJournal,
  type RouteAdmission,
  type RouteModelsOptions,
} from "@neuve/harness/coding";
import type { LinearMcpSession } from "@neuve/harness/linear-planning";
import { checkpointNativeAuthority } from "@neuve/harness/native-source-authority";
import { Blobs, Identity, Store, storeLocationIn } from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import {
  StorageProfile,
  StorageRefused,
  validateStorageProfile,
  type ValidatedStorage,
} from "../../../scripts/pi-storage.ts";
import { thisBuild } from "./cli-command.ts";
import type { PublicQueryEvent, RepositoryPath, Revision } from "./domain.ts";
import { workspaceCaptureModels } from "./workspace-capture-models.ts";
import {
  claudeDefaultModel,
  workspaceChatRuntime,
  productionChatSources,
  type ChatRuntimeSources,
  type WorkerChatRuntime,
} from "./workspace-chat-runtime.ts";
import { workspaceLinearPlanning } from "./workspace-linear.ts";
import { routeModelRef } from "./workspace-models.ts";

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
  type CodingRuntime = WorkerChatRuntime & { prepareModels(): Promise<void> };
  const chatRuntimes = new Map<string, CodingRuntime>();
  const openingChats = new Map<string, Promise<CodingRuntime>>();
  let accountRoute: AnyRouteConfig | undefined;
  const routeLimits = new SharedWork<AnyRouteConfig>();
  const resolveChatRoute = async (worker: WorkerContext) => {
    if (accountRoute || route.provider === "claude")
      return accountRoute ?? route;
    const { outcome } = await routeLimits.run({
      scope: "coding-route-limits",
      key: route.model,
      run: async () => {
        accountRoute =
          (await codingRouteLimits(
            route,
            { ...transport, admission: directAdmission(worker) },
            (fields) =>
              process.stderr.write(
                `${JSON.stringify({ event: "model-limits.resolved", ...fields })}\n`,
              ),
          )) ?? route;
        return { kind: "succeeded", value: accountRoute };
      },
    });
    if (outcome.kind === "failed") throw outcome.error;
    return outcome.value;
  };
  configureReviewPreparation(async (project, range) => {
    const [{ CommitPrepare }, { keepWorkerFor }] = await Promise.all([
      import("@neuve/harness"),
      import("./review-worker.ts"),
    ]);
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
      const { collectPublicQueryResult, runQueryGraph } =
        await import("./graph-query.ts");
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
          trustWorkingTree: false,
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
        const options = {
          ...transport,
          route,
          ...admission(worker),
          capture,
          credentialInspection,
          runId: worker.sessionId,
          sessionAffinity: worker.sessionId,
        };
        const configured = createModels();
        const runtime = await workspaceChatRuntime(
          workspaceCaptureModels(defaults, options, configured),
          worker.stateDirectory,
          chatSources,
          worker.sessionId,
        );
        let active = route;
        return {
          ...runtime,
          async prepareModels() {
            const resolved = await resolveChatRoute(worker);
            if (resolved === active) return;
            createRouteModels({ ...options, route: resolved }, configured);
            active = resolved;
          },
        };
      })();
      openingChats.set(worker.sessionId, opening);
      const runtime = await opening;
      chatRuntimes.set(worker.sessionId, runtime);
      return runtime.models;
    },
    ...(route.provider === "claude"
      ? {}
      : {
          async prepareModels(worker: WorkerContext) {
            await chatRuntimes.get(worker.sessionId)?.prepareModels();
          },
        }),
    routeModel: routeModelRef(route),
    ...(chatSources
      ? { accountStatuses: () => chatSources.statuses.current() }
      : {}),
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
      const [{ captureRunDump }, { startCaptureWorker }] = await Promise.all([
        import("@neuve/harness/session-dump"),
        import("./worker-cli.ts"),
      ]);
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
      await Effect.runPromise(
        startCaptureWorker(location, thisBuild()).pipe(
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

export async function runWorkspaceWorker(): Promise<number> {
  delete process.env[Identity.ACE_CHAT_VARIABLE];
  try {
    const configuration = HostConfigSchema.parse(
      JSON.parse(process.env[CONFIG_VARIABLE] ?? "null"),
    );
    const profile = StorageProfile.parse(
      JSON.parse(
        configuration.environment["NEUVE_WORKSPACE_PROFILE"] ?? "null",
      ),
    );
    const source = configuration.environment["NEUVE_WORKSPACE_SOURCE"];
    if (source === undefined)
      throw new Error("A workspace worker requires its launcher configuration");
    const storage = await validateStorageProfile(profile, { checkout: source });
    await runWorker(
      codingWorkerSetup(
        storage,
        undefined,
        undefined,
        productionChatSources({
          home: configuration.environment.HOME ?? homedir(),
          carriedSkills: configuration.skills,
        }),
      ),
    );
    return 0;
  } catch (error) {
    if (!(error instanceof StorageRefused)) throw error;
    writeSync(2, `neuve workspace: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runWorkspaceWorker();
  } catch (error) {
    writeSync(
      2,
      `neuve: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
