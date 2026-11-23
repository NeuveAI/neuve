import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  AccountStore,
  EffortLevel,
  RuntimeUnavailable,
  TurnFailed,
  type Account,
  type AccountName,
  type AccountProbe,
  type RuntimeError,
  type RuntimeModel,
  type RuntimeShape,
  type SignInHint,
  type SignInState,
} from "@neuve/runtime";
import { Effect } from "effect";
import { z } from "zod";
import type { CodexConnection } from "./client.ts";
import * as Decode from "./decode.ts";
import { RELEASE } from "./generated/methods.ts";
import type { LogEntry } from "./log.ts";
import {
  applicationFolders,
  appsLookedFor,
  discoveryCandidates,
  findCodex,
  inApps,
  PROGRAM,
  runtimeCandidates,
  type Asked,
  type Candidate,
  type FindOptions,
} from "./program.ts";
import { CodexProcess } from "./services.ts";
import {
  capabilities,
  openCodexSession,
  windows,
  type CodexTokenSource,
} from "./session.ts";

type CodexAccount = Extract<Account, { runtime: "codex" }>;
type NeuveAccount = CodexAccount & {
  credential: Extract<Account["credential"], { kind: "neuve-sign-in" }>;
};

export interface CodexRuntimeConfig {
  /** The program the person set for an account (`neuve auth program`), asked before any other. */
  readonly programPath?:
    ((account: AccountName) => string | undefined) | undefined;
  readonly environment?:
    Readonly<Record<string, string | undefined>> | undefined;
  /** The home the person's Applications folder is in, for discovery; the real one by default. */
  readonly home?: string | undefined;
  readonly log?:
    | ((account: AccountName) => ((entry: LogEntry) => void) | undefined)
    | undefined;
  readonly neuveSignIn?:
    | {
        readonly accessToken: (
          account: NeuveAccount,
          rejected?: string,
        ) => ReturnType<CodexTokenSource>;
        readonly signOut: (
          account: NeuveAccount,
        ) => Effect.Effect<void, RuntimeUnavailable>;
      }
    | undefined;
  /** For tests: where discovery looks for apps, and the releases refused as broken. */
  readonly apps?: (() => ReadonlyArray<string>) | undefined;
  readonly broken?: ReadonlyArray<string> | undefined;
}

const supported = (
  account: Account,
): Effect.Effect<CodexAccount, RuntimeUnavailable> =>
  account.runtime === "codex"
    ? Effect.succeed(account)
    : Effect.fail(
        new RuntimeUnavailable({
          account: account.name,
          reason: "not-registered",
        }),
      );

const usesNeuveSignIn = (account: CodexAccount): account is NeuveAccount =>
  account.credential.kind === "neuve-sign-in";

const codexHomeOf = (home: string, account: CodexAccount) => {
  const folder = account.credential.folder;
  if (!usesNeuveSignIn(account)) return folder;
  const key =
    folder === undefined
      ? "default"
      : createHash("sha256").update(resolvePath(folder)).digest("hex");
  return join(AccountStore.neuveFolder(home), "codex", account.name, key);
};

const unavailableStart = (account: CodexAccount) =>
  new RuntimeUnavailable({ account: account.name, reason: "start-failed" });

const signInFailure = (error: RuntimeError): SignInState => {
  switch (error._tag) {
    case "SignInRequired":
      return { state: "not-signed-in", hint: error.hint };
    case "AccountRejected":
      return {
        state: "credential-rejected",
        hint: error.hint,
        reason: error.reason,
      };
    case "RuntimeUnavailable":
      return { state: "runtime-unavailable", reason: error.reason };
    default:
      return { state: "unknown", reason: "check-failed" };
  }
};

export const prepareCodexHome = (home: string, account: CodexAccount) =>
  Effect.try({
    try: () => {
      const folder = codexHomeOf(home, account);
      if (usesNeuveSignIn(account) && folder !== undefined)
        AccountStore.privateDirectory(home, folder);
      return folder;
    },
    catch: () => unavailableStart(account),
  });

/** Codex's own sign-in, run by the Codex the account uses: a bare `codex` may be another program. */
const hintOf = (account: CodexAccount, program: string): SignInHint => ({
  kind: "command",
  command: "codex login",
  ...(account.credential.folder === undefined
    ? {}
    : { environment: { CODEX_HOME: account.credential.folder } }),
  program,
});

