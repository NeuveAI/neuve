// Why: coverage must survive a real precompute deadline, and new preparation paths need attributable timings.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeLocationIn } from "@neuve/records-core";
import { AssembledBatch } from "../src/compose.ts";
import { readRunLog, runLogPath } from "../src/run-log.ts";
import { runReview } from "./fixtures/pi-review.ts";

const root = mkdtempSync(join(tmpdir(), "large-review-integration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a real precompute deadline retains complete coverage and publishes the unread batches as pending", async () => {
  const directory = join(root, "deadline");
  const run = await runReview({
    directory,
    base: { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" },
    head: { "a.ts": "export const a = 2;\n", "b.ts": "export const b = 2;\n" },
    message: "Raise both values",
    precomputeDeadline: true,
    cutoffAfterMs: -1,
    answer: () => {
      throw new Error("No model work after cutoff");
    },
  });
  expect(run.precomputed!.facts).toBeUndefined();
  expect(run.precomputed!.record.status).toBe("skipped");
  const filled = await run.lookup("harness.code-filled-batch");
  const batches = await Promise.all(
    filled.map((entry) => run.read(entry.key, AssembledBatch)),
  );
  const owned = batches
    .flatMap((batch) => batch.units.flatMap((unit) => unit.hunkIds))
    .sort();
  expect(owned).toEqual(run.manifest.hunks.map((hunk) => hunk.hunkId).sort());
  expect(owned).toHaveLength(2);
  expect(
    run.publicationHistory.filter(
      ({ event }) =>
        event.kind === "unit.recorded@2" || event.kind === "unit.recorded@3",
    ),
  ).toHaveLength(0);
  expect(
    run.publicationHistory.filter(
      ({ event }) => event.kind === "packet.published@2",
    ),
  ).toMatchObject([
    {
      event: {
        payload: {
          complete: false,
          counts: { pending: { batches: 2, sections: 2 } },
        },
      },
    },
  ]);
  expect(run.sent).toHaveLength(0);
  const records = run.log.read();
  expect(records).toContainEqual(
    expect.objectContaining({
      type: "stage.start",
      stage: "precompute",
      agent: "precompute.coverage",
    }),
  );
  for (const name of ["harness.precompute.coverage"]) {
    expect(records).toContainEqual(
      expect.objectContaining({ type: "span.start", name }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "span",
        name,
        durationMs: expect.any(Number),
      }),
    );
  }
  for (const type of ["span.start", "span"])
    expect(records).toContainEqual(
      expect.objectContaining({
        type,
        name: "harness.pi.phase",
        attributes: expect.objectContaining({
          "harness.phase": "link",
          "harness.task_kind": "review",
        }),
      }),
    );
}, 30000);

test("range preparation jobs and shared indexes emit attributable spans", async () => {
  const directory = join(root, "preparation");
  mkdirSync(join(directory, "repo"), { recursive: true });
  const git = (...args: string[]) => {
    const result = Bun.spawnSync([
      "git",
      "-C",
      join(directory, "repo"),
      ...args,
    ]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  for (const value of [1, 2]) {
    writeFileSync(
      join(directory, "repo", "value.ts"),
      `export const value = ${value};\n`,
    );
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      `value ${value}`,
    );
  }
  const storeRoot = join(directory, "preparation-store");
  const child = Bun.spawn(
    [
      "/usr/bin/nice",
      "-n",
      "10",
      process.execPath,
      join(import.meta.dir, "fixtures/precompute-code.ts"),
      "prepare",
      join(directory, "repo"),
      storeRoot,
      join(directory, "ready"),
      JSON.stringify({
        kind: "range",
        range: {
          baseOid: git("rev-parse", "HEAD~1"),
          headOid: git("rev-parse", "HEAD"),
        },
      }),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, , error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(error);
  const preparation = readRunLog(
    runLogPath(storeLocationIn(storeRoot), "preparation-fixture"),
  );
  for (const name of [
    "harness.preparation.job",
    "harness.preparation.range",
    "harness.index.shared",
  ]) {
    expect(preparation).toContainEqual(
      expect.objectContaining({ type: "span.start", name }),
    );
    expect(preparation).toContainEqual(
      expect.objectContaining({ type: "span", name }),
    );
  }
  const shared = preparation.filter(
    (row) => row.type === "span.start" && row.name === "harness.index.shared",
  );
  const builds = preparation.filter(
    (row) => row.type === "span.start" && row.name === "harness.index.tree",
  );
  expect(builds.length).toBeGreaterThan(0);
  for (const build of builds)
    expect(shared.some((run) => run.spanId === build.parentSpanId)).toBe(true);
}, 30000);
