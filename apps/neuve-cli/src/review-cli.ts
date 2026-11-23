import { captureOutlineSource } from "../../../packages/harness/src/graph-outline.ts";
import { safeRead } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { SqlClient } from "effect/sql/SqlClient";
import { CaptureRecords } from "@neuve/harness/session-dump";
import {
  auditCapture,
  readRawManifest,
  legacyCaptures,
} from "@neuve/harness/session-dump";
import {
  MAX_CLOSE_MS,
  closeCeiling,
} from "../../../packages/harness/src/pi/capture/watchdog.ts";
import { recordedCloseCeiling } from "../../../packages/harness/src/pi/capture/recorded-inventory.ts";
import { dirname, join } from "node:path";
import {
  CloseDiagnostic,
  publicCloseReason,
  renderCloseDiagnostic,
} from "../../../packages/harness/src/pi/capture/close-diagnostic.ts";
import type {
  CycleScopeSource,
  ExternalReviewSource,
  ReviewOrigin,
} from "@neuve/records-schema";
import {
  existsSync,
  realpathSync,
  statSync,
  writeSync,
  watch,
  mkdirSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { Cause, Effect, Layer, Logger, ManagedRuntime, Option } from "effect";
import { z } from "zod";
import { ReceiptLists, Ulid } from "@neuve/records-schema";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  PublishedPackets,
  ReviewStats,
  Starter,
  Worker,
  resolveStoreLocation,
  storeLocationIn,
  type StoreLocation,
} from "@neuve/records-core";
import {
  Budget,
  CommitHybrid as HarnessCommitHybrid,
  Config,
  Git,
  Manifest,
  PacketView,
  Receipt,
  Recompose,
  Request,
  Route,
  RouteProvider,
  RunLog,
  Scope,
  SearchIndex,
  StageView,
} from "@neuve/harness";
import {
  heldForAccount,
  readHeldReviews,
  type HeldReview,
} from "@neuve/harness/held-reviews";
import {
  exportCapturedDump,
  readCapturedDump,
} from "@neuve/harness/session-dump";
import { AccountDirectory, RuntimeRegistry } from "@neuve/runtime";
import { harnessRuntimes, workerRuntimeOptions } from "@neuve/harness/runtimes";
import { execute, withStore, write } from "./records-cli.ts";
import { startCaptureWorker } from "./worker-cli.ts";
import { deskLinkLine } from "./review-desk-claim.ts";
import { REVIEW_DESK_COMMAND } from "./review-desk-config.ts";
import { requireRepositorySetup } from "./setup-status.ts";
import { gitAvailability, gitRefusal } from "./git-available.ts";

export const REVIEW_HELP = `Usage:
  neuve review <base>..<head> [--route <name>] [--leads bm25|hybrid] [--detach] [--repo <path>]
              Request a review of a commit range and follow its run. The request opens the
              range's review cycle (or joins it) and queues one review.run job; the worker runs
              it in the background, so closing the terminal does not stop it. --detach returns
              once the job is queued. A second request for the same range and configuration
              follows the same job. Run neuve setup in the repository first.
  neuve review ${REVIEW_DESK_COMMAND} [--repo <path>] [--port <n>]
              Open the batch overview and the review desk for the repository on this machine.
              Run neuve review ${REVIEW_DESK_COMMAND} --help for the options.
  neuve review recompose --run <run-id> --store <dir> [--allow-model frame,map,find,verify] [--json] [--repo <path>]
              Run a completed run's review again as a new run in the given store (a scratch copy
              of a case's store, never a working checkout's own), reusing every stored stage, to
              score a change to Link, Publish or the digest without a new review. Every agent
              step must find its stored output: one that would need the model stops the run and
              is named, unless --allow-model lets the Frame, Map, Find or Verify
              step call it. Without
              --allow-model the run reads no credential and opens no connection; telemetry export
              and integration servers are off either way. --allow-model needs a lease
              (NEUVE_OPENAI_TOKEN_COMMAND). --store is required: the folder that holds the scratch
              copy's neuve/ folder, as .git holds it; a store inside any git directory is refused. Prints
              each step as reused, code-filled or recomputed with the model, then what review
              show --json prints for the new run.
  neuve review show [<base>..<head> | --run <run-id>] [--json] [--repo <path>]
              Print a run's receipt from Records (run.completed@1): route, the variable that
              supplied the key, stages with turns against their limits, tokens, cost and time,
              and what it disclosed. A run still going shows its run log so far. Then the range
              manifest Precompute stored: each hunk's allowance, declared kinds, owned ranges and
              sides, enclosing symbol and leads, the change facts, and the cycle's scope snapshot
              with each source's stratum and fetch time. Before it, the packet Publish appended:
              each batch's digest and units with their lanes, rationales, validation requirements,
              Guided rows, the agent's lane-blind review, its comments and disposition (or the
              suggested review on human-required work), each unit's closure, the local IDs its
              content cites resolved through the assembled batch with the count left unresolved,
              each reference whole (grade, why, before you decide), and the run's gaps,
              ownership disclosures among them; then Frame, Map, finding and verification counts,
              and the agents' spans.
  neuve review export-dump --capture <hash> --root <dir> [--store <Records dir>] [--redaction restricted|portable]
              Export a marked capture from a coding or review Records store.
  neuve review dead-letter list [--store <Records dir>] [--repo <path>]
  neuve review dead-letter send-back --job <number>|--all [--store <Records dir>] [--repo <path>]
  neuve review audit --capture <raw-capture>|--run <run-id>|--all [--repair] [--store <Records dir>] [--repo <path>]
  neuve review capture-status --run <run-id>|--capture <hash> [--store <Records dir>] [--repo <path>]
  neuve review capture-ceiling --run <run-id> [--repo <path>]
  neuve review export-dump --run <run-id> --root <dir> [--redaction restricted|portable] [--repo <path>]
              File a run's session dump into <dir> (an existing folder) for a dataset, and print the
              snapshot it filed (directory, runId, snapshotId, redaction, reused, run) as JSON, with
              the close that recorded it (mode held, interrupted or ended; execution open or ended;
              whether the capture is complete). The snapshot is the one the run's latest close
              recorded in its run log, read back whole from Records and checked to be this run's. An
              attempt admitted after the last close, not closed yet, exits 3; a failed or malformed
              latest close, a record naming another run's capture, or a pruned one is refused.
              restricted (the default) copies the capture byte for byte; portable derives the
              inspection copy. The same snapshot filed again is verified and reused, never
              overwritten. It reads the store only: no network, credential or worker.
  neuve review stats [--cycle <id>] [--json] [--repo <path>]
              Print the review product metrics Records projects: lanes per batch, gaps by kind,
              agent dispositions by verdict and lane (uncited requests for changes, approvals
              that cite no proof record, 10.83), time and cost per batch and run, findings by their tests
              and proof sign (forged, test bloat, untested, stale proof), 10.55's case, and unit
              counts at 10, 20 and 40 lines;
              over the store, or one cycle with --cycle.

Development settings for the stub stages (slice H1), recorded in the run's configuration and on
its receipt. They are refused unless NEUVE_DEV_STUBS=1 is set:
  --stub-hold <stage>=<seconds>[@before-commit]
                                  hold a stage before it works (to reach the 10-minute limit), or
                                  after it works and before its output is stored
  --stub-turn-limit <n>           lower the agents' turn limits (to reach the final generation)
  --stub-measure                  also record the provider measurements in the run log


--route picks the run's route: anthropic (${Route.OPUS_ROUTE.model}, the key from ${Route.routeCredentialVariable(Route.OPUS_ROUTE)} in
the worker's environment), openai (${Route.SOL_ROUTE.model} on your ChatGPT plan, after neuve auth login openai),
or the name of a Claude subscription account (Opus through its Claude Code sign-in).
Without it, the route is the "review.route" in your Neuve settings, else anthropic. Every route
runs at the "review.effort" in your Neuve settings (low, medium or high), else medium. A kind of
step named in "review.stepEffort" (frame, map, find, verify, assess, lane-review or brief) runs at the
effort given there instead. With the section readings on, Assess and Lane review that
"review.stepEffort" does not name run at the lower of the route's effort and medium; with
"review.sectionReadingsEffort" set to by-risk, the readings' steps run at fixed levels instead,
whatever "review.stepEffort" says.

--leads picks where the preloaded leads come from: bm25 (keyword search) or hybrid (Graph, keyword
search and E0 fused, then reranked, computed after each commit while search.hybrid.prepare is on in
your Neuve settings; a hunk whose hybrid leads are not ready gets keyword leads, and says so).
Without it, the "search.leads" in your Neuve settings, else bm25. The choice is in the run's manifest.`;

const StubHold = z
  .string()
  .regex(
    /^[a-z]+=\d+(@(start|before-commit))?$/,
    "Expected <stage>=<seconds>[@start|@before-commit]",
  )
  .transform((text) => {
    const [hold, at] = text.split("@");
    const [stage, seconds] = (hold ?? "").split("=");
    return {
      stage: Budget.Stage.parse(stage),
      seconds: Number(seconds),
      ...(at === undefined ? {} : { at: at as "start" | "before-commit" }),
    };
  });

