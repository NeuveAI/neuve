import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Claude Code credentials for headless runs, in the owner's order: the subscription token first,
 * then the API key once the token is out of credit, quota or rate limit after one backoff. Values are
 * read from the repository's gitignored `.env.local` at runtime and handed to Claude Code processes
 * only, one at a time; they are never printed, logged or written. Receipts record the route name.
 */

export type CredentialRoute = "subscription-token" | "api-key";
export const CREDENTIAL_ROUTES: ReadonlyArray<CredentialRoute> = [
  "subscription-token",
  "api-key",
];

export interface Credential {
  readonly route: CredentialRoute;
  /** The variable Claude Code reads, and its value. */
  readonly name: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY";
  readonly value: string;
}

/** The variables Claude Code may receive as a credential; nothing else secret reaches a process. */
export const CREDENTIAL_VARIABLES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

const ENV_FILE = resolve(import.meta.dir, "../../../../../.env.local");

const readEnvFile = (path: string) => {
  const values = new Map<string, string>();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    let value = match[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values.set(match[1]!, value);
  }
  return values;
};

let current: CredentialRoute = "subscription-token";
let exhausted = false;

/** The credential for the current route, or undefined when that route has no value configured. */
export const claudeCredential = (path = ENV_FILE): Credential | undefined => {
  const values = readEnvFile(path);
  const value =
    current === "subscription-token"
      ? values.get("CLAUDE_CODE_TOKEN")
      : values.get("ANTHROPIC_API_KEY");
  if (value === undefined || value === "") return undefined;
  return {
    route: current,
    name:
      current === "subscription-token"
        ? "CLAUDE_CODE_OAUTH_TOKEN"
        : "ANTHROPIC_API_KEY",
    value,
  };
};

export const currentRoute = () => current;
export const routesExhausted = () => exhausted;

/** Moves to the next route after `from` failed; the first caller switches, later ones follow. */
export const advanceRoute = (from: CredentialRoute) => {
  if (current !== from) return current;
  const next = CREDENTIAL_ROUTES[CREDENTIAL_ROUTES.indexOf(from) + 1];
  if (next === undefined) exhausted = true;
  else {
    current = next;
    console.log(
      `${new Date().toISOString()} credential route switched from ${from} to ${next}`,
    );
  }
  return current;
};

/** A failure that more runs on the same route will not fix: credit, quota or rate limit. */
export const isLimitFailure = (text: string) =>
  /credit balance|quota|rate[ -]?limit|usage limit|weekly limit|session limit|hit your [\w ]*limit|too many requests|\b429\b|billing/i.test(
    text,
  );
