import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Runs git in a test repository and returns its trimmed output; throws on failure. */
export const git = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

export const scratch = (prefix: string) =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** A repository with one commit of `files`; returns its path and the commit. */
export const repositoryWith = (
  root: string,
  files: Record<string, string | Uint8Array>,
) => {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  return { repo, commit: commitFiles(repo, files) };
};

export const commitFiles = (
  repo: string,
  files: Record<string, string | Uint8Array>,
) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "files");
  return git(repo, "rev-parse", "HEAD");
};

/** A `bun.lock` with one root workspace depending on `packages`, each `[name, version, integrity, registry?]`. */
export const bunLock = (
  packages: ReadonlyArray<readonly [string, string, string, string?]>,
  extra: Record<string, string> = {},
) =>
  `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
${[...packages.map(([name, version]) => `        "${name}": "${version}",`), ...Object.entries(extra).map(([name, spec]) => `        "${name}": "${spec}",`)].join("\n")}
      },
    },
  },
  "packages": {
${packages.map(([name, version, integrity, registry]) => `    "${name}": ["${name}@${version}", "${registry ?? ""}", {}, "${integrity}"],`).join("\n")}
  }
}
`;
