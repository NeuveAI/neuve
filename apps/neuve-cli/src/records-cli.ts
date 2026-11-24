import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CommitNotFound } from "../../../packages/harness/src/git.ts";
import { Cause, Effect, Exit, Option } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { SqlClient } from "effect/sql/SqlClient";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { z } from "zod";
import {
  ActorId,
  RecordEvent,
  Ulid,
  type StoredEvent,
} from "@neuve/records-schema";
import {
  Admin,
  Blobs,
  Feedback,
  Identity,
  Ingest,
  JobQueue,
  Log,
  Retention,
  SCHEMA_VERSION,
  Starter,
  Store,
  mintUlid,
  resolveStoreLocation,
  type StoreLocation,
} from "@neuve/records-core";
import { afterMigrate } from "./installed-copy.ts";
import { refusalFrom, refusalSentence } from "./version-skew.ts";

export const RECORDS_HELP = `Usage:
  neuve records history [--unit <id>] [--cycle <id>] [--kind <kind>] [--actor <id>]
    [--after <seq>] [--limit <count>] [--json] [--repo <path>]
              List events in log order, filtered through the unit and cycle indexes.
  neuve records get <event-id> [--json] [--repo <path>]
              Show one event.
  neuve records rebuild [--verify] [--repo <path>]
              Rebuild every projection from the log. --verify prints checksums before and
              after and exits 1 if they differ.
  neuve records fsck [--repo <path>]
              Check integrity, envelopes, indexes, jobs, projections against a rebuild, and the
              computation store: references, bindings and every blob re-hashed.
  neuve records stats [--json] [--repo <path>]
              Report bytes per event, rows and bytes per table, any state-copy table, database and
              blob sizes, computations, transcripts as referenced blobs and tokens per agent.
  neuve records migrate [--repo <path>]
              Upgrade the store to this build's schema and projector versions, after a backup
              copy in <store>/backups/. Every command does this when it opens an older store;
              older builds keep using it unless a migration declares them unsafe.
  neuve records ingest [--json] [--repo <path>]
              Append spooled hook events to the log in ULID order, then remove them. The worker
              does this on its own; files it cannot record move to spool/rejected/.
  neuve records prune [--dry-run] [--json] [--repo <path>]
              Enqueue a retention.prune job and wake the worker: it removes the bytes of raw
              captures (transcripts) captured more than 30 days ago, keeping each one's row as a
              tombstone; durable blobs are never pruned. --dry-run shows what would go, by class
              and age, and changes nothing. The worker also prunes on its own, once a day, when
              captures are due.
  neuve records feedback [--cycle <id>] [--email <email>] [--repo <path>]
              Export a person's feedback from the review desk as JSON in the end-to-end check's
              sheet answers' shape, marked as desk answers (not decide-then-reveal): units with
              first and final answers and judged findings, margin cards, and digests, each
              recording whether the harness's call was visible. The person is git's user.email
              unless --email names another.

The store lives in <git common directory>/neuve/records.sqlite.`;

const kinds = RecordEvent.options.map((option) => option.shape.kind.value);
const count = z.coerce.number().int().min(0);

const HistoryFlags = z.strictObject({
  unit: Ulid.optional(),
  cycle: Ulid.optional(),
  kind: z.enum(kinds).optional(),
  actor: ActorId.optional(),
  after: count.optional(),
  limit: count.max(10_000).optional(),
});

const parse = <T extends z.ZodType>(
  schema: T,
  value: unknown,
  label: string,
): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${label}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
};

/** `create` makes a missing store, as the first write of a repository does (ingestion). */
export type Mode = "read" | "write" | "create" | "migrate";

const prepare = (mode: Mode): Effect.Effect<void, unknown, SqlClient> => {
  switch (mode) {
    case "read":
      return Store.prepareForRead;
    case "write":
    case "create":
      return Store.prepareForWrite;
    case "migrate":
      return Effect.void;
  }
};

/**
 * Opens the repository's store for one command, applies the version gate and runs `program`, given
 * as an effect or as a function of the store's location.
 */
