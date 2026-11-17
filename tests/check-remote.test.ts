import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkedCommit,
  checkUploadPath,
  remotePlan,
  pinLocalCheckout,
  withPinnedLocalCheckout,
  sourceArchive,
  remoteReceiptPath,
  graphLocalPart,
} from "../scripts/check-remote.ts";
import { buildCheckedGraph } from "../scripts/check-graph.ts";
import {
  GRAPH_DEPENDENT_TESTS,
  graphTestArguments,
} from "../scripts/graph-dependent-tests.ts";
import { readReceipt } from "../apps/neuve-cli/src/install-source.ts";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "remote-check-"));
  folders.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  await writeFile(join(repo, "source.ts"), "export const value = 42;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture source");
  return { root, repo, commit: git(repo, "rev-parse", "HEAD") };
};

test("commit guard accepts a clean exact commit and refuses unknown or different commits", async () => {
  const { repo, commit } = await fixture();
  expect(await checkedCommit(repo, commit)).toBe(commit);
  await expect(checkedCommit(repo, "unknown-commit")).rejects.toThrow();
  await expect(checkedCommit(repo, "--help")).rejects.toThrow();
  git(repo, "commit", "-qm", "next", "--allow-empty");
  await expect(checkedCommit(repo, commit)).rejects.toThrow("same source");
});

test("commit guard refuses unstaged, staged and untracked changes", async () => {
  const { repo, commit } = await fixture();
  await writeFile(join(repo, "source.ts"), "changed\n");
  await expect(checkedCommit(repo, commit)).rejects.toThrow("dirty");
  git(repo, "add", ".");
  await expect(checkedCommit(repo, commit)).rejects.toThrow("dirty");
  git(repo, "reset", "--hard", "HEAD");
  await writeFile(join(repo, "untracked.txt"), "untracked\n");
  await expect(checkedCommit(repo, commit)).rejects.toThrow("dirty");
});

test("local parts pin the requested historical commit and restore the original branch", async () => {
  const { repo, commit } = await fixture();
  const branch = git(repo, "symbolic-ref", "--short", "HEAD");
  await writeFile(join(repo, "source.ts"), "export const value = 43;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "next source");
  const head = git(repo, "rev-parse", "HEAD");
  await writeFile(
    join(repo, ".git/hooks/post-checkout"),
    "#!/bin/sh\nprintf ran > .git/hook-marker\n",
    { mode: 0o755 },
  );
  const { restore } = await pinLocalCheckout(repo, commit, head);
  expect(git(repo, "rev-parse", "HEAD")).toBe(commit);
  expect(await Bun.file(join(repo, "source.ts")).text()).toBe(
    "export const value = 42;\n",
  );
  await restore();
  expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe(branch);
  expect(await Bun.file(join(repo, ".git/hook-marker")).exists()).toBe(false);
});

test("restoration refuses to overwrite work added during the local checks", async () => {
  const { repo, commit } = await fixture();
  git(repo, "commit", "-qm", "next", "--allow-empty");
  const { restore } = await pinLocalCheckout(
    repo,
    commit,
    git(repo, "rev-parse", "HEAD"),
  );
  await writeFile(join(repo, "source.ts"), "work in progress\n");
  await expect(restore()).rejects.toThrow("dirty");
  expect(await Bun.file(join(repo, "source.ts")).text()).toBe(
    "work in progress\n",
  );
  expect(git(repo, "rev-parse", "HEAD")).toBe(commit);
});

test("archive contains only commit objects, never ignored files or Git stores", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(repo, ".gitignore"), ".env\nnode_modules/\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-qm", "ignores");
  await writeFile(join(repo, ".env"), "fixture only\n");
  await mkdir(join(repo, ".claude"));
  await writeFile(join(repo, ".claude", "launch.json"), "{}\n");
  await writeFile(join(repo, ".npmrc"), "fixture only\n");
  git(repo, "add", ".claude", ".npmrc");
  git(repo, "commit", "-qm", "project metadata excluded from upload");
  await mkdir(join(repo, "validation/evidence"), { recursive: true });
  await writeFile(
    join(repo, "validation/evidence/raw-evidence.tar.gz"),
    "excluded fixture archive\n",
  );
  git(repo, "add", "validation");
  git(repo, "commit", "-qm", "evidence is not source");
  await mkdir(join(repo, ".agents/skills/reviewer"), { recursive: true });
  await writeFile(
    join(repo, ".agents/skills/reviewer/SKILL.md"),
    "runtime prompt\n",
  );
  await mkdir(join(repo, "design/neuve-web/design-export"), {
    recursive: true,
  });
  await writeFile(
    join(repo, "design/neuve-web/design-export/tokens.css"),
    "/* source tokens */\n",
  );
  git(repo, "add", ".agents", "design");
  git(repo, "commit", "-qm", "runtime source assets");
  await mkdir(join(repo, "node_modules"));
  await writeFile(join(repo, "node_modules", "fixture"), "not source\n");
  await mkdir(join(repo, ".git", "neuve"));
  await writeFile(join(repo, ".git", "neuve", "fixture"), "not source\n");
  const archive = join(root, "source.tar.gz");
  await sourceArchive(repo, git(repo, "rev-parse", "HEAD"), archive);
  const listed = Bun.spawnSync(["tar", "-tzf", archive]);
  expect(listed.exitCode).toBe(0);
  const names = listed.stdout.toString().trim().split("\n");
  expect(names.filter((name) => !name.endsWith("/")).sort()).toEqual([
    ".agents/skills/reviewer/SKILL.md",
    ".gitignore",
    "design/neuve-web/design-export/tokens.css",
    "source.ts",
  ]);
  const content = Bun.spawnSync(["tar", "-xOzf", archive, "source.ts"]);
  expect(content.stdout.toString()).toBe("export const value = 42;\n");
});