const FOLLOW_TYPES = new Set([
  "run.started",
  "progress",
  "stage",
  "turn.stored",
  "gap",
  "stage.captured",
  "run.attempt-failed",
  "run.failed",
  "run.completed",
  "run.abandoned",
  "records",
  "precompute.manifest",
  "precompute.scope",
  "range.leads",
  "publish",
]);

const describeRecord = (record: RunLog.RunLogRecord) => {
  switch (record.type) {
    case "run.started":
      return `attempt ${String(record["attempt"])} started${record["resumed"] === true ? " (resuming stored work)" : ""}`;
    case "progress":
      return String(record["message"]);
    case "turn.stored":
      return `${String(record["agent"])}: turn ${String(record["turn"])} stored`;
    case "stage":
      return `${String(record["agent"] ?? record["stage"])}: ${String(record["status"])} in ${String(record["wallMs"])} ms${record["note"] === undefined ? "" : ` (${String(record["note"])})`}`;
    case "gap":
      return `gap: ${String(record["agent"] ?? record["stage"])}: ${String(record["kind"])}`;
    case "stage.captured":
      return `${String(record["agent"])}: turns masked into ${(record["captures"] as ReadonlyArray<unknown>).length} capture(s); working copy deleted`;
    case "run.attempt-failed":
      return `attempt ${String(record["attempt"])} failed${record["final"] === true ? " (final)" : "; the queue retries it"}: ${String(record["error"])}`;
    case "run.failed":
      return `run failed; run folder ${record["runFolderRemoved"] === true ? "deleted" : "already gone"}`;
    case "run.completed":
      return `run ${String(record["outcome"])}; run folder ${record["runFolderRemoved"] === true ? "deleted" : "already gone"}`;
    case "run.abandoned":
      return `run abandoned: ${String(record["reason"])}`;
    case "records":
      return `Records: ${String(record["kind"])} ${String(record["status"])}`;
    case "precompute.manifest":
      return `precompute: range manifest ${String(record["status"])}, ${String(record["hunks"])} hunk(s), ${String(record["reviewLines"])} review lines`;
    case "range.leads": {
      const counts = record["counts"] as
        { cached?: number; searched?: number } | undefined;
      return counts === undefined
        ? `leads: ${String(record["status"])}`
        : `leads: ${String(record["status"])}, ${counts.cached ?? 0} reused / ${counts.searched ?? 0} searched`;
    }
    case "publish": {
      const counts = record["counts"] as Record<string, number> | undefined;
      return `publish: packet ${record["complete"] === true ? "complete" : "incomplete"}, ${counts?.["units"] ?? 0} unit(s), ${counts?.["dispositions"] ?? 0} disposition(s), ${counts?.["comments"] ?? 0} comment(s), ${counts?.["gaps"] ?? 0} gap(s)`;
    }
    case "precompute.scope":
      return `precompute: scope snapshot ${String(record["status"])} (fetched ${String(record["fetchedAt"])} in ${String(record["ms"])} ms), strongest stratum ${String(record["strongest"])}`;
    default:
      return record.type;
  }
};

/** The run's receipt from Records, the source of truth (10.32), with lists read from their blob. */
const recordedReceipt = (repository: string, runId: string) =>
  execute(
    withStore(repository, "read", (location) =>
      Effect.gen(function* () {
        const stored = yield* ReviewStats.runReceipt(runId);
        if (Option.isNone(stored)) return undefined;
        const { event } = stored.value;
        if (event.kind !== "run.completed@1") return undefined;
        const blobs = yield* Blobs.BlobStore;
        return yield* Receipt.receiptFromEvent(event, (hash) =>
          Effect.flatMap(blobs.get(hash), (read) =>
            read._tag === "Pruned"
              ? Effect.die(new Error(`receipt lists ${hash} were pruned`))
              : Effect.try(() =>
                  readData(
                    ReceiptLists,
                    JSON.parse(new TextDecoder().decode(read.bytes)),
                  ),
                ),
          ),
        );
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );

/** A run log's record of a successful harness close (handler.ts): the snapshot its export stored. */
const SnapshotRecord = z.object({
  type: z.literal("run.snapshot"),
  mode: z.enum(["held", "interrupted", "ended"]),
  capture: z.string().regex(/^[0-9a-f]{64}$/),
  snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
  complete: z.boolean(),
  gaps: z.array(z.string()),
  execution: z.enum(["ended", "open"]),
  backup: z.string(),
  pendingScan: z.literal(true).optional(),
});

const CLOSES = new Set(["run.snapshot", "run.close-failed"]);

/**
 * The snapshot of a run's latest harness close, from its run log, or why there is none. Per attempt
 * the worker writes run.admitted, then one close record: run.snapshot (held, interrupted or ended)
 * or run.close-failed. The latest close record decides, whatever its mode: a held or interrupted
 * snapshot is filed too, its execution open and said so. It fails closed: a failed or malformed latest
 * close is refused, and an older snapshot never stands in for it. `pending` marks the one answer a
 * later read may change: an attempt admitted after the last close has not closed yet.
 */
export const latestSnapshot = (
  records: ReadonlyArray<RunLog.RunLogRecord>,
  source = "run log",
):
  | { readonly snapshot: z.infer<typeof SnapshotRecord> }
  | { readonly refused: string; readonly pending: boolean } => {
  const closed = records.findLastIndex((record) => CLOSES.has(record.type));
  const admitted = records.findLastIndex(
    (record) => record.type === "run.admitted",
  );
  if (records.length === 0)
    return { refused: "it has no run log", pending: false };
  if (admitted > closed)
    return {
      refused:
        closed === -1
          ? "its attempt has not closed yet"
          : "a newer attempt was admitted after its last close and has not closed yet",
      pending: true,
    };
  if (closed === -1)
    return { refused: "its run log records no harness close", pending: false };
  const record = records[closed]!;
  if (record.type === "run.close-failed") {
    const diagnostic = safeRead(CloseDiagnostic, record["closeDiagnostic"], {
      source,
    });
    const reason = publicCloseReason(record["error"]);
    const detail = diagnostic.success
      ? diagnostic.data.refusal === reason
        ? renderCloseDiagnostic(diagnostic.data)
        : `${reason} | ${renderCloseDiagnostic(diagnostic.data)}`
      : reason;
    return {
      refused: `its latest close failed: ${detail}`,
      pending: false,
    };
  }
  const parsed = SnapshotRecord.safeParse(record);
  if (!parsed.success)
    return {
      refused: `its latest run.snapshot is malformed (${parsed.error.issues
        .slice(0, 2)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")})`,
      pending: false,
    };
  if (parsed.data.snapshotId !== parsed.data.capture)
    return {
      refused:
        "its latest run.snapshot names a snapshot that is not its capture",
      pending: false,
    };
  return { snapshot: parsed.data };
};

/** The capture lane's refusals (DumpRejected, DumpRefused) carry their reason, not a message: said whole. */
const captureFailure = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("reason" in error))
    return error;
  const tagged = error as {
    _tag?: unknown;
    reason: unknown;
    source?: unknown;
    capture?: unknown;
  };
  return new Error(
    `${String(tagged._tag)}: ${String(tagged.reason)} (${String(tagged.source ?? tagged.capture)})`,
  );
};

/** A dataset's retention as this command files it: the caller's root keeps it; Records' 30 days are untouched. */
const DATASET_RETENTION = {
  policy: "neuve-evaluation-dataset: kept by the caller's root",
} as const;

const ceilingFallback = (error: unknown) => {
  process.stderr.write(
    `neuve: capture ceiling fallback: ${publicCloseReason(error)}\n`,
  );
  return MAX_CLOSE_MS;
};

const statusCeiling = (counts: Parameters<typeof closeCeiling>[0]) =>
  Effect.try(() => closeCeiling(counts)).pipe(
    Effect.orElseSucceed(ceilingFallback),
  );

const captureStatus = async (
  repository: string,
  run: string | undefined,
  options: { store?: string | undefined; capture?: string | undefined } = {},
) => {
  const runId = options.capture === undefined ? Ulid.parse(run) : undefined;
  return execute(
    withStore(
      repository,
      "read",
      (location) =>
        Effect.gen(function* () {
          if (options.capture !== undefined) {
            const status = yield* CaptureRecords.scanStatus(options.capture);
            return {
              ...status,
              ceilingMs:
                "counts" in status
                  ? yield* statusCeiling(status.counts)
                  : MAX_CLOSE_MS,
            };
          }
          if (runId === undefined)
            return yield* Effect.fail(
              new Error("capture status needs a run or capture"),
            );
          const found = latestSnapshot(
            RunLog.readRunLog(RunLog.runLogPath(location, runId)),
            RunLog.runLogPath(location, runId),
          );
          if ("refused" in found)
            return {
              status: found.pending ? "closing" : "refused",
              reason: found.refused,
              ceilingMs: yield* Effect.tryPromise(() =>
                recordedCloseCeiling(join(location.directory, "runs", runId)),
              ).pipe(Effect.orElseSucceed(ceilingFallback)),
            };
          const mark = yield* CaptureRecords.scanStatus(found.snapshot.capture);
          return {
            ...mark,
            ceilingMs:
              "counts" in mark
                ? yield* statusCeiling(mark.counts)
                : MAX_CLOSE_MS,
          };
        }).pipe(Effect.provide(Blobs.layer(location))),
      options.store === undefined
        ? undefined
        : storeLocationIn(dirname(resolve(options.store))),
    ),
  );
};

const scanDeadLetter = async (
  repository: string,
  action: string | undefined,
  options: {
    job?: string | undefined;
    all?: boolean | undefined;
    store?: string | undefined;
  },
) => {
  if (action !== "list" && action !== "send-back")
    throw new Error(
      "review dead-letter is list or send-back --job <number>|--all",
    );
  if (
    action === "send-back" &&
    (options.all === true) === (options.job !== undefined)
  )
    throw new Error("send-back needs exactly one of --job <number> or --all");
  return execute(
    withStore(
      repository,
      action === "list" ? "read" : "write",
      (location) =>
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          const sendBack = (seq: number) =>
            Effect.gen(function* () {
              const job = Option.getOrThrow(yield* queue.inspect(seq));
              const event = yield* CaptureRecords.scanEvent(job);
              const manifest = yield* readRawManifest(event.payload.rawCapture);
              const sql = yield* SqlClient;
              return yield* sql.withTransaction(
                Effect.gen(function* () {
                  const state = yield* CaptureRecords.markState(
                    event.payload.rawCapture,
                  );
                  return yield* queue.retryFailedScan(
                    seq,
                    [
                      event.payload.rawCapture,
                      ...manifest.files.map((file) => file.sha256),
                    ],
                    state.conflicted ? state.mark?.id : undefined,
                  );
                }),
              );
            });
          if (options.job !== undefined)
            return [
              yield* sendBack(
                z.coerce.number().int().positive().parse(options.job),
              ),
            ];
          const results = [];
          let after = 0;
          for (;;) {
            const jobs = yield* queue.failedScans(after, 128);
            for (const job of jobs) {
              if (action === "list") results.push(job);
              else {
                const outcome = yield* Effect.result(sendBack(job.seq));
                results.push(
                  outcome._tag === "Success"
                    ? outcome.success
                    : {
                        jobSeq: job.seq,
                        status: "refused",
                        reason: publicCloseReason(outcome.failure),
                      },
                );
              }
              after = job.seq;
            }
            if (jobs.length < 128) break;
          }
          return results;
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(Blobs.layer(location)),
        ),
      options.store === undefined
        ? undefined
        : storeLocationIn(dirname(resolve(options.store))),
    ),
  );
};

