// Why: between `neuve skills` checking a folder and writing or removing a file in it, another
// process can swap that folder for a link, or change the file. These tests make that swap at the
// last moment (inside the very filesystem call that follows the checks, or while the plan is being
// printed) and require that nothing outside the folder Neuve owns is written or removed, and that a
// file changed since the plan is kept. Turned from the second review's reproduction harness.
import { afterEach, expect, mock, test } from "bun:test";
import * as real from "node:fs/promises";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const realWriteFile = real.writeFile;
const realRm = real.rm;
let trigger: ((path: string) => void) | undefined;
/** Runs just after a removal returns, for a swap between one removal and the next step. */
let afterRemoval: ((path: string) => void) | undefined;
const fire = (path: unknown) => {
  const run = trigger;
  if (run !== undefined && typeof path === "string") run(path);
};
// Every write and removal goes through these, so a test can act inside the call itself.
mock.module("node:fs/promises", () => ({
  ...real,
  writeFile: async (path: unknown, ...rest: Array<unknown>) => {
    fire(path);
    return (realWriteFile as (...args: Array<unknown>) => Promise<void>)(
      path,
      ...rest,
    );
  },
  rm: async (path: unknown, ...rest: Array<unknown>) => {
    fire(path);
    await (realRm as (...args: Array<unknown>) => Promise<void>)(path, ...rest);
    const after = afterRemoval;
    if (after !== undefined && typeof path === "string") after(path);
  },
}));
const { runSkillsCli } = await import("../src/skills-cli.ts");
const { readSkillTemplate } = await import("../src/skill-bundle.ts");
type SkillsContext = Parameters<typeof runSkillsCli>[1] & object;

