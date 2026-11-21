// Why: on the Claude route, setup's closing check is the account status check `neuve auth status
// claude --check` runs, and its first step must put the sign-in (and Claude Code's install, when
// it's missing) before the review. A stand-in Claude Code runtime answers the probe, so no Claude
// Code is opened; the account store lives in a scratch home. The question's answers must map to
// the three routes the harness's settings accept.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  RuntimeUnavailable,
  type RuntimeShape,
  type SignInState,
} from "@neuve/runtime";
import { Settings } from "../../../packages/harness/src/settings.ts";
import { checkClaudeSignIn } from "../src/auth-cli.ts";
import { plainScreen } from "../src/terminal.ts";
import {
  claudeSignInStep,
  ROUTE_CHOICES,
  ROUTE_QUESTION,
} from "../src/setup.ts";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const capabilities = {
  ownsLoop: true,
  toolEndsTurn: true,
  resumeInTurn: true,
  perMessageUsage: true,
  resume: true,
  fork: true,
  interrupt: false,
  modelSwitchInSession: false,
  structuredOutput: true,
  steering: false,
  approvals: false,
  perRequestTelemetry: false,
  ownTools: false,
  byteExactCapture: false,
  nativeToolServer: false,
  statusProbe: true,
  internalRetries: false,
};

/** Claude Code as the probe finds it: installed with a sign-in state, or not installed. */
const claudeCode = (
  probed: SignInState | "not-installed",
  calls: string[],
): RuntimeShape => ({
  kind: "claude-code",
  capabilities: (account) =>
    probed === "not-installed"
      ? Effect.fail(
          new RuntimeUnavailable({
            account: account.name,
            reason: "not-installed",
          }),
        )
      : Effect.succeed(capabilities),
  continuation: (account) => ({ runtime: account.runtime, key: account.name }),
  openSession: () => Effect.die("a status check must not open a session"),
  signOut: () => Effect.die("a status check must not sign out"),
  probe: (account) =>
    Effect.sync(() => {
      calls.push(`probe:${account.name}`);
      if (probed === "not-installed") throw new Error("unreachable");
      return {
        signIn: probed,
        limits: [],
        checkedAt: new Date().toISOString(),
      };
    }),
});

const step = async (probed: SignInState | "not-installed") => {
  const home = mkdtempSync(join(tmpdir(), "neuve-setup-claude-"));
  homes.push(home);
  const calls: string[] = [];
  const status = await checkClaudeSignIn({
    home,
    runtimes: [claudeCode(probed, calls)],
  });
  return { ...claudeSignInStep(status), calls };
};

test("a signed-in Claude Code is ready, with no sign-in command, checked once through the built-in account", async () => {
  expect(await step({ state: "signed-in" })).toEqual({
    status: "ok",
    detail: "Claude Code is signed in",
    calls: ["probe:claude"],
  });
});

test("Claude Code that isn't signed in names claude auth login", async () => {
  const result = await step({
    state: "not-signed-in",
    hint: { kind: "command", command: "claude auth login" },
  });
  expect(result).toMatchObject({
    status: "missing",
    detail: "sign in to Claude Code with your Claude subscription",
    command: "claude auth login",
  });
});

test("a missing Claude Code is installed before the sign-in", async () => {
  expect(await step("not-installed")).toEqual({
    status: "missing",
    detail:
      "Claude Code isn't installed: there's no claude on PATH. Install it, then",
    command: "claude auth login",
    calls: [],
  });
});

test("a check that couldn't run points at the status command", () => {
  expect(claudeSignInStep(undefined)).toMatchObject({
    status: "missing",
    detail:
      "Neuve couldn't check the Claude Code sign-in; to check again without spending usage",
    command: "neuve auth status claude --check",
  });
});

test("the question offers the three routes, asks again until an answer is one of them, and each is a route the settings accept", async () => {
  const asked: string[] = [];
  let said = "";
  const answers = ["y", "4", "claude please", "2", "1"];
  const screen = plainScreen(
    async (text) => {
      said += text;
    },
    {
      canAsk: true,
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? null;
      },
    },
  );
  const choices = ROUTE_CHOICES.map((choice) => ({
    value: choice.route,
    label: choice.label,
  }));
  const fallback = { label: "decide later" };
  expect(await screen.choose(ROUTE_QUESTION, choices, fallback)).toBe(
    "anthropic",
  );
  expect(said).toStartWith(
    "How should reviews sign in?\n  1. ChatGPT\n  2. An Anthropic API key\n  3. Your Claude subscription, through Claude Code\n",
  );
  // The three answers that weren't a choice were asked again, and the one after them is untouched.
  expect(asked).toHaveLength(4);
  expect(answers).toEqual(["1"]);
  // Enter, or the end of input, decides later.
  for (const answer of ["", null]) {
    const later = plainScreen(async () => {}, {
      canAsk: true,
      ask: async () => answer,
    });
    expect(await later.choose(ROUTE_QUESTION, choices, fallback)).toBe(
      undefined,
    );
  }
  for (const { route } of ROUTE_CHOICES)
    expect(Settings.safeParse({ version: 1, review: { route } }).success).toBe(
      true,
    );
});