const auditCaptures = async (
  repository: string,
  options: {
    capture?: string | undefined;
    run?: string | undefined;
    all?: boolean | undefined;
    repair?: boolean | undefined;
    store?: string | undefined;
  },
) => {
  if (
    [
      options.capture !== undefined,
      options.run !== undefined,
      options.all === true,
    ].filter(Boolean).length !== 1
  )
    throw new Error(
      "review audit needs exactly one of --capture <raw-capture>, --run <run-id>, or --all",
    );
  return execute(
    withStore(
      repository,
      "write",
      (location) =>
        Effect.gen(function* () {
          const identity =
            options.capture === undefined
              ? undefined
              : ((yield* CaptureRecords.rawCaptureFor(options.capture)) ??
                options.capture);
          const results = [];
          let after = 0;
          let legacy = false;
          for (;;) {
            const old = legacy
              ? yield* legacyCaptures(after, options.run)
              : undefined;
            const page =
              old === undefined
                ? yield* CaptureRecords.rawCaptures(after, options.run)
                : old.captures;
            for (const raw of page) {
              if (!legacy) after = raw._tag === "Pruned" ? raw.cursor : raw.seq;
              if (identity !== undefined && raw.rawCapture !== identity)
                continue;
              if (raw._tag === "Invalid") {
                results.push({
                  eventSeq: raw.seq,
                  ...(raw.rawCapture === null
                    ? {}
                    : { rawCapture: raw.rawCapture }),
                  observed: "failed",
                  reason: raw.reason,
                  retryable: false,
                });
                continue;
              }
              if (raw.prunedAt !== null || raw._tag === "Pruned") {
                results.push({
                  rawCapture: raw.rawCapture,
                  observed: "pruned",
                  prunedAt: raw.prunedAt,
                });
                continue;
              }
              const result = yield* Effect.exit(
                auditCapture({
                  location,
                  event: raw.event,
                  command: Starter.currentCliCommand(),
                  repair: options.repair === true,
                }),
              );
              if (result._tag === "Failure") {
                if (Cause.hasInterrupts(result.cause))
                  return yield* Effect.failCause(result.cause);
                const typed = Cause.findErrorOption(result.cause);
                const failure =
                  typed._tag === "Some"
                    ? typed.value
                    : Cause.squash(result.cause);
                results.push({
                  rawCapture: raw.rawCapture,
                  observed:
                    typeof failure === "object" &&
                    failure !== null &&
                    "failureKind" in failure &&
                    failure.failureKind === "pruned"
                      ? "pruned"
                      : "failed",
                  reason: publicCloseReason(failure),
                  retryable:
                    typed._tag === "Some" &&
                    !(
                      typeof failure === "object" &&
                      failure !== null &&
                      "retryable" in failure &&
                      failure.retryable === false
                    ),
                });
              } else results.push(result.value);
            }
            if (old !== undefined) {
              if (!old.more) break;
              after = old.after;
            } else if (page.length < 128) {
              legacy = true;
              after = 0;
            }
          }
          if (identity !== undefined && results.length === 0)
            return yield* Effect.fail(
              new Error("raw capture was not filed in this store"),
            );
          return results;
        }).pipe(Effect.provide(Blobs.layer(location))),
      options.store === undefined
        ? undefined
        : storeLocationIn(dirname(resolve(options.store))),
    ),
  );
};

const exportStoredCapture = async (
  repository: string,
  options: {
    capture?: string | undefined;
    store?: string | undefined;
    root?: string | undefined;
    redaction?: string | undefined;
  },
) => {
  const capture = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(options.capture);
  const root = realpathSync(z.string().parse(options.root));
  const location =
    options.store === undefined
      ? await execute(resolveStoreLocation(repository))
      : storeLocationIn(dirname(resolve(options.store)));
  const store = realpathSync(location.directory);
  if (root === store || root.startsWith(`${store}${sep}`))
    throw new Error("a dataset is filed outside the Records store");
  const redaction = z
    .enum(["restricted", "portable"])
    .parse(options.redaction ?? "restricted");
  const filed = await execute(
    withStore(
      repository,
      "read",
      exportCapturedDump({
        capture,
        root,
        retention: DATASET_RETENTION,
        redaction,
      }).pipe(Effect.provide(Blobs.layer(location))),
      location,
    ),
  );
  await write(JSON.stringify(filed));
  return 0;
};

const exportDump = async (
  repository: string,
  options: {
    readonly run: string | undefined;
    readonly root: string | undefined;
    readonly redaction: string | undefined;
  },
) => {
  const runId = Ulid.safeParse(options.run);
  if (!runId.success)
    throw new PublicReviewError(
      "review export-dump needs --run <run-id>, a run ID",
    );
  if (options.root === undefined)
    throw new PublicReviewError(
      "review export-dump needs --root <dir>: the dataset's folder",
    );
  const redaction = options.redaction ?? "restricted";
  if (redaction !== "restricted" && redaction !== "portable")
    throw new PublicReviewError("--redaction is restricted or portable");
  const requestedRoot = resolve(options.root);
  if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory())
    throw new PublicReviewError("--root must be an existing folder");
  const root = realpathSync(requestedRoot);
  const location = await execute(resolveStoreLocation(repository));
  const store = existsSync(location.directory)
    ? realpathSync(location.directory)
    : location.directory;
  if (root === store || root.startsWith(`${store}${sep}`))
    throw new PublicReviewError(
      "dataset root is inside the store: a dataset is filed outside it",
    );
  const found = latestSnapshot(
    RunLog.readRunLog(RunLog.runLogPath(location, runId.data)),
    RunLog.runLogPath(location, runId.data),
  );
  if ("refused" in found) {
    writeSync(
      2,
      `neuve: run ${runId.data} has no snapshot to file: ${found.refused}\n`,
    );
    if (found.pending) return 3;
    throw new Error(`run ${runId.data}: ${found.refused}`);
  }
  const { capture } = found.snapshot;
  const status = await execute(
    withStore(repository, "read", CaptureRecords.scanStatus(capture)),
  );
  if (status.status === "pending") {
    writeSync(2, "neuve: capture scan is pending\n");
    return 3;
  }
  if (status.status !== "clean")
    throw new Error(
      status.status === "refused" ||
        status.status === "failed" ||
        status.status === "pruned"
        ? publicCloseReason(status.reason)
        : "capture scan has not passed; export refused",
    );
  const filed = await execute(
    withStore(repository, "read", (at) =>
      Effect.gen(function* () {
        // The capture read back whole by its own reader, and checked to be this run's before filing.
        const restored = yield* readCapturedDump(capture);
        if (
          restored.manifest.runId !== runId.data ||
          restored.run.runId !== runId.data
        )
          return yield* Effect.fail(
            new PublicReviewError(
              Ulid.safeParse(restored.run.runId).success
                ? `run ${runId.data}: its run log names capture ${capture}, which is run ${restored.run.runId}'s`
                : "capture belongs to a different run; export refused",
            ),
          );
        return yield* exportCapturedDump({
          capture,
          root,
          retention: DATASET_RETENTION,
          redaction,
        });
      }).pipe(Effect.mapError(captureFailure), Effect.provide(Blobs.layer(at))),
    ),
  );
  if (filed.runId !== runId.data || filed.snapshotId !== status.capture)
    throw new Error(
      `run ${runId.data}: filed ${filed.runId}/${filed.snapshotId}, not ${capture}`,
    );
  // The SnapshotExport as filed, and the close that recorded it: a held or interrupted snapshot's
  // execution is open, and a complete capture is not an ended run.
  const { mode } = found.snapshot;
  const { complete } = filed.run;
  const execution = mode === "ended" ? filed.run.execution : "open";
  const gaps = filed.run.gaps.map((gap) => gap.code);
  await write(
    JSON.stringify({ ...filed, close: { mode, execution, complete, gaps } }),
  );
  return 0;
};

