import { budgetFetch } from "../budget/fetch.ts";
import { logTimed } from "../log-span.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { openNativeStorage } from "./storage.ts";
import { Effect } from "effect";
import type { RuntimeRegistryShape } from "@neuve/runtime";
import { processRuntimes } from "../runtimes.ts";
import { clientBudget } from "../budget/local.ts";
import type { Budget } from "../budget/scheduler.ts";
import { providerAccountKey } from "./providers/route-admission.ts";
import type { Integrations } from "../integrations.ts";
import type { McpClients } from "../mcp-client.ts";
import { cutoffAt, type RunContext } from "../pipeline.ts";
import {
  captureFolder,
  exportOnClose,
  piDatabase,
  runFolder,
} from "../run-folder.ts";
import type { SourceOwnership } from "./source-ownership.ts";
import { routeOwnsLoop } from "../config.ts";
import { routeAccount } from "../route.ts";
import {
  continuationAccountKey,
  contractSessionSlots,
} from "./session-slots.ts";
import { callSlots, type RunSlot } from "./call-slots.ts";
import type { CloseReceipt } from "./capture/close.ts";
import {
  openManagedCredentialInspection,
  privateInspectionDirectory,
} from "./capture/safety.ts";
import { tmpdir } from "node:os";
import { openCaptureJournal, type CaptureJournal } from "./capture/journal.ts";
import { openReviewHost, type QueueClaim, type ReviewHost } from "./host.ts";
import { childOf } from "./review-task.ts";
import {
  createAgentRouteProvider,
  type RouteTransportOptions,
} from "./providers/agent-route-provider.ts";
import type { CreateRouteProvider } from "./contracts.ts";
import type { RouteConfig } from "../route.ts";
import { bindingRoute } from "./bindings.ts";
import { createCountTokens } from "./providers/count-tokens.ts";
import { reviewStages } from "./stages/index.ts";
import { writeNativeAttempts } from "./measurements.ts";
import { stageRunner } from "./stages/services.ts";

/**
 * One claim's open of a review run over pi (0014): the run's capture journal for this process, the
 * route's providers, the stages over the run's services and the host over the run's `pi.sqlite`.
 * The handler decides how the claim ends; this module only opens it and wires capture's export
 * into every close.
 */

/**
 * Builds each conversation's provider from its route binding: the run's route at the binding's
 * effort (`bindingRoute`), so a stored binding's effort reaches its requests.
 */
export const bindingProvider =
  (
    route: RouteConfig,
    transport: Omit<RouteTransportOptions, "route">,
  ): CreateRouteProvider =>
  (binding, readBinding) =>
    createAgentRouteProvider({
      ...transport,
      route: bindingRoute(route, binding),
      logicalProvider: binding.logicalProvider,
      readBinding,
    });

export interface OpenedAttempt {
  readonly host: ReviewHost<CloseReceipt>;
  readonly journal: CaptureJournal;
}

