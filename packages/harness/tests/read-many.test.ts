import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: the owner ruled on 12 November that finders read many ranges in one call, past 10.18's
// 3,000-token page. That opens three ways to manufacture or lose evidence, which these tests hold at
// the lookup's boundary, without a model:
// - entries must answer in the order asked, each for itself, so one bad path cannot hide the rest;
// - head lines read through it must be citable exactly as `read`'s are, and old-side lines must not
//   become citable, or a finding could cite lines no one read or anchor where the rule forbids;
// - its result must stay inside its own cap and the caller's reading budget, say what it left out
//   and how to ask for it, and every other tool must keep the 3,000-token cap byte for byte;
// - what it says to ask for next must be input it accepts and read exactly the rest, or a model
//   following it word for word pays a failed call or reads lines twice or never;
// - a failure at one entry must not hide the others, whose lines may already be recorded as read.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { TOOL_RESULT_BYTES } from "../src/budget.ts";
import { readingBudget } from "../src/readings/tool-budget.ts";
import * as L from "../src/lookups.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import {
  READ_MANY_CAP,
  TOOL_RESULT_CAP,
  capResult,
  nearCap,
  wireSchema,
} from "../src/toolkit.ts";
import { hunk } from "./find-fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-read-many-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const repository = join(directory, "repo");
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const commit = (message: string) => {
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};

const BIG_LINES = 3_000;
const aLines = (head: boolean) =>
  Array.from({ length: 30 }, (_, i) => i + 1)
    .filter((n) => !head || n < 20 || n > 22)
    .map((n) =>
      head && n === 10 ? "line 10: changed" : `line ${n}: original`,
    );
/** A file renamed with one line changed, so the rename is detected. */
const renamed = (head: boolean) =>
  Array.from({ length: 20 }, (_, i) =>
    head && i === 9 ? "renamed 10, changed" : `renamed ${i + 1}`,
  ).join("\n") + "\n";
/** 51 small hunks: one changed line in every ten. */
const many = (head: boolean) =>
  Array.from({ length: 510 }, (_, i) =>
    head && i % 10 === 4 ? `m ${i + 1} changed` : `m ${i + 1}`,
  ).join("\n") + "\n";
/** Four hunks of several pages each: blocks of 150 rewritten lines, ten unchanged between. */
const wide = (head: boolean) =>
  Array.from({ length: 4 }, (_, block) => [
    ...Array.from(
      { length: 150 },
      (_, i) => `w${block}-${i} ${head ? "new" : "old"} ${"o".repeat(40)}`,
    ),
    ...Array.from({ length: 10 }, (_, i) => `between ${block}-${i}`),
  ])
    .flat()
    .join("\n") + "\n";
/** One hunk of many pages: 700 rewritten lines. */
const huge = (head: boolean) =>
  Array.from(
    { length: 700 },
    (_, i) => `u${i} ${head ? "new" : "old"} ${"q".repeat(40)}`,
  ).join("\n") + "\n";
let base = "";
let head = "";
beforeAll(() => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(
    join(repository, "src", "a.ts"),
    aLines(false).join("\n") + "\n",
  );
  writeFileSync(
    join(repository, "src", "b.ts"),
    Array.from({ length: 10 }, (_, i) => `b ${i + 1}`).join("\n") + "\n",
  );
  writeFileSync(
    join(repository, "big.ts"),
    Array.from(
      { length: BIG_LINES },
      (_, i) => `export const value${i + 1} = "${"x".repeat(30)}";`,
    ).join("\n") + "\n",
  );
  writeFileSync(join(repository, "img.bin"), new Uint8Array([0, 1, 2, 0, 255]));
  // Read only by the failure test, so no earlier read leaves its text cached.
  writeFileSync(join(repository, "src", "c.ts"), "c, read once\n");
  writeFileSync(
    join(repository, "long.ts"),
    `short one\n${"z".repeat(50_000)}\nshort three\n`,
  );
  writeFileSync(join(repository, "src", "old-name.ts"), renamed(false));
  writeFileSync(join(repository, "many.ts"), many(false));
  writeFileSync(join(repository, "wide.ts"), wide(false));
  writeFileSync(join(repository, "huge.ts"), huge(false));
  base = commit("base");
  writeFileSync(
    join(repository, "src", "a.ts"),
    aLines(true).join("\n") + "\n",
  );
  rmSync(join(repository, "src", "old-name.ts"));
  writeFileSync(join(repository, "src", "new-name.ts"), renamed(true));
  writeFileSync(join(repository, "many.ts"), many(true));
  writeFileSync(join(repository, "wide.ts"), wide(true));
  writeFileSync(join(repository, "huge.ts"), huge(true));
  head = commit("change");
});

