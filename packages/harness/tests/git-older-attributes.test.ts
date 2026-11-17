// Why: a full-clone review on stock macOS Git must read revision attributes without Git 2.42.
import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  realpath,
  rm,
  chmod,
  mkdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

for (const differentOwner of [false, true]) {
  test(`full-clone review reads target attributes without Git 2.42, ${differentOwner ? "globally approved owner" : "native owner"}`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "neuve-old-attributes-")),
    );
    roots.push(root);
    const repository = join(root, "repo");
    await mkdir(repository);
    const hostGit = Bun.which("git");
    if (hostGit === null) throw new Error("Git unavailable");
    const git = (...args: string[]) => {
      const child = Bun.spawnSync([
        hostGit,
        "-C",
        repository,
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ]);
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      return child.stdout.toString().trim();
    };
    git("init", "-q");
    const commit = () => {
      git("add", ".");
      git(
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      return git("rev-parse", "HEAD");
    };
    const body = (value: number) =>
      `class Foo:\n    x = 0\n\n    def bar(self):\n        a = 1\n        b = 2\n        c = 3\n        d = 4\n        return ${value}\n`;
    await Bun.write(join(repository, "a.py"), body(1));
    const base = commit();
    await Bun.write(join(repository, "a.py"), body(2));
    await Bun.write(
      join(repository, ".gitattributes"),
      "*.py diff=python linguist-generated=true\n",
    );
    const head = commit();
    await Bun.write(
      join(repository, ".gitattributes"),
      "*.py -diff -linguist-generated\n",
    );
    const index = await readFile(join(repository, ".git/index"));
    const tools = join(root, "tools");
    await mkdir(tools);
    const wrapper = join(tools, "git");
    await Bun.write(
      wrapper,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (${differentOwner} && (args.includes(${JSON.stringify(repository)}) || args.includes(${JSON.stringify("--git-dir=" + join(repository, ".git"))}))) process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
if (args.includes("--no-lazy-fetch") || args.some(arg => arg.startsWith("--attr-source=") || arg.startsWith("--source="))) {
  console.error("unknown option: " + args.find(arg => arg.startsWith("--")));
  process.exit(129);
}
if (args.at(-1) === "version") { console.log("git version 2.39.5 (Apple Git-154)"); process.exit(0); }
delete process.env.GIT_NO_LAZY_FETCH;
process.exit(Bun.spawnSync([${JSON.stringify(hostGit)}, ...args], { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode);
`,
    );
    await chmod(wrapper, 0o755);
    const global = join(root, "global-config");
    await Bun.write(global, `[safe]\n\tdirectory = ${repository}\n`);
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    import { Effect } from "effect";
    import { diffTrees, lsTree } from "./src/git-objects.ts";
    import { readDeclarations } from "./src/declarations.ts";
    import { readCommitAttributes } from "./src/linguist-lists.ts";
    import { gitWithInput } from "./src/git.ts";
    import { withGitReadSnapshot } from "./src/git-read-snapshot.ts";
    const repository = ${JSON.stringify(repository)}, head = ${JSON.stringify(head)};
    const result = await Effect.runPromise(withGitReadSnapshot(repository, 1048576)(Effect.gen(function* () {
      const diff = yield* diffTrees(repository, ${JSON.stringify(base)}, head);
      const declarations = yield* readDeclarations({ repository, revision: head, tree: yield* lsTree(repository, head), paths: ["a.py"] });
      const attributes = yield* readCommitAttributes(repository, head, ["a.py"]);
      const batch = yield* gitWithInput(repository, ["check-attr", "--source=" + head, "-z", "--stdin", "linguist-generated"], "a.py\\0".repeat(20000));
      return { file: diff.find(file => file.newPath === "a.py"), declarations, attributes: attributes.values.get("a.py"), batchCorrect: batch === "a.py\\0linguist-generated\\0true\\0".repeat(20000) };
    })));
    console.log(JSON.stringify(result, (_key, value) => value instanceof Map ? Object.fromEntries(value) : value));
  `,
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          GIT_CONFIG_GLOBAL: global,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.batchCorrect).toBe(true);
    expect(result.file.binary).toBe(false);
    expect(result.file.hunks[0].text).toContain("@@ -6,4 +6,4 @@ class Foo:");
    expect(result.file.hunks[0].text).toContain(
      "-        return 1\n+        return 2\n",
    );
    expect(result.attributes["linguist-generated"]).toEqual({
      state: "value",
      value: "true",
    });
    expect(result.declarations.byPath["a.py"]).toContainEqual({
      kind: "generated",
      by: "gitattributes: linguist-generated=true",
    });
    expect(result.attributes.diff).toEqual({ state: "value", value: "python" });
    expect(await readFile(join(repository, ".git/index"))).toEqual(index);
    expect(await Bun.file(join(repository, ".gitattributes")).text()).toBe(
      "*.py -diff -linguist-generated\n",
    );
  });
}
