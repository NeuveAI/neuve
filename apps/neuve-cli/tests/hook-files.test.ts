// Why: `setup hooks` writes files Neuve shares with the person (their agent's hook file, their Git
// hooks), and doctor reports on the same files. Both must read them through one judgement, so each
// row of the agreed table is checked here from both sides: what setup hooks does, and what the
// inspection doctor shows says, in the same words where Neuve refuses.
import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectCapture,
  runSetupHooks,
  type CapturePart,
} from "../src/capture/setup-hooks.ts";

const scratches: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratches
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A repository, a scratch hook file per agent, and setup hooks run with a fake install. */
const scene = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-hook-files-")),
  );
  scratches.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const settings = join(root, "home/.claude/settings.json");
  const codex = join(root, "home/.codex/hooks.json");
  const program = join(root, "install/bin/neuve");
  await mkdir(join(root, "install/bin"), { recursive: true });
  await writeFile(program, "#!/bin/sh\nexit 0\n");
  await chmod(program, 0o755);
  const hookFiles = (harness: string) =>
    harness === "claude-code" ? settings : codex;
  let said = "";
  const setUp = async () => {
    said = "";
    const write = Bun.write;
    (Bun as { write: typeof Bun.write }).write = (async (
      target: unknown,
      data: unknown,
    ) => {
      if (target === Bun.stdout) said += String(data);
      else return write(target as never, data as never);
      return 0;
    }) as typeof Bun.write;
    try {
      return await runSetupHooks(
        [
          "--repo",
          repo,
          "--agents",
          "claude-code",
          "--claude-settings",
          settings,
          "--codex-hooks",
          codex,
          "--command",
          program,
          "--no-stack",
        ],
        { stackStore: join(root, "stack") },
      );
    } finally {
      (Bun as { write: typeof Bun.write }).write = write;
    }
  };
  const part = async (path: string): Promise<CapturePart | undefined> =>
    (await inspectCapture(repo, hookFiles))?.parts.find(
      (found) => found.path === path,
    );
  return { root, repo, settings, program, setUp, said: () => said, part };
};

test("a command that isn't text is unreadable in both places, and the file is left as it is", async () => {
  const { settings, setUp, part } = await scene();
  const bad = '{"hooks":{"Stop":[{"hooks":[{"command":42}]}]}}';
  await mkdir(join(settings, ".."), { recursive: true });
  await writeFile(settings, bad);
  const found = await part(settings);
  expect(found).toMatchObject({ state: "unreadable" });
  await expect(setUp()).rejects.toThrow(found!.why!);
  expect(await readFile(settings, "utf8")).toBe(bad);
});

test("an empty file is read as one with nothing in it", async () => {
  const { settings, setUp, part } = await scene();
  await mkdir(join(settings, ".."), { recursive: true });
  await writeFile(settings, "  \n");
  expect(await part(settings)).toBeUndefined();
  expect(await setUp()).toBe(0);
  expect(await part(settings)).toMatchObject({ state: "ok" });
});

test("a missing event, a duplicate and a changed timeout each need an update, named", async () => {
  const { settings, setUp, part } = await scene();
  expect(await setUp()).toBe(0);
  const written = await readFile(settings, "utf8");
  const edit = async (change: (file: any) => void) => {
    const file = JSON.parse(written);
    change(file);
    await writeFile(settings, JSON.stringify(file));
    return (await part(settings))!;
  };
  expect(await edit((file) => delete file.hooks.SessionEnd)).toMatchObject({
    state: "update",
    why: expect.stringContaining("its SessionEnd hook is missing"),
  });
  expect(
    await edit((file) =>
      file.hooks.Stop.push(structuredClone(file.hooks.Stop[0])),
    ),
  ).toMatchObject({
    state: "update",
    why: expect.stringContaining("Stop has 2 Neuve hooks"),
  });
  expect(
    await edit((file) => (file.hooks.Stop[0].hooks[0].timeout = 60)),
  ).toMatchObject({
    state: "update",
    why: expect.stringContaining("type or timeout was changed"),
  });
  // setup hooks puts it right.
  expect(await setUp()).toBe(0);
  expect(await part(settings)).toMatchObject({ state: "ok" });
});

