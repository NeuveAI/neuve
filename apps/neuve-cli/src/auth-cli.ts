import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { Effect, Layer, Logger } from "effect";
import {
  AccountDirectory,
  type AccountDirectoryShape,
  type AccountStore,
  type AccountName,
  type AccountStatus,
  type RuntimeRegistryShape,
  type RuntimeShape,
  type SignInHint,
  RuntimeUnavailable,
  signInCommand,
} from "@neuve/runtime";
import { Route, RouteProvider } from "@neuve/harness";
import {
  codexRuntimeOptions,
  defaultClaudeWorkingFolder,
  harnessRuntimes,
  prepareCodexHome,
} from "@neuve/harness/runtimes";
import { write } from "./records-cli.ts";

export const AUTH_HELP = `Usage:
  neuve auth login openai [--no-browser]
              Sign in with ChatGPT in the browser, so reviews can run on the OpenAI route
              (GPT-6.1 Sol on your ChatGPT plan). The first sign-in registers Neuve with your
              ChatGPT account; approve it and allow ChatGPT plan usage. The sign-in is kept in
              $NEUVE_OPENAI_AUTH_DIR when it is set, else $XDG_CONFIG_HOME/neuve/ (or
              ~/.config/neuve/), readable only by you, and refreshed as needed. --no-browser
              prints the link instead of opening it.
  neuve auth status [openai] [--check] [--json]
              Show the signed-in account and when the sign-in expires. --check also asks
              OpenAI's model catalogue whether the route's model is offered to the account
              (no plan usage is spent).
  neuve auth logout openai
              Revoke the sign-in at OpenAI and remove its tokens. The registration stays, so the
              next sign-in reuses it.
  neuve auth lease openai
              For the one process that refreshes a sign-in shared by cloud machines: print a
              usable access token and its expiry as JSON ({"access_token", "expires_at"} in epoch
              milliseconds) to a pipe, refreshing the sign-in first when it is near expiry. It
              refuses to print to a terminal. It exits 75 when a later attempt can succeed. A
              machine with no sign-in of its own runs reviews with NEUVE_OPENAI_TOKEN_COMMAND set
              to the absolute path of a program that prints such a lease, kept in memory only.

  neuve auth list [--check] [--json]
              Show each account's sign-in state and limits. --check checks without spending usage.
  neuve auth status <account> [--check] [--json]
              Show one account's saved state, or check it now.
  neuve auth add claude <name>
  neuve auth add chatgpt <name> [--runtime codex]
              Add a separate sign-in and print the command to sign in.
              Add --runtime codex to run the account on Codex.
  neuve auth login <account> [--print]
              Sign in using the account's own command. --print only shows the command.
  neuve auth program <account> [<path> | --find | --unset]
              Set the program an account runs on, such as the Codex the codex account uses,
              then check it. Once set, only that program is used. --find looks once for Codex,
              on the PATH and, on macOS, in the installed apps, says what it asked and why each
              was skipped, and stores the first that answers as Codex. --unset forgets the path,
              and the account uses the codex the PATH resolves to.
  neuve auth remove <account> [--force]
              Stop use, sign out, then remove the sign-in. --force allows removal when
              Claude Code is missing; its sign-in may remain in the Keychain.

Usage limits and the apps allowed to use your plan are at https://chatgpt.com/settings/usage.`;

const openBrowser = async (url: string) => {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
};

const describe = (status: RouteProvider.OpenAiAuth.AuthStatus) =>
  status.signedIn
    ? [
        `Signed in to OpenAI as ${status.email ?? status.name ?? "an account with no email"}.`,
        status.planUsage
          ? "ChatGPT plan usage: allowed."
          : "ChatGPT plan usage: not allowed; run neuve auth login openai and allow it.",
        `Access token expires ${status.accessExpiresAt} (refreshed automatically); the sign-in lasts until about ${status.refreshExpiresBy} unless it is used before then.`,
        ...(status.identityNotice === undefined
          ? []
          : [
              `The last refresh could not confirm the account (${status.identityNotice}); run neuve auth login openai if it persists.`,
            ]),
        `Kept in ${status.file}.`,
      ].join("\n")
    : `Not signed in to OpenAI${status.clientRegistered ? " (Neuve is registered with your account; signing in again reuses it)" : ""}. Run neuve auth login openai.`;

