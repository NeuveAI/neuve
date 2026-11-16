import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sharedPublication } from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";
const files = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(root, entry.name))
      : [join(root, entry.name)],
  );
// B2: killed producers never run finally; recovery must discover payloads without their metadata.
test("four interrupted ready installs are reclaimed before a healthy publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "abandoned-publication-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root);
  try {
    for (let n = 0; n < 4; n++) {
      const child = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/publication-crash.ts"),
          `crash-${n}`,
        ],
        { env: { ...process.env } },
      );
      expect(child.exitCode, child.stderr.toString()).toBe(23);
      expect(child.stdout.toString()).toContain("killedBeforeInstall");
      // Reproduce the old pruner having already discarded metadata while leaving ready payloads.
      for (const name of files(root))
        if (/^meta-[0-9a-f-]{36}$/.test(basename(name))) rmSync(name);
    }
    expect(files(root).some((name) => name.includes("/ready-"))).toBe(true);
    const store = sharedPublication({
      namespace: "shared-indexes-v4",
      scope: "store",
      key: "healthy",
      group: "tree",
      schema: z.object({ publication: z.uuid(), value: z.number() }),
      reusable: () => true,
      authority: host.authority,
    });
    const result = await store.publish({ publication: randomUUID(), value: 2 });
    expect((await store.read(result.publication))?.value).toBe(2);
    expect(
      files(root).filter((name) => /^[0-9a-f-]{36}$/.test(basename(name))),
    ).toHaveLength(1);
    expect(
      files(root).some(
        (name) =>
          name.includes("/ready-") ||
          name.includes("/prepare-") ||
          /data-[0-9a-f-]+\.tmp$/.test(name),
      ),
    ).toBe(false);
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
