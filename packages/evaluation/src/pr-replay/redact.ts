/**
 * Secrets masked out of text a failed cloud call leaves behind (its stderr, kept on the research
 * volume and quoted in the pipeline's log): a sign-in token must never land in a log. The same
 * shapes as the modal folder's redact.py, which masks the box's stderr; each is tested with planted
 * fake values.
 */
const MASK = "[redacted]";

/**
 * Names whose value is a secret, wherever they appear as a JSON field, key=value or environment, in
 * any case (ACCESS_TOKEN, Refresh_Token).
 */
const SECRET_NAMES = [
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apiKey",
  "OPENAI_API_KEY",
  "account_id",
  "NEUVE_LEASE_KEY",
  "NEUVE_LEASE_SECRET",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
].join("|");

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // A JSON field or a quoted mapping entry: "access_token": "…", 'NEUVE_LEASE_KEY': '…'.
  [
    new RegExp(
      `(["'](?:${SECRET_NAMES})["']\\s*:\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`,
      "gi",
    ),
    `$1$2${MASK}$2`,
  ],
  // key=value, key: value and export forms: NEUVE_LEASE_SECRET=…, refresh_token=…&.
  [
    new RegExp(
      `\\b((?:${SECRET_NAMES})\\s*[=:]\\s*)["']?[^\\s"'&,;}]+["']?`,
      "gi",
    ),
    `$1${MASK}`,
  ],
  // An Authorization header or a bearer value.
  [/\b(Bearer\s+)[^\s"',;]+/gi, `$1${MASK}`],
  // OpenAI-style keys.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, `sk-${MASK}`],
  // An opaque refresh token's "rt_" prefix: undocumented (OpenAI's Codex docs give no token format;
  // one third-party example shows it), so a defensive rule only; the names above catch the field.
  [/\brt_[A-Za-z0-9_-]{20,}/g, `rt_${MASK}`],
  // JWT-shaped values: three base64url parts joined by dots.
  [/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, MASK],
];

/** The text with every secret-shaped value masked; mask the whole text before cutting it short. */
export const redactSecrets = (text: string) =>
  RULES.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
