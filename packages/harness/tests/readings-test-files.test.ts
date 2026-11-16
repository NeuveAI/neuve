// Why (NEU-148 readers, round 13): a reading's evidence decision tells a caller's file test,
// not-test or undecided (`testFilesOf`, `pi/stages/reading-task.ts`), and only a not-test caller's
// row may lift the missing-caller gap. Before this round the decision read the declarations with the
// package manifests as the only tree entries, so no `bunfig.toml` and no `./tests` root was ever
// seen and most of this repository's test files were not tests: a test file's call could lift.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  BUN_TEST_FILE,
  readDeclarations,
  testStatusOf,
} from "../src/declarations.ts";
import { lsTree } from "../src/git-objects.ts";
import { headTestFilesOf } from "./fixtures/head-test-files.ts";

// The integration commit that landed as main on 13 November (batch 4), as the sections lane's own
// count of this repository pins it (`declarations-undecided.test.ts`).
const PINNED = "0af3643b1317fd76c7b796d91d2ac0e07da3b5b2";
const enclosing = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
  cwd: import.meta.dir,
});
const repository = enclosing.stdout.toString().trim();
const pinnedPresent =
  enclosing.exitCode === 0 &&
  Bun.spawnSync([
    "git",
    "-C",
    repository,
    "cat-file",
    "-e",
    `${PINNED}^{commit}`,
  ]).exitCode === 0;

// Reason: the 127-versus-712 defect would let a test file's call lift. On this repository's own
// head tree the decision's read must count its harness tests as tests, and the sections lane's
// counts (710 tests, 22 undecided, none not-test among the 732 test-named files) must be what it
// gives; the manifests-only read it replaces declares 127.
test.skipIf(!pinnedPresent)(
  "testFilesOf on this repository's head tree counts its harness tests as tests",
  async () => {
    const { entries, files } = await headTestFilesOf(repository, PINNED);
    const blobs = entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
    const named = blobs.filter((path) =>
      BUN_TEST_FILE.test(path.split("/").at(-1) ?? ""),
    );
    expect(named.length).toBe(732);
    const status = { test: 0, "not-test": 0, undecided: 0 };
    for (const path of named)
      status[
        files.tests.has(path)
          ? "test"
          : files.undecided.has(path)
            ? "undecided"
            : "not-test"
      ]++;
    expect(status).toEqual({ test: 710, "not-test": 0, undecided: 22 });
    // Every harness test file is a test.
    const harness = named.filter((path) =>
      path.startsWith("packages/harness/tests/"),
    );
    expect(harness.length).toBeGreaterThan(0);
    expect(harness.filter((path) => !files.tests.has(path))).toEqual([]);
    // Nothing is both, and a file that is not test-named is never a test here.
    expect(
      [...files.tests].filter((path) => files.undecided.has(path)),
    ).toEqual([]);
    // The read it replaces: the package manifests as the only tree entries.
    const manifestsOnly = await Effect.runPromise(
      readDeclarations({
        repository,
        revision: PINNED,
        tree: entries.filter(
          (entry) =>
            entry.type === "blob" &&
            entry.path.split("/").at(-1) === "package.json",
        ),
        paths: blobs,
        markers: false,
      }),
    );
    const before = named.filter(
      (path) => testStatusOf(manifestsOnly, path) === "test",
    );
    // 127 of the 732: the defect.
    expect(before.length).toBe(127);
    expect(
      harness.filter((path) => !before.includes(path)).length,
    ).toBeGreaterThan(0);
  },
  120_000,
);