test("historical uploads keep their inputs and targets with a cut list omit private inputs", async () => {
  const { root, repo } = await fixture();
  const inputs = [
    "research/pr-bench/replay/modal/capture_diagnostic.py",
    "validation/review-quality/fixture.json",
    "validation/external/neuve-effect/manifest.yaml",
    "validation/benchmarks/m4/labelling/dev/fixture.json",
    "validation/benchmarks/m4/results/dev/score.dev.json",
    "validation/benchmarks/m4/results/harness-compare/sticky-leads/sol/spend.json",
  ];
  const keptFixture =
    "packages/evaluation/tests/fixtures/frozen-dev-choices.json";
  for (const path of [...inputs, keptFixture]) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), "{}\n");
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "historical test inputs");
  const historical = git(repo, "rev-parse", "HEAD");
  await mkdir(join(repo, "scripts/release"), { recursive: true });
  await writeFile(
    join(repo, "scripts/release/public-cut.exclude"),
    "research/pr-bench/replay/\nvalidation/\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "public cut policy");
  for (const [commit, expected, archive] of [
    [historical, ["source.ts", keptFixture, ...inputs], "historical.tar.gz"],
    [
      git(repo, "rev-parse", "HEAD"),
      ["source.ts", keptFixture, "scripts/release/public-cut.exclude"],
      "public.tar.gz",
    ],
  ] satisfies [string, string[], string][]) {
    const path = join(root, archive);
    expect((await sourceArchive(repo, commit, path)).sort()).toEqual(
      expected.sort(),
    );
    const listed = Bun.spawnSync(["tar", "-tzf", path]);
    expect(listed.exitCode).toBe(0);
    expect(
      listed.stdout
        .toString()
        .trim()
        .split("\n")
        .filter((name) => !name.endsWith("/"))
        .sort(),
    ).toEqual(expected.sort());
  }
});

