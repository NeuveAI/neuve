// Why: the native task must persist both outputs, reuse a completed Frame at cut-off,
// and provide code coverage when cut off before setup. A user stop must not compose a review.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFront } from "./fixtures/front.ts";
for (const stop of [undefined, "setup", "map", "user-stop"] as const)
  test(`front task ${stop ?? "completes"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "front-task-"));
    try {
      const run = await runFront(directory, stop);
      if (stop === "user-stop") {
        expect(run.result.frameKey).toBeNull();
        expect(run.result.mapKey).toBeNull();
        expect(run.sent).toEqual([]);
        return;
      }
      expect(run.result.frameKey).toMatch(/^[a-f0-9]{64}$/);
      expect(run.result.mapKey).toMatch(/^[a-f0-9]{64}$/);
      expect(run.frame?.doneWhen.map((d) => d.id)).toEqual(["D1"]);
      expect(
        run.map?.groups.flatMap((g) => g.files.map((f) => f.path)),
      ).toEqual(["app.ts"]);
      expect(run.frame?.source).toBe(stop === "setup" ? "fallback" : "agent");
      expect(run.map?.source).toBe(stop === undefined ? "agent" : "fallback");
      expect(run.sent).toEqual(
        stop === "setup" ? [] : stop === "map" ? ["frame"] : ["frame", "map"],
      );
      expect(run.setup?.setup).toBeDefined();
      expect(
        run.log.find((entry) => entry.type === "map.groups"),
      ).toMatchObject({
        entries: 1,
        files: 1,
        missingFiles: 0,
        duplicateFiles: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

test("native cut-off aborts an in-flight Frame and retains its interrupted record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "front-native-abort-"));
  try {
    const run = await runFront(directory, "native-frame");
    expect(run.sent).toEqual(["frame"]);
    expect(run.frame?.source).toBe("fallback");
    expect(run.map?.source).toBe("fallback");
    expect(
      run.result.stages.some(
        (r) => r.agent === "frame" && r.status === "interrupted",
      ),
    ).toBe(true);
    expect(
      run.result.stages.some(
        (r) => r.agent === "frame" && r.status === "computed",
      ),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);

// Why: an excluded-only range has no Map entries and must spend no model calls on Map.
test("an excluded-only range skips the Map model and retains excluded coverage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "front-excluded-"));
  try {
    const run = await runFront(directory, undefined, "bun.lock");
    expect(run.sent).toEqual(["frame"]);
    expect(run.map?.groups).toEqual([]);
    expect(run.map?.excluded.map((file) => file.path)).toEqual(["bun.lock"]);
    expect(run.result.mapKey).toBeString();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
