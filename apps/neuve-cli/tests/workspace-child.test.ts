// Why: readiness failures must be actionable and must not leave an owned listener behind.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announcedChild, closeChild } from "../src/workspace-child.ts";

test("the child binds port zero and the parent uses its IPC address", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-child-"));
  const script = join(directory, "child.ts");
  const base = `/review/${"a".repeat(64)}/`;
  await writeFile(
    script,
    `const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("announced")}); process.send({kind:"review-ready",url:server.url.origin+${JSON.stringify(base)}});`,
  );
  let child: Bun.Subprocess | undefined;
  try {
    const started = await announcedChild({
      command: [process.execPath, "--no-env-file", script],
      cwd: directory,
      env: {},
      base,
      log: join(directory, "child.log"),
      signal: new AbortController().signal,
    });
    child = started.child;
    expect(new URL(started.url).port).not.toBe("0");
    expect(await (await fetch(started.url)).text()).toBe("announced");
  } finally {
    if (child) await closeChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["exit", "silent", "invalid", "abort"] as const) {
  test(`a child that is ${mode} before ready fails with its log and leaves no process`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-child-fail-"));
    const script = join(directory, "child.ts");
    const pidFile = join(directory, "pid");
    const log = join(directory, "child.log");
    const controller = new AbortController();
    await writeFile(
      script,
      `await Bun.write(${JSON.stringify(pidFile)},String(process.pid)); ${
        mode === "exit"
          ? "process.exit(23)"
          : mode === "invalid"
            ? 'process.send({kind:"review-ready",url:"http://foreign.invalid/"}); setInterval(()=>{},1000)'
            : "setInterval(()=>{},1000)"
      };`,
    );
    const timer =
      mode === "abort" ? setTimeout(() => controller.abort(), 300) : undefined;
    try {
      const start = announcedChild({
        command: [process.execPath, "--no-env-file", script],
        cwd: directory,
        env: {},
        base: `/review/${"a".repeat(64)}/`,
        log,
        signal: controller.signal,
        deadlineMs: 1000,
      });
      await expect(start).rejects.toThrow(log);
      const pid = Number(await Bun.file(pidFile).text());
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