export const openAttempt = async (input: {
  readonly ctx: RunContext["Service"];
  readonly generation: number;
  readonly ownership: SourceOwnership;
  readonly claim: QueueClaim;
  readonly integrations: Integrations;
  readonly clients: McpClients["Service"];
  /** Runs the call slots' waits under the attempt's telemetry. */
  readonly runSlot: RunSlot;
  readonly budget?: Budget;
  readonly runtimes?: RuntimeRegistryShape;
  /** The route's requests' fetch, for a test's local endpoint; unset, the route's own host. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}): Promise<OpenedAttempt> => {
  const { ctx } = input;
  const { route } = ctx.config;
  const budget = input.budget ?? (await clientBudget());
  const runtimes = input.runtimes ?? (await processRuntimes());
  const ownsLoop = await Effect.runPromise(routeOwnsLoop(route, runtimes));
  const namedAccount = routeAccount(route);
  const account =
    ownsLoop && namedAccount !== undefined
      ? continuationAccountKey(
          await Effect.runPromise(runtimes.continuation(namedAccount.name)),
        )
      : providerAccountKey({ route });
  const admittedFetch = ownsLoop
    ? undefined
    : budgetFetch(input.fetch ?? globalThis.fetch, budget, account);
  input.ownership.assertSource(runFolder(ctx.location, ctx.runId));
  const inspection = openManagedCredentialInspection({
    ownership: input.ownership,
    source: runFolder(ctx.location, ctx.runId),
    directory: privateInspectionDirectory(
      runFolder(ctx.location, ctx.runId),
      ctx.location.directory,
    ),
    journal: captureFolder(ctx.location, ctx.runId),
    nativeDatabase: piDatabase(ctx.location, ctx.runId),
    excludedRoots: [runFolder(ctx.location, ctx.runId), tmpdir()],
  });
  let endReview: (() => void) | undefined;
  let journal: CaptureJournal | undefined;
  let inspectionClosed = false;
  const closeInspection = () => {
    if (inspectionClosed) return;
    inspectionClosed = true;
    inspection.close();
  };
  const closeResources = async () => {
    endReview?.();
    endReview = undefined;
    const errors: unknown[] = [];
    try {
      journal?.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      closeInspection();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 1)
      throw new AggregateError(errors, "Attempt resource cleanup failed");
    if (errors.length === 1) throw errors[0];
  };
  try {
    endReview = await budget.activate?.(account, ctx.runId);
    journal = openCaptureJournal(
      captureFolder(ctx.location, ctx.runId),
      ctx.runId,
      { log: ctx.log },
    );
    const captured = journal;
    // Every claim's start says the same thing, so a resumed run's journal agrees with itself.
    journal.capture({
      type: "run.start",
      scope: { runId: ctx.runId },
      runKind:
        route.provider === "openai" && route.reasoningSummary !== undefined
          ? "reading"
          : "scored",
      sourceRevision: ctx.range.headOid,
      route: `${route.provider}/${route.model}`,
      pricing: route.price === null ? "subscription" : "metered",
    });
    const registry = createRegistry();
    const host = await openReviewHost(
      {
        ownership: input.ownership,
        log: ctx.log,
        storage: await input.ownership.openNative(
          piDatabase(ctx.location, ctx.runId),
          openNativeStorage,
        ),
        models: createModels(),
        createRouteProvider: ownsLoop
          ? () => {
              throw new Error(
                "A contract attempt cannot create a direct provider",
              );
            }
          : bindingProvider(route, {
              log: ctx.log,
              capture: captured.capture,
              credentialInspection: inspection,
              fetch: admittedFetch,
            }),
        registry,
        slots: callSlots(ctx.config.budgets.callsInFlight, input.runSlot, {
          budget,
          account,
          owner: ctx.runId,
          priority: () => ({
            class: "interactive",
            position: "new",
            stage: 0,
          }),
        }),
        run: {
          runId: ctx.runId,
          runKey: ctx.runKey,
          generation: input.generation,
          cycleId: ctx.cycleId,
          range: ctx.range,
          config: ctx.config,
          cutoffAt: cutoffAt(ctx),
        },
        claim: input.claim,
        stages: ({ harness, routes }) => {
          const stages = reviewStages({
            ctx,
            routes,
            capture: captured.capture,
            registry,
            runtimes,
            contractSessions: contractSessionSlots(
              budget,
              ctx.config.budgets.callsInFlight,
              ctx.runId,
            ),
            integrations: input.integrations,
            clients: input.clients,
            run: stageRunner(ctx, input.clients, budget),
            // A round the stage's policy ends but pi cannot: its decision commits, then the
            // generation's abort mark. Called from the generation's own `afterTools` hook, pi's
            // `abortTask` then joins that same invocation, which ends only because the mark
            // signals the hook's context: the call rejects with that cancellation, and the
            // generation stops before its post-tools commit, so it sends no further request. A
            // context nothing can cancel would wait on itself forever, so it is refused.
            endRound: async ({ generation, decide }, context) => {
              if (context.abortSignal === undefined)
                throw new Error(
                  "endRound needs the generation hook's own context, which its abort cancels",
                );
              if (await harness.commit((tx) => decide(tx), context))
                await harness.abortTask(generation, context);
            },
            // The route's free token count (§2.1, 10.35), where it has one: absent on the OpenAI route.

            countTokens: ownsLoop
              ? async () => null
              : (request, signal) =>
                  logTimed(
                    ctx.log,
                    "harness.count-tokens",
                    { "harness.agent": request.label },
                    () =>
                      createCountTokens({
                        route,
                        runId: ctx.runId,
                        capture: captured.capture,
                        credentialInspection: inspection,
                        fetch: admittedFetch,
                      })(request, signal),
                  ),
          });
          return {
            port: {
              ...stages,
              front: childOf(stages.front),
              finder: childOf(stages.finder),
            },
            extension: stages.extension,
            restore: stages.restore,
          };
        },
        // Capture's hook ends the journal's session, then exports the raw storage and the native
        // backup into Records; the barrier closes the database after it either way.
        onClose: async (close) => {
          // The scheduler joined contractStep's finally before reaching this storage barrier.
          // Its session scope, event consumer, dispatch and tool handlers have all settled.
          let result: CloseReceipt;
          try {
            await writeNativeAttempts(ctx.log, close.reads, close.context);
            const hook = exportOnClose({
              location: ctx.location,
              runId: ctx.runId,
              journal: captured,
              credentialInspection: inspection,
            });
            result = await Effect.runPromise(
              hook({ runId: ctx.runId, ...close }).pipe(
                Effect.provide(ctx.records),
              ),
            );
          } catch (error) {
            try {
              await closeResources();
            } catch (cleanup) {
              throw new AggregateError(
                [error, cleanup],
                "Attempt export and authority cleanup failed",
              );
            }
            throw error;
          }
          await closeResources();
          return result;
        },
        onReport: (error) =>
          ctx.log.write({
            type: "pi.report",
            error: (error instanceof Error
              ? error.message
              : String(error)
            ).slice(0, 500),
          }),
      },
      BACKGROUND_CONTEXT,
    );
    return { host, journal };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await closeResources();
    } catch (cleanup) {
      errors.push(cleanup);
    }
    if (errors.length > 1)
      throw new AggregateError(errors, "Attempt startup and cleanup failed");
    throw error;
  }
};
