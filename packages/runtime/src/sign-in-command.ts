import type { SignInHint } from "./status.ts";

/** The exact command a person can paste into zsh. Account names are validated slugs. */
export function signInCommand(hint: SignInHint): string | undefined {
  if (hint.kind === "settings") return undefined;
  if (hint.command === "neuve auth login")
    return `${hint.command} ${hint.account}`;
  const folder = hint.environment?.CLAUDE_CONFIG_DIR;
  return folder === undefined
    ? hint.command
    : `CLAUDE_CONFIG_DIR='${folder.replaceAll("'", "'\\''")}' ${hint.command}`;
}
