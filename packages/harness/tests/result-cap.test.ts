import { captureOutlineSource } from "../src/graph-outline.ts";
// Why: 10.18 caps every tool result at 3,000 tokens, and the closed sums that size each context
// (planSettings' diff cap among them) count on it. A pager that overshoots only shows later as a
// context reaching its ceiling. This drives every pager to a full page on content built to be dense
// (long lines, multi-byte text, long paths) and checks each whole result, the toolkit's longest
// budget line included, by UN9's estimator, without the toolkit's last-resort cut; and that `uses`
// pages lose no match.
import { afterAll, expect, test } from "bun:test";
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
import {
  BUDGET_LINE_BYTES,
  TOOL_RESULT_TOKENS,
  estimateTokens,
} from "../src/budget.ts";
import * as L from "../src/lookups.ts";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import { sectionsOf, type ScopeSnapshot } from "../src/scope.ts";
import { capResult, type ToolSpec } from "../src/toolkit.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-cap-"));
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

const dense = "ŝtrïng ✓ ünïcödé ".repeat(8);
const longDir = "deeply/nested/module/with/a/rather/long/directory/name";
const write = (version: string) => {
  mkdirSync(join(repository, longDir), { recursive: true });
  writeFileSync(
    join(repository, "big.ts"),
    Array.from(
      { length: 400 },
      (_, i) =>
        `export function dup${i}(): string { return "${dense}${version}"; } // sharedIdent`,
    ).join("\n") + "\n",
  );
  for (let i = 0; i < 120; i++)
    writeFileSync(
      join(repository, longDir, `file-with-a-long-name-${i}.ts`),
      `export function dupName(): number { return ${i}; }\nexport const value${i} = sharedIdent + "${dense}${i === 0 || i % 3 === 0 ? version : ""}";\n`,
    );
  writeFileSync(
    join(repository, "doc.md"),
    `# Done when\n\n${Array.from({ length: 200 }, (_, i) => `- item ${i}: ${dense}`).join("\n")}\n`,
  );
};

test("every pager's whole result stays within 3,000 UN9 tokens, and uses loses no match", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  write("one");
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    "base",
  );
  const base = git("rev-parse", "HEAD");
  write("two");
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    `change\n\n${Array.from({ length: 400 }, (_, i) => `line ${i} ${dense}`).join("\n")}`,
  );
  const head = git("rev-parse", "HEAD");
  const location = storeLocationIn(join(directory, "store"));
  const results = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
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
        const docBlob = views.head.entries.get("doc.md")!.oid;
        const docText = (yield* L.blobTextOf(repository, docBlob))!;
        const snapshot = {
          cycleId: "cycle",
          sources: [
            {
              id: "S1",
              kind: "repository-document",
              stratum: "plan-or-ticket-at-base",
              fetchedAt: "2026-10-19T00:00:00.000Z",
              ms: 0,
              status: "fetched",
              ref: { path: "doc.md", blob: docBlob, found: "test" },
              title: "doc.md",
              sections: sectionsOf("S1", docText),
              capture: null,
              gap: null,
            },
          ],
        } as unknown as ScopeSnapshot;
        const ctx: L.LookupContext = {
          source: captureOutlineSource(),
          repository,
          location,
          cycleId: "cycle",
          manifest,
          head: views.head,
          base: views.base,
          hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
          commits: yield* L.rangeCommits(repository, manifest),
          snapshot,
          records,
          handles: new L.HandleRegistry(),
          searchFrequency: new Map(),
        };
        const bigHunk = [...manifest.hunks].sort(
          (a, b) => b.text.length - a.text.length,
        )[0]!;
        // The longest budget line the agent loop can append (its note is held to the budget).
        const line = `[${"x".repeat(BUDGET_LINE_BYTES - 2)}]`;
        const specs: ReadonlyArray<ToolSpec<unknown>> = [
          L.usesTool(ctx),
          L.searchTool(ctx),
          L.readTool(ctx),
          L.hunkTool(ctx),
          L.scopeSectionTool(ctx),
          L.treeTool(ctx),
          L.defsTool(ctx),
          L.outlineTool(ctx),
          L.commitTool(ctx),
          L.hunksTool(ctx),
        ];
        const call = (name: string, params: unknown) =>
          Effect.gen(function* () {
            const tool = specs.find((spec) => spec.name === name);
            if (!tool) throw new Error(`Missing tool ${name}`);
            const outcome = yield* tool.handle(tool.input?.parse(params));
            return capResult(outcome.text, line);
          });
        const calls: Array<[string, unknown]> = [
          ["search", { query: `dup sharedIdent string ${dense}`, k: 10 }],
          ["read", { path: "big.ts", startLine: 1, endLine: 400 }],
          ["hunk", { id: bigHunk.hunkId }],
          ["scope_section", { id: snapshot.sources[0]!.sections[0]!.id }],
          ["tree", { prefix: "" }],
          ["defs", { identifier: "dupName" }],
          ["outline", { path: "big.ts" }],
          ["commit", { oid: head.slice(0, 12) }],
          ["hunks", {}],
        ];
        const out: Array<{ tool: string; tokens: number; text: string }> = [];
        for (const [name, params] of calls) {
          const text = yield* call(name, params);
          out.push({
            tool: name,
            tokens: estimateTokens(Buffer.byteLength(text)),
            text,
          });
        }
        // Every page of `uses`, to count the matches it returns.
        const seen = new Set<string>();
        for (let page = 1; page < 60; page++) {
          const text = yield* call("uses", { identifier: "sharedIdent", page });
          out.push({
            tool: `uses p${page}`,
            tokens: estimateTokens(Buffer.byteLength(text)),
            text,
          });
          let file = "";
          for (const row of text.split("\n")) {
            const header = /^(\S+\.ts)(?: \(.*\))?$/.exec(row)?.[1];
            if (header !== undefined) file = header;
            const lineNumber = /^ {2}(\d+)(?: in .*?)? h[0-9a-f]{9}: /.exec(
              row,
            )?.[1];
            if (lineNumber !== undefined) seen.add(`${file}:${lineNumber}`);
          }
          if (!text.includes("[more: uses page")) break;
        }
        const total = Number(
          git("grep", "-c", "-w", "sharedIdent", head)
            .split("\n")
            .reduce((sum, row) => sum + Number(row.split(":").at(-1)), 0),
        );
        return { out, matches: seen.size, total };
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  for (const result of results.out) {
    expect({
      tool: result.tool,
      under: result.tokens <= TOOL_RESULT_TOKENS,
    }).toEqual({
      tool: result.tool,
      under: true,
    });
    // Paging alone keeps it under the cap: the toolkit's last-resort cut never ran.
    expect(result.text.includes("[result cut at the")).toBe(false);
  }
  // The content is dense enough that the pagers page.
  for (const tool of [
    "read",
    "hunk",
    "scope_section",
    "tree",
    "defs",
    "outline",
    "commit",
  ])
    expect(results.out.find((result) => result.tool === tool)!.text).toMatch(
      /page 1 of \d+|\[more:/,
    );
  expect(
    results.out.filter((result) => result.tool.startsWith("uses")).length,
  ).toBeGreaterThan(1);
  expect(results.matches).toBe(results.total);
}, 120_000);
