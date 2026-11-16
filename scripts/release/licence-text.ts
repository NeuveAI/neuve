import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which licences a text carries in full, judged against SPDX's canonical templates
 * (`licence-templates/`, from spdx/license-list-data at the commit its source.json names): the whole
 * template must appear in the text, in order, with only its marked variable parts (the copyright
 * line, the holder's name, "Software" or "Materials") and its optional parts free. Case,
 * punctuation and whitespace don't count. A truncated text, or one whose licence has no template
 * here, matches nothing.
 */

export const TEMPLATES = join(import.meta.dir, "licence-templates");

// The Free Software Foundation's older postal addresses, which SPDX's matching guidelines treat as
// the same as the current one in its licences.
const FSF_ADDRESS = "51 franklin street fifth floor boston ma 02110 1301 usa";
const OLD_FSF_ADDRESSES = [
  /\b59 temple place suite 330 boston ma 02111 1307 usa\b/g,
  /\b675 mass ave cambridge ma 02139 usa\b/g,
  /\b51 franklin st fifth floor boston ma 02110 1301 usa\b/g,
];

const normal = (text: string) =>
  OLD_FSF_ADDRESSES.reduce(
    (current, address) => current.replace(address, FSF_ADDRESS),
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      // Articles vary between copies of one licence ("submitted to the Licensor" in some Apache
      // texts); a cut or a missing clause never comes down to them.
      .replace(/\b(the|a|an) /g, "")
      // SPDX's matching guidelines treat http:// and https:// in a licence's links as the same.
      .replace(/\bhttps\b/g, "http")
      .trim(),
  );

type Part =
  | { readonly kind: "words"; readonly words: ReadonlyArray<string> }
  | {
      readonly kind: "var";
      /** SPDX's pattern, compiled over normalised words; undefined for a free gap. */
      readonly pattern: RegExp | undefined;
      readonly most: number;
    }
  | { readonly kind: "optional"; readonly parts: ReadonlyArray<Part> };

/**
 * SPDX's `match` regex, over text normalised as `normal` does: letters lower-cased, punctuation and
 * whitespace one space, the articles gone. Literal words stay literal; `\s` and punctuation become
 * an optional space; `.` is any letter, digit or space; groups, alternatives and quantifiers keep
 * their meaning, so "Neither the name of .+ nor the names of its contributors may" still needs
 * each of those words, in that order.
 */
export const compileMatch = (match: string): RegExp => {
  const SPACE = "\u0000";
  const malformed = (why: string) =>
    new Error(
      `The SPDX pattern ${JSON.stringify(match)} is malformed: ${why}.`,
    );
  let out = "";
  // A space stands in for whitespace or punctuation, so a quantifier on it ("\\s+", ",?") goes too.
  const space = (at: number) => {
    out += SPACE;
    let next = at + 1;
    while ("+*?".includes(match[next] ?? "x")) next += 1;
    if (match[next] === "{") {
      const close = match.indexOf("}", next);
      if (close === -1) throw malformed("a { has no }");
      next = close + 1;
    }
    return next - 1;
  };
  for (let index = 0; index < match.length; index += 1) {
    const char = match[index] ?? "";
    if (char === "\\") {
      const next = match[index + 1] ?? "";
      index += 1;
      if (/[sS]/.test(next)) index = space(index);
      else if (/[dw]/.test(next)) out += `\\${next}`;
      else if (/[A-Za-z0-9]/.test(next)) out += next.toLowerCase();
      else index = space(index);
    } else if (char === "[") {
      const end = match.indexOf("]", index + 1);
      if (end === -1) throw malformed("a [ has no ]");
      const negated = match[index + 1] === "^";
      const inside = match.slice(index + (negated ? 2 : 1), end).toLowerCase();
      const kept = inside.replace(/[^a-z0-9-]/g, "").replace(/(^-|-$)/g, "");
      index = end;
      if (negated) {
        // Anything but those: punctuation and whitespace in the set are the one space they became.
        const spaced = /[^a-z0-9-]/.test(inside) ? " " : "";
        out += kept + spaced === "" ? "[a-z0-9 ]" : `[^${kept}${spaced}]`;
      } else if (kept === "") index = space(index);
      else out += `[${kept}]`;
    } else if (char === ".") out += "[a-z0-9 ]";
    else if ("()|?*+{}".includes(char)) {
      // A quantifier's braces keep their digits: copy through the closing brace.
      if (char === "{") {
        const end = match.indexOf("}", index);
        if (end === -1) throw malformed("a { has no }");
        out += match.slice(index, end + 1);
        index = end;
      } else out += char;
    } else if (/[A-Za-z0-9]/.test(char)) out += char.toLowerCase();
    else index = space(index);
  }
  // Drop the articles, as `normal` does: a lone "the", "a" or "an" between spaces or group marks.
  out = out.replace(
    new RegExp(`(^|${SPACE}|\\(|\\|)(?:the|an|a)(?:${SPACE})+`, "g"),
    "$1",
  );
  // Runs of spaces become one optional space.
  out = out.replace(new RegExp(`(?:${SPACE})+`, "g"), " ?");
  try {
    return new RegExp(`^ ?(?:${out}) ?$`);
  } catch (error) {
    throw malformed((error as Error).message);
  }
};

/** A variable part: SPDX's pattern compiled as a regex, or a free gap of up to `most` words. */
const variable = (spec: string): Part => {
  const match = /match="((?:[^"\\]|\\.)*)"/.exec(spec)?.[1] ?? ".+";
  // A free gap: any text, bounded (".{0,5000}", ".{54,64}") or not (".+", ".*").
  const free = /^\.(?:\{(\d+),(\d+)\}|\+|\*)$/.exec(match);
  if (free !== null)
    return {
      kind: "var",
      pattern: undefined,
      // Characters to words: a bound of 5000 characters is several hundred words.
      most: free[2] === undefined ? 200 : Math.ceil(Number(free[2]) / 4),
    };
  return { kind: "var", pattern: compileMatch(match), most: 120 };
};

