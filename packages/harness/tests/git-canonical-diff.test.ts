// Why: the same object pair must give preparation and review identical hunks under any local config.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { diffTrees } from "../src/git-objects.ts";

test("tree diffs ignore local drivers, attributes and presentation settings", async () => {
  const repository = mkdtempSync(join(tmpdir(), "canonical-diff-"));
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    const body = (value: number) =>
      `class Foo:\n    x = ${value}\n\n    def bar(self):\n` +
      Array.from({ length: 20 }, (_, i) => `        line${i} = ${i}\n`).join(
        "",
      ) +
      `        return ${value}\n`;
    writeFileSync(join(repository, ".gitattributes"), "*.py diff=python\n");
    writeFileSync(join(repository, "a.py"), body(1));
    writeFileSync(join(repository, "spaces"), "keep\nspace \n");
    writeFileSync(join(repository, "binary"), "before\0\n");
    writeFileSync(join(repository, "old-name"), "renamed content\n");
    git("add", ".");
    const base = git("write-tree");
    writeFileSync(join(repository, "a.py"), body(2));
    writeFileSync(join(repository, "spaces"), "keep\nspace  \n");
    writeFileSync(join(repository, "binary"), "after\0\n");
    git("mv", "old-name", "new-name");
    git("add", ".");
    const head = git("write-tree");
    const expected = await Effect.runPromise(diffTrees(repository, base, head));
    expect(
      expected.find((file) => file.newPath === "a.py")?.hunks,
    ).toHaveLength(2);
    expect(
      expected.find((file) => file.newPath === "spaces")?.hunks[0]?.added,
    ).toBe(1);
    expect(expected.find((file) => file.newPath === "binary")?.binary).toBe(
      true,
    );
    expect(expected.find((file) => file.newPath === "new-name")?.status).toBe(
      "renamed",
    );
    const settings = {
      "diff.algorithm": "histogram",
      "diff.indentHeuristic": "false",
      "diff.renames": "copies",
      "diff.renameLimit": "1",
      "diff.context": "20",
      "diff.interHunkContext": "100",
      "diff.suppressBlankEmpty": "true",
      "diff.noPrefix": "true",
      "diff.mnemonicPrefix": "true",
      "diff.srcPrefix": "old/",
      "diff.dstPrefix": "new/",
      "diff.relative": "true",
      "diff.submodule": "diff",
      "diff.ignoreSubmodules": "all",
      "diff.python.binary": "true",
      "diff.python.xfuncname": "^OVERRIDDEN",
      "diff.python.algorithm": "histogram",
      "core.bigFileThreshold": "1",
      "core.whitespace": "blank-at-eol,blank-at-eof,space-before-tab",
      "core.quotePath": "false",
    };
    for (const [key, value] of Object.entries(settings))
      git("config", key, value);
    writeFileSync(join(repository, ".git/info/attributes"), "* -diff\n");
    const global = join(repository, "global-config");
    writeFileSync(global, "[diff]\nalgorithm = minimal\ncontext = 100\n");
    process.env.GIT_CONFIG_GLOBAL = global;
    const actual = await Effect.runPromise(diffTrees(repository, base, head));
    expect(actual).toEqual(expected);
    // Target-tree attributes still apply, including a built-in driver's function headers.
    expect(
      actual.find((file) => file.newPath === "a.py")?.hunks[1]?.text,
    ).toContain("def bar(self):");
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    rmSync(repository, { recursive: true, force: true });
  }
});
