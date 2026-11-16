// Why: fixture commits must succeed without executing the host's configured hooks.
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("review repository ignores host configuration and disables hooks", () => {
  const directory = mkdtempSync(join(tmpdir(), "review-repository-hooks-"));
  try {
    const hooks = join(directory, "hooks");
    const repository = join(directory, "repository");
    const marker = join(directory, "hook-ran");
    const config = join(directory, "gitconfig");
    mkdirSync(hooks);
    mkdirSync(repository);
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
      { mode: 0o700 },
    );
    writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);
    const script = `import { reviewRepository } from ${JSON.stringify(join(import.meta.dir, "fixtures/review-repository.ts"))}; const git = reviewRepository(${JSON.stringify(repository)}); console.log(JSON.stringify({ commits: git("rev-list", "--count", "HEAD"), hooks: git("config", "core.hooksPath"), global: git("config", "--global", "--list") }));`;
    const child = Bun.spawnSync(
      [process.execPath, "--no-env-file", "--eval", script],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_SYSTEM: config,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: hooks,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    expect(existsSync(marker)).toBe(false);
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(child.stdout.toString())).toEqual({
      commits: "2",
      hooks: "/dev/null",
      global: "",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Why: inherited Git configuration and repository paths must not change the fixture's commits.
for (const source of ["control", "count", "parameters", "file", "paths"]) {
  test(`review repository ignores environment ${source}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "review-repository-env-"));
    try {
      const repository = join(directory, "repository");
      const config = join(directory, "gitconfig");
      mkdirSync(repository);
      writeFileSync(config, "[core]\n\tignorestat = true\n");
      const inherited: Record<string, string> =
        source === "count"
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "core.ignorestat",
              GIT_CONFIG_VALUE_0: "true",
            }
          : source === "parameters"
            ? { GIT_CONFIG_PARAMETERS: "'core.ignorestat'='true'" }
            : source === "file"
              ? { GIT_CONFIG: config }
              : source === "paths"
                ? {
                    GIT_DIR: join(directory, "foreign.git"),
                    GIT_COMMON_DIR: join(directory, "foreign-common.git"),
                    GIT_WORK_TREE: directory,
                    GIT_INDEX_FILE: join(directory, "foreign-index"),
                    GIT_OBJECT_DIRECTORY: join(directory, "foreign-objects"),
                    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(
                      directory,
                      "foreign-alternate",
                    ),
                  }
                : {};
      const script = `import { reviewRepository } from ${JSON.stringify(join(import.meta.dir, "fixtures/review-repository.ts"))}; const git = reviewRepository(${JSON.stringify(repository)}); console.log(JSON.stringify({ commits: git("rev-list", "--count", "HEAD"), files: git("ls-files", "-v"), root: git("rev-parse", "--show-toplevel"), ignorestat: git("config", "--default", "false", "--get", "core.ignorestat") }));`;
      const child = Bun.spawnSync(
        [process.execPath, "--no-env-file", "--eval", script],
        {
          env: { ...process.env, ...inherited },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        },
      );
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe("");
      expect(JSON.parse(child.stdout.toString())).toEqual({
        commits: "2",
        files: "H a.ts",
        root: repository,
        ignorestat: "false",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
