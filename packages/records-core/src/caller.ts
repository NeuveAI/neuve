import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import {
  lineage,
  sameProcess,
  identityOf,
  snapshotProcesses,
  type Snapshot,
} from "./ancestry.ts";
import { UnknownSession } from "./errors.ts";
import {
  ACE_CHANNEL_HARNESS,
  ACE_CHAT_VARIABLE,
  AGENT_HARNESSES,
  agentFingerprint,
  isAgentHarness,
  readAceChat,
  type AgentHarness,
} from "./identity.ts";
import type { StoreLocation } from "./location.ts";
import { listSessions, type SessionState } from "./sessions.ts";

/**
 * The variable each supported harness sets to its session ID in the shells it runs (8.13). Claude
 * Code sets `CLAUDE_CODE_SESSION_ID`, the session ID its hooks report. Codex sets `CODEX_THREAD_ID`,
 * the thread ID its rollout (transcript) file is named after. Only these are read, and only a value
 * that names a live session its hooks recorded counts, so a variable that is not the hooks' session
 * ID never links anything.
 */
export const DECLARED_SESSION_VARIABLES: Readonly<
  Record<AgentHarness, string>
> = {
  "claude-code": "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_THREAD_ID",
};

/** How a `neuve` call was tied to an agent session (D23), or why it was not. Nothing here guesses. */
export type CallerResolution =
  | {
      readonly _tag: "Linked";
      /**
       * `declared` (8.13): the process table could not be read, and a session ID the harness set in
       * the environment named a live session here. It is trusted less than ancestry.
       */
      readonly method: "ancestry" | "override" | "declared";
      readonly actorId: string;
      readonly harness: string;
      readonly sessionId: string;
      readonly subagentId?: string | undefined;
      /** For a declared link, the environment variable the session ID came from. */
      readonly source?: string | undefined;
    }
  /** Several live sessions are owned by the nearest owning ancestor; none is chosen. */
  | {
      readonly _tag: "Ambiguous";
      readonly sessionIds: ReadonlyArray<string>;
    }
  /**
   * The process table could not be read, as inside agent sandboxes that forbid listing processes,
   * and the declared session IDs did not name exactly one live session here: none did, or one did
   * while another harness's variable named no live session.
   */
  | { readonly _tag: "Unavailable" }
  /** Ancestry was checked and no live agent session or Ace chat was identified. */
  | { readonly _tag: "None" };

/**
 * Parses a `--session` override: `<harness>:<session id>[/<subagent id>]` with a supported harness, or
 * a bare session ID that names exactly one live session in this store.
 */
const parseOverride = (
  override: string,
  sessions: ReadonlyArray<SessionState>,
): CallerResolution | string => {
  const match =
    /^(?<harness>[a-z][a-z0-9-]*):(?<session>[^/]+)(?:\/(?<subagent>.+))?$/.exec(
      override,
    )?.groups;
  if (match !== undefined) {
    const harness = match["harness"]!;
    // Only supported harnesses: any other name, such as `human`, would let an override mint an
    // actor that is not an agent session.
    if (!isAgentHarness(harness))
      return `Unknown harness ${harness}; expected one of ${AGENT_HARNESSES.join(", ")}`;
    const sessionId = match["session"]!;
    const subagentId = match["subagent"];
    return {
      _tag: "Linked",
      method: "override",
      actorId: agentFingerprint({ harness, sessionId, subagentId }),
      harness,
      sessionId,
      subagentId,
    };
  }
  const named = sessions.filter(
    (session) =>
      session.sessionId === override && isAgentHarness(session.harness),
  );
  if (named.length !== 1)
    return `Session ${override} is not a live session here; pass <harness>:<session id>`;
  const session = named[0]!;
  return {
    _tag: "Linked",
    method: "override",
    actorId: session.actorId,
    harness: session.harness,
    sessionId: session.sessionId,
  };
};

/**
 * The session a harness declared in the environment (8.13), used only when the process table cannot
 * be read. A declared ID counts only when it names a live session of that harness recorded here by
 * its hooks, and its actor is that session's fingerprint (harness and session ID), exactly as the
 * hooks register it. Shells inherit their parents' variables, so when two harnesses both declare a
 * live session (one started inside the other), neither is chosen; when another harness's variable is
 * also set but names no live session here, none is chosen either.
 */
