import {
  CapabilityUnsupported,
  RuntimeUnavailable,
  type Account,
  type CredentialReference,
  type RuntimeCapabilities,
  type RuntimeShape,
  type SignInState,
} from "@neuve/runtime";
import { Effect } from "effect";
import {
  OpenAiAuthError,
  signInProblem,
  signOut,
  status,
  TOKEN_COMMAND_VARIABLE,
  type AuthOptions,
} from "../openai-auth.ts";
import { isClaudeSubscriptionToken } from "../subscription-token.ts";

export interface PiStatusRuntimeOptions {
  readonly auth?: AuthOptions;
  readonly localAuthDiagnostics?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Presence only, without prompting, including Keychain dialogs. */
  readonly keyPresence?: (
    reference: Extract<CredentialReference, { kind: "environment" | "vault" }>,
  ) => Promise<"absent" | "present" | "subscription-token">;
}

const capabilities: RuntimeCapabilities = {
  ownsLoop: false,
  toolEndsTurn: false,
  resumeInTurn: false,
  perMessageUsage: false,
  resume: false,
  fork: false,
  interrupt: false,
  modelSwitchInSession: false,
  structuredOutput: false,
  steering: false,
  approvals: false,
  perRequestTelemetry: false,
  ownTools: false,
  byteExactCapture: false,
  nativeToolServer: false,
  statusProbe: true,
  internalRetries: false,
};

export function piStatusRuntime(
  options: PiStatusRuntimeOptions = {},
): RuntimeShape {
  const environment = options.environment ?? process.env;
  const keyPresence: NonNullable<PiStatusRuntimeOptions["keyPresence"]> =
    options.keyPresence ??
    (async (reference) => {
      const value =
        environment[
          reference.kind === "environment"
            ? reference.variable
            : reference.entry
        ];
      return value === undefined || value.trim() === ""
        ? "absent"
        : isClaudeSubscriptionToken(value)
          ? "subscription-token"
          : "present";
    });
  const authOptions = (
    account: Extract<Account, { kind: "chatgpt-subscription" }>,
  ): AuthOptions => ({
    ...options.auth,
    directory: account.credential.folder ?? options.auth?.directory,
  });
  return {
    kind: "pi",
    capabilities: () => Effect.succeed(capabilities),
    openSession: (account) =>
      Effect.fail(
        new CapabilityUnsupported({
          account: account.name,
          capability: "ownsLoop",
        }),
      ),
    continuation: (account) => {
      const reference = account.credential;
      const name =
        reference.kind === "environment"
          ? reference.variable
          : reference.kind === "vault"
            ? reference.entry
            : (reference.folder ?? "default");
      return { runtime: "pi", key: JSON.stringify([reference.kind, name]) };
    },
    probe: (account) =>
      Effect.gen(function* () {
        let signIn: SignInState;
        switch (account.kind) {
          case "chatgpt-subscription": {
            try {
              const auth = authOptions(account);
              const problem = signInProblem(auth);
              // AuthOptions selects a command only when no folder was supplied,
              // unless the caller explicitly overrides tokenCommand.
              const command =
                auth.tokenCommand === null
                  ? undefined
                  : (auth.tokenCommand ??
                    (auth.directory === undefined
                      ? process.env[TOKEN_COMMAND_VARIABLE]
                      : undefined));
              const current = command ? undefined : status(auth);
              signIn =
                problem === undefined
                  ? {
                      state: "signed-in",
                      credentialSource: "neuve-sign-in",
                      ...(current?.email === undefined
                        ? {}
                        : { email: current.email }),
                    }
                  : {
                      state: "not-signed-in",
                      hint: {
                        kind: "command",
                        command: "neuve auth login",
                        account: account.name,
                      },
                    };
            } catch (error) {
              if (
                options.localAuthDiagnostics &&
                error instanceof OpenAiAuthError
              )
                yield* Effect.logError(error.message);
              signIn = { state: "unknown", reason: "check-failed" };
            }
            break;
          }
          case "anthropic-api-key":
          case "openai-api-key": {
            const reference = account.credential;
            const hint = { kind: "settings", entry: "accounts" } as const;
            const presence = yield* Effect.tryPromise({
              try: () => keyPresence(reference),
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined));
            signIn =
              presence === undefined
                ? { state: "unknown", reason: "check-failed" }
                : presence === "absent"
                  ? { state: "not-signed-in", hint }
                  : account.kind === "anthropic-api-key" &&
                      presence === "subscription-token"
                    ? { state: "credential-rejected", reason: "other", hint }
                    : { state: "signed-in", credentialSource: reference.kind };
            break;
          }
          case "claude-subscription":
            signIn = { state: "runtime-unavailable", reason: "not-registered" };
            break;
        }
        return { signIn, limits: [], checkedAt: new Date().toISOString() };
      }),
    signOut: (account) =>
      account.kind === "chatgpt-subscription"
        ? Effect.tryPromise({
            try: () => signOut(authOptions(account)),
            catch: (error) =>
              new RuntimeUnavailable({
                account: account.name,
                reason: "start-failed",
                ...(options.localAuthDiagnostics &&
                error instanceof OpenAiAuthError
                  ? { fix: error.message }
                  : {}),
              }),
          }).pipe(Effect.asVoid)
        : Effect.void,
  };
}
