import type { SignInHint, SignInState } from "./status.ts";

/** The exact command a person can paste into zsh. Account names are validated slugs. */
export function signInCommand(hint: SignInHint): string | undefined {
  if (hint.kind === "settings") return undefined;
  if (hint.command === "neuve auth login")
    return `${hint.command} ${hint.account}`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const [name, folder] =
    hint.command === "codex login"
      ? ["CODEX_HOME", hint.environment?.CODEX_HOME]
      : ["CLAUDE_CONFIG_DIR", hint.environment?.CLAUDE_CONFIG_DIR];
  const command =
    hint.command === "codex login" && hint.program !== undefined
      ? `${quote(hint.program)} login`
      : hint.command;
  return folder === undefined ? command : `${name}=${quote(folder)} ${command}`;
}

const UNAVAILABLE: Record<
  Extract<SignInState, { state: "runtime-unavailable" }>["reason"],
  string
> = {
  "not-installed": "isn't installed",
  "not-registered": "isn't set up for Neuve",
  "unsupported-version": "needs a newer version",
  "start-failed": "couldn't start",
  "sign-out-failed": "couldn't sign out",
  "unrecognized-program":
    "was looked for, and the file found didn't answer as it",
};

/**
 * What a person reads when an account's program can't run, in the CLI, the accounts list and a
 * chat alike: the runtime's own fix when it wrote one, else the program's name and the reason,
 * without a full stop, as the accounts list has always written it. A state with no program
 * (stored before programs were named, or built where none is known) reads as Claude Code's did.
 */
export function unavailableText(
  state: Pick<
    Extract<SignInState, { state: "runtime-unavailable" }>,
    "reason" | "program" | "fix"
  > & { readonly state?: "runtime-unavailable" },
): string {
  return (
    state.fix ??
    `${state.program ?? "Claude Code"} ${UNAVAILABLE[state.reason]}`
  );
}