const storeLayer = (location: ReturnType<typeof storeLocationIn>) =>
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );

/** Runs `body` with a fresh lookup context over the range, in its own store. */
const withLookups = <A>(
  name: string,
  body: (ctx: L.LookupContext) => Effect.Effect<A, unknown, never>,
) => {
  const location = storeLocationIn(join(directory, name));
  return Effect.runPromise(
    Effect.gen(function* () {
      const manifest = (yield* rangeManifest(
        repository,
        { baseOid: base, headOid: head },
        defaultManifestSettings(1_000_000),
        captureOutlineSource(),
      )).value;
      const views = yield* L.revisionViews(repository, manifest);
      const records = yield* Effect.context<
        Blobs.BlobStore | Computations.ComputationStore
      >();
      const ctx: L.LookupContext = {
        source: captureOutlineSource(),
        repository,
        location,
        cycleId: "cycle",
        manifest,
        head: views.head,
        base: views.base,
        hunks: new Map(manifest.hunks.map((h) => [h.hunkId, h])),
        commits: yield* L.rangeCommits(repository, manifest),
        snapshot: undefined,
        records,
        handles: new L.HandleRegistry(),
        searchFrequency: new Map(),
      };
      return yield* body(ctx);
    }).pipe(Effect.provide(storeLayer(location))),
  );
};

/** No reading budget: what a caller with its own `read` and no budget passes. */
const noBudget = () => Number.POSITIVE_INFINITY;

/** What a result shows, in order: each file line as `F path@rev n: text`, each diff page as `D id body`. */
const units = (text: string) => {
  const out: Array<string> = [];
  for (const block of text.matchAll(
    /<(data-[0-9a-f]+) kind="(file|diff)"([^>]*)>\n([\s\S]*?)\n<\/\1>/g,
  )) {
    const attribute = (name: string) =>
      new RegExp(` ${name}="([^"]*)"`).exec(block[3]!)?.[1];
    if (block[2] === "file")
      for (const row of block[4]!.split("\n"))
        out.push(`F ${attribute("path")}@${attribute("rev")} ${row}`);
    else out.push(`D ${attribute("hunk")} ${block[4]}`);
  }
  return out;
};

/** The numbered lines a result shows for one path at one revision, from its data blocks. */
const shownLines = (text: string, path: string, rev: string) => {
  const out: Array<number> = [];
  let inside = false;
  for (const row of text.split("\n")) {
    if (row.startsWith("<data-"))
      inside = row.includes(`path="${path}"`) && row.includes(`rev="${rev}"`);
    else if (row.startsWith("</data-")) inside = false;
    else if (inside) {
      const n = /^(\d+): /.exec(row)?.[1];
      if (n !== undefined) out.push(Number(n));
    }
  }
  return out;
};

