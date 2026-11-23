import { watch as watchFiles } from "node:fs";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { Budget, RunLog, Settings } from "@neuve/harness";
import {
  ReviewRefusalError,
  type ReviewLookup,
} from "@ace/channel/review-protocol";
import { ReviewProgress } from "@neuve/records-core";
import {
  ReviewFeedSnapshotSchema,
  type ReviewFeedSnapshot,
  type ReviewFeedSource,
  type ReviewFeedQuery,
  type ReviewSubmission,
} from "@ace/host/review-protocol";
import { z } from "zod";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  PublishedPackets,
  ReviewStats,
  canonicalJson,
  mintUlid,
  resolveStoreLocation,
  sha256Hex,
  type StoreLocation,
} from "@neuve/records-core";
import { PipelineConfig } from "@neuve/harness/config";
import {
  prepareReviewConfig,
  requestReview,
  settingsRoute,
} from "@neuve/harness/request";
import {
  NativeReviewResultSchema,
  type PreparedReview,
  type NativeReviewResult,
  type ReviewStatusQuery,
} from "@ace/host/review-protocol";
import type { NativeReviewCallbacks } from "@ace/host/extension-protocol";
import { execute, withStore } from "./records-cli";
import { requestRangeReview } from "./review-cli";
import { keepWorkerFor } from "./review-worker";

