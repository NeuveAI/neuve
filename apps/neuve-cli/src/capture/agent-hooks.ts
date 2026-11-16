import { open, stat } from "node:fs/promises";
import { Effect } from "effect";
import { z } from "zod";
import type { RecordEvent } from "@neuve/records-schema";
import {
  Ancestry,
  Identity,
  Sessions,
  mintUlid,
  type StoreLocation,
} from "@neuve/records-core/capture";
import { captureEvent, defined, registration } from "./events.ts";

export const AGENT_HARNESSES = Identity.AGENT_HARNESSES;
export type AgentHarness = Identity.AgentHarness;

export const AGENT_HOOK_EVENTS = [
  "session-start",
  "user-prompt-submit",
  "stop",
  "subagent-start",
  "subagent-stop",
  "session-end",
] as const;
export type AgentHookEvent = (typeof AGENT_HOOK_EVENTS)[number];

const text = z.string().min(1);
/** Claude Code reports `model` as a string on some events; accept an `{ id }` object too. */
const model = z
  .union([text, z.looseObject({ id: text }).transform((m) => m.id)])
  .optional()
  .catch(undefined);

/**
 * The fields capture reads from a Claude Code or Codex hook payload (entire-cli's
 * `agent/claudecode/types.go` and `agent/codex/types.go` list them). Unknown fields, the prompt among
 * them, are dropped by parsing and never read (D25).
 */
export const HookPayload = z.object({
  session_id: text,
  transcript_path: text.nullish().catch(undefined),
  cwd: text.optional().catch(undefined),
  source: text.optional().catch(undefined),
  reason: text.optional().catch(undefined),
  model,
  turn_id: text.optional().catch(undefined),
  agent_id: text.optional().catch(undefined),
  agent_type: text.optional().catch(undefined),
  agent_transcript_path: text.nullish().catch(undefined),
});
export type HookPayload = z.infer<typeof HookPayload>;

const TAIL_BYTES = 256 * 1024;

/**
 * The model of the last assistant message in a Claude Code transcript, read from the file's tail. Only
 * that string is kept; the transcript's content is session data that S5 captures as a blob (D25).
 */
export const lastTranscriptModel = async (
  path: string | null | undefined,
): Promise<string | undefined> => {
  if (path === undefined || path === null) return undefined;
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n").reverse();
      for (const line of lines) {
        if (!line.includes('"assistant"')) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: unknown;
            message?: { model?: unknown };
          };
          const found = entry.message?.model;
          if (entry.type === "assistant" && typeof found === "string")
            return found;
        } catch {
          // The first line of the tail is usually cut; skip anything that is not whole JSON.
        }
      }
      return undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

/**
 * The transcript's size now, which bounds the segment `transcript.capture` copies (one `stat`, so the
 * hook stays fast). Absent when there is no transcript or it cannot be read.
 */
export const transcriptSize = async (
  path: string | null | undefined,
): Promise<number | undefined> => {
  if (path === undefined || path === null) return undefined;
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
};

interface Context {
  readonly location: StoreLocation;
  readonly harness: AgentHarness;
  readonly payload: HookPayload;
}

/**
 * The session's state, creating it (and registering its actor) when this is the first hook seen for
 * the session, as when hooks were installed after it started. The owner is the agent process that ran
 * this hook, recorded for ancestry matching (D23).
 */
const sessionState = ({ location, harness, payload }: Context) =>
  Effect.gen(function* () {
    const sessionId = payload.session_id;
    const known = yield* Sessions.readSession(location, harness, sessionId);
    if (known !== undefined)
      return { state: known, events: [] as Array<RecordEvent> };
    const actorId = Identity.agentFingerprint({ harness, sessionId });
    const snapshot = Ancestry.snapshotProcesses();
    const owner =
      snapshot === undefined ? undefined : Ancestry.hookOwner(snapshot);
    const state: Sessions.SessionState = defined({
      version: 1 as const,
      harness,
      sessionId,
      actorId,
      owner,
      turnKey: undefined,
    });
    return {
      state,
      events: [
        registration(actorId, {
          actorKind: "agent",
          harness,
          sessionId,
        }),
      ],
    };
  });

const turnIdempotency = (
  harness: string,
  sessionId: string,
  subagentId: string | undefined,
  turnKey: string,
  edge: "start" | "end",
) =>
  `${harness}:${sessionId}${subagentId === undefined ? "" : `/${subagentId}`}:turn:${turnKey}:${edge}`;

/**
 * Turns one agent hook into the events it records and updates the session's capture state. Every
 * event goes to the spool only; nothing here opens SQLite (D18).
 */