/** A template as a sequence of literal words, variable parts and optional groups. */
export const parseTemplate = (template: string): ReadonlyArray<Part> => {
  const root: Array<Part> = [];
  const stack: Array<Array<Part>> = [root];
  for (const piece of template.split(
    /(<<(?:beginOptional|endOptional|var;[\s\S]*?)>>)/,
  )) {
    const top = stack.at(-1) ?? root;
    if (piece === "<<beginOptional>>") {
      const group: Array<Part> = [];
      top.push({ kind: "optional", parts: group });
      stack.push(group);
    } else if (piece === "<<endOptional>>") {
      if (stack.length > 1) stack.pop();
    } else if (piece.startsWith("<<var;")) top.push(variable(piece));
    else {
      const words = normal(piece).split(" ").filter(Boolean);
      if (words.length > 0) top.push({ kind: "words", words });
    }
  }
  return root;
};

/**
 * The positions where the parts, matched from `at`, can end. Literal words must follow one another
 * exactly; a free variable may take up to its bound of words, but only up to a place where the
 * literal after it begins (found through `where`, each word's positions in the text).
 */
const ends = (
  parts: ReadonlyArray<Part>,
  text: ReadonlyArray<string>,
  where: ReadonlyMap<string, ReadonlyArray<number>>,
  at: number,
): ReadonlyArray<number> => {
  let positions: ReadonlyArray<number> = [at];
  parts.forEach((part, index) => {
    const next = new Set<number>();
    const following = parts[index + 1];
    for (const position of positions) {
      if (part.kind === "words") {
        if (
          part.words.every((word, offset) => text[position + offset] === word)
        )
          next.add(position + part.words.length);
      } else if (part.kind === "optional") {
        next.add(position);
        for (const end of ends(part.parts, text, where, position))
          next.add(end);
      } else if (part.pattern !== undefined) {
        // Every span of words from here that SPDX's pattern matches in full.
        for (
          let take = 0;
          take <= part.most && position + take <= text.length;
          take += 1
        )
          if (
            part.pattern.test(text.slice(position, position + take).join(" "))
          )
            next.add(position + take);
      } else if (following?.kind === "words") {
        for (const candidate of where.get(following.words[0] ?? "") ?? [])
          if (candidate >= position && candidate <= position + part.most)
            next.add(candidate);
      } else
        for (
          let skip = 0;
          skip <= part.most && position + skip <= text.length;
          skip += 1
        )
          next.add(position + skip);
    }
    positions = [...next];
  });
  return positions;
};

const indexed = (text: string) => {
  const words = normal(text).split(" ").filter(Boolean);
  const where = new Map<string, Array<number>>();
  words.forEach((word, position) => {
    const list = where.get(word);
    if (list === undefined) where.set(word, [position]);
    else list.push(position);
  });
  return { words, where };
};

/**
 * Each place the whole template appears, as the words it spans, from its first literal word to the
 * furthest end it can reach. Leading optional and variable parts are free.
 */
