import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  TEXT_CAPTURE_MEDIA_TYPE,
  VENT_TEXT_MAX,
  VentInput,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import { resolveCaller, type CallerResolution } from "./caller.ts";
import { decodeEnvelope } from "./codec.ts";
import { CorruptRecord, InvalidEvent } from "./errors.ts";
import { baseAlias } from "./identity.ts";
import { mintUlid } from "./ids.ts";
import type { StoreLocation } from "./location.ts";
import { append, earlierVent, ventKeyOf } from "./log.ts";
import { readSession, readSubagent } from "./sessions.ts";
import { assertCompatible } from "./store.ts";

/**
 * Vents (2.15, 8.8): an agent may say, once per session, what is making that session difficult. A
 * vent is optional, needs little structure, and never changes the task or the review. It is a
 * `vent.recorded@2` event read through `neuve vents`; no projection holds it, so it never enters
 * review context. Its text is a raw capture that the pruner removes after 30 days (8.17), while the
 * event keeps who vented, when, and in which session.
 */

export interface VentRequest {
  /** The agent session, or subagent, that vents. */
  readonly actorId: string;
  readonly sessionId: string;
  readonly text: string;
  /**
   * The harness's session ID for this review cycle (8.16). The limit is one vent per actor and
   * reconciliation ID, or per actor and session without one.
   */
  readonly reconciliationId?: string | undefined;
  readonly turnKey?: string | undefined;
  readonly runId?: string | undefined;
  readonly stage?: string | undefined;
}

export interface StoredVent {
  readonly id: string;
  readonly seq: number;
  readonly recordedAt: string;
}

/**
 * `kept-earlier`: this actor already vented under this reconciliation ID (or in this session). That
 * is an ordinary outcome, not an error, so a caller has nothing to retry.
 */
export type VentResult =
  | { readonly status: "recorded"; readonly vent: StoredVent }
  | { readonly status: "kept-earlier"; readonly earlier: StoredVent };

const parseVent = (
  request: Pick<VentRequest, "text" | "reconciliationId">,
): Effect.Effect<VentInput, InvalidEvent> => {
  const parsed = VentInput.safeParse({
    text: request.text,
    reconciliationId: request.reconciliationId,
  });
  if (parsed.success) return Effect.succeed(parsed.data);
  const fields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
  const problems: string[] = [];
  if (fields.has("text"))
    problems.push(
      `Vent text takes 1 to ${VENT_TEXT_MAX.toLocaleString("en")} characters with at least one non-whitespace character. Received ${request.text.trim() === "" ? "blank text" : `${[...request.text].length} characters`}.`,
    );
  if (fields.has("reconciliationId"))
    problems.push(
      `--reconciliation-id takes the harness's review cycle ID of 1 to 256 characters. Received ${JSON.stringify(request.reconciliationId)}.`,
    );
  return Effect.fail(new InvalidEvent({ message: problems.join("\n") }));
};

/**
 * Records a vent, or keeps the earlier one: at most one per actor and reconciliation ID, falling
 * back to the session (8.8, 8.16). `Log.append` applies the limit for every producer, in its write
 * transaction, and the log's unique index holds it under races. The text must fit `VentInput` as
 * given and is stored trimmed, as a raw-capture blob the event references (8.17). A second vent is
 * answered before its text is stored, so nothing of it is kept.
 */
export const record = (request: VentRequest) =>
  parseVent(request).pipe(Effect.flatMap((input) => storeVent(request, input)));

