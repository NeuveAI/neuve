import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { Effect, Layer, Logger } from "effect";
import {
  AccountDirectory,
  type AccountDirectoryShape,
  type AccountStore,
  type AccountStatus,
  type RuntimeShape,
  type SignInHint,
} from "@neuve/runtime";
import { Route, RouteProvider } from "@neuve/harness";
import {
  codexRuntimeOptions,
  defaultClaudeWorkingFolder,
  harnessRuntimes,
} from "@neuve/harness/runtimes";
import { write } from "./records-cli.ts";

/**
 * `neuve auth`: the sign-in a model route needs (10.85). `openai` keeps OpenAI's "Sign in
 * with ChatGPT", so the OpenAI route spends the owner's ChatGPT plan. The owner signs in in their
 * own browser; this command never sees a password, and never prints a token. `status` shows the
 * account and expiry only.
 */

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
  neuve auth add chatgpt <name>
              Add a separate sign-in and print the command to sign in.
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
    codex: codexRuntimeOptions(home),
  });

export interface AuthCliOptions {
  readonly runtimes?: ReadonlyArray<RuntimeShape>;
  readonly home?: string;
  /** For tests: what `program --find` runs in place of discovery's real programs. */
  readonly findCodex?: FindCodex;
}
type FindCodex = typeof import("@neuve/harness/runtimes").findCodexProgram;

/**
 * The built-in Claude account's sign-in, checked as `neuve auth status claude --check` checks it:
 * the account status service opens Claude Code with no prompt, so no usage is spent, and a check
 * already running for the account is joined rather than repeated. Setup's closing check uses it.
 */
export const checkClaudeSignIn = async (
  options: AuthCliOptions = {},
): Promise<AccountStatus> => {
  const { AccountName, AccountStore, RuntimeRegistry, runtimeRegistryLayer } =
    await import("@neuve/runtime");
  const name = AccountName.parse("claude");
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = options.home ?? homedir();
        const store = yield* AccountStore.make(home);
        return yield* Effect.gen(function* () {
          const statuses = yield* AccountStore.makeStatuses(
            home,
            yield* RuntimeRegistry,
          );
          return yield* statuses.check(name);
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
    ),
  );
};

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
          : signIn.state;
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
    .join("")}${program}${models}`;
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
    "no-browser"?: boolean;
  },
  options: AuthCliOptions,
) => {
  const {
    AccountName,
    AccountStore,
    RuntimeRegistry,
    runtimeRegistryLayer,
    signInCommand,
    unavailableText,
  } = await import("@neuve/runtime");
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const home = options.home ?? homedir();
        const store = yield* AccountStore.make(home);
        return yield* Effect.gen(function* () {
          const registry = yield* RuntimeRegistry;
          const statuses = yield* AccountStore.makeStatuses(home, registry);
          const output = (value: string) => Effect.promise(() => write(value));
          if (command === "add") {
            const kind = positionals[0];
            const name = positionals[1];
            if (
              (kind !== "claude" && kind !== "chatgpt") ||
              name === undefined ||
              positionals.length !== 2
            )
              return yield* new AccountStore.StoreError({
                message:
                  "Use neuve auth add claude <name> or neuve auth add chatgpt <name>.",
              });
            const account = yield* store.add(kind, name);
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
              const findCodexProgram =
                options.findCodex ??
                (yield* Effect.promise(() => import("@neuve/harness/runtimes")))
                  .findCodexProgram;
              const found = yield* findCodexProgram({
                home,
                codexHome: account.credential.folder,
              });
              const where = {
                set: "set",
                path: "on the PATH",
                app: "in an installed app",
              } as const;
              const answered = {
                missing: "nothing runs there",
                unrecognized: "did not answer as Codex, skipped",
                broken: "a version marked broken, skipped",
                codex: "Codex",
              } as const;
              yield* output(
                [
                  "Looked for Codex:",
                  ...found.tried.map(
                    (asked) =>
                      `  ${asked.candidate.path} (${where[asked.candidate.found]}): ${answered[asked.kind]}${"version" in asked ? ` ${asked.version}` : ""}`,
                  ),
                  ...found.skippedApps.map(
                    ({ app, why }) => `  ${app}: ${why}, skipped`,
                  ),
                  ...(found.appsLookedFor
                    ? []
                    : [
                        "  No installed app was looked for: OpenAI's desktop apps are looked for only on macOS.",
                      ]),
                  ...(found.found === undefined
                    ? ["Found no Codex; nothing was stored."]
                    : []),
                ].join("\n"),
              );
              if (found.found === undefined) return 1;
              yield* Effect.try({
                try: () =>
                  AccountStore.setProgramPath(
                    home,
                    name.data,
                    found.found!.candidate.path,
                  ),
                catch: (error) =>
                  error instanceof AccountStore.StoreError
                    ? error
                    : new AccountStore.StoreError({
                        message: "The program path could not be saved.",
                      }),
              });
              // Said once it is saved, not before.
              yield* output(
                `Stored ${found.found.candidate.path} as ${name.data}'s program.`,
              );
              yield* output(
                accountDescription(yield* statuses.check(name.data)),
              );
              return 0;
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
            yield* store.remove(name.data, registry, {
              force: values.force === true,
              onStep: (step) => output(removalMessages[step]),
            });
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
              : (yield* statuses.read).find(
                  (status) => status.name === name.data,
                );
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
                  Bun.spawn(
                    ["claude", "auth", "login"],
                    claudeLoginOptions(hint),
                  ),
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
                  const deadline = setTimeout(
                    () => child.kill("SIGKILL"),
                    2000,
                  );
                  try {
                    await child.exited;
                  } finally {
                    clearTimeout(deadline);
                  }
                }),
            );
            const after = yield* statuses.check(name.data);
            yield* output(accountDescription(after));
            return code !== 0
              ? code
              : after.signIn.state === "signed-in"
                ? 0
                : 1;
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
                    values["no-browser"] === true
                      ? false
                      : await openBrowser(url);
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
    ).pipe(Effect.provide(stderrLogs)),
  );
};

/**
 * A runtime's log lines (a candidate program skipped, an effort level left out) go to standard
 * error, so what these commands print, `--json` included, stays the account's alone.
 */
const stderrLogs = Logger.layer([
  Logger.make(({ logLevel, message }) => {
    try {
      process.stderr.write(
        `neuve: ${String(logLevel).toLowerCase()}: ${JSON.stringify(message)}\n`,
      );
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
