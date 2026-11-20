/**
 * Redaction for anything the client lets out of the process: recordings, Codex's own error text,
 * and the program's standard-error tail on a failure. It holds no state and writes nothing.
 */
import { homedir, hostname } from "node:os";

/** Field names whose values are never kept: credentials, and who the person is. */
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
/** OpenAI's keys and refresh tokens, and the other common prefixed token shapes. */
const TOKEN =
  /\b(?:sk|rt|pk|sess|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_][\w-]{8,}/g;
/** The value after an authorization scheme, whatever its shape. */
const BEARER = /\b(Bearer|Basic|Token)(\s+)[^\s"',;]{4,}/gi;
/** A path under the home folder written the short way. */
const TILDE = /(?<![\w/])~\/[\w.@+/-]+/g;
/** Any absolute path left after the known ones were named, never a URL's path. */
/** Folder names may hold spaces; the last part may not, so a path never runs on into prose. */
const ABSOLUTE = /(?<![:\w/.])\/(?:[\w.@+-]+(?: [\w.@+-]+)*\/)+[\w.@+-]+/g;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * Replaces each known value (the working folder, the Codex home, the person's home, the run's
 * bearer token) with its label, then every secret-named field, email, token, bearer value, the
 * machine's name and other absolute path. The person's home is always known. Field names are kept.
 * A secret-named field keeps `null` and booleans, which carry nothing; any other value, list or
 * object included, becomes `<redacted>`.
 */
export const redact = (
  value: unknown,
  known: ReadonlyArray<readonly [string, string]>,
): unknown => {
  const ordered = [...known, [homedir(), "<home>"] as const]
    .filter(([found]) => found.length > 1)
    .sort(([a], [b]) => b.length - a.length);
  const text = (input: string) => {
    let out = input;
    for (const [found, label] of ordered) out = out.split(found).join(label);
    out = out
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