const declaredSession = (
  sessions: ReadonlyArray<SessionState>,
  environment: Readonly<Record<string, string | undefined>>,
): CallerResolution => {
  const set = AGENT_HARNESSES.flatMap((harness) => {
    const source = DECLARED_SESSION_VARIABLES[harness];
    const sessionId = environment[source];
    if (sessionId === undefined || sessionId === "") return [];
    const live = sessions.some(
      (session) =>
        session.harness === harness && session.sessionId === sessionId,
    );
    return [{ harness, sessionId, source, live }];
  });
  const declared = set.filter((entry) => entry.live);
  if (declared.length > 1)
    return {
      _tag: "Ambiguous",
      sessionIds: declared.map((entry) => entry.sessionId).sort(),
    };
  // A variable naming no live session may be the calling harness's own, its session not recorded
  // here, while the other was inherited from an enclosing harness: picking the live one could
  // attribute the call to the wrong harness, so nothing is chosen.
  const only = declared[0];
  if (only === undefined || set.length > declared.length)
    return { _tag: "Unavailable" };
  return {
    _tag: "Linked",
    method: "declared",
    actorId: agentFingerprint({
      harness: only.harness,
      sessionId: only.sessionId,
    }),
    harness: only.harness,
    sessionId: only.sessionId,
    source: only.source,
  };
};

/**
 * The session the given process (this one by default) runs under. An override wins. Otherwise one
 * process-table snapshot is walked from the process upward, and the nearest ancestor recorded as a live
 * session's owner names it. An Ace channel worker owns one live session for its chats. The chat
 * variable selects a chat of that channel. When the table cannot be read, a standalone harness's
 * declared session ID may name the session (8.13).
 */
export const resolveCaller = (
  location: StoreLocation,
  options: {
    readonly override?: string | undefined;
    readonly pid?: number | undefined;
    readonly includeAceChats?: boolean | undefined;
    /** Reads the process table; `undefined` from it means the table could not be read. */
    readonly processes?: (() => Snapshot | undefined) | undefined;
    /** Where session and chat variables are read. Default: this process's environment. */
    readonly environment?:
      Readonly<Record<string, string | undefined>> | undefined;
  } = {},
): Effect.Effect<CallerResolution, UnknownSession, FileSystem> =>
  Effect.gen(function* () {
    const sessions = yield* listSessions(location);
    if (options.override !== undefined) {
      const resolved = parseOverride(options.override, sessions);
      if (typeof resolved === "string")
        return yield* new UnknownSession({
          session: options.override,
          message: resolved,
        });
      return resolved;
    }
    // The table is read first: "None" must mean the ancestry was checked, never that it could not be.
    const snapshot = (options.processes ?? snapshotProcesses)();
    if (snapshot === undefined)
      return declaredSession(sessions, options.environment ?? process.env);
    const owned = sessions.filter(
      (session) =>
        session.owner !== undefined &&
        (options.includeAceChats !== false ||
          session.harness !== ACE_CHANNEL_HARNESS),
    );
    for (const row of lineage(snapshot, options.pid ?? process.pid)) {
      const identity = identityOf(row);
      const matches = owned.filter((session) =>
        sameProcess(session.owner!, identity),
      );
      if (matches.length === 1) {
        const session = matches[0]!;
        if (session.harness === ACE_CHANNEL_HARNESS) {
          const chat = readAceChat(
            session.sessionId,
            (options.environment ?? process.env)[ACE_CHAT_VARIABLE],
          );
          return chat === undefined
            ? { _tag: "None" }
            : { _tag: "Linked", method: "ancestry", ...chat };
        }
        return {
          _tag: "Linked",
          method: "ancestry",
          actorId: session.actorId,
          harness: session.harness,
          sessionId: session.sessionId,
        };
      }
      if (matches.length > 1) {
        return {
          _tag: "Ambiguous",
          sessionIds: matches.map((session) => session.sessionId).sort(),
        };
      }
    }
    return { _tag: "None" };
  });
