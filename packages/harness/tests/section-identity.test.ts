// Why: a judgement made on a section is carried to the same change later by its identity key, and
// unit identity is built from the set of those keys. A key that moves with line numbers or input
// order loses judgements; a key that survives a different change, or that two sections share, puts
// a judgement on code nobody judged. Each test below names the case it holds. Inputs are real
// `sectionsOf` output over small Markdown files, whose structure is the stored structure's own
// producer (`computeBlobStructure`) and needs no Graph.
import { expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "@neuve/records-core";

import { hunkContentKey } from "../src/hunks.ts";
import type { ManifestHunk } from "../src/manifest.ts";
import {
  SECTION_IDENTITY_RECIPE,
  orderedSectionKeys,
  sectionIdentities,
  sectionKeySetHash,
  type SectionIdentity,
} from "../src/section-identity.ts";
import {
  asStructure,
  computeBlobStructure,
  noStructure,
  sectionsOf,
  type BlobStructure,
  type Structure,
} from "../src/sections.ts";

const sha = (text: string) => sha256Hex(text);
const oidOf = (text: string) => sha(`blob\0${text}`).slice(0, 40);

/** The stored structure of a file, as the blob-structure pass computes it. */
const structureOf = (path: string, text: string): BlobStructure =>
  computeBlobStructure(path, text, { kind: "unavailable" }).structure;

/**
 * Hunks as Git prints them (one line of context), from a line diff of two texts, with the owned
 * ranges the review rules give: each side's runs of changed lines.
 */
const diff = (
  path: string,
  before: string,
  after: string,
  options: {
    readonly status?: ManifestHunk["status"];
    readonly oldPath?: string;
    readonly withoutContentKey?: boolean;
  } = {},
): ReadonlyArray<ManifestHunk> => {
  const a = before.split("\n").slice(0, -1);
  const b = after.split("\n").slice(0, -1);
  const lcs = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{
    sign: " " | "-" | "+";
    text: string;
    old: number;
    new: number;
  }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ sign: " ", text: a[i]!, old: ++i, new: ++j });
    } else if (
      j >= b.length ||
      (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
    ) {
      ops.push({ sign: "-", text: a[i]!, old: ++i, new: j });
    } else {
      ops.push({ sign: "+", text: b[j]!, old: i, new: ++j });
    }
  }
  const changed = ops.flatMap((op, index) => (op.sign === " " ? [] : [index]));
  const groups: Array<[number, number]> = [];
  for (const index of changed) {
    const last = groups.at(-1);
    if (last !== undefined && index - last[1] <= 3) last[1] = index;
    else groups.push([index, index]);
  }
  const oldOid = oidOf(before);
  const newOid = oidOf(after);
  return groups.map(([from, to]) => {
    const rows = ops.slice(Math.max(0, from - 1), Math.min(ops.length, to + 2));
    const oldRows = rows.filter((row) => row.sign !== "+");
    const newRows = rows.filter((row) => row.sign !== "-");
    const oldStart = oldRows[0]?.old ?? rows[0]!.old;
    const newStart = newRows[0]?.new ?? rows[0]!.new;
    const text = `@@ -${oldStart},${oldRows.length} +${newStart},${newRows.length} @@\n${rows
      .map((row) => `${row.sign}${row.text}`)
      .join("\n")}\n`;
    const runs = (sign: "-" | "+") => {
      const lines = rows
        .filter((row) => row.sign === sign)
        .map((row) => (sign === "-" ? row.old : row.new));
      const out: Array<{
        side: "old" | "new";
        startLine: number;
        lineCount: number;
      }> = [];
      for (const line of lines) {
        const last = out.at(-1);
        if (last !== undefined && last.startLine + last.lineCount === line)
          last.lineCount++;
        else
          out.push({
            side: sign === "-" ? "old" : "new",
            startLine: line,
            lineCount: 1,
          });
      }
      return out;
    };
    const added = rows.filter((row) => row.sign === "+").length;
    const deleted = rows.filter((row) => row.sign === "-").length;
    // Typed as the hunk without `leads`, then cast once: `leads` is leaving the manifest hunk for
    // its own computation and nothing in section identity reads it, so the fixture never names it.
    const hunk: Omit<ManifestHunk, "leads"> = {
      hunkId: `h${sha(`${path}\0${text}`).slice(0, 15)}`,
      ...(options.withoutContentKey
        ? {}
        : { contentKey: hunkContentKey({ path, text }) }),
      kind: "text",
      path,
      oldPath: options.oldPath ?? path,
      newPath: path,
      oldOid,
      newOid,
      status: options.status ?? "modified",
      oldMode: "100644",
      newMode: "100644",
      oldStart,
      oldLines: oldRows.length,
      newStart,
      newLines: newRows.length,
      added,
      deleted,
      text,
      textSha256: sha(text),
      enclosing: null,
      query: null,
      ownedRanges: [...runs("-"), ...runs("+")],
      qualifications: [],
      declared: [],
      countsTowardReviewLines: true,
      allowance: { tokens: 4_000, exactShare: 0, floored: true },
    };
    return hunk as ManifestHunk;
  });
};