const storeVent = (request: VentRequest, input: VentInput) =>
  Effect.gen(function* () {
    const text = input.text.trim();
    const key = ventKeyOf({
      reconciliationId: input.reconciliationId,
      sessionId: request.sessionId,
    });
    const sql = yield* SqlClient;
    const blobs = yield* BlobStore;
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertCompatible;
        const held = yield* earlierVent(request.actorId, key);
        if (held !== undefined)
          return { status: "kept-earlier", earlier: held } satisfies VentResult;
        const blob = yield* blobs.put({
          bytes: new TextEncoder().encode(text),
          mediaType: TEXT_CAPTURE_MEDIA_TYPE,
          retention: "raw-capture",
        });
        const [result] = yield* append([
          {
            id: mintUlid(),
            kind: "vent.recorded@2",
            idempotencyKey: `vent:${request.actorId}:${"reconciliationId" in key ? `r:${key.reconciliationId}` : `s:${key.sessionId}`}`,
            actor: request.actorId,
            occurredAt,
            attribution: {
              sessionId: request.sessionId,
              ...(request.turnKey === undefined
                ? {}
                : { turnKey: request.turnKey }),
              ...(request.runId === undefined ? {} : { runId: request.runId }),
              ...(request.stage === undefined ? {} : { stage: request.stage }),
            },
            refs: [{ ref: `blob:${blob.blob.hash}`, role: "vent" }],
            payload:
              "reconciliationId" in key
                ? { reconciliationId: key.reconciliationId }
                : {},
          },
        ]);
        const stored = yield* earlierVent(request.actorId, key);
        if (result === undefined || stored === undefined)
          return yield* new CorruptRecord({
            message: "the vent's append returned no stored vent",
          });
        return result.status === "appended"
          ? ({ status: "recorded", vent: stored } satisfies VentResult)
          : ({ status: "kept-earlier", earlier: stored } satisfies VentResult);
      }),
    );
  });

/**
 * What `neuve vent` and the MCP `vent` tool do: tie the call to its agent session (D23), then record.
 * Nothing is guessed: with no session, or more than one, nothing is recorded and the resolution says
 * why. The turn is the session's (or subagent's) open turn, when hooks recorded one.
 */
export type CallerVentResult =
  | (VentResult & {
      readonly caller: Extract<CallerResolution, { _tag: "Linked" }>;
      readonly reconciliationId?: string | undefined;
    })
  | {
      readonly status: "unlinked";
      readonly caller: Exclude<CallerResolution, { _tag: "Linked" }>;
      readonly problems?: string;
    };

export const ventAsCaller = (
  location: StoreLocation,
  options: {
    readonly text: string;
    readonly override?: string | undefined;
    /** The harness's session ID for this review cycle (8.16), when it gave one. */
    readonly reconciliationId?: string | undefined;
    readonly pid?: number | undefined;
    /** Where a declared session ID is read when the process table cannot be (8.13). */
    readonly environment?:
      Readonly<Record<string, string | undefined>> | undefined;
  },
) =>
  Effect.gen(function* () {
    const caller = yield* resolveCaller(location, {
      override: options.override,
      pid: options.pid,
      environment: options.environment,
    });
    const input = yield* Effect.result(parseVent(options));
    if (caller._tag !== "Linked")
      return {
        status: "unlinked",
        caller,
        ...(input._tag === "Failure"
          ? { problems: input.failure.message }
          : {}),
      } satisfies CallerVentResult;
    const ready = yield* Effect.fromResult(input);
    const open =
      caller.subagentId === undefined
        ? yield* readSession(location, caller.harness, caller.sessionId)
        : yield* readSubagent(
            location,
            caller.harness,
            caller.sessionId,
            caller.subagentId,
          );
    const result = yield* storeVent(
      {
        actorId: caller.actorId,
        sessionId: caller.sessionId,
        text: options.text,
        reconciliationId: options.reconciliationId,
        turnKey: open?.turnKey,
      },
      ready,
    );
    return {
      ...result,
      caller,
      ...(options.reconciliationId === undefined
        ? {}
        : { reconciliationId: options.reconciliationId }),
    } satisfies CallerVentResult;
  });