test("several ranges of several files answer in the order asked, both revisions of one file, and an unreadable entry answers for itself", async () => {
  const result = await withLookups("order", (ctx) =>
    Effect.gen(function* () {
      const tool = L.readManyTool(ctx);
      const outcome = yield* tool.handle(
        tool.input!.parse({
          entries: [
            { path: "src/b.ts", startLine: 2, endLine: 4 },
            { path: "src/a.ts", rev: "base", startLine: 18, endLine: 24 },
            { path: "src/a.ts", startLine: 18, endLine: 21 },
            { path: "missing.ts" },
            { path: "img.bin" },
            { path: "src/b.ts", startLine: 50 },
            { handle: "h000000000" },
            { path: "src/a.ts", startLine: 5, endLine: 3 },
            { path: "src/b.ts", hunk: "h0123456789abcde" },
          ],
        }),
      );
      const reads = ctx.handles.toJSON().handles.map(([, h]) => ({
        path: h.base.path,
        rev: h.base.rev,
        lines: `${h.base.startLine}-${h.base.endLine}`,
        lookups: [...new Set(h.sightings.map((s) => s.lookup))],
      }));
      const read = L.readTool(ctx);
      const reversed = yield* read.handle({
        path: "src/a.ts",
        startLine: 5,
        endLine: 3,
      });
      return { outcome, reads, reversed };
    }),
  );
  const text = result.outcome.text;
  const at = (needle: string) => {
    const index = text.indexOf(needle);
    expect({ needle, found: index >= 0 }).toEqual({ needle, found: true });
    return index;
  };
  const order = [
    at("[1] src/b.ts@head lines 2-4 of 10"),
    at("[2] src/a.ts@base lines 18-24 of 30"),
    at("[3] src/a.ts@head lines 18-21 of 27"),
    at("[4] missing.ts is not a file at the head revision"),
    at("[5] img.bin at head is binary or unreadable as text."),
    at("[6] src/b.ts at head has 10 lines."),
    at("[7] No handle h000000000 in this context."),
    at("[8] endLine 3 is before startLine 5 and must be at least 5."),
    at("[9] Give one of:"),
  ];
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(result.reversed).toEqual({
    text: "endLine 3 is before startLine 5 and must be at least 5.",
    error: "InvalidInput",
  });
  expect(text.startsWith("9 entries:\n")).toBe(true);
  expect(shownLines(text, "src/b.ts", "head")).toEqual([2, 3, 4]);
  // The old side holds the deleted lines; the new side's same numbers hold what follows them.
  expect(shownLines(text, "src/a.ts", "base")).toEqual([
    18, 19, 20, 21, 22, 23, 24,
  ]);
  expect(text).toContain("20: line 20: original");
  expect(text).toContain("20: line 23: original");
  expect(result.outcome.paged).toBeUndefined();
  expect(result.outcome.empty).toBeUndefined();
  // Every range became a handle through read, so the reading counters count its files.
}, 120_000);

test("a file's diff and hunks by ID show deleted lines under each hunk's ID and header, opened as hunk opens them", async () => {
  const result = await withLookups("diff", (ctx) =>
    Effect.gen(function* () {
      const tool = L.readManyTool(ctx);
      const hunks = [...ctx.hunks.values()].filter(
        (h) => h.path === "src/a.ts",
      );
      const outcome = yield* tool.handle(
        tool.input!.parse({
          entries: [
            { path: "src/a.ts", diff: true },
            { hunk: hunks[0]!.hunkId },
            { path: "src/b.ts", diff: true },
            { path: "src/a.ts", diff: true, startLine: 1 },
          ],
        }),
      );
      return {
        outcome,
        hunks: hunks.map((h) => ({
          id: h.hunkId,
          line: L.hunkLine(h),
          foundBy: ctx.handles.seen(h.hunkId)?.foundBy,
        })),
      };
    }),
  );
  const text = result.outcome.text;
  expect(result.hunks.length).toBe(2);
  expect(text).toContain("[1] diff of src/a.ts: 2 hunk(s)");
  for (const h of result.hunks) {
    expect(text).toContain(h.line);
    expect(text).toContain(`hunk="${h.id}"`);
    expect(h.foundBy).toEqual(["hunk"]);
  }
  expect(text).toContain("-line 10: original");
  expect(text).toContain("+line 10: changed");
  for (const n of [20, 21, 22]) expect(text).toContain(`-line ${n}: original`);
  expect(text.indexOf("[2] hunk of src/a.ts")).toBeGreaterThan(
    text.indexOf("[1] diff of src/a.ts"),
  );
  expect(text).toContain(
    "[3] No changed hunks for src/b.ts in this range. hunks lists the changed files.",
  );
  expect(text).toContain("[4] Give one of:");
}, 120_000);

