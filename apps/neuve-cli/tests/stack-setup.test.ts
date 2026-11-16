// Why: `neuve setup stack` is the consent step for network and disk work (SC1): it must name what
// it will fetch and the caps before anything is queued, a dry run must change nothing, and turning
// it off must stop every later fetch path, which reads the repository's stack.json.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack } from "@neuve/harness";
import { setupStack } from "../src/stack-cli.ts";

const directories: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const git = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

const repository = async (files: Record<string, string>) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-stack-setup-")),
  );
  directories.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "dev@example.com");
  git(root, "config", "user.name", "Dev");
  for (const [path, content] of Object.entries(files))
    await writeFile(join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
};

// Never the user's own settings or store.
const isolated = {
  settings: Stack.resolveStackSettings(undefined),
};

const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "a", "dependencies": { "left-pad": "1.3.0" } } },
  "packages": { "left-pad": ["left-pad@1.3.0", "", {}, "sha512-${"A".repeat(86)}=="] }
}
`;

test("a dry run names the entries and the caps and writes nothing", async () => {
  const root = await repository({ "bun.lock": LOCK });
  const lines = await setupStack({
    root,
    dryRun: true,
    ...isolated,
    storeRoot: join(root, "stack-store"),
  });
  expect(lines[0]).toContain("Would set up stack sources");
  expect(lines[0]).toContain("1 entry pinned at HEAD (bun.lock)");
  expect(lines.join("\n")).toContain(
    "5.0 GiB in total, 256.0 MiB per package, 128.0 MiB per upstream tree",
  );
  expect(lines.join("\n")).toContain("Nothing fetched is run");
  expect(existsSync(join(root, ".git", "neuve", "stack.json"))).toBe(false);
});

test("off is recorded in stack.json, which every fetch path reads", async () => {
  const root = await repository({ "bun.lock": LOCK });
  const lines = await setupStack({
    root,
    dryRun: false,
    off: "--no-stack",
    ...isolated,
    storeRoot: join(root, "stack-store"),
  });
  expect(lines[0]).toContain("Turned stack sources off");
  const state = await Stack.readRepoStack(join(root, ".git", "neuve"));
  expect(state?.enabled).toBe(false);
  expect(state?.disabledBy).toBe("--no-stack");
});

test("a repository with nothing pinned is set up without queueing a fetch", async () => {
  const root = await repository({ a: "a" });
  const lines = await setupStack({
    root,
    dryRun: false,
    ...isolated,
    storeRoot: join(root, "stack-store"),
  });
  expect(lines.join("\n")).toContain("Nothing to fetch yet");
  expect(
    (await Stack.readRepoStack(join(root, ".git", "neuve")))?.enabled,
  ).toBe(true);
  expect(existsSync(join(root, ".git", "neuve", "records.sqlite"))).toBe(false);
});

// The stored unknown fields may arrive after setup starts; only the shared store lock orders publication.
test("setup waits for the stack writer and preserves its newer fields before replacing repository pins", async () => {
  const root = await repository({ a: "a" });
  const storeRoot = join(root, "stack-store");
  await setupStack({ root, dryRun: false, ...isolated, storeRoot });
  const path = join(root, ".git", "neuve", "stack.json");
  let setup: Promise<ReadonlyArray<string>> | undefined;
  await Stack.withStoreLock(storeRoot, async () => {
    setup = setupStack({
      root,
      dryRun: false,
      off: "--off",
      ...isolated,
      storeRoot,
    });
    const finished = await Promise.race([
      setup.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(finished).toBe(false);
    await writeFile(
      path,
      JSON.stringify({
        ...JSON.parse(readFileSync(path, "utf8")),
        future: { keep: true },
      }),
    );
  });
  await setup;
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    enabled: false,
    disabledBy: "--off",
    future: { keep: true },
  });
});
