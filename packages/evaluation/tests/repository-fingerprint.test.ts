import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repositoryFingerprint } from "../src/repository-fingerprint.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const run = (argv: readonly string[], cwd: string): void => {
  const result = Bun.spawnSync([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

describe("repository sensitivity fingerprint", () => {
  test("includes selected evidence and latest symlink identity but excludes ignored runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "neuve-fingerprint-"));
    roots.push(root);
    run(["git", "init", "--quiet"], root);
    await mkdir(join(root, "validation/evidence/suite/runs/selected"), {
      recursive: true,
    });
    await mkdir(join(root, "validation/evidence/suite/runs/generated"), {
      recursive: true,
    });
    await Bun.write(join(root, ".gitignore"), "/validation/evidence/*/runs/\n");
    await Bun.write(
      join(
        root,
        "validation/evidence/suite/runs/selected/canonical-result.json",
      ),
      "selected-one\n",
    );
    await symlink(
      "runs/selected",
      join(root, "validation/evidence/suite/latest"),
    );
    run(["git", "add", ".gitignore"], root);
    run(
      [
        "git",
        "add",
        "-f",
        "validation/evidence/suite/runs/selected/canonical-result.json",
        "validation/evidence/suite/latest",
      ],
      root,
    );
    const initial = await repositoryFingerprint(root);

    await Bun.write(
      join(root, "validation/evidence/suite/runs/generated/result.json"),
      "ignored mutation\n",
    );
    expect(await repositoryFingerprint(root)).toBe(initial);

    await Bun.write(
      join(
        root,
        "validation/evidence/suite/runs/selected/canonical-result.json",
      ),
      "selected-two\n",
    );
    const selectedMutation = await repositoryFingerprint(root);
    expect(selectedMutation).not.toBe(initial);

    await chmod(
      join(
        root,
        "validation/evidence/suite/runs/selected/canonical-result.json",
      ),
      0o755,
    );
    const modeMutation = await repositoryFingerprint(root);
    expect(modeMutation).not.toBe(selectedMutation);

    await rm(join(root, "validation/evidence/suite/latest"));
    await symlink("runs/other", join(root, "validation/evidence/suite/latest"));
    expect(await repositoryFingerprint(root)).not.toBe(modeMutation);
  });
});