export const captureAgentHook = (event: AgentHookEvent, context: Context) =>
  Effect.gen(function* () {
    const { location, harness, payload } = context;
    const sessionId = payload.session_id;
    const attribution = { sessionId };
    const { state, events } = yield* sessionState(context);

    switch (event) {
      case "session-start": {
        // A resumed session may run in another process, so a known session's owner is re-read.
        let owner = state.owner;
        if (events.length === 0) {
          const snapshot = Ancestry.snapshotProcesses();
          owner =
            snapshot === undefined ? undefined : Ancestry.hookOwner(snapshot);
        }
        yield* Sessions.writeSession(location, defined({ ...state, owner }));
        events.push(
          captureEvent({
            kind: "session.started@1",
            idempotencyKey: (id) =>
              `${harness}:${sessionId}:session-start:${id}`,
            actor: state.actorId,
            attribution,
            payload: defined({
              harness,
              source: payload.source,
              model: payload.model,
              transcriptPath: payload.transcript_path ?? undefined,
            }),
          }),
        );
        return events;
      }
      case "user-prompt-submit": {
        const turnKey = payload.turn_id ?? mintUlid();
        yield* Sessions.writeSession(location, { ...state, turnKey });
        const transcriptPath = payload.transcript_path ?? undefined;
        const transcriptOffset = yield* Effect.promise(() =>
          transcriptSize(transcriptPath),
        );
        events.push(
          captureEvent({
            kind: "turn.started@1",
            idempotencyKey: () =>
              turnIdempotency(harness, sessionId, undefined, turnKey, "start"),
            actor: state.actorId,
            attribution: { sessionId, turnKey },
            payload: defined({
              harness,
              model: payload.model,
              ...(transcriptOffset === undefined
                ? {}
                : { transcriptPath, transcriptOffset }),
            }),
          }),
        );
        return events;
      }
      case "stop": {
        const turnKey = payload.turn_id ?? state.turnKey;
        const { turnKey: _closed, ...rest } = state;
        yield* Sessions.writeSession(location, rest);
        // A turn that began before the hooks were installed has no start to close.
        if (turnKey === undefined) return events;
        const turnModel =
          payload.model ??
          (yield* Effect.promise(() =>
            lastTranscriptModel(payload.transcript_path),
          ));
        events.push(
          captureEvent({
            kind: "turn.ended@1",
            idempotencyKey: () =>
              turnIdempotency(harness, sessionId, undefined, turnKey, "end"),
            actor: state.actorId,
            attribution: { sessionId, turnKey },
            payload: defined({
              harness,
              model: turnModel,
              transcriptPath: payload.transcript_path ?? undefined,
              transcriptOffset: yield* Effect.promise(() =>
                transcriptSize(payload.transcript_path),
              ),
            }),
          }),
        );
        return events;
      }
      case "subagent-start":
      case "subagent-stop": {
        const subagentId = payload.agent_id;
        if (subagentId === undefined) return events;
        if (events.length > 0) yield* Sessions.writeSession(location, state);
        const actorId = Identity.agentFingerprint({
          harness,
          sessionId,
          subagentId,
        });
        const sub = yield* Sessions.readSubagent(
          location,
          harness,
          sessionId,
          subagentId,
        );
        // Registered when it starts, or at its stop if its start was never seen.
        if (event === "subagent-start" || sub === undefined) {
          events.push(
            registration(actorId, {
              actorKind: "agent",
              harness,
              sessionId,
              subagentId,
              parentActor: state.actorId,
              agentType: payload.agent_type,
            }),
          );
        }
        if (event === "subagent-start") {
          // A subagent run is one turn of the subagent actor.
          const turnKey = `subagent:${mintUlid()}`;
          yield* Sessions.writeSubagent(location, harness, sessionId, {
            version: 1,
            subagentId,
            actorId,
            turnKey,
          });
          events.push(
            captureEvent({
              kind: "turn.started@1",
              idempotencyKey: () =>
                turnIdempotency(
                  harness,
                  sessionId,
                  subagentId,
                  turnKey,
                  "start",
                ),
              actor: actorId,
              attribution: { sessionId, turnKey },
              payload: defined({ harness, model: payload.model }),
            }),
          );
          return events;
        }
        yield* Sessions.writeSubagent(location, harness, sessionId, {
          version: 1,
          subagentId,
          actorId,
        });
        if (sub?.turnKey === undefined) return events;
        const turnKey = sub.turnKey;
        const turnModel =
          payload.model ??
          (yield* Effect.promise(() =>
            lastTranscriptModel(payload.agent_transcript_path),
          ));
        events.push(
          captureEvent({
            kind: "turn.ended@1",
            idempotencyKey: () =>
              turnIdempotency(harness, sessionId, subagentId, turnKey, "end"),
            actor: actorId,
            attribution: { sessionId, turnKey },
            payload: defined({
              harness,
              model: turnModel,
              transcriptPath: payload.agent_transcript_path ?? undefined,
              transcriptOffset: yield* Effect.promise(() =>
                transcriptSize(payload.agent_transcript_path),
              ),
            }),
          }),
        );
        return events;
      }
      case "session-end": {
        yield* Sessions.removeSession(location, harness, sessionId);
        events.push(
          captureEvent({
            kind: "session.ended@1",
            idempotencyKey: (id) => `${harness}:${sessionId}:session-end:${id}`,
            actor: state.actorId,
            attribution,
            payload: defined({
              harness,
              reason: payload.reason,
              transcriptPath: payload.transcript_path ?? undefined,
              transcriptOffset: yield* Effect.promise(() =>
                transcriptSize(payload.transcript_path),
              ),
            }),
          }),
        );
        return events;
      }
    }
  });
