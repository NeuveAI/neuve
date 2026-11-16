/**
 * Masking for raw captures (10.8, 10.24): clear identifiers are replaced in what is stored, never in
 * what the model sees. This masks email addresses and the credential shapes the repository's own
 * environment uses, keeping each one's literal prefix so a capture still shows what kind of value
 * stood there.
 */

const LOCAL = /[A-Za-z0-9._%+-]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y;

const KEY_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox-"],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, "lin_"],
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const maskText = (
  text: string,
  declared: ReadonlyArray<string> = [],
): string => {
  let masked = text;
  for (const identifier of declared)
    if (identifier.length >= 3)
      masked = masked.replace(new RegExp(escape(identifier), "g"), "<masked>");
  for (const [shape, prefix] of KEY_SHAPES)
    masked = masked.replace(shape, `${prefix}<masked>`);
  const parts: string[] = [];
  let copied = 0;
  LOCAL.lastIndex = 0;
  for (let local = LOCAL.exec(masked); local; local = LOCAL.exec(masked)) {
    if (masked[LOCAL.lastIndex] !== "@") continue;
    EMAIL.lastIndex = local.index;
    if (!EMAIL.test(masked)) continue;
    parts.push(masked.slice(copied, local.index), "<email>");
    copied = LOCAL.lastIndex = EMAIL.lastIndex;
  }
  if (copied === 0) return masked;
  parts.push(masked.slice(copied));
  return parts.join("");
};
