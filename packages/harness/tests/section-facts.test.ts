// Why: section facts feed code rules that can only raise a lane, so a wrong fact silently sends a
// section to the wrong review, and a guessed one is worse than none. Each test below names the fact
// it holds. Inputs are real Graph structures of small files (`computeBlobStructure` over the built
// engine's outline, as the stored structure is made) and hunks as Git prints them. One test holds
// the stored computation's key: keyed by exactly what it reads, so a blob whose structure changes is
// computed again.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";

import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import { captureOutlineSource, readOutlines } from "../src/graph-outline.ts";
import type { ManifestHunk } from "../src/manifest.ts";
import {
  computeSectionFacts,
  sectionFactsSpec,
  storedSectionFacts,
  type SectionFact,
} from "../src/section-facts.ts";
import {
  computeBlobStructure,
  noStructure,
  sectionPlace,
  type BlobStructure,
} from "../src/sections.ts";
import { diff, oidOf } from "./section-fixtures.ts";

const FACTS_BASE = `export class Cache {
  get(key: string): number {
    return 1;
  }
}

export function body(a: number) {
  return a;
}

export function sig(a: number) {
  return a;
}

function priv() {}

export function gone() {}
`;
/** `fresh` added at the top; `gone` deleted on its own; the rest changed in place. */
const FACTS_HEAD = `export function fresh() {}

export class Cache {
  get(key: string): number {
    return 1;
  }
  set(key: string) {}
}

export function body(a: number) {
  return a + 1;
}

export function sig(a: number, b: number) {
  return a;
}

export function priv() {}
`;

const RUST_BODY = {
  before: "pub fn two(b: i32) -> i32 {\n    let c = b + 1;\n    c\n}\n",
  after: "pub fn two(b: i32) -> i32 {\n    let c = b + 2;\n    c\n}\n",
};
const texts: Array<{ path: string; text: string }> = [
  { path: "base/facts.ts", text: FACTS_BASE },
  { path: "head/facts.ts", text: FACTS_HEAD },
  { path: "base/body.rs", text: RUST_BODY.before },
  { path: "head/body.rs", text: RUST_BODY.after },
];
const outlines = await readOutlines(
  texts.map(({ path, text }) => ({
    path,
    bytes: new TextEncoder().encode(text),
  })),
  captureOutlineSource(),
);
const stored = (path: string, side: "base" | "head", text: string) =>
  computeBlobStructure(path, text, outlines.context(`${side}/${path}`))
    .structure;

/** One file's change: its hunks, both blobs' stored structures, and its sections' facts. */
const change = (
  path: string,
  before: string,
  after: string,
  options: {
    readonly hunk?: Partial<ManifestHunk>;
    readonly edit?: (structure: BlobStructure) => BlobStructure;
  } = {},
) => {
  const hunks = diff(path, before, after, options.hunk);
  const edit = options.edit ?? ((structure) => structure);
  const structures = new Map<string, BlobStructure>([
    [oidOf(before), edit(stored(path, "base", before))],
    [oidOf(after), edit(stored(path, "head", after))],
  ]);
  return { hunks, structures, ...computeSectionFacts(hunks, structures) };
};

/** The facts of the section named `name`, by fact name (a symbol's signature by its id's tail). */
const factsOf = (result: ReturnType<typeof change>, name: string) => {
  const sections = result.sections.filter((section) => section.name === name);
  expect(sections).toHaveLength(1);
  const key = result.identities.get(sections[0]!.key)!.key;
  const facts = result.facts.filter((fact) => fact.about.key === key);
  return {
    key,
    facts,
    one: (fact: SectionFact["fact"]) => {
      const found = facts.filter((entry) => entry.fact === fact);
      expect(found).toHaveLength(1);
      return found[0]!;
    },
  };
};
const valueAndReason = (fact: SectionFact) => [fact.value, fact.reason];

const facts = change("facts.ts", FACTS_BASE, FACTS_HEAD);