const expectOpenAi = (provider: string | undefined, required: boolean) => {
  if (provider === undefined && !required) return;
  if (provider !== "openai")
    throw new Error(
      `neuve auth ${provider === undefined ? "needs a provider" : `does not know ${provider}`}: only openai has a sign-in (the Anthropic route uses ANTHROPIC_API_KEY).`,
    );
};

/** Auth uses the harness's runtime registration with this store and CLI home. */
export const authRuntimes = ({
  directory,
  home,
}: {
  readonly directory: AccountDirectoryShape;
  readonly home: string;
}) =>
  harnessRuntimes({
    accountDirectory: Layer.succeed(AccountDirectory, directory),
    claude: { cwd: defaultClaudeWorkingFolder(home) },
    codex: codexRuntimeOptions(home, { localAuthDiagnostics: true }),
    localAuthDiagnostics: true,
  });

export interface AuthCliOptions {
  readonly runtimes?: ReadonlyArray<RuntimeShape>;
  readonly home?: string;
  /** For tests: what `program --find` runs in place of discovery's real programs. */
  readonly findCodex?: FindCodex;
}
type FindCodex = typeof import("@neuve/harness/runtimes").findCodexProgram;

/** What every account command works with: the store, its runtimes and the status service. */
interface Accounts {
  readonly home: string;
  readonly store: AccountStore.AccountStoreShape;
  readonly registry: RuntimeRegistryShape;
  readonly statuses: AccountStore.AccountStatusesShape;
}

/** Runs `body` with the accounts of `options.home`, a runtime's log lines going to standard error. */
const withAccounts = async <A>(
  options: AuthCliOptions,
  body: (accounts: Accounts) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const { AccountStore, RuntimeRegistry, runtimeRegistryLayer } =
    await import("@neuve/runtime");
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = options.home ?? homedir();
        const store = yield* AccountStore.make(home);
        return yield* Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const statuses = yield* AccountStore.makeStatuses(home, registry);
          return yield* body({ home, store, registry, statuses });
        }).pipe(
          Effect.provide(
            options.runtimes === undefined
              ? authRuntimes({ directory: store.directory, home })
              : runtimeRegistryLayer(options.runtimes).pipe(
                  Layer.provide(
                    Layer.succeed(AccountDirectory, store.directory),
                  ),
                ),
          ),
        );
      }),
    ).pipe(Effect.provide(personLogs)),
  );
};

/**
 * The built-in Claude account's sign-in, checked as `neuve auth status claude --check` checks it:
 * the account status service opens Claude Code with no prompt, so no usage is spent, and a check
 * already running for the account is joined rather than repeated. Setup's closing check uses it.
 */
export const checkClaudeSignIn = async (
  options: AuthCliOptions = {},
): Promise<AccountStatus> => {
  const { AccountName } = await import("@neuve/runtime");
  return withAccounts(options, ({ statuses }) =>
    statuses.check(AccountName.parse("claude")),
  );
};

/** What looking for Codex found, in the words `auth program --find`, setup and doctor share. */
export interface CodexLook {
  readonly found?: {
    readonly path: string;
    readonly version: string;
    readonly how: string;
  };
  /** Each candidate asked and what it answered, then what was stored and the account's state. */
  readonly lines: ReadonlyArray<string>;
  /** Programs named `codex` on the PATH that did not answer as Codex. */
  readonly strangers: ReadonlyArray<string>;
  /** The path stored for the account, when it no longer answers as Codex. */
  readonly stale?: string;
  /** In `find`: the path stored as the account's program, and the account's checked status. */
  readonly stored?: { readonly path: string; readonly account: AccountStatus };
}

const WHERE = {
  set: "set",
  path: "on the PATH",
  app: "in an installed app",
} as const;
const ANSWERED = {
  missing: "nothing runs there",
  unrecognized: "did not answer as Codex, skipped",
  broken: "a version marked broken, skipped",
  codex: "Codex",
} as const;

