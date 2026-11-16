import type { IdentifierClass } from "./integrations.ts";
import { maskText } from "./masking.ts";

/**
 * Identifier masking for scope captures (10.8, 10.24), with no per-system code: every value the
 * source's own response marks as an identifier (the fields the user's integration file names, with
 * what each holds) is masked, then other occurrences of the shapes actually fetched. A key's shape
 * is learned from the keys fetched and keeps its literal prefix: fetching `NEU-13` masks
 * `NEU-<digits>`, never `<letters>-<digits>`, so `UTF-8` or `SHA-256` stay. URLs on the hosts the
 * response's URL fields name are masked, and email addresses by the standard address form. Masks
 * are stable within one capture (`[ticket-1]`, `[person-2]`), so a dataset built later keeps its
 * references consistent. Credential shapes are masked last (`masking.ts`).
 */

const LABEL: Record<IdentifierClass, string> = {
  key: "ticket",
  id: "id",
  url: "url",
  person: "person",
  email: "email",
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The declared identifier values of a JSON response, by class. */
export const declaredValues = (
  response: unknown,
  fields: Readonly<Record<string, IdentifierClass>>,
) => {
  const found: Array<{ value: string; kind: IdentifierClass }> = [];
  const visit = (value: unknown, key: string | undefined, depth: number) => {
    if (depth > 32) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [child, inner] of Object.entries(value))
        visit(inner, child, depth + 1);
      return;
    }
    const kind = key === undefined ? undefined : fields[key];
    if (
      kind !== undefined &&
      (typeof value === "string" || typeof value === "number")
    ) {
      const text = String(value).trim();
      if (text.length >= 2) found.push({ value: text, kind });
    }
  };
  visit(response, undefined, 0);
  return found;
};

export interface ScopeMasker {
  readonly mask: (text: string) => string;
  /** How many distinct values each label masked, for the capture's record. */
  readonly counts: () => Readonly<Record<string, number>>;
}

/** A masker for one capture, from the identifier values the response declared. */
export const scopeMasker = (
  declared: ReadonlyArray<{
    readonly value: string;
    readonly kind: IdentifierClass;
  }>,
): ScopeMasker => {
  const assigned = new Map<string, string>();
  const perLabel = new Map<string, number>();
  const tokenFor = (value: string, kind: IdentifierClass) => {
    const held = assigned.get(value);
    if (held !== undefined) return held;
    const label = LABEL[kind];
    const n = (perLabel.get(label) ?? 0) + 1;
    perLabel.set(label, n);
    const token = `[${label}-${n}]`;
    assigned.set(value, token);
    return token;
  };
  const prefixes = new Set<string>();
  const hosts = new Set<string>();
  for (const { value, kind } of declared) {
    if (kind === "key") {
      const shape = /^(.*?[^0-9])[0-9]+$/.exec(value)?.[1];
      if (shape !== undefined && shape.length >= 2) prefixes.add(shape);
    }
    if (kind === "url")
      try {
        hosts.add(new URL(value).host);
      } catch {
        // Not a URL; the value itself is still masked.
      }
  }
  // Longest first, so a value containing another is masked whole.
  const exact = [...declared].sort((a, b) => b.value.length - a.value.length);
  const mask = (text: string) => {
    let masked = text;
    for (const { value, kind } of exact)
      masked = masked.replace(new RegExp(escape(value), "g"), () =>
        tokenFor(value, kind),
      );
    // URLs before key shapes: a URL that holds a key is masked whole.
    for (const host of hosts)
      masked = masked.replace(
        new RegExp(`https?://${escape(host)}[^\\s)\\]>"']*`, "g"),
        (found) => tokenFor(found, "url"),
      );
    for (const prefix of prefixes)
      masked = masked.replace(
        new RegExp(
          `(?<![A-Za-z0-9])${escape(prefix)}[0-9]+(?![A-Za-z0-9])`,
          "g",
        ),
        (found) => tokenFor(found, "key"),
      );
    masked = masked.replace(EMAIL, (found) => tokenFor(found, "email"));
    return maskText(masked);
  };
  return { mask, counts: () => Object.fromEntries(perLabel) };
};
