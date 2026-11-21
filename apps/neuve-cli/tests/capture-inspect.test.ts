// Why: a moved install leaves agent and Git hooks calling a program that is gone. Each hook discards
// its output and exits 0, so capture silently stops, and doctor used to say "set up". These cases
// build that in a scratch home and check that the read-only inspection doctor uses names it, that
// neuve setup hooks repairs it, and that a Git hook already as it should be is left unchanged.
import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCapture, runSetupHooks } from "../src/capture/setup-hooks.ts";

const scratches: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("a hook calling a program that is gone is a finding, and setup hooks repairs it", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-capture-inspect-")),
  );
  scratches.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const files = {
    "claude-code": join(root, "home/.claude/settings.json"),
    codex: join(root, "home/.codex/hooks.json"),
  } as const;
  const hookFiles = (harness: keyof typeof files) => files[harness];
  const install = async (name: string) => {
    const path = join(root, name, "bin/neuve");
    await mkdir(join(root, name, "bin"), { recursive: true });
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
    return path;
  };
  const setUp = (command: string) =>
    runSetupHooks(
      [
        "--repo",
        repo,
        "--agents",
        "claude-code",
        "--claude-settings",
        files["claude-code"],
        "--codex-hooks",
        files.codex,
        "--command",
        command,
        "--no-stack",
      ],
      { stackStore: join(root, "stack") },
    );

  expect(await inspectCapture(repo, hookFiles)).toEqual({
    configured: false,
    parts: [],
  });
  // A space in the path: the hook command quotes it, and the check reads it back.
  const old = await install("old copy");
  expect(await setUp(old)).toBe(0);
  expect(
    (await inspectCapture(repo, hookFiles))?.parts.every(
      (part) => part.state === "ok",
    ),
  ).toBe(true);

  // The install moves: every hook still calls the old path, and nothing says so.
  await rm(join(root, "old copy"), { recursive: true });
  const stale = (await inspectCapture(repo, hookFiles))?.parts ?? [];
  expect(
    stale.filter((part) => part.state === "update").map((part) => part.path),
  ).toEqual(
    expect.arrayContaining([
      files["claude-code"],
      join(repo, ".git/hooks/post-commit"),
    ]),
  );
  expect(
    stale.find((part) => part.path === files["claude-code"])?.why,
  ).toContain(`run ${old}, which isn't there or can't run`);

  // The person's hook file is theirs, shared by every repository: a repository with no capture
  // still sees the dead entries.
  const other = join(root, "other");
  await mkdir(other);
  Bun.spawnSync(["git", "init", "-q", other]);
  const elsewhere = await inspectCapture(other, hookFiles);
  expect(elsewhere?.configured).toBe(false);
  expect(elsewhere?.parts).toEqual([
    expect.objectContaining({ path: files["claude-code"], state: "update" }),
  ]);

  // setup hooks from the new install puts every part right, and the person's own entry stays.
  const settings = JSON.parse(await readFile(files["claude-code"], "utf8"));
  settings.hooks.Stop.push({
    matcher: "",
    hooks: [{ type: "command", command: "echo mine" }],
  });
  await writeFile(files["claude-code"], JSON.stringify(settings, null, 2));
  const current = await install("new");
  expect(await setUp(current)).toBe(0);
  expect(
    (await inspectCapture(repo, hookFiles))?.parts.every(
      (part) => part.state === "ok",
    ),
  ).toBe(true);
  expect(await readFile(files["claude-code"], "utf8")).toContain("echo mine");

  // A Git hook already as it should be is reported unchanged and not rewritten.
  const hook = join(repo, ".git/hooks/post-commit");
  const written = Bun.file(hook).lastModified;
  let said = "";
  const write = Bun.write;
  // Bun.write(Bun.stdout, …) is how setup hooks reports; read it without printing.
  (Bun as { write: typeof Bun.write }).write = (async (
    target: unknown,
    data: unknown,
  ) => {
    if (target === Bun.stdout) said += String(data);
    else return write(target as never, data as never);
    return 0;
  }) as typeof Bun.write;
  try {
    expect(await setUp(current)).toBe(0);
  } finally {
    (Bun as { write: typeof Bun.write }).write = write;
  }
  expect(said).toContain(`${hook}: unchanged`);
  expect(Bun.file(hook).lastModified).toBe(written);

  // The same text without its execute bit: Git skips it, so it needs an update and is rewritten.
  await chmod(hook, 0o644);
  expect(
    (await inspectCapture(repo, hookFiles))?.parts.find(
      (part) => part.path === hook,
    ),
  ).toMatchObject({
    state: "update",
    why: "it can't be executed, so Git skips it",
  });
  said = "";
  (Bun as { write: typeof Bun.write }).write = (async (
    target: unknown,
    data: unknown,
  ) => {
    if (target === Bun.stdout) said += String(data);
    else return write(target as never, data as never);
    return 0;
  }) as typeof Bun.write;
  try {
    expect(await setUp(current)).toBe(0);
  } finally {
    (Bun as { write: typeof Bun.write }).write = write;
  }
  expect(said).toContain(`${hook}: updated`);
  expect((await stat(hook)).mode & 0o100).not.toBe(0);
});

// Why: the check reads a command back from text; a word it can't read surely must never be
// reported as a program that is gone, and a source-run hook must be judged by the script it runs.
test("an entry Neuve can't read surely is unclear, never gone; a bun hook is judged by its script", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-capture-unclear-")),
  );
  scratches.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const settings = join(root, "settings.json");
  const hookFiles = (harness: string) =>
    harness === "claude-code" ? settings : join(root, "none.json");
  const entry = (line: string) =>
    `sh -c '${line.replaceAll("'", `'\\''`)} >/dev/null 2>&1; exit 0 # neuve-capture-hook'`;
  const write = (commands: string[]) =>
    writeFile(
      settings,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: commands.map((command) => ({ type: "command", command })),
            },
          ],
        },
      }),
    );
  const part = async () =>
    (await inspectCapture(repo, hookFiles))?.parts.find(
      (found) => found.path === settings,
    );
  for (const line of [
    "neuve hook claude-code stop",
    "./bin/neuve hook claude-code stop",
    `'/gone/it'\''s/neuve' hook claude-code stop`,
  ]) {
    await write([entry(line)]);
    expect(await part(), line).toMatchObject({ state: "unclear" });
  }
  await write([
    entry(
      `${process.execPath} --no-env-file /gone/neuve-hook.js claude-code stop`,
    ),
  ]);
  expect(await part()).toMatchObject({
    state: "update",
    why: expect.stringContaining("/gone/neuve-hook.js"),
  });
});
