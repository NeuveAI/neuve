import { Clock, Data, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  TurnRecoveryRecorded,
  TurnRecoveryPublished,
  type TurnRecoveryCheckpoint,
  type TurnRecoveryPayload,
  type TurnRecoveryReason,
} from "@neuve/records-schema";
import { sha256Hex } from "./canonical.ts";
import { CorruptRecord } from "./errors.ts";
import { mintUlid } from "./ids.ts";
import { append } from "./log.ts";
import { assertCompatible } from "./store.ts";
import type { Job } from "./queue.ts";

export interface RecoveryState {
  readonly event: string;
  readonly value: TurnRecoveryPayload;
}
export class RecoveryConflict extends Data.TaggedError("RecoveryConflict")<{
  readonly message: string;
}> {}
const actor = sha256Hex("neuve/harness/turn-recovery/1");
const ended = (state: TurnRecoveryPayload["state"]) =>
  state === "terminal" || state === "cancelled" || state === "recovered";

/** Read from the append-only log; no browser clock, heads file or second retry counter is authoritative. */
export const current = (turn: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ envelope: string }>`SELECT envelope FROM events
      WHERE kind = 'turn.recovery-recorded@1' AND json_extract(envelope, '$.payload.turn') = ${turn}
      ORDER BY seq DESC LIMIT 1`;
    if (!row) return undefined;
    const event = yield* Effect.try({
      try: () => TurnRecoveryRecorded.parse(JSON.parse(row.envelope)),
      catch: () => new CorruptRecord({ message: "Invalid turn recovery event" }),
    });
    return { event: event.id, value: event.payload } satisfies RecoveryState;
  });

const publish = (value: TurnRecoveryPayload, previous?: RecoveryState) =>
  Effect.gen(function* () {
    const id = mintUlid();
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* append([{
      id,
      actor,
      kind: "turn.recovery-recorded@1",
      idempotencyKey: `turn.recovery:${value.turn}:${value.state}:${value.attempt}`,
      occurredAt,
      attribution: { turnKey: value.turn },
      ...(previous ? { causation: { causedBy: previous.event } } : {}),
      payload: value,
    }]);
    return { event: id, value } satisfies RecoveryState;
  });
const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.withTransaction(Effect.andThen(assertCompatible, effect));
  });
const required = (turn: string) => Effect.gen(function* () {
  const found = yield* current(turn);
  if (!found) return yield* new RecoveryConflict({ message: "Turn recovery has not begun" });
  return found;
});

/** Same logical turn joins its recorded work. A later turn cannot overtake unsettled work for this chat. */
export const begin = (input: { turn: string; chat: string; checkpoint: TurnRecoveryCheckpoint }) => write(
  Effect.gen(function* () {
    const existing = yield* current(input.turn);
    if (existing) {
      if (existing.value.chat !== input.chat || existing.value.checkpoint.generation !== input.checkpoint.generation)
        return yield* new RecoveryConflict({ message: "Logical turn identity changed" });
      return existing;
    }
    const sql = yield* SqlClient;
    const [pending] = yield* sql`SELECT 1 FROM events e
      WHERE e.kind = 'turn.recovery-recorded@1'
        AND json_extract(e.envelope, '$.payload.chat') = ${input.chat}
        AND json_extract(e.envelope, '$.payload.state') IN ('running', 'scheduled', 'started')
        AND NOT EXISTS (SELECT 1 FROM events n
          WHERE n.kind = e.kind AND n.seq > e.seq
            AND json_extract(n.envelope, '$.payload.turn') = json_extract(e.envelope, '$.payload.turn')) LIMIT 1`;
    if (pending) return yield* new RecoveryConflict({ message: "An earlier turn still owns this chat" });
    return yield* publish({ ...input, state: "running", attempt: 0 });
  }),
);

