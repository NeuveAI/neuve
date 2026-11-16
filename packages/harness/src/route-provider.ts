import { accountReadRefused, accountStoreRefusalMessage } from "@neuve/runtime";
import { signedIn, type AuthOptions } from "./openai-auth.ts";
import { Effect, type Scope } from "effect";
import type {
  AccountStore,
  RuntimeRegistryShape,
  RuntimeUnavailableReason,
} from "@neuve/runtime";
import type { AccountStatus } from "@neuve/runtime/status";
import { AccountNeedsNewerBuild } from "@neuve/runtime";
import {
  requireDirectRoute,
  credentialName,
  routeAccount,
  routeCredentialVariable,
  type AnyRouteConfig,
} from "./route.ts";

/** The public sign-in owner and catalogue probe used by the auth command. */
export * as OpenAiAuth from "./openai-auth.ts";
export * as OpenAiProvider from "./openai-route.ts";

/** The OpenAI route's API base (sign-in guide: the public Responses API, never `backend-api`). */
export { OPENAI_BASE_URL } from "./provider-urls.ts";

/**
 * Whether this process has the route's credential: the key variable is set, or the OpenAI sign-in is on
 * file with plan usage allowed. No credential value is read into the answer. An invalid but present
 * Anthropic credential is admitted so the run surfaces the provider's refusal instead of being held
 * as credential-missing. The provider and count preflight refuse subscription tokens before sending.
 */
export const credentialPresent = (
  configured: AnyRouteConfig,
  auth: AuthOptions = {},
) => {
  const route = requireDirectRoute(configured);
  if (route.provider === "openai") return signedIn(auth);
  const value = process.env[routeCredentialVariable(route)];
  return value !== undefined && value.trim() !== "";
};

/** The status service owns checks; the worker scope keeps subscriptions alive between admissions. */
export interface ReadinessStatuses {
  readonly service: Pick<AccountStore.AccountStatusesShape, "read" | "check">;
  readonly scope: Scope.Scope;
}

export const claudeUnavailableReason = (
  account: string,
  reason: RuntimeUnavailableReason,
) =>
  reason === "not-installed"
    ? `Claude Code is not installed for account ${account}; install Claude Code, then run \`neuve auth status ${account} --check\``
    : `This worker doesn't have usable Claude Code for account ${account} (${reason}); the job waits for a worker that does`;

const pendingCheckReason = (account: string) =>
  `Account ${account} hasn't been checked yet; waiting for its shared account check`;

export const statusNeedsNewerBuild = (status: AccountStatus) =>
  status.signIn.state === "unknown" &&
  status.signIn.reason === "needs-newer-build"
    ? new AccountNeedsNewerBuild({ account: status.name })
    : undefined;

const statusReadiness = (status: AccountStatus) => {
  const { signIn, name } = status;
  const held = (credential: string) => ({ ready: false, credential });
  const newerBuild = statusNeedsNewerBuild(status);
  if (newerBuild !== undefined) return held(newerBuild.message);
  switch (signIn.state) {
    case "not-signed-in":
    case "credential-rejected":
      return held(
        `The Claude Code sign-in of account ${name} is ${signIn.state}; run \`neuve auth login ${name}\``,
      );
    case "runtime-unavailable":
      return held(pendingCheckReason(name));
    case "unknown":
      return held(
        signIn.reason === "check-failed"
          ? `Account ${name} couldn't be checked; run \`neuve auth status ${name} --check\``
          : pendingCheckReason(name),
      );
    case "signed-in":
      return {
        ready: true,
        credential: `the Claude Code sign-in of account ${name}`,
      };
    default: {
      const exhaustive: never = signIn;
      return exhaustive;
    }
  }
};

/** Admission reads snapshots. Only the accounts service can start a shared check. */
export const routeReadiness = (
  route: AnyRouteConfig,
  runtimes: Pick<RuntimeRegistryShape, "capabilities">,
  statuses: Effect.Effect<ReadinessStatuses, AccountStore.StoreError>,
) =>
  Effect.gen(function* () {
    const credential = credentialName(route);
    const account = routeAccount(route);
    if (account !== undefined) {
      const capabilities = yield* Effect.result(
        runtimes.capabilities(account.name),
      );
      if (capabilities._tag === "Failure") {
        const error = capabilities.failure;
        if (accountReadRefused(error))
          return { ready: false, credential: error.message };
        if (route.provider === "claude" && error._tag === "RuntimeUnavailable")
          return {
            ready: false,
            credential: claudeUnavailableReason(account.name, error.reason),
          };
        return yield* Effect.fail(error);
      }
      if (capabilities.success.ownsLoop) {
        const read = yield* Effect.result(
          Effect.gen(function* () {
            const { service, scope } = yield* statuses;
            const snapshots = yield* service.read;
            return { service, scope, snapshots };
          }),
        );
        if (read._tag === "Failure")
          return {
            ready: false,
            credential:
              read.failure.refusal === undefined
                ? `Account ${account.name} couldn't be checked; run \`neuve auth status ${account.name} --check\``
                : accountStoreRefusalMessage(read.failure.refusal),
          };
        const { service, scope, snapshots } = read.success;
        const snapshot = snapshots.find(
          (status) => status.name === account.name,
        );
        if (
          snapshot === undefined ||
          snapshot.signIn.state === "runtime-unavailable" ||
          (snapshot.signIn.state === "unknown" &&
            snapshot.signIn.reason === "not-checked")
        ) {
          // Rechecks subscribe to the service's in-flight work, never create their own claim.
          yield* service.check(account.name).pipe(
            Effect.catch((error) => Effect.logWarning(error.message)),
            Effect.forkIn(scope, { startImmediately: true }),
          );
          return {
            ready: false,
            credential: pendingCheckReason(account.name),
          };
        }
        return statusReadiness(snapshot);
      }
    }
    return { ready: credentialPresent(route), credential };
  });