test("a declaration only the head has is added (fact: declaration added)", () => {
  const fresh = factsOf(facts, "fresh");
  expect(valueAndReason(fresh.one("declaration"))).toEqual(["added", null]);
  // Matching reads the span's text hash too (unchanged spans are matched by it).
  expect(fresh.one("declaration").evidence).toEqual([
    "structure.spans[].kind,name",
    "structure.spans[].textSha256",
  ]);
  // Nothing to compare it with: not known, never false.
  expect(valueAndReason(fresh.one("body-changed"))).toEqual([
    null,
    "no-counterpart",
  ]);
});

test("a declaration deleted whole is removed and old-side only (facts: declaration removed, old side only)", () => {
  const gone = factsOf(facts, "gone");
  expect(valueAndReason(gone.one("declaration"))).toEqual(["removed", null]);
  expect(gone.one("old-side-only").value).toBe(true);
  expect(gone.one("size").value).toEqual({
    addedRows: 0,
    removedRows: 2,
    changedCharacters: "export function gone() {}".length,
    headLines: null,
    headCharacters: null,
    baseLines: 2,
    baseCharacters: "\nexport function gone() {}\n".length,
  });
  expect(factsOf(facts, "priv").one("old-side-only").value).toBe(false);
});

test("a changed parameter list is a changed signature, and leaves the body not known (fact: signature changed)", () => {
  const sig = factsOf(facts, "sig");
  expect(valueAndReason(sig.one("declaration"))).toEqual(["changed", null]);
  expect(valueAndReason(sig.one("signature"))).toEqual([true, null]);
  expect(sig.one("signature").id).toBe(`${sig.key}.signature:function::sig:1`);
  expect(valueAndReason(sig.one("body-changed"))).toEqual([
    null,
    "signature-changed",
  ]);
});

test("a changed line inside a declaration with the same signature is a changed body; the export keyword alone is not (fact: body changed)", () => {
  const body = factsOf(facts, "body");
  expect(valueAndReason(body.one("signature"))).toEqual([false, null]);
  expect(valueAndReason(body.one("body-changed"))).toEqual([true, null]);
  expect(body.one("symbol").value).toEqual({
    kind: "function",
    container: null,
  });
  // `function priv` became `export function priv`: Graph's signature leaves `export` out, and only
  // the first line changed, so the body is not known.
  const priv = factsOf(facts, "priv");
  expect(valueAndReason(priv.one("signature"))).toEqual([false, null]);
  expect(valueAndReason(priv.one("body-changed"))).toEqual([
    null,
    "first-line-only",
  ]);
});

test("a method added to a class is a symbol added to its span, and a changed body (fact: class member added)", () => {
  const cache = factsOf(facts, "Cache");
  expect(cache.one("symbols-added").value).toEqual(["method Cache.set"]);
  expect(cache.one("symbols-removed").value).toEqual([]);
  expect(cache.one("symbol").value).toEqual({
    kind: "class",
    container: null,
  });
  expect(valueAndReason(cache.one("body-changed"))).toEqual([true, null]);
  expect(
    cache.facts
      .filter((fact) => fact.fact === "signature")
      .map((fact) => [fact.id.slice(cache.key.length), fact.value]),
  ).toEqual([
    [".signature:class::Cache:1", false],
    [".signature:method:Cache:get:1", false],
  ]);
});

test("a Rust function's changed body is a changed body, with its own signature the same (the span took its name from Graph's body block, whose signature is the body, so the body was not known)", () => {
  const result = change("body.rs", RUST_BODY.before, RUST_BODY.after);
  const two = factsOf(result, "two");
  expect(two.one("symbol").value).toEqual({
    kind: "function",
    container: null,
  });
  expect(
    two.facts
      .filter((fact) => fact.id.endsWith("signature:function::two:1"))
      .map(valueAndReason),
  ).toEqual([[false, null]]);
  expect(valueAndReason(two.one("body-changed"))).toEqual([true, null]);
});

test("the repository's declared kinds are the file's declared kind, and none is undeclared (fact: declared kind)", () => {
  const generated = change("facts.ts", FACTS_BASE, FACTS_HEAD, {
    hunk: {
      declared: [
        { kind: "generated", by: "gitattributes: linguist-generated=true" },
        { kind: "generated", by: "generated-marker: @generated" },
      ],
    },
  });
  expect(factsOf(generated, "body").one("declared-kind").value).toEqual([
    "generated",
  ]);
  expect(factsOf(facts, "body").one("declared-kind").value).toEqual([]);
});

