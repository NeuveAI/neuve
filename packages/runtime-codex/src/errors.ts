import { TurnFailed, type AccountName } from "@neuve/runtime";
import { Data } from "effect";
import { redact } from "./redact.ts";

export class CodexSignInFileError extends TurnFailed {
  constructor(
    account: AccountName,
    readonly fix: string,
  ) {
    super({ account, reason: "provider-unavailable" });
  }
}

/** The program could not be started at all. */
export class CodexSpawnFailed extends Data.TaggedError("CodexSpawnFailed")<{
  readonly reason: string;
}> {}

/** A line that is not JSON, or JSON that is not a request, response or notification. */
export class CodexMalformedLine extends Data.TaggedError("CodexMalformedLine")<{
  readonly reason: "json" | "shape";
  readonly bytes: number;
}> {}

/** A line longer than the client's limit; nothing after it can be framed, so the connection ends. */
export class CodexOversizedLine extends Data.TaggedError("CodexOversizedLine")<{
  readonly limit: number;
}> {}

/**
 * A message this release's types do not have, or a response to no pending request. It never fails
 * the connection: each kind is logged once and ignored, and a request is answered as unsupported.
 */
export class CodexUnknownMessage extends Data.TaggedError(
  "CodexUnknownMessage",
)<{
  readonly kind: "notification" | "request" | "response";
  readonly method: string;
}> {}

/**
 * Text the program wrote, redacted, on a field that is not enumerable: a log line or a JSON dump of
 * the failure leaves it out, and only a reader that asks for it gets it.
 */
const withText = <E extends object>(error: E, field: string, text: string) =>
  Object.defineProperty(error, field, {
    value: String(redact(text, [])),
    enumerable: false,
  });

/**
 * Codex answered a request with an error. `type` is Codex's own reason from `error.data.type`
 * (such as `modelProviderNotConfigured`), which the runtime maps onto the contract's failures.
 * `message` is Codex's own text, redacted and not enumerable.
 */
export class CodexRequestFailed extends Data.TaggedError("CodexRequestFailed")<{
  readonly method: string;
  readonly code: number;
  readonly type?: string;
}> {
  declare readonly message: string;
  static of(
    fields: ConstructorParameters<typeof CodexRequestFailed>[0],
    text: string,
  ) {
    return withText(new CodexRequestFailed(fields), "message", text);
  }
}

const withTail = <E extends object>(error: E, tail: string) =>
  withText(error, "stderrTail", tail);

/** The process ended while the client still needed it. */
export class CodexExited extends Data.TaggedError("CodexExited")<{
  readonly method?: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}> {
  declare readonly stderrTail: string;
  static of(
    fields: ConstructorParameters<typeof CodexExited>[0],
    tail: string,
  ) {
    return withTail(new CodexExited(fields), tail);
  }
}

/**
 * Standard output ended while the program still ran (`closed`), or reading it failed (`defect`):
 * nothing more can be read, so the connection ends and the program is stopped.
 */
export class CodexOutputEnded extends Data.TaggedError("CodexOutputEnded")<{
  readonly reason: "closed" | "defect";
  readonly method?: string;
}> {
  declare readonly stderrTail: string;
  static of(
    fields: ConstructorParameters<typeof CodexOutputEnded>[0],
    tail: string,
  ) {
    return withTail(new CodexOutputEnded(fields), tail);
  }
}

/** `initialize` had no answer in time; the process is stopped. */
export class CodexHandshakeTimeout extends Data.TaggedError(
  "CodexHandshakeTimeout",
)<{}> {
  declare readonly stderrTail: string;
  static of(tail: string) {
    return withTail(new CodexHandshakeTimeout(), tail);
  }
}

/**
 * A request or notification the program can no longer be sent: after the client was closed, or
 * when its input was refused while it still ran.
 */
export class CodexClosed extends Data.TaggedError("CodexClosed")<{
  readonly method: string;
}> {}

/**
 * The program stopped taking input while it still ran. What was not written is lost, so the
 * connection ends: nothing later can be known to follow it.
 */
export class CodexInputRefused extends Data.TaggedError("CodexInputRefused")<{
  readonly method?: string;
}> {}

/**
 * More notifications waited unread than the reader's bound: the reader has stopped keeping up, so
 * the connection ends rather than hold them without limit.
 */
export class CodexBacklog extends Data.TaggedError("CodexBacklog")<{
  readonly limit: number;
}> {}

/** What ends a connection on its own: every pending request fails with it. */
export type CodexTermination =
  | CodexMalformedLine
  | CodexOversizedLine
  | CodexExited
  | CodexOutputEnded
  | CodexInputRefused
  | CodexBacklog;

export type CodexFailure = CodexTermination | CodexRequestFailed | CodexClosed;
