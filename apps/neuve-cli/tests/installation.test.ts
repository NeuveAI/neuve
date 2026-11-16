import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstallation } from "../src/installation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const repositoryWith = async (config: (owner: string) => object) => {
  const owner = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-installation-")),
  );
  roots.push(owner);
  await mkdir(join(owner, "neuve"), { mode: 0o700 });
  await writeFile(
    join(owner, "neuve/config.json"),
    JSON.stringify(config(owner)),
  );
  return owner;
};

const binaries = (owner: string) => ({
  repository: owner,
  cliBinary: join(owner, "neuve/bin/neuve"),
  graphBinary: join(owner, "neuve/bin/neuve-graph"),
});

describe("installation", () => {
  // Why: Graph's cache moved to the store, so setup stopped writing a cache path; repositories set
  // up before that must keep answering queries until setup is run again, and a current file must
  // not carry the old path.
  test("an earlier installation naming a cache stays readable; a schema 3 record may not name it", async () => {
    for (const schemaVersion of [1, 2]) {
      const owner = await repositoryWith((owner) => ({
        schemaVersion,
        ...binaries(owner),
        cacheDirectory: join(owner, "neuve/cache/graph"),
      }));
      expect(await readInstallation(owner)).toEqual({
        schemaVersion: 4,
        ...binaries(owner),
      });
    }
    const current = await repositoryWith((owner) => ({
      schemaVersion: 3,
      ...binaries(owner),
    }));
    expect(await readInstallation(current)).toEqual({
      schemaVersion: 4,
      ...binaries(current),
    });
    const naming = await repositoryWith((owner) => ({
      schemaVersion: 3,
      ...binaries(owner),
      cacheDirectory: join(owner, "neuve/cache/graph"),
    }));
    // Not Neuve's record, so not setup: a project's own neuve/ folder never stops setup either.
    expect(await readInstallation(naming)).toBeUndefined();
  });
});
