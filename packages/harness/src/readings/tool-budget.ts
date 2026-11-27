import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { ToolOutcome, ToolSpec } from "../toolkit.ts";

/** The opening tag `dataBlock` writes (data-block.ts): the body's hash, quoted attributes, a line end. */
const OPENING_TAG = /<data-([0-9a-f]{64})(?: [^\s="]+="[^"]*")*>\n/y;

/** A span of a tool result that reads as a data block: its opening tag, body, closing tag and end. */
type Span = {
  readonly start: number;
  readonly body: number;
  readonly close: number;
  readonly end: number;
  readonly tag: string;
};

/**
 * Every span of `text` opening before `before` that reads as a data block. Each `<data-` is
 * examined, none skipped: it counts when it starts an opening tag `dataBlock` writes and the text up
 * to the first `\n</data-<same hash>>` after it, which a real body cannot hold, hashes to the tag.
 * Planted tag text can make spans that count too: inside a real body, in a header's path ahead of a
 * real block (`read` prints a path twice), or around a whole real block from text printed before and
 * after it. Nothing in the text tells such a span from real nesting, so `cutToRoom` closes every
 * span the cut falls in: no counted span, planted or real, can keep the real block it falls in open.
 */
const blocksBefore = (text: string, before: number) => {
  const spans: Array<Span> = [];
  let at = text.indexOf("<data-");
  while (at !== -1 && at < before) {
    OPENING_TAG.lastIndex = at;
    const open = OPENING_TAG.exec(text);
    const hash = open?.[1];
    if (open !== null && hash !== undefined) {
      const tag = `</data-${hash}>`;
      const body = at + open[0].length;
      const close = text.indexOf(`\n${tag}`, body);
      if (
        close !== -1 &&
        createHash("sha256").update(text.slice(body, close)).digest("hex") ===
          hash
      )
        spans.push({
          start: at,
          body,
          close,
          end: close + 1 + tag.length,
          tag,
        });
    }
    at = text.indexOf("<data-", at + 1);
  }
  return spans;
};

/** The line a cut result ends with: not a `[more]` offer, since the step can read nothing more. */
const cutLine = (shown: number, total: number) =>
  `[reading budget reached: result cut after ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters; this step can read no more]`;

/** What closing a block a cut leaves open adds: a line end and `</data-<64 hex>>`. */
const CLOSING_CHARS = "\n</data->".length + 64;

/**
 * A result longer than `room`, cut to fit it whole: the kept text, the closing tags of the data
 * blocks the cut falls in, innermost first, and the line saying it was cut, together at most `room`
 * characters. The cut falls at the last line end in reach when that keeps more than half of what can
 * be kept, and otherwise inside the line (never between a surrogate pair), so one long line is not
 * dropped whole. A cut inside a block's opening tag drops the whole tag; one inside its closing tag
 * keeps the body whole. Undefined when the room cannot hold the closing tags and the line.
 */
const cutToRoom = (text: string, room: number) => {
  // The line is widest with the shown count at the total, which it is always below.
  const line = cutLine(text.length, text.length).length;
  const keepFor = (closing: number) =>
    room - closing * CLOSING_CHARS - 1 - line;
  // Every cut below is at most the first `keep`, so the spans opening before it are all it can meet.
  const spans = blocksBefore(text, keepFor(1));
  for (let closing = 1; ;) {
    const keep = keepFor(closing);
    if (keep < 0) return undefined;
    const lineEnd = text.lastIndexOf("\n", keep);
    let cut = lineEnd * 2 > keep ? lineEnd : keep;
    const code = text.charCodeAt(cut - 1);
    if (cut === keep && code >= 0xd800 && code <= 0xdbff) cut -= 1;
    for (let moved = true; moved;) {
      moved = false;
      for (const span of spans)
        if (span.start < cut && cut < span.body - 1) {
          cut = span.start;
          moved = true;
        } else if (span.close < cut && cut < span.end) {
          cut = span.close;
          moved = true;
        }
    }
    const open = spans
      .filter((span) => span.start < cut && cut < span.end)
      .sort((a, b) => b.start - a.start);
    // More blocks to close than the room was kept for: keep less and look again.
    if (open.length > closing) {
      closing = open.length;
      continue;
    }
    return `${text.slice(0, cut)}${open.map((span) => `\n${span.tag}`).join("")}\n${cutLine(cut, text.length)}`;
  }
};

/**
 * A step's lookups held to `limit` characters of results. A result that fits is passed through
 * unchanged. One that crosses what is left is cut to fit with its cut said (`cutToRoom`), or, when
 * what is left cannot hold that, answered as a spent budget; either way the budget is then spent,
 * so every later call answers that it is, and the step's results never pass the limit.
 */
export const readingBudget = (
  tools: ReadonlyArray<ToolSpec<unknown>>,
  limit: number,
) => {
  let used = 0;
  const spent = (): ToolOutcome => ({
    text: "Reading budget spent. Submit your review.",
    error: "BudgetSpent",
  });
  return {
    tools: tools.map((tool) =>
      tool.name === "vent" || tool.name.startsWith("submit_")
        ? tool
        : {
            ...tool,
            handle: (input: unknown) =>
              Effect.suspend((): Effect.Effect<ToolOutcome> => {
                if (used >= limit) return Effect.succeed(spent());
                return Effect.map(tool.handle(input), (outcome) => {
                  const room = Math.max(0, limit - used);
                  if (outcome.text.length <= room) {
                    used += outcome.text.length;
                    return outcome;
                  }
                  const text = cutToRoom(outcome.text, room);
                  used = limit;
                  return text === undefined
                    ? spent()
                    : { ...outcome, text, paged: true };
                });
              }),
          },
    ),
    save: () => ({ used }),
    restore: (state: { used: number }) => {
      used = state.used;
    },
    note: () =>
      `reading ${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} characters`,
  };
};
