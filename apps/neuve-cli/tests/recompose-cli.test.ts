// Why (10.137): a recompose appends a new review request and stage records to the store it runs in,
// and a worker on a repository's own store would run its leftover jobs or rerun it with the model.
// So it must run only on a named scratch copy: never by default in the repository's own store, and
// never in a store that sits in any git directory, whatever the checkout's layout.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewCli } from "../src/review-cli.ts";

const root = mkdtempSync(join(tmpdir(), "neuve-recompose-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const refusal = (store: string | undefined) =>
  runReviewCli([
    "recompose",
    "--run",
    "01M5T8PQA8EQY0GQZVZEJWP4JD",
    "--repo",
    root,
    ...(store === undefined ? [] : ["--store", store]),
  ]).then(
    () => "ran",
    (error: unknown) => String((error as Error).message),
  );

test("a recompose needs --store and refuses a store in any git directory", async () => {
  expect(await refusal(undefined)).toContain("needs --store");
  expect(await refusal(join(root, "empty"))).toContain("holds no store");
  // A work tree's .git, a --separate-git-dir checkout's git dir, and a bare repository.
  git("init", "-q", join(root, "work"));
  git(
    "init",
    "-q",
    `--separate-git-dir=${join(root, "separate.git")}`,
    join(root, "separate"),
  );
  git("init", "-q", "--bare", join(root, "bare.git"));
  for (const gitDirectory of [
    join(root, "work", ".git"),
    join(root, "separate.git"),
    join(root, "bare.git"),
  ]) {
    mkdirSync(join(gitDirectory, "neuve"), { recursive: true });
    expect(await refusal(gitDirectory)).toContain("is in a git directory");
  }
});
