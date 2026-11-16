import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureGraphWorkspace,
  type GraphWorkspaceContract,
} from "../scripts/setup-graph-workspace.ts";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const run = async (
  command: readonly string[],
  cwd: string,
): Promise<string> => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
};

const commit = async (
  repository: string,
  contents: string,
): Promise<string> => {
  await Bun.write(join(repository, "source.txt"), contents);
  await run(["git", "add", "source.txt"], repository);
  await run(["git", "commit", "--quiet", "-m", contents], repository);
  return run(["git", "rev-parse", "HEAD"], repository);
};

describe("graph workspace setup", () => {
  test("converges a fresh clone remote configuration to the operational marker", async () => {
    const repository = await temporaryDirectory("neuve-graph-setup-");
    await run(["git", "init", "--quiet"], repository);
    await run(["git", "config", "user.name", "Neuve test"], repository);
    await run(
      ["git", "config", "user.email", "neuve-test@example.test"],
      repository,
    );
    const baselineRevision = await commit(repository, "baseline");
    await run(["git", "tag", "-a", "baseline", "-m", "Baseline"], repository);
    await commit(repository, "current");
    await run(
      ["git", "remote", "add", "origin", "git@example.test:private.git"],
      repository,
    );

    const contract = {
      originUrl: "git@example.test:private.git",
      upstreamUrl: "git@example.test:upstream.git",
      upstreamPushUrl: "DISABLED",
      baselineTag: "baseline",
      baselineRevision,
    } satisfies GraphWorkspaceContract;
    await configureGraphWorkspace({ repository, contract });
    await run(
      ["git", "remote", "set-url", "upstream", "git@example.test:wrong.git"],
      repository,
    );
    await run(
      ["git", "config", "--unset-all", "remote.upstream.pushurl"],
      repository,
    );
    await run(
      ["git", "config", "--add", "remote.upstream.pushurl", "wrong-one"],
      repository,
    );
    await run(
      ["git", "config", "--add", "remote.upstream.pushurl", "wrong-two"],
      repository,
    );
    await configureGraphWorkspace({ repository, contract });

    expect(await run(["git", "remote", "get-url", "origin"], repository)).toBe(
      contract.originUrl,
    );
    expect(
      await run(["git", "remote", "get-url", "upstream"], repository),
    ).toBe(contract.upstreamUrl);
    expect(
      await run(["git", "remote", "get-url", "--push", "upstream"], repository),
    ).toBe(contract.upstreamPushUrl);
  });

  test("refuses a repository whose origin is not the private fork", async () => {
    const repository = await temporaryDirectory("neuve-graph-origin-");
    await run(["git", "init", "--quiet"], repository);
    await run(["git", "config", "user.name", "Neuve test"], repository);
    await run(
      ["git", "config", "user.email", "neuve-test@example.test"],
      repository,
    );
    const baselineRevision = await commit(repository, "baseline");
    await run(["git", "tag", "-a", "baseline", "-m", "Baseline"], repository);
    await run(
      ["git", "remote", "add", "origin", "git@example.test:wrong.git"],
      repository,
    );

    await expect(
      configureGraphWorkspace({
        repository,
        contract: {
          originUrl: "git@example.test:private.git",
          upstreamUrl: "git@example.test:upstream.git",
          upstreamPushUrl: "DISABLED",
          baselineTag: "baseline",
          baselineRevision,
        },
      }),
    ).rejects.toThrow("origin URL");
  });
});