const spans = (
  template: ReadonlyArray<Part>,
  { words, where }: ReturnType<typeof indexed>,
): ReadonlyArray<readonly [number, number]> => {
  const start = template.findIndex((part) => part.kind === "words");
  const first = template[start];
  if (first?.kind !== "words") return [];
  const parts = template.slice(start);
  // Where the template's opening words begin. A match never reaches past the next of them, so a
  // free gap in a cut copy can't stretch into the whole copy that follows it.
  const openings = (where.get(first.words[0] ?? "") ?? []).filter((position) =>
    first.words.every((word, offset) => words[position + offset] === word),
  );
  return openings.flatMap((position, index) => {
    const limit = openings[index + 1] ?? words.length;
    const found = ends(parts, words, where, position).filter(
      (end) => end <= limit,
    );
    return found.length === 0
      ? []
      : [
          [
            back(template.slice(0, start), words, position),
            Math.max(...found),
          ] as const,
        ];
  });
};

/** An optional part's literal words, or undefined when it holds a variable. */
const literal = (parts: ReadonlyArray<Part>): Array<string> | undefined => {
  const out: Array<string> = [];
  for (const part of parts) {
    if (part.kind === "words") out.push(...part.words);
    else if (part.kind === "optional") {
      const inner = literal(part.parts);
      if (inner === undefined) return undefined;
      out.push(...inner);
    } else return undefined;
  }
  return out;
};

/**
 * Where a match really begins: before its first literal words, the leading optional titles that
 * are there in full ("Apache License Version 2.0, January 2004"), and a short numbering variable
 * between them ("1."), but only when a title before it is there too. A long variable, the
 * copyright line, ends the search.
 */
const back = (
  leading: ReadonlyArray<Part>,
  words: ReadonlyArray<string>,
  position: number,
): number => {
  const from = (index: number, start: number): number => {
    const part = leading[index];
    if (part === undefined) return start;
    if (part.kind === "optional") {
      const title = literal(part.parts);
      if (title === undefined) return start;
      const skipped = from(index - 1, start);
      const there =
        title.length > 0 &&
        title.length <= start &&
        title.every(
          (word, offset) => words[start - title.length + offset] === word,
        );
      return there
        ? Math.min(skipped, from(index - 1, start - title.length))
        : skipped;
    }
    if (part.kind === "var" && part.most <= 5) {
      let best = start;
      for (let take = 1; take <= part.most && take <= start; take += 1)
        if (
          part.pattern === undefined ||
          part.pattern.test(words.slice(start - take, start).join(" "))
        ) {
          const reached = from(index - 1, start - take);
          if (reached < start - take) best = Math.min(best, reached);
        }
      return best;
    }
    return start;
  };
  return from(leading.length - 1, position);
};

/** Whether the whole template appears in the text. */
export const matchesTemplate = (template: ReadonlyArray<Part>, text: string) =>
  spans(template, indexed(text)).length > 0;

/** A stored template's text, refused when it is an error page or too short to be a licence. */
const checkedTemplate = (path: string) => {
  const text = readFileSync(path, "utf8");
  if (looksLikeNoLicence(text))
    throw new Error(`${path} isn't a licence template.`);
  return text;
};

/** SPDX's templates, and the local variants in `local/` (its README says what each changes). */
const templates = (): ReadonlyArray<{
  id: string;
  parts: ReadonlyArray<Part>;
}> =>
  [TEMPLATES, join(TEMPLATES, "local")].flatMap((folder) =>
    readdirSync(folder)
      .filter((name) => name.endsWith(".template.txt"))
      .sort()
      .map((name) => ({
        id: name.slice(0, -".template.txt".length),
        parts: parseTemplate(checkedTemplate(join(folder, name))),
      })),
  );
let loaded: ReturnType<typeof templates> | undefined;

/**
 * A text that can't be a licence: an HTTP error page as a failed download stores it ("404: Not
 * Found", an HTML error document), or anything shorter than the shortest licence kept here.
 */
export const looksLikeNoLicence = (text: string) =>
  text.trim().length < 300 ||
  /^\s*(\d{3}\s*:|<!doctype html|<html|<\?xml)/i.test(text) ||
  /\b(404|403|500|502|503)\b[^\n]{0,40}\b(not found|forbidden|error|unavailable)\b/i.test(
    text.slice(0, 400),
  );

/** The SPDX licences whose whole canonical text is in `text`. */
export const fullLicences = (text: string): ReadonlyArray<string> =>
  licenceCoverage(text).ids;

