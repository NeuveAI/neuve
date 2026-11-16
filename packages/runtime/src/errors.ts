import { Data } from "effect";
import { z } from "zod";
import { AccountName } from "./account.ts";
import {
  AccountRejectedReason,
  LimitWindow,
  RuntimeUnavailableReason,
  SignInHint,
} from "./status.ts";

export const RuntimeCapability = z.enum([
  "ownsLoop", // The runtime runs its model loop and calls Neuve's tool handlers.
  "resume",
  "fork",
  "interrupt",
  "modelSwitchInSession",
  "structuredOutput",
  // The ruling's "steer" capability keeps its existing contract name.
  "steering",
  "approvals",
  "perRequestTelemetry",
  "byteExactCapture",
  "nativeToolServer",
  "statusProbe",
  "internalRetries",
]);
export type RuntimeCapability = z.infer<typeof RuntimeCapability>;
export const TurnFailureReason = z.enum([
  "turn-limit-reached",
  "context-overflow",
  "no-output-schema",
  "structured-output-missing",
  "structured-output-invalid",
  "provider-failed",
  "provider-unavailable",
  "protocol-error",
  "session-stopped",
  "previous-turn-active",
]);
export type TurnFailureReason = z.infer<typeof TurnFailureReason>;

export const AccountStoreProblem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("symbolic-link") }),
  z.strictObject({ kind: z.literal("not-folder") }),
  z.strictObject({ kind: z.literal("writable-by-others") }),
  z.strictObject({ kind: z.literal("wrong-owner") }),
  z.strictObject({
    kind: z.literal("private-permissions"),
    permission: z.enum(["read", "written", "accessed"]),
    mode: z.string().regex(/^[0-7]{4}$/),
  }),
  z.strictObject({ kind: z.literal("unreadable") }),
]);
export type AccountStoreProblem = z.infer<typeof AccountStoreProblem>;

export const AccountStoreRefusal = z.strictObject({
  folder: z.string(),
  problem: AccountStoreProblem,
});
export type AccountStoreRefusal = z.infer<typeof AccountStoreRefusal>;

export function accountStoreRefusalMessage({
  folder,
  problem,
}: AccountStoreRefusal): string {
  switch (problem.kind) {
    case "symbolic-link":
      return `${folder} is a symbolic link.`;
    case "not-folder":
      return `${folder} is not a folder.`;
    case "writable-by-others":
      return `${folder} is writable by other users. Neuve needs it writable only by you.`;
    case "wrong-owner":
      return `${folder} is owned by another user.`;
    case "private-permissions":
      return `${folder} can be ${problem.permission} by other users (mode ${problem.mode}). Neuve keeps account folders readable only by you (0700).`;
    case "unreadable":
      return `${folder} could not be read.`;
  }
}

export const RuntimeFailure = z.discriminatedUnion("_tag", [
  z.strictObject({
    _tag: z.literal("SignInRequired"),
    account: AccountName,
    hint: SignInHint,
  }),
  z.strictObject({
    _tag: z.literal("AccountRejected"),
    account: AccountName,
    hint: SignInHint.optional(),
    reason: AccountRejectedReason.optional(),
  }),
  z.strictObject({
    _tag: z.literal("UsageLimitReached"),
    account: AccountName,
    /** Same window fields as status and events; omitted when the runtime cannot identify the limit. */
    ...LimitWindow.partial().shape,
  }),
  z.strictObject({
    _tag: z.literal("RuntimeUnavailable"),
    account: AccountName,
    reason: RuntimeUnavailableReason,
  }),
  z.strictObject({ _tag: z.literal("AccountNotFound"), account: AccountName }),
  z.strictObject({
    _tag: z.literal("AccountNeedsNewerBuild"),
    account: AccountName,
  }),
  z.strictObject({
    _tag: z.literal("AccountStoreRefused"),
    account: AccountName,
    ...AccountStoreRefusal.shape,
  }),
  z.strictObject({
    _tag: z.literal("CapabilityUnsupported"),
    account: AccountName,
    capability: RuntimeCapability,
  }),
  z.strictObject({
    _tag: z.literal("TurnFailed"),
    account: AccountName,
    reason: TurnFailureReason,
  }),
]);
export type RuntimeFailure = z.infer<typeof RuntimeFailure>;
type Fields<Tag extends RuntimeFailure["_tag"]> = Omit<
  Extract<RuntimeFailure, { _tag: Tag }>,
  "_tag"
>;

export class SignInRequired extends Data.TaggedError("SignInRequired")<
  Fields<"SignInRequired">
> {
  override get message() {
    return "Sign-in required.";
  }
}
export class AccountRejected extends Data.TaggedError("AccountRejected")<
  Fields<"AccountRejected">
> {
  override get message() {
    return "Account credential rejected.";
  }
}
export class UsageLimitReached extends Data.TaggedError("UsageLimitReached")<
  Fields<"UsageLimitReached">