/** One line naming the run's telemetry events in Records. */
const recordedLine = async (repository: string, runId: string) => {
  const counts = await execute(
    withStore(repository, "read", ReviewStats.runRecordCounts(runId)),
  );
  // A run of the new shape publishes a chain of packets; one packet reads as it always has.
  return `records    ${counts.map((c) => `${c.events} ${c.kind}${c.kind.startsWith("packet.published@") && c.events > 1 ? ` (${c.events} publications of one review)` : ""}`).join(", ") || "none yet"}`;
};

/**
 * One run-log record as `review`'s follow mode prints it, through the terminal guard: progress,
 * stage notes, failed attempts and abandon reasons can carry a provider's or a tool's text.
 */
export const followLine = (record: RunLog.RunLogRecord) =>
  terminalGuard([`${String(record.at ?? "")} ${describeRecord(record)}`]);

/** Why a review job waits: the running worker lacks its route's credential (10.17). */
const heldReason = (repository: string, location: StoreLocation, seq: number) =>
  Effect.gen(function* () {
    const claim = yield* withStore(repository, "read", Worker.readClaim).pipe(
      Effect.orElseSucceed(() => Option.none<Worker.WorkerClaim>()),
    );
    const holder = Option.getOrUndefined(claim)?.pid;
    const entry = readHeldReviews(location).find(
      (held) => held.seq === seq && held.pid === holder,
    );
    if (entry === undefined) return Option.none<HeldReview>();
    return Option.some(entry);
  });

export const follow = async (
  repository: string,
  location: StoreLocation,
  seq: number,
  runId: string,
  startupReady?: Extract<Starter.StartResult, { status: "spawned" }>["ready"],
) => {
  let seen = 0;
  let toldHeld = false;
  const path = RunLog.runLogPath(location, runId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let draining = Promise.resolve();
  const drain = () => {
    draining = draining.then(async () => {
      const records = RunLog.readRunLog(path);
      for (const record of records.slice(seen))
        if (FOLLOW_TYPES.has(record.type)) await write(followLine(record));
      seen = records.length;
    });
    return draining;
  };
  const watcher = watch(dirname(path), () => {
    void drain();
  });
  const inspect = () =>
    execute(
      withStore(
        repository,
        "read",
        Effect.provide(
          JobQueue.JobQueue.use((queue) => queue.inspect(seq)),
          JobQueue.layer,
        ),
      ),
    );
  try {
    await drain();
    for (;;) {
      const prior = await inspect();
      if (Option.isNone(prior)) throw new Error(`Job ${seq} is gone.`);
      if (prior.value.state === "completed") {
        await drain();
        const receipt = await recordedReceipt(repository, runId);
        await write(
          receipt === undefined
            ? "Completed; Records holds no receipt for this run."
            : terminalGuard([
                "",
                Receipt.formatReceipt(receipt),
                await recordedLine(repository, runId),
              ]),
        );
        return 0;
      }
      if (prior.value.state === "failed") {
        await drain();
        await write(
          terminalGuard([
            `Job ${seq} failed: ${prior.value.lastError?.tag ?? "?"}: ${prior.value.lastError?.message ?? ""}`,
          ]),
        );
        return 1;
      }
      const ready = startupReady;
      startupReady = undefined;
      await Effect.runPromise(
        ready ??
          Starter.ensureWorker({
            repository,
            command: Starter.currentCliCommand(),
            waitForReady: true,
          }),
      );
      let subscription:
        Awaited<ReturnType<typeof Worker.subscribeJob>> | undefined;
      try {
        subscription = await Worker.subscribeJob(location, seq);
        // Registration preceded this read, so a commit cannot be missed.
        const current = await inspect();
        if (
          Option.isNone(current) ||
          current.value.state === "completed" ||
          current.value.state === "failed"
        )
          continue;
        for (;;) {
          const event = await subscription.next();
          if (event !== "held") break;
          if (!toldHeld) {
            const held = await execute(heldReason(repository, location, seq));
            if (Option.isSome(held)) {
              toldHeld = true;
              await write(
                heldForAccount(held.value)
                  ? `Waiting: the running worker (pid ${held.value.pid}) holds this job for ${held.value.route}. ${held.value.credential}.`
                  : `Waiting: the running worker (pid ${held.value.pid}) lacks ${held.value.credential} for ${held.value.route}, so it holds this job; a worker that has it picks it up.`,
              );
            }
          }
        }
      } catch (error) {
        if (!(error instanceof Worker.WorkerSubscriptionLost)) throw error;
        // The next turn reads state before ensuring a worker or subscribing again.
      } finally {
        subscription?.close();
      }
    }
  } finally {
    watcher.close();
    await draining;
  }
};

export type RangeReviewOptions = {
  readonly requester?: Request.Requester | undefined;
  readonly requestId?: string | undefined;
  readonly frozenConfig?: Config.PipelineConfig | undefined;
  readonly scopeSource?: CycleScopeSource | undefined;
  readonly origin?: ReviewOrigin | undefined;
  readonly externalSources?: readonly ExternalReviewSource[] | undefined;
  readonly route?: string | undefined;
  readonly leads?: string | undefined;
  readonly "stub-hold"?: string | undefined;
  readonly "stub-turn-limit"?: string | undefined;
  readonly "stub-measure"?: boolean | undefined;
};

/** Queues the actual range and wakes its worker when its configured credential is available. */
export const requestRangeReview = async (
  repository: string,
  rangeText: string,
  values: RangeReviewOptions = {},
) => {
  const wantsStubs =
    values["stub-hold"] !== undefined ||
    values["stub-turn-limit"] !== undefined ||
    values["stub-measure"] === true;
  if (wantsStubs && process.env["NEUVE_DEV_STUBS"] !== "1")
    throw new Error(
      "The --stub-* settings are for developing the harness; set NEUVE_DEV_STUBS=1 to use them.",
    );
  const stub: Config.StubSettings = Config.StubSettings.parse({
    ...(values["stub-hold"] === undefined
      ? {}
      : { hold: StubHold.parse(values["stub-hold"]) }),
    ...(values["stub-turn-limit"] === undefined
      ? {}
      : { turnLimit: Number(values["stub-turn-limit"]) }),
    ...(values["stub-measure"] === true ? { measure: true } : {}),
  });
  const runtimeOptions = workerRuntimeOptions();
  const runtime = ManagedRuntime.make(
    harnessRuntimes(runtimeOptions).pipe(
      Layer.provideMerge(runtimeOptions.accountDirectory),
    ),
  );
  try {
    const { directory, registry } = await runtime.runPromise(
      Effect.gen(function* () {
        return {
          directory: yield* AccountDirectory,
          registry: yield* RuntimeRegistry,
        };
      }),
    );
    const route = values.frozenConfig
      ? values.frozenConfig.route
      : values.route === undefined
        ? Request.settingsRoute()
        : await execute(Request.resolveNamedRoute(values.route, directory));
    // --leads: keyword leads (the default while the lanes climb runs) or hybrid leads (10.119).
    const leadsChoice = z.enum(["bm25", "hybrid"]).safeParse(values.leads);
    if (values.leads !== undefined && !leadsChoice.success)
      throw new Error(
        `--leads takes bm25 or hybrid, not ${JSON.stringify(values.leads)}`,
      );
    const leads = leadsChoice.success ? leadsChoice.data : undefined;
    const location = await execute(resolveStoreLocation(repository));
    const admitted = await execute(
      withStore(repository, "create", (store) =>
        Effect.gen(function* () {
          const request = yield* Request.requestReview({
            runtimes: registry,
            location: store,
            repository,
            range: rangeText,
            ...(values.requestId ? { requestId: values.requestId } : {}),
            ...(values.frozenConfig
              ? { frozenConfig: values.frozenConfig }
              : {}),
            ...(values.scopeSource ? { scopeSource: values.scopeSource } : {}),
            ...(values.origin ? { origin: values.origin } : {}),
            ...(values.externalSources
              ? { externalSources: values.externalSources }
              : {}),
            requester:
              values.requester ??
              (yield* Request.resolveRequester(store, repository)),
            stub,
            route,
            ...(leads === undefined ? {} : { leads }),
          });
          const queue = yield* JobQueue.JobQueue;
          const jobs = yield* queue.list({
            states: ["waiting", "delayed", "active", "completed", "failed"],
            limit: 10_000,
          });
          const job = jobs.find(
            (candidate) => candidate.dedupeKey === request.dedupeKey,
          );
          if (job === undefined) {
            // A newer build queued this range's review under its own job kind (8.19).
            const newer = yield* JobQueue.newerJob({
              dedupeKey: request.dedupeKey,
            });
            if (Option.isNone(newer))
              return yield* Effect.die(
                new Error(`no job with key ${request.dedupeKey}`),
              );
            return { request, job: newer.value, newer: true as const };
          }
          // Hybrid leads still being prepared for the range's commits (a measured review waits for 0).
          // The request is already recorded: a count that cannot be read never fails it.
          const hybrid =
            Config.precomputeSettings(request.config).retriever.id === "hybrid"
              ? yield* Effect.result(
                  HarnessCommitHybrid.pendingHybrid(repository, request.range),
                )
              : undefined;
          return { request, job, hybrid, newer: false as const };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              JobQueue.layer,
              Computations.layer.pipe(Layer.provideMerge(Blobs.layer(store))),
            ),
          ),
        ),
      ),
    );
    if (admitted.newer) return { ...admitted, location, route };
    const { request } = admitted;
    const { job, hybrid } = admitted;
    const runId = job.eventId ?? "?";
    const started =
      job.state === "completed" || job.state === "failed"
        ? undefined
        : route.provider === "claude" || RouteProvider.credentialPresent(route)
          ? await Effect.runPromise(
              Effect.result(
                Starter.ensureWorker({
                  repository,
                  command: Starter.currentCliCommand(),
                  deferReady: true,
                }),
              ),
            )
          : undefined;
    return {
      request,
      job,
      hybrid,
      location,
      route,
      runId,
      started,
      newer: false as const,
    };
  } finally {
    await runtime.dispose();
  }
};

