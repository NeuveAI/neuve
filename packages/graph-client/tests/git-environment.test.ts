// Old Git is simulated because the host Git supports the flag. Real repositories and missing
// partial-clone objects exercise both readers, including the boundary that must stay offline.
import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const fixture = async (partial: boolean, supported: boolean) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-host-git-")));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  const hostGit = Bun.which("git");
  if (!hostGit) throw new Error("Git unavailable");
  const git = (repository: string, ...args: string[]) => {
    const result = Bun.spawnSync([hostGit, "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git(source, "init", "-q");
  await Bun.write(join(source, "source.custom"), "offline content\n");
  git(source, "add", "source.custom");
  git(
    source,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qm",
    "first",
  );
  const oid = git(source, "rev-parse", "HEAD:source.custom");
  let repository = source;
  if (partial) {
    git(source, "config", "uploadpack.allowFilter", "true");
    repository = join(root, "partial");
    git(
      source,
      "clone",
      "--quiet",
      "--no-checkout",
      "--filter=blob:none",
      `file://${source}`,
      repository,
    );
  }
  const tools = join(root, "tools");
  await mkdir(tools);
  const log = join(root, "commands.jsonl");
  const wrapper = join(tools, "git");
  await Bun.write(
    wrapper,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const flag = args.includes("--no-lazy-fetch");
if (flag && !${supported}) { console.error("unknown option: --no-lazy-fetch"); process.exit(129); }
if (args.at(-1) === "version" || args.at(-1) === "--version") { console.log("git version 2.39.5 (Apple Git-154)"); process.exit(0); }
// A backport can support the flag without changing its version string.
const child = Bun.spawnSync([${JSON.stringify(hostGit)}, ...args], { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(child.exitCode);
`,
  );
  await chmod(wrapper, 0o755);
  const run = async (body: string) => {
    const child = Bun.spawn([process.execPath, "--eval", body], {
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    return stdout;
  };
  return { root, repository, oid, git, run, log };
};
const qualification = resolve(
  import.meta.dir,
  "../src/git-read-qualification.ts",
);
const session = resolve(import.meta.dir, "../src/git-read-session.ts");

for (const partial of [false, true])
  for (const supported of [false, true]) {
    test(`${partial ? "partial" : "full"} clone with ${supported ? "supported" : "old"} Git`, async () => {
      const f = await fixture(partial, supported);
      const stdout = await f.run(`
      import { preflightLocalGitRead, qualifyLocalGitRead, runQualifiedGit, assessLocalGitEnvironment } from ${JSON.stringify(qualification)};
      import { GitReadSession } from ${JSON.stringify(session)};
      const repository = ${JSON.stringify(f.repository)};
      console.log(JSON.stringify(await assessLocalGitEnvironment(repository)));
      try {
        const git = await qualifyLocalGitRead(await preflightLocalGitRead({ repository }));
        console.log(JSON.stringify(git.assessment));
        const commands = [];
        try { await runQualifiedGit(git, { kind: "object-type", oid: ${JSON.stringify(f.oid)} }, { onCommand: c => commands.push(c) }); }
        catch (error) { console.log(error.message); }
        console.log(JSON.stringify(commands.map(c => ({argv: c.argv, stderr: c.stderr}))));
      } catch (error) { console.log(error.message); }
      const reader = await GitReadSession.open(repository);
      try {
        console.log("prepared " + (await reader.prepare()).suppression);
        const blobs = await reader.blobs([${JSON.stringify(f.oid)}], undefined, new AbortController().signal);
        console.log(blobs.size);
      } catch (error) { console.log(error.message); }
      finally { await reader.close(); }
    `);
      const assessment = {
        gitVersion: "git version 2.39.5 (Apple Git-154)",
        supportsNoLazyFetch: supported,
        partialClone: partial,
      };
      expect(JSON.parse(stdout.split("\n")[0] ?? "")).toEqual(assessment);
      if (partial && !supported) {
        expect(
          stdout.match(/this repository is a partial clone/g),
        ).toHaveLength(2);
        expect(stdout).toContain(
          "Install Git 2.45 or later, for example with brew install git, or use a full clone.",
        );
        const commands = await readFile(f.log, "utf8");
        expect(commands).not.toContain("cat-file");
      } else {
        expect(JSON.parse(stdout.split("\n")[1] ?? "")).toEqual(assessment);
        expect(stdout).toContain(
          "prepared " + (partial ? "no-lazy-fetch-flag" : "none"),
        );
        if (partial) {
          expect(stdout).toContain(
            "Local Git read refused (command: git-read)",
          );
          expect(stdout).not.toContain("transport");
          expect(stdout).not.toContain("could not fetch");
          expect(stdout.trim().endsWith("0"), stdout).toBe(true);
        } else expect(stdout.trim().endsWith("1"), stdout).toBe(true);
        const commands: string[][] = (await readFile(f.log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const reads = commands.filter((args) => args.includes("cat-file"));
        expect(reads.length).toBeGreaterThan(0);
        for (const args of reads)
          expect(args.includes("--no-lazy-fetch")).toBe(partial);
      }
      if (partial) {
        // The clone still lacks the blob after qualification and session reads.
        const result = Bun.spawnSync([
          "git",
          "--no-lazy-fetch",
          "-C",
          f.repository,
          "cat-file",
          "-e",
          f.oid,
        ]);
        expect(result.exitCode).not.toBe(0);
      }
    });
  }

for (const { setting, values } of [
  { setting: "extensions.partialClone", values: ["origin"] },
  { setting: "remote.origin.promisor", values: ["true"] },
  { setting: "remote.origin.partialclonefilter", values: ["blob:none"] },
  // Git retains a promisor remote seen earlier even if a later entry says false.
  { setting: "remote.origin.promisor", values: ["true", "false"] },
]) {
  test(`detect ${setting}=${values.join(",")} before object reads`, async () => {
    const f = await fixture(false, false);
    for (const value of values)
      f.git(f.repository, "config", "--add", setting, value);
    const stdout = await f.run(`
      import { preflightLocalGitRead, qualifyLocalGitRead, assessLocalGitEnvironment } from ${JSON.stringify(qualification)};
      const repository = ${JSON.stringify(f.repository)};
      console.log(JSON.stringify(await assessLocalGitEnvironment(repository)));
      try { await qualifyLocalGitRead(await preflightLocalGitRead({ repository })); }
      catch (error) { console.log(error.message); }
    `);
    expect(JSON.parse(stdout.split("\n")[0] ?? "").partialClone).toBe(true);
    expect(stdout).toContain("this repository is a partial clone");
  });
}

// Why: Git accepts more numeric booleans than 0/1, and old Git must still explain a partial clone.
for (const supported of [false, true]) {
  test(`Git boolean forms with ${supported ? "supported" : "old"} Git`, async () => {
    const f = await fixture(false, supported);
    for (const [value, expected] of [
      ["2", true],
      ["-1", true],
      ["+2", true],
      ["0x2", true],
      ["010", true],
      ["1k", true],
      ["-2M", true],
      ["1G", true],
      ["-2147483648", true],
      ["2147483647", true],
      ["  +2", true],
      ["yes", true],
      ["ON", true],
      ["0", false],
      ["-0", false],
      ["+0", false],
      ["0x0", false],
      ["000", false],
      ["0g", false],
      ["", false],
      ["NO", false],
      ["off", false],
    ] as const) {
      f.git(f.repository, "config", "remote.origin.promisor", value);
      expect(
        f.git(f.repository, "config", "--bool", "remote.origin.promisor"),
      ).toBe(String(expected));
      const stdout = await f.run(`
        import { assessLocalGitEnvironment, preflightLocalGitRead, qualifyLocalGitRead } from ${JSON.stringify(qualification)};
        const repository = ${JSON.stringify(f.repository)};
        console.log(JSON.stringify(await assessLocalGitEnvironment(repository)));
        try { console.log(JSON.stringify((await qualifyLocalGitRead(await preflightLocalGitRead({ repository }))).assessment)); }
        catch (error) { console.log(error.message); }
      `);
      expect(JSON.parse(stdout.split("\n")[0] ?? "").partialClone, value).toBe(
        expected,
      );
      if (expected && !supported) {
        expect(stdout, value).toContain("git version 2.39.5");
        expect(stdout, value).toContain("this repository is a partial clone");
        expect(stdout, value).toContain("brew install git");
      } else
        expect(
          JSON.parse(stdout.split("\n")[1] ?? "").partialClone,
          value,
        ).toBe(expected);
    }
    for (const value of [
      "08",
      "0b1",
      "2z",
      "2147483648",
      "-2147483649",
      "2g",
      "1 ",
      "truthy",
      "true\n",
      "2\n",
    ]) {
      f.git(f.repository, "config", "remote.origin.promisor", value);
      const stdout = await f.run(`
        import { assessLocalGitEnvironment, preflightLocalGitRead } from ${JSON.stringify(qualification)};
        const repository = ${JSON.stringify(f.repository)};
        for (const inspect of [() => assessLocalGitEnvironment(repository), () => preflightLocalGitRead({ repository })]) {
          try { await inspect(); console.log("accepted"); }
          catch (error) { console.log(error.message); }
        }
      `);
      expect(stdout, value).not.toContain("accepted");
      expect(stdout.match(/unsupported-config: boolean/g), value).toHaveLength(
        2,
      );
    }
  }, 60000);
}

// Why: query source validation uses native Git outside GitReadSession and must obey the same policy.
test("native Graph source validation does not fetch a missing promisor blob", async () => {
  const f = await fixture(true, true);
  const commit = f.git(f.repository, "rev-parse", "HEAD");
  await f.run(`
    import { runGraphInspection } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
    import { fakeExecutable, request, removeRoots } from ${JSON.stringify(resolve(import.meta.dir, "graph-client-support.ts"))};
    const executable = await fakeExecutable("prepared-valid");
    try {
      await runGraphInspection({ ...request(executable, ${JSON.stringify(f.repository)}, ${JSON.stringify(commit)}, false), cache: "prepared" }, {
        cacheDirectory: ${JSON.stringify(join(f.root, "cache"))}, emit: async () => {},
      });
    } finally { await removeRoots(); }
  `);
  const commands: string[][] = (await readFile(f.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const reads = commands.filter(
    (args) => args.includes("cat-file") && args.includes("blob"),
  );
  expect(reads.length).toBeGreaterThan(0);
  for (const args of reads) expect(args).toContain("--no-lazy-fetch");
  expect(
    Bun.spawnSync([
      "git",
      "--no-lazy-fetch",
      "-C",
      f.repository,
      "cat-file",
      "-e",
      f.oid,
    ]).exitCode,
  ).not.toBe(0);
});
