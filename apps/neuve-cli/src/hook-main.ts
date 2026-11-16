#!/usr/bin/env bun
// The hooks' own entry: `<harness> <event> [git arguments]`. It first checks, with nothing loaded but
// Bun itself, that the repository has capture enabled, and only then loads the capture modules (never
// the rest of the CLI or a SQL client). Whatever happens it prints nothing and exits 0, so a hook can
// neither add to an agent's context nor block a prompt, a stop or a commit.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The git directory for `cwd`, found by walking up to `.git` (a directory, or a `gitdir:` file). */
const findGitDirectory = (cwd: string): string | undefined => {
  if (process.env["GIT_DIR"]) return resolve(cwd, process.env["GIT_DIR"]);
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const candidate = join(directory, ".git");
    if (existsSync(candidate)) {
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"));
      return pointer === null
        ? undefined
        : resolve(directory, pointer[1]!.trim());
    }
    if (dirname(directory) === directory) return undefined;
  }
};

/**
 * Whether `<git common directory>/neuve/capture.json` exists, read from the file system without
 * spawning git: hooks fire in every repository, and most have capture off. A layout this walk does
 * not recognise falls back to git itself.
 */
const captureEnabled = (cwd: string) => {
  let common = process.env["GIT_COMMON_DIR"];
  if (common === undefined) {
    const gitDirectory = findGitDirectory(cwd);
    if (gitDirectory !== undefined) {
      const pointer = join(gitDirectory, "commondir");
      common = existsSync(pointer)
        ? resolve(gitDirectory, readFileSync(pointer, "utf8").trim())
        : gitDirectory;
    } else {
      const result = Bun.spawnSync(
        ["git", "-C", cwd, "rev-parse", "--git-common-dir"],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      );
      if (!result.success) return false;
      common = result.stdout.toString().trim();
    }
  }
  return existsSync(join(resolve(cwd, common), "neuve", "capture.json"));
};

try {
  const args = Bun.argv.slice(2);
  const [harness, event] = args;
  // Git passes input on standard input only to post-rewrite; agent hooks always send a JSON payload.
  const input =
    harness !== "git" || event === "post-rewrite" ? await Bun.stdin.text() : "";
  let cwd = process.cwd();
  if (harness !== "git") {
    const payload = JSON.parse(input) as { cwd?: unknown };
    if (typeof payload.cwd === "string") cwd = payload.cwd;
  }
  if (captureEnabled(cwd)) {
    const { runHook } = await import("./capture/hook-cli.ts");
    await runHook(args, input);
  }
} catch {
  // runHook logs its own failures to the store; anything before it stays silent.
}
process.exit(0);
