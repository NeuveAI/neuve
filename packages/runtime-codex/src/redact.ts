import { homedir, hostname } from "node:os";

const SECRET_KEY =
  /token|secret|password|authorization|cookie|api[_-]?key|bearer|email|(user|account|workspace|org(anization)?|installation|environment|machine|device)_?id$|workspaceName|serverName/i;
/**
 * Names of counts and limits, such as a turn's `tokenUsage`. They are exempt only while they hold
 * numbers: a plural name like `accessTokens` can hold the secrets themselves.
 */
const COUNT_KEY = /(usage|count|limit|budget|window)s?$|^max_|\w_?tokens$/i;
/** A number, or an object of them all the way down; `null` stands for a count not known. */
const counts = (item: unknown): boolean =>
  typeof item === "number" ||
  item === null ||
  (typeof item === "object" &&
    !Array.isArray(item) &&
    Object.values(item).every(counts));
/** Whole blocks a server definition can hide a secret anywhere in. */
const SECRET_BLOCK = /^(env|args|http_headers|env_http_headers|headers)$/;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
/** OpenAI keys and refresh tokens, plus common prefixed tokens from other providers. */
const TOKEN =
  /\b(?:sk|rt|pk|sess|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][\w-]{8,}/g;
/** Authorization values may have any shape. */
const BEARER = /\b(Bearer|Basic|Token)(\s+)[^\s"',;]{4,}/gi;
const TILDE = /(?<![\w/])~\/[\w.@+/-]+/g;
/** Any absolute path left after the known ones were named, never a URL's path. */
/** Folder names may hold spaces; the last part may not, so a path never runs on into prose. */
const ABSOLUTE = /(?<![:\w/.])\/(?:[\w.@+-]+(?: [\w.@+-]+)*\/)+[\w.@+-]+/g;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const replaceKnown = (
  known: ReadonlyArray<readonly [string, string]>,
  minimumLength = 2,
) => {
  const ordered = known
    .filter(([found]) => found.length >= minimumLength)
    .sort(([a], [b]) => b.length - a.length);
  return (input: string) => {
    let out = input;
    for (const [found, label] of ordered) out = out.split(found).join(label);
    return out;
  };
};
/** The machine's name, whole and as its first label, only where it stands as a word of its own. */
const host = (() => {
  const full = hostname();
  const short = full.split(".")[0] ?? "";
  const names = [...new Set([full, short])].filter((name) => name.length >= 3);
  return names.length === 0
    ? undefined
    : new RegExp(
        `(?<![\\w.-])(?:${names
          .sort((a, b) => b.length - a.length)
          .map(escape)
          .join("|")})(?![\\w-])`,
        "gi",
      );
})();

export const redact = (
  value: unknown,
  known: Iterable<readonly [string, string]>,
): unknown => {
  const replace = replaceKnown([...known, [homedir(), "<home>"]]);
  const text = (input: string) => {
    const out = replace(input)
      .replace(JWT, "<token>")
      .replace(TOKEN, "<token>")
      .replace(BEARER, "$1$2<token>")
      .replace(EMAIL, "<email>")
      .replace(TILDE, "<path>")
      .replace(ABSOLUTE, "<path>");
    return host === undefined ? out : out.replace(host, "<host>");
  };
  const walk = (item: unknown, name?: string): unknown => {
    if (name !== undefined && SECRET_BLOCK.test(name) && item !== null)
      return "<redacted>";
    if (
      name !== undefined &&
      SECRET_KEY.test(name) &&
      !(COUNT_KEY.test(name) && counts(item)) &&
      item !== null &&
      item !== undefined &&
      typeof item !== "boolean"
    )
      return "<redacted>";
    if (typeof item === "string") return text(item);
    if (Array.isArray(item)) return item.map((entry) => walk(entry));
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([field, entry]) => [
          text(field),
          walk(entry, field),
        ]),
      );
    return item;
  };
  return walk(value);
};