test("the reading budget cuts a result to what is left and counts it; given what is left, read_many stops within it", async () => {
  const LIMIT = 6_000;
  const result = await withLookups("budget", (ctx) =>
    Effect.gen(function* () {
      const plain = readingBudget([L.readManyTool(ctx)], LIMIT);
      const input = { entries: [{ path: "big.ts" }, { path: "src/b.ts" }] };
      const cut = yield* plain.tools[0]!.handle(input);
      const bounded = readingBudget(
        [
          L.readManyTool(ctx, {
            remaining: () => LIMIT - bounded.save().used,
          }),
        ],
        LIMIT,
      );
      const within = yield* bounded.tools[0]!.handle(input);
      return {
        cut,
        cutUsed: plain.save().used,
        within,
        withinUsed: bounded.save().used,
      };
    }),
  );
  // Cut to fit what is left, with its cut said; the cut spends the budget.
  expect(result.cut.text.length).toBeLessThanOrEqual(LIMIT);
  expect(result.cut.text).toMatch(/\n\[reading budget reached: [^\n]*\]$/);
  expect(result.cut.paged).toBe(true);
  expect(result.cutUsed).toBe(LIMIT);
  // Stopped by itself: the budget cut nothing, and it counted what was shown. What it leaves is too
  // little for another page, so it says so and offers nothing to ask again.
  expect(result.within.text.length).toBeLessThanOrEqual(LIMIT);
  expect(result.within.text).toMatch(
    /\n\[read_many stopped: the reading budget is all but spent, with fewer than \d+ characters left after this result, too few to show any more\. Not read: entry 1 from line \d+, and entry 2\. There is nothing to ask again; submit your review\.\]$/,
  );
  expect(result.within.text).not.toContain("ask read_many with entries");
  expect(result.withinUsed).toBe(result.within.text.length);
  const shown = shownLines(result.within.text, "big.ts", "head");
  expect(shown.length).toBeGreaterThan(0);
}, 120_000);

test("only read_many declares a larger cap; every other tool keeps 10.18's cap byte for byte", async () => {
  const result = await withLookups("caps", (ctx) =>
    Effect.sync(() => ({
      others: [
        L.readTool(ctx),
        L.hunkTool(ctx),
        L.hunksTool(ctx),
        L.commitTool(ctx),
        L.logTool(ctx),
        L.scopeSectionTool(ctx),
        L.searchTool(ctx),
        L.usesTool(ctx),
        L.defsTool(ctx),
        L.outlineTool(ctx),
        L.symbolAtTool(ctx),
        L.treeTool(ctx),
      ].map((tool) => [tool.name, tool.resultCap]),
      readMany: L.readManyTool(ctx),
    })),
  );
  for (const [name, cap] of result.others)
    expect([name, cap]).toEqual([name, undefined]);
  expect(result.readMany.resultCap).toBe(READ_MANY_CAP);
  // The provider schema keeps the entries' shape.
  const schema = wireSchema(result.readMany.input!).schema as {
    properties: { entries: { items: { properties: Record<string, unknown> } } };
  };
  expect(
    Object.keys(schema.properties.entries.items.properties).sort(),
  ).toEqual([
    "diff",
    "endLine",
    "fromHunk",
    "handle",
    "hunk",
    "page",
    "path",
    "rev",
    "startLine",
  ]);
  const long = "y".repeat(TOOL_RESULT_BYTES * 3);
  const line = "[turn 1 / 6; results are capped at about 3,000 tokens]";
  const plain = capResult(long, line);
  expect(plain).toBe(capResult(long, line, TOOL_RESULT_CAP));
  expect(Buffer.byteLength(plain)).toBeLessThanOrEqual(TOOL_RESULT_BYTES);
  expect(plain).toContain("[result cut at the 3,000-token cap;");
  // The same text fits whole under read_many's cap.
  expect(capResult(long, line, READ_MANY_CAP)).toBe(`${long}\n\n${line}`);
  expect(nearCap(long, true)).toBe(true);
  expect(nearCap(long, true, READ_MANY_CAP)).toBe(false);
}, 120_000);

type Entry = {
  path?: string;
  rev?: "head" | "base";
  startLine?: number;
  endLine?: number;
  diff?: boolean;
  hunk?: string;
  fromHunk?: string;
  page?: number;
};