/** The harness supplies the chosen time, once. Publishing and enqueueing are the same append transaction. */
export const schedule = (input: {
  turn: string;
  expected: string;
  nextAt: string;
  reason: "temporary-provider-failure" | "reusable-protocol-failure";
  checkpoint: TurnRecoveryCheckpoint;
}) => write(Effect.gen(function* () {
  const prior = yield* required(input.turn);
  // Repeated wake-ups join the same schedule, even if the caller drew another jitter value.
  if (prior.value.state === "scheduled") return prior;
  if (prior.event !== input.expected || (prior.value.state !== "running" && prior.value.state !== "started"))
    return yield* new RecoveryConflict({ message: "Stale recovery scheduling request" });
  if (prior.value.attempt >= 5)
    return yield* publish({ ...prior.value, state: "terminal", reason: "retry-budget-exhausted" }, prior);
  return yield* publish({
    turn: input.turn,
    chat: prior.value.chat,
    state: "scheduled",
    attempt: prior.value.attempt + 1,
    nextAt: input.nextAt,
    reason: input.reason,
    checkpoint: input.checkpoint,
  }, prior);
}));

/** The existing queue is the sole dispatcher. An old/cancelled/duplicate job never starts model work. */
export const start = (job: Job) => write(Effect.gen(function* () {
  if (job.kind !== "chat.turn-retry@1" || job.eventId === null) return undefined;
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ envelope: string }>`SELECT envelope FROM events WHERE id = ${job.eventId}`;
  if (!row) return yield* new CorruptRecord({ message: "Turn retry job has no scheduling event" });
  const scheduled = yield* Effect.try({
    try: () => TurnRecoveryRecorded.parse(JSON.parse(row.envelope)),
    catch: () => new CorruptRecord({ message: "Turn retry job has an invalid scheduling event" }),
  });
  const prior = yield* required(scheduled.payload.turn);
  if (prior.event !== job.eventId || prior.value.state !== "scheduled") return undefined;
  const [active] = yield* sql`SELECT 1 FROM jobs WHERE job_seq = ${job.seq}
    AND state IN ('active', 'completed') AND attempts = ${job.attempts} AND event_id = ${job.eventId}`;
  if (!active) return undefined;
  const now = yield* Clock.currentTimeMillis;
  if (Date.parse(prior.value.nextAt!) > now) return undefined;
  const { nextAt: _next, ...value } = prior.value;
  return yield* publish({ ...value, state: "started", job: job.seq }, prior);
}));

/** A late completion cannot overwrite cancellation, exhaustion or a newer attempt. */
export const settle = (input: {
  turn: string;
  expected: string;
  state: "recovered" | "terminal" | "cancelled";
  reason?: TurnRecoveryReason;
}) => write(Effect.gen(function* () {
  const prior = yield* required(input.turn);
  if (prior.event !== input.expected || ended(prior.value.state)) return prior;
  const { nextAt: _next, reason: _reason, ...value } = prior.value;
  return yield* publish({ ...value, state: input.state, ...(input.reason ? { reason: input.reason } : {}) }, prior);
}));

/** Cancellation is durable before any queued delivery can observe it. */
export const cancel = (turn: string) => write(Effect.gen(function* () {
  const prior = yield* current(turn);
  if (!prior || ended(prior.value.state)) return prior;
  return yield* settle({ turn, expected: prior.event, state: "cancelled", reason: "cancelled" });
}));

/** A dispatched request without a durable result is an ambiguous effect, never an automatic replay. */
export const reconcile = (turn: string) => write(Effect.gen(function* () {
  const prior = yield* current(turn);
  if (!prior || ended(prior.value.state) || prior.value.state === "scheduled") return prior;
  return yield* settle({ turn, expected: prior.event, state: "terminal", reason: "unsafe-continuation" });
}));

/** The resumed pi task must name exactly the generation at the durable checkpoint. */
export const find = (chat: string, generation: string) => Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ turn: string }>`SELECT json_extract(envelope, '$.payload.turn') AS turn FROM events
    WHERE kind='turn.recovery-recorded@1' AND json_extract(envelope, '$.payload.chat')=${chat}
      AND json_extract(envelope, '$.payload.checkpoint.generation')=${generation}
    ORDER BY seq DESC LIMIT 1`;
  if (!row) return undefined;
  return yield* current(row.turn);
});