export const withStore = <A, E>(
  repository: string,
  mode: Mode,
  program:
    | Effect.Effect<A, E, SqlClient | FileSystem>
    | ((
        location: StoreLocation,
      ) => Effect.Effect<A, E, SqlClient | FileSystem>),
  /** A store other than the repository's own, such as a scratch copy a recompose runs in. */
  at?: StoreLocation,
): Effect.Effect<A, unknown> =>
  Effect.gen(function* () {
    const location = at ?? (yield* resolveStoreLocation(repository));
    const run = typeof program === "function" ? program(location) : program;
    return yield* Effect.andThen(prepare(mode), run).pipe(
      Effect.provide(
        Store.layer(location, {
          create: mode === "migrate" || mode === "create",
        }),
      ),
    );
  }).pipe(Effect.provide(BunFileSystem.layer));

/** A store or gate failure as one sentence for the person or agent reading the output. */
export const describeFailure = (error: unknown, fallback?: string): string => {
  // The version gate's refusals name both versions and what fixes them. Every WriterTooOld and
  // StoreNewer carries its versions, so only MigrationRequired without stored versions (an
  // initialization cut short) reaches the switch below.
  const refusal = refusalFrom(error);
  if (refusal !== undefined) return refusalSentence(refusal);
  if (error instanceof CommitNotFound) return fallback ?? error.message;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { _tag: string } & Record<string, unknown>;
    switch (tagged._tag) {
      case "StoreMissing":
        return "Neuve isn't set up in this repository. Run neuve setup there first.";
      case "WorkerSpawnFailed":
        return String(tagged["message"]);
      case "ProofRefused":
      case "InvalidEvent":
        return fallback ?? String(tagged["message"]);
      case "UnknownSession":
        return "The --session value names no live agent session in this repository.";
      case "RepositoryUnavailable":
        return "--repo must name a folder inside a Git repository.";
      case "BackupFailed":
        return `The store was not migrated: its backup copy ${String(tagged["path"])} could not be written (${String(tagged["message"])}).`;
      case "StoreNotInitialized":
        return "The Records database exists but was never initialized. Run: neuve records migrate";
      case "MigrationRequired":
        return "The store's initialization did not finish. Run: neuve records migrate";
      default:
        return (
          fallback ??
          (typeof tagged["message"] === "string"
            ? `${tagged._tag}: ${tagged["message"]}`
            : tagged._tag)
        );
    }
  }
  return fallback ?? (error instanceof Error ? error.message : String(error));
};

export const execute = async <A>(
  effect: Effect.Effect<A, unknown, never>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  throw new Error(
    Option.isSome(failure)
      ? describeFailure(failure.value)
      : Cause.pretty(exit.cause),
  );
};

export const write = (text: string) =>
  Bun.write(Bun.stdout, text.endsWith("\n") ? text : `${text}\n`);

export const argumentRefusal = (argument: string, accepted: string): string =>
  `${argument} takes ${accepted}.`;

export const nameDiagnosticPath = (
  error: unknown,
  name: string,
  ...paths: string[]
): string => {
  let message = error instanceof Error ? error.message : String(error);
  for (const path of paths.sort((a, b) => b.length - a.length)) {
    if (path === "") continue;
    message = message
      .replaceAll(JSON.stringify(path), name)
      .replaceAll(`'${path}'`, name)
      .replaceAll(`at ${path}:`, `at ${name}:`);
    if (path.startsWith("/") && path !== "/")
      message = message.replaceAll(path, name);
    // A system error can name a folder above the supplied path, which is part of what the person typed.
    for (
      let folder = dirname(path);
      folder !== dirname(folder);
      folder = dirname(folder)
    )
      message = message
        .replaceAll(`'${folder}'`, `a folder of ${name}`)
        .replaceAll(JSON.stringify(folder), `a folder of ${name}`);
  }
  return message;
};