export const unavailable = (
  account: AccountName,
  tried: ReadonlyArray<Asked>,
): Extract<SignInState, { state: "runtime-unavailable" }> => {
  const set = `neuve auth program ${account} <path>`;
  const where = appsLookedFor()
    ? "on the PATH and in the installed apps"
    : "everywhere on the PATH";
  const install = `Run neuve auth program ${account} --find to look for Codex ${where}, install it with ${PROGRAM.install} (${PROGRAM.page}), or set its path with ${set}.`;
  const broken = tried.find((asked) => asked.kind === "broken");
  if (broken !== undefined)
    return {
      state: "runtime-unavailable",
      reason: "unsupported-version",
      program: PROGRAM.displayName,
      fix: `Codex ${broken.version} at ${broken.candidate.path} does not work with this Neuve, which was built for Codex ${RELEASE}. Update Codex (${PROGRAM.page}), or set another with ${set}.`,
    };
  const unrecognized = tried.filter((asked) => asked.kind === "unrecognized");
  if (unrecognized.length > 0)
    return {
      state: "runtime-unavailable",
      reason: "unrecognized-program",
      program: PROGRAM.displayName,
      fix: `Found ${unrecognized.map((asked) => asked.candidate.path).join(", ")}, which did not answer as Codex. ${install}`,
    };
  const missing = tried.find((asked) => asked.candidate.found === "set");
  return {
    state: "runtime-unavailable",
    reason: "not-installed",
    program: PROGRAM.displayName,
    fix: `Codex isn't installed${missing === undefined ? ", or isn't on the PATH" : `: nothing runs at ${missing.candidate.path}, the path set for ${account}`}. ${install}`,
  };
};

const ModelRow = z.looseObject({
  id: z.string().min(1),
  displayName: z.string(),
  description: z.string().nullish(),
  hidden: z.boolean().nullish(),
  isDefault: z.boolean().nullish(),
  supportedReasoningEfforts: z
    .array(z.looseObject({ reasoningEffort: z.string() }))
    .nullish(),
});
const ModelPage = z.looseObject({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});

