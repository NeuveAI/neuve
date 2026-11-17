// The real held-handler scenario exposes repeated-claim and resumed-claim measurement boundaries.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readRunLog } from "../src/run-log.ts";
import { settingsPath } from "../src/settings.ts";

import { runProcess } from "./fixtures/process.ts";

const root = mkdtempSync(join(tmpdir(), "pi-measurements-handler-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("held, repeated and resumed handler claims count only their own calls and estimates", async () => {
  mkdirSync(join(root, "home"));
  // The measurement boundaries, not the section readings (on by default): the readings are off.
  const settings = settingsPath(join(root, "home"));
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(
    settings,
    JSON.stringify({ version: 1, review: { sectionReadings: "off" } }),
  );
  const {
    OPENAI_API_KEY: _openai,
    ANTHROPIC_API_KEY: _anthropic,
    ...env
  } = process.env;
  const run = await runProcess(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "fixtures", "pi-handler-held.ts"),
    ],
    {
      env: {
        ...env,
        HOME: join(root, "home"),
        TMPDIR: root,
        SCENARIO_ROOT: root,
      },
      timeout: 110_000,
    },
  );
  expect(run.exitCode, run.stderr.toString().slice(-4000)).toBe(0);
  const stdout = run.stdout.toString().trim().split("\n");
  const observed = JSON.parse(stdout[stdout.length - 1]!);
  expect(observed.outcomes).toEqual(["JobHeld", "JobHeld", "completed"]);
  const directory = join(root, "store", "neuve", "run-logs");
  const files = readdirSync(directory);
  expect(files.length).toBe(1);
  const log = readRunLog(join(directory, files[0]!));
  expect(
    log.filter(
      (record) =>
        record.type === "span.start" &&
        record["name"] === "harness.measurements.native",
    ),
  ).toHaveLength(3);
  expect(
    log.filter(
      (record) =>
        record.type === "span" &&
        record["name"] === "harness.measurements.native",
    ),
  ).toHaveLength(3);
  const claims = log
    .filter((e) => e.type === "measurement.boundary")
    .map((e) => e["claim"]);
  expect(claims.length).toBe(3);
  expect(claims[0]).toEqual(claims[1]);
  expect(claims[2]).not.toEqual(claims[1]);
  const strict = log.filter(
    (e) => e.type === "measurement" && e["name"] === "strict-flag",
  );
  expect(strict.map((e) => e["requests"]).slice(0, 2)).toEqual([2, 0]);
  expect(strict.reduce((sum, e) => sum + Number(e["requests"]), 0)).toBe(
    observed.requests.total,
  );
  expect(
    log.filter((e) => e["name"] === "turn-latency").map((e) => e["turns"]),
  ).toEqual(strict.map((e) => e["requests"]));
  const samples = log
    .filter((e) => e["name"] === "estimate-calibration")
    .map((e) => e["samples"]);
  expect(samples[1]).toEqual([]);
  expect(samples.flat()).toEqual(
    log
      .filter((e) => e.type === "estimate")
      .map((e) => ({
        label: e["label"],
        bytes: e["bytes"],
        estimate: e["estimate"],
        counted: e["counted"],
        ratio: e["ratio"],
      })),
  );
}, 120_000);