/** Read one admitted request and exact job. A queue completion cannot supply a review verdict. */
export async function nativeReviewStatus(
  project: string,
  query: ReviewStatusQuery,
  link: (project: string, reference: string) => Promise<string>,
): Promise<NativeReviewResult> {
  const location = await execute(resolveStoreLocation(project));
  const value = await execute(
    withStore(
      project,
      "read",
      Effect.gen(function* () {
        const original = yield* Log.get(query.request);
        if (
          Option.isNone(original) ||
          original.value.event.kind !== "review.requested@1"
        )
          throw new Error(
            "Records does not hold this review request in the connected project",
          );
        const event = original.value.event;
        if (event.attribution.cycleId !== query.reference)
          throw new Error("The request does not belong to this review cycle");
        const queue = yield* JobQueue.JobQueue;
        const inspected = yield* queue.inspect(query.job);
        const job = Option.getOrUndefined(inspected);
        if (
          job &&
          (job.eventId !== query.run ||
            job.dedupeKey !==
              `review.run:${event.payload.runKey}:${event.payload.generation}`)
        )
          throw new Error("The job and run do not belong to this request");
        const started = yield* Log.get(query.run);
        if (
          Option.isNone(started) ||
          started.value.event.kind !== "review.requested@1" ||
          started.value.event.attribution.cycleId !== query.reference ||
          started.value.event.payload.runKey !== event.payload.runKey ||
          started.value.event.payload.generation !== event.payload.generation
        )
          throw new Error(
            "Records does not hold the admitted run for this request",
          );
        const found = yield* ReviewStats.runReceipt(query.run);
        const receipt =
          Option.isSome(found) && found.value.event.kind === "run.completed@1"
            ? found.value.event
            : undefined;
        if (receipt && receipt.payload.jobSeq !== query.job)
          throw new Error("The run receipt belongs to a different job");
        // readRun follows a newer standing packet. Only its own packet, its newest publication, can
        // describe this admission; another run's packet standing is said, never attributed to it.
        const packet = yield* PublishedPackets.readRun(query.run);
        const exactPacket =
          packet && packet.eventId === packet.requestedPacket
            ? packet
            : undefined;
        const state = receipt
          ? receipt.payload.outcome
          : job?.state === "failed"
            ? "failed"
            : job?.state === "active"
              ? "running"
              : job?.state === "waiting" || job?.state === "delayed"
                ? "queued"
                : "incomplete";
        return {
          kind: "review",
          ...query,
          base: event.attribution.range.baseOid,
          head: event.attribution.range.headOid,
          state,
          queue: job?.state ?? null,
          recorded: {
            receipt: receipt?.id ?? null,
            packet: exactPacket?.eventId ?? null,
            complete: exactPacket?.complete ?? false,
            gaps: exactPacket?.gaps.length ?? null,
            undecoded: exactPacket?.undecoded.length ?? null,
            units: exactPacket?.counts.units ?? null,
            // What is still being judged, said only for a packet of the new shape.
            ...(exactPacket?.kind === "packet.published@2"
              ? { pending: exactPacket.counts.pending }
              : {}),
            message:
              packet && !exactPacket
                ? "The cycle has a newer standing packet. Open the review link for current review facts; no findings from it are attributed to this run."
                : !receipt
                  ? "No terminal run receipt is recorded. Queue or tool completion is not review completion or approval."
                  : !exactPacket
                    ? "A terminal run receipt is recorded, but no exact published packet is available. No approval is inferred."
                    : "Recorded packet summary only. Review completion and packet completeness do not grant approval. Open the review link for recorded unit dispositions and findings.",
          },
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
      ),
    ),
  );
  return NativeReviewResultSchema.parse({
    ...value,
    url: await link(project, query.reference),
  });
}

export function nativeReviewCallbacks(
  link: (project: string, reference: string) => Promise<string>,
  admitProject: (project: string) => Promise<string>,
  /** Keeps a worker of this build for a queued review (`keepWorkerFor`); tests stand it in. */
  keepWorker: (input: {
    readonly project: string;
    readonly job: number;
  }) => Promise<unknown> = keepWorkerFor,
  prepareConfig: (
    location: StoreLocation,
  ) => Effect.Effect<PipelineConfig, unknown> = (location) =>
    prepareReviewConfig({ location, route: settingsRoute() }),
): Required<NativeReviewCallbacks> {
  const admissions = new Map<string, Promise<NativeReviewResult>>();
  const serialize = async (
    review: string,
    work: () => Promise<NativeReviewResult>,
  ) => {
    const previous = admissions.get(review) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    admissions.set(review, pending);
    try {
      return await pending;
    } finally {
      if (admissions.get(review) === pending) admissions.delete(review);
    }
  };
  return {
    async reviewPrepare(handoff) {
      const started = Date.now();
      const requestId = mintUlid();
      const project = await admitProject(handoff.project);
      const location = await execute(resolveStoreLocation(project));
      const log = RunLog.openAdmissionLog(
        location,
        requestId,
        Settings.telemetryMode(Settings.readSettings()) !== "off",
      );
      log.write({
        type: "span.start",
        name: "harness.admission.review-prepare",
        spanId: `prepare:${requestId}`,
        start: new Date(started).toISOString(),
        attributes: {},
      });
      let status = "ok";
      try {
        const config = await Effect.runPromise(
          prepareConfig(location).pipe(
            Effect.withTracer(RunLog.runLogTracer(log)),
          ),
        );
        const externalContext = handoff.externalSources.length
          ? sha256Hex(
              canonicalJson(
                handoff.externalSources.map(
                  ({ fetchedAt: _at, version: _version, ...source }) => source,
                ),
              ),
            )
          : undefined;
        return {
          requestId,
          config: z.json().parse(
            JSON.parse(
              JSON.stringify({
                ...config,
                ...(externalContext ? { externalContext } : {}),
              }),
            ),
          ),
        };
      } catch (error) {
        status = "error";
        throw error;
      } finally {
        log.write({
          type: "span",
          name: "harness.admission.review-prepare",
          spanId: `prepare:${requestId}`,
          start: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          status,
          attributes: {},
        });
      }
    },
    reviewSubmit: (prepared, validate) =>
      serialize(prepared.requestId, async () => {
        const started = Date.now();
        const h = prepared.handoff;
        const project = await admitProject(h.project);
        const location = await execute(resolveStoreLocation(project));
        const log = RunLog.openAdmissionLog(
          location,
          prepared.requestId,
          Settings.telemetryMode(Settings.readSettings()) !== "off",
        );
        const submitSpanId = mintUlid();
        log.write({
          type: "span.start",
          name: "harness.admission.review-submit",
          spanId: submitSpanId,
          start: new Date(started).toISOString(),
          attributes: {},
        });
        let status = "ok";
        try {
          const exists = await execute(
            withStore(project, "create", Log.get(prepared.requestId)).pipe(
              Effect.withTracer(RunLog.runLogTracer(log)),
            ),
          );
          await validate(Option.isNone(exists));
          const values = {
            requestId: prepared.requestId,
            branchCheckout: h.cwd,
            frozenConfig: PipelineConfig.parse(prepared.config),
            origin: h.origin,
            externalSources: h.externalSources,
            requester: {
              _tag: "Agent" as const,
              harness: "neuve-pi",
              sessionId: h.channel,
              subagentId: String(h.chat),
            },
            ...(h.source
              ? {
                  scopeSource: {
                    server: h.source.connection,
                    item: h.source.key,
                    workspace: h.source.workspace,
                  },
                }
              : {}),
          };
          if (Option.isSome(exists)) {
            const recovered = await execute(
              withStore(project, "read", (location) =>
                Effect.gen(function* () {
                  yield* requestReview({
                    location,
                    repository: project,
                    range: `${h.base}..${h.head}`,
                    ...values,
                  });
                  return (yield* resolveReview(h.channel, {
                    review: prepared.requestId,
                  })).query;
                }).pipe(
                  Effect.provide(
                    Layer.mergeAll(
                      JobQueue.layer,
                      Computations.layer.pipe(
                        Layer.provideMerge(Blobs.layer(location)),
                      ),
                    ),
                  ),
                ),
              ),
            );
            // A recovered request may still be waiting: a worker of this build takes it (12.24).
            await keepWorker({ project, job: recovered.job });
            const status = await nativeReviewStatus(project, recovered, link);
            const admission = await admissionDetails(prepared, true);
            return NativeReviewResultSchema.parse({
              ...status,
              admission,
              target: prepared.target,
              ...(h.branch ? { branch: h.branch } : {}),
            });
          }
          const result = await requestRangeReview(
            project,
            `${h.base}..${h.head}`,
            values,
          );
          if (result.newer)
            throw new Error(
              `Job ${result.job.seq} is ${result.job.kind}, a newer build's job; use that build to read and run it.`,
            );
          if (!result.job.eventId)
            throw new Error("Records admitted a job without its run identity");
          // `review.run@2`, which only a worker of this build takes, so one is kept for it (12.24).
          await keepWorker({ project, job: result.job.seq });
          const status = await nativeReviewStatus(
            project,
            {
              request: prepared.requestId,
              reference: result.request.cycleId,
              job: result.job.seq,
              run: result.job.eventId,
            },
            link,
          );
          return NativeReviewResultSchema.parse({
            ...status,
            admission: await admissionDetails(prepared, false),
            target: prepared.target,
            ...(h.branch ? { branch: h.branch } : {}),
          });
        } catch (error) {
          status = "error";
          throw error;
        } finally {
          log.write({
            type: "span",
            name: "harness.admission.review-submit",
            spanId: submitSpanId,
            start: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            status,
            attributes: {},
          });
        }
      }),
    reviewStatus: (project, query) => nativeReviewStatus(project, query, link),
    async reviewLookup(project, channel, query) {
      const value = await readReviewFeedSnapshot(project, channel, query);
      return {
        review: value.review,
        state: value.progress.phase,
        ...(value.progress.phase === "running" && value.progress.stage
          ? { stage: value.progress.stage }
          : {}),
      };
    },
    async reviewOutcome(project, channel, query) {
      const value = await readReviewFeedSnapshot(project, channel, query);
      if (value.progress.phase !== "finished")
        return { outcome: "not_finished", state: value.progress.phase };
      const { complete, units, gaps, undecoded } = value.progress.finished;
      return { review: value.review, complete, units, gaps, undecoded };
    },
    reviewFeed: reviewFeedReply,
  };
}

async function admissionDetails(
  prepared: ReviewSubmission,
  recovered: boolean,
) {
  const h = prepared.handoff;
  const child = Bun.spawn(
    ["git", "-C", h.cwd, "rev-list", "--count", `${h.base}..${h.head}`],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0)
    throw new Error(
      error.trim() || "The pinned range commit count is unavailable",
    );
  const commits = z.coerce.number().int().nonnegative().parse(output.trim());
  return {
    recovered,
    commits,
    branch:
      h.branch ??
      (prepared.target.kind === "pull-request"
        ? `${prepared.target.repo}#${prepared.target.number}`
        : (h.lane ?? "detached")),
    notify: prepared.notify ?? false,
  };
}

/** The request is the only public handle. Resolve its canonical deduplicated job/run in Records. */
const resolveReview = (
  channel: string,
  query: { review?: string | undefined; chat?: number | undefined },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      id: string;
      chat: string | null;
    }>`SELECT e.id, a.subagent_id AS chat FROM events e
      JOIN projection_actors a ON a.actor_id = e.actor_id
      WHERE e.kind = 'review.requested@1' AND a.harness = 'neuve-pi' AND a.session_id = ${channel}
        AND (${query.review ?? null} IS NULL OR e.id = ${query.review ?? null})
        AND (${query.review !== undefined || query.chat === undefined ? null : String(query.chat)} IS NULL
          OR a.subagent_id = ${query.chat === undefined ? null : String(query.chat)})
      ORDER BY e.seq DESC LIMIT 1`;
    if (!row)
      throw new ReviewRefusalError(
        "not_found",
        "Records does not hold this review request in the connected chat",
      );
    const found = yield* Log.get(row.id);
    if (Option.isNone(found) || found.value.event.kind !== "review.requested@1")
      throw new ReviewRefusalError(
        "records_mismatch",
        "Records request did not decode",
      );
    const request = found.value.event;
    const key = `review.run:${request.payload.runKey}:${request.payload.generation}`;
    const [queued] = yield* sql<{
      seq: number;
    }>`SELECT job_seq AS seq FROM jobs WHERE dedupe_key = ${key}`;
    const queue = yield* JobQueue.JobQueue;
    const job = queued
      ? Option.getOrUndefined(yield* queue.inspect(queued.seq))
      : undefined;
    let run = job?.eventId;
    let jobSeq = job?.seq;
    if (!run) {
      const [ended] = yield* sql<{
        id: string;
      }>`SELECT id FROM events WHERE kind = 'run.completed@1'
        AND json_extract(envelope, '$.payload.runKey') = ${request.payload.runKey}
        AND json_extract(envelope, '$.payload.generation') = ${request.payload.generation}
        AND json_extract(envelope, '$.attribution.cycleId') = ${request.attribution.cycleId}
        ORDER BY seq LIMIT 1`;
      const receipt = ended
        ? Option.getOrUndefined(yield* Log.get(ended.id))?.event
        : undefined;
      if (receipt?.kind === "run.completed@1") {
        run = receipt.attribution.runId;
        jobSeq = receipt.payload.jobSeq;
      }
    }
    if (!run || !jobSeq)
      throw new ReviewRefusalError(
        "records_mismatch",
        "Records retains this request but not its exact job or run receipt",
      );
    const started = Option.getOrUndefined(yield* Log.get(run))?.event;
    if (
      started?.kind !== "review.requested@1" ||
      started.payload.runKey !== request.payload.runKey ||
      started.payload.generation !== request.payload.generation ||
      started.attribution.cycleId !== request.attribution.cycleId
    )
      throw new ReviewRefusalError(
        "records_mismatch",
        "Records job/run does not belong to this request",
      );
    if (row.chat === null)
      throw new ReviewRefusalError(
        "records_mismatch",
        "Records request has no owning chat",
      );
    return {
      request,
      job,
      chat: z.coerce.number().int().nonnegative().parse(row.chat),
      query: {
        request: request.id,
        reference: request.attribution.cycleId,
        job: jobSeq,
        run,
      },
    };
  });

