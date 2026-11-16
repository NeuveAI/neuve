import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The caller's temporary world owns the repository and removes it after the tests. */
export const reviewRepository = (repository: string) => {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ["git", "-c", "core.hooksPath=/dev/null", ...args],
      {
        cwd: repository,
        env,
      },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  for (const value of [1, 2]) {
    writeFileSync(join(repository, "a.ts"), `export const value = ${value};\n`);
    git("add", "a.ts");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--no-gpg-sign",
      "-qm",
      `value ${value}`,
    );
  }
  return git;
};
