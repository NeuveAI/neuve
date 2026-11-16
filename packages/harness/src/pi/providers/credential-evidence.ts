import type { Json } from "../capture/types.ts";

/** Redact only known active credential values, and name each changed source without storing it. */
export const refusalEvidence = (
  body: string,
  headers: Headers,
): {
  readonly body: string;
  readonly bodyRedactions: string[];
} => {
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    json = undefined;
  }
  if (typeof json === "string" || (typeof json === "object" && json !== null)) {
    const redactions = new Set<string>();
    const kept = body.replace(/"(?:[^"\\]|\\.)*"/gs, (quoted) => {
      const value: unknown = JSON.parse(quoted);
      if (typeof value !== "string") return quoted;
      const evidence = refusalEvidence(value, headers);
      for (const name of evidence.bodyRedactions) redactions.add(name);
      return evidence.body === value ? quoted : JSON.stringify(evidence.body);
    });
    return { body: kept, bodyRedactions: [...redactions] };
  }
  const redacted: string[] = [];
  for (const [name, value] of headers) {
    if (!/authorization|api[-_]?key|cookie/i.test(name) || value === "")
      continue;
    const values = [value];
    if (/authorization/i.test(name)) values.push(value.replace(/^\S+\s+/, ""));
    if (/cookie/i.test(name))
      for (const cookie of value.split(";")) {
        const separator = cookie.indexOf("=");
        if (separator >= 0) values.push(cookie.slice(separator + 1).trim());
      }
    let changed = false;
    for (const credential of values) {
      let encoded = credential;
      while (encoded !== "" && encoded.length <= body.length) {
        if (body.includes(encoded)) {
          body = body.replaceAll(encoded, "[REDACTED]");
          changed = true;
        }
        const nested = JSON.stringify(encoded).slice(1, -1);
        if (nested === encoded) break;
        encoded = nested;
      }
    }
    if (changed) redacted.push(name);
  }
  return { body, bodyRedactions: redacted };
};

/** Redact strings in a capture copy, including JSON strings nested inside provider fields. */
export const eventEvidence = (value: Json, headers: Headers) => {
  const redactions = new Set<string>();
  const text = (value: string) => {
    const evidence = refusalEvidence(value, headers);
    for (const name of evidence.bodyRedactions) redactions.add(name);
    return evidence.body;
  };
  const visit = (value: Json): Json =>
    typeof value === "string"
      ? text(value)
      : Array.isArray(value)
        ? value.map(visit)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(
              Object.entries(value).map(([key, value]) => [
                text(key),
                visit(value),
              ]),
            )
          : value;
  return { data: visit(value), bodyRedactions: [...redactions] };
};

export type CredentialCapture =
  import("../capture/private-inspection.ts").PrivateInspection | "ephemeral";

/** A historical match changes only the observation copy, with decoded token coordinates rebuilt outward. */
export const historicalEvidence = async (
  value: Json,
  inspection: import("../capture/private-inspection.ts").PrivateInspection,
  observed: (epochs: ReadonlyArray<string>) => void,
  signal?: AbortSignal,
): Promise<{
  readonly data: Json;
  readonly exposedEpochs: ReadonlyArray<string>;
}> => {
  const { CredentialJson, InspectionBudget } =
    await import("../capture/credential-detectors.ts");
  const source = CredentialJson.serialize(value);
  const result = await inspection.inspectJson({
    json: source,
    budget: new InspectionBudget(),
    ...(signal === undefined ? {} : { signal }),
  });
  const known =
    result.status === "complete"
      ? [...new Set(result.matches.map((match) => match.epoch))]
      : result.exposedEpochs;
  if (known.length > 0) observed(known);
  if (result.status === "unavailable") {
    const error = new Error("Historical credential observation is unavailable");
    throw error;
  }
  if (result.matches.length === 0) return { data: value, exposedEpochs: [] };
  interface Node {
    ranges: Array<{ start: number; end: number }>;
    children: Map<string, { span: { start: number; end: number }; node: Node }>;
  }
  const node = (): Node => ({ ranges: [], children: new Map() });
  const root = node();
  for (const match of result.matches) {
    let target = root;
    for (const span of match.jsonPath) {
      const key = `${span.start}:${span.end}`;
      let child = target.children.get(key);
      if (!child) {
        child = { span, node: node() };
        target.children.set(key, child);
      }
      target = child.node;
    }
    target.ranges.push({ start: match.start, end: match.end });
  }
  const render = (text: string, tree: Node): string => {
    const replacements: Array<{ start: number; end: number; text: string }> =
      [];
    for (const { span, node } of tree.children.values()) {
      const decoded: unknown = JSON.parse(text.slice(span.start, span.end));
      if (typeof decoded !== "string")
        throw new Error("Historical mask token is invalid");
      replacements.push({
        ...span,
        text: JSON.stringify(render(decoded, node)),
      });
    }
    const ranges = tree.ranges.toSorted(
      (a, b) => a.start - b.start || b.end - a.end,
    );
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      if (
        replacements.some(
          (replacement) =>
            range.start >= replacement.start && range.end <= replacement.end,
        )
      )
        continue;
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end)
        previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    for (const range of merged)
      replacements.push({ ...range, text: "[REDACTED]" });
    replacements.sort((a, b) => b.start - a.start);
    let kept = text;
    for (const replacement of replacements)
      kept =
        kept.slice(0, replacement.start) +
        replacement.text +
        kept.slice(replacement.end);
    try {
      JSON.parse(text);
    } catch {
      return kept;
    }
    try {
      JSON.parse(kept);
      return kept;
    } catch {
      return JSON.stringify("[REDACTED]");
    }
  };
  const data: unknown = JSON.parse(render(source.contents(), root));
  const { Json } = await import("../capture/types.ts");
  return {
    data: Json.parse(data),
    exposedEpochs: [...new Set(result.matches.map((match) => match.epoch))],
  };
};