/**
 * The licences whose whole text is in `text`, and the runs of its words that none of them covers,
 * each as its first word's position and its words.
 */
export const licenceCoverage = (text: string) => {
  const index = indexed(text);
  const uncovered: Array<{ at: number; words: ReadonlyArray<string> }> = [];
  if (looksLikeNoLicence(text))
    return {
      ids: [] as ReadonlyArray<string>,
      words: index.words.length,
      uncovered,
      spans: [] as ReadonlyArray<LicenceSpan>,
    };
  loaded ??= templates();
  const covered = new Uint8Array(index.words.length);
  const ids: Array<string> = [];
  const matched: Array<{ id: string; from: number; to: number }> = [];
  for (const template of loaded) {
    const found = spans(template.parts, index);
    if (found.length === 0) continue;
    ids.push(template.id);
    for (const [from, to] of found) {
      covered.fill(1, from, to);
      matched.push({ id: template.id, from, to });
    }
  }
  for (let at = 0; at < covered.length;) {
    if (covered[at]) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < covered.length && !covered[end]) end += 1;
    uncovered.push({ at, words: index.words.slice(at, end) });
    at = end;
  }
  // Matches that overlap are one licence span: BSD-3-Clause and its local variant on the same text.
  const grouped: Array<LicenceSpan> = [];
  for (const match of matched.sort((a, b) => a.from - b.from || b.to - a.to)) {
    const last = grouped.at(-1);
    if (last !== undefined && match.from < last.to) {
      last.to = Math.max(last.to, match.to);
      if (!last.ids.includes(match.id)) last.ids.push(match.id);
    } else grouped.push({ from: match.from, to: match.to, ids: [match.id] });
  }
  for (const span of grouped) span.ids.sort();
  return {
    ids: ids as ReadonlyArray<string>,
    words: index.words.length,
    uncovered,
    spans: grouped as ReadonlyArray<LicenceSpan>,
  };
};

/** One stretch of words a licence covers in full: its first word, its end, and its licences. */
export interface LicenceSpan {
  from: number;
  to: number;
  ids: Array<string>;
}

/** A file's licence spans in order, each as its licences joined by "+". */
export const licenceSpans = (text: string) =>
  licenceCoverage(text).spans.map((span) => span.ids.join("+"));

/** Six words in a row from a template's body: a licence's own words, never a copyright line's. */
const RUN = 6;
let bodyRuns: ReadonlySet<string> | undefined;
const runsOf = (parts: ReadonlyArray<Part>, into: Set<string>) => {
  for (const part of parts)
    if (part.kind === "words")
      for (let at = 0; at + RUN <= part.words.length; at += 1)
        into.add(part.words.slice(at, at + RUN).join(" "));
    else if (part.kind === "optional") runsOf(part.parts, into);
};
const templateRuns = () => {
  loaded ??= templates();
  const runs = new Set<string>();
  for (const template of loaded) {
    // The body: from the first literal words on, so a leading title or copyright line isn't one.
    const start = template.parts.findIndex((part) => part.kind === "words");
    runsOf(template.parts.slice(start), runs);
  }
  return runs;
};

/** The words no licence covers, as one string to hash: each run on its own line. */
export const uncoveredText = (text: string) =>
  licenceCoverage(text)
    .uncovered.map((run) => run.words.join(" "))
    .join("\n");

/** Short runs outside the licences: a heading and copyright lines first, separators between. */
const LIMIT = { head: 40, between: 20, tail: 0 };

/**
 * Why `text` isn't whole licences from end to end, or undefined when it is. The licences found must
 * cover the text but for a short heading, short separators and nothing at the end, and no run
 * outside them may hold a licence's own words, so a licence cut anywhere, the last one included,
 * is caught. A file with more than one licence span (two licences, or two copies of one), or with
 * longer text outside its licences, passes only as `reviewed` records it: its spans in order, each
 * as its licences joined by "+", and the SHA-256 of `uncoveredText`.
 */