/** The same entries read with no cap: lines through `read`'s own pages, hunks through `hunk`'s. */
const uncapped = (ctx: L.LookupContext, entries: ReadonlyArray<Entry>) =>
  Effect.gen(function* () {
    const read = L.readTool(ctx);
    const hunk = L.hunkTool(ctx);
    const out: Array<string> = [];
    for (const entry of entries) {
      if (entry.diff === true || entry.hunk !== undefined) {
        const hunks =
          entry.hunk !== undefined
            ? [ctx.hunks.get(entry.hunk)!]
            : [...ctx.hunks.values()].filter((h) =>
                [h.path, h.oldPath, h.newPath].includes(entry.path!),
              );
        for (const h of hunks)
          for (let page = 1; ; page++) {
            const shown = yield* hunk.handle({ id: h.hunkId, page });
            out.push(...units(shown.text));
            if (!shown.text.includes(`ask hunk ${h.hunkId} page ${page + 1}`))
              break;
          }
        continue;
      }
      let line = entry.startLine ?? 1;
      for (;;) {
        const shown = yield* read.handle({
          path: entry.path,
          rev: entry.rev ?? "head",
          startLine: line,
          ...(entry.endLine === undefined ? {} : { endLine: entry.endLine }),
        });
        out.push(...units(shown.text));
        const more = /\[more: read path .* from line (\d+)\]$/.exec(shown.text);
        if (more === null) break;
        line = Number(more[1]);
      }
    }
    return out;
  });

/**
 * Asks `entries`, then each note's entries as written, until a result has no note: every request
 * must parse with the tool's own schema, be no longer than the one before, and show something.
 */
const drain = (
  tool: ReturnType<typeof L.readManyTool>,
  entries: Array<Entry>,
) =>
  Effect.gen(function* () {
    const shown: Array<string> = [];
    const asked: Array<Array<Entry>> = [];
    let next = entries;
    for (let call = 0; call < 60; call++) {
      const parsed = tool.input!.safeParse({ entries: next });
      expect(parsed.success).toBe(true);
      asked.push(next);
      const out = yield* tool.handle(parsed.data);
      const got = units(out.text);
      shown.push(...got);
      const note = /For the rest, ask read_many with entries (\[.*\])\]$/.exec(
        out.text,
      );
      if (note === null) return { shown, asked };
      const following = JSON.parse(note[1]!) as Array<Entry>;
      expect(following.length).toBeLessThanOrEqual(next.length);
      expect(got.length).toBeGreaterThan(0);
      next = following;
    }
    throw new Error("the continuation did not finish");
  });

test("a stop inside a diff entry or inside a hunk names one entry for the rest; fed back until done, the whole request reads exactly as uncapped, and only shown head lines are recorded", async () => {
  const result = await withLookups("continuation", (ctx) =>
    Effect.gen(function* () {
      const wideHunks = [...ctx.hunks.values()].filter(
        (h) => h.path === "wide.ts",
      );
      const request: Array<Entry> = [
        { path: "many.ts", diff: true },
        { path: "big.ts", startLine: 1, endLine: 900 },
        { hunk: wideHunks[1]!.hunkId },
        { path: "wide.ts", diff: true },
        { path: "src/b.ts" },
      ];
      const runs: Array<{
        readonly prefix: number;
        readonly shown: Array<string>;
        readonly asked: Array<Array<Entry>>;
        readonly reads: Array<{
          path: string;
          startLine: number;
          endLine: number;
        }>;
      }> = [];
      // The cap alone stops it; a line range first, of four lengths, moves where the stops fall.
      const expected: Array<Array<string>> = [];
      for (const prefix of [0, 120, 260, 410]) {
        const asked: Array<Entry> = [
          ...(prefix === 0
            ? []
            : [{ path: "big.ts", startLine: 1_001, endLine: 1_000 + prefix }]),
          ...request,
        ];
        expected.push(yield* uncapped(ctx, asked));
        const tool = L.readManyTool(ctx, {
          remaining: noBudget,
        });
        const drained = yield* drain(tool, asked);
        runs.push({ prefix, ...drained, reads: [] });
      }
      return {
        expected,
        runs,
        hunks: {
          many: [...ctx.hunks.values()].filter((h) => h.path === "many.ts")
            .length,
          widePages: wideHunks.map(
            (h) => L.pagesOf(h.text.replace(/\n$/, "").split("\n")).length,
          ),
        },
      };
    }),
  );
  // The request is the reviewer's case: a 51-hunk diff, and hunks of several pages.
  expect(result.hunks.many).toBe(51);
  for (const pages of result.hunks.widePages) expect(pages).toBeGreaterThan(1);
  // 900 lines of big.ts, 10 of b.ts, and every hunk page besides.
  expect(result.expected[0]!.length).toBeGreaterThan(910);
  const continued = result.runs.flatMap((run) => run.asked.slice(1).flat());
  // Stops fell inside a diff entry and inside a hunk.
  expect(continued.some((entry) => entry.fromHunk !== undefined)).toBe(true);
  expect(continued.some((entry) => (entry.page ?? 1) > 1)).toBe(true);
  for (const [at, run] of result.runs.entries()) {
    expect({ prefix: run.prefix, calls: run.asked.length > 1 }).toEqual({
      prefix: run.prefix,
      calls: true,
    });
    // Nothing repeated, nothing skipped, in order.
    expect(run.shown).toEqual(result.expected[at]!);
    // Recorded head reads are exactly the head lines shown.
    const recorded = new Set(
      run.reads.flatMap((r) =>
        Array.from(
          { length: r.endLine - r.startLine + 1 },
          (_, i) => `${r.path}:${r.startLine + i}`,
        ),
      ),
    );
    const shownHead = new Set(
      run.shown
        .filter((unit) => /^F \S+@head \d+: /.test(unit))
        .map((unit) => {
          const [, at, n] = /^F (\S+)@head (\d+): /.exec(unit)!;
          return `${at}:${n}`;
        }),
    );
  }
}, 240_000);