/** The stored path, when it was asked and did not answer as Codex. */
const staleOf = (
  tried: Effect.Success<ReturnType<FindCodex>>["tried"],
): { stale?: string } => {
  const set = tried.find((asked) => asked.candidate.found === "set");
  return set === undefined || set.kind === "codex"
    ? {}
    : { stale: set.candidate.path };
};

const lookOf = (
  found: Effect.Success<ReturnType<FindCodex>>,
  scanned: boolean,
): CodexLook => ({
  ...(found.found === undefined
    ? {}
    : {
        found: {
          path: found.found.candidate.path,
          version: found.found.version,
          how: PROGRAM_FOUND[found.found.candidate.found],
        },
      }),
  lines: [
    ...found.tried.map(
      (asked) =>
        `  ${asked.candidate.path} (${WHERE[asked.candidate.found]}): ${ANSWERED[asked.kind]}${"version" in asked ? ` ${asked.version}` : ""}`,
    ),
    ...found.skippedApps.map(({ app, why }) => `  ${app}: ${why}, skipped`),
    ...(!scanned || found.appsLookedFor
      ? []
      : [
          "  No installed app was looked for: OpenAI's desktop apps are looked for only on macOS.",
        ]),
  ],
  ...staleOf(found.tried),
  strangers: found.tried
    .filter(
      (asked) =>
        asked.candidate.found === "path" && asked.kind === "unrecognized",
    )
    .map((asked) => asked.candidate.path),
});

/**
 * Looking for the codex account's program. `find` is `neuve auth program codex --find`, which
 * setup also runs: the path already set, every `codex` on the PATH, then (on macOS) OpenAI's
 * apps, each started once as its app server to ask its version; the first that answers as Codex
 * is stored as the account's program and the account is checked. `check` is doctor's: only what
 * run time would start, the stored path or else the PATH's one `codex`, asked its version, and
 * nothing stored.
 */
