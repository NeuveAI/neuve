import { captureOutlineSource } from "../src/graph-outline.ts";
// These tests guard the opening's lossless accounting, its bound, its order and stable text.
// No model calls: exact output and real Git objects exercise the input boundaries directly.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Layer, Scope } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  renderOpening,
  fileOrder,
  initialLog,
  rankInitialFiles,
} from "../src/initial-context.ts";
import { BUDGET_LINE_BYTES, TOOL_RESULT_BYTES } from "../src/budget.ts";
import { rangeCommitFiles, reviewMessage } from "../src/git.ts";
import {
  HandleRegistry,
  hunksTool,
  hunkTool,
  readTool,
  logTool,
  commitTool,
  scopeSectionTool,
  type LookupContext,
} from "../src/lookups.ts";
import {
  findChecks,
  repairFind,
  readingBudget,
  findSystem,
  OPENING_EXAMPLE,
} from "../src/find.ts";
import { findCounters } from "../src/pi/stages/find-steps.ts";
import { frame, hunk, finding, view } from "./find-fixture.ts";
import { ScopeSnapshot, sectionsOf } from "../src/scope.ts";
import type { ManifestHunk } from "../src/manifest.ts";
import { MAP_LOCKFILES } from "../src/review-map.ts";
import { parseDiff, type CommitText } from "../src/git-objects.ts";
const hunks = new Map([[hunk.hunkId, hunk]]);
const commits: CommitText[] = [
  {
    oid: "b".repeat(40),
    subject: "Merge topic",
    body: "Merge topic\n\nFull message",
  },
  {
    oid: "a".repeat(40),
    subject: "Reject input",
    body: "Reject input\n\nExplanation",
  },
];
const files = new Map(commits.map((c) => [c.oid, ["new.ts", "old.ts"]]));
const input = { frame, hunks, commits, commitFiles: files };
const directory = mkdtempSync(join(tmpdir(), "initial-context-lookups-"));
const location = storeLocationIn(directory);
const scope = await Effect.runPromise(Scope.make());
afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  rmSync(directory, { recursive: true, force: true });
});
const records = await Effect.runPromise(
  Layer.buildWithScope(
    Computations.layer.pipe(
      Layer.provideMerge(Blobs.layer(location)),
      Layer.provideMerge(Store.layer(location, { create: true })),
      Layer.provideMerge(BunFileSystem.layer),
    ),
    scope,
  ),
);
const lookup = (extra: Partial<LookupContext> = {}): LookupContext => ({
  source: captureOutlineSource(),
  ...view(),
  repository: "unused",
  location,
  cycleId: "cycle",
  records,
  commits: [...commits].reverse(),
  findLog: { commits, files },
  handles: new HandleRegistry(),
  placement: new Map([["h1", { partition: "g1", batch: "g1" }]]),
  ...extra,
});
const call = (tool: ReturnType<typeof logTool>, input: unknown) =>
  Effect.runPromise(tool.handle(tool.input?.parse(input) ?? input));

