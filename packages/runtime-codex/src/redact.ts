/**
 * Redaction for anything the client lets out of the process: recordings, and the program's
 * standard-error tail on a failure. It holds no state and writes nothing.
 */
/** Field names whose values are never kept: credentials, and who the person is. */
const SECRET_KEY =
  /token|secret|password|authorization|cookie|api[_-]?key|bearer|email|(user|account|workspace|org(anization)?|installation|machine|device)_?id$|workspaceName|serverName/i;
/** Whole blocks a server definition can hide a secret anywhere in. */
const SECRET_BLOCK = /^(env|args|http_headers|env_http_headers|headers)$/;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
/** Any absolute path left after the known ones were named, never a URL's path. */
/** Folder names may hold spaces; the last part may not, so a path never runs on into prose. */
const ABSOLUTE = /(?<![:\w/.])\/(?:[\w.@+-]+(?: [\w.@+-]+)*\/)+[\w.@+-]+/g;

/**
 * Replaces each known value (the working folder, the Codex home, the person's home, the run's
 * bearer token) with its label, then every secret-named field, email, token and other absolute
 * path. Field names are kept.
 */
export const redact = (
  value: unknown,
  known: ReadonlyArray<readonly [string, string]>,
): unknown => {
  const ordered = [...known]
    .filter(([found]) => found.length > 0)
    .sort(([a], [b]) => b.length - a.length);
  const text = (input: string) => {
    let out = input;
    for (const [found, label] of ordered) out = out.split(found).join(label);
    return out
      .replace(JWT, "<token>")
      .replace(EMAIL, "<email>")
      .replace(ABSOLUTE, "<path>");
  };
  const walk = (item: unknown, name?: string): unknown => {
    if (name !== undefined && SECRET_BLOCK.test(name) && item !== null)
      return "<redacted>";
    if (typeof item === "string")
      return name !== undefined && SECRET_KEY.test(name)
        ? "<redacted>"
        : text(item);
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