test("a kind only Linguist's lists give is worded as Linguist's mark, not the repository's declaration, and keys apart from it (fact: declared kind)", () => {
  // Why: decision 14.18's marks are the standard's, not the repository's; the stored facts are keyed
  // by kind, so a key that did not tell the two apart would reuse the wrong statement.
  const repository = {
    kind: "generated" as const,
    by: "gitattributes: linguist-generated=true",
  };
  const linguist = {
    kind: "generated" as const,
    by: "linguist v9.7.0 vendored: (^|/)dist/",
    standard: "linguist-vendored" as const,
  };
  const marked = change("facts.ts", FACTS_BASE, FACTS_HEAD, {
    hunk: { declared: [linguist] },
  });
  const both = change("facts.ts", FACTS_BASE, FACTS_HEAD, {
    hunk: { declared: [repository, linguist] },
  });
  const own = change("facts.ts", FACTS_BASE, FACTS_HEAD, {
    hunk: { declared: [repository] },
  });
  const kind = (result: ReturnType<typeof change>) =>
    factsOf(result, "body").one("declared-kind");
  expect([kind(marked).value, kind(marked).statement]).toEqual([
    ["generated"],
    "GitHub Linguist's vendored list marks it",
  ]);
  expect(kind(both).statement).toBe(
    "the repository declares the file generated; GitHub Linguist's vendored list marks it",
  );
  expect(kind(own).statement).toBe(
    "the repository declares the file generated",
  );
  const keyOf = (result: ReturnType<typeof change>) =>
    Computations.computationKey(
      sectionFactsSpec(result.hunks, result.structures),
    ).key;
  expect(new Set([keyOf(marked), keyOf(both), keyOf(own)]).size).toBe(3);
});

test("where Graph gives no signature the signature and the body are not known, never false (fact: not known)", () => {
  const unsigned = change("facts.ts", FACTS_BASE, FACTS_HEAD, {
    // The stored shape allows it: Graph's observation leaves a symbol's signature out.
    edit: (structure) => ({
      ...structure,
      spans: structure.spans.map((span) => ({
        ...span,
        symbols: span.symbols.map((symbol) =>
          symbol.name === "body" ? { ...symbol, signature: null } : symbol,
        ),
      })),
    }),
  });
  const body = factsOf(unsigned, "body");
  expect(valueAndReason(body.one("signature"))).toEqual([
    null,
    "signature-not-given",
  ]);
  expect(valueAndReason(body.one("body-changed"))).toEqual([
    null,
    "signature-not-given",
  ]);
});

test("every fact has a unique id built from its section's identity key, and states its evidence", () => {
  const ids = facts.facts.map((fact) => fact.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const fact of facts.facts) {
    expect(fact.id.startsWith(`${fact.about.key}.`)).toBe(true);
    expect(fact.evidence.length).toBeGreaterThan(0);
    // Not known always says why; a known value has no reason.
    if (fact.value === null) expect(fact.reason).not.toBeNull();
    else expect(fact.reason).toBeNull();
  }
});

