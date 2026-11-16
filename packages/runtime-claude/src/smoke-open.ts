import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Effect, Exit } from "effect";
import type { ClaudeSdkError } from "./services.ts";

const markers = [
  ["noConversation", "no conversation found"],
  ["noMessageAtUuid", "no message found with message.uuid"],
  ["dropGuardRefused", "would discard entries"],
  ["notAUuid", "is not a uuid"],
  ["resumeLoadFailed", "resume load failed"],
  ["resumeLoadFailed", "session load failed"],
  ["jsonSchemaNotJson", "--json-schema is not valid json"],
  ["jsonSchemaNotObject", "--json-schema must be a json object"],
  ["invalidSessionId", "invalid session id"],
  ["resumeNeedsValidId", "requires a valid session id"],
  ["sessionIdInUse", "already in use"],
  ["cannotBeCombined", "cannot be combined with"],
  ["requiresResume", "requires --resume"],
  ["noMessagesReturned", "no messages returned from query"],
  ["notValidJson", "is not valid json"],
  ["invalidSchema", "invalid schema"],
  ["schemaConversion", "json schema"],
] as const;

// SDK 0.3.316 sdk.mjs:152, Iv.initialize(), F6() and $6().
// extraArgs accepts arbitrary keys; those outside this fixed list remain otherFlag.
const allowedFlags = [
  "--output-format",
  "--verbose",
  "--input-format",
  "--thinking",
  "--max-thinking-tokens",
  "--thinking-display",
  "--effort",
  "--max-turns",
  "--max-budget-usd",
  "--task-budget",
  "--model",
  "--agent",
  "--betas",
  "--json-schema",
  "--debug-file",
  "--debug",
  "--permission-prompt-tool",
  "--permission-prompts",
  "--continue",
  "--resume",
  "--channels",
  "--allowedTools",
  "--disallowedTools",
  "--tools",
  "--mcp-config",
  "--setting-sources",
  "--strict-mcp-config",
  "--permission-mode",
  "--allow-dangerously-skip-permissions",
  "--fallback-model",
  "--include-hook-events",
  "--include-partial-messages",
  "--session-mirror",
  "--project-config-root",
  "--add-dir",
  "--await-initialize",
  "--plugin-dir-no-mcp",
  "--plugin-dir",
  "--fork-session",
  "--resume-session-at",
  "--resume-drops-turn",
  "--session-id",
  "--no-session-persistence",
  "--managed-settings",
  "--settings",
  "--print",
  "--workload",
  "--await-claim",
] as const;

/** Store classifier state only; no stderr line or chunk survives the callback. */
const stderrObservation = () => {
  let stderrLines = 0;
  let partialLine = false;
  let token = "";
  let oversized = false;
  let firstTokenSeen = false;
  let errorToken: string | undefined;
  let marker: (typeof markers)[number][0] | undefined;
  const progress = markers.map(() => 0);
  let flag: (typeof allowedFlags)[number] | undefined;
  let otherFlag = false;
  let errorPrefix = false;
  let prefixLength = 0;
  let dashes = 0;
  let flagLength = 0;
  let candidates: readonly (typeof allowedFlags)[number][] = allowedFlags;
  const endFlag = () => {
    if (flagLength >= 2) {
      const known = candidates.find((name) => name.length === flagLength + 2);
      if (known === undefined) otherFlag = true;
      else flag ??= known;
    }
    dashes = 0;
    flagLength = 0;
    candidates = allowedFlags;
  };
  const receiveFlag = (char: string) => {
    if (dashes === 1 && char === "-") {
      dashes = 2;
    } else if (
      dashes === 2 &&
      (flagLength === 0 ? /[a-z]/ : /[a-z-]/).test(char)
    ) {
      candidates = candidates.filter((name) => name[flagLength + 2] === char);
      flagLength++;
      if (flagLength === 41) endFlag();
    } else {
      endFlag();
      if (char === "-") dashes = 1;
    }
  };
  const endToken = () => {
    if (
      !firstTokenSeen &&
      !oversized &&
      /^(?:[A-Z][A-Za-z]{1,38}(?:Error|Exception)|E[A-Z]{3,15})$/.test(token)
    ) {
      firstTokenSeen = true;
      if (/^[a-z][a-z0-9_]{0,39}$/i.test(token)) errorToken = token;
    }
    token = "";
    oversized = false;
  };
  return {
    receive: (chunk: string) => {
      for (const char of chunk) {
        receiveFlag(char);
        if (prefixLength >= 0 && prefixLength < 6) {
          if (char === "Error:"[prefixLength]) {
            prefixLength++;
            if (prefixLength === 6) errorPrefix = true;
          } else prefixLength = -1;
        }
        if (char === "\n") {
          stderrLines++;
          prefixLength = 0;
          partialLine = false;
        } else partialLine = true;
        if (/\w/.test(char)) {
          if (token.length < 48) token += char;
          else oversized = true;
        } else endToken();
        if (marker !== undefined) continue;
        const lower = char.toLowerCase();
        for (const [index, [name, phrase]] of markers.entries()) {
          const count = progress[index] ?? 0;
          // Retain only a prefix length, including overlapping candidate prefixes.
          const candidate = phrase.slice(0, count) + lower;
          let next = Math.min(phrase.length, candidate.length);
          while (next > 0 && !candidate.endsWith(phrase.slice(0, next))) next--;
          progress[index] = next;
          if (next === phrase.length) {
            marker = name;
            break;
          }
        }
      }
    },
    snapshot: () => {
      endToken();
      endFlag();
      return {
        errorPrefix,
        otherFlag,
        ...(flag === undefined ? {} : { flag }),
        stderrLines: stderrLines + Number(partialLine),
        ...(marker === undefined ? {} : { marker }),
        ...(errorToken === undefined ? {} : { errorToken }),
      };
    },
  };
};