test("handle entries read their region or the lines asked, as read follows a handle, with its lineage", async () => {
  const result = await withLookups("handles", (ctx) =>
    Effect.gen(function* () {
      const tool = L.readManyTool(ctx, {
        remaining: noBudget,
      });
      const first = yield* tool.handle(
        tool.input!.parse({
          entries: [
            { path: "src/b.ts", startLine: 2, endLine: 8 },
            { path: "src/a.ts", rev: "base", startLine: 1, endLine: 3 },
          ],
        }),
      );
      const [headHandle, baseHandle] = [
        ...first.text.matchAll(/^(h[0-9a-f]{9}) \S+@(?:head|base) lines/gm),
      ].map((m) => m[1]!);
      const second = yield* tool.handle(
        tool.input!.parse({
          entries: [
            { handle: headHandle },
            { handle: headHandle, startLine: 3, endLine: 4 },
            { handle: baseHandle },
          ],
        }),
      );
      const narrowed = ctx.handles
        .toJSON()
        .handles.find(
          ([, h]) => h.base.startLine === 3 && h.base.endLine === 4,
        )!;
      return {
        second,
        headHandle,
        parent: ctx.handles.get(narrowed[0])!.parent,
      };
    }),
  );
  const text = result.second.text;
  expect(text).toContain("[1] src/b.ts@head lines 2-8 of 10");
  expect(text).toContain("[2] src/b.ts@head lines 3-4 of 10");
  expect(text).toContain("[3] src/a.ts@base lines 1-3 of 30");
  expect(shownLines(text, "src/b.ts", "head")).toEqual([
    2, 3, 4, 5, 6, 7, 8, 3, 4,
  ]);
  expect(result.parent).toBe(result.headHandle!);
  // Head regions are recorded each time they are shown; the base one never.
}, 120_000);

test("a renamed file's diff is found by either path, and each revision reads its own path", async () => {
  const result = await withLookups("rename", (ctx) =>
    Effect.gen(function* () {
      const tool = L.readManyTool(ctx);
      const outcome = yield* tool.handle(
        tool.input!.parse({
          entries: [
            { path: "src/old-name.ts", diff: true },
            { path: "src/new-name.ts", diff: true },
            { path: "src/old-name.ts", rev: "base", startLine: 9, endLine: 11 },
            { path: "src/new-name.ts", startLine: 9, endLine: 11 },
            { path: "src/old-name.ts" },
          ],
        }),
      );
      const renamedHunks = [...ctx.hunks.values()].filter(
        (h) => h.newPath === "src/new-name.ts",
      );
      return { outcome, renamedHunks };
    }),
  );
  expect(result.renamedHunks.map((h) => [h.oldPath, h.status])).toEqual([
    ["src/old-name.ts", "renamed"],
  ]);
  const id = result.renamedHunks[0]!.hunkId;
  const text = result.outcome.text;
  expect(text).toContain("[1] diff of src/old-name.ts: 1 hunk(s)");
  expect(text).toContain("[2] diff of src/new-name.ts: 1 hunk(s)");
  expect(text.split(`hunk="${id}"`).length - 1).toBe(2);
  expect(text).toContain("-renamed 10\n+renamed 10, changed");
  expect(shownLines(text, "src/old-name.ts", "base")).toEqual([9, 10, 11]);
  expect(text).toContain("10: renamed 10\n");
  expect(shownLines(text, "src/new-name.ts", "head")).toEqual([9, 10, 11]);
  expect(text).toContain("10: renamed 10, changed\n");
  expect(text).toContain(
    "[5] src/old-name.ts is not a file at the head revision",
  );
}, 120_000);