export const delivery = (event: string) => Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ seq: number; state: string }>`SELECT job_seq AS seq, state FROM jobs
    WHERE kind='chat.turn-retry@1' AND event_id=${event}`;
  return row;
});

/** Publish the single attempt's durable response before releasing its shared-work claim. */
export const publishResult = (schedule: RecoveryState, result: string) => Effect.gen(function* () {
  const id = mintUlid();
  const appended = yield* append([{ id, actor, occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    kind: "turn.recovery-published@1", idempotencyKey: `turn.recovery-output:${schedule.event}`,
    attribution: { turnKey: schedule.value.turn }, causation: { causedBy: schedule.event },
    payload: { turn: schedule.value.turn, schedule: schedule.event, attempt: schedule.value.attempt, result },
  }]);
  return appended[0]!.id;
});
export const publishedResult = (schedule: string, publication?: string) => Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ envelope: string }>`SELECT envelope FROM events
    WHERE kind='turn.recovery-published@1' AND json_extract(envelope, '$.payload.schedule')=${schedule}
      ${publication === undefined ? sql`` : sql`AND id=${publication}`} ORDER BY seq DESC LIMIT 1`;
  if (!row) return undefined;
  const parsed = yield* Effect.try({
    try: () => TurnRecoveryPublished.parse(JSON.parse(row.envelope)),
    catch: () => new CorruptRecord({ message: "Invalid turn recovery publication" }),
  });
  return { publication: parsed.id, hash: parsed.payload.result };
});

export const latest = (chat: string) => Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ turn: string }>`SELECT json_extract(envelope, '$.payload.turn') AS turn FROM events
    WHERE kind='turn.recovery-recorded@1' AND json_extract(envelope, '$.payload.chat')=${chat}
    ORDER BY seq DESC LIMIT 1`;
  return row ? yield* current(row.turn) : undefined;
});

export const statuses = () => Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ chat: string }>`SELECT DISTINCT json_extract(envelope, '$.payload.chat') AS chat
    FROM events WHERE kind='turn.recovery-recorded@1'`;
  return (yield* Effect.forEach(rows, (row) => latest(row.chat))).filter((state) => state !== undefined);
});
export const status = (state: RecoveryState) => Effect.gen(function* () {
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ seq: number }>`SELECT seq FROM events WHERE id=${state.event}`;
  const job = state.value.state === 'scheduled' ? yield* delivery(state.event) : undefined;
  return {
    event: state.event, revision: row?.seq ?? 0, turn: state.value.turn, checkpoint: state.value.checkpoint.id,
    state: state.value.state, attempt: state.value.attempt,
    ...(state.value.reason === undefined ? {} : { reason: state.value.reason }),
    ...(state.value.nextAt === undefined ? {} : { nextAt: state.value.nextAt }),
    ...(job?.seq === undefined && state.value.job === undefined ? {} : { job: job?.seq ?? state.value.job! }),
  } satisfies import('@neuve/records-schema').TurnRetryStatus;
});

export const scheduledState = (state: RecoveryState) => Effect.gen(function* () {
  if (state.value.state !== 'started' || state.value.job === undefined) return state;
  const sql = yield* SqlClient;
  const [row] = yield* sql<{ envelope: string }>`SELECT e.envelope FROM jobs j JOIN events e ON e.id=j.event_id
    WHERE j.job_seq=${state.value.job} AND e.kind='turn.recovery-recorded@1'`;
  if (!row) return yield* new CorruptRecord({ message: 'Retry attempt has no schedule' });
  const event = yield* Effect.try({ try: () => TurnRecoveryRecorded.parse(JSON.parse(row.envelope)),
    catch: () => new CorruptRecord({ message: 'Invalid retry schedule' }) });
  return { event: event.id, value: event.payload };
});