export const describe = (result: CallerVentResult) => {
  switch (result.status) {
    case "recorded":
      return `Vent recorded (${result.vent.id}) for ${result.caller.harness} session ${result.caller.sessionId}${result.reconciliationId === undefined ? "" : ` in review cycle ${result.reconciliationId}`}. Thank you; it does not change your task.`;
    case "kept-earlier":
      return `You already vented in this ${result.reconciliationId === undefined ? "session" : "review cycle"} (${result.earlier.id}, ${result.earlier.recordedAt}); one vent per ${result.reconciliationId === undefined ? "session" : "review cycle"}, and the earlier one is kept. Nothing else is needed.`;
    case "unlinked": {
      const problems =
        result.problems === undefined ? "" : `\n${result.problems}`;
      switch (result.caller._tag) {
        case "Ambiguous":
          return `Not recorded: this call belongs to more than one live agent session (${result.caller.sessionIds.join(", ")}), and none is chosen.${problems}`;
        case "Unavailable":
          return `Not recorded: the process table cannot be read here (agent sandboxes may forbid it), and no session ID set by a supported harness names a live session here, so this call is not linked to an agent session.${problems}`;
        case "None":
          return `Not recorded: this call ran outside a captured agent session. If the agent hooks are not set up for this agent, ask the person to run neuve setup hooks.${problems}`;
      }
    }
  }
};

export interface VentView {
  readonly seq: number;
  readonly id: string;
  readonly recordedAt: string;
  readonly occurredAt: string;
  readonly actorId: string;
  /** The actor's alias; the base alias when no registration for the actor was recorded. */
  readonly alias: string;
  readonly harness: string | null;
  readonly subagent: boolean;
  readonly agentType: string | null;
  readonly sessionId: string;
  readonly reconciliationId: string | null;
  readonly turnKey: string | null;
  readonly runId: string | null;
  readonly stage: string | null;
  /** `null` once the pruner removed the text (8.17); `textPrunedAt` says when. */
  readonly text: string | null;
  readonly textPrunedAt: string | null;
}

/** Vents in log order, recorded at or after `since`, optionally of one alias or one run. */
export const list = (filter: {
  readonly since?: string | undefined;
  readonly alias?: string | undefined;
  readonly runId?: string | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const blobs = yield* BlobStore;
    yield* assertCompatible;
    const rows = yield* sql<{
      seq: number;
      recordedAt: string;
      envelope: string;
      alias: string | null;
      harness: string | null;
      subagentId: string | null;
      agentType: string | null;
    }>`SELECT e.seq, e.recorded_at, e.envelope, a.alias, a.harness, a.subagent_id, a.agent_type
      FROM events e LEFT JOIN projection_actors a ON a.actor_id = e.actor_id
      WHERE e.kind IN ('vent.recorded@1', 'vent.recorded@2') AND e.recorded_at >= ${filter.since ?? ""}
      ORDER BY e.seq`;
    const vents: Array<VentView> = [];
    for (const row of rows) {
      const event = yield* decodeEnvelope(row.envelope, `event seq ${row.seq}`);
      if (event.kind !== "vent.recorded@1" && event.kind !== "vent.recorded@2")
        return yield* new CorruptRecord({
          message: `event seq ${row.seq} is indexed as a vent but holds ${event.kind}`,
        });
      const alias = row.alias ?? baseAlias(event.actor);
      if (filter.alias !== undefined && alias !== filter.alias) continue;
      if (
        filter.runId !== undefined &&
        event.attribution.runId !== filter.runId
      )
        continue;
      // A vent from before 8.17 holds its text inline; it is shown as stored.
      let text: string | null;
      let textPrunedAt: string | null = null;
      if (event.kind === "vent.recorded@1") text = event.payload.text;
      else {
        const read = yield* blobs.get(event.refs[0].ref.slice("blob:".length));
        if (read._tag === "Pruned") {
          text = null;
          textPrunedAt = read.blob.prunedAt;
        } else text = new TextDecoder().decode(read.bytes);
      }
      vents.push({
        seq: row.seq,
        id: event.id,
        recordedAt: row.recordedAt,
        occurredAt: event.occurredAt,
        actorId: event.actor,
        alias,
        harness: row.harness,
        subagent: row.subagentId !== null,
        agentType: row.agentType,
        sessionId: event.attribution.sessionId,
        reconciliationId:
          event.kind === "vent.recorded@2"
            ? (event.payload.reconciliationId ?? null)
            : null,
        turnKey: event.attribution.turnKey ?? null,
        runId: event.attribution.runId ?? null,
        stage: event.attribution.stage ?? null,
        text,
        textPrunedAt,
      });
    }
    return vents as ReadonlyArray<VentView>;
  });