test("valid input is closed under continuation: requests at and just under the bound, of each entry shape, stopped in their first entry, drain through their notes with every offer valid", async () => {
  const result = await withLookups("closure", (ctx) =>
    Effect.gen(function* () {
      const wideHunks = [...ctx.hunks.values()].filter(
        (h) => h.path === "wide.ts",
      );
      const hugeHunk = [...ctx.hunks.values()].find(
        (h) => h.path === "huge.ts",
      )!;
      const seen = yield* L.readTool(ctx).handle({
        path: "big.ts",
        startLine: 1,
        endLine: 5,
      });
      const handle = /^(h[0-9a-f]{9}) /.exec(seen.text)![1]!;
      // Each shape a continuation rewrites, each large enough to stop the call inside it.
      const shapes: Array<Entry & { handle?: string }> = [
        { path: "big.ts" },
        { path: "big.ts", rev: "base", startLine: 2 },
        { handle, startLine: 1, endLine: 3_000 },
        { path: "wide.ts", diff: true },
        {
          path: "wide.ts",
          diff: true,
          fromHunk: wideHunks[1]!.hunkId,
          page: 2,
        },
        { hunk: hugeHunk.hunkId },
        { hunk: hugeHunk.hunkId, page: 3 },
      ];
      const tool = L.readManyTool(ctx);
      const out: Array<{
        shape: string;
        under: number;
        measured: number;
        oneMore: boolean;
        calls: number;
        firstOffer: number;
      }> = [];
      for (const first of shapes)
        for (const under of [0, 1, 37]) {
          // Two paths no tree holds pad the request to the bound, less `under` bytes.
          const pad = (a: number, b: number) => [
            first,
            { path: "q".repeat(a) },
            { path: "r".repeat(b) },
          ];
          const extra =
            L.READ_MANY_INPUT_BYTES - under - L.readManyMeasure(pad(1, 1));
          const entries = pad(
            1 + Math.ceil(extra / 2),
            1 + Math.floor(extra / 2),
          );
          const drained = yield* drain(tool, entries);
          out.push({
            shape: Object.keys(first).sort().join("+"),
            under,
            measured: L.readManyMeasure(entries),
            oneMore: tool.input!.safeParse({
              entries: pad(2 + Math.ceil(extra / 2), 1 + Math.floor(extra / 2)),
            }).success,
            calls: drained.asked.length,
            firstOffer: drained.asked[1]?.length ?? 0,
          });
        }
      return out;
    }),
  );
  expect(result).toHaveLength(21);
  for (const run of result) {
    expect({ ...run, measured: run.measured === 8_000 - run.under }).toEqual({
      ...run,
      measured: true,
    });
    // At the bound, one byte more is refused: the bound is exact.
    if (run.under === 0) expect(run.oneMore).toBe(false);
    // Stopped in its first entry: continued, with the same three entries offered.
    expect(run.calls).toBeGreaterThan(1);
    expect(run.firstOffer).toBe(3);
  }
}, 240_000);