for (const filename of [".env.production", ".envrc", ".dev.vars"])
  test(`tracked ${filename} refuses the whole upload`, async () => {
    const { root, repo } = await fixture();
    await writeFile(join(repo, filename), "fixture only\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "unsafe filename");
    const archive = join(root, "source.tar.gz");
    await expect(
      sourceArchive(repo, git(repo, "rev-parse", "HEAD"), archive),
    ).rejects.toThrow("upload path");
    expect(await Bun.file(archive).exists()).toBe(false);
  });

test("upload paths refuse homes, stores, credentials, caches and escaping links", () => {
  for (const path of [
    ".git/neuve/store.sqlite",
    "home/user/file",
    ".local/bin/neuve",
    ".ssh/id_rsa",
    "a/.env",
    "a/.env.example",
    "node_modules/cache",
    ".cache/data",
    "credentials.json",
    "source/secrets.yaml",
    "source/auth.toml",
    "source/credentials.ini",
    "source/key.pem",
    "source/key.key",
    ".ssh/id_ecdsa",
    ".envrc",
    ".dev.vars",
    ".dev.vars.production",
    "../outside",
    "/outside",
    "a/../outside",
    "a\\outside",
  ])
    expect(() => checkUploadPath(path)).toThrow();
  for (const target of [
    "/Users/owner",
    "../../outside",
    ".git/neuve",
    ".env",
    "../outside",
  ])
    expect(() => checkUploadPath("link", target)).toThrow();
  expect(() => checkUploadPath("tests/fixture.ts")).not.toThrow();
  expect(() =>
    checkUploadPath("apps/desktop/scripts/credentials.ts"),
  ).not.toThrow();
  expect(() =>
    checkUploadPath("validation/latest", "runs/selected"),
  ).not.toThrow();
});

test("archive rejects an escaping symlink without following it", async () => {
  const { root, repo } = await fixture();
  await symlink("/outside", join(repo, "link"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "link");
  await expect(
    sourceArchive(
      repo,
      git(repo, "rev-parse", "HEAD"),
      join(root, "source.tar.gz"),
    ),
  ).rejects.toThrow("upload link");
});

test("archive refuses internal links too, so chained links cannot escape the selection", async () => {
  const { root, repo } = await fixture();
  await symlink("source.ts", join(repo, "alias"));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "source alias");
  await expect(
    sourceArchive(
      repo,
      git(repo, "rev-parse", "HEAD"),
      join(root, "source.tar.gz"),
    ),
  ).rejects.toThrow("upload link");
});

test("archive refuses export attributes that could change source bytes", async () => {
  const { root, repo } = await fixture();
  await writeFile(join(repo, ".gitattributes"), "source.ts export-ignore\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "archive filtering");
  await expect(
    sourceArchive(
      repo,
      git(repo, "rev-parse", "HEAD"),
      join(root, "source.tar.gz"),
    ),
  ).rejects.toThrow("export attributes");
});

test("a remote receipt never satisfies the existing install receipt reader", async () => {
  const { root, commit } = await fixture();
  await writeFile(
    remoteReceiptPath(root, commit),
    JSON.stringify({
      version: 1,
      kind: "remote",
      installEligible: false,
      commit,
      passed: true,
    }),
  );
  expect(await readReceipt(root, commit)).toBe(
    `no passing \`bun run check\` recorded for ${commit.slice(0, 10)}`,
  );
  expect(await Bun.file(join(root, `${commit}.json`)).exists()).toBe(false);
});

test("an empty source selection cannot fall back to archiving the entire tree", async () => {
  const { root, repo } = await fixture();
  await rm(join(repo, "source.ts"));
  await mkdir(join(repo, "design"));
  await writeFile(join(repo, "design/fixture.txt"), "not test source\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "no source");
  await expect(
    sourceArchive(
      repo,
      git(repo, "rev-parse", "HEAD"),
      join(root, "source.tar.gz"),
    ),
  ).rejects.toThrow("No tracked source");
});

test("package names cannot become paths outside the result directory", async () => {
  const { repo } = await fixture();
  await mkdir(join(repo, "apps/fixture"), { recursive: true });
  await writeFile(
    join(repo, "apps/fixture/package.json"),
    JSON.stringify({
      name: "@neuve/../../outside",
      scripts: { test: "bun test" },
    }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "invalid package name");
  await expect(
    remotePlan(repo, git(repo, "rev-parse", "HEAD")),
  ).rejects.toThrow();
});

// These names must be assigned to one local part without dropping the other CLI cases.
test("the remote plan excludes exactly the Graph cases and the local part selects them", async () => {
  const { repo } = await fixture();
  for (const [cwd, name] of [
    ["apps/neuve-cli", "@neuve/cli"],
    ["packages/harness", "@neuve/harness"],
    ["packages/evaluation", "@neuve/evaluation"],
    ["packages/records-core", "@neuve/records-core"],
  ] satisfies [string, string][]) {
    await mkdir(join(repo, cwd), { recursive: true });
    await writeFile(
      join(repo, cwd, "package.json"),
      JSON.stringify({
        name,
        scripts: {
          test: "bun ../../scripts/test-budget.ts ./tests",
          typecheck: "tsc --noEmit",
        },
      }),
    );
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "test packages");
  const plan = await remotePlan(repo, git(repo, "rev-parse", "HEAD"));
  const pattern = (id: string) => {
    const command = plan.find((part) => part.id === id)?.command;
    const index = command?.indexOf("--test-name-pattern");
    const text = index === undefined ? undefined : command?.[index + 1];
    if (text === undefined) throw new Error(`Missing exclusion for ${id}`);
    return new RegExp(text);
  };
  const withGraph = await remotePlan(repo, git(repo, "rev-parse", "HEAD"), {
    graph: true,
  });
  for (const entry of GRAPH_DEPENDENT_TESTS) {
    const part = withGraph.find(
      (part) => part.cwd === entry.cwd && part.id.startsWith("test-"),
    );
    if (part === undefined)
      throw new Error(`Missing test part for ${entry.cwd}`);
    const at = part.command.indexOf("--test-name-pattern");
    const selection = at === -1 ? undefined : part.command[at + 1];
    const included = selection === undefined ? /.*/ : new RegExp(selection);
    for (const name of entry.names) expect(included.test(name)).toBe(true);
  }
  const harness = pattern("test-neuve-harness");
  const cli = pattern("test-neuve-cli");
  const localArgs = graphTestArguments();
  expect(localArgs.slice(0, 4)).toEqual([
    "./packages/harness/tests/graph-fallback.test.ts",
    "./packages/harness/tests/graph-leads-at-commit.test.ts",
    "./packages/harness/tests/graph-declare.test.ts",
    "./apps/neuve-cli/tests/preparation-orphan.test.ts",
  ]);
  const localPattern = localArgs.at(-1);
  if (localPattern === undefined)
    throw new Error("Missing local Graph selection");
  const local = new RegExp(localPattern);
  for (const entry of GRAPH_DEPENDENT_TESTS) {
    const id =
      entry.cwd === "packages/harness"
        ? "test-neuve-harness"
        : entry.cwd === "packages/evaluation"
          ? "test-neuve-evaluation"
          : "test-neuve-cli";
    for (const name of entry.names) {
      expect(pattern(id).test(name)).toBe(false);
      expect(local.test(name)).toBe(true);
      expect(pattern(id).test(`${name} another case`)).toBe(true);
    }
  }
  expect(
    pattern("test-neuve-evaluation").test(
      "leads root interrupts its in-flight plan before publishing",
    ),
  ).toBe(true);
  expect(
    pattern("test-neuve-evaluation").test(
      "symbol-batch measurement requires an explicitly configured effect repository",
    ),
  ).toBe(true);

  for (const name of [
    "past the review's wait, Graph's leads and answers fall back, disclosed and counted, while Graph finishes and keeps them",
    "Graph's leads are searched at commit time with their timings and CPU, and the review finds them ready",
    "the worker declares the bases still needed, none that ended, and looks again after a failure",
  ]) {
    expect(harness.test(name)).toBe(false);
    expect(local.test(name)).toBe(true);
    expect(harness.test(`${name} another case`)).toBe(true);
  }
  for (const kind of ["prepare-code", "prepare-commit"]) {
    const name = `SIGKILL of ${kind} stops a real indexing engine and its group within five seconds`;
    expect(cli.test(name)).toBe(false);
    expect(local.test(name)).toBe(true);
  }
  for (const name of [
    "the instant grandchild oracle rejects a running process",
    "prepare-commit stops Graph's engine while its finalizer waits on a lock",
  ]) {
    expect(cli.test(name)).toBe(true);
    expect(local.test(name)).toBe(false);
  }
  expect(
    cli.test(
      "the worker this build starts loads neither the project's environment nor config",
    ),
  ).toBe(false);
  const core = pattern("test-neuve-records-core");
  for (const [id, names] of [
    [
      "test-neuve-cli",
      [
        "F1: two real foreground reviews await one acceptance after admission then follow on a closed store",
        "F1: failed startup closes both foreground waiters without successful readiness",
        "F1: detached review returns while its spawned worker has not opened Records",
        "worker run on corrupt Records exits nonzero with its database cause on stderr",
        ...[
          "locked",
          "reserved",
          "opening",
          "transaction",
          "accepted",
          "ready",
        ].flatMap((step) => [
          `worker status and stop at startup ${step}`,
          ...["SIGTERM", "SIGKILL"].map(
            (signal) =>
              `plain review recovers after ${signal} at startup ${step}`,
          ),
        ]),
      ],
    ],
    [
      "test-neuve-records-core",
      [
        "F2: main's unmarked claim refuses with absent marker table and no listener",
        "F2: main's unmarked claim refuses with empty marker table and no listener",
        "F2: changed read with absent marker and legacy listener refuses despite contender lock",
        "F2: changed read with empty marker and absent listener refuses despite contender lock",
        "F2: changed read can wake a status-confirmed accepted current claim",
        "F3: read-only legacy diagnosis preserves a 0400 lifetime file and creates nothing, long path",
        "readiness narrowing: real refused child does not acknowledge a legacy listener",
        "worker pre-bind peer writer: none legacy claim",
        "worker pre-bind peer writer: observed legacy claim",
        "worker pre-bind peer writer: late legacy claim",
        "worker pre-bind read propagates an I/O error and its original cause",
      ],
    ],
  ] satisfies Array<[string, string[]]>) {
    const command = plan.find((part) => part.id === id)?.command;
    expect(command).toContain("15000");
    for (const name of names)
      expect((id === "test-neuve-cli" ? cli : core).test(name)).toBe(true);
  }
  expect(graphLocalPart).toEqual({
    id: "local-graph",
    cwd: ".",
    command: [
      process.execPath,
      "--no-env-file",
      "scripts/check-graph.ts",
      "--test",
    ],
  });
  expect(
    plan.find((part) => part.id === "typecheck-neuve-cli")?.command,
  ).toEqual(["bun", "--no-env-file", "run", "typecheck"]);
});

test("historical gitlinks leave submodule files alone and restore the branch", async () => {
  const { root, repo } = await fixture();
  const sub = join(root, "sub");
  await mkdir(sub);
  git(sub, "init", "-q");
  await mkdir(join(sub, "cmd/entire-graph"), { recursive: true });
  await writeFile(join(sub, "go.mod"), "module fixture\n");
  await writeFile(join(sub, "cmd/entire-graph/main.go"), "package main\n");
  await writeFile(join(sub, "value"), "one");
  git(sub, "add", ".");
  git(sub, "commit", "-qm", "one");
  git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    sub,
    "apps/neuve-graph",
  );
  git(repo, "commit", "-qam", "first pointer");
  const target = git(repo, "rev-parse", "HEAD");
  const checkout = join(repo, "apps/neuve-graph");
  await writeFile(join(checkout, "value"), "two");
  git(checkout, "commit", "-qam", "two");
  const subHead = git(checkout, "rev-parse", "HEAD");
  git(repo, "commit", "-qam", "second pointer");
  const head = git(repo, "rev-parse", "HEAD");
  const branch = git(repo, "symbolic-ref", "--short", "HEAD");
  const pin = await pinLocalCheckout(repo, target, head);
  expect(git(repo, "status", "--porcelain")).toBe("M apps/neuve-graph");
  await expect(buildCheckedGraph(repo)).rejects.toThrow(
    "does not match HEAD's gitlink",
  );
  await expect(buildCheckedGraph(repo)).rejects.toThrow(
    "git submodule update --init --recursive -- apps/neuve-graph",
  );
  await pin.check();
  git(repo, "add", "apps/neuve-graph");
  await expect(pin.check()).rejects.toThrow();
  git(repo, "reset", target, "--", "apps/neuve-graph");
  await writeFile(join(checkout, "value"), "work in progress");
  await expect(pin.restore()).rejects.toThrow("Submodule changed");
  expect(await Bun.file(join(checkout, "value")).text()).toBe(
    "work in progress",
  );
  await writeFile(join(checkout, "value"), "two");
  expect(git(checkout, "rev-parse", "HEAD")).toBe(subHead);
  expect(await Bun.file(join(checkout, "value")).text()).toBe("two");
  await pin.restore();
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe(branch);
  expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(git(repo, "status", "--porcelain")).toBe("");
});

test("restoration errors preserve the completed checks and newly written work", async () => {
  const { repo, commit } = await fixture();
  git(repo, "commit", "-qm", "next", "--allow-empty");
  const outcome = await withPinnedLocalCheckout(
    repo,
    commit,
    git(repo, "rev-parse", "HEAD"),
    async () => {
      await writeFile(join(repo, "source.ts"), "new work");
      return { pass: 42, fail: 0 };
    },
  );
  expect(outcome.value).toEqual({ pass: 42, fail: 0 });
  expect(outcome.restorationError).toContain("dirty");
  expect(await Bun.file(join(repo, "source.ts")).text()).toBe("new work");
});

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)
  test(`${signal} stops the child and restores the caller branch without hooks`, async () => {
    const { root, repo, commit } = await fixture();
    git(repo, "commit", "-qm", "next", "--allow-empty");
    const head = git(repo, "rev-parse", "HEAD");
    const branch = git(repo, "symbolic-ref", "--short", "HEAD");
    await writeFile(
      join(repo, ".git/hooks/post-checkout"),
      "#!/bin/sh\nprintf ran > .git/hook-marker\n",
      { mode: 0o755 },
    );
    const ready = join(root, "ready");
    const stopped = join(root, "stopped");
    const childReady = join(root, "child-ready");
    const worker = join(root, "worker.ts");
    await writeFile(
      worker,
      `process.on("SIGTERM", async () => {
      const child = Bun.spawn(["git", "-C", ${JSON.stringify(repo)}, "rev-parse", "HEAD"], {stdout:"pipe"});
      await Bun.write(${JSON.stringify(stopped)}, await new Response(child.stdout).text());
      process.exit(0);
    }); await Bun.write(${JSON.stringify(childReady)}, "ready"); setInterval(() => {}, 1000);`,
    );
    const driver = join(root, "driver.ts");
    await writeFile(
      driver,
      `import { withPinnedLocalCheckout } from ${JSON.stringify(fileURLToPath(new URL("../scripts/check-remote.ts", import.meta.url)))};
      await withPinnedLocalCheckout(${JSON.stringify(repo)}, ${JSON.stringify(commit)}, ${JSON.stringify(head)}, async (checkout) => {
        const child = Bun.spawn([process.execPath, ${JSON.stringify(worker)}], {detached:true, stdout:"ignore", stderr:"inherit"});
        checkout.track(child);
        while (!(await Bun.file(${JSON.stringify(childReady)}).exists())) await Bun.sleep(10);
        await Bun.write(${JSON.stringify(ready)}, "ready");
        await child.exited;
      });`,
    );
    const process = Bun.spawn([Bun.which("bun") ?? "bun", driver], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      for (
        let tries = 0;
        tries < 200 && !(await Bun.file(ready).exists());
        tries++
      )
        await Bun.sleep(10);
      expect(await Bun.file(ready).exists()).toBe(true);
      process.kill(signal);
      expect(await process.exited).toBe(code);
      expect((await Bun.file(stopped).text()).trim()).toBe(commit);
      expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe(branch);
      expect(git(repo, "rev-parse", "HEAD")).toBe(head);
      expect(await Bun.file(join(repo, ".git/hook-marker")).exists()).toBe(
        false,
      );
    } finally {
      if (process.exitCode === null) process.kill("SIGKILL");
    }
  }, 10000);
