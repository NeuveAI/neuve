// Why: the release workflow ships install.sh stamped with the release's version, as bun run release
// does, so the installer installs its own release by default and release --from accepts the folder.
import { afterAll, expect, test } from "bun:test";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stampInstaller } from "../../scripts/release/release.ts";
import { stampFolder } from "../../scripts/release/stamp.ts";
import {
  ASSET,
  removeAllScratch,
  scratchDirectory,
  tinyRelease,
} from "./release-fixture.ts";

afterAll(removeAllScratch, 60_000);

test("stamps install.sh with the version the folder's archives hold", async () => {
  const release = await tinyRelease("0.4.0");
  const folder = await scratchDirectory("neuve-stamp-");
  await copyFile(release.archive, join(folder, ASSET));
  expect(await stampFolder(folder)).toBe("0.4.0");
  const script = await readFile(
    resolve(import.meta.dir, "../../scripts/install.sh"),
    "utf8",
  );
  const stamped = await readFile(join(folder, "install.sh"), "utf8");
  expect(stamped).toBe(stampInstaller(script, "0.4.0"));
  expect(stamped).toContain("\nshipped_version=0.4.0\n");
});

test("refuses a folder with no release archive, and writes nothing", async () => {
  const folder = await scratchDirectory("neuve-stamp-empty-");
  await expect(stampFolder(folder)).rejects.toThrow("has no release archives");
  expect(await readdir(folder)).toEqual([]);
});