test("a person's own entries, a group without hooks and extra fields survive, and a reorder is said as one", async () => {
  const { settings, setUp, said, part } = await scene();
  expect(await setUp()).toBe(0);
  const file = JSON.parse(await readFile(settings, "utf8"));
  file.hooks.Stop.push({
    matcher: "Bash",
    hooks: [
      { type: "command", command: "echo mine", timeout: 3, label: "kept" },
    ],
    note: "a field Neuve doesn't use",
  });
  file.hooks.Stop.push({ matcher: "empty" });
  file.hooks.PreToolUse = [{ matcher: "x", hooks: [] }];
  await writeFile(settings, JSON.stringify(file, null, 2));
  expect(await part(settings)).toMatchObject({ state: "ok" });
  expect(await setUp()).toBe(0);
  expect(said()).toContain(
    "reordered: Neuve's claude-code hooks were already right",
  );
  expect(said()).not.toContain("added 6");
  const after = JSON.parse(await readFile(settings, "utf8"));
  expect(after.hooks.Stop).toContainEqual({
    matcher: "Bash",
    hooks: [
      { type: "command", command: "echo mine", timeout: 3, label: "kept" },
    ],
    note: "a field Neuve doesn't use",
  });
  expect(after.hooks.Stop).toContainEqual({ matcher: "empty" });
  expect(after.hooks.PreToolUse).toEqual([{ matcher: "x", hooks: [] }]);
  // Neuve's entry now comes last.
  expect(JSON.stringify(after.hooks.Stop.at(-1))).toContain(
    "neuve-capture-hook",
  );
});

test("an unreadable bundled script needs an update", async () => {
  const { root, settings, part } = await scene();
  const script = join(root, "hook/neuve-hook.js");
  await mkdir(join(root, "hook"), { recursive: true });
  await writeFile(script, "");
  const entry = (verb: string) =>
    `sh -c '${process.execPath} --no-env-file ${script} claude-code ${verb} >/dev/null 2>&1; exit 0 # neuve-capture-hook'`;
  await mkdir(join(settings, ".."), { recursive: true });
  await writeFile(
    settings,
    JSON.stringify({
      hooks: Object.fromEntries(
        [
          ["SessionStart", "session-start"],
          ["UserPromptSubmit", "user-prompt-submit"],
          ["Stop", "stop"],
          ["SubagentStart", "subagent-start"],
          ["SubagentStop", "subagent-stop"],
          ["SessionEnd", "session-end"],
        ].map(([event, verb]) => [
          event,
          [
            {
              matcher: "",
              hooks: [{ type: "command", command: entry(verb!), timeout: 10 }],
            },
          ],
        ]),
      ),
    }),
  );
  expect(await part(settings)).toMatchObject({ state: "ok" });
  await chmod(script, 0o000);
  try {
    expect(await part(settings)).toMatchObject({
      state: "update",
      why: expect.stringContaining(script),
    });
  } finally {
    await chmod(script, 0o600);
  }
});

test("a folder in a Git hook's place is refused, in the same words in both places", async () => {
  const { repo, setUp, part } = await scene();
  const hook = join(repo, ".git/hooks/post-commit");
  // Doctor reads Git hooks once capture is set up here.
  expect(await setUp()).toBe(0);
  await rm(hook);
  await mkdir(hook);
  const found = await part(hook);
  expect(found).toMatchObject({ state: "unreadable" });
  await expect(setUp()).rejects.toThrow(found!.why!);
  expect(
    await Bun.file(join(hook, "..", "post-commit.pre-neuve")).exists(),
  ).toBe(false);
});

test("another tool's hook beside an earlier .pre-neuve is refused in the same words in both places", async () => {
  const { repo, setUp, part } = await scene();
  expect(await setUp()).toBe(0);
  const hook = join(repo, ".git/hooks/post-commit");
  await writeFile(hook, "#!/bin/sh\necho theirs\n");
  await writeFile(`${hook}.pre-neuve`, "#!/bin/sh\necho earlier\n");
  const found = await part(hook);
  expect(found).toMatchObject({ state: "unreadable" });
  await expect(setUp()).rejects.toThrow(found!.why!);
});

test("a hooks folder that is a link is refused in the same words in both places", async () => {
  const { root, repo, setUp, part } = await scene();
  expect(await setUp()).toBe(0);
  const hooks = join(repo, ".git/hooks");
  const elsewhere = join(root, "elsewhere-hooks");
  await mkdir(elsewhere);
  await rm(hooks, { recursive: true });
  await symlink(elsewhere, hooks);
  const found = await part(hooks);
  expect(found).toMatchObject({ state: "unreadable" });
  await expect(setUp()).rejects.toThrow(found!.why!);
});
