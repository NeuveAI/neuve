// Why (NEU-148): `neuve review show` reads two inputs it did not before. An older build's run keeps
// each hunk's leads inside its manifest (an input from older builds); a newer run keeps them in
// their own computation, which may be absent because the run still searches them or because the
// search failed for good (an error path). Each must print what is true. Scratch repository and
// HOME, no model credentials, so no worker starts; the stored computations are written directly.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { Config, Manifest, RunLog, SearchIndex } from "@neuve/harness";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { captureOutlineSource } from "../../../packages/harness/src/graph-outline.ts";
import { markSetUp } from "./fixtures/set-up.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

const directories: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

/** A requested run over a scratch range, with its request's range and settings. */
const requested = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-show-")));
  directories.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(home);
  const git = (...args: Array<string>) =>
    Bun.spawnSync(["git", "-C", repo, ...args])
      .stdout.toString()
      .trim();
  Bun.spawnSync(["git", "init", "-q", repo]);
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  for (const text of ["a\n", "b\n"]) {
    await writeFile(join(repo, "a"), text);
    git("add", "a");
    git("commit", "-qm", text.trim());
  }
  // `neuve review` refuses a repository until setup has run there.
  await markSetUp(repo);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
  };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "NEUVE_OPENAI_TOKEN_COMMAND",
  ])
    delete env[name];
  const queued = Bun.spawnSync(
    [
      process.execPath,
      CLI,
      "review",
      "HEAD~1..HEAD",
      "--detach",
      "--repo",
      repo,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  expect(queued.exitCode).toBe(0);
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  const db = new Database(location.database);
  const row = db
    .query<{ id: string; envelope: string }, []>(
      "SELECT id, envelope FROM events WHERE kind = 'review.requested@1'",
    )
    .get()!;
  db.close();
  const event = JSON.parse(row.envelope) as {
    attribution: { range: { baseOid: string; headOid: string } };
    payload: { pipeline: { config: unknown } };
  };
  const settings = Config.precomputeSettings(
    Config.PipelineConfig.parse(event.payload.pipeline.config),
  );
  const range = event.attribution.range;
  const merge = git("merge-base", range.baseOid, range.headOid);
  const store = <T>(
    spec: Computations.ComputationSpec,
    schema: import("zod").z.ZodType<T>,
    value: T,
  ) =>
    Effect.runPromise(
      SearchIndex.jsonComputation(spec, schema, Effect.succeed(value)).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
  const show = (json: boolean) => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        CLI,
        "review",
        "show",
        "--run",
        row.id,
        ...(json ? ["--json"] : []),
        "--repo",
        repo,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  return { runId: row.id, location, settings, range, merge, store, show };
};

const hunk: Manifest.ManifestHunk = {
  hunkId: "h1",
  kind: "text",
  path: "a",
  oldPath: "a",
  newPath: "a",
  oldOid: "1".repeat(40),
  newOid: "2".repeat(40),
  status: "modified",
  oldMode: "100644",
  newMode: "100644",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  added: 1,
  deleted: 1,
  text: "@@ -1 +1 @@\n-a\n+b\n",
  textSha256: "0".repeat(64),
  enclosing: null,
  query: null,
  ownedRanges: [{ side: "new", startLine: 1, lineCount: 1 }],
  qualifications: [],
  declared: [],
  countsTowardReviewLines: true,
  allowance: { tokens: 4_000, exactShare: 0, floored: true },
};
const manifestOf = (
  range: { baseOid: string; headOid: string },
  merge: string,
) => ({
  range: {
    baseOid: range.baseOid,
    headOid: range.headOid,
    mergeBase: merge,
    baseTree: "c".repeat(40),
    headTree: "d".repeat(40),
  },
  files: 1,
  reviewLines: 2,
  facts: [],
  declarations: { readers: [], gaps: [] },
  limitations: [],
});

test("review show reads an older run's manifest with each hunk's leads inside it", async () => {
  const run = await requested();
  const lead = {
    source: "cached" as const,
    tree: "c".repeat(40),
    querySha256: "0".repeat(64),
    results: [],
    millis: 1,
  };
  await run.store(
    Manifest.legacyManifestSpec(
      run.range,
      run.merge,
      run.settings,
      captureOutlineSource(),
    ),
    Manifest.LegacyRangeManifest,
    {
      ...manifestOf(run.range, run.merge),
      settings: run.settings,
      hunks: [{ ...hunk, leads: lead }],
      index: null,
      leads: { cached: 1, searched: 0, stale: 0 },
    },
  );
  expect(run.show(false)).toContain(
    "leads: 1 hunk(s) reused from commit preparation, 0 searched for the review",
  );
  const output = JSON.parse(run.show(true));
  // The manifest as stored, and its leads as their own record.
  expect(output.manifest.hunks[0].leads).toEqual(lead);
  expect(output.leads.counts).toEqual({ cached: 1, searched: 0, stale: 0 });
  expect(output.leads.hunks).toEqual([{ hunkId: "h1", leads: lead }]);
}, 120_000);

test("review show reads v2 manifests and leads, preferring the run's recorded key", async () => {
  const run = await requested();
  const source = captureOutlineSource();
  const currentSpec = Manifest.manifestSpec(
    run.range,
    run.merge,
    run.settings,
    source,
  );
  const spec = { ...currentSpec, opVersion: 2 };
  const key = Computations.computationKey(spec).key;
  const manifest = {
    ...manifestOf(run.range, run.merge),
    settings: Manifest.frontSettings(run.settings),
    hunks: [hunk],
  };
  const lead: Manifest.RangeLeads = {
    manifest: key,
    settings: Manifest.leadSettings(run.settings),
    index: null,
    counts: { cached: 1, searched: 0, stale: 0 },
    hunks: [
      {
        hunkId: "h1",
        leads: {
          source: "cached",
          tree: "c".repeat(40),
          querySha256: "0".repeat(64),
          results: [],
          millis: 1,
        },
      },
    ],
  };
  await run.store(spec, Manifest.RangeManifest, manifest);
  await run.store(
    Manifest.rangeLeadsSpec(key, lead.settings, source),
    Manifest.RangeLeads,
    lead,
  );
  expect(run.show(false)).toContain(
    "leads: 1 hunk(s) reused from commit preparation, 0 searched for the review",
  );
  const output = JSON.parse(run.show(true));
  expect(output.manifest).toEqual(manifest);
  expect(output.leads).toEqual(lead);

  // With no recorded key, readers prefer the newest stored version.
  await run.store(currentSpec, Manifest.RangeManifest, {
    ...manifest,
    files: 2,
  });
  expect(JSON.parse(run.show(true)).manifest.files).toBe(2);
  RunLog.openRunLog(run.location, run.runId).write({
    type: "precompute.manifest",
    key,
    status: "reused",
  });
  const recorded = JSON.parse(run.show(true));
  expect(recorded.manifest).toEqual(manifest);
  expect(recorded.leads).toEqual(lead);
}, 120_000);

test("review show says a newer run's leads are not stored yet, or why they never were", async () => {
  const run = await requested();
  await run.store(
    Manifest.manifestSpec(
      run.range,
      run.merge,
      run.settings,
      captureOutlineSource(),
    ),
    Manifest.RangeManifest,
    {
      ...manifestOf(run.range, run.merge),
      settings: Manifest.frontSettings(run.settings),
      hunks: [hunk],
    },
  );
  expect(run.show(false)).toContain("leads: not stored yet");
  expect(JSON.parse(run.show(true)).leads).toBeNull();
  // The leads task ended without them: the run log says how.
  RunLog.openRunLog(run.location, run.runId).write({
    type: "range.leads",
    key: "k".repeat(64),
    status: "failed",
    error: "Error: fixture",
  });
  const after = run.show(false);
  expect(after).toContain("leads: not stored; their search failed");
  expect(after).not.toContain("not stored yet");
}, 120_000);
