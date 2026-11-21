import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { AccountName, unavailableText } from "../../src/index.ts";
import { privateDirectory } from "../../src/store/files.ts";
import { AccountStore, scratch } from "./fixtures.ts";

const codex = AccountName.parse("codex");

// Reason: a built-in account has no record, so the program path a person sets for it is kept in a
// file of its own; it must persist privately, be read back, and be forgotten without leaving a file.
test("the program path set for an account is kept privately, read back and forgotten", () => {
  const { home, close } = scratch();
  try {
    expect(AccountStore.programPath(home, codex)).toBeUndefined();
    AccountStore.setProgramPath(home, codex, "/opt/codex/bin/codex");
    expect(AccountStore.programPath(home, codex)).toBe("/opt/codex/bin/codex");
    expect(statSync(AccountStore.programsPath(home)).mode & 0o777).toBe(0o600);
    AccountStore.setProgramPath(home, codex, undefined);
    expect(AccountStore.programPath(home, codex)).toBeUndefined();
    expect(() => statSync(AccountStore.programsPath(home))).toThrow();
  } finally {
    close();
  }
});

// Reason: input handling. A relative path, or a file that is not Neuve's, is refused rather than run.
test("a program file that is not Neuve's is refused, and a relative path is never kept", () => {
  const { home, close } = scratch();
  try {
    expect(() =>
      AccountStore.setProgramPath(home, codex, "relative/codex"),
    ).toThrow();
    const path = AccountStore.programsPath(home);
    privateDirectory(home, join(path, ".."));
    writeFileSync(
      path,
      JSON.stringify({ version: 1, programs: { codex: "x" } }),
      {
        mode: 0o600,
      },
    );
    expect(() => AccountStore.programPath(home, codex)).toThrow();
    expect(readFileSync(path, "utf8")).toContain('"x"');
  } finally {
    close();
  }
});

// Reason: `codex` became a built-in name. A record a person added under it before must leave the
// rest of the store readable, and the built-in account wins.
test("a stored account under a name that became built-in is left as stored", async () => {
  const { home, close } = scratch();
  try {
    const claim = join(AccountStore.accountsPath(home), "codex");
    privateDirectory(home, AccountStore.accountsPath(home));
    mkdirSync(claim, { mode: 0o700 });
    writeFileSync(
      join(claim, "default.active.json"),
      JSON.stringify({
        version: 1,
        account: {
          name: "codex",
          kind: "chatgpt-subscription",
          runtime: "pi",
          credential: { kind: "neuve-sign-in" },
        },
      }),
      { mode: 0o600 },
    );
    const accounts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          return yield* store.list;
        }),
      ),
    );
    expect(accounts.filter((a) => a.name === codex)).toEqual([
      {
        name: codex,
        kind: "chatgpt-subscription",
        runtime: "codex",
        credential: { kind: "codex-home" },
      },
    ]);
  } finally {
    close();
  }
});

// Reason: one text for an account whose program cannot run, used by the CLI, the accounts list and
// a chat: the runtime's fix when it wrote one, else the program and the reason, worded and
// punctuated as the accounts list always wrote it, so Claude Code's states read exactly as before.
test("an unavailable program reads as the runtime's fix, else its name and the reason", () => {
  expect(
    unavailableText({
      state: "runtime-unavailable",
      reason: "not-installed",
      program: "Codex",
      fix: "Install Codex.",
    }),
  ).toBe("Install Codex.");
  expect(
    unavailableText({
      state: "runtime-unavailable",
      reason: "not-installed",
      program: "Claude Code",
    }),
  ).toBe("Claude Code isn't installed");
  // A state stored before programs were named, or built where none is known, reads as before.
  expect(
    unavailableText({ state: "runtime-unavailable", reason: "not-registered" }),
  ).toBe("Claude Code isn't set up for Neuve");
});

// Reason: a built-in account is never removed, and the reason given is its own: by what its
// credential is, so `codex` (the person's own Codex login) never reads as another account's.
test("removing a built-in account says why in its own words, the codex account included", async () => {
  const { home, close } = scratch();
  try {
    const messages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const refusal = (name: string) =>
            store.remove(AccountName.parse(name), {} as never).pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
          return {
            codex: yield* refusal("codex"),
            claude: yield* refusal("claude"),
            chatgpt: yield* refusal("chatgpt"),
            anthropic: yield* refusal("anthropic"),
          };
        }),
      ),
    );
    expect(messages).toEqual({
      codex:
        "This is your own Codex login, and Neuve never signs you out of it. Sign out in Codex itself if you want to.",
      claude:
        "Claude Code owns this sign-in. Sign out yourself with claude auth logout.",
      chatgpt: "Sign out with neuve auth logout openai.",
      anthropic: "This key is set where ANTHROPIC_API_KEY is set today.",
    });
  } finally {
    close();
  }
});
