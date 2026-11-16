import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Preparation changes HOME; its persisted computation keys must still match review's keys.
test("checkout outline discovery and source identity do not depend on HOME or cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "outline-discovery-"));
  try {
    const executable = resolve(
      import.meta.dir,
      "../../../apps/neuve-graph/entire-graph",
    );
    const source = {
      sha256: createHash("sha256")
        .update(readFileSync(executable))
        .digest("hex"),
    };
    const env = { ...process.env };
    delete env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    const observations = ["preparation", "review"].map((home): unknown => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import { outlineExecutable, captureOutlineSource } from ${JSON.stringify(resolve(import.meta.dir, "../src/graph-outline.ts"))}; console.log(JSON.stringify({ executable: outlineExecutable(), source: captureOutlineSource().key }));`,
        ],
        { cwd: root, env: { ...env, HOME: join(root, home) } },
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      return JSON.parse(child.stdout.toString());
    });
    expect(observations).toEqual([
      { executable, source },
      { executable, source },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A bare override must fingerprint the same PATH file that Graph actually executes.
test("replacing a PATH-named engine rejects its old stack index", async () => {
  const { appendFileSync, copyFileSync, mkdirSync, symlinkSync } =
    await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "outline-path-engine-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const engine = resolve(
      import.meta.dir,
      "../../../apps/neuve-graph/entire-graph",
    );
    const replacement = join(root, "replacement");
    copyFileSync(engine, replacement);
    appendFileSync(replacement, "\n");
    const name = "neuve-path-outline-engine";
    const link = join(bin, name);
    symlinkSync(engine, link);
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/outline/path-engine.ts"),
        root,
        replacement,
        link,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NEUVE_GRAPH_OUTLINE_EXECUTABLE: name,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    console.info(JSON.stringify(result));
    expect(result.built.status).toBe("built");
    expect(result.capability).toBe("graph-symbols");
    expect(result.firstKey).toEqual({
      sha256: createHash("sha256").update(readFileSync(engine)).digest("hex"),
    });
    expect(result.firstExecutable).toBe(link);
    expect(result.metaSource).toEqual({
      kind: "available",
      sha256: result.firstKey.sha256,
    });
    expect(result.secondKey).not.toEqual(result.firstKey);
    expect(result.indexedAfterReplacement).toBe(false);
    expect(result.staleHits).toBe(0);
    expect(result.notIndexed).toEqual([result.tree]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
