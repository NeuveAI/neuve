import { parseArgs } from "node:util";
import { Effect } from "effect";
import { Route, RouteProvider } from "@neuve/harness";
import { write } from "./records-cli.ts";

/**
 * `neuve auth`: the sign-in a model route needs (10.85). Only `openai` exists: OpenAI's "Sign in
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

export const runAuthCli = async (args: readonly string[]): Promise<number> => {
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
    },
  });
  const provider = positionals[0];
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