// Why: Package references are review evidence; only actual email addresses should remove a line.
test("email filtering preserves package versions and removes real addresses", async () => {
  const repository = mkdtempSync(join(tmpdir(), "initial-context-email-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    git("commit", "--allow-empty", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const cases = [
      "Bump `@effect/platform` and vite@5.1.0 for tests",
      "queued review.run@2",
      "Sam Dev <sam@dev.example>",
    ];
    for (const subject of cases) git("commit", "--allow-empty", "-qm", subject);
    const log = await Effect.runPromise(
      rangeCommitFiles(repository, base, git("rev-parse", "HEAD")),
    );
    const ctx = lookup({ repository, commits: log.commits, findLog: log });
    const opening = renderOpening({
      ...input,
      commits: log.commits,
      commitFiles: log.files,
    });
    for (const subject of cases) {
      const commit = log.commits.find((c) => c.subject === subject)!;
      const expected =
        subject === cases[2]
          ? "[Identity trailers and email-bearing lines omitted.]"
          : subject;
      expect(reviewMessage(subject)).toBe(expected);
      expect(opening.text).toContain(`${commit.oid.slice(0, 8)} ${expected}`);
      for (const result of [
        await call(logTool(ctx), { commit: commit.oid, format: "message" }),
        await call(commitTool(ctx), { oid: commit.oid }),
      ]) {
        expect(result.text).toContain(expected);
        expect(result.text).not.toContain("sam@dev.example");
      }
    }
    for (const line of [
      "(@Injectable)",
      "effect@3.1.0",
      "user@host.com2",
      "user@host.example.2",
      "user@host.example_bad",
    ])
      expect(reviewMessage(line)).toBe(line);
    expect(reviewMessage("Contact sam@dev.example today")).toBe(
      "[Identity trailers and email-bearing lines omitted.]",
    );
    expect(reviewMessage("Contact josé@développeur.exemple today")).toBe(
      "[Identity trailers and email-bearing lines omitted.]",
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

// Why: A synchronous regex hang cannot be interrupted by the test runner's own timer.
test("a million-character message line and title finish under a child hang watchdog", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `import { reviewMessage } from ${JSON.stringify(fileURLToPath(new URL("../src/git.ts", import.meta.url)))};
     import { initialLog } from ${JSON.stringify(fileURLToPath(new URL("../src/initial-context.ts", import.meta.url)))};
     const line = "x".repeat(1_000_000);
     if (reviewMessage(line) !== line) process.exit(1);
     const log = initialLog([{oid: "a".repeat(40), subject: line, body: ""}], [], new Map());
     if (log.text !== "aaaaaaaa " + "x".repeat(200)) process.exit(2);`,
    ],
    { timeout: 30_000 },
  );
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
});

// Why: Capping after the filter would remove a safe visible title because of its hidden tail.
test("titles are capped before filtering in the opening and log", async () => {
  const subject = "x".repeat(200) + " sam@dev.example";
  const cs = [{ ...commits[0]!, subject }];
  expect(initialLog(cs, [], files).text).toBe("bbbbbbbb " + "x".repeat(200));
  const result = await call(
    logTool(lookup({ findLog: { commits: cs, files } })),
    {},
  );
  expect(result.text).toContain("bbbbbbbb " + "x".repeat(200));
  expect(result.text).not.toContain("omitted");
});

// Why: Coverage selection must preserve hot files and account for every omitted commit.
test("heat uses changed lines and byte-stable path ties; coverage keeps skipped runs within the log cap", () => {
  const fs = ["cold", "hot-b", "hot-a"].map((path) => ({
    path,
    added: path === "cold" ? 1 : 50,
    deleted: 0,
    status: "M",
  }));
  expect(rankInitialFiles(fs).map((f) => f.path)).toEqual([
    "hot-a",
    "hot-b",
    "cold",
  ]);
  const cs = Array.from({ length: 8 }, (_, i) => ({
    oid: i.toString().repeat(40),
    subject: "title".repeat(4),
    body: "",
  }));
  const touched = new Map(
    cs.map((c, i) => [c.oid, i === 6 ? ["hot-a", "hot-b"] : ["cold"]]),
  );
  const result = initialLog(cs, fs, touched, 100);
  expect(result.shown.has(cs[6]!.oid)).toBe(true);
  expect(result.text.length).toBeLessThanOrEqual(100);
  expect(result.text).toContain("…");
  const represented =
    result.shown.size +
    [...result.text.matchAll(/… (\d+) commits/g)].reduce(
      (n, m) => n + Number(m[1]),
      0,
    );
  expect(represented).toBe(8);
  const indices = result.text
    .split("\n")
    .filter((l) => !l.startsWith("…"))
    .map((l) => Number(l[0]));
  expect(indices).toEqual([...indices].sort());
});

// Why: Removing opening hunk ids must not prevent discovery or weaken the existing ownership checks.
// Finders read before any hunk is placed in a group or partition, so hunks offers no such filter.
test("hunks resolves either rename path, offers no group filter; checks and repair resolve findings without opening ids", async () => {
  const ctx = lookup();
  for (const args of [{}, { path: "new.ts" }, { path: "old.ts" }])
    expect((await call(hunksTool(ctx), args)).text).toContain("h1 new.ts");
  const missing = await call(hunksTool(ctx), { path: "other.ts" });
  expect(missing.empty).toBe(true);
  expect(missing.text).toBe("No hunks for path other.ts.");
  for (const args of [{ group: "g1" }, { partition: "g1", path: "new.ts" }])
    expect(hunksTool(ctx).input?.safeParse(args).success).toBe(false);
  expect(hunksTool(ctx).description).not.toMatch(/group|partition/);
  const checks = {
    lens: "correctness" as const,
    frame,
    hunks,
    unreviewed: new Map(),
    evidence: new Set(["h1"]),
    headReads: () => [],
  };
  expect(findChecks({ findings: [finding], notes: [] }, checks)).toEqual([]);
  expect(
    repairFind({ findings: [finding], notes: [] }, checks).findings,
  ).toEqual([finding]);
});

// Why: Log reads must stay inside the range, page complete messages and obey the shared reading limit.
test("log filters only range commits and paths, pages full messages and spends the shared reading budget", async () => {
  const ctx = lookup({
    findLog: {
      commits: [
        { ...commits[0]!, body: "begin\n" + "x".repeat(30000) + "\nlast-line" },
        commits[1]!,
      ],
      files,
    },
  });
  const tool = logTool(ctx);
  expect((await call(tool, {})).text).toContain(
    "bbbbbbbb Merge topic\naaaaaaaa Reject input",
  );
  expect((await call(tool, { commit: "f".repeat(40) })).text).toContain(
    "Only commits in the range",
  );
  expect((await call(tool, { paths: ["missing"] })).empty).toBe(true);
  expect((await call(tool, { paths: ["old.ts"] })).text).toContain("aaaaaaaa");
  const pages: string[] = [];
  for (let cursor = 1; cursor <= 10; cursor++) {
    const result = await call(tool, {
      commit: "bbbbbbbb",
      format: "message",
      cursor,
    });
    pages.push(result.text);
    expect(Buffer.byteLength(result.text)).toBeLessThan(
      TOOL_RESULT_BYTES - BUDGET_LINE_BYTES,
    );
    if (!result.paged || result.text.includes("the last]")) break;
  }
  expect(pages.join("\n")).toContain("last-line");
  // A page that crosses the budget (the message's long second page) is cut to fit it, says so, and
  // spends it.
  const budget = readingBudget([tool], 400);
  const cut = await call(budget.tools[0]!, {
    commit: "bbbbbbbb",
    format: "message",
    cursor: 2,
  });
  expect(cut.text.length).toBeLessThanOrEqual(400);
  expect(cut.text).toMatch(/\n\[reading budget reached: [^\n]*\]$/);
  expect((await call(budget.tools[0]!, {})).error).toBe("BudgetSpent");
});

// Unicode message lines must remain reachable without pageText cutting their middle.
test("log pages preserve multibyte text and Unicode line separators in a full message", async () => {
  const body = "😀\u2028".repeat(3000) + "end-of-message";
  const ctx = lookup({
    findLog: { commits: [{ ...commits[0]!, body }], files },
  });
  const pages: string[] = [];
  for (let cursor = 1; cursor <= 20; cursor++) {
    const result = await call(logTool(ctx), { format: "message", cursor });
    pages.push(result.text);
    expect(Buffer.byteLength(result.text)).toBeLessThan(
      TOOL_RESULT_BYTES - BUDGET_LINE_BYTES,
    );
    expect(result.text).not.toContain("line cut");
    if (!result.paged || result.text.includes("the last]")) break;
  }
  expect(pages.join("").match(/😀/gu)).toHaveLength(3000);
  expect(pages.join("").match(/\u2028/gu)).toHaveLength(3000);
  expect(pages.join("")).toContain("end-of-message");
});

// Why: Counters must distinguish actual opens from index sightings and survive registry restore.
test("finder counters distinguish index sightings, repeated hunk opens, files and log calls across restore, and count the opening's parts", async () => {
  const id = "h111111111111111";
  const counterHunks = new Map([
    [id, { ...hunk, hunkId: id }],
    ["support", { ...hunk, hunkId: "support", path: "support.ts" }],
  ]);
  const opening = renderOpening({ ...input, hunks: counterHunks });
  const ctx = lookup({
    hunks: counterHunks,
    placement: new Map([[id, { partition: "g1", batch: "g1" }]]),
  });
  await call(hunksTool(ctx), {});
  expect(ctx.handles.seen(id)?.lookup).toBe("hunks");
  expect(
    findCounters({
      opening,
      hunks: counterHunks,
      handles: ctx.handles,
    })["harness.find.hunks_opened"],
  ).toBe(0);
  await call(hunkTool(ctx), { id });
  await call(hunkTool(ctx), { id });
  await call(logTool(ctx), {});
  await call(logTool(ctx), {});
  const repository = mkdtempSync(join(tmpdir(), "initial-context-read-"));
  try {
    const initialized = Bun.spawnSync(["git", "-C", repository, "init", "-q"]);
    expect(initialized.exitCode).toBe(0);
    const hashed = Bun.spawnSync(
      ["git", "-C", repository, "hash-object", "-w", "--stdin"],
      { stdin: Buffer.from("read this line\n") },
    );
    expect(hashed.exitCode).toBe(0);
    const oid = hashed.stdout.toString().trim();
    const entry = {
      path: "new.ts",
      oid,
      mode: "100644",
      type: "blob",
      size: 15,
    };
    const outcome = await call(
      readTool({
        ...ctx,
        repository,
        head: { ...ctx.head, entries: new Map([[entry.path, entry]]) },
      }),
      { path: "new.ts" },
    );
    expect(outcome.text).toContain("1: read this line");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
  ctx.handles.register({
    rev: "head",
    path: "search-only.ts",
    blob: "3".repeat(40),
    commit: "4".repeat(40),
    startLine: 1,
    endLine: 1,
    lookup: "search",
    args: {},
    parent: null,
    retrieval: null,
  });
  const restored = new HandleRegistry();
  restored.restore(ctx.handles.toJSON());
  expect(
    findCounters({
      opening,
      hunks: counterHunks,
      handles: restored,
    }),
  ).toEqual({
    "harness.find.hunks_opened": 1,
    "harness.find.files_read": 1,
    "harness.find.log_calls": 2,
    "harness.find.opening_chars": opening.text.length,
    "harness.find.opening_over_limit": 0,
    "harness.find.opening_frame_chars": opening.counts.chars.frame,
    "harness.find.opening_scope_chars": 0,
    "harness.find.opening_index_chars": opening.counts.chars.index,
    "harness.find.opening_diff_chars": opening.counts.chars.diff,
    "harness.find.opening_log_chars": opening.counts.chars.log,
    "harness.find.sections_inlined": 0,
    "harness.find.sections_listed": 0,
    "harness.find.files_total": 2,
    "harness.find.files_named": 2,
    "harness.find.files_folded": 0,
    "harness.find.files_diffed": 2,
    "harness.find.files_cut": 0,
    "harness.find.hunks_total": 2,
    "harness.find.hunks_diffed": 2,
    "harness.find.lines_added_shown": 2,
    "harness.find.lines_deleted_shown": 2,
    "harness.find.lines_context_shown": 4,
    "harness.find.owned_added_shown": 2,
    "harness.find.owned_deleted_shown": 2,
    "harness.find.owned_added_total": 2,
    "harness.find.owned_deleted_total": 2,
    "harness.find.log_lines_shown": 2,
    "harness.find.log_lines_total": 2,
  });
});

// Why: Git formatting, merges, empty commits and literal paths must agree with the real repository.
test("one real Git read includes merges, Git oneline subjects, full messages and literal unusual paths", async () => {
  const repository = mkdtempSync(join(tmpdir(), "initial-context-git-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    writeFileSync(join(repository, "base"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "topic");
    const path = "tab\tand\nnewline";
    writeFileSync(join(repository, path), "changed");
    git("add", ".");
    git(
      "commit",
      "-qm",
      "Title first\nsecond line\n\nFull explanation\nSigned-off-by: Sam Dev <sam@dev.example>\nco-AUTHORED-by: Pat Peer\nReviewed-by: Other Peer\nContact me at person@domain.example\nLocal contact person@localhost\nBug: 42\nChange-Id: I123",
    );
    git("checkout", "-q", "--detach", base);
    writeFileSync(join(repository, "other"), "other");
    git("add", ".");
    git("commit", "-qm", "other");
    git("merge", "--no-ff", "-qm", "Merge topic", "topic");
    const head = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "Empty commit");
    const emptyHead = git("rev-parse", "HEAD");
    git("checkout", "-qb", "unrelated-topic");
    writeFileSync(join(repository, "unrelated.ts"), "unrelated");
    git("add", ".");
    git("commit", "-qm", "Unrelated change");
    git("checkout", "-q", "--detach", emptyHead);
    git("merge", "--no-ff", "-qm", "Merge unrelated", "unrelated-topic");
    const unrelatedMerge = git("rev-parse", "HEAD");
    const result = await Effect.runPromise(
      rangeCommitFiles(repository, base, unrelatedMerge),
    );
    expect(result.files.get(emptyHead)).toEqual([]);
    expect(JSON.stringify(result.commits)).not.toContain(
      "fixture@example.invalid",
    );
    expect(JSON.stringify(result.commits)).not.toContain("Fixture");
    expect(
      result.commits.map((c) => `${c.oid.slice(0, 8)} ${c.subject}`).join("\n"),
    ).toBe(
      git("log", "--format=%h %s", "--abbrev=8", `${base}..${unrelatedMerge}`),
    );
    expect(result.files.get(head)).toEqual([]);
    expect(result.mergeFiles?.get(head)).toEqual([path]);
    expect(result.mergeFiles?.get(unrelatedMerge)).toEqual(["unrelated.ts"]);
    expect(
      result.commits.find((c) => c.subject === "Title first second line")?.body,
    ).toContain("Full explanation");
    expect([...result.files.values()].flat()).toContain(path);
    const topic = result.commits.find(
      (c) => c.subject === "Title first second line",
    )!;
    const ctx = lookup({
      repository,
      commits: result.commits,
      findLog: result,
    });
    for (const tool of [
      await call(logTool(ctx), { commit: topic.oid, format: "message" }),
      await call(commitTool(ctx), { oid: topic.oid }),
    ]) {
      expect(tool.text).toContain("Full explanation");
      expect(tool.text).toContain("Bug: 42");
      expect(tool.text).toContain("Change-Id: I123");
      expect(tool.text).toContain("Local contact person@localhost");
      for (const identity of [
        "Sam Dev",
        "Pat Peer",
        "Other Peer",
        "person@domain.example",
        "-by:",
      ])
        expect(tool.text).not.toContain(identity);
      expect(tool.text).toContain(
        "Identity trailers and email-bearing lines omitted",
      );
    }
    const fs = [
      { path, status: "M", added: 100, deleted: 0 },
      { path: "other", status: "M", added: 1, deleted: 0 },
    ];
    const selected = initialLog(
      result.commits,
      fs,
      result.files,
      62,
      result.mergeFiles,
    );
    expect(selected.shown.has(topic.oid)).toBe(true);
    expect(selected.shown.has(head)).toBe(false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

// Why: coverage must remove covered heat, and file rank must outweigh file count.
test("coverage spends heat once and prefers hotter files over more cold files", () => {
  const fs = ["a", "b", "c", "d", "e"].map((path, i) => ({
    path,
    added: 100 - i,
    deleted: 0,
    status: "M",
  }));
  const cs = Array.from({ length: 4 }, (_, i) => ({
    oid: String(i).repeat(40),
    subject: "t".repeat(100),
    body: "",
  }));
  const touched = new Map([
    [cs[0]!.oid, ["a", "b"]],
    [cs[1]!.oid, ["a", "b"]],
    [cs[2]!.oid, ["c", "d"]],
    [cs[3]!.oid, ["e"]],
  ]);
  expect([...initialLog(cs, fs, touched, 250).shown].sort()).toEqual([
    cs[0]!.oid,
    cs[2]!.oid,
  ]);
  const heat = new Map([
    [cs[0]!.oid, ["c", "d", "e"]],
    [cs[1]!.oid, ["a", "b"]],
  ]);
  expect([...initialLog(cs, fs, heat, 150).shown]).toEqual([cs[1]!.oid]);
});

// Why: A stale positive score must be reinserted so newly uncovered heat wins the next slot.
test("lazy coverage rechecks a stale top candidate before spending the remaining space", () => {
  const fs = ["a", "b", "c", "d", "e"].map((path, i) => ({
    path,
    added: 100 - i,
    deleted: 0,
    status: "M",
  }));
  const cs = Array.from({ length: 4 }, (_, i) => ({
    oid: String(i).repeat(40),
    subject: "t".repeat(100),
    body: "",
  }));
  const touched = new Map([
    [cs[0]!.oid, ["a", "b", "c"]],
    [cs[1]!.oid, ["a", "b", "d"]],
    [cs[2]!.oid, ["d", "e"]],
    [cs[3]!.oid, []],
  ]);
  expect([...initialLog(cs, fs, touched, 250).shown].sort()).toEqual([
    cs[0]!.oid,
    cs[2]!.oid,
  ]);
});

// Why: scope-fit can only read a section when the Frame supplies its resolvable id.
test("the complete Frame remains plain text, its cited section is inlined, and the id resolves through scope_section", async () => {
  const repository = mkdtempSync(join(tmpdir(), "initial-context-scope-"));
  try {
    expect(
      Bun.spawnSync(["git", "-C", repository, "init", "-q"]).exitCode,
    ).toBe(0);
    const body = "# Done when\nPreserve the saved value\n";
    const hashed = Bun.spawnSync(
      ["git", "-C", repository, "hash-object", "-w", "--stdin"],
      { stdin: Buffer.from(body) },
    );
    expect(hashed.exitCode).toBe(0);
    const sections = sectionsOf("S2", body);
    const sectionId = sections[0]!.id;
    const source = {
      id: "src1",
      kind: "repository-document",
      stratum: "plan-or-ticket-at-base",
      fetchedAt: "2026-11-06T00:00:00Z",
      ms: 0,
      status: "fetched",
      ref: {
        found: "test",
        path: "scope.md",
        blob: hashed.stdout.toString().trim(),
      },
      title: "Scope",
      sections,
      capture: null,
      gap: null,
    };
    const snapshot = ScopeSnapshot.parse({
      cycleId: "cycle",
      fetchedAt: source.fetchedAt,
      ms: 0,
      range: { baseOid: "base", headOid: "head", mergeBase: "base" },
      integrations: { file: "absent", detail: null, servers: [] },
      named: [],
      sources: [source],
      strata: { strongest: source.stratum, present: [source.stratum] },
      gaps: [],
    });
    const f = {
      ...frame,
      stratum: snapshot.strata.strongest,
      sourceIds: ["src1"],
      gaps: ["A scope gap"],
      doneWhen: [
        {
          ...frame.doneWhen[0]!,
          basis: "done-when" as const,
          sectionId,
          candidateId: "O1",
        },
      ],
    };
    const rendered = renderOpening({
      ...input,
      frame: f,
      sections: [
        {
          id: sectionId,
          header: `${sectionId} "Done when" of src1 (repository-document, plan-or-ticket-at-base)`,
          text: "# Done when\nPreserve the saved value",
        },
      ],
    }).text;
    // The cited section is in the opening, so no lens needs scope_section for it.
    expect(rendered).toContain(`Scope\n${sectionId} "Done when" of src1`);
    expect(rendered).toContain("Preserve the saved value");
    for (const value of [
      "D1 Invalid input is refused",
      "basis: done-when",
      `sectionId: ${sectionId}`,
      "candidateId: O1",
      "Source ids: src1",
      "Stratum: plan-or-ticket-at-base",
      "Source: fallback",
      "Gaps: A scope gap",
      "sectionsInlined 0",
      "sectionsListed 0",
      "commitsShown 1",
      "commitsTotal 1",
    ])
      expect(rendered).toContain(value);
    const read = await call(
      scopeSectionTool(lookup({ repository, snapshot })),
      { id: sectionId },
    );
    expect(read.error).toBeUndefined();
    expect(read.text).toContain("Preserve the saved value");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

// Why: a Frame can cite a section the run's snapshot does not hold. It takes no room, so it must
// not stop the sections after it from being inlined; it is listed by ID and the rest go on.
test("a cited section missing from the snapshot is listed and the next one is still inlined", () => {
  const text = renderOpening({
    ...input,
    sections: [
      { id: "S9" },
      {
        id: "S1",
        header: `S1 "Done when" of src1 (repository-document, plan-or-ticket-at-base)`,
        text: "# Done when\nPreserve the saved value",
      },
    ],
  }).text;
  expect(text).toContain(
    `Scope\nS1 "Done when" of src1 (repository-document, plan-or-ticket-at-base)\n# Done when\nPreserve the saved value\nNot inlined: S9 (not in this run's scope snapshot)`,
  );
});

// Why: after coverage, the remaining room belongs to merge summaries before log-order filler.
test("folded logs spend spare characters on merges before other zero-heat commits", () => {
  const cs = Array.from({ length: 5 }, (_, i) => ({
    oid: String(i).repeat(40),
    subject: "t".repeat(60),
    body: "",
  }));
  const fs = [{ path: "hot", added: 100, deleted: 0, status: "M" }];
  const touched = new Map(cs.map((c, i) => [c.oid, i === 2 ? ["hot"] : []]));
  const mergeFiles = new Map([[cs[4]!.oid, ["hot"]]]);
  const result = initialLog(cs, fs, touched, 170, mergeFiles);
  expect([...result.shown].sort()).toEqual([cs[2]!.oid, cs[4]!.oid]);
  expect(result.text.length).toBeLessThanOrEqual(170);
});

// Why: The log floor must stop at hot-tenth coverage instead of spending all coverage heat.
test("log floor selects by uncovered heat, stops at the hottest tenth and keeps Git order", () => {
  const fs = Array.from({ length: 20 }, (_, i) => ({
    path: `f${i}`,
    added: 20 - i,
    deleted: 0,
    status: "M",
  }));
  const cs = Array.from({ length: 10 }, (_, i) => ({
    oid: i.toString().repeat(40),
    subject: `change ${i}`,
    body: "",
  }));
  const touched = new Map(
    cs.map((c, i) => [c.oid, i === 8 ? ["f0", "f1"] : [`f${i + 2}`]]),
  );
  const floor = initialLog(cs, fs, touched, Infinity, undefined, true);
  expect([...floor.shown]).toEqual([cs[8]!.oid]);
  expect(floor.text).toBe("… 8 commits\n88888888 change 8\n… 1 commits");
});

// Why: A merge-only hot file must not make the coverage floor consume the whole log.
test("log floor stops at the reachable hottest files, including an empty reachable set", () => {
  const fs = Array.from({ length: 20 }, (_, i) => ({
    path: `f${i}`,
    added: 20 - i,
    deleted: 0,
    status: "M",
  }));
  const cs = Array.from({ length: 10 }, (_, i) => ({
    oid: i.toString().repeat(40),
    subject: `change ${i}`,
    body: "",
  }));
  const touching = new Map(
    cs.map((c, i) => [c.oid, [i === 8 ? "f1" : `f${i + 2}`]]),
  );
  expect(initialLog(cs, fs, touching, Infinity, undefined, true).text).toBe(
    "… 8 commits\n88888888 change 8\n… 1 commits",
  );
  touching.set(cs[8]!.oid, ["f19"]);
  expect(initialLog(cs, fs, touching, Infinity, undefined, true).text).toBe(
    "… 10 commits",
  );
});

// Why: Reverse-order coverage inserts must replace exactly one skipped run at a tight budget.
test("log neighbour accounting handles insertion before the first selected commit", () => {
  const fs = Array.from({ length: 20 }, (_, i) => ({
    path: `f${i}`,
    added: 20 - i,
    deleted: 0,
    status: "M",
  }));
  const cs = Array.from({ length: 10 }, (_, i) => ({
    oid: i.toString().repeat(40),
    subject: `change ${i}`,
    body: "",
  }));
  const touching = new Map(
    cs.map((c, i) => [c.oid, [i === 9 ? "f0" : i === 0 ? "f1" : `f${i + 2}`]]),
  );
  expect(initialLog(cs, fs, touching, 47, undefined, true).text).toBe(
    "00000000 change 0\n… 8 commits\n99999999 change 9",
  );
  expect(initialLog(cs, fs, touching, 46, undefined, true).text).toBe(
    "… 9 commits\n99999999 change 9",
  );
});

/** A text hunk from its body lines, with the owned ranges a changed run gives (review-rules' shape). */
const textHunk = (o: {
  id: string;
  path: string;
  lines: ReadonlyArray<string>;
  oldStart?: number;
  newStart?: number;
  status?: ManifestHunk["status"];
  declared?: ManifestHunk["declared"];
  symbols?: ReadonlyArray<string>;
}): ManifestHunk => {
  const oldStart = o.oldStart ?? 1;
  const newStart = o.newStart ?? 1;
  const owned: Array<{
    side: "old" | "new";
    startLine: number;
    lineCount: number;
  }> = [];
  let oldLine = oldStart,
    newLine = newStart;
  let run: (typeof owned)[number] | undefined;
  for (const l of o.lines) {
    const side = l[0] === "-" ? "old" : l[0] === "+" ? "new" : undefined;
    if (side === undefined) {
      run = undefined;
      oldLine++;
      newLine++;
      continue;
    }
    const at = side === "old" ? oldLine++ : newLine++;
    if (run?.side === side && run.startLine + run.lineCount === at)
      run.lineCount++;
    else {
      run = { side, startLine: at, lineCount: 1 };
      owned.push(run);
    }
  }
  const oldLines = o.lines.filter((l) => l[0] !== "+").length;
  const newLines = o.lines.filter((l) => l[0] !== "-").length;
  return {
    ...hunk,
    hunkId: o.id,
    path: o.path,
    oldPath: o.status === "added" ? null : o.path,
    newPath: o.status === "deleted" ? null : o.path,
    status: o.status ?? "modified",
    oldStart,
    oldLines,
    newStart,
    newLines,
    added: o.lines.filter((l) => l[0] === "+").length,
    deleted: o.lines.filter((l) => l[0] === "-").length,
    text: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${o.lines.join("\n")}`,
    ownedRanges: owned,
    declared: o.declared ?? [],
    enclosing:
      o.symbols === undefined
        ? null
        : {
            side: "post",
            symbols: [...o.symbols],
            headingPath: [],
            capability: "test",
            language: "ts",
            limitation: null,
          },
  };
};
const hunksOf = (list: ReadonlyArray<ManifestHunk>) =>
  new Map(list.map((h) => [h.hunkId, h]));

// Why: the four lenses share one opening and a resumed step must read the same text, so the same
// range and Frame give the same bytes; a different Frame gives a different opening.
test("the opening is byte-identical for the same input and differs with the Frame", () => {
  const range = hunksOf([
    textHunk({ id: "h2", path: "b.ts", lines: [" a", "-b", "+c", " d"] }),
    textHunk({ id: "h1", path: "a.ts", lines: ["+x"], symbols: ["writer"] }),
  ]);
  const first = renderOpening({ ...input, hunks: range });
  const again = renderOpening({
    ...input,
    hunks: new Map([...range].reverse()),
  });
  expect(again).toEqual(first);
  const other = renderOpening({
    ...input,
    hunks: range,
    frame: { ...frame, goal: "Another goal" },
  });
  expect(other.text).not.toBe(first.text);
  // In order: Frame, index, diff, log.
  const at = (part: string) => first.text.indexOf(`\n${part}`);
  expect(at("Frame")).toBeLessThan(at("Index:"));
  expect(at("Index:")).toBeLessThan(at("Diff"));
  expect(at("Diff")).toBeLessThan(at("Log"));
});

// Why: finders cite deleted and added lines, so the diff must show both sides with their line
// numbers and mark the owned changed lines a primary anchor may cite, under each hunk's ID and
// enclosing symbol; the example in the prompt must match what is rendered.
test("the diff shows deleted and added lines with both line numbers and marks owned lines", () => {
  const opening = renderOpening({
    ...input,
    hunks: hunksOf([
      textHunk({
        id: "h3",
        path: "packages/api/src/auth.ts",
        oldStart: 40,
        newStart: 40,
        lines: [
          " const token = read(header);",
          "-if (token) return accept(token);",
          "+if (!token) return reject();",
          " return next();",
        ],
        symbols: ["verifyToken"],
      }),
    ]),
  });
  const block = [
    "packages/api/src/auth.ts M",
    "h3 in verifyToken @@ -40,3 +40,3 @@",
    "   40    40    const token = read(header);",
    "   41       -* if (token) return accept(token);",
    "         41 +* if (!token) return reject();",
    "   42    42    return next();",
  ].join("\n");
  expect(opening.text).toContain(block);
  expect(findSystem("correctness")).toContain(
    block.split("\n").slice(1).join("\n"),
  );
  expect(opening.text).toContain(
    "M packages/api/src/auth.ts +1 -1 1 hunk [diff below]",
  );
  // New-side lines shown count as read: the context and added lines, 40 to 42.
  expect(opening.headReads).toEqual([
    { path: "packages/api/src/auth.ts", startLine: 40, endLine: 42 },
  ]);
  expect(opening.counts).toMatchObject({
    filesDiffed: 1,
    hunksDiffed: 1,
    linesAdded: 1,
    linesDeleted: 1,
    linesContext: 2,
    ownedAddedShown: 1,
    ownedDeletedShown: 1,
  });
});

// Why: the prompt's worked example teaches finders to read the opening, so it must be what the
// opening renders, index and diff alike: render its three-file range and compare the whole of it.
test("the prompt's worked example is the opening rendered for its range", () => {
  const long = (n: number, sign: string) =>
    Array.from({ length: n }, (_, i) => `${sign}${i} ${"x".repeat(400)}`);
  const opening = renderOpening({
    ...input,
    hunks: hunksOf([
      textHunk({
        id: "h3",
        path: "packages/api/src/auth.ts",
        oldStart: 40,
        newStart: 40,
        lines: [
          " const token = read(header);",
          "-if (token) return accept(token);",
          "+if (!token) return reject();",
          " return next();",
        ],
        symbols: ["verifyToken"],
      }),
      textHunk({
        id: "h4",
        path: "packages/api/tests/auth.test.ts",
        status: "added",
        oldStart: 0,
        lines: ['+test("rejects a missing token", () => {', "+});"],
        declared: [{ kind: "test", by: "package-scripts-bun-test" }],
      }),
      // Too large for the diff's share, so it is listed with what to open.
      textHunk({
        id: "h9",
        path: "packages/api/docs/guide.md",
        lines: [...long(40, "-"), ...long(120, "+")],
        declared: [
          { kind: "doc", by: "gitattributes: linguist-documentation" },
        ],
      }),
    ]),
  });
  expect(opening.text).toContain(`\n\n${OPENING_EXAMPLE}\n\n`);
  expect(findSystem("correctness")).toContain(OPENING_EXAMPLE);
});

// Why: the bound decides which diffs a finder gets for free. The order is source, then declared
// tests, declared documentation, and lockfiles or declared-generated files last; by lines changed
// within a class; a file goes in whole or not at all, a larger one is skipped for the next.
test("the diff order and the whole-file rule at a bound that forces them", () => {
  const body = (n: number) =>
    Array.from({ length: n }, (_, i) => `+line ${i} ${"x".repeat(40)}`);
  const range = hunksOf([
    textHunk({
      id: "s1",
      path: "src/big.ts",
      lines: body(400),
      status: "added",
    }),
    textHunk({
      id: "s2",
      path: "src/mid.ts",
      lines: body(30),
      status: "added",
    }),
    textHunk({
      id: "s3",
      path: "src/small.ts",
      lines: body(10),
      status: "added",
    }),
    textHunk({
      id: "t1",
      path: "src/a.test.ts",
      lines: body(60),
      status: "added",
      declared: [{ kind: "test", by: "package-scripts-bun-test" }],
    }),
    textHunk({
      id: "d1",
      path: "docs/guide.md",
      lines: body(5),
      status: "added",
      declared: [{ kind: "doc", by: "gitattributes: linguist-documentation" }],
    }),
    textHunk({
      id: "g1",
      path: "out/gen.js",
      lines: body(2),
      status: "added",
      declared: [
        { kind: "generated", by: "gitattributes: linguist-generated=true" },
      ],
    }),
    textHunk({
      id: "l1",
      path: MAP_LOCKFILES[0]!,
      lines: body(2),
      status: "added",
    }),
  ]);
  const files = [...range.values()].map((h) => h.path);
  // The order itself, whatever fits.
  const ordered = fileOrder(
    [...range.values()].map((h) => ({
      path: h.path,
      status: "A",
      added: h.added,
      deleted: 0,
      hunks: [h],
      rank: (h.declared.some((d) => d.kind === "generated") ||
      h.path === MAP_LOCKFILES[0]
        ? 3
        : h.declared.some((d) => d.kind === "doc")
          ? 2
          : h.declared.some((d) => d.kind === "test")
            ? 1
            : 0) as 0 | 1 | 2 | 3,
      reviewed: true,
    })),
  ).map((f) => f.path);
  expect(ordered).toEqual([
    "src/big.ts",
    "src/mid.ts",
    "src/small.ts",
    "src/a.test.ts",
    "docs/guide.md",
    ...["out/gen.js", MAP_LOCKFILES[0]!].sort(),
  ]);
  const opening = renderOpening({ ...input, hunks: range }, 12_000);
  expect(opening.text.length).toBeLessThanOrEqual(12_000);
  const diffed = opening.text
    .slice(opening.text.indexOf("\nDiff\n"))
    .split("\n")
    .filter((line) => files.some((path) => line.startsWith(`${path} `)))
    .map((line) => line.split(" ")[0]!);
  // big.ts does not fit and is skipped whole; the rest go in, in order, each with every line.
  expect(diffed).toEqual(ordered.filter((path) => path !== "src/big.ts"));
  expect(opening.text).toContain("A src/big.ts +400 -0 1 hunk [read_many: s1]");
  expect(opening.text).toContain(
    "A out/gen.js +2 -0 1 hunk [diff below, not reviewed]",
  );
  expect(opening.counts.filesCut).toBe(0);
  expect(opening.counts.linesAdded).toBe(30 + 10 + 60 + 5 + 2 + 2);
  // When no file fits whole, the first in order goes in cut at a hunk, said to be cut.
  const one = hunksOf([
    textHunk({
      id: "a1",
      path: "src/huge.ts",
      lines: body(120),
      status: "added",
    }),
    textHunk({
      id: "a2",
      path: "src/huge.ts",
      lines: body(120),
      newStart: 400,
      oldStart: 1,
      status: "added",
    }),
  ]);
  const cut = renderOpening({ ...input, hunks: one }, 14_000);
  expect(cut.counts.filesCut).toBe(1);
  expect(cut.counts.hunksDiffed).toBe(1);
  expect(cut.text).toContain(
    "[diff cut: 1 of 2 hunks shown; the others are a2, from read_many with fromHunk a2]",
  );
  expect(cut.text).toContain("[diff cut below]");
});

// Why: nothing is hidden. Far below the change's size every changed file is still counted once,
// in named rows or counted folders, with the diffs named and the rest openable by path.
test("every changed file is accounted for at a bound far below the change's size", () => {
  const range = hunksOf(
    Array.from({ length: 1500 }, (_, i) =>
      textHunk({
        id: `h${i}`,
        path: `packages/p${i % 7}/src/d${i % 31}/f${i}.ts`,
        lines: [" a", "-b", "+c", " d"],
      }),
    ),
  );
  for (const limit of [50_000, 8_000]) {
    const opening = renderOpening({ ...input, hunks: range }, limit);
    const index = opening.text.slice(
      opening.text.indexOf("Index:"),
      opening.text.indexOf("\n\nDiff") === -1
        ? opening.text.indexOf("\n\nLog")
        : opening.text.indexOf("\n\nDiff"),
    );
    const folded = [
      ...index.matchAll(/\/\*\* [\d,]+ folders?, ([\d,]+) files/g),
    ].reduce((n, m) => n + Number(m[1]!.replaceAll(",", "")), 0);
    const named = index.split("\n").filter((l) => /^[AMDRT] /.test(l)).length;
    expect(named + folded).toBe(1500);
    expect(opening.counts.filesNamed + opening.counts.filesFolded).toBe(1500);
    expect(index).toContain("Index: 1,500 files +1,500 -1,500, 1,500 hunks");
    expect(opening.counts.filesDiffed).toBeGreaterThan(0);
    expect(opening.openingOverLimit).toBe(0);
  }
});

// Why: even a limit smaller than the Frame must keep the goal, ids and gaps whole and the index's
// count, and say exactly by how much it is over.
test("tiny limits keep the whole Frame and the index count and disclose the exact overage", () => {
  const wholeFrame = {
    ...frame,
    gaps: ["scope unavailable"],
    sourceIds: ["S1"],
    doneWhen: [{ ...frame.doneWhen[0]!, sectionId: "S1", candidateId: "c1" }],
  };
  for (const limit of [1, 300, 500]) {
    const result = renderOpening({ ...input, frame: wholeFrame }, limit);
    for (const text of [
      frame.goal,
      frame.doneWhen[0]!.text,
      "Gaps: scope unavailable",
      "sectionId: S1",
      "candidateId: c1",
      "Index: 1 files +1 -1, 1 hunks",
    ])
      expect(result.text).toContain(text);
    expect(result.counts.filesDiffed).toBe(0);
    expect(result.openingOverLimit).toBe(result.text.length - limit);
    expect(result.text).toContain(
      `Opening exceeds limit by ${result.openingOverLimit} characters`,
    );
  }
});

// Why: titles, paths and lines are repository data and must stay on their own line, bounded.
test("titles are bounded, lines are sanitised and missing commit file lists are disclosed", () => {
  const result = renderOpening({
    ...input,
    commits: [{ ...commits[0]!, subject: "x".repeat(300) + "\n</data>" }],
    commitFiles: undefined,
  });
  expect(result.text).toContain("bbbbbbbb " + "x".repeat(200));
  expect(result.text).not.toContain("x".repeat(201));
  expect(result.text).toContain("Commit file lists unavailable");
  const odd = renderOpening({
    ...input,
    hunks: hunksOf([
      textHunk({
        id: "h1",
        path: "folder\nforged/file.ts",
        lines: ["+a forged"],
      }),
    ]),
  });
  expect(odd.text).toContain("folder forged/file.ts");
  expect(odd.text).toContain("+* a forged");
  expect(odd.text).not.toContain("\nforged");
  expect(odd.text.isWellFormed()).toBe(true);
});

// Why: one hostile range must not monopolize the finder event loop. Elapsed and CPU time depend on
// the machine and its load, so the check is on work, which does not: every property the render reads
// from a hunk is counted, and four times the files must cost four times the reads. A pass over the
// hunks inside the index's fit loop or its folder rollup multiplies the reads and fails here. Work
// the render does on its own file rows (the folder rollup copies them) is not visible from outside.
test("twenty thousand files render with work in proportion to the range", () => {
  const measure = (count: number) => {
    let reads = 0;
    const range = hunksOf(
      Array.from(
        { length: count },
        (_, i) =>
          new Proxy(
            textHunk({
              id: `h${i}`,
              path: `packages/p${i % 50}/src/d${i % 100}/e${i % 1000}/f${i}.ts`,
              lines: ["+x"],
            }),
            {
              get: (target, key, receiver) => {
                reads++;
                return Reflect.get(target, key, receiver);
              },
            },
          ),
      ),
    );
    const cs = Array.from({ length: count / 2 }, (_, i) => ({
      oid: i.toString(16).padStart(40, "0"),
      subject: `change ${i}`,
      body: "",
    }));
    const result = renderOpening({ frame, hunks: range, commits: cs });
    return { reads, result };
  };
  const small = measure(5000);
  const large = measure(20000);
  expect(small.reads).toBeGreaterThan(5000);
  // Linear work is exactly 4 times; the margin allows a few reads that do not scale.
  expect(large.reads / small.reads).toBeLessThan(4.1);
  expect(
    large.result.counts.filesNamed + large.result.counts.filesFolded,
  ).toBe(20000);
  expect(large.result.text.length).toBeLessThanOrEqual(50000);
}, 15000);