type OpenStep =
  "sdkOpen" | "initialization" | "effortUpdate" | "timeout" | "ready";
export const smokeOpenObservation = (options: Options) => {
  let step: OpenStep = "timeout";
  let exit: Pick<ClaudeSdkError, "errorClass" | "exitCode" | "signal"> = {};
  let sendWithheld = false;
  const stderr = stderrObservation();
  const flags = {
    resume: options.resume !== undefined,
    resumeSessionAt: options.resumeSessionAt !== undefined,
    sessionId: options.sessionId !== undefined,
    forkSession: options.forkSession === true,
    continue: options.continue === true,
    outputFormat: options.outputFormat !== undefined,
  };
  return {
    stderr: stderr.receive,
    withhold: () => {
      sendWithheld = true;
    },
    track: <A, E, R>(
      name: Exclude<OpenStep, "timeout" | "ready">,
      effect: Effect.Effect<A, E, R>,
      contain: (action: () => void) => void,
    ) =>
      Effect.suspend(() => {
        contain(() => {
          step = "timeout";
        });
        return effect.pipe(
          Effect.onExit((outcome) =>
            Effect.sync(() =>
              contain(() => {
                if (Exit.isSuccess(outcome)) {
                  if (name !== "sdkOpen") step = "ready";
                } else {
                  const failure = outcome.cause.reasons.find(
                    Cause.isFailReason,
                  );
                  const defect = outcome.cause.reasons.find(Cause.isDieReason);
                  if (failure !== undefined || defect !== undefined)
                    step = name;
                  const error = failure?.error;
                  if (error !== null && typeof error === "object") {
                    const errorClass =
                      "errorClass" in error ? error.errorClass : undefined;
                    const exitCode =
                      "exitCode" in error ? error.exitCode : undefined;
                    const signal = "signal" in error ? error.signal : undefined;
                    exit = {
                      ...(typeof errorClass === "string" &&
                      /^[a-z][a-z0-9_]{0,39}$/i.test(errorClass)
                        ? { errorClass }
                        : {}),
                      ...(typeof exitCode === "number" &&
                      Number.isInteger(exitCode)
                        ? { exitCode }
                        : {}),
                      ...(typeof signal === "string" &&
                      /^SIG[A-Z0-9]{1,8}$/.test(signal)
                        ? { signal }
                        : {}),
                    };
                  }
                }
              }),
            ),
          ),
        );
      }),
    snapshot: () => ({
      step,
      options: flags,
      child: {
        ...stderr.snapshot(),
        exited:
          exit.errorClass === "process_exited_nonzero" ||
          exit.errorClass === "process_killed_by_signal",
        ...exit,
      },
    }),
    get sendWithheld() {
      return sendWithheld;
    },
  };
};
export type SmokeOpenObservation = ReturnType<typeof smokeOpenObservation>;