const runRequest = async (
  repository: string,
  rangeText: string,
  values: RangeReviewOptions & {
    readonly detach?: boolean | undefined;
    readonly repo?: string | undefined;
  },
) => {
  // Setup first: nothing is created until `neuve setup` has run in the repository.
  const root = await requireRepositorySetup(repository);
  if (root === undefined) return 1;
  const admitted = await requestRangeReview(repository, rangeText, values);
  const { request } = admitted;
  const deskLink = async () =>
    write(
      await deskLinkLine(
        admitted.location,
        request.cycleId,
        values.repo === undefined ? undefined : root,
      ),
    );
  if (admitted.newer) {
    const { seq, kind, state } = admitted.job;
    const opening = `Review of ${request.range.baseRef} ${request.range.baseOid.slice(0, 12)}..${request.range.headOid.slice(0, 12)}: ${request.openedCycle ? "opened" : "joined"} cycle ${request.cycleId}; job ${seq} ${kind} (${state}) is a newer build's`;
    // The generation counts every ended run of the key, of any job kind, so a request joins a
    // newer build's job only while it is queued or running, or once it completed the review.
    if (state === "completed") {
      await write(
        `${opening}, which already reviewed this range and configuration; nothing is recomputed, and that build shows its receipt.`,
      );
      await deskLink();
      return 0;
    }
    if (state === "failed") {
      // Only when it failed after this request joined it.
      await write(
        `${opening} and failed after this request joined it; request the review again to start the next generation.`,
      );
      await deskLink();
      return 1;
    }
    await write(
      `${opening}, and that build's worker runs it; this build leaves it to it.`,
    );
    await deskLink();
    return 0;
  }
  const { job, hybrid, location, route, runId, started } = admitted;
  await write(
    `Review of ${request.range.baseRef} ${request.range.baseOid.slice(0, 12)}..${request.range.headOid.slice(0, 12)}: ${request.openedCycle ? "opened" : "joined"} cycle ${request.cycleId}; job ${job.seq} review.run (${job.state}), run ${runId}, generation ${request.generation}.`,
  );
  if (hybrid !== undefined)
    await write(
      hybrid._tag === "Failure"
        ? `Hybrid leads: could not read the range's pending hybrid preparation (${String((hybrid.failure as { message?: unknown }).message ?? hybrid.failure).slice(0, 200)}).`
        : hybrid.success.pending === 0
          ? `Hybrid leads: none of the range's ${hybrid.success.commits} commit(s) has hybrid preparation queued or running.`
          : `Hybrid leads: ${hybrid.success.pending} of the range's ${hybrid.success.commits} commit(s) still have hybrid preparation queued or running; their hunks may get keyword leads, disclosed.`,
    );
  if (request.complete !== undefined && job.state === "completed") {
    const receipt = await recordedReceipt(repository, runId);
    await write(
      `This range and configuration were already reviewed; nothing is recomputed.${receipt === undefined ? "" : `\n\n${Receipt.formatReceipt(receipt)}`}`,
    );
    await deskLink();
    return 0;
  }
  if (job.state === "failed") {
    await deskLink();
    return follow(repository, location, job.seq, runId);
  }
  if (started !== undefined) {
    await write(
      started._tag === "Failure"
        ? started.failure._tag === "OlderWorkerHeld"
          ? started.failure.message
          : "Queued without waking a worker; it runs at the next worker start or sweep."
        : started.success.status === "running"
          ? "Signalled the running worker."
          : `Spawned a worker (pid ${started.success.pid ?? "?"}, log ${started.success.log}).`,
    );
  } else
    await write(
      route.provider === "openai"
        ? `The OpenAI route is not available here (${RouteProvider.OpenAiAuth.signInProblem() ?? "the sign-in could not be read"}); the job waits for a worker that has it (neuve worker start from such a shell).`
        : `${Route.credentialName(route)} is not available here; the job waits for a worker that has it (neuve worker start from such a shell).`,
    );
  await deskLink();
  if (values.detach === true) return 0;
  return follow(
    repository,
    location,
    job.seq,
    runId,
    started?._tag === "Success" && started.success.status === "spawned"
      ? started.success.ready
      : undefined,
  );
};

const thousands = (value: number) => value.toLocaleString("en-US");

