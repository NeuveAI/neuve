import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import { Store, storeLocationIn } from "@neuve/records-core";
import { z } from "zod";
import { hostBudget } from "../src/budget/local.ts";
import { BlobChunks } from "../src/search-index.ts";

const Message = z.discriminatedUnion("event", [
  z.object({ event: z.enum(["claimed", "joined"]) }),
  z.object({
    event: z.literal("others-finished"),
    computed: z.int().nonnegative(),
  }),
  z.object({ event: z.literal("failed"), message: z.string() }),
  z.object({
    event: z.literal("result"),
    computed: z.number(),
    reused: z.number(),
    target: BlobChunks,
  }),
]);
const spawn = (
  root: string,
  mode: "background" | "foreground",
  budgetDirectory: string,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();
  const claimed = Promise.withResolvers<void>(),
    joined = Promise.withResolvers<void>(),
    othersFinished = Promise.withResolvers<number>();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/blob-overlap-process.ts"),
      JSON.stringify({ root, mode }),
    ],
    {
      env: { ...process.env, NEUVE_BUDGET_DIRECTORY: budgetDirectory },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const stop = () => child.kill("SIGKILL");
  signal.addEventListener("abort", stop, { once: true });
  const output = (async () => {
    const decoder = new TextDecoder();
    let stdout = "",
      pending = "";
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      stdout += text;
      pending += text;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const message = Message.parse(JSON.parse(line));
        if (message.event === "claimed") claimed.resolve();
        if (message.event === "joined") joined.resolve();
        if (message.event === "others-finished")
          othersFinished.resolve(message.computed);
      }
    }
    return stdout;
  })();
  const result = (async () => {
    const stdout = await output,
      code = await child.exited;
    const lines = stdout.trim().split("\n");
    const message = Message.parse(JSON.parse(lines.at(-1) ?? ""));
    if (message.event !== "result" || code !== 0)
      throw new Error(`${stdout}\n${await stderr}`);
    return message;
  })();
  void result.catch(() => {});
  return {
    result,
    claimed: claimed.promise,
    joined: joined.promise,
    othersFinished: othersFinished.promise,
    release: async () => {
      child.stdin.write("release\n");
      await child.stdin.end();
    },
    stop: async () => {
      signal.removeEventListener("abort", stop);
      if (child.exitCode === null) stop();
      await child.exited;
      await Promise.allSettled([result, stderr]);
    },
  };
};

test("two processes subscribe to an overlapping blob without holding the machine's one CPU permit", async () => {
  const root = mkdtempSync(join(tmpdir(), "blob-overlap-process-")),
    directory = join(root, "budget"),
    signal = AbortSignal.timeout(8000),
    children: ReturnType<typeof spawn>[] = [];
  let host: Awaited<ReturnType<typeof hostBudget>> = undefined;
  try {
    const location = storeLocationIn(join(root, "records"));
    await Effect.runPromise(
      Store.prepareForWrite.pipe(
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    host = await hostBudget({ directory, threads: 1, efficiency: 1 });
    if (!host) throw new Error("Missing budget host");
    await host.claims.ready;
    const background = spawn(root, "background", directory, signal);
    children.push(background);
    const [, completedOthers] = await Promise.race([
      Promise.all([background.claimed, background.othersFinished]),
      background.result.then(() => {
        throw new Error("Background finished before the target was released");
      }),
    ]);
    expect(completedOthers).toBe(32);
    expect(readFileSync(join(root, "executions"), "utf8")).toBe("background\n");
    const foreground = spawn(root, "foreground", directory, signal);
    children.push(foreground);
    await Promise.race([
      foreground.joined,
      foreground.result.then(() => {
        throw new Error("Foreground did not subscribe");
      }),
    ]);
    expect((await host.scheduler.observe()).held).toBe(0);
    await background.release();
    const [bg, fg] = await Promise.all([background.result, foreground.result]);
    expect([bg.computed, bg.reused, fg.computed, fg.reused]).toEqual([
      33, 0, 0, 1,
    ]);
    expect(fg.target).toEqual(bg.target);
    expect(readFileSync(join(root, "executions"), "utf8")).toBe("background\n");
    expect((await host.scheduler.observe()).held).toBe(0);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
