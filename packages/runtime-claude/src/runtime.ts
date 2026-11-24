import {
  RuntimeUnavailable,
  type Account,
  type AccountProbe,
  type CallUsage,
  type RuntimeCapabilities,
  type RuntimeShape,
} from "@neuve/runtime";
import { Effect } from "effect";
import { resolve as resolvePath } from "node:path";
import {
  childEnvironment,
  signInHint,
  type ClaudeAccount,
} from "./environment.ts";
import { probeSignIn, runtimeModels } from "./mapping.ts";
import {
  openClaudeSession,
  type InternalSessionOptions,
  type SessionIdentity,
} from "./session.ts";
import { ClaudeExecutable, ClaudeProcess, ClaudeSdk } from "./services.ts";

export interface ClaudeRuntimeConfig {
  /** Stable directory owned by Neuve. The caller creates it before opening sessions. */
  readonly cwd: string;
  readonly executable?: string;
  readonly oauthToken?: string | undefined;
  /** Maximum wait for query disposal on a turn path. Defaults to 10 seconds. */
  readonly interruptTimeoutMs?: number;
}
interface InternalConfig extends ClaudeRuntimeConfig {
  readonly handleTool?: InternalSessionOptions["handleTool"];
  readonly heldResults?: InternalSessionOptions["heldResults"];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly identity?: SessionIdentity;
  readonly usageBaseline?: ReadonlyMap<string, CallUsage>;
  readonly probeTimeoutMs?: number;
}
const supportedAccount = (account: Account) =>
  account.kind === "claude-subscription"
    ? Effect.succeed(account)
    : Effect.fail(
        new RuntimeUnavailable({
          account: account.name,
          reason: "not-registered",
        }),
      );
export const capabilities: RuntimeCapabilities = {
  ownsLoop: true,
  toolEndsTurn: true,
  resumeInTurn: true,
  perMessageUsage: true,
  resume: true,
  fork: true,
  interrupt: true,
  modelSwitchInSession: true,
  structuredOutput: true,
  steering: true,
  approvals: true,
  nativeToolServer: true,
  statusProbe: true,
  internalRetries: true,
  perRequestTelemetry: false,
  ownTools: false,
  byteExactCapture: false,
};
export const makeRuntime = (config: InternalConfig) => {
  const environment = config.environment ?? process.env;
  const oauthToken = Object.hasOwn(config, "oauthToken")
    ? config.oauthToken
    : environment.CLAUDE_CODE_OAUTH_TOKEN;
  return Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    const executable = yield* ClaudeExecutable;
    const processes = yield* ClaudeProcess;
    const resolve = (account: ClaudeAccount) =>
      executable.resolve(config.executable).pipe(
        Effect.flatMap((path) =>
          path === undefined
            ? Effect.fail(
                new RuntimeUnavailable({
                  account: account.name,
                  reason: "not-installed",
                }),
              )
            : Effect.succeed(path),
        ),
      );
    return {
      kind: "claude-code",
      continuation: (account) => ({
        runtime: "claude-code",
        key:
          account.credential.kind === "claude-config-folder" &&
          account.credential.folder !== undefined
            ? resolvePath(account.credential.folder)
            : "default",
      }),
      capabilities: (account) =>
        supportedAccount(account).pipe(
          Effect.flatMap(resolve),
          Effect.as(capabilities),
        ),
      openSession: (account, policy, start = { kind: "new" }) =>
        Effect.gen(function* () {
          const supported = yield* supportedAccount(account);
          const path = yield* resolve(supported);
          return yield* openClaudeSession(supported, policy, {
            cwd: config.cwd,
            executable: path,
            environment,
            oauthToken,
            ...(config.interruptTimeoutMs === undefined
              ? {}
              : { interruptTimeoutMs: config.interruptTimeoutMs }),
            ...(config.handleTool === undefined
              ? {}
              : { handleTool: config.handleTool }),
            ...(config.heldResults === undefined
              ? {}
              : { heldResults: config.heldResults }),
            ...(config.usageBaseline === undefined
              ? {}
              : { usageBaseline: config.usageBaseline }),
            identity:
              start.kind === "resume"
                ? {
                    resume: start.session,
                    ...(start.at === undefined
                      ? {}
                      : { resumeSessionAt: start.at }),
                    forkSession: start.fork,
                  }
                : (config.identity ?? { sessionId: crypto.randomUUID() }),
          }).pipe(Effect.provideService(ClaudeSdk, sdk));
        }),
      probe: (account) =>
        Effect.gen(function* () {
          const supported = yield* supportedAccount(account);
          const path = yield* executable.resolve(config.executable);
          const checkedAt = new Date().toISOString();
          if (path === undefined)
            return {
              signIn: { state: "runtime-unavailable", reason: "not-installed" },
              limits: [],
              checkedAt,
            } satisfies AccountProbe;
          const observations = yield* Effect.scoped(
            Effect.gen(function* () {
              const query = yield* sdk.open({
                pathToClaudeCodeExecutable: path,
                env: childEnvironment(environment, supported, oauthToken),
                cwd: config.cwd,
                settingSources: [],
                settings: { disableAllHooks: true },
                strictMcpConfig: true,
                persistSession: false,
                allowedTools: [],
                mcpServers: {},
                tools: [],
                skills: [],
                permissionMode: "default",
              });
              const init = yield* query.initializationResult;
              const signIn = probeSignIn(supported, init.account);
              const models = yield* Effect.try(() =>
                runtimeModels(init.models),
              ).pipe(Effect.catch(() => Effect.succeed(undefined)));
              return { signIn, ...(models === undefined ? {} : { models }) };
            }).pipe(Effect.timeout(config.probeTimeoutMs ?? 25_000)),
          ).pipe(
            Effect.catch(() =>
              Effect.succeed({
                signIn: {
                  state: "unknown",
                  reason: "check-failed",
                  hint: signInHint(supported),
                },
              } as const),
            ),
          );
          return {
            ...observations,
            limits: [],
            checkedAt,
          } satisfies AccountProbe;
        }),
      signOut: (account) =>
        account.credential.kind === "environment" ||
        account.credential.kind === "vault"
          ? Effect.void
          : Effect.gen(function* () {
              const supported = yield* supportedAccount(account);
              const path = yield* resolve(supported);
              yield* processes
                .run(
                  [path, "auth", "logout"],
                  childEnvironment(environment, supported, oauthToken),
                )
                .pipe(
                  Effect.mapError(
                    () =>
                      new RuntimeUnavailable({
                        account: account.name,
                        reason: "start-failed",
                      }),
                  ),
                );
            }),
    } satisfies RuntimeShape;
  });
};