/** One change: its hunks, the stored structures of both blobs, and the identities of its sections. */
const change = (
  path: string,
  before: string,
  after: string,
  options: Parameters<typeof diff>[3] & {
    readonly edit?: (structure: BlobStructure) => BlobStructure;
  } = {},
) => {
  const hunks = diff(path, before, after, options);
  const edit = options.edit ?? ((structure) => structure);
  const structures = new Map<string, BlobStructure>([
    [oidOf(before), edit(structureOf(path, before))],
    [oidOf(after), edit(structureOf(path, after))],
  ]);
  const sections = sectionsOf(
    hunks,
    new Map<string, Structure>(
      [...structures].map(([oid, structure]) => [oid, asStructure(structure)]),
    ),
  );
  const byId = new Map(hunks.map((hunk) => [hunk.hunkId, hunk]));
  const identities = sectionIdentities(sections, byId, structures);
  return { hunks, byId, structures, sections, identities };
};

/** The identity of the one section named `name`. */
const named = (
  identities: ReadonlyMap<string, SectionIdentity>,
  name: string,
) => {
  const found = [...identities.values()].filter(
    (identity) => identity.parts.name === name,
  );
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** The parts two identities differ in, ordinal included. */
const differing = (a: SectionIdentity, b: SectionIdentity) =>
  (Object.keys(a.parts) as Array<keyof SectionIdentity["parts"]>).filter(
    (part) => canonicalJson(a.parts[part]) !== canonicalJson(b.parts[part]),
  );

/** The key is exactly the hash of the recipe and the parts: nothing else enters it. */
const expectKeyOfParts = (identity: SectionIdentity) =>
  expect(identity.key).toBe(
    sha(canonicalJson([SECTION_IDENTITY_RECIPE, identity.parts])),
  );

const BASE = `# Alpha
alpha text

# Beta
beta one
beta two

# Gamma
gamma text
`;
const HEAD = BASE.replace("beta two", "beta 2");

test("the same change at shifted lines keeps its key (carried judgements are keyed by it)", () => {
  const plain = named(change("doc.md", BASE, HEAD).identities, "Beta");
  expect(plain.where).toEqual({ startLine: 4, endLine: 7 });
  expect(plain.parts).toMatchObject({
    side: "new",
    kind: "heading",
    ordinal: 1,
  });
  expectKeyOfParts(plain);
  // Lines inserted above, outside every hunk, on both sides.
  const intro = "# Intro\nintro\n\n";
  const above = named(
    change("doc.md", intro + BASE, intro + HEAD).identities,
    "Beta",
  );
  expect(above.where).toEqual({ startLine: 7, endLine: 10 });
  expect(above.key).toBe(plain.key);
  // Lines inserted above in another hunk of the same change: the head moves, the base does not.
  const other = change(
    "doc.md",
    BASE,
    HEAD.replace("alpha text", "alpha text\nmore alpha"),
  );
  expect(other.hunks).toHaveLength(2);
  const shifted = named(other.identities, "Beta");
  expect(shifted.where).toEqual({ startLine: 5, endLine: 8 });
  expect(shifted.key).toBe(plain.key);
});

test("a different changed row, span text, name, kind, side or path changes the key (a surviving key would carry a wrong judgement)", () => {
  const plain = named(change("doc.md", BASE, HEAD).identities, "Beta");
  const variants: Array<
    [SectionIdentity, ReadonlyArray<keyof SectionIdentity["parts"]>]
  > = [
    // One changed row.
    [
      named(
        change("doc.md", BASE, BASE.replace("beta two", "beta II")).identities,
        "Beta",
      ),
      ["spanSha256", "changeSha256"],
    ],
    // The span's text outside the changed rows: the changed rows are the same.
    [
      named(
        change(
          "doc.md",
          BASE.replace("beta one", "beta first"),
          HEAD.replace("beta one", "beta first"),
        ).identities,
        "Beta",
      ),
      // The base's Beta, the counterpart, changed with it.
      ["spanSha256", "counterpartSha256"],
    ],
    // The name, with the same text (a structure edited by hand).
    [
      named(
        change("doc.md", BASE, HEAD, {
          edit: (s) => ({
            ...s,
            spans: s.spans.map((span) =>
              span.name === "Beta" ? { ...span, name: "B" } : span,
            ),
          }),
        }).identities,
        "B",
      ),
      ["name"],
    ],
    // The kind, with the same text and name.
    [
      named(
        change("doc.md", BASE, HEAD, {
          edit: (s) => ({
            ...s,
            spans: s.spans.map((span) =>
              span.name === "Beta"
                ? { ...span, kind: "declaration" as const }
                : span,
            ),
          }),
        }).identities,
        "Beta",
      ),
      ["kind"],
    ],
    // The path.
    [named(change("notes.md", BASE, HEAD).identities, "Beta"), ["path"]],
  ];
  for (const [variant, parts] of variants) {
    expectKeyOfParts(variant);
    expect(differing(plain, variant)).toEqual([...parts]);
    expect(variant.key).not.toBe(plain.key);
  }
  // The side: the Beta section added, and the same section removed. Its span text and the rows'
  // places are the same on both sides; the rows' signs differ too.
  const without = BASE.replace("# Beta\nbeta one\nbeta two\n\n", "");
  const addedBeta = named(change("doc.md", without, BASE).identities, "Beta");
  const removedBeta = named(change("doc.md", BASE, without).identities, "Beta");
  expect([addedBeta.parts.side, removedBeta.parts.side]).toEqual([
    "new",
    "old",
  ]);
  expect(differing(addedBeta, removedBeta)).toEqual(["side", "changeSha256"]);
  expect(removedBeta.where).toEqual({ startLine: 4, endLine: 7 });
  expect(addedBeta.key).not.toBe(removedBeta.key);
});

test("two sections of one file with equal parts get ordinals 1 and 2 in file order, with distinct keys, with or without a span (a collision would merge their judgements)", () => {
  const step = "# Step\nrun it\n\n";
  const before = `${step}# Other\nother\n\n${step}`;
  const spanned = change(
    "doc.md",
    before,
    before.replaceAll("run it", "run it now"),
  );
  const steps = [...spanned.identities.values()].filter(
    (identity) => identity.parts.name === "Step",
  );
  expect(
    steps.map((identity) => [
      identity.parts.ordinal,
      identity.where?.startLine,
    ]),
  ).toEqual([
    [1, 1],
    [2, 7],
  ]);
  expect(differing(steps[0]!, steps[1]!)).toEqual(["ordinal"]);
  expect(steps[0]!.key).not.toBe(steps[1]!.key);
  // No span: a file no capability reads, with the same hunk text twice.
  const script = "echo a\nrun\necho b\n\necho a\nrun\necho b\n";
  const unspanned = change(
    "run.sh",
    script,
    script.replaceAll("run", "run now"),
    {
      edit: () => noStructure("capability-unavailable"),
    },
  );
  const plain = [...unspanned.identities.values()];
  expect(
    plain.map((identity) => [
      identity.parts.side,
      identity.parts.kind,
      identity.parts.ordinal,
    ]),
  ).toEqual([
    ["none", "hunk", 1],
    ["none", "hunk", 2],
  ]);
  expect(plain[0]!.parts.hunkContentKeys).toHaveLength(1);
  expect(plain[0]!.where).toBeNull();
  expect(differing(plain[0]!, plain[1]!)).toEqual(["ordinal"]);
  expect(plain[0]!.key).not.toBe(plain[1]!.key);
  // A stored hunk from before content keys has the key computed, not skipped.
  const older = change("run.sh", script, script.replaceAll("run", "run now"), {
    edit: () => noStructure("capability-unavailable"),
    withoutContentKey: true,
  });
  expect(
    [...older.identities.values()].map((identity) => identity.key),
  ).toEqual(plain.map((identity) => identity.key));
});

/**
 * Two files at once: a long section edited in two places far enough apart to make two hunks, and a
 * file with no structure holding two no-span sections with equal parts.
 */
const LONG = `# Long
${Array.from({ length: 12 }, (_, at) => `line ${at + 1}`).join("\n")}
`;
const SCRIPT = "echo a\nrun\necho b\n\necho a\nrun\necho b\n";
const twoFiles = () => {
  const long = change(
    "doc.md",
    LONG,
    LONG.replace("line 2\n", "line two\n").replace("line 11", "line eleven"),
  );
  const script = change("run.sh", SCRIPT, SCRIPT.replaceAll("run", "run now"), {
    edit: () => noStructure("capability-unavailable"),
  });
  return {
    hunks: [...long.hunks, ...script.hunks],
    byId: new Map([...long.byId, ...script.byId]),
    structures: new Map([...long.structures, ...script.structures]),
    sections: [...long.sections, ...script.sections],
  };
};

test("any order of the sections, the hunks and the structures gives the same result (the contract)", () => {
  const { hunks, byId, structures, sections } = twoFiles();
  const longSection = sections.find((section) => section.name === "Long")!;
  expect(longSection.hunkIds).toHaveLength(2);
  const expected = [...sectionIdentities(sections, byId, structures)];
  expect(
    expected
      .filter(([, identity]) => identity.parts.side === "none")
      .map(([, identity]) => identity.parts.ordinal),
  ).toEqual([1, 2]);
  const reversed = sectionIdentities(
    [...sections].reverse(),
    new Map([...byId].reverse()),
    new Map([...structures].reverse()),
  );
  expect([...reversed]).toEqual(expected);
  const rotated = sectionIdentities(
    [...sections.slice(1), sections[0]!],
    new Map([...hunks.slice(1), hunks[0]!].map((hunk) => [hunk.hunkId, hunk])),
    structures,
  );
  expect([...rotated]).toEqual(expected);
  // A section's own hunks in another order.
  const shuffled = sections.map((section) => ({
    ...section,
    hunkIds: [...section.hunkIds].reverse(),
  }));
  expect([...sectionIdentities(shuffled, byId, structures)]).toEqual(expected);
});

test("a removed row's place inside its span is part of the change, and lines shifted above the span do not move it (what is judged is a change, and place is part of it)", () => {
  const head = "# S\nA\nB\nC\n";
  const early = named(
    change("doc.md", "# S\nX\nA\nB\nC\n", head).identities,
    "S",
  );
  const late = named(
    change("doc.md", "# S\nA\nB\nX\nC\n", head).identities,
    "S",
  );
  expect([early.parts.side, late.parts.side]).toEqual(["new", "new"]);
  // The two bases' S differ too: the counterpart's text pins the pair.
  expect(differing(early, late)).toEqual(["counterpartSha256", "changeSha256"]);
  expect(late.key).not.toBe(early.key);
  const intro = "# Intro\nintro\n\n";
  const shifted = named(
    change("doc.md", `${intro}# S\nX\nA\nB\nC\n`, intro + head).identities,
    "S",
  );
  expect(shifted.where).toEqual({ startLine: 4, endLine: 7 });
  expect(shifted.key).toBe(early.key);
});

test("a removed row given to a head span that is not its own declaration is placed where it sits in the head (two different changes must not share a key)", () => {
  const head = "# H\nc1\nc2\nc3\n\n# T\nt\n";
  const one = change("doc.md", "# P\nc1\n# X\nc2\nc3\n\n# T\nt\n", head);
  const two = change("doc.md", "# P\nc1\nc2\n# X\nc3\n\n# T\nt\n", head);
  expect(one.sections.map((section) => section.name)).toEqual(["H"]);
  expect(two.sections.map((section) => section.name)).toEqual(["H"]);
  const [first] = one.identities.values();
  const [second] = two.identities.values();
  expect(differing(first!, second!)).toEqual(["changeSha256"]);
  expect(second!.key).not.toBe(first!.key);
  // Such a row's place is local: lines inserted above on both sides do not move it.
  const intro = "# Intro\nintro\n\n";
  const shifted = named(
    change("doc.md", `${intro}# P\nc1\n# X\nc2\nc3\n\n# T\nt\n`, intro + head)
      .identities,
    "H",
  );
  expect(shifted.where).toEqual({ startLine: 4, endLine: 8 });
  expect(shifted.key).toBe(first!.key);
});

test("a new-side section's base structure must be given; a base with no span for the row places it where it sits, under its own rule name (two callers must not disagree, and two rules must not meet)", () => {
  const base = "# S\nX\nA\nB\nC\n";
  const { byId, structures, sections, identities } = change(
    "doc.md",
    base,
    "# S\nA\nB\nC\n",
  );
  const noBase = new Map(structures);
  noBase.delete(oidOf(base));
  expect(() => sectionIdentities(sections, byId, noBase)).toThrow(
    /doc\.md.*base blob.*no structure given/,
  );
  // The row X: `base` at offset 1 in S, or `at` offset 1 when the base has no structure.
  const unstructured = new Map(structures);
  unstructured.set(oidOf(base), noStructure("parse-error"));
  const [placed] = identities.values();
  const [sits] = sectionIdentities(sections, byId, unstructured).values();
  expect(differing(placed!, sits!)).toEqual([
    "counterpartSha256",
    "changeSha256",
  ]);
  expect(sits!.key).not.toBe(placed!.key);
  // The rule's name alone: the base given cut by hand so X's line is in another span (`at`, offset
  // 1), while S keeps its text hash and stays the counterpart.
  const stored = structures.get(oidOf(base))!;
  const s = stored.spans[0]!;
  const recut = new Map(structures);
  recut.set(oidOf(base), {
    ...stored,
    spans: [
      { ...s, end: 1 },
      { ...s, start: 2, name: "Y", textSha256: sha("Y") },
    ],
  });
  // The same section (the real cut), placed against the recut base.
  const [atOne] = sectionIdentities(sections, byId, recut).values();
  expect(atOne!.parts.counterpartSha256).toBe(placed!.parts.counterpartSha256);
  expect(differing(placed!, atOne!)).toEqual(["changeSha256"]);
});

test("a section on the old side keeps its key under lines shifted above it (its rows are placed in the old span)", () => {
  const without = BASE.replace("# Beta\nbeta one\nbeta two\n\n", "");
  const removed = named(change("doc.md", BASE, without).identities, "Beta");
  const intro = "# Intro\nintro\n\n";
  const shifted = named(
    change("doc.md", intro + BASE, intro + without).identities,
    "Beta",
  );
  expect([removed.parts.side, shifted.parts.side]).toEqual(["old", "old"]);
  expect(shifted.where).toEqual({ startLine: 7, endLine: 10 });
  expect(shifted.key).toBe(removed.key);
});

test("same-named twins whose first line moves: the counterpart's text tells the two changes apart (two different changes must not share a key)", () => {
  const head = "# S\na\nb\n# T\nt\n# S\na\nb\n";
  const second = (base: string) =>
    [...change("doc.md", base, head).identities.values()].find(
      (identity) =>
        identity.parts.name === "S" && identity.where?.startLine === 6,
    )!;
  const one = second("a\nb\n# T\nt\n# S\na\n# S\nb\n");
  const two = second("a\nb\n# T\nt\n# S\na\nb\n# S\n");
  expect(one.parts.counterpartSha256).not.toBeNull();
  expect(differing(one, two)).toContain("counterpartSha256");
  expect(two.key).not.toBe(one.key);
});

test("the counterpart's text is null where the head span has none, on the old side and with no span (the part names only a real pair)", () => {
  const renamed = named(
    change("doc.md", "# P\np1\n# X\nc\n", "# P\np1\n# S\nc\n").identities,
    "S",
  );
  expect([renamed.parts.side, renamed.parts.counterpartSha256]).toEqual([
    "new",
    null,
  ]);
  const without = BASE.replace("# Beta\nbeta one\nbeta two\n\n", "");
  const removed = named(change("doc.md", BASE, without).identities, "Beta");
  expect([removed.parts.side, removed.parts.counterpartSha256]).toEqual([
    "old",
    null,
  ]);
  const [script] = change("run.sh", "a\nb\n", "a\nc\n", {
    edit: () => noStructure("capability-unavailable"),
  }).identities.values();
  expect([script!.parts.side, script!.parts.counterpartSha256]).toEqual([
    "none",
    null,
  ]);
  const paired = named(change("doc.md", BASE, HEAD).identities, "Beta");
  expect(paired.parts.counterpartSha256).toBe(
    structureOf("doc.md", BASE).spans.find((span) => span.name === "Beta")!
      .textSha256,
  );
});

test("rows added to the section above in the same block do not move a removed row's place (one change to S, one key)", () => {
  const base = "# P\np1\n# X\nc\n";
  const keys = ["", "p2\n", "p2\np3\n"].map((added) => {
    const s = named(
      change("doc.md", base, `# P\np1\n${added}# S\nc\n`).identities,
      "S",
    );
    expect(s.parts.side).toBe("new");
    return s.key;
  });
  expect(new Set(keys).size).toBe(1);
});

test("a declaration moved within a file with one line changed keeps its key when lines between its old and new place change (a moved declaration's key must not depend on code between the two places)", () => {
  const moved = "# B\nb1\nb2\nb3\n\n";
  const between = (extra: string) => `# M\nm1\nm2\n${extra}\n# C\nc\n\n`;
  const of = (extra: string) => {
    const result = change(
      "doc.md",
      moved + between(extra),
      between(extra) + moved.replace("b2", "b two"),
    );
    expect(result.hunks).toHaveLength(2);
    return named(result.identities, "B");
  };
  const plain = of("");
  // One section on the new side holds the removed rows at the top and the added rows at the end.
  expect(plain.parts.side).toBe("new");
  expect(
    change(
      "doc.md",
      moved + between(""),
      between("") + moved.replace("b2", "b two"),
    ).sections.find((section) => section.name === "B")!.hunkIds,
  ).toHaveLength(2);
  const longer = of("m3\nm4\n");
  expect(longer.where!.startLine).toBe(plain.where!.startLine + 2);
  expect(longer.key).toBe(plain.key);
});

test("two identical sections changed identically: in one range ordinals 1 and 2 with distinct keys; changed alone, each has ordinal 1 and the other's key (equal keys mean an equal change; this pins the one case where position does not enter)", () => {
  const step = "# Step\nrun it\n\n";
  const before = `${step}# Other\nother\n\n${step}`;
  const changed = "# Step\nrun it now\n\n";
  const steps = (after: string) =>
    [...change("doc.md", before, after).identities.values()].filter(
      (identity) => identity.parts.name === "Step",
    );
  const both = steps(`${changed}# Other\nother\n\n${changed}`);
  expect(
    both.map((identity) => [identity.parts.ordinal, identity.where?.startLine]),
  ).toEqual([
    [1, 1],
    [2, 7],
  ]);
  expect(both[0]!.key).not.toBe(both[1]!.key);
  const [firstAlone] = steps(`${changed}# Other\nother\n\n${step}`);
  const [secondAlone] = steps(`${step}# Other\nother\n\n${changed}`);
  expect(firstAlone!.where?.startLine).toBe(1);
  expect(secondAlone!.where?.startLine).toBe(7);
  expect([firstAlone!.parts.ordinal, secondAlone!.parts.ordinal]).toEqual([
    1, 1,
  ]);
  expect(secondAlone!.key).toBe(firstAlone!.key);
  expect(firstAlone!.key).toBe(both[0]!.key);
});

/** One text hunk from its body rows, both sides from line 1, with the rules' owned ranges. */
const fromBody = (path: string, body: string): ManifestHunk => {
  let oldLine = 1;
  let newLine = 1;
  const ownedRanges: Array<{
    side: "old" | "new";
    startLine: number;
    lineCount: number;
  }> = [];
  const own = (side: "old" | "new", line: number) => {
    const last = ownedRanges.findLast((range) => range.side === side);
    if (last !== undefined && last.startLine + last.lineCount === line)
      last.lineCount++;
    else ownedRanges.push({ side, startLine: line, lineCount: 1 });
  };
  for (const row of body.split("\n").slice(0, -1)) {
    if (row.startsWith("\\")) continue;
    if (row.startsWith("-")) own("old", oldLine++);
    else if (row.startsWith("+")) own("new", newLine++);
    else (oldLine++, newLine++);
  }
  const text = `@@ -1,${oldLine - 1} +1,${newLine - 1} @@\n${body}`;
  const [hunk] = diff(path, "x\n", "y\n");
  return {
    ...hunk!,
    hunkId: `h${sha(text).slice(0, 15)}`,
    contentKey: hunkContentKey({ path, text }),
    oldLines: oldLine - 1,
    newLines: newLine - 1,
    text,
    textSha256: sha(text),
    ownedRanges,
  };
};

const changeOf = (body: string) => {
  const hunk = fromBody("run.sh", body);
  const sections = sectionsOf([hunk], new Map());
  expect(sections).toHaveLength(1);
  return sectionIdentities(sections, new Map([[hunk.hunkId, hunk]]), new Map())
    .values()
    .next().value!.parts.changeSha256;
};

test("the no-newline marker is content, its wording is not, and a marker after a context row does not enter; hunks that disagree on the blob throw (a marker regression would silently change keys)", () => {
  const marker = "\\ No newline at end of file";
  const values = [
    changeOf(` a\n-b\n${marker}\n+c\n`),
    changeOf(` a\n-b\n+c\n${marker}\n`),
    changeOf(` a\n-b\n${marker}\n+c\n${marker}\n`),
    changeOf(" a\n-b\n+c\n"),
  ];
  expect(new Set(values).size).toBe(4);
  expect(changeOf(` a\n-b\n+c\n${marker}\n`)).toBe(
    changeOf(" a\n-b\n+c\n\\ Kein Zeilenumbruch am Dateiende.\n"),
  );
  expect(changeOf(` a\n-b\n+c\n d\n${marker}\n`)).toBe(
    changeOf(" a\n-b\n+c\n d\n"),
  );
  // The long section's two hunks naming different head blobs.
  const { byId, structures, sections } = twoFiles();
  const longSection = sections.find((section) => section.name === "Long")!;
  const disagreeing = new Map(byId);
  const later = longSection.hunkIds[1]!;
  disagreeing.set(later, { ...byId.get(later)!, newOid: "f".repeat(40) });
  expect(() => sectionIdentities(sections, disagreeing, structures)).toThrow(
    /doc\.md.*different new blobs/,
  );
});

test("the same head text reached from a different base gives a different key (what is judged is a change)", () => {
  const fromTwo = named(change("doc.md", BASE, HEAD).identities, "Beta");
  const fromDeux = named(
    change("doc.md", BASE.replace("beta two", "beta deux"), HEAD).identities,
    "Beta",
  );
  expect(differing(fromTwo, fromDeux)).toEqual([
    "counterpartSha256",
    "changeSha256",
  ]);
  expect(fromDeux.key).not.toBe(fromTwo.key);
});

test("a section that claims a span whose structure or span is missing throws, naming its path (a silent fallback would change keys between runs)", () => {
  const { byId, structures, sections } = change("doc.md", BASE, HEAD);
  const headOid = oidOf(HEAD);
  const noHead = new Map([...structures].filter(([oid]) => oid !== headOid));
  expect(() => sectionIdentities(sections, byId, noHead)).toThrow(
    /doc\.md.*no structure given/,
  );
  const noSpan = new Map(structures);
  noSpan.set(headOid, { ...structures.get(headOid)!, spans: [] });
  expect(() => sectionIdentities(sections, byId, noSpan)).toThrow(
    /doc\.md.*does not have/,
  );
  expect(() => sectionIdentities(sections, new Map(), structures)).toThrow(
    /doc\.md.*not given/,
  );
});

test("orderedSectionKeys and sectionKeySetHash: order and duplicates do not change the hash; a different set does (unit identity is built on it)", () => {
  const keys = [
    ...change(
      "doc.md",
      BASE,
      HEAD.replace("gamma text", "gamma 3"),
    ).identities.values(),
  ].map((identity) => identity.key);
  expect(keys.length).toBeGreaterThanOrEqual(2);
  const ordered = orderedSectionKeys([...keys, ...keys].reverse());
  expect(ordered).toEqual([...new Set(keys)].sort());
  expect(sectionKeySetHash(keys)).toMatch(/^[0-9a-f]{64}$/);
  expect(sectionKeySetHash([...keys].reverse())).toBe(sectionKeySetHash(keys));
  expect(sectionKeySetHash([...keys, keys[0]!])).toBe(sectionKeySetHash(keys));
  expect(sectionKeySetHash(keys.slice(1))).not.toBe(sectionKeySetHash(keys));
  expect(sectionKeySetHash([])).not.toBe(sectionKeySetHash(keys));
});

test("where and renamedFrom stay out of the key: a renamed file's key differs only through its path (the rename ruling)", () => {
  const renamed = named(
    change("doc.md", BASE, HEAD, { status: "renamed", oldPath: "old.md" })
      .identities,
    "Beta",
  );
  expect(renamed.renamedFrom).toBe("old.md");
  expectKeyOfParts(renamed);
  const modified = named(change("doc.md", BASE, HEAD).identities, "Beta");
  expect(modified.renamedFrom).toBeNull();
  expect(renamed.key).toBe(modified.key);
  const atOldPath = named(change("old.md", BASE, HEAD).identities, "Beta");
  expect(differing(renamed, atOldPath)).toEqual(["path"]);
  expect(renamed.key).not.toBe(atOldPath.key);
});
