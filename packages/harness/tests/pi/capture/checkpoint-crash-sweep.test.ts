// A crashed checkpoint is removed immediately; an active writer keeps its copy regardless of age.
import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { storeLocationIn } from "@neuve/records-core";
import { captureCheckpointSweep } from "../../../src/pi/capture/retention.ts";
import { privateInspectionDirectory } from "../../../src/pi/capture/safety.ts";
import { writeCaptureOwner } from "../../../src/pi/capture/staging.ts";
import { runIn, value } from "./fixture.ts";
const root = mkdtempSync(join(tmpdir(), "checkpoint-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("the checkpoint sweep removes dead and old half-written snapshots but keeps the live writer", async () => {
  const previousTemporary = process.env.TMPDIR;
  process.env.TMPDIR = join(root, "isolated-temporary");
  try {
    const location = storeLocationIn(join(root, "store"));
    const run = runIn(location);
    const snapshots = join(
      dirname(
        privateInspectionDirectory(location.directory, location.directory),
      ),
      "snapshots",
    );
    const paths = ["a", "b", "c"].map((char) =>
      join(snapshots, char.repeat(64)),
    );
    for (const path of paths) {
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, "authority.sqlite"),
        "synthetic private checkpoint",
      );
    }
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    writeFileSync(
      join(paths[0]!, ".capture-owner.json"),
      JSON.stringify({ pid: child.pid }),
    );
    writeCaptureOwner(paths[1]!);
    utimesSync(paths[1]!, new Date(0), new Date(0));
    utimesSync(paths[2]!, new Date(0), new Date(0));
    value(await run(captureCheckpointSweep(location).sweep));
    expect(paths.map((path) => existsSync(path))).toEqual([false, true, false]);
  } finally {
    if (previousTemporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporary;
  }
}, 120000);

test("capture staging cleanup retains newer owner metadata rather than treating its job as absent", async () => {
  const location = storeLocationIn(join(root, "newer-owner"));
  const folder = join(location.directory, "capture-jobs", "job-newer");
  mkdirSync(folder, { recursive: true });
  const text = JSON.stringify({
    pid: 2147483647,
    job: { seq: 999, attempt: 1, future: true },
    future: true,
  });
  writeFileSync(join(folder, ".capture-owner.json"), text);
  writeFileSync(join(folder, "newer-state"), "keep");
  value(await runIn(location)(captureCheckpointSweep(location).sweep));
  expect(existsSync(join(folder, "newer-state"))).toBe(true);
});