/** The range manifest and the cycle's scope snapshot of a run, from the computation store. */
const precomputed = (repository: string, runId: string, at?: StoreLocation) => {
  // The manifest's key names the parser; look it up with the same parser the worker used.
  return execute(
    withStore(
      repository,
      "read",
      (location) =>
        Effect.gen(function* () {
          const stored = yield* Log.get(runId);
          const event = Option.getOrUndefined(stored)?.event;
          if (event?.kind !== "review.requested@1") return undefined;
          const config = safeRead(
            Config.PipelineConfig,
            event.payload.pipeline.config,
          );
          if (!config.success) return undefined;
          const source = captureOutlineSource();
          const settings = Config.precomputeSettings(config.data);
          const { range, cycleId } = event.attribution;
          const merge = yield* Effect.orElseSucceed(
            Git.git(repository, ["merge-base", range.baseOid, range.headOid]),
            () => "",
          );
          const spec = Manifest.manifestSpec(
            range,
            merge.trim(),
            settings,
            source,
          );
          const legacySpec = Manifest.legacyManifestSpec(
            range,
            merge.trim(),
            settings,
            source,
          );
          const log = RunLog.readRunLog(RunLog.runLogPath(location, runId));
          const leadsRecord = log
            .filter((record) => record.type === "range.leads")
            .at(-1);
          const recordedKey =
            log
              .filter((record) => record.type === "precompute.manifest")
              .at(-1)?.["key"] ?? leadsRecord?.["manifest"];
          const keys = [
            ...(typeof recordedKey === "string" ? [recordedKey] : []),
            ...[spec, { ...spec, opVersion: 2 }, legacySpec].map(
              (spec) => Computations.computationKey(spec).key,
            ),
          ];
          const store = yield* Computations.ComputationStore;
          const blobs = yield* Blobs.BlobStore;
          const readStored = (key: string) =>
            Effect.gen(function* () {
              const held = yield* store.lookup(key);
              if (Option.isNone(held)) return undefined;
              const read = yield* blobs.get(held.value.outputHash);
              return read._tag === "Pruned"
                ? undefined
                : { bytes: read.bytes, opVersion: held.value.opVersion };
            });
          const readOutput = <T>(key: string, schema: z.ZodType<T>) =>
            Effect.map(readStored(key), (stored) =>
              stored === undefined
                ? undefined
                : SearchIndex.decodeJson(stored.bytes, schema),
            );
          let key = Computations.computationKey(spec).key;
          let storedManifest:
            Manifest.RangeManifest | Manifest.LegacyRangeManifest | undefined;
          for (const candidate of new Set(keys)) {
            const stored = yield* readStored(candidate);
            if (stored === undefined) continue;
            // Version 1 owns inline leads; select its reader before additive compatibility.
            storedManifest =
              stored.opVersion === 1
                ? SearchIndex.decodeJson(
                    stored.bytes,
                    Manifest.LegacyRangeManifest,
                  )
                : SearchIndex.decodeJson(stored.bytes, Manifest.RangeManifest);
            key = candidate;
            break;
          }
          // A run from before the split holds its leads inside its manifest.
          const split =
            storedManifest !== undefined && "leads" in storedManifest
              ? Manifest.splitLegacyManifest(key, storedManifest)
              : undefined;
          const manifest =
            storedManifest === undefined || "leads" in storedManifest
              ? split?.manifest
              : storedManifest;
          // Leads are keyed by the manifest this run used, even if a newer version exists.
          const recordedLeadsKey = leadsRecord?.["key"];
          const leadsSpec = Manifest.rangeLeadsSpec(
            key,
            Manifest.leadSettings(settings),
            source,
          );
          let leads = split?.leads;
          if (split === undefined && storedManifest !== undefined) {
            if (
              typeof recordedLeadsKey === "string" &&
              leadsRecord?.["manifest"] === key
            )
              leads = yield* readOutput(recordedLeadsKey, Manifest.RangeLeads);
            leads ??= yield* readOutput(
              Computations.computationKey(leadsSpec).key,
              Manifest.RangeLeads,
            );
          }
          // How the run's leads task ended, from its last `range.leads` record, while the run log
          // is there: a run whose leads are not stored either still runs them or ended without.
          const ended = leadsRecord?.["status"];
          const leadsEnd = typeof ended === "string" ? ended : undefined;
          const scope = yield* Scope.storedSnapshot(cycleId);
          // The masked raw captures of fetched items (10.8): what a capture keeps, never the
          // unmasked text agents read.
          const captures = new Map<string, string>();
          for (const source of Option.isSome(scope) ? scope.value.sources : [])
            if (source.capture !== null) {
              const read = yield* blobs.get(source.capture.blob);
              captures.set(
                source.id,
                read._tag === "Present"
                  ? new TextDecoder().decode(read.bytes)
                  : "(pruned after 30 days)",
              );
            }
          return {
            manifest,
            leads,
            storedManifest,
            retriever: settings.retriever.id,
            leadsEnd: split === undefined ? leadsEnd : undefined,
            scope: Option.getOrUndefined(scope),
            captures,
            key,
          };
        }).pipe(
          Effect.provide(
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
      at,
    ),
  );
};

/** The manifest as `neuve review show` prints it. */
/** Why a run's leads are not stored, from how its leads task ended (`range.leads`), if it did. */
const unstoredLeads = (ended: string | undefined, retriever: string) =>
  ended === "failed"
    ? `  leads: not stored; their search failed (retriever ${retriever}). A later review searches again`
    : ended === "cutoff"
      ? `  leads: not stored; the review's cut-off came first (retriever ${retriever}). A later review searches again`
      : ended === "stopped"
        ? `  leads: not stored; the review was stopped first (retriever ${retriever}). A later review searches again`
        : ended === undefined
          ? `  leads: not stored yet (retriever ${retriever}); they are computed beside the review`
          : `  leads: not stored (retriever ${retriever}); the run log says they ended ${ended}`;

const manifestLines = (
  manifest: Manifest.RangeManifest,
  key: string,
  ranked: Manifest.RangeLeads | undefined,
  retriever: string,
  ended?: string,
) => {
  const { settings } = manifest;
  const byHunk =
    ranked === undefined ? undefined : Manifest.leadsByHunk(ranked);
  const counts = ranked?.counts;
  const index = ranked?.index ?? null;
  const lines = [
    `range manifest (computation ${key.slice(0, 12)}), merge base ${manifest.range.mergeBase.slice(0, 12)}, base tree ${manifest.range.baseTree.slice(0, 12)}`,
    `  ${manifest.files} file(s), ${manifest.hunks.length} hunk(s), ${thousands(manifest.reviewLines)} review lines; allowance = max(${thousands(settings.allowanceFloor)}, floor(${thousands(settings.window)} x ${settings.allowanceShare} x hunk lines / ${thousands(manifest.reviewLines)}))`,
    counts === undefined
      ? unstoredLeads(ended, retriever)
      : `  leads: ${counts.cached} hunk(s) reused from commit preparation, ${counts.searched} searched for the review, ${counts.stale} stale result(s); retriever ${retriever}${counts.fallback === undefined ? "" : `, ${counts.fallback} hunk(s) without hybrid leads ready, given keyword leads`}${index === null ? "" : `; base index ${index.tree.slice(0, 12)}: ${thousands(index.chunks)} chunks, left out ${JSON.stringify(index.excluded)} (${index.bounds})`}`,
    `  declarations read: ${manifest.declarations.readers.join(", ")}`,
    ...manifest.declarations.gaps.map((gap) => `  declaration gap: ${gap}`),
    ...manifest.limitations.map((limitation) => `  limitation: ${limitation}`),
    "",
    "  HUNK              LINES      ALLOWANCE              DECLARED     OWNED RANGES (side start+count)  WHERE",
  ];
  for (const hunk of manifest.hunks) {
    const header =
      hunk.kind === "text"
        ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`
        : hunk.kind;
    const allowance = `${thousands(hunk.allowance.tokens)}${hunk.allowance.floored ? ` (floor; ${thousands(Math.round(hunk.allowance.exactShare))})` : ""}${hunk.countsTowardReviewLines ? "" : " (not counted)"}`;
    const declared =
      hunk.declared.length === 0
        ? "undeclared"
        : [...new Set(hunk.declared.map((entry) => entry.kind))].join(",");
    const owned =
      hunk.ownedRanges.length === 0
        ? hunk.qualifications.map((entry) => entry.kind).join(",") || "-"
        : hunk.ownedRanges
            .map(
              (range) => `${range.side} ${range.startLine}+${range.lineCount}`,
            )
            .join(", ");
    const enclosing =
      hunk.enclosing === null
        ? ""
        : hunk.enclosing.symbols.length > 0
          ? ` in ${hunk.enclosing.symbols.slice(0, 3).join(", ")}`
          : hunk.enclosing.headingPath.length > 0
            ? ` under "${hunk.enclosing.headingPath.at(-1)}"`
            : "";
    const leads = byHunk?.get(hunk.hunkId) ?? undefined;
    const lead = leads?.results[0];
    lines.push(
      `  ${hunk.hunkId.padEnd(17)} ${`+${hunk.added} -${hunk.deleted}`.padEnd(10)} ${allowance.padEnd(22)} ${declared.padEnd(12)} ${owned.padEnd(32)} ${hunk.path} ${header}${enclosing}${lead === undefined ? "" : `; lead ${lead.identity.path}:${lead.identity.startLine}-${lead.identity.endLine} (${leads?.source})`}`,
    );
  }
  lines.push("", "  change facts (citable, never a score)");
  for (const fact of manifest.facts.filter(
    (entry) => entry.about.kind !== "hunk",
  ))
    lines.push(`    ${fact.id}: ${fact.statement}`);
  return lines;
};

/**
 * The guard on what `review show`, `review recompose` and `review`'s follow mode write to the
 * terminal as text: every line, one at a time, goes through `terminalSafe`, which removes terminal
 * escape sequences, control characters other than tab, and bidirectional overrides, and keeps
 * every other character, so text without them prints byte for byte as before. Line by line, so a
 * sequence left open in one line can never reach the next. It stops stored text (a model's, a
 * provider's, a tool's or a repository's) from driving the terminal anywhere in the output. It does
 * not stop a line break in stored text from starting a line: only the packet section prevents that
 * (`PacketView`); the receipt, run log, stage, manifest, scope and capture sections do not yet.
 * `--json` is not guarded: JSON escapes every control character itself.
 */
export const terminalGuard = (lines: ReadonlyArray<string>) =>
  lines.join("\n").split("\n").map(PacketView.terminalSafe).join("\n");

const show = async (
  repository: string,
  rangeText: string | undefined,
  runFlag: string | undefined,
  json: boolean,
) => {
  // First, as always: a folder outside git is refused with the store's own sentence.
  const location = await execute(resolveStoreLocation(repository));
  let runId = runFlag;
  if (runId === undefined) {
    const wanted =
      rangeText === undefined
        ? undefined
        : await execute(
            Effect.gen(function* () {
              const { base, head } = Request.parseRange(rangeText);
              return {
                baseOid: yield* Git.resolveCommit(repository, base),
                headOid: yield* Git.resolveCommit(repository, head),
              };
            }),
          );
    // A run's ID is its review request's event ID.
    runId = Option.getOrUndefined(
      await execute(
        withStore(repository, "read", ReviewStats.latestRun(wanted)),
      ),
    );
  }
  if (runId === undefined) {
    await write("No run found.");
    return 1;
  }
  const output = await showOutput(repository, runId, json, location);
  await write("json" in output ? output.json : terminalGuard(output.lines));
  return 0;
};

/**
 * What `review show` prints for a run: its JSON, or its text lines before the terminal guard. A
 * function of its own, so a test can compare the lines with what the guard lets through; `show`
 * passes the store location it resolved before looking the run up.
 */
export const showOutput = async (
  repository: string,
  runId: string,
  json: boolean,
  resolved?: StoreLocation,
): Promise<
  { readonly json: string } | { readonly lines: ReadonlyArray<string> }
> => {
  const location =
    resolved ?? (await execute(resolveStoreLocation(repository)));
  const receipt = await recordedReceipt(repository, runId);
  const stored = await precomputed(repository, runId);
  // Understand's change map, the partition plan and Investigate's ledgers (H6), from Records.
  const outputs = await execute(
    withStore(repository, "read", (store) =>
      StageView.runStageOutputs(runId).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(store))),
        ),
      ),
    ),
  );
  // The published packet (H8), as Records' read model reads it (M5 RD1): batches, units, lanes,
  // Guided rows, reviews, comments, dispositions, closure, resolved citations and the run's gaps.
  // Either shape: the cycle's packet of record, the run's own being its newest publication.
  const packet = await execute(
    withStore(repository, "read", (store) =>
      PublishedPackets.readRun(runId, { repository }).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(store))),
        ),
      ),
    ),
  );
  const packetLines = [
    "",
    ...(packet === undefined
      ? ["No packet is published for this run yet."]
      : PacketView.describePacket(packet)),
  ];
  const stageLines = ["", ...StageView.stageOutputLines(outputs)];
  const precomputeLines = [
    "",
    ...(stored?.manifest === undefined
      ? ["No range manifest is stored for this run yet."]
      : manifestLines(
          stored.manifest,
          stored.key,
          stored.leads,
          stored.retriever,
          stored.leadsEnd,
        )),
    "",
    ...(stored?.scope === undefined
      ? ["No scope snapshot is stored for this run's cycle yet."]
      : Scope.describeSnapshot(stored.scope)),
    ...[...(stored?.captures ?? new Map<string, string>())].flatMap(
      ([id, text]) => [
        "",
        `  masked capture of ${id} (raw capture, 30 days):`,
        ...text.split("\n").map((line) => `    | ${line}`),
      ],
    ),
  ];
  if (json)
    return {
      json: JSON.stringify(
        {
          ...(receipt ?? { runId, receipt: null }),
          packet: packet ?? null,
          // The manifest as stored (an older run's holds each hunk's leads inline), and the
          // range's leads from their own computation: null until stored.
          manifest: stored?.storedManifest ?? null,
          leads: stored?.leads ?? null,
          scope: stored?.scope ?? null,
          stageOutputs: outputs.lines,
          captures: Object.fromEntries(stored?.captures ?? []),
        },
        null,
        2,
      ),
    };
  if (receipt === undefined) {
    const records = RunLog.readRunLog(RunLog.runLogPath(location, runId));
    return {
      lines: [
        `Run ${runId} has no receipt in Records yet. Its run log so far:`,
        ...records
          .filter((r) => FOLLOW_TYPES.has(r.type))
          .map((r) => `  ${String(r.at ?? "")} ${describeRecord(r)}`),
        ...packetLines,
        ...stageLines,
        ...precomputeLines,
      ],
    };
  }
  const cycleStats = await cycleReviewStats(repository, receipt.cycleId);
  return {
    lines: [
      Receipt.formatReceipt(receipt),
      await recordedLine(repository, runId),
      "",
      `day-one counts for cycle ${receipt.cycleId} (from Records' projections)`,
      ...dayOneLines(cycleStats),
      ...packetLines,
      ...stageLines,
      ...precomputeLines,
    ],
  };
};

/**
 * A cycle's metrics through its packet of record (H8): unit-level counts take only the units the
 * cycle's standing packet names, so a superseded packet's units are never counted twice.
 */
const cycleReviewStats = (repository: string, cycleId: string) =>
  execute(
    withStore(repository, "read", (store) =>
      Effect.gen(function* () {
        const units = yield* PublishedPackets.standingUnits(cycleId);
        return yield* ReviewStats.reviewStats({ cycleId, units });
      }).pipe(Effect.provide(Blobs.layer(store))),
    ),
  );

/** Null is a route with no per-token price (the ChatGPT plan, 10.85). */
const usdOf = (microUsd: number | null) =>
  microUsd === null ? "USD unknown" : `$${(microUsd / 1_000_000).toFixed(4)}`;
const secondsOf = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const short = (id: string | null) => (id === null ? "-" : id.slice(0, 12));

/** The product metrics as `neuve review stats` prints them. */
const formatStats = (stats: ReviewStats.ReviewStats) => {
  const lines = ["lanes (units per batch)"];
  if (stats.lanes.length === 0) lines.push("  none assessed");
  for (const row of stats.lanes)
    lines.push(
      `  batch ${short(row.batchId)}  ${row.lane.padEnd(18)} ${row.units}`,
    );
  lines.push("", "gaps disclosed (by kind and stage)");
  if (stats.gaps.length === 0) lines.push("  none");
  for (const row of stats.gaps)
    lines.push(
      `  ${row.kind.padEnd(28)} ${(row.stage ?? "run").padEnd(12)} ${row.gaps}`,
    );
  lines.push("", "agent dispositions (by verdict and lane)");
  if (stats.agentDispositions.length === 0) lines.push("  none");
  for (const row of stats.agentDispositions)
    lines.push(
      `  ${row.verdict.padEnd(16)} ${(row.lane ?? "unassessed").padEnd(18)} ${row.dispositions}${row.verdict === "request-changes" ? `  uncited ${row.uncited}` : `  without recorded proof ${row.withoutProof}`}${row.version1 > 0 ? `  (${row.version1} version 1, which cannot cite)` : ""}`,
    );
  lines.push("", "time and cost per batch (stage records)");
  if (stats.batchCosts.length === 0) lines.push("  none");
  for (const row of stats.batchCosts)
    lines.push(
      `  ${row.batchId === null ? "run-level (no batch)" : `batch ${short(row.batchId)}`}  ${row.stages} stage(s), ${secondsOf(row.wallMs)}, ${row.modelCalls} call(s), ${usdOf(row.costMicroUsd)}`,
    );
  lines.push("", "runs (newest first, from their receipts)");
  if (stats.runs.length === 0) lines.push("  none");
  for (const run of stats.runs)
    lines.push(
      `  ${run.runId}  ${run.outcome.padEnd(9)} ${secondsOf(run.wallMs)} wall, queue ${secondsOf(run.queueWaitMs)}, ${run.modelCalls} call(s), ${usdOf(run.costMicroUsd)}, ${run.stageCount} stage(s), ${run.gapCount} gap(s); units at 10/20/40 lines ${run.unitCount20 === null ? "not measured" : `${run.unitCount10}/${run.unitCount20}/${run.unitCount40}`}`,
    );
  lines.push(
    "",
    "findings",
    ...stats.findings.map(
      (f) =>
        `  ${f.kind.padEnd(14)} about ${f.about.padEnd(6)} ${(f.signal ?? "-").padEnd(12)} ${f.comments}`,
    ),
    "",
    ...dayOneLines(stats),
  );
  return lines.join("\n");
};

/** The day-one counts that are facts of events (10.55, 10.62, 10.63, 10.70), one definition each. */
const dayOneLines = (stats: ReviewStats.ReviewStats) => {
  const withoutProof = stats.agentDispositions
    .filter((row) => row.verdict === "approve" && row.withoutProof > 0)
    .map((row) => `${row.lane ?? "unassessed"} ${row.withoutProof}`);
  const uncited = stats.agentDispositions
    .filter((row) => row.verdict === "request-changes" && row.uncited > 0)
    .map((row) => `${row.lane ?? "unassessed"} ${row.uncited}`);
  return [
    `  agent approvals citing no proof record (10.83, by lane): ${withoutProof.join(", ") || "none"}`,
    `  uncited agent requests for changes: ${uncited.join(", ") || "none"}`,
    `  forged or bogus evidence (10.63): ${stats.signals.forged}; test bloat: ${stats.signals.testBloat}; untested behaviour: ${stats.signals.untested}; stale proof (11.10): ${stats.signals.staleProof}`,
    `  10.55, high complexity with a validation gap in human-suggested: ${stats.highComplexityValidationGapHumanSuggested} unit(s)`,
    `  grouping (10.70): ${stats.grouping.byGapLines.map((g) => `${g.units} unit(s) at a ${g.gapLines}-line gap`).join(", ") || "no unit records its grouping yet"}; merges ${stats.grouping.merges}, splits ${stats.grouping.splits}`,
  ];
};

const showStats = async (
  repository: string,
  cycleFlag: string | undefined,
  json: boolean,
) => {
  const cycleId = cycleFlag === undefined ? undefined : Ulid.parse(cycleFlag);
  const stats =
    cycleId === undefined
      ? await execute(
          withStore(repository, "read", (store) =>
            Effect.gen(function* () {
              // Store-wide, too, only every cycle's packet of record counts (H8).
              const units = yield* PublishedPackets.recordUnits();
              return yield* ReviewStats.reviewStats({ units });
            }).pipe(Effect.provide(Blobs.layer(store))),
          ),
        )
      : await cycleReviewStats(repository, cycleId);
  await write(json ? JSON.stringify(stats, null, 2) : formatStats(stats));
  return 0;
};

/** Logs to stderr, so a recompose's stdout is only its report; its messages through the guard. */
const stderrLogger = Logger.make((options) => {
  writeSync(
    2,
    `${terminalGuard([`${options.date.toISOString()} ${options.logLevel.toUpperCase().padEnd(7)} ${String(options.message)}`])}\n`,
  );
});

const recomposeRun = async (
  repository: string,
  options: {
    readonly run: string | undefined;
    readonly store: string | undefined;
    readonly allowModel: string | undefined;
    readonly json: boolean;
  },
) => {
  if (options.run === undefined)
    throw new Error("neuve review recompose needs --run <run-id>");
  const steps = (options.allowModel ?? "").split(",").filter(Boolean);
  const unknown = steps.filter((step) => !(step in Recompose.RECOMPOSE_STEPS));
  if (unknown.length > 0)
    throw new Error(
      `--allow-model takes ${Object.keys(Recompose.RECOMPOSE_STEPS).join(" and ")}, not ${unknown.join(", ")}`,
    );
  // Always a named scratch copy: a recompose never falls back to the repository's own store.
  if (options.store === undefined)
    throw new Error(
      "neuve review recompose needs --store <dir>: the folder that holds a scratch copy's neuve/",
    );
  const at = storeLocationIn(resolve(options.store));
  if (!existsSync(at.directory))
    throw new Error(`${at.directory} holds no store`);
  if (Recompose.inGitDirectory(at.directory))
    throw new Error(
      `${at.directory} is in a git directory, so it is a repository's own store; a recompose runs only on a scratch copy outside one`,
    );
  // The model only with a lease of its own: never the owner's sign-in.
  if (
    steps.length > 0 &&
    (process.env["NEUVE_OPENAI_TOKEN_COMMAND"] ?? "").trim() === ""
  )
    throw new Error(
      "--allow-model needs a lease: NEUVE_OPENAI_TOKEN_COMMAND names the command that hands this machine a token",
    );
  // Precompute's keys depend on the parser, as in the worker that ran the original.
  const result = await execute(
    withStore(
      repository,
      "write",
      (location) =>
        Recompose.recompose({
          location,
          repository,
          runId: options.run!,
          allowModel: steps as ReadonlyArray<Recompose.RecomposeStep>,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              JobQueue.layer,
              Computations.layer.pipe(
                Layer.provideMerge(Blobs.layer(location)),
              ),
            ),
          ),
          // The run's own log lines go to stderr: stdout carries only the report (or its JSON).
          Effect.provide(Logger.layer([stderrLogger])),
        ),
      at,
    ),
  );
  const report = {
    runId: result.runId,
    original: result.original,
    generation: result.generation,
    steps: result.steps,
  };
  if (!options.json) {
    await write(
      terminalGuard([
        `recomposed run ${result.original} as run ${result.runId} (generation ${result.generation}):`,
        ...result.steps.map(
          (step) =>
            `  ${step.agent ?? step.stage}: ${step.outcome}${step.modelCalls > 0 ? ` (${step.modelCalls} model call(s))` : ""}`,
        ),
      ]),
    );
    return 0;
  }
  const runId = result.runId;
  const stored = await precomputed(repository, runId, at);
  const outputs = await execute(
    withStore(
      repository,
      "read",
      (store) =>
        StageView.runStageOutputs(runId).pipe(
          Effect.provide(
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(store))),
          ),
        ),
      at,
    ),
  );
  const packet = await execute(
    withStore(
      repository,
      "read",
      (store) =>
        PublishedPackets.readRun(runId, { repository }).pipe(
          Effect.provide(
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(store))),
          ),
        ),
      at,
    ),
  );
  await write(
    JSON.stringify(
      {
        recompose: report,
        ...result.receipt,
        packet: packet ?? null,
        manifest: stored?.storedManifest ?? null,
        leads: stored?.leads ?? null,
        scope: stored?.scope ?? null,
        stageOutputs: outputs.lines,
      },
      null,
      2,
    ),
  );
  return 0;
};

