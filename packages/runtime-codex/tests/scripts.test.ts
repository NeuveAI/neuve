import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPin } from "../scripts/generate.ts";
import { outputPath, programPath } from "../scripts/record.ts";

// The recorder's guards, checked as functions: nothing here starts a program.
describe("the recorder refuses what could leak or start the wrong program", () => {
  const folder = mkdtempSync(join(tmpdir(), "runtime-codex-record-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  // A bare or relative name would be looked up through PATH or the current folder.
  test("a program that is not an absolute path", () => {
    expect(() => programPath("codex")).toThrow(/absolute path/);
    expect(() => programPath("bin/codex")).toThrow(/absolute path/);
    expect(programPath("/opt/tool/bin/program")).toBe("/opt/tool/bin/program");
  });

  // An output inside any work tree, not only this checkout, is one `git add` from a commit.
  test("an output inside a Git work tree", () => {
    expect(() => outputPath(join(import.meta.dir, "recording.json"))).toThrow(
      /Git work tree/,
    );
    const other = join(folder, "other-repository");
    mkdirSync(join(other, "deep"), { recursive: true });
    writeFileSync(join(other, ".git"), "gitdir: elsewhere\n");
    expect(() => outputPath(join(other, "deep", "recording.json"))).toThrow(
      /Git work tree/,
    );
    expect(outputPath(join(folder, "recording.json"))).toBe(
      join(folder, "recording.json"),
    );
  });
});

// A tag can be moved to another commit: regenerating from it must not pass silently.
describe("the generator keeps to the commit it recorded", () => {
  const tag = "rust-v0.171.0-alpha.13";
  const commit = "581161ab41e643d942e1e1b5f561034060bf18e3";
  const tagObject = "e0fd22a0e4e047a795d4bfa2b135fd3e6356eef2";
  const moved = "1".repeat(40);
  const header = (kind: string, sha: string, at = tag) =>
    `// From OpenAI's Codex, ${at} (${kind} ${sha}),\n`;

  test("the committed types record the commit the tag resolves to", async () => {
    const methods = await Bun.file(
      new URL("../src/generated/methods.ts", import.meta.url),
    ).text();
    expect(methods.startsWith(header("commit", commit))).toBe(true);
    expect(() =>
      checkPin(methods, tag, { commit, tagObject }, false),
    ).not.toThrow();
  });

  test("a moved tag is refused unless repinned", () => {
    expect(() =>
      checkPin(
        header("commit", commit),
        tag,
        { commit: moved, tagObject },
        false,
      ),
    ).toThrow(/the tag moved/);
    expect(() =>
      checkPin(
        header("tag object", tagObject),
        tag,
        { commit, tagObject: moved },
        false,
      ),
    ).toThrow(/the tag moved/);
    expect(() =>
      checkPin(
        header("commit", commit),
        tag,
        { commit: moved, tagObject },
        true,
      ),
    ).not.toThrow();
  });

  test("a new tag or an empty folder is a deliberate update", () => {
    expect(() =>
      checkPin(
        header("commit", commit, "rust-v0.170.0"),
        tag,
        { commit: moved, tagObject },
        false,
      ),
    ).not.toThrow();
    expect(() =>
      checkPin(undefined, tag, { commit: moved, tagObject }, false),
    ).not.toThrow();
  });
});