const root = mkdtempSync(join(tmpdir(), "section-facts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `storedSectionFacts` over one named store under the test's folder. */
const storedFactsIn = (
  name: string,
  repository: string,
  hunks: ReadonlyArray<ManifestHunk>,
) => {
  const location = storeLocationIn(join(root, name));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  return Effect.runPromise(
    storedSectionFacts(repository, hunks, captureOutlineSource()).pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provideService(CodeWork, undefined),
      Effect.provide(layer),
    ),
  );
};

test("the stored computation's key changes when a blob's structure changes (a blob given with none, here for conflicting paths, later read with a cut), and not with input order; a second run reads what the first stored (keyed by what it reads)", async () => {
  const { hunks, structures } = change("facts.ts", FACTS_BASE, FACTS_HEAD);
  const key = (
    list: ReadonlyArray<ManifestHunk>,
    map: ReadonlyMap<string, BlobStructure>,
  ) => Computations.computationKey(sectionFactsSpec(list, map)).key;
  const full = key(hunks, structures);
  // `storedSectionFacts` gives every text blob a structure: one it cannot use has none, with why.
  const conflicted = new Map(structures);
  conflicted.set(oidOf(FACTS_HEAD), noStructure("conflicting-paths"));
  expect(key(hunks, conflicted)).not.toBe(full);
  // A structure that differs at all (here: one signature) is another key too.
  const edited = new Map(structures);
  const head = structures.get(oidOf(FACTS_HEAD))!;
  edited.set(oidOf(FACTS_HEAD), {
    ...head,
    spans: head.spans.map((span, index) =>
      index === 0
        ? {
            ...span,
            symbols: span.symbols.map((symbol) => ({
              ...symbol,
              signature: null,
            })),
          }
        : span,
    ),
  });
  expect(key(hunks, edited)).not.toBe(full);
  const shuffled = [...hunks].reverse();
  const reordered = new Map([...structures].reverse());
  expect(key(shuffled, reordered)).toBe(full);
  expect(computeSectionFacts(shuffled, reordered).facts).toEqual(
    computeSectionFacts(hunks, structures).facts,
  );

  // The Effect: structures read through `blobStructures` (Markdown: no Graph), stored once.
  const repository = join(root, "repo");
  Bun.spawnSync(["git", "init", "-q", repository]);
  const before = "# Alpha\nalpha\n\n# Beta\nbeta\n";
  const after = "# Alpha\nalpha two\n\n# Beta\nbeta\n";
  for (const text of [before, after])
    Bun.spawnSync(["git", "-C", repository, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode(text),
    });
  const blobOf = (text: string) =>
    Bun.spawnSync(["git", "-C", repository, "hash-object", "--stdin"], {
      stdin: new TextEncoder().encode(text),
    })
      .stdout.toString()
      .trim();
  const markdownHunks = diff("notes.md", before, after).map((hunk) => ({
    ...hunk,
    oldOid: blobOf(before),
    newOid: blobOf(after),
  }));
  const run = () => storedFactsIn("store", repository, markdownHunks);
  const first = await run();
  const second = await run();
  expect([first.status, second.status]).toEqual(["computed", "reused"]);
  expect(second.key).toBe(first.key);
  expect(second.facts).toEqual(first.facts);
  expect(first.sections.map((section) => section.name)).toEqual(["Alpha"]);
  expect(
    first.facts
      .filter((fact) => fact.fact === "body-changed")
      .map(valueAndReason),
  ).toEqual([[true, null]]);
}, 60_000);

/** One file's change read from Graph in its own outline read, for a test of its own. */
const changeOnGraph = async (
  path: string,
  before: string,
  after: string,
  edit?: (structure: BlobStructure, side: "base" | "head") => BlobStructure,
) => {
  const read = await readOutlines(
    [
      { path: `base/${path}`, bytes: new TextEncoder().encode(before) },
      { path: `head/${path}`, bytes: new TextEncoder().encode(after) },
    ],
    captureOutlineSource(),
  );
  const side = (text: string, at: "base" | "head") => {
    const structure = computeBlobStructure(
      path,
      text,
      read.context(`${at}/${path}`),
    ).structure;
    return edit === undefined ? structure : edit(structure, at);
  };
  const hunks = diff(path, before, after);
  const structures = new Map<string, BlobStructure>([
    [oidOf(before), side(before, "base")],
    [oidOf(after), side(after, "head")],
  ]);
  return { hunks, structures, ...computeSectionFacts(hunks, structures) };
};
/** Every fact of one kind across the change's sections. */
const allOf = (
  result: { facts: ReadonlyArray<SectionFact> },
  fact: SectionFact["fact"],
) => result.facts.filter((entry) => entry.fact === fact);

test("a same-named Go method inserted before an existing one is added, and the existing one is untouched (it was matched as the existing one, changed)", async () => {
  // Something between them: adjacent spans of one name are joined into one.
  const before = `package p

func other() {}

func (b B) String() string {
	return "b"
}
`;
  const after = `package p

func (a A) String() string {
	return "a"
}

func other() {}

func (b B) String() string {
	return "b"
}
`;
  const result = await changeOnGraph("insert.go", before, after);
  // One `String` section, the inserted one; the blank line Git added is `other`'s.
  const strings = result.sections.filter(
    (section) => section.name === "String",
  );
  expect(strings.map((section) => sectionPlace(section))).toEqual([
    { side: "new", startLine: 2, endLine: 5 },
  ]);
  const key = result.identities.get(strings[0]!.key)!.key;
  const own = result.facts.filter((fact) => fact.about.key === key);
  expect(
    own.filter((fact) => fact.fact === "declaration").map(valueAndReason),
  ).toEqual([["added", null]]);
  expect(own.filter((fact) => fact.fact === "signature")).toEqual([]);
});

test("the first of two Markdown sections of one name deleted is removed, and the second's body is not changed (its rows landed in the second, body changed)", () => {
  const before =
    "## Usage\nfirst use\n\n## Other\nother\n\n## Usage\nsecond use\n";
  const after = "## Other\nother\n\n## Usage\nsecond use\n";
  const hunks = diff("guide.md", before, after);
  const structures = new Map<string, BlobStructure>(
    [before, after].map((text) => [
      oidOf(text),
      computeBlobStructure("guide.md", text, { kind: "unavailable" }).structure,
    ]),
  );
  const result = computeSectionFacts(hunks, structures);
  expect(allOf(result, "declaration").map(valueAndReason)).toEqual([
    ["removed", null],
  ]);
  expect(allOf(result, "body-changed").map(valueAndReason)).toEqual([
    [null, "no-counterpart"],
  ]);
});

test("a body changed in the second of two adjacent Go methods of one name is a changed body (the fact read only the first, and said false)", async () => {
  const before = `package p

func (a A) String() string {
	return "a"
}
func (b B) String() string {
	return "b"
}
`;
  const after = before.replace('return "b"', 'return "bb"');
  const result = await changeOnGraph("twins.go", before, after);
  expect(result.sections.map((section) => section.name)).toEqual(["String"]);
  const symbols = result.structures
    .get(oidOf(after))!
    .spans.flatMap((span) =>
      span.name === "String"
        ? span.symbols.map((symbol) => symbol.qualifiedName)
        : [],
    );
  // One span holds both: the joined span this finding is about.
  expect(symbols).toEqual(["A.String", "B.String"]);
  expect(allOf(result, "body-changed").map(valueAndReason)).toEqual([
    [true, null],
  ]);
});

test("a declaration moved without change has no changed body: equal text wins", async () => {
  const before =
    "export function one() {\n  return 1;\n}\n\nexport function two() {\n  return 2;\n}\n\nexport function three() {\n  return 3;\n}\n";
  const after =
    "export function one() {\n  return 1;\n}\n\nexport function three() {\n  return 3;\n}\n\nexport function two() {\n  return 2;\n}\n";
  const result = await changeOnGraph("moved.ts", before, after);
  // Git may show either neighbour as moved; each moved span is the same text on both sides.
  expect(result.sections.length).toBeGreaterThan(0);
  for (const fact of allOf(result, "declaration"))
    expect(valueAndReason(fact)).toEqual(["changed", null]);
  for (const fact of allOf(result, "body-changed"))
    expect(valueAndReason(fact)).toEqual([false, null]);
});

test("a statement that is still there after a blank line before it was removed is not 'removed' (an unnamed span has no counterpart rule)", async () => {
  const before = "const app = make();\n\n// routes\napp.use(\n  a,\n  b,\n);\n";
  const after = "const app = make();\n// routes\napp.use(\n  a,\n  b,\n);\n";
  const result = await changeOnGraph("app.ts", before, after);
  expect(allOf(result, "declaration").map(valueAndReason)).toEqual([
    [null, "unnamed-span"],
  ]);
});

test("symbols whose parts hold colons are matched by their own parts, and their signature ids cannot collide", () => {
  const symbol = (container: string, name: string, signature: string) => ({
    name,
    kind: "method",
    qualifiedName: `${container}.${name}`,
    signature,
    container,
    startLine: 8,
    endLine: 8,
  });
  const x = symbol("a:b", "c", "x()");
  const y = symbol("a", "b:c", "y()");
  const withSymbols = (
    structure: BlobStructure,
    symbols: ReadonlyArray<ReturnType<typeof symbol>>,
  ): BlobStructure => ({
    ...structure,
    spans: structure.spans.map((span) =>
      span.name === "body"
        ? { ...span, symbols: [...span.symbols, ...symbols] }
        : span,
    ),
  });
  const structures = new Map(facts.structures);
  structures.set(
    oidOf(FACTS_BASE),
    withSymbols(facts.structures.get(oidOf(FACTS_BASE))!, [x, y]),
  );
  structures.set(
    oidOf(FACTS_HEAD),
    withSymbols(facts.structures.get(oidOf(FACTS_HEAD))!, [y, x]),
  );
  const result = computeSectionFacts(facts.hunks, structures);
  const section = result.sections.find((entry) => entry.name === "body")!;
  const key = result.identities.get(section.key)!.key;
  const body = result.facts.filter(
    (fact) =>
      fact.fact === "signature" &&
      fact.about.key === key &&
      fact.id.includes("signature:method"),
  );
  expect(
    body.map((fact) => [fact.id.split(".signature:")[1], fact.value]),
  ).toEqual([
    ["method:a%3Ab:c:1", false],
    ["method:a:b%3Ac:1", false],
  ]);
});

/** The facts of one kind on the sections named `name`. */
const namedFacts = (
  result: {
    sections: ReadonlyArray<{ key: string; name: string | undefined }>;
    identities: ReadonlyMap<string, { key: string }>;
    facts: ReadonlyArray<SectionFact>;
  },
  name: string,
  fact: SectionFact["fact"],
) => {
  const keys = new Set(
    result.sections
      .filter((section) => section.name === name)
      .map((section) => result.identities.get(section.key)!.key),
  );
  return result.facts.filter(
    (entry) => entry.fact === fact && keys.has(entry.about.key),
  );
};

test("with three suites' `works` tests, the middle deleted and the first edited, neither is called added or removed: several share the name (it read 'added, the base has no declaration of this kind and name')", async () => {
  const suite = (name: string, line: string) =>
    `describe("${name}", () => {\n  it("works", () => {\n    ${line}\n  });\n});\n`;
  const before =
    suite("a", "expect(1).toBe(1);") +
    suite("b", "expect(2).toBe(2);") +
    suite("c", "expect(3).toBe(3);");
  const after =
    suite("a", "expect(1).toBe(10);") + suite("c", "expect(3).toBe(3);");
  const result = await changeOnGraph("three.test.ts", before, after);
  const works = namedFacts(result, '"works"', "declaration");
  expect(works.length).toBeGreaterThan(0);
  for (const fact of works)
    expect(valueAndReason(fact)).toEqual([null, "ambiguous-namesake"]);
});

test("one declaration replaced by another of the same name is changed, and the statement says it was matched by name and position (that is all the evidence shows)", () => {
  const before = "# Step\nfirst\n";
  const after = "# Step\nsecond\n";
  const hunks = diff("step.md", before, after);
  const structures = new Map<string, BlobStructure>(
    [before, after].map((text) => [
      oidOf(text),
      computeBlobStructure("step.md", text, { kind: "unavailable" }).structure,
    ]),
  );
  const [declaration] = allOf(
    computeSectionFacts(hunks, structures),
    "declaration",
  );
  expect(declaration!.value).toBe("changed");
  expect(declaration!.statement).toContain("by position");
});

test("a row changed in another block of a one-span Terraform file is not 'no body change' (the fact read the first block only, and said false)", async () => {
  const before =
    'resource "a" "one" {\n  x = 1\n}\n\nresource "a" "two" {\n  y = 2\n}\n';
  const after = before.replace("y = 2", "y = 3");
  const result = await changeOnGraph("main.tf", before, after);
  expect(result.sections.map((section) => section.name)).toEqual(["one"]);
  expect(allOf(result, "body-changed").map(valueAndReason)).toEqual([
    [null, "signature-changed"],
  ]);
});

test("a body changed in the second declarator of `export const a = 1, b = () => …` is a changed body (it read `a` only, and said false)", async () => {
  const before = "export const a = 1, b = () => {\n  return 2;\n};\n";
  const after = before.replace("return 2", "return 3");
  const result = await changeOnGraph("pair.ts", before, after);
  expect(allOf(result, "body-changed").map(valueAndReason)).toEqual([
    [true, null],
  ]);
});

test("a declaration moved to the end unchanged, with a different blank line before it, has no changed body (it read true)", async () => {
  const before =
    "export function alpha() {\n  return 1;\n}\n\nexport function beta() {\n  return 2;\n}\n";
  const after =
    "export function beta() {\n  return 2;\n}\n\nexport function alpha() {\n  return 1;\n}\n";
  const result = await changeOnGraph("move.ts", before, after);
  const body = allOf(result, "body-changed");
  expect(body.length).toBeGreaterThan(0);
  for (const fact of body) expect(valueAndReason(fact)).toEqual([false, null]);
});

test("a statement moved inside a function body is a changed body (its added and removed rows read the same, which was read as a move)", async () => {
  const before =
    "export function order() {\n  first();\n  second();\n  third();\n}\n";
  const after =
    "export function order() {\n  second();\n  third();\n  first();\n}\n";
  const result = await changeOnGraph("order.ts", before, after);
  expect(allOf(result, "body-changed").map(valueAndReason)).toEqual([
    [true, null],
  ]);
});

test("a blank line removed inside a body leaves the body not known: inside a template string or a heredoc it is content", async () => {
  const before = "export function spaced() {\n  first();\n\n  second();\n}\n";
  const after = "export function spaced() {\n  first();\n  second();\n}\n";
  const result = await changeOnGraph("spaced.ts", before, after);
  expect(allOf(result, "body-changed").map(valueAndReason)).toEqual([
    [null, "blank-lines-only"],
  ]);
});

test("one blob read under two paths whose structures differ is given, with none and why, so the facts compute without a throw (a blob left out made the identities throw)", async () => {
  const repository = join(root, "two-paths");
  Bun.spawnSync(["git", "init", "-q", repository]);
  const write = (text: string) =>
    Bun.spawnSync(["git", "-C", repository, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode(text),
    })
      .stdout.toString()
      .trim();
  // The same base under a Markdown path and a plain-text one: a heading cut, and none.
  const base = "# Alpha\nalpha\n\n# Beta\nbeta\n";
  const markdown = "# Alpha\nalpha two\n\n# Beta\nbeta\n";
  const text = "# Alpha\nalpha\n\n# Beta\nbeta three\n";
  const blobs = new Map(
    [base, markdown, text].map((value) => [value, write(value)]),
  );
  const hunksOf = (path: string, after: string) =>
    diff(path, base, after).map((hunk) => ({
      ...hunk,
      oldOid: blobs.get(base)!,
      newOid: blobs.get(after)!,
    }));
  // Both files, identical on both sides: each blob is read under both paths.
  const same = [
    ...hunksOf("notes.md", markdown),
    ...hunksOf("notes.txt", markdown),
  ];
  const both = await storedFactsIn("two-paths-same", repository, same);
  expect(both.sections.map((section) => [section.path, section.basis])).toEqual(
    [
      ["notes.md", "conflicting-paths"],
      ["notes.txt", "conflicting-paths"],
    ],
  );
  // Only the base under both paths: the Markdown file's head is cut, its base has no cut, and why.
  const shared = [
    ...hunksOf("notes.md", markdown),
    ...hunksOf("notes.txt", text),
  ];
  const one = await storedFactsIn("two-paths-base", repository, shared);
  const markdownSections = one.sections.filter(
    (section) => section.path === "notes.md",
  );
  expect(markdownSections.map((section) => section.basis)).toEqual([
    "markdown-sections",
  ]);
  const key = one.identities.get(markdownSections[0]!.key)!.key;
  expect(
    one.facts
      .filter((fact) => fact.about.key === key && fact.fact === "declaration")
      .map(valueAndReason),
  ).toEqual([[null, "structure:conflicting-paths"]]);
}, 60_000);
