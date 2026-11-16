// Why: the Linguist standard is only worth using if what Neuve carries is Linguist's own rules.
// These tests hold the carried files to the hashes recorded when they were fetched, the tables
// to those files (the vendor patterns line by line, the generated rules in the order of the
// `generated?` chain, every Ruby literal verbatim), each JavaScript translation to the one
// translator, the recipe to the folder's contents, and each translation to an input where
// carrying the Ruby pattern unchanged would answer differently.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATED_RULES,
  LEFT_OUT,
  type RubyRegexp,
} from "../src/linguist/generated-rules.ts";
import { LINGUIST_STANDARD } from "../src/linguist/index.ts";
import { LINGUIST_RECIPE } from "../src/linguist/recipe.ts";
import {
  RUBY_LINE_START,
  rubyExtname,
  translateRubyRegexp,
} from "../src/linguist/ruby.ts";
import {
  VENDOR_PATTERNS,
  VENDOR_REGEXPS,
} from "../src/linguist/vendor-patterns.ts";

const folder = join(import.meta.dir, "../src/linguist");
const carried = (name: string) => readFileSync(join(folder, name));
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// A reader for the one YAML form `vendor.yml` uses: comment lines starting with `#`, empty lines,
// and `- <plain scalar>` items at the margin. Any other line, and any item YAML would read as
// something other than the same string (quoted, flow or block indicators, a trailing comment,
// surrounding spaces, a value YAML resolves to a number, boolean, null or symbol), fails loudly.
function readVendorYml(text: string): { line: number; pattern: string }[] {
  const rows: { line: number; pattern: string }[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw new Error("vendor.yml: no final line feed");
  lines.slice(0, -1).forEach((raw, index) => {
    const line = index + 1;
    if (raw === "" || raw.startsWith("#")) return;
    const fail = (why: string) => {
      throw new Error(
        `vendor.yml line ${line}: ${why}: ${JSON.stringify(raw)}`,
      );
    };
    if (!raw.startsWith("- "))
      fail("not a comment, an empty line or a list item");
    const value = raw.slice(2);
    if (value === "" || /^\s|\s$/.test(value)) fail("surrounding spaces");
    if (/\t|: | #/.test(value) || value.endsWith(":"))
      fail("a tab, a mapping or a comment");
    if (/^[,[\]{}#&*!|>'"%@`:?]/.test(value))
      fail("a YAML indicator at the start");
    if (/^-(\s|$)/.test(value)) fail("a nested list");
    if (/^(~|null|true|false|yes|no|on|off|y|n|<<)$/i.test(value))
      fail("a YAML non-string");
    if (/^[-+]?(\d|\.\d|\.(inf|nan)$)/i.test(value)) fail("a YAML number");
    rows.push({ line, pattern: value });
  });
  return rows;
}

test("the carried Linguist files are byte for byte the fetched ones", () => {
  expect(sha256(carried("vendor.yml"))).toBe(
    LINGUIST_STANDARD.files["lib/linguist/vendor.yml"],
  );
  expect(sha256(carried("generated.rb"))).toBe(
    LINGUIST_STANDARD.files["lib/linguist/generated.rb"],
  );
  expect(LINGUIST_STANDARD.files).toEqual({
    "lib/linguist/vendor.yml":
      "1ae9980298c7c4b89fa663f1efbab3c977818a0fcb59ddc869f2b8060a7ad345",
    "lib/linguist/generated.rb":
      "e5d73b4b0835d6b3c48fed9c056e21599284879063027fc561c1a62dd7b246c7",
  });
});

test("the recipe is the fingerprint of every table, matcher and carried file in the folder", () => {
  // Why: a mark records the recipe so a later reader knows which port gave it; a change anywhere
  // in the port must change it.
  const hash = createHash("sha256");
  for (const name of readdirSync(folder).sort()) {
    if (name === "recipe.ts" || name === "NOTICE") continue;
    hash.update(`${name}\0`).update(carried(name)).update("\0");
  }
  expect(LINGUIST_RECIPE).toBe(`sha256:${hash.digest("hex")}`);
  expect(LINGUIST_STANDARD.recipe).toBe(LINGUIST_RECIPE);
});

test("the vendor table is vendor.yml's patterns, in its order, as Linguist wrote them", () => {
  const read = readVendorYml(carried("vendor.yml").toString("utf8"));
  expect(read.length).toBe(168);
  expect(
    VENDOR_PATTERNS.map(({ line, pattern }) => ({ line, pattern })),
  ).toEqual(read);
});

test("the YAML line reader fails loudly on a line it cannot read", () => {
  for (const text of [
    "- 'quoted'\n",
    "  - indented\n",
    "- a # note\n",
    "- yes\n",
    "- 1.5\n",
    "key: x\n",
  ])
    expect(() => readVendorYml(text)).toThrow("vendor.yml line 1");
});

test("every vendor pattern compiles, and each translation is the translator's", () => {
  for (const [index, row] of VENDOR_PATTERNS.entries()) {
    const translated = translateRubyRegexp(row.pattern, { mode: "text" });
    if (row.js === undefined) expect(translated).toBe(row.pattern);
    else expect(row.js).toBe(translated);
    expect(VENDOR_REGEXPS[index]!.regexp.source).toBe(
      new RegExp(translated, "u").source,
    );
  }
  expect(
    VENDOR_PATTERNS.filter((row) => row.js === undefined).map(
      (row) => row.line,
    ),
  ).toEqual([109, 262, 263]);
});

// One string that matches a vendor pattern, read from the pattern itself: the first branch of
// each alternation, the first character a class allows, the fewest repetitions. With `dot` set,
// each `.` (Ruby: anything but a line feed) produces that character, at least once.
function example(source: string, dot?: string): string {
  let i = 0;
  const alternation = (): string => {
    const first = sequence();
    while (source[i] === "|") {
      i++;
      sequence();
    }
    return first;
  };
  const sequence = (): string => {
    let out = "";
    while (i < source.length && source[i] !== "|" && source[i] !== ")") {
      const [atom, isDot] = atomAt();
      let min = 1;
      const q = /^(\*|\+|\?|\{(\d+)(,\d*)?\})\??/.exec(source.slice(i));
      if (q) {
        i += q[0].length;
        min = q[1] === "+" ? 1 : q[2] !== undefined ? Number(q[2]) : 0;
      }
      if (isDot && dot !== undefined) min = Math.max(min, 1);
      out += atom.repeat(min);
    }
    return out;
  };
  const atomAt = (): [string, boolean] => {
    const c = source[i++]!;
    if (c === "(") {
      if (source.startsWith("?:", i)) i += 2;
      const inner = alternation();
      i++;
      return [inner, false];
    }
    if (c === "^" || c === "$") return ["", false];
    if (c === ".") return [dot ?? "x", true];
    if (c === "\\") {
      const n = source[i++]!;
      return [n === "d" ? "0" : n === "w" ? "a" : n === "s" ? " " : n, false];
    }
    if (c === "[") {
      const negated = source[i] === "^";
      if (negated) i++;
      let body = "";
      while (source[i] !== "]") body += source[i++]!;
      i++;
      const members = new RegExp(`[${body}]`, "u");
      if (negated)
        return [["a", "z", "0"].find((x) => !members.test(x))!, false];
      return [
        body.startsWith("\\d") ? "0" : body.startsWith("\\w") ? "a" : body[0]!,
        false,
      ];
    }
    return [c, false];
  };
  return alternation();
}

test("each translated vendor pattern has an input where the translation matches and the unchanged pattern does not (Ruby's answer asserted, not computed)", () => {
  // Why: a translation is only needed where carrying Linguist's text as JavaScript would answer
  // differently. For each translated row, one input built from the row's own reasons shows it:
  // the translation matches and the unchanged pattern read as JavaScript does not. That Ruby
  // matches too is asserted, not computed here: no Ruby runs in this test. Ruby's answers on
  // these constructs were checked against Ruby 2.6 outside the test, by the implementer and by
  // the reviewer.
  for (const [index, row] of VENDOR_PATTERNS.entries()) {
    if (row.js === undefined) continue;
    const ours = VENDOR_REGEXPS[index]!.regexp;
    const naive = new RegExp(row.pattern);
    const plain = example(row.pattern);
    expect(ours.test(plain)).toBe(true);
    const witnesses = [
      ...(row.why!.includes("^") ? [`x\n${plain}`] : []),
      ...(row.why!.includes("$") ? [`${plain}\nx`] : []),
      ...(row.why!.includes(".")
        ? [example(row.pattern, "\r"), example(row.pattern, " ")]
        : []),
    ];
    const differing = witnesses.filter(
      (input) => ours.test(input) && !naive.test(input),
    );
    expect({ line: row.line, differing: differing.length > 0 }).toEqual({
      line: row.line,
      differing: true,
    });
    if (row.why!.includes("\\-"))
      expect(() => new RegExp(row.pattern, "u")).toThrow();
  }
});

test("the vendor translations keep Ruby's meaning on the characters where the languages part", () => {
  const vendor = (line: number) =>
    VENDOR_REGEXPS[VENDOR_PATTERNS.findIndex((row) => row.line === line)]!
      .regexp;
  // `[^\s]`: Ruby's \s has no U+00A0, so `custom.bootstrap<NBSP>js` matches in Ruby.
  expect(vendor(78).test("custom.bootstrap js")).toBe(true);
  expect(
    new RegExp(
      String.raw`(^|/)custom\.bootstrap([^\s]*)(js|css|less|scss|styl)$`,
    ).test("custom.bootstrap js"),
  ).toBe(false);
  // `^` is no line start after a final line feed: Ruby's `"a\n" =~ /\n^/` is nil.
  expect(new RegExp(`\\n${RUBY_LINE_START}`, "u").test("a\n")).toBe(false);
  expect(new RegExp(`\\n${RUBY_LINE_START}`, "u").test("a\nb")).toBe(true);
  // Case: the vendor regexp has no flags.
  expect(vendor(112).test("Vendor/x.js")).toBe(true);
  expect(vendor(112).test("VENDOR/x.js")).toBe(false);
});

// Every Ruby regexp a generated rule carries.
function regexps(value: unknown): RubyRegexp[] {
  if (value === null || typeof value !== "object") return [];
  if ("ruby" in value && "regexp" in value) return [value as RubyRegexp];
  return Object.values(value).flatMap(regexps);
}

test("the generated rules are generated?'s chain, in Linguist's order, under its method names", () => {
  const source = carried("generated.rb").toString("utf8");
  const body = /\n    def generated\?\n([\s\S]*?)\n    end\n/.exec(source)![1]!;
  const chain = body.split("||").map((name) => name.trim());
  expect(chain.length).toBe(74);
  expect(GENERATED_RULES.map((rule): string => rule.name)).toEqual(chain);
  for (const name of chain) expect(source).toContain(`    def ${name}\n`);
  expect(LEFT_OUT).toEqual([]);
});

test("every Ruby literal a rule carries is in generated.rb verbatim, and its translation is the translator's", () => {
  const source = carried("generated.rb").toString("utf8");
  const all = regexps(GENERATED_RULES);
  expect(all.length).toBe(68);
  for (const literal of all) {
    expect(source).toContain(literal.ruby);
    const [, body, flags] = literal.ruby.startsWith("%r{")
      ? [null, literal.ruby.slice(3, -1), ""]
      : /^\/([\s\S]*)\/([a-z]*)$/.exec(literal.ruby)!;
    const options = {
      mode: literal.flags.includes("u")
        ? ("text" as const)
        : ("binary" as const),
      ignoreCase: flags!.includes("i"),
      extended: flags!.includes("x"),
    };
    expect(literal.flags.replace("u", "")).toBe(flags!.replace("x", ""));
    if (literal.hand === undefined)
      expect(literal.js).toBe(translateRubyRegexp(body!, options));
    else expect(() => translateRubyRegexp(body!, options)).toThrow();
  }
  expect(
    all
      .filter((literal) => literal.hand !== undefined)
      .map((literal) => literal.ruby),
  ).toEqual([
    String.raw`/(\.css|\.js)\.map$/i`,
    String.raw`/<meta(\s+[^>]++)>/i`,
  ]);
});

test("the translator fails loudly on Ruby it does not port", () => {
  const refused = [
    String.raw`a++`,
    String.raw`a{1,2}+`,
    String.raw`\h`,
    String.raw`(?i)a`,
    String.raw`(?<name>a)`,
    String.raw`(?>a)`,
    String.raw`(a)\1`,
    String.raw`[[:alpha:]]`,
    String.raw`[a[b]]`,
    String.raw`[a&&b]`,
    String.raw`a{,2}`,
    "é",
  ];
  for (const source of refused)
    expect(() => translateRubyRegexp(source, { mode: "text" })).toThrow(
      "cannot translate",
    );
  // Under /i on a path, folds JavaScript does not share.
  for (const source of ["ss", "[a]", String.raw`\w`])
    expect(() =>
      translateRubyRegexp(source, { mode: "text", ignoreCase: true }),
    ).toThrow("cannot translate");
});

test("the source-map name keeps Onigmo's folding of ß to ss", () => {
  // Ruby 2.6 matches all of these against /(\.css|\.js)\.map$/i.
  const literal = regexps(
    GENERATED_RULES.find((rule) => rule.name === "source_map?"),
  ).find((r) => r.ruby.includes("css"))!;
  for (const name of [
    "a.css.map",
    "a.CSS.MAP",
    "a.cß.map",
    "a.cẞ.map",
    "a.cſs.map",
    "a.js.map",
  ])
    expect(literal.regexp.test(name)).toBe(true);
  for (const name of ["a.cs.map", "a.ts.map"])
    expect(literal.regexp.test(name)).toBe(false);
});

test("File.extname answers as Ruby does", () => {
  // Ruby 2.6's answers, except "foo.", where Ruby 2.7 and later give ".".
  const cases: [string, string][] = [
    ["foo.", "."],
    [".bashrc", ""],
    ["a/.b.c", ".c"],
    ["foo.rb/", ".rb"],
    ["..foo", ""],
    ["a.b/c", ""],
    ["a/b.c.d", ".d"],
    [".a.b", ".b"],
    ["a..b", ".b"],
    ["..", ""],
    ["a//", ""],
    ["a.b//", ".b"],
    ["dir.d/file", ""],
  ];
  for (const [path, extname] of cases)
    expect([path, rubyExtname(path)]).toEqual([path, extname]);
  expect(() => rubyExtname("a\0.js")).toThrow();
});
