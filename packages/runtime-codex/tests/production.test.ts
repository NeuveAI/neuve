import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Logger } from "effect";
import { connect, type ConnectOptions } from "../src/client.ts";
import { processLayer } from "../src/production.ts";

// The process service against a real child process: a stub program written for the test, started
// through a wrapper script that hands itself over to it, as the desktop app's entry point does.
const folder = mkdtempSync(join(tmpdir(), "runtime-codex-stub-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const program = join(folder, "stub-app-server");
writeFileSync(
  program,
  `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "stub-program.ts")}" "$@"\n`,
);
chmodSync(program, 0o755);

const options = (
  mode: string,
  overrides: Partial<ConnectOptions> = {},
): ConnectOptions => ({
  program,
  args: [],
  env: { PATH: process.env.PATH, STUB_MODE: mode },
  cwd: folder,
  clientInfo: { name: "neuve-test", title: null, version: "0" },
  answer: () => Effect.succeed({ result: {} }),
  ...overrides,
});
const run = <A, E>(body: Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    Effect.scoped(body).pipe(
      Effect.provide(processLayer),
      Effect.provide(Logger.layer([])),
    ) as Effect.Effect<A, E>,
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
type Listed = { seen: Array<string>; pid: number };

// The handshake over real pipes: `initialize` answered, then `initialized` sent before anything
// else, and a clean close that ends input lets the program exit by itself, well inside the wait.
test("the handshake, and a close the program ends by itself", async () => {
  const { userAgent, listed, ms } = await run(
    Effect.gen(function* () {
      const c = yield* connect(options("plain"));
      const listed = (yield* c.request("model/list", {})) as unknown as Listed;
      const started = Date.now();
      yield* c.close;
      return {
        userAgent: c.initialize.userAgent,
        listed,
        ms: Date.now() - started,
      };
    }),
  );
  expect(userAgent).toBe("stub/0.0.0 (test) stub");
  expect(listed.seen).toEqual(["initialize", "initialized", "model/list"]);
  expect(ms).toBeLessThan(2000);
  expect(alive(listed.pid)).toBe(false);
});

// A program that ignores the end of its input and the termination signal is killed, after the
// stop wait and not before.
test("a program that outlives the stop wait is killed after it", async () => {
  const { pid, ms } = await run(
    Effect.gen(function* () {
      const c = yield* connect(options("linger", { stopWait: "300 millis" }));
      const { pid } = (yield* c.request("model/list", {})) as unknown as Listed;
      const started = Date.now();
      yield* c.close;
      return { pid, ms: Date.now() - started };
    }),
  );
  expect(ms).toBeGreaterThanOrEqual(290);
  expect(alive(pid)).toBe(false);
});

// The program dying under a pending request fails it with its exit code and its last words.
test("the program dies mid-request", async () => {
  const failure = await run(
    connect(options("die")).pipe(
      Effect.flatMap((c) => Effect.flip(c.request("model/list", {}))),
    ),
  );
  expect(failure).toMatchObject({
    _tag: "CodexExited",
    method: "model/list",
    exitCode: 3,
  });
  expect((failure as { stderrTail: string }).stderrTail).toContain(
    "stub panicked",
  );
});