export const lookForCodex = async (
  mode: "find" | "check",
  options: AuthCliOptions & {
    /** The account whose program is looked for; the built-in `codex` by default. */
    readonly account?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): Promise<CodexLook> => {
  const { AccountName, AccountStore } = await import("@neuve/runtime");
  const name = AccountName.parse(options.account ?? "codex");
  const home = options.home ?? homedir();
  const find =
    options.findCodex ??
    (await import("@neuve/harness/runtimes")).findCodexProgram;
  const environment = options.environment ?? process.env;
  if (mode === "check")
    // Only reads: no account store is opened, and the built-in account's own Codex home is used.
    return lookOf(
      await Effect.runPromise(
        find({
          home,
          environment,
          setting: AccountStore.programPath(home, name),
          scan: false,
        }).pipe(Effect.provide(personLogs)),
      ),
      false,
    );
  return withAccounts(options, (accounts) =>
    findAndStore(accounts, name, find, environment),
  );
};

/** `lookForCodex`'s `find`, inside an account command's accounts. */
const findAndStore = (
  { home, store, statuses }: Accounts,
  name: AccountName,
  find: FindCodex,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) =>
  Effect.gen(function* () {
    const { AccountStore } = yield* Effect.promise(
      () => import("@neuve/runtime"),
    );
    const account = yield* store.directory.lookup(name, "use");
    if (account?.runtime !== "codex")
      return yield* new AccountStore.StoreError({
        message: `The ${name} account doesn't run Codex.`,
      });
    const found = yield* find({
      home,
      environment,
      codexHome: yield* prepareCodexHome(home, account),
      setting: AccountStore.programPath(home, name),
    });
    const look = lookOf(found, true);
    if (found.found === undefined)
      return {
        ...look,
        lines: [...look.lines, "Found no Codex; nothing was stored."],
      } satisfies CodexLook;
    const path = found.found.candidate.path;
    yield* Effect.try({
      try: () => AccountStore.setProgramPath(home, name, path),
      catch: (error) =>
        error instanceof AccountStore.StoreError
          ? error
          : new AccountStore.StoreError({
              message: "The program path could not be saved.",
            }),
    });
    return {
      ...look,
      stored: { path, account: yield* statuses.check(name) },
    } satisfies CodexLook;
  });

/** Fixed argv and inherited streams keep Claude Code's sign-in bytes out of Neuve. */
export const claudeLoginOptions = (
  hint: Extract<SignInHint, { command: "claude auth login" }>,
) =>
  ({
    env: { ...process.env, ...hint.environment },
    stdio: ["inherit", "inherit", "inherit"],
  }) satisfies {
    env: NodeJS.ProcessEnv;
    stdio: ["inherit", "inherit", "inherit"];
  };
const accountDescription = (status: AccountStatus) => {
  const signIn = status.signIn;
  const state =
    signIn.state === "signed-in" && signIn.sourceMatchesAccount === false
      ? "signed in through another source, not this account's folder"
      : signIn.state === "runtime-unavailable"
        ? `${signIn.state}: ${signIn.reason}${signIn.fix === undefined ? "" : `\n  ${signIn.fix}`}`
        : signIn.state === "unknown"
          ? `${signIn.state}: ${signIn.reason}`
          : signIn.state === "credential-rejected" &&
              signIn.reason !== undefined &&
              signIn.reason !== "other"
            ? `${signIn.state}: ${signIn.reason}`
            : signIn.state;
  const fix =
    "hint" in signIn && signIn.hint !== undefined
      ? signInCommand(signIn.hint)
      : undefined;
  const program =
    status.program === undefined
      ? ""
      : `\n  program ${status.program.path}${status.program.version === undefined ? "" : ` (${status.program.version})`}, ${PROGRAM_FOUND[status.program.found]}`;
  const models =
    status.program === undefined || status.models === undefined
      ? ""
      : `\n  models ${status.models
          .map(
            (model) =>
              `${model.id}${model.supportedEffortLevels?.length ? ` (${model.supportedEffortLevels.join(", ")})` : ""}`,
          )
          .join(", ")}`;
  return `${status.name}  ${status.kind}  ${state}${status.limits
    .map(
      (limit) =>
        `  ${limit.window}${limit.model === undefined ? "" : ` (${limit.model})`}: ${limit.status}${limit.utilization === undefined ? "" : ` ${Math.round(limit.utilization * 100)}%`}${limit.resetsAt === undefined ? "" : `, resets ${limit.resetsAt}`}`,
    )
    .join("")}${fix === undefined ? "" : `\n  ${fix}`}${program}${models}`;
};
const PROGRAM_FOUND: Record<
  NonNullable<AccountStatus["program"]>["found"],
  string
> = {
  set: "the path set for this account",
  path: "found on the PATH",
  app: "found in an installed app",
};
const removalMessages: Record<AccountStore.RemovalStep, string> = {
  "admission-closed": "Stopped new use of the account.",
  "sessions-closed": "Stopped this process's use of the account.",
  "signed-out": "Signed out.",
  "sign-out-skipped":
    "Skipped sign-out because Claude Code is missing. The sign-in may remain in the Keychain.",
  "folder-deleted": "Removed the account's folder.",
  "record-dropped": "Removed the account.",
};

const runAccountCommand = async (
  command: string,
  positionals: string[],
  values: {
    check?: boolean;
    json?: boolean;
    print?: boolean;
    force?: boolean;
    unset?: boolean;
    find?: boolean;
    runtime?: string;
    "no-browser"?: boolean;
  },
  options: AuthCliOptions,
) => {
  const { AccountName, AccountStore, unavailableText } =
    await import("@neuve/runtime");
  return withAccounts(options, ({ home, store, registry, statuses }) =>
    Effect.gen(function* () {
      const output = (value: string) => Effect.promise(() => write(value));
      if (command === "add") {
        const kind = positionals[0];
        const name = positionals[1];
        if (
          (kind !== "claude" && kind !== "chatgpt") ||
          name === undefined ||
          positionals.length !== 2 ||
          (values.runtime !== undefined &&
            (kind !== "chatgpt" || values.runtime !== "codex"))
        )
          return yield* new AccountStore.StoreError({
            message:
              "Use neuve auth add claude <name> or neuve auth add chatgpt <name> [--runtime codex].",
          });
        const account = yield* store.add(kind, name, values.runtime);
        yield* output(
          signInCommand(
            account.credential.kind === "claude-config-folder" &&
              account.credential.folder !== undefined
              ? {
                  kind: "command",
                  command: "claude auth login",
                  environment: {
                    CLAUDE_CONFIG_DIR: account.credential.folder,
                  },
                }
              : {
                  kind: "command",
                  command: "neuve auth login",
                  account: account.name,
                },
          ) ?? "Set the key in Settings.",
        );
        return 0;
      }
      if (command === "list") {
        const all = yield* values.check === true
          ? statuses.checkAll
          : statuses.read;
        yield* output(
          values.json === true
            ? JSON.stringify(all)
            : all.map(accountDescription).join("\n"),
        );
        return 0;
      }
      const name = AccountName.safeParse(positionals[0]);
      if (!name.success)
        return yield* new AccountStore.StoreError({
          message: "Use a valid account name.",
        });
      if (command === "program") {
        const account = yield* store.directory.lookup(name.data, "use");
        if (account?.runtime !== "codex")
          return yield* new AccountStore.StoreError({
            message:
              "Only an account whose runtime finds its own program takes a program path: codex.",
          });
        const given = positionals[1];
        if (
          [
            given !== undefined,
            values.unset === true,
            values.find === true,
          ].filter(Boolean).length !== 1
        )
          return yield* new AccountStore.StoreError({
            message: `Use neuve auth program ${name.data} <path>, --find, or --unset.`,
          });
        // An empty path would resolve to the current folder: refused, never stored.
        if (given !== undefined && given.trim() === "")
          return yield* new AccountStore.StoreError({
            message: "Give the program's path, or use --find or --unset.",
          });
        if (values.find === true) {
          // Discovery, once, when asked: what it finds is stored, and checks then ask only that.
          const look = yield* findAndStore(
            { home, store, registry, statuses },
            name.data,
            options.findCodex ??
              (yield* Effect.promise(() => import("@neuve/harness/runtimes")))
                .findCodexProgram,
          );
          yield* output(
            [
              "Looked for Codex:",
              ...look.lines,
              ...(look.stored === undefined
                ? []
                : [
                    `Stored ${look.stored.path} as ${name.data}'s program.`,
                    accountDescription(look.stored.account),
                  ]),
            ].join("\n"),
          );
          return look.found === undefined ? 1 : 0;
        }
        yield* Effect.try({
          try: () =>
            AccountStore.setProgramPath(
              home,
              name.data,
              given === undefined ? undefined : resolvePath(given),
            ),
          catch: (error) =>
            error instanceof AccountStore.StoreError
              ? error
              : new AccountStore.StoreError({
                  message: "The program path could not be saved.",
                }),
        });
        yield* output(accountDescription(yield* statuses.check(name.data)));
        return 0;
      }
      if (command === "remove") {
        yield* store
          .remove(name.data, registry, {
            force: values.force === true,
            onStep: (step) => output(removalMessages[step]),
          })
          .pipe(
            Effect.mapError((error) =>
              error instanceof RuntimeUnavailable &&
              error.reason === "start-failed"
                ? new Error(
                    `Could not sign out of ${name.data}. ${error.fix === undefined ? "" : `${error.fix} `}Run neuve auth remove ${name.data} again.`,
                  )
                : error,
            ),
          );
        return 0;
      }
      const account = yield* store.directory.lookup(name.data, "use");
      if (account === undefined)
        return yield* new AccountStore.StoreError({
          message: "Account not found.",
        });
      const status =
        values.check === true || command === "login"
          ? yield* statuses.check(name.data)
          : (yield* statuses.read).find((status) => status.name === name.data);
      if (status === undefined)
        return yield* new AccountStore.StoreError({
          message: "Account not found.",
        });
      if (command === "status") {
        yield* output(
          values.json === true
            ? JSON.stringify(status)
            : accountDescription(status),
        );
        return 0;
      }
      if (status.signIn.state === "signed-in") {
        yield* output(accountDescription(status));
        return 0;
      }
      if (status.signIn.state === "runtime-unavailable") {
        // Key accounts still have no sign-in flow, as the original openai-only command reports.
        if (
          account.kind === "anthropic-api-key" ||
          account.kind === "openai-api-key"
        )
          expectOpenAi(account.name, true);
        yield* output(
          status.signIn.reason === "not-installed"
            ? (status.signIn.fix ?? `${unavailableText(status.signIn)}.`)
            : accountDescription(status),
        );
        return 1;
      }
      const hint = "hint" in status.signIn ? status.signIn.hint : undefined;
      if (hint === undefined) {
        yield* output(accountDescription(status));
        return 1;
      }
      // Codex's own sign-in is the person's to run, in their terminal.
      if (
        hint.kind === "settings" ||
        hint.command === "codex login" ||
        values.print === true ||
        process.stdin.isTTY !== true
      ) {
        yield* output(signInCommand(hint) ?? "Set the key in Settings.");
        return 0;
      }
      if (hint.command === "claude auth login") {
        const code = yield* Effect.acquireUseRelease(
          Effect.try({
            try: () =>
              Bun.spawn(["claude", "auth", "login"], claudeLoginOptions(hint)),
            catch: () =>
              new AccountStore.StoreError({
                message: "Claude Code isn't installed or could not start.",
              }),
          }),
          (child) => Effect.promise(() => child.exited),
          (child) =>
            Effect.promise(async () => {
              if (child.exitCode !== null) return;
              child.kill("SIGTERM");
              const deadline = setTimeout(() => child.kill("SIGKILL"), 2000);
              try {
                await child.exited;
              } finally {
                clearTimeout(deadline);
              }
            }),
        );
        const after = yield* statuses.check(name.data);
        yield* output(accountDescription(after));
        return code !== 0 ? code : after.signIn.state === "signed-in" ? 0 : 1;
      }
      if (
        account.credential.kind !== "neuve-sign-in" ||
        hint.account !== account.name
      )
        return yield* new AccountStore.StoreError({
          message: "The sign-in command does not match the account.",
        });
      const authOptions = RouteProvider.OpenAiAuth.authOptionsFor(
        account.credential,
      );
      const signedIn = yield* Effect.tryPromise({
        try: () =>
          RouteProvider.OpenAiAuth.signIn({
            ...authOptions,
            openBrowser: async (url) => {
              const opened =
                values["no-browser"] === true ? false : await openBrowser(url);
              await write(
                opened
                  ? `Opened the browser to sign in with ChatGPT. If it did not open, visit:\n${url}\nWaiting for the browser (5 minutes)...`
                  : `Visit this link to sign in with ChatGPT:\n${url}\nWaiting for the browser (5 minutes)...`,
              );
            },
          }),
        catch: () =>
          new AccountStore.StoreError({
            message: "Could not finish signing in with ChatGPT.",
          }),
      });
      yield* output(accountDescription(yield* statuses.check(name.data)));
      return signedIn.planUsage ? 0 : 1;
    }),
  );
};

/** Send runtime diagnostics to stderr so stdout can carry JSON. */
const personLogs = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    const parts = Array.isArray(message) ? message : [message];
    const advice = parts
      .map((part) =>
        typeof part === "object" && part !== null && "advice" in part
          ? part.advice
          : undefined,
      )
      .find((part): part is string => typeof part === "string");
    const sentence =
      advice ??
      (logLevel === "Error" || logLevel === "Fatal"
        ? parts.find((part): part is string => typeof part === "string")
        : undefined);
    if (sentence === undefined) return;
    try {
      process.stderr.write(`neuve: ${sentence}\n`);
    } catch {}
  }),
]);