const cycleSequence = (cycle: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      seq: number | null;
    }>`SELECT max(event_seq) AS seq FROM event_cycles WHERE cycle_id = ${cycle}`;
    return row?.seq ?? 0;
  });

/** One consistent read of a request's receipt, queue state and published packet, with no findings leaving the callback. */
export async function readReviewFeedSnapshot(
  project: string,
  channel: string,
  query: { review?: string | undefined; chat?: number | undefined },
): Promise<ReviewFeedSnapshot> {
  const location = await execute(resolveStoreLocation(project));
  return ReviewFeedSnapshotSchema.parse(
    await execute(
      withStore(
        project,
        "read",
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const resolved = yield* resolveReview(channel, query);
              const receiptEvent = Option.getOrUndefined(
                yield* ReviewStats.runReceipt(resolved.query.run),
              )?.event;
              const receipt =
                receiptEvent?.kind === "run.completed@1"
                  ? receiptEvent
                  : undefined;
              if (receipt && receipt.payload.jobSeq !== resolved.query.job)
                throw new ReviewRefusalError(
                  "records_mismatch",
                  "Records receipt belongs to a different job",
                );
              const stages: string[] = [...Budget.Stage.options];
              const completions = yield* ReviewProgress.stageCompletions(
                resolved.query.run,
              );
              for (const completion of completions)
                if (!stages.includes(completion.stage))
                  stages.push(completion.stage);
              const stageProgress = yield* ReviewProgress.stageProgress(
                resolved.query.run,
                stages,
              );
              let progress: ReviewFeedSnapshot["progress"];
              if (receipt?.payload.outcome === "completed") {
                // The run's own packet: its newest publication, of either shape.
                const [published] = yield* sql<{
                  id: string;
                }>`SELECT id FROM events WHERE kind IN ('packet.published@1', 'packet.published@2')
          AND json_extract(envelope, '$.attribution.runId') = ${resolved.query.run} ORDER BY id DESC LIMIT 1`;
                const packet = published
                  ? yield* PublishedPackets.readExact(published.id)
                  : undefined;
                if (!packet)
                  throw new ReviewRefusalError(
                    "records_mismatch",
                    "The run's exact published packet is unavailable",
                  );
                const byReviewLane = {
                  humanRequired: 0,
                  humanSuggested: 0,
                  agentic: 0,
                  static: 0,
                };
                let needJudgment = 0;
                // Each unit's lane as Records judges it, the same for either shape.
                for (const unit of packet.batches.flatMap(
                  (
                    batch,
                  ): ReadonlyArray<{
                    readonly judgement: (typeof batch.units)[number]["judgement"];
                  }> => batch.units,
                )) {
                  switch (unit.judgement.lane) {
                    case "human-required":
                      byReviewLane.humanRequired++;
                      if (!unit.judgement.closed) needJudgment++;
                      break;
                    case "human-suggested":
                      byReviewLane.humanSuggested++;
                      break;
                    case "agentic":
                      byReviewLane.agentic++;
                      break;
                    case "static-automation":
                      byReviewLane.static++;
                      break;
                  }
                }
                progress = {
                  phase: "finished",
                  finished: {
                    units: packet.counts.units,
                    byReviewLane,
                    needJudgment,
                    complete: packet.complete,
                    gaps: packet.gaps.length,
                    undecoded: packet.undecoded.length,
                    ...(packet.kind === "packet.published@2"
                      ? { pending: packet.counts.pending }
                      : {}),
                  },
                };
              } else if (receipt) {
                const interrupted = receipt.payload.timeout.disclosed.find(
                  (item) => item.status === "interrupted" && item.note,
                );
                const note = interrupted?.note
                  ? `${interrupted.stage}: ${interrupted.note}`
                  : undefined;
                progress = {
                  phase: "stopped",
                  reason:
                    note ??
                    `${stageProgress?.name ?? "review"}: The review reached its recorded time limit.`,
                };
              } else if (
                resolved.job?.state === "failed" ||
                resolved.job?.state === "completed"
              ) {
                progress = {
                  phase: "stopped",
                  reason: `${stageProgress?.name ?? "review"}: ${
                    resolved.job.lastError?.tag === "Dropped"
                      ? "The review was stopped before it recorded a terminal receipt."
                      : resolved.job.lastError?.tag === "DeadlineExceeded"
                        ? "The review reached its recorded deadline."
                        : resolved.job.state === "failed"
                          ? "Records marked the review job as failed without a terminal receipt."
                          : "Records marked the review job as completed without a terminal receipt."
                  }`,
                };
              } else if (
                resolved.job?.state === "waiting" ||
                resolved.job?.state === "delayed"
              ) {
                progress = { phase: "queued" };
              } else if (resolved.job?.state === "active") {
                progress = {
                  phase: "running",
                  stage: stageProgress,
                };
              } else progress = { phase: "queued" };
              return {
                review: resolved.request.id,
                chat: resolved.chat,
                sequence: yield* cycleSequence(resolved.query.reference),
                project,
                cycle: resolved.query.reference,
                stages,
                progress,
              };
            }),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              JobQueue.layer,
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

const reviewFeedMark = async (
  project: string,
  channel: string,
  review: string,
) =>
  execute(
    withStore(
      project,
      "read",
      Effect.gen(function* () {
        const resolved = yield* resolveReview(channel, { review });
        const sequence = yield* cycleSequence(resolved.query.reference);
        return `${sequence}:${resolved.job?.state ?? "pruned"}:${resolved.job?.attempts ?? 0}:${resolved.job?.lastError?.message ?? ""}`;
      }).pipe(Effect.provide(JobQueue.layer)),
    ),
  );

/** Subscribe before reading; SQLite file changes drive projections, with a bounded retry for busy stores. */
export function recordsReviewFeed(
  project: string,
  channel: string,
  options: { intervalMs?: number; report?(error: unknown): void } = {},
): ReviewFeedSource {
  return {
    async watch(review, receive, context, failed) {
      const location = await execute(resolveStoreLocation(project));
      let stopped = false;
      let lastReadAt = 0;
      let latest: string | undefined;
      let latestMark: string | undefined;
      let reading: Promise<void> | undefined;
      const tick = () => {
        return (reading ??= (async () => {
          if (!stopped) {
            lastReadAt = Date.now();
            const mark = await reviewFeedMark(project, channel, review);
            if (mark === latestMark) return;
            const snapshot = await readReviewFeedSnapshot(project, channel, {
              review,
            });
            const stamp = canonicalJson(snapshot);
            if (stamp !== latest && !stopped) {
              await receive(snapshot);
              latest = stamp;
            }
            latestMark = mark;
          }
        })().finally(() => {
          reading = undefined;
        }));
      };
      const changed = () => {
        if (Date.now() - lastReadAt < 250) return;
        void tick().catch((error) => {
          options.report?.(error);
          failed?.(error);
          void stop();
        });
      };
      const observer = watchFiles(
        location.directory,
        { persistent: false },
        (_event, name) => {
          if (
            name === "records.sqlite" ||
            name === "records.sqlite-wal" ||
            name === null
          )
            changed();
        },
      );
      observer.on("error", (error) => {
        options.report?.(error);
        failed?.(error);
        void stop();
      });
      const timer = setInterval(changed, options.intervalMs ?? 1000);
      timer.unref();
      const stop = async () => {
        stopped = true;
        observer.close();
        clearInterval(timer);
        context.abortSignal?.removeEventListener("abort", abort);
        await reading?.catch(() => {});
      };
      const abort = () => {
        void stop();
      };
      context.abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        if (context.abortSignal?.aborted) throw context.abortSignal.reason;
        await tick();
        return stop;
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}

/** Ace's request/reply transport bounds abandoned server watches to five seconds. */
async function reviewFeedReply(
  project: string,
  channel: string,
  query: ReviewFeedQuery,
): Promise<{ stamp: string; snapshot: ReviewFeedSnapshot } | null> {
  const result = Promise.withResolvers<{
    stamp: string;
    snapshot: ReviewFeedSnapshot;
  } | null>();
  void result.promise.catch(() => {});
  const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
  const timer = setTimeout(() => {
    result.resolve(null);
    cancel();
  }, 5000);
  let stop: (() => void | Promise<void>) | undefined;
  try {
    stop = await recordsReviewFeed(project, channel).watch(
      query.review,
      async (raw) => {
        const snapshot = ReviewFeedSnapshotSchema.parse(raw);
        const stamp = sha256Hex(canonicalJson(snapshot));
        if (stamp !== query.after) result.resolve({ stamp, snapshot });
      },
      context,
      (error) => result.reject(error),
    );
    return await result.promise;
  } catch (error) {
    if (context.abortSignal?.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
    cancel();
    await stop?.();
  }
}
