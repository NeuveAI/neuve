import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitReadRefusal,
  gitReadText,
  preflightLocalGitRead,
  qualifyLocalGitRead,
  runQualifiedGit,
} from "../src/git-read-qualification.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const fixture = async (format: "sha1" | "sha256") => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-ref-read-")));
  roots.push(root);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...environment,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main", `--object-format=${format}`);
  const commit = (message: string) => {
    git(
      "-c",
      "user.name=Native fixture",
      "-c",
      "user.email=native@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  const selectedCommit = commit("Selected original");
  const ref = "refs/heads/context/β-source";
  git("update-ref", ref, selectedCommit);
  const currentHead = commit("Current checkout");
  const qualified = await qualifyLocalGitRead(
    await preflightLocalGitRead({ repository: root, workdir: root }),
  );
  return { root, ref, selectedCommit, currentHead, qualified, git };
};

const formats: readonly ("sha1" | "sha256")[] = ["sha1", "sha256"];
for (const format of formats)
  test(`resolve the exact noncurrent local ref in ${format} without moving HEAD`, async () => {
    const input = await fixture(format);
    const commands: (readonly string[])[] = [];
    const result = await runQualifiedGit(
      input.qualified,
      { kind: "resolve-local-ref", ref: input.ref },
      { onCommand: (receipt) => commands.push([...receipt.argv]) },
      128,
    );
    expect(gitReadText(result)).toBe(input.selectedCommit);
    expect(result.bytes.byteLength).toBe(format === "sha1" ? 41 : 65);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(-4)).toEqual([
      "show-ref",
      "--verify",
      "--hash",
      input.ref,
    ]);
    expect(
      gitReadText(
        await runQualifiedGit(input.qualified, { kind: "resolve-head" }),
      ),
    ).toBe(input.currentHead);
  });

test("malformed refs refuse before a native resolver command", async () => {
  const input = await fixture("sha1");
  for (const ref of [
    "HEAD",
    "refs/tags/tag",
    "refs/heads/",
    "refs/heads/a..b",
    "refs/heads/a.lock",
    "refs/heads/.hidden",
    "refs/heads/a@{1}",
    "refs/heads/a\n",
    "refs/heads/a b",
    "refs/heads/a\\b",
    "refs/heads/a//b",
    "refs/heads/a.",
    "refs/heads/a?b",
    "refs/heads/a\0b",
  ]) {
    let commands = 0;
    try {
      await runQualifiedGit(
        input.qualified,
        { kind: "resolve-local-ref", ref },
        {
          onCommand: () => {
            commands++;
          },
        },
        128,
      );
      throw new Error(`Accepted malformed ref ${JSON.stringify(ref)}`);
    } catch (error) {
      expect(error).toBeInstanceOf(GitReadRefusal);
      if (!(error instanceof GitReadRefusal)) throw error;
      expect(error.detail).toBe("local-ref-shape");
    }
    expect(commands).toBe(0);
  }
});

test("literal full ref preserves a dash-leading branch component", async () => {
  const input = await fixture("sha1");
  const ref = "refs/heads/-literal";
  input.git("check-ref-format", ref);
  input.git("update-ref", ref, input.selectedCommit);
  expect(
    gitReadText(
      await runQualifiedGit(
        input.qualified,
        { kind: "resolve-local-ref", ref },
        {},
        128,
      ),
    ),
  ).toBe(input.selectedCommit);
});

test("a missing literal ref refuses without a HEAD fallback", async () => {
  const input = await fixture("sha1");
  await expect(
    runQualifiedGit(
      input.qualified,
      { kind: "resolve-local-ref", ref: "refs/heads/not-present" },
      {},
      128,
    ),
  ).rejects.toBeInstanceOf(GitReadRefusal);
  expect(
    gitReadText(
      await runQualifiedGit(input.qualified, { kind: "resolve-head" }),
    ),
  ).toBe(input.currentHead);
});
