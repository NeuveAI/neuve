import {
  accountStoreRefusalMessage,
  signInCommand,
  type RuntimeFailure,
} from "@neuve/runtime";
import type { AssistantMessage, Model, Api } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { usage } from "./transcript.ts";

export const resumeFailed =
  "This chat could not be continued. Start a new chat, or continue on another model.";
/** Never forward provider text: pi would retry errors whose wording matches its heuristics. */
export function terminalText(
  failure: RuntimeFailure,
  now = Date.now(),
): string {
  switch (failure._tag) {
    case "UsageLimitReached":
      return `Usage limit reached for ${failure.account}.${failure.resetsAt ? ` Resets at ${accountTime(failure.resetsAt, now)}.` : ""}`;
    case "SignInRequired":
      return signInText(failure.account, failure.hint);
    case "AccountRejected":
      return failure.hint
        ? signInText(failure.account, failure.hint)
        : `Sign in again for ${failure.account}.`;
    case "TurnFailed":
      return "This turn did not produce an answer. Try another message.";
    case "RuntimeUnavailable":
      return `The selected account ${failure.account} cannot run here.`;
    case "AccountStoreRefused":
      return accountStoreRefusalMessage(failure);
    case "AccountNeedsNewerBuild":
      return `Account ${failure.account} needs a newer Neuve.`;
    case "AccountNotFound":
      return `The selected account ${failure.account} is no longer available.`;
    case "CapabilityUnsupported":
      return `The selected account ${failure.account} cannot continue this turn.`;
  }
}

// Copied from apps/neuve-web/packages/ui/src/neuve/settings/accounts-copy.ts, accountTime.
function accountTime(value: string, now: number): string {
  const date = new Date(value);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(Math.abs(date.getTime() - now) >= 86_400_000
      ? { weekday: "short" }
      : {}),
  });
}

function signInText(
  account: string,
  hint: Parameters<typeof signInCommand>[0],
): string {
  const command = signInCommand(hint);
  return command
    ? `Sign in for ${account}. Run ${command}.`
    : `Sign in for ${account} in Settings.`;
}
/** Account names and commands can themselves match pi's text heuristics. Preserve them verbatim without retrying. */
export function markTerminal(message: AssistantMessage): void {
  if (isRetryableAssistantError(message) || isContextOverflow(message))
    message.stopReason = "aborted";
}
export function failureStream(
  model: Model<Api>,
  text: string,
  responseId?: string,
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    provider: model.provider,
    model: model.id,
    api: model.api,
    content: [],
    usage: usage(),
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
    ...(responseId ? { responseId } : {}),
  };
  markTerminal(message);
  stream.push({
    type: "error",
    reason: message.stopReason === "aborted" ? "aborted" : "error",
    error: message,
  });
  return stream;
}