const roots: Array<string> = [];
afterEach(() => {
  trigger = undefined;
  afterRemoval = undefined;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neuve-skills-race-")));
  roots.push(root);
  return root;
};
const files = (folder: string) =>
  existsSync(folder)
    ? [...new Bun.Glob("**/*").scanSync({ cwd: folder, dot: true })].sort()
    : [];
const context = (
  home: string,
  cwd: string,
  out: (text: string) => Promise<void> = async () => {},
): SkillsContext => ({
  home,
  claudeConfigDir: undefined,
  cwd,
  version: "0.1.0",
  source: async () => ({
    found: true,
    location: "test template",
    bundle: await readSkillTemplate(
      resolve(import.meta.dir, "../skills/neuve"),
      "0.1.0",
    ),
  }),
  isTerminal: false,
  ask: async () => null,
  out,
  now: () => new Date("2026-11-13T12:00:00.000Z"),
});
/** The command's exit code, or the error it stopped with. */
const run = async (args: Array<string>, given: SkillsContext) => {
  try {
    return await runSkillsCli(args, given);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

test("repo scope: .agents swapped for a link inside the first write writes nothing outside", async () => {
  const root = scratch();
  const repository = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(join(outside, "skills/neuve"), { recursive: true });
  mkdirSync(repository);
  Bun.spawnSync(["git", "init", "-q", repository]);
  trigger = () => {
    trigger = undefined;
    renameSync(join(repository, ".agents"), join(root, "agents-moved"));
    symlinkSync(outside, join(repository, ".agents"));
  };
  const result = await run(
    ["install", "--scope", "repo", "--agents", "codex"],
    context(join(root, "home"), repository),
  );
  // The write in flight finished in the folder it started in, now moved within the repository;
  // the next file's check stopped the install.
  expect(result).toContain(`${join(repository, ".agents")} is a symbolic link`);
  expect(files(join(root, "agents-moved"))).toContain(
    "skills/neuve/.neuve-skill.json",
  );
  expect(files(outside)).toEqual([]);
});

test("uninstall: references swapped for a link inside the removal removes nothing outside", async () => {
  const root = scratch();
  const home = join(root, "home");
  mkdirSync(home);
  expect(
    await run(["install", "--agents", "claude-code"], context(home, root)),
  ).toBe(0);
  const folder = join(home, ".claude/skills/neuve");
  const other = join(root, "other");
  cpSync(join(folder, "references"), other, { recursive: true });
  trigger = (path) => {
    if (!path.endsWith("desk.md")) return;
    trigger = undefined;
    renameSync(join(folder, "references"), join(root, "references-moved"));
    symlinkSync(other, join(folder, "references"));
  };
  const result = await run(
    ["uninstall", "--agents", "claude-code"],
    context(home, root),
  );
  // The removal in flight happened in the folder it started in, now moved; the next file's check
  // stopped the uninstall.
  expect(result).toContain(`${join(folder, "references")} is a symbolic link`);
  expect(readdirSync(join(root, "references-moved"))).not.toContain("desk.md");
  expect(readdirSync(other).sort()).toEqual([
    "desk.md",
    "lanes-and-dispositions.md",
    "proof.md",
    "request-review.md",
    "setup.md",
    "stack.md",
  ]);
});

test("uninstall: neuve/ swapped for a link while the plan is printed removes nothing there", async () => {
  const root = scratch();
  const home = join(root, "home");
  mkdirSync(home);
  expect(await run(["install", "--agents", "codex"], context(home, root))).toBe(
    0,
  );
  const folder = join(home, ".agents/skills/neuve");
  // Another folder with the same file names and different text: say, another tool's copy.
  const other = join(root, "other-skill");
  cpSync(folder, other, { recursive: true });
  for (const file of files(other))
    if (file.endsWith(".md"))
      writeFileSync(join(other, file), "someone else's text\n");
  const before = files(other);
  let swapped = false;
  const result = await run(
    ["uninstall", "--agents", "codex"],
    context(home, root, async (text) => {
      if (swapped || !text.includes("The Neuve skill:")) return;
      swapped = true;
      renameSync(folder, join(root, "neuve-moved"));
      symlinkSync(other, folder);
    }),
  );
  expect(result).toContain(`${folder} is a symbolic link`);
  expect(files(other)).toEqual(before);
  expect(readFileSync(join(other, "SKILL.md"), "utf8")).toBe(
    "someone else's text\n",
  );
});

test("uninstall keeps a file changed after the plan", async () => {
  const root = scratch();
  const home = join(root, "home");
  mkdirSync(home);
  expect(await run(["install", "--agents", "codex"], context(home, root))).toBe(
    0,
  );
  const edited = join(home, ".agents/skills/neuve/SKILL.md");
  let done = false;
  const result = await run(
    ["uninstall", "--agents", "codex"],
    context(home, root, async (text) => {
      if (done || !text.includes("The Neuve skill:")) return;
      done = true;
      writeFileSync(edited, "the person's notes\n");
    }),
  );
  expect(result).toContain(`${edited} changed while removing`);
  expect(readFileSync(edited, "utf8")).toBe("the person's notes\n");
});

/** An installed Codex copy, and a decoy folder with the same names and other text. */
const installedWithDecoy = async () => {
  const root = scratch();
  const home = join(root, "home");
  mkdirSync(home);
  expect(await run(["install", "--agents", "codex"], context(home, root))).toBe(
    0,
  );
  const folder = join(home, ".agents/skills/neuve");
  const decoy = join(root, "decoy");
  cpSync(folder, decoy, { recursive: true });
  for (const file of files(decoy))
    if (file.endsWith(".md")) writeFileSync(join(decoy, file), "decoy\n");
  return { root, home, folder, decoy };
};

test("uninstall: neuve/ swapped for a link between two removals removes nothing more", async () => {
  // One check at the start of the removals would miss this: each removal must check again.
  const { root, home, folder, decoy } = await installedWithDecoy();
  const before = files(decoy);
  afterRemoval = () => {
    afterRemoval = undefined;
    renameSync(folder, join(root, "neuve-moved"));
    symlinkSync(decoy, folder);
  };
  const result = await run(
    ["uninstall", "--agents", "codex"],
    context(home, root),
  );
  expect(result).toContain(`${folder} is a symbolic link`);
  expect(files(decoy)).toEqual(before);
});

test("uninstall: neuve/ swapped for a link before its empty folders go removes none there", async () => {
  const { root, home, folder, decoy } = await installedWithDecoy();
  // The decoy's references/ is empty, as the real one is once its files are gone.
  for (const file of files(join(decoy, "references")))
    rmSync(join(decoy, "references", file));
  afterRemoval = (path) => {
    if (!path.endsWith(".neuve-skill.json")) return;
    afterRemoval = undefined;
    renameSync(folder, join(root, "neuve-moved"));
    symlinkSync(decoy, folder);
  };
  const result = await run(
    ["uninstall", "--agents", "codex"],
    context(home, root),
  );
  expect(result).toContain(`${folder} is a symbolic link`);
  expect(existsSync(join(decoy, "references"))).toBe(true);
});