> {
  override get message() {
    return "Account usage limit reached.";
  }
}
export class RuntimeUnavailable extends Data.TaggedError("RuntimeUnavailable")<
  Fields<"RuntimeUnavailable">
> {
  override get message() {
    return `Runtime unavailable: ${this.reason}.`;
  }
}
export class AccountNotFound extends Data.TaggedError("AccountNotFound")<
  Fields<"AccountNotFound">
> {
  override get message() {
    return "Account not found.";
  }
}
export class AccountNeedsNewerBuild extends Data.TaggedError(
  "AccountNeedsNewerBuild",
)<Fields<"AccountNeedsNewerBuild">> {
  override get message() {
    return `Account ${this.account} needs a newer Neuve.`;
  }
}
/** Account and store refusals recover as soon as the directory can read the account. */
export const accountReadRefused = (
  failure: Pick<RuntimeFailure, "_tag">,
): boolean =>
  failure._tag === "AccountNeedsNewerBuild" ||
  failure._tag === "AccountStoreRefused";

export class AccountStoreRefused extends Data.TaggedError(
  "AccountStoreRefused",
)<Fields<"AccountStoreRefused">> {
  override get message() {
    return accountStoreRefusalMessage(this);
  }
}
export class CapabilityUnsupported extends Data.TaggedError(
  "CapabilityUnsupported",
)<Fields<"CapabilityUnsupported">> {
  override get message() {
    return `Runtime capability unsupported: ${this.capability}.`;
  }
}
export class TurnFailed extends Data.TaggedError("TurnFailed")<
  Fields<"TurnFailed">
> {
  override get message() {
    return `Turn failed: ${this.reason}.`;
  }
}
export type RuntimeError =
  | SignInRequired
  | AccountRejected
  | UsageLimitReached
  | RuntimeUnavailable
  | AccountNotFound
  | AccountNeedsNewerBuild
  | AccountStoreRefused
  | CapabilityUnsupported
  | TurnFailed;

function projectSignInHint(hint: SignInHint): SignInHint {
  if (hint.kind === "settings") return { kind: hint.kind, entry: hint.entry };
  switch (hint.command) {
    case "claude auth login":
      return {
        kind: hint.kind,
        command: hint.command,
        ...(hint.environment === undefined
          ? {}
          : {
              environment: {
                CLAUDE_CONFIG_DIR: hint.environment.CLAUDE_CONFIG_DIR,
              },
            }),
      };
    case "neuve auth login":
      return { kind: hint.kind, command: hint.command, account: hint.account };
  }
}

/** Project only contract fields; Error stack and any incidental properties never cross the seam. */
export function runtimeErrorToFailure(error: RuntimeError): RuntimeFailure {
  const { account } = error;
  switch (error._tag) {
    case "SignInRequired":
      return { _tag: error._tag, account, hint: projectSignInHint(error.hint) };
    case "AccountRejected":
      return {
        _tag: error._tag,
        account,
        ...(error.hint === undefined
          ? {}
          : { hint: projectSignInHint(error.hint) }),
        ...(error.reason === undefined ? {} : { reason: error.reason }),
      };
    case "UsageLimitReached":
      return {
        _tag: error._tag,
        account,
        ...(error.window === undefined ? {} : { window: error.window }),
        ...(error.model === undefined ? {} : { model: error.model }),
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.utilization === undefined
          ? {}
          : { utilization: error.utilization }),
        ...(error.resetsAt === undefined ? {} : { resetsAt: error.resetsAt }),
        ...(error.observedAt === undefined
          ? {}
          : { observedAt: error.observedAt }),
      };
    case "AccountStoreRefused":
      return {
        _tag: error._tag,
        account,
        folder: error.folder,
        problem:
          error.problem.kind === "private-permissions"
            ? {
                kind: error.problem.kind,
                permission: error.problem.permission,
                mode: error.problem.mode,
              }
            : { kind: error.problem.kind },
      };
    case "RuntimeUnavailable":
      return { _tag: error._tag, account, reason: error.reason };
    case "AccountNeedsNewerBuild":
    case "AccountNotFound":
      return { _tag: error._tag, account };
    case "CapabilityUnsupported":
      return { _tag: error._tag, account, capability: error.capability };
    case "TurnFailed":
      return { _tag: error._tag, account, reason: error.reason };
  }
}

export function runtimeFailureToError(failure: RuntimeFailure): RuntimeError {
  switch (failure._tag) {
    case "SignInRequired":
      return new SignInRequired(failure);
    case "AccountRejected":
      return new AccountRejected(failure);
    case "UsageLimitReached":
      return new UsageLimitReached(failure);
    case "RuntimeUnavailable":
      return new RuntimeUnavailable(failure);
    case "AccountNeedsNewerBuild":
      return new AccountNeedsNewerBuild(failure);
    case "AccountStoreRefused":
      return new AccountStoreRefused(failure);
    case "AccountNotFound":
      return new AccountNotFound(failure);
    case "CapabilityUnsupported":
      return new CapabilityUnsupported(failure);
    case "TurnFailed":
      return new TurnFailed(failure);
  }
}