export const repositoryRoot = (repository: string): string => {
  const git = Bun.spawnSync(
    ["git", "-C", repository, "rev-parse", "--show-toplevel"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  if (!git.success)
    throw new Error(
      argumentRefusal("--repo", "a folder inside a Git working tree"),
    );
  return git.stdout.toString().trimEnd();
};

export const unknownOptionRefusal = (
  token: string | undefined,
  command: string,
) => {
  const name = token?.split("=", 1)[0];
  const option =
    name !== undefined && /^-{1,2}[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(name)
      ? ` '${name}'`
      : "";
  return `Unknown option${option}. Run ${command} --help for accepted options.`;
};

export const unknownCommandRefusal = (token: string, command: string) =>
  token.startsWith("-")
    ? unknownOptionRefusal(token, command)
    : `Unknown command. Run ${command} --help for usage.`;

const bytes = (count: number) => {
  if (count < 1024) return `${count} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = count / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

/** Columns before `textColumns` are left-aligned text; the rest are right-aligned numbers. */
const table = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  textColumns: number,
) => {
  const widths = (rows[0] ?? []).map((_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, index) =>
        index < textColumns
          ? cell.padEnd(widths[index] ?? 0)
          : cell.padStart(widths[index] ?? 0),
      )
      .join("  "),
  );
};

/** The computation store's part of `stats`: what the owner judges after a day of dogfooding. */
const formatStore = (store: Admin.StoreStats["store"]) => {
  const { database, computations, transcripts } = store;
  const attempts = Object.entries(computations.attempts)
    .map(([outcome, n]) => `${n} ${outcome}`)
    .join(", ");
  const lines = [
    `store size on disk ${bytes(database.totalBytes)}: database file ${bytes(database.fileBytes)} + write-ahead log ${bytes(database.walBytes)} + blob files ${bytes(database.blobFileBytes)}; database pages ${bytes(database.pageBytes)} (${bytes(database.freeBytes)} free)`,
    `blobs: ${
      store.blobs.length === 0
        ? "none"
        : store.blobs
            .map(
              (b) =>
                `${b.retention} ${b.placement} ${b.blobs} (${bytes(b.bytes)}${b.pruned > 0 ? `, ${b.pruned} pruned` : ""})`,
            )
            .join("; ")
    }`,
    `retention: ${store.retention.due.blobs} raw capture(s) past the 30-day cutoff ${store.retention.cutoff} (${bytes(store.retention.due.bytes)}); ${store.retention.tombstones.blobs} tombstone(s) (${bytes(store.retention.tombstones.bytes)} pruned)${store.retention.tombstones.lastPrunedAt === null ? "" : `, last pruned ${store.retention.tombstones.lastPrunedAt}`}`,
    `computations: ${computations.finished} finished; attempts ${attempts}${computations.pendingRemovals > 0 ? `; ${computations.pendingRemovals} evicted output file(s) still to remove` : ""}`,
    ...(computations.kinds.length === 0
      ? []
      : [
          "computations by kind (bytes count each blob once; at most evictable: of a declared kind, stored over 15 minutes ago, no model's, named in no event's refs):",
          ...table(
            [
              [
                "kind",
                "oldest stored",
                "newest stored",
                "outputs",
                "bytes",
                "at most evictable",
                "its bytes",
                "cap",
              ],
              ...computations.kinds.map((kind) => [
                kind.op,
                kind.oldestStoredAt ?? "-",
                kind.newestStoredAt ?? "-",
                String(kind.outputs),
                bytes(kind.bytes),
                String(kind.evictable.outputs),
                bytes(kind.evictable.bytes),
                kind.capBytes === null ? "none" : bytes(kind.capBytes),
              ]),
            ],
            3,
          ).map((line) => `  ${line}`),
        ]),
    `transcripts: ${transcripts.summaries.turn} turn and ${transcripts.summaries.sessionTail} session-tail summaries reference ${transcripts.blobs} raw-capture blobs (${bytes(transcripts.bytes)}; ${transcripts.inline} inline, ${transcripts.files} files, ${transcripts.pruned} pruned, ${transcripts.missing} missing)`,
  ];
  if (store.agents.length === 0)
    return [...lines, "tokens per agent: none recorded", ""];
  return [
    ...lines,
    "tokens per agent:",
    ...table(
      [
        [
          "agent",
          "kind",
          "harness",
          "model",
          "turns",
          "summaries",
          "input",
          "cache write",
          "cache read",
          "output",
          "calls",
          "tools",
        ],
        ...store.agents.map((agent) => [
          agent.alias,
          agent.subagent ? "subagent" : "agent",
          agent.harness,
          agent.model ?? "-",
          String(agent.turns),
          String(agent.summaries),
          String(agent.tokens.input),
          String(agent.tokens.cacheCreation),
          String(agent.tokens.cacheRead),
          String(agent.tokens.output),
          String(agent.apiCalls),
          String(agent.toolCalls),
        ]),
      ],
      4,
    ).map((line) => `  ${line}`),
    "",
  ];
};

/** The dry run: what a prune now would remove, by class and age, and what it keeps. */
const formatPlan = (plan: Retention.PrunePlan) => {
  const lines = [
    `Raw captures expire 30 days after capture; now ${plan.now}, cutoff ${plan.cutoff}.`,
    plan.due.blobs === 0
      ? "Would prune nothing: no raw capture is past retention."
      : `Would prune ${plan.due.blobs} raw capture(s), ${bytes(plan.due.bytes)}; the oldest was captured ${plan.due.oldestCapturedAt}.`,
  ];
  if (plan.byClass.length > 0)
    lines.push(
      "by class:",
      ...table(
        [
          ["retention", "media type", "placement", "blobs", "bytes"],
          ...plan.byClass.map((row) => [
            row.retention,
            row.mediaType,
            row.placement,
            String(row.blobs),
            bytes(row.bytes),
          ]),
        ],
        3,
      ).map((line) => `  ${line}`),
      "by age since capture:",
      ...table(
        [
          ["age", "blobs", "bytes"],
          ...plan.byAge.map((band) => [
            band.label,
            String(band.blobs),
            bytes(band.bytes),
          ]),
        ],
        1,
      ).map((line) => `  ${line}`),
    );
  lines.push(
    plan.leftoverFiles === null
      ? `Files beside tombstones from an interrupted prune: not scanned (${plan.leftoverError}).`
      : `Files beside tombstones from an interrupted prune: ${plan.leftoverFiles}${plan.leftoverFiles > 0 ? " (a prune removes them)" : ""}.`,
    `Kept: ${plan.retained.blobs} raw capture(s) within retention (${bytes(plan.retained.bytes)}); ${plan.durable.blobs} durable blob(s) (${bytes(plan.durable.bytes)}), never pruned.`,
    `Tombstones so far: ${plan.tombstones.blobs} (${bytes(plan.tombstones.bytes)} pruned)${plan.tombstones.lastPrunedAt === null ? "" : `, last pruned ${plan.tombstones.lastPrunedAt}`}.`,
    "Dry run: nothing changed.",
  );
  return lines.join("\n");
};

/** The person git names in the repository, or "" when it names none. */
const gitEmail = (repository: string) => {
  const result = Bun.spawnSync(
    ["git", "-C", repository, "config", "user.email"],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  return result.success ? result.stdout.toString() : "";
};

const short = (id: string | undefined) =>
  id === undefined ? "-" : id.slice(0, 12);

const formatEvent = ({ seq, recordedAt, event }: StoredEvent): string => {
  const units = event.attribution?.unitIds?.length ?? 0;
  return [
    `#${seq}`.padEnd(6),
    recordedAt,
    event.kind.padEnd(24),
    `actor ${short(event.actor)}`,
    `cycle ${short(event.attribution?.cycleId)}`,
    `units ${units}`,
    event.id,
  ].join("  ");
};

export const runRecordsCli = async (
  args: readonly string[],
): Promise<number> => {
  const [subcommand, ...rest] = args;
  if (
    subcommand === undefined ||
    subcommand === "--help" ||
    subcommand === "help"
  ) {
    await write(RECORDS_HELP);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: subcommand === "get",
    strict: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      verify: { type: "boolean" },
      "dry-run": { type: "boolean" },
      unit: { type: "string" },
      cycle: { type: "string" },
      kind: { type: "string" },
      actor: { type: "string" },
      after: { type: "string" },
      limit: { type: "string" },
      email: { type: "string" },
    },
  });
  const repository = resolve(values.repo ?? process.cwd());

  switch (subcommand) {
    case "history": {
      const flags = parse(
        HistoryFlags,
        {
          unit: values.unit,
          cycle: values.cycle,
          kind: values.kind,
          actor: values.actor,
          after: values.after,
          limit: values.limit,
        },
        "history",
      );
      const events = await execute(
        withStore(
          repository,
          "read",
          Log.history({
            unitId: flags.unit,
            cycleId: flags.cycle,
            kind: flags.kind,
            actorId: flags.actor,
            afterSeq: flags.after,
            limit: flags.limit,
          }),
        ),
      );
      await write(
        values.json === true
          ? JSON.stringify(events, null, 2)
          : events.map(formatEvent).join("\n") || "No events.",
      );
      return 0;
    }
    case "get": {
      const id = parse(Ulid, positionals[0], "get <event-id>");
      const event = await execute(withStore(repository, "read", Log.get(id)));
      if (Option.isNone(event)) {
        const newer = await execute(
          withStore(repository, "read", Log.newerEventKind(id)),
        );
        await Bun.write(
          Bun.stderr,
          Option.isSome(newer)
            ? `neuve: That event is ${newer.value}, a kind this build does not know. Use the newer build that wrote it.\n`
            : "neuve: That event ID has no event in this store.\n",
        );
        return 1;
      }
      await write(
        values.json === true
          ? JSON.stringify(event.value, null, 2)
          : `${formatEvent(event.value)}\n${JSON.stringify(event.value.event, null, 2)}`,
      );
      return 0;
    }
    case "rebuild": {
      const report = await execute(
        withStore(repository, "write", Admin.rebuild),
      );
      const lines = [
        `Replayed ${report.events} events into ${report.after.length} projection tables${report.newerEvents === 0 ? "" : `; left ${report.newerEvents} event(s) of kinds this build does not know for the newer build that wrote them`}.`,
      ];
      if (values.verify === true) {
        lines.push("table                           rows  before        after");
        report.after.forEach((after, index) => {
          const before = report.before[index];
          lines.push(
            `${after.table.padEnd(30)}  ${String(after.rows).padStart(4)}  ${before?.sha256.slice(0, 12) ?? "-"}  ${after.sha256.slice(0, 12)}  ${before?.sha256 === after.sha256 ? "identical" : "DIFFERENT"}`,
          );
        });
        lines.push(`combined before ${report.beforeCombined}`);
        lines.push(`combined after  ${report.afterCombined}`);
        lines.push(
          report.beforeCombined === report.afterCombined
            ? "verify: identical"
            : "verify: DIFFERENT",
        );
      } else {
        lines.push(`combined ${report.afterCombined}`);
      }
      await write(lines.join("\n"));
      return values.verify === true &&
        report.beforeCombined !== report.afterCombined
        ? 1
        : 0;
    }
    case "fsck": {
      const checks = await execute(withStore(repository, "read", Admin.fsck));
      await write(
        checks
          .map(
            (check) =>
              `${check.status.padEnd(7)}  ${check.name}: ${check.detail}`,
          )
          .join("\n"),
      );
      return checks.some((check) => check.status === "fail") ? 1 : 0;
    }
    case "stats": {
      const stats = await execute(withStore(repository, "read", Admin.stats));
      if (values.json === true) {
        await write(JSON.stringify(stats, null, 2));
        return 0;
      }
      const lines = [
        ...formatStore(stats.store),
        `events ${stats.events}; unit index rows ${stats.unitIndexRows}; cycle index rows ${stats.cycleIndexRows}; jobs ${stats.jobs}`,
        `bytes per event: envelope ${stats.bytesPerEvent.envelope}, log and index pages ${stats.bytesPerEvent.logPages}, whole file ${stats.bytesPerEvent.allPages}`,
        "table                           role         rows     bytes",
        ...stats.tables.map(
          (t) =>
            `${t.table.padEnd(30)}  ${t.role.padEnd(10)}  ${String(t.rows).padStart(6)}  ${String(t.bytes).padStart(8)}`,
        ),
        `undeclared tables: ${stats.undeclaredTables.length === 0 ? "none" : stats.undeclaredTables.join(", ")}`,
        ...(stats.newerTables.length === 0
          ? []
          : [
              `tables of the newer build that upgraded this store, left to it: ${stats.newerTables.join(", ")}`,
            ]),
        `state copies: ${stats.stateCopies.length === 0 ? "none (every projection has at most one row per entity)" : stats.stateCopies.join("; ")}`,
      ];
      await write(lines.join("\n"));
      return stats.stateCopies.length === 0 &&
        stats.undeclaredTables.length === 0
        ? 0
        : 1;
    }
    case "ingest": {
      const location = await execute(resolveStoreLocation(repository));
      const report = await execute(
        withStore(
          repository,
          "create",
          Effect.provide(Ingest.ingestSpool(location), BunFileSystem.layer),
        ),
      );
      await write(
        values.json === true
          ? JSON.stringify(report, null, 2)
          : [
              `Ingested the spool: ${report.appended} appended, ${report.existing} already recorded, ${report.keptEarlier} second vent(s) kept the earlier one, ${report.rejected.length} rejected.`,
              ...report.rejected.map((r) => `rejected ${r.file}: ${r.reason}`),
            ].join("\n"),
      );
      return report.rejected.length === 0 ? 0 : 1;
    }
    case "prune": {
      const dryRun = values["dry-run"] === true;
      if (dryRun) {
        const plan = await execute(
          withStore(repository, "read", (location) =>
            Effect.provide(Retention.plan, Blobs.layer(location)),
          ),
        );
        await write(
          values.json === true
            ? JSON.stringify(plan, null, 2)
            : formatPlan(plan),
        );
        return 0;
      }
      // The worker is the one runner of prunes: this enqueues the job (with a key of its own, so a
      // prune that already ran today does not absorb it) and wakes or starts the worker.
      const { job } = await execute(
        withStore(
          repository,
          "write",
          Effect.provide(
            JobQueue.JobQueue.use((queue) =>
              queue.enqueue({
                kind: "retention.prune",
                dedupeKey: `retention.prune:manual:${mintUlid()}`,
                payload: {},
              }),
            ),
            JobQueue.layer,
          ),
        ),
      );
      const started = await Effect.runPromise(
        Effect.result(
          Starter.ensureWorker({
            repository,
            command: Starter.currentCliCommand(),
          }),
        ),
      );
      const worker =
        started._tag === "Failure"
          ? `queued without waking a worker (${describeFailure(started.failure)}); it runs at the next worker start or sweep`
          : started.success.status === "running"
            ? "signalled the running worker"
            : `spawned a worker (pid ${started.success.pid ?? "?"}, log ${started.success.log})`;
      await write(
        values.json === true
          ? JSON.stringify(
              {
                job,
                worker: started._tag === "Success" ? started.success : null,
              },
              null,
              2,
            )
          : `Enqueued retention.prune as job ${job.seq}; ${worker}. Follow it with: neuve jobs inspect ${job.seq}`,
      );
      return 0;
    }
    case "feedback": {
      const cycle = parse(Ulid.optional(), values.cycle, "feedback --cycle");
      const email = (values.email ?? gitEmail(repository)).trim();
      if (email === "" || !email.includes("@"))
        throw new Error(
          "feedback: git names no email here (git config user.email); name the person with --email",
        );
      const document = await execute(
        withStore(
          repository,
          "read",
          Feedback.sheetAnswers({
            actorId: Identity.humanFingerprint(email),
            cycleId: cycle,
            readAt: new Date().toISOString(),
          }),
        ),
      );
      await write(JSON.stringify(document, null, 2));
      return 0;
    }
    case "migrate": {
      const result = await execute(
        withStore(
          repository,
          "migrate",
          Effect.gen(function* () {
            const migrated = yield* Store.migrate;
            const state = yield* Store.readState;
            return {
              ...migrated,
              newerSchema:
                state._tag === "Ready" &&
                state.versions.schemaVersion > SCHEMA_VERSION
                  ? state.versions.schemaVersion
                  : undefined,
            };
          }),
        ),
      );
      if (result.newerSchema !== undefined) {
        await write(
          `A newer build already upgraded this store (schema ${result.newerSchema}); this build (schema ${SCHEMA_VERSION}) keeps working with it, so nothing was changed.`,
        );
        return 0;
      }
      await write(
        `Applied ${result.applied.length === 0 ? "no migrations" : result.applied.join(", ")}${result.rebuilt ? "; projections rebuilt" : ""}.`,
      );
      const warning = await execute(afterMigrate(repository));
      if (warning !== undefined)
        await Bun.write(Bun.stderr, `neuve: ${warning}\n`);
      return 0;
    }
    default:
      throw new Error(unknownCommandRefusal(subcommand, "neuve records"));
  }
};