export const runAuthCli = async (
  args: readonly string[],
  options: AuthCliOptions = {},
): Promise<number> => {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "help") {
    await write(AUTH_HELP);
    return command === undefined ? 2 : 0;
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: {
      "no-browser": { type: "boolean" },
      check: { type: "boolean" },
      json: { type: "boolean" },
      print: { type: "boolean" },
      force: { type: "boolean" },
      unset: { type: "boolean" },
      find: { type: "boolean" },
      runtime: { type: "string" },
    },
  });
  const provider = positionals[0];
  if (
    command === "login" &&
    provider === "anthropic" &&
    options.runtimes === undefined
  )
    expectOpenAi(provider, true);
  if (
    command === "list" ||
    command === "add" ||
    command === "program" ||
    command === "remove" ||
    ((command === "status" || command === "login") &&
      provider !== undefined &&
      provider !== "openai")
  )
    return runAccountCommand(command, positionals, values, options);
  if (command === "login") {
    expectOpenAi(provider, true);
    const status = await RouteProvider.OpenAiAuth.signIn({
      openBrowser: async (url) => {
        const opened =
          values["no-browser"] === true ? false : await openBrowser(url);
        await write(
          opened
            ? `Opened the browser to sign in with ChatGPT. If it did not open, visit:\n${url}\nWaiting for the browser (5 minutes)...`
            : `Visit this link to sign in with ChatGPT:\n${url}\nWaiting for the browser (5 minutes)...`,
        );
      },
    });
    await write(describe(status));
    return status.planUsage ? 0 : 1;
  }
  if (command === "status") {
    expectOpenAi(provider, false);
    const status = RouteProvider.OpenAiAuth.status();
    const check =
      values.check === true && status.signedIn
        ? await Effect.runPromise(
            Effect.result(
              RouteProvider.OpenAiProvider.checkRoute(Route.SOL_ROUTE, {
                baseUrl: RouteProvider.OPENAI_BASE_URL,
                fetch: globalThis.fetch,
              }),
            ),
          )
        : undefined;
    const checked =
      check === undefined
        ? undefined
        : check._tag === "Success"
          ? { ok: true as const, model: Route.SOL_ROUTE.model }
          : { ok: false as const, reason: check.failure.message };
    if (values.json === true)
      await write(
        JSON.stringify({
          ...status,
          ...(checked === undefined ? {} : { check: checked }),
        }),
      );
    else
      await write(
        `${describe(status)}${checked === undefined ? "" : checked.ok ? `\nRoute check: ${checked.model} is offered to this account.` : `\nRoute check failed: ${checked.reason}`}`,
      );
    return checked?.ok === false ? 1 : 0;
  }
  if (command === "lease") {
    expectOpenAi(provider, true);
    if (process.stdout.isTTY === true)
      throw new Error(
        "neuve auth lease prints an access token, so it writes only to a pipe, never to a terminal.",
      );
    // A SIGTERM (the refresher's stop) ends a lease that is waiting, but a refresh already sent has
    // spent its refresh token, so it runs on to write back the replacement before the command exits.
    const stop = new AbortController();
    const onStop = () => stop.abort();
    process.on("SIGTERM", onStop);
    process.on("SIGINT", onStop);
    try {
      // The sign-in folder itself, never another token command: this is the refresher.
      const lease = await RouteProvider.OpenAiAuth.accessToken({
        tokenCommand: null,
        signal: stop.signal,
      });
      if (stop.signal.aborted) {
        await Bun.write(
          Bun.stderr,
          "neuve auth lease: stopped; the sign-in on file is current and nothing was printed\n",
        );
        return 143;
      }
      await write(
        JSON.stringify(
          RouteProvider.OpenAiAuth.Lease.parse({
            access_token: lease.token,
            expires_at: lease.expiresAt,
          }),
        ),
      );
      return 0;
    } catch (error) {
      if (!(error instanceof RouteProvider.OpenAiAuth.OpenAiAuthError))
        throw error;
      await Bun.write(Bun.stderr, `neuve auth lease: ${error.message}\n`);
      return stop.signal.aborted
        ? 143
        : error.transient
          ? RouteProvider.OpenAiAuth.LEASE_TEMPORARY_FAILURE
          : 1;
    } finally {
      process.off("SIGTERM", onStop);
      process.off("SIGINT", onStop);
    }
  }
  if (command === "logout") {
    expectOpenAi(provider, true);
    const result = await RouteProvider.OpenAiAuth.signOut();
    await write(
      !result.hadSession
        ? "Not signed in to OpenAI; nothing to remove."
        : result.revoked
          ? "Signed out of OpenAI: the sign-in was revoked and its tokens removed."
          : "Removed the OpenAI tokens, but OpenAI did not confirm the revocation. Disconnect Neuve at https://chatgpt.com/settings to be sure.",
    );
    return 0;
  }
  throw new Error(`Unknown auth command: ${command}. Run neuve auth --help.`);
};
