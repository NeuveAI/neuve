import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  prepareGraphSnapshot,
  type GraphPreparationRun,
} from "../src/index.ts";
import {
  fakeExecutable,
  fixtureRepository,
  removeRoots,
  waitForFile,
} from "./graph-client-support.ts";

afterEach(removeRoots);

// Why: another engine or Git inheriting a write end would prevent EOF when its holder disappears.
test("concurrent engine lifelines close independently while another engine and Git stay alive", async () => {
  const repo = await fixtureRepository();
  const children = new Map<
    number,
    Awaited<ReturnType<NonNullable<GraphPreparationRun["spawnProcess"]>>>
  >();
  const pending: Promise<unknown>[] = [];
  const engines: number[] = [];
  let git: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const executable = await fakeExecutable("prepared-service-answered");
      const directory = dirname(executable),
        pidFile = join(directory, "engine.pid");
      writeFileSync(
        executable,
        readFileSync(executable, "utf8").replace(
          "const command = process.argv[2];",
          `const command = process.argv[2]; if(command === "index") { writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); if(process.env.ENTIRE_GRAPH_LIFELINE_FD === undefined) await Bun.sleep(60000); else readFileSync(Number(process.env.ENTIRE_GRAPH_LIFELINE_FD)); process.exit(0); }`,
        ),
      );
      pending.push(
        Effect.runPromise(
          prepareGraphSnapshot(
            { repository: repo.root, revision: repo.second, executable },
            {
              cacheDirectory: join(directory, "cache"),
              spawnProcess: async (launch) => {
                const child = launch();
                children.set(child.pid, child);
                return child;
              },
            },
          ),
        ).catch(() => {}),
      );
      await waitForFile(pidFile);
      let pid = 0;
      while (pid <= 1) {
        pid = Number(readFileSync(pidFile, "utf8"));
        if (pid <= 1) await Bun.sleep(10);
      }
      engines.push(pid);
    }
    git = Bun.spawn(["git", "-c", "alias.hold=!sleep 60", "hold"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    for (const [i, pid] of engines.entries()) {
      const child = children.get(pid);
      expect(child).toBeDefined();
      if (
        !child ||
        child.stdin === undefined ||
        typeof child.stdin === "number"
      )
        throw new Error("Engine has no pipe lifeline");
      child.stdin.end();
      expect(
        await Promise.race([
          child.exited,
          Bun.sleep(5000).then(() => "still running"),
        ]),
      ).toBe(0);
      if (i === 0) expect(children.get(engines[1]!)?.exitCode).toBeNull();
      expect(git.exitCode).toBeNull();
    }
  } finally {
    for (const child of children.values())
      if (child.exitCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    if (git) {
      try {
        process.kill(-git.pid, "SIGKILL");
      } catch {}
      await git.exited;
    }
    await Promise.all(pending);
  }
}, 30000);

// Why: GC must not close a healthy command's caller-held lifeline before Graph finishes its answer.
test("a healthy engine keeps its lifeline through repeated GC until it answers", async () => {
  const repo = await fixtureRepository();
  const executable = await fakeExecutable("prepared-service-answered");
  const directory = dirname(executable),
    started = join(directory, "index-started");
  writeFileSync(
    executable,
    readFileSync(executable, "utf8").replace(
      "const command = process.argv[2];",
      `import { createReadStream } from "node:fs";
const command = process.argv[2];
if (command === "index") {
  writeFileSync(${JSON.stringify(started)}, "started");
  void (async () => { for await (const chunk of createReadStream("", { fd: 0, autoClose: false })) {} process.exit(143); })();
  await Bun.sleep(2000);
}`,
    ) + '\nif (command === "index") process.exit(0);\n',
  );
  const exits: number[] = [];
  const pending = Effect.runPromise(
    prepareGraphSnapshot(
      { repository: repo.root, revision: repo.second, executable },
      {
        cacheDirectory: join(directory, "cache"),
        onCommand: (receipt) => {
          if (receipt.stage === "index") exits.push(receipt.exitCode);
        },
      },
    ),
  );
  void pending.catch(() => {});
  await waitForFile(started);
  for (let i = 0; i < 8; i++) {
    Bun.gc(true);
    await Bun.sleep(200);
  }
  const answer = await pending;
  expect(answer.profile).toBe("full");
  expect(answer.source.revision.toString()).toBe(repo.second);
  expect(exits).toEqual([0]);
}, 15000);
