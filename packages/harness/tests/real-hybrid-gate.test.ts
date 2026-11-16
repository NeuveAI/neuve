// The handler resolves real scratch settings, runs prepareHybrid, and reaches prepareNextBase.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeExecutable,
  removeRoots,
} from "../../graph-client/tests/graph-client-support.ts";
import { settingsPath } from "../src/settings.ts";

test("the real commit.hybrid handler admits Graph base preparation after the running review", async () => {
  const root = mkdtempSync(join(tmpdir(), "real-hybrid-gate-")),
    repo = join(root, "repo"),
    home = join(root, "home");
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  try {
    git("init", "-q", repo);
    const commit = () =>
      git(
        "-C",
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "empty",
      );
    commit();
    const parent = git("-C", repo, "rev-parse", "HEAD");
    commit();
    const oid = git("-C", repo, "rev-parse", "HEAD"),
      tree = git("-C", repo, "rev-parse", "HEAD^{tree}");
    const engine = await fakeExecutable("prepared-service-answered"),
      marker = join(dirname(engine), "index-call");
    mkdirSync(dirname(settingsPath(home)), { recursive: true });
    writeFileSync(
      settingsPath(home),
      JSON.stringify({
        version: 1,
        search: {
          hybrid: {
            prepare: true,
            device: "cpu",
            python: process.execPath,
            e0: {
              snapshot: root,
              worker: fileURLToPath(
                new URL("../../semantic-client/src/worker.py", import.meta.url),
              ),
            },
            reranker: {
              snapshot: root,
              worker: fileURLToPath(
                new URL(
                  "../../semantic-client/src/reranker_worker.py",
                  import.meta.url,
                ),
              ),
            },
            graph: { executable: engine },
          },
        },
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/real-hybrid-gate.ts"),
        JSON.stringify({ root, repo, oid, parent, tree, marker }),
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: home,
          TMPDIR: root,
          NEUVE_MODE: "check",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, err).toBe(0);
    const line = out
      .split("\n")
      .find((line) => line.startsWith("GATE_RESULT "));
    expect(line, out).toBeDefined();
    expect(JSON.parse(line!.slice("GATE_RESULT ".length))).toEqual({
      exit: "idle",
      duringReview: false,
      setups: 1,
      modelCalls: 0,
      cpuPriority: "preparation",
      indexed: true,
      report: "prepared",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await removeRoots();
  }
}, 120000);