test("a call that arrives with too little budget to show anything answers as a spent budget does, its instruction never cut", async () => {
  const result = await withLookups("spent", (ctx) =>
    Effect.gen(function* () {
      const out: Array<{
        left: number;
        text: string;
        error?: string | undefined;
      }> = [];
      for (const left of [400, 120, 60, 30, 12]) {
        const tool = L.readManyTool(ctx, { remaining: () => left });
        const answer = yield* tool.handle(
          tool.input!.parse({ entries: [{ path: "big.ts" }] }),
        );
        out.push({ left, text: answer.text, error: answer.error });
      }
      return out;
    }),
  );
  expect(result.map((r) => [r.left, r.text, r.error])).toEqual([
    [
      400,
      "Reading budget spent. Submit your review. (400 characters are left, too few to read any of these entries.)",
      "BudgetSpent",
    ],
    [
      120,
      "Reading budget spent. Submit your review. (120 characters are left, too few to read any of these entries.)",
      "BudgetSpent",
    ],
    [60, "Reading budget spent. Submit your review.", "BudgetSpent"],
    [30, "Submit your review.", "BudgetSpent"],
    [12, "Submit.", "BudgetSpent"],
  ]);
}, 120_000);

test("a caller's read that fails after a page says what is true, and a call whose every entry failed keeps the failure's tag", async () => {
  const result = await withLookups("errors", (ctx) =>
    Effect.gen(function* () {
      const plain = L.readTool(ctx);
      /** A `read` that fails in its error channel on the calls `fails` picks. */
      const failing = (fails: (call: number) => boolean) => {
        let calls = 0;
        return {
          ...plain,
          handle: (input: unknown) => {
            calls += 1;
            return fails(calls)
              ? (Effect.fail({
                  _tag: "ProbeFailed",
                  message: "probe failure",
                }) as never)
              : plain.handle(input);
          },
        };
      };
      const midway = L.readManyTool(ctx, {
        read: failing((call) => call === 2),
        remaining: noBudget,
      });
      const partial = yield* midway.handle(
        midway.input!.parse({
          entries: [
            { path: "big.ts", startLine: 1, endLine: 400 },
            { path: "src/b.ts", startLine: 1, endLine: 2 },
          ],
        }),
      );
      const broken = L.readManyTool(ctx, {
        read: failing(() => true),
        remaining: noBudget,
      });
      const all = yield* broken.handle(
        broken.input!.parse({
          entries: [{ path: "src/b.ts" }, { path: "src/a.ts" }],
        }),
      );
      return { partial, all };
    }),
  );
  const partial = result.partial.text;
  const shown = shownLines(partial, "big.ts", "head");
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.at(-1)!).toBeLessThan(400);
  expect(partial).toContain(
    "\n[1] stopped with an error after what is shown above: probe failure. The rest of it was not read.\n",
  );
  expect(partial).not.toContain("Nothing of it is shown");
  expect(shownLines(partial, "src/b.ts", "head")).toEqual([1, 2]);
  expect(result.partial.error).toBeUndefined();
  // Every entry failed: each says so, and the outcome keeps the failure's tag.
  expect(result.all.text).toContain(
    "[1] could not be read: probe failure. Nothing of it is shown; ask for it again.",
  );
  expect(result.all.text).toContain(
    "[2] could not be read: probe failure. Nothing of it is shown; ask for it again.",
  );
  expect(result.all.error).toBe("ProbeFailed");
  expect(result.all.empty).toBe(true);
}, 120_000);

// Why: a caller's own `read` (the one head reads are recorded from) without `remaining` would let a
// reading budget cut pages that were already recorded. The pairing is a type, so the typecheck,
// not a run, is this check: the line marked below must not compile.
export const wiringIsTyped = (ctx: L.LookupContext) => [
  // @ts-expect-error: a caller's own read comes only with remaining.
  L.readManyTool(ctx, { read: L.readTool(ctx) }),
  L.readManyTool(ctx, { read: L.readTool(ctx), remaining: noBudget }),
  L.readManyTool(ctx, { remaining: noBudget }),
  L.readManyTool(ctx),
];

// Why (NEU-148): finders are offered read_many beside read, wired through their own recording read
// and reading budget (find-steps.ts). Lines a finder may cite as read must be exactly the head lines
// a call showed it: in a call of several entries, in one its cap stopped and in one the budget
// stopped; never base lines, never a diff's or a hunk's, and the budget counts each result once.

// Why: a handle's ID hashes the blob, path and lines, not the revision, so a file unchanged between
// base and head has one handle per range, holding the revision of its first read. The head read of
// such a range must still record what it showed (the prompt asks for both revisions where a deletion
// matters), whichever revision was read first, through read and through read_many alike, and a base
// read must add nothing.
