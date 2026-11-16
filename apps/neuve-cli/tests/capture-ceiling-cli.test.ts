// The cloud collector consumes this command's public clock before a close has finished.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveStoreLocation } from "@neuve/records-core";
import { recordedCloseCeiling } from "../../../packages/harness/src/pi/capture/recorded-inventory.ts";

test("capture-ceiling publishes the recorded artifact allowance", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-clock-cli-"));
  const run = "01M5V9FNPH0GA6XREDPJR5KWC8";
  try {
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    const location = await Effect.runPromise(resolveStoreLocation(root));
    const folder = join(location.directory, "runs", run);
    mkdirSync(join(folder, "capture"), { recursive: true });
    writeFileSync(
      join(folder, "capture", "events.jsonl"),
      JSON.stringify({ event: { type: "artifact", size: 80 * 1024 * 1024 } }) +
        "\n",
    );
    const result = Bun.spawnSync([
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../src/cli.ts"),
      "review",
      "capture-ceiling",
      "--run",
      run,
      "--repo",
      root,
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      ceilingMs: await recordedCloseCeiling(folder),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture-ceiling logs a public fallback cause while keeping JSON output usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-clock-fallback-"));
  const run = "01M5V9FNPH0GA6XREDPJR5KWC8";
  try {
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    const location = await Effect.runPromise(resolveStoreLocation(root));
    mkdirSync(join(location.directory, "runs", run, "capture"), {
      recursive: true,
    });
    writeFileSync(
      join(location.directory, "runs", run, "capture", "events.jsonl"),
      "synthetic-private-invalid-json",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "capture-ceiling",
        "--run",
        run,
        "--repo",
        root,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ceilingMs: 1800000 });
    expect(stderr).toContain(
      "capture ceiling fallback: capture close failed (private details suppressed)",
    );
    expect(stderr).not.toContain("synthetic-private");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