const modelsOf = (connection: CodexConnection) =>
  Effect.gen(function* () {
    const rows: Array<RuntimeModel & { readonly isDefault: boolean }> = [];
    const unknown = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const answered = ModelPage.safeParse(
        yield* connection.request("model/list", {
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!answered.success)
        return yield* Effect.fail("models-undecodable" as const);
      const page = answered.data;
      for (const raw of page.data) {
        const row = ModelRow.safeParse(raw);
        if (!row.success || row.data.hidden === true) continue;
        const levels: EffortLevel[] = [];
        for (const { reasoningEffort } of row.data.supportedReasoningEfforts ??
          []) {
          const known = EffortLevel.safeParse(reasoningEffort);
          if (known.success) levels.push(known.data);
          else unknown.add(reasoningEffort.slice(0, 40));
        }
        rows.push({
          id: row.data.id,
          displayName: row.data.displayName,
          description: row.data.description ?? "",
          ...(levels.length === 0
            ? {}
            : { supportsEffort: true, supportedEffortLevels: levels }),
          isDefault: row.data.isDefault === true,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (unknown.size > 0)
      yield* Effect.logWarning("codex effort levels unknown, left out", {
        levels: [...unknown],
      });
    return [
      ...rows.filter((r) => r.isDefault),
      ...rows.filter((r) => !r.isDefault),
    ].map(({ isDefault: _isDefault, ...row }) => row);
  });

/**
 * Discovery, the one step that looks for Codex (`neuve auth program codex --find`, which setup
 * runs too): the path already set, then every `codex` on the PATH, then OpenAI's apps by
 * identifier and manifest, each asked the version question as the app server in order. Every
 * answer is returned, with the first that answered as Codex, for the caller to store as the
 * account's program. With `scan: false` (doctor) only what run time would ask is asked: the set
 * path, else the PATH's one `codex`. Status checks and sessions never run it.
 */
export const discoverCodex = (
  config: Pick<
    CodexRuntimeConfig,
    "environment" | "home" | "apps" | "broken"
  > & {
    readonly codexHome?: string | undefined;
    readonly setting?: string | undefined;
    readonly scan?: boolean | undefined;
  } = {},
) =>
  Effect.gen(function* () {
    const environment = config.environment ?? process.env;
    const skipped: Array<{ readonly app: string; readonly why: string }> = [];
    const scan = config.scan !== false;
    const list = scan
      ? discoveryCandidates(
          environment.PATH,
          () =>
            config.apps !== undefined
              ? config.apps()
              : inApps(applicationFolders(config.home), (app, why) =>
                  skipped.push({ app, why }),
                ),
          config.setting,
        )
      : runtimeCandidates(config.setting, environment.PATH);
    const { tried, found } = yield* findCodex(
      {
        candidates: list,
        environment,
        codexHome: config.codexHome,
        broken: config.broken,
      },
      () => Effect.void,
    );
    return {
      tried,
      found: found?.asked,
      skippedApps: skipped,
      appsLookedFor: scan && (config.apps !== undefined || appsLookedFor()),
    };
  });

export const makeRuntime = (config: CodexRuntimeConfig = {}) =>
  Effect.gen(function* () {
    const processes = yield* CodexProcess;
    const environment = config.environment ?? process.env;
    const home = config.home ?? homedir();
    const { neuveSignIn } = config;
    const accessTokenFor = (
      account: CodexAccount,
    ): Effect.Effect<CodexTokenSource | undefined, RuntimeUnavailable> => {
      if (!usesNeuveSignIn(account)) return Effect.succeed(undefined);
      if (neuveSignIn === undefined)
        return Effect.fail(unavailableStart(account));
      return Effect.succeed((rejected) =>
        neuveSignIn.accessToken(account, rejected),
      );
    };
    /** The program each account last used, per process; forgotten when it stops answering. */
    const known = new Map<
      AccountName,
      { readonly candidate: Candidate; readonly setting: string | undefined }
    >();
    const settingOf = (account: CodexAccount) =>
      Effect.try({
        try: () => config.programPath?.(account.name),
        catch: (error) =>
          error instanceof Error
            ? error.message
            : "The program path could not be read.",
      });
    const find = <A, E>(
      account: CodexAccount,
      setting: string | undefined,
      launch: Pick<FindOptions, "codexHome">,
      use: (c: CodexConnection, found: Candidate) => Effect.Effect<A, E>,
    ) =>
      findCodex(
        {
          candidates: runtimeCandidates(setting, environment.PATH),
          environment,
          broken: config.broken,
          ...launch,
        },
        use,
      ).pipe(
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            if (found === undefined) known.delete(account.name);
            else
              known.set(account.name, {
                candidate: found.asked.candidate,
                setting,
              });
          }),
        ),
        Effect.provideService(CodexProcess, processes),
      );
    const program = (account: CodexAccount, codexHome: string | undefined) =>
      Effect.gen(function* () {
        // The person's setting is read at every open, so one set or unset from the CLI is used by
        // a workspace that is already running.
        const setting = yield* settingOf(account).pipe(
          Effect.mapError(
            () =>
              new RuntimeUnavailable({
                account: account.name,
                reason: "start-failed",
              }),
          ),
        );
        const cached = known.get(account.name);
        if (cached !== undefined && cached.setting === setting)
          return cached.candidate;
        const { found, tried } = yield* find(
          account,
          setting,
          { codexHome },
          () => Effect.void,
        );
        if (found !== undefined) return found.asked.candidate;
        const state = unavailable(account.name, tried);
        return yield* new RuntimeUnavailable({
          account: account.name,
          reason: state.reason,
          program: state.program!,
          fix: state.fix!,
        });
      });
    return {
      kind: "codex",
      continuation: (account) => {
        const folder =
          account.runtime === "codex" ? codexHomeOf(home, account) : undefined;
        return {
          runtime: "codex",
          key: folder === undefined ? "default" : resolvePath(folder),
        };
      },
      // Whether the program can be found is the account's state, never its capabilities, so an
      // account whose Codex is missing still lists and its chat fails with that state.
      capabilities: (account) =>
        supported(account).pipe(Effect.as(capabilities)),
      openSession: (account, policy, start) =>
        Effect.gen(function* () {
          const codex = yield* supported(account);
          if (policy.folder === undefined)
            return yield* new TurnFailed({
              account: account.name,
              reason: "protocol-error",
            });
          const accessToken = yield* accessTokenFor(codex);
          const codexHome = yield* prepareCodexHome(home, codex);
          const found = yield* program(codex, codexHome);
          return yield* openCodexSession({
            account: account.name,
            program: found.path,
            codexHome,
            accessToken,
            cwd: policy.folder,
            environment,
            policy,
            start,
            log: config.log?.(account.name),
            broken: config.broken,
          }).pipe(
            Effect.provideService(CodexProcess, processes),
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error._tag === "RuntimeUnavailable")
                  known.delete(account.name);
              }),
            ),
          );
        }),
      probe: (account) =>
        Effect.gen(function* () {
          const codex = yield* supported(account);
          const checkedAt = new Date().toISOString();
          const codexHome = yield* Effect.gen(function* () {
            const source = yield* accessTokenFor(codex);
            if (source !== undefined) yield* source();
            return yield* prepareCodexHome(home, codex);
          }).pipe(Effect.result);
          if (codexHome._tag === "Failure")
            return {
              signIn: signInFailure(codexHome.failure),
              limits: [],
              checkedAt,
            } satisfies AccountProbe;
          const onNeuveSignIn = usesNeuveSignIn(codex);
          const setting = yield* settingOf(codex).pipe(Effect.result);
          if (setting._tag === "Failure") {
            const unreadable: AccountProbe = {
              signIn: {
                state: "runtime-unavailable",
                reason: "start-failed",
                program: PROGRAM.displayName,
                fix: `${setting.failure} Fix it, or set the path again with neuve auth program ${account.name} <path>.`,
              },
              limits: [],
              checkedAt,
            };
            return unreadable;
          }
          const { found, tried } = yield* find(
            codex,
            setting.success,
            { codexHome: codexHome.success },
            (connection, candidate) =>
              Effect.gen(function* () {
                let signIn: SignInState = {
                  state: "signed-in",
                  credentialSource: "neuve-sign-in",
                };
                if (!onNeuveSignIn) {
                  const signed = Decode.AccountAnswer.safeParse(
                    yield* connection.request("account/read", {
                      refreshToken: false,
                    }),
                  );
                  if (!signed.success)
                    return yield* Effect.fail("account-undecodable" as const);
                  signIn =
                    signed.data.account == null &&
                    signed.data.requiresOpenaiAuth
                      ? {
                          state: "not-signed-in",
                          hint: hintOf(codex, candidate.path),
                        }
                      : { state: "signed-in" };
                }
                const models = yield* modelsOf(connection).pipe(Effect.option);
                const limits = onNeuveSignIn
                  ? []
                  : yield* connection
                      .request("account/rateLimits/read", {})
                      .pipe(
                        Effect.map((answer) => {
                          const read = Decode.RateLimits.safeParse(answer);
                          return read.success
                            ? windows(read.data.rateLimits)
                            : [];
                        }),
                        Effect.orElseSucceed(() => []),
                      );
                return {
                  signIn,
                  limits,
                  models: models._tag === "Some" ? models.value : undefined,
                };
              }).pipe(
                Effect.timeout("25 seconds"),
                // A failed check gives no basis for asking the person to sign in.
                Effect.orElseSucceed(() => ({
                  signIn: (!onNeuveSignIn
                    ? { state: "unknown", reason: "check-failed" }
                    : {
                        state: "signed-in",
                        credentialSource: "neuve-sign-in",
                      }) satisfies SignInState,
                  limits: [],
                  models: undefined,
                })),
              ),
          );
          if (found === undefined) {
            const missing: AccountProbe = {
              signIn: unavailable(account.name, tried),
              limits: [],
              checkedAt,
            };
            return missing;
          }
          const { signIn, limits, models } = found.value;
          const used: AccountProbe = {
            signIn,
            limits,
            checkedAt,
            ...(models === undefined ? {} : { models }),
            program: {
              path: found.asked.candidate.path,
              version: found.asked.version,
              found: found.asked.candidate.found,
            },
          };
          return used;
        }),
      signOut: (account) =>
        supported(account).pipe(
          Effect.flatMap((codex) =>
            usesNeuveSignIn(codex)
              ? (neuveSignIn?.signOut(codex) ??
                Effect.fail(unavailableStart(codex)))
              : Effect.void,
          ),
        ),
    } satisfies RuntimeShape;
  });