export const wholeTextProblem = (
  text: string,
  reviewed?: Readonly<{ spans: ReadonlyArray<string>; uncovered: string }>,
): string | undefined => {
  const coverage = licenceCoverage(text);
  const spans = coverage.spans.map((span) => span.ids.join("+"));
  if (reviewed) {
    const found = spans.join(", ");
    const expected = reviewed.spans.join(", ");
    if (found !== expected)
      return `its whole licences are ${found}, not the reviewed ${expected}`;
    const hash = new Bun.CryptoHasher("sha256")
      .update(uncoveredText(text))
      .digest("hex");
    if (hash !== reviewed.uncovered)
      return "its text outside the licences isn't the reviewed text";
    return undefined;
  }
  if (coverage.ids.length === 0) return "it isn't a whole licence";
  if (spans.length > 1)
    return `it holds ${spans.length} licences (${spans.join(", ")}), and a file with more than one passes only with a reviewed entry`;
  bodyRuns ??= templateRuns();
  for (const run of coverage.uncovered) {
    const where =
      run.at === 0
        ? "head"
        : run.at + run.words.length === coverage.words
          ? "tail"
          : "between";
    const quote = `"${run.words.slice(0, 12).join(" ")}${run.words.length > 12 ? " …" : ""}"`;
    if (run.words.length > LIMIT[where])
      return `${run.words.length} words ${where === "head" ? "before" : where === "tail" ? "after" : "between"} the licences aren't part of one: ${quote}`;
    for (let at = 0; at + RUN <= run.words.length; at += 1)
      if (bodyRuns.has(run.words.slice(at, at + RUN).join(" ")))
        return `words outside the whole licences are part of a licence's text, so one is cut: ${quote}`;
  }
  return undefined;
};

/** The licence names a notices row states, and the SPDX templates each one means. */
const KEYWORD: Record<string, { name: RegExp; ids: ReadonlyArray<string> }> = {
  MIT: { name: /\bMIT\b/, ids: ["MIT", "MIT-0"] },
  ISC: { name: /\bISC\b/, ids: ["ISC"] },
  BSD: {
    name: /\bBSD\b/,
    ids: [
      "BSD-2-Clause",
      "BSD-2-Clause-unchanged",
      "BSD-3-Clause",
      "BSD-3-Clause-named",
      "BSD-4-Clause",
      "0BSD",
    ],
  },
  "Apache-2.0": { name: /\bApache\b/, ids: ["Apache-2.0"] },
  "CC0-1.0": { name: /\bCC0\b/, ids: ["CC0-1.0"] },
};

/**
 * Rows of a notices table whose licence column doesn't match the licence texts the row links to.
 * The licence a row names first must be, in full, in every licence file the row links (LICENSE,
 * COPYING, UPSTREAM-LICENSE, licenses/*.txt), so an unrelated MIT link beside an Apache text doesn't
 * pass for it; a row that links only NOTICE files needs it in one of them; and a linked licence or
 * notice file that doesn't exist is a problem in itself. `read` returns a file's text, or undefined
 * when it doesn't exist. (A file may hold more than the named licence, as dual-licensed files do.)
 */
export const licenceRowProblems = async (
  markdown: string,
  read: (target: string) => Promise<string | undefined>,
) => {
  const problems: Array<string> = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const stated = cells.find((cell) =>
      Object.values(KEYWORD).some((keyword) => keyword.name.test(cell)),
    );
    if (stated === undefined) continue;
    const first = Object.entries(KEYWORD)
      .map(([form, keyword]) => ({ form, at: stated.search(keyword.name) }))
      .filter((entry) => entry.at !== -1)
      .sort((a, b) => a.at - b.at)[0]?.form;
    const ids = first === undefined ? [] : (KEYWORD[first]?.ids ?? []);
    const licenceFiles: Array<ReadonlyArray<string>> = [];
    const noticeFiles: Array<ReadonlyArray<string>> = [];
    for (const match of line.matchAll(/\]\(([^)\s#]+)\)/g)) {
      const target = match[1] ?? "";
      const licence =
        /(^|\/)(LICEN[CS]E|COPYING|UPSTREAM-LICENSE)[^/]*$|\/licenses\/[^/]+\.txt$/i.test(
          target,
        );
      const notice = /(^|\/)NOTICE[^/]*$/i.test(target);
      if (!licence && !notice) continue;
      const text = await read(target);
      if (text === undefined) {
        problems.push(`links ${target}, which doesn't exist: ${cells[0]}`);
        continue;
      }
      (licence ? licenceFiles : noticeFiles).push(fullLicences(text));
    }
    const carries = (found: ReadonlyArray<string>) =>
      found.some((id) => ids.includes(id));
    if (licenceFiles.length > 0) {
      if (!licenceFiles.every(carries))
        problems.push(
          `says ${first} but a licence file it links isn't ${first}: ${cells[0]}`,
        );
    } else if (noticeFiles.length > 0 && !noticeFiles.some(carries))
      problems.push(
        `says ${first} but no notice it links holds the ${first} text: ${cells[0]}`,
      );
  }
  return problems;
};
