import { expect, test } from "bun:test";
import { AccountName } from "../src/account.ts";
import { signInCommand } from "../src/sign-in-command.ts";

// A pasted folder must remain literal, including syntax that could otherwise run code.
for (const folder of [
  "/tmp/Neuve's account folder",
  "/tmp/account $HOME",
  "/tmp/$(printf expanded; printf executed >&2)",
  "/tmp/`printf expanded; printf executed >&2`",
  '/tmp/account "quoted"',
  "/tmp/account \\folder",
  "/tmp/account with spaces",
  "/tmp/café/中/😀",
]) {
  // zsh is absent on some Linux check machines.
  test.skipIf(Bun.which("zsh") === null)(
    `the pasted sign-in folder round-trips byte-identical through zsh: ${folder}`,
    () => {
      const command = signInCommand({
        kind: "command",
        command: "claude auth login",
        environment: { CLAUDE_CONFIG_DIR: folder },
      });
      const result = Bun.spawnSync([
        "zsh",
        "-f",
        "-c",
        `function true() { zsh -f -c 'printf %s "$CLAUDE_CONFIG_DIR"'; }\n${command?.replace("claude auth login", "true")}`,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(Buffer.from(folder, "utf8"));
      expect(result.stderr.toString()).toBe("");
    },
  );

  test(`the pasted sign-in folder round-trips byte-identical through sh: ${folder}`, () => {
    const command = signInCommand({
      kind: "command",
      command: "claude auth login",
      environment: { CLAUDE_CONFIG_DIR: folder },
    });
    const result = Bun.spawnSync([
      "sh",
      "-c",
      command?.replace(
        "claude auth login",
        `sh -c 'printf %s "$CLAUDE_CONFIG_DIR"'`,
      ) ?? "",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(Buffer.from(folder, "utf8"));
    expect(result.stderr.toString()).toBe("");
  });
}

test("the default Claude sign-in command needs no environment assignment", () => {
  expect(signInCommand({ kind: "command", command: "claude auth login" })).toBe(
    "claude auth login",
  );
});

test("pasted Neuve commands name the account and Settings hints have no shell command", () => {
  expect(
    signInCommand({
      kind: "command",
      command: "neuve auth login",
      account: AccountName.parse("work"),
    }),
  ).toBe("neuve auth login work");
  expect(
    signInCommand({ kind: "settings", entry: "accounts" }),
  ).toBeUndefined();
});
