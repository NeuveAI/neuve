import { describe, expect, test } from "bun:test";
import {
  ArchiveRefused,
  bareRepositoryHeads,
  gunzipBounded,
  isGitComponent,
  readTar,
} from "../src/stack/index.ts";
import { tarGz, type TarEntry } from "./fixtures/stack/archives.ts";

/**
 * Why: an inner-loop agent may run its own tools inside the extracted folders, so a planted
 * `.git/config` (with `core.fsmonitor`) would run a command on `git status`, and a link or a case
 * collision could write outside the folder or overwrite another file on a case-insensitive disk
 * (SC7). None of these would make anything fail visibly: the folder would just contain them.
 */

const limits = { maxBytes: 1024 * 1024, maxEntries: 1_000 };

const read = async (entries: ReadonlyArray<TarEntry>, bounds = limits) =>
  readTar(await gunzipBounded(tarGz(entries), bounds), bounds);

const refusal = async (entries: ReadonlyArray<TarEntry>, bounds = limits) => {
  try {
    await read(entries, bounds);
  } catch (error) {
    if (error instanceof ArchiveRefused) return error.reason;
    throw error;
  }
  return undefined;
};

describe("stack archive extraction", () => {
  test("keeps a package's files under its top folder, byte for byte", async () => {
    const files = await read([
      { path: "package/", type: "5" },
      { path: "package/package.json", content: '{"name":"a"}' },
      { path: "package/src/index.ts", content: "export const a = 1;\r\n" },
    ]);
    expect(files.map((file) => file.path)).toEqual([
      "package.json",
      "src/index.ts",
    ]);
    expect(new TextDecoder().decode(files[1]?.bytes)).toBe(
      "export const a = 1;\r\n",
    );
  });

  test("refuses every component git would treat as .git", async () => {
    for (const path of [
      "package/.git/config",
      "package/.GIT/config",
      "package/sub/.Git/hooks/x",
      "package/.git./config",
      "package/.git /config",
      "package/git~1/config",
      "package/.g\u200cit/config",
      "package/.git",
    ])
      expect(
        await refusal([
          { path, content: "[core]\n\tfsmonitor = touch /tmp/pwned\n" },
        ]),
      ).toBe("path");
    expect(isGitComponent(".gitignore")).toBe(false);
    expect(isGitComponent(".github")).toBe(false);
  });

  test("refuses links, devices, parent and absolute paths", async () => {
    expect(
      await refusal([
        { path: "package/a", type: "2", linkname: "/etc/passwd" },
      ]),
    ).toBe("link-or-device");
    expect(
      await refusal([{ path: "package/a", type: "1", linkname: "package/b" }]),
    ).toBe("link-or-device");
    expect(await refusal([{ path: "package/dev", type: "3" }])).toBe(
      "link-or-device",
    );
    expect(
      await refusal([{ path: "package/../../evil.sh", content: "x" }]),
    ).toBe("path");
    expect(await refusal([{ path: "/etc/evil", content: "x" }])).toBe("path");
    expect(await refusal([{ path: "package/a\\b", content: "x" }])).toBe(
      "path",
    );
  });

  test("refuses paths that collide under case folding or Unicode normalisation", async () => {
    expect(
      await refusal([
        { path: "package/README.md", content: "a" },
        { path: "package/readme.md", content: "b" },
      ]),
    ).toBe("collision");
    expect(
      await refusal([
        { path: "package/caf\u00e9.txt", content: "a" },
        { path: "package/cafe\u0301.txt", content: "b" },
      ]),
    ).toBe("collision");
    expect(
      await refusal([
        { path: "package/lib", content: "a file" },
        { path: "package/lib/index.js", content: "b" },
      ]),
    ).toBe("collision");
  });

  test("folds names as the default macOS disk does: full case folding, any normalisation", async () => {
    for (const [a, b] of [
      ["stra\u00dfe.md", "strasse.md"],
      ["\u03c2.txt", "\u03c3.txt"],
      ["\u212b.txt", "\u00e5.txt"],
    ])
      expect(
        await refusal([
          { path: `package/${a}`, content: "a" },
          { path: `package/${b}`, content: "b" },
        ]),
      ).toBe("collision");
  });

  test("reads a path prefix only from POSIX ustar headers, never from old GNU ones", async () => {
    const archive = tarGz([{ path: "package/a.txt", content: "x" }]);
    const tar = new Uint8Array(await gunzipBounded(archive, limits));
    // Old GNU magic, with bytes where POSIX keeps its prefix (old GNU keeps times there).
    tar.set(new TextEncoder().encode("ustar  \0"), 257);
    tar.set(new TextEncoder().encode("../../evil"), 345);
    let sum = 0;
    for (let i = 0; i < 512; i++)
      sum += i >= 148 && i < 156 ? 32 : (tar[i] ?? 0);
    tar.set(
      new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `),
      148,
    );
    expect(readTar(tar, limits).map((file) => file.path)).toEqual(["a.txt"]);
  });

  test("leaves out the HEAD of any folder git would take for a bare repository", () => {
    const heads = bareRepositoryHeads([
      "HEAD",
      "objects/x",
      "refs/heads/main",
      "test/fixture.git/head",
      "test/fixture.git/Refs/x",
      "other/HEAD",
      "worktree/HEAD",
      "worktree/commondir",
      "docs/HEAD.md",
    ]);
    expect([...heads].sort()).toEqual([
      "HEAD",
      "test/fixture.git/head",
      "worktree/HEAD",
    ]);
  });

  test("refuses an archive over its byte or entry cap, and one outside its top folder", async () => {
    expect(
      await refusal([{ path: "package/big", content: "x".repeat(2048) }], {
        maxBytes: 1024,
        maxEntries: 10,
      }),
    ).toBe("over-cap");
    expect(
      await refusal(
        Array.from({ length: 5 }, (_, n) => ({
          path: `package/f${n}`,
          content: "x",
        })),
        { maxBytes: 1024, maxEntries: 4 },
      ),
    ).toBe("too-many-entries");
    expect(
      await refusal([
        { path: "package/a", content: "x" },
        { path: "other/b", content: "y" },
      ]),
    ).toBe("path");
  });
});