/** Public command validation, constructed only at the CLI boundary. */
export class PublicReviewError extends Error {}

export const runReviewCli = async (
  args: readonly string[],
): Promise<number> => {
  const [first, ...rest] = args;
  if (first === undefined || first === "--help" || first === "help") {
    await write(REVIEW_HELP);
    return first === undefined ? 2 : 0;
  }
  // `review show --help` prints the review help, which describes show, instead of refusing the flag.
  if (first === "show" && (rest.includes("--help") || rest.includes("-h"))) {
    await write(REVIEW_HELP);
    return 0;
  }
  // Every review subcommand reads Git; on a Mac without the command-line tools git only opens
  // Apple's installer, so none runs it then.
  const available = gitAvailability();
  if (!available.usable) {
    await Bun.write(Bun.stderr, gitRefusal(available));
    return 1;
  }
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args:
          first === "show" ||
          first === "stats" ||
          first === "recompose" ||
          first === "export-dump" ||
          first === "capture-ceiling" ||
          first === "capture-status" ||
          first === "dead-letter" ||
          first === "audit"
            ? [...rest]
            : [...args],
        allowPositionals: true,
        strict: true,
        options: {
          repo: { type: "string" },
          json: { type: "boolean" },
          detach: { type: "boolean" },
          route: { type: "string" },
          leads: { type: "string" },
          run: { type: "string" },
          cycle: { type: "string" },
          store: { type: "string" },
          root: { type: "string" },
          redaction: { type: "string" },
          capture: { type: "string" },
          job: { type: "string" },
          all: { type: "boolean" },
          repair: { type: "boolean" },
          "allow-model": { type: "string" },
          "stub-hold": { type: "string" },
          "stub-turn-limit": { type: "string" },
          "stub-measure": { type: "boolean" },
        },
      });
    } catch (error) {
      if (
        error instanceof TypeError &&
        "code" in error &&
        error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
      ) {
        const option =
          /^Unknown option '(-{1,2}[a-zA-Z][a-zA-Z0-9-]{0,63})'/.exec(
            error.message,
          )?.[1];
        if (option !== undefined)
          throw new PublicReviewError(`Unknown option '${option}'`);
      }
      throw error;
    }
  })();
  const repository = resolve(values.repo ?? process.cwd());
  if (first === "show")
    return show(repository, positionals[0], values.run, values.json === true);
  if (first === "stats")
    return showStats(repository, values.cycle, values.json === true);
  if (first === "capture-ceiling") {
    const runId = Ulid.parse(values.run);
    const ceilingMs = await captureStatus(repository, runId, values)
      .then((status) => status.ceilingMs)
      .catch(async () => {
        const location = await execute(resolveStoreLocation(repository));
        return recordedCloseCeiling(
          join(location.directory, "runs", runId),
        ).catch(ceilingFallback);
      });
    await write(JSON.stringify({ ceilingMs }));
    return 0;
  }
  if (first === "capture-status") {
    await write(
      JSON.stringify(await captureStatus(repository, values.run, values)),
    );
    return 0;
  }
  if (first === "dead-letter") {
    await write(
      JSON.stringify(await scanDeadLetter(repository, positionals[0], values)),
    );
    if (positionals[0] === "send-back")
      await execute(
        withStore(
          repository,
          "write",
          (location) =>
            values.store === undefined
              ? Starter.ensureWorkerAt(location, {
                  repository,
                  command: Starter.currentCliCommand(),
                })
              : startCaptureWorker(location, Starter.currentCliCommand()),
          values.store === undefined
            ? undefined
            : storeLocationIn(dirname(resolve(values.store))),
        ),
      );
    return 0;
  }
  if (first === "audit") {
    const results = await auditCaptures(repository, values);
    await write(JSON.stringify(results));
    return results.some(
      (result) =>
        result.observed === "failed" ||
        ("disagrees" in result && result.disagrees === true) ||
        ("reason" in result &&
          "repaired" in result &&
          result.repaired === false),
    )
      ? 2
      : 0;
  }
  if (first === "export-dump" && values.capture !== undefined)
    return exportStoredCapture(repository, values);
  if (first === "export-dump")
    return exportDump(repository, {
      run: values.run,
      root: values.root,
      redaction: values.redaction,
    });
  if (first === "recompose")
    return recomposeRun(repository, {
      run: values.run,
      store: values.store,
      allowModel: values["allow-model"],
      json: values.json === true,
    });
  const range = positionals[0];
  if (range === undefined)
    throw new Error("neuve review needs a range: <base>..<head>");
  return runRequest(repository, range, values);
};
