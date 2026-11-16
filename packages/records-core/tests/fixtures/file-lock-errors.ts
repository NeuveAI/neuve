// Fault only the failed operation; publication, work and cleanup otherwise use the real filesystem.
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const [scenario, root] = process.argv.slice(2);
if (!root || !scenario) throw new Error("missing case");
const io = { ...fs };
const lock = join(root, "lock");
const guard = `${lock}.recovery`;
const controller = new AbortController();
const failure = (message: string) =>
  Object.assign(new Error(message), { code: "EIO" });
let entered = 0,
  injections = 0,
  releasing = false;
let foreign = "";
if (scenario.startsWith("guard") || scenario === "deadline")
  await io.writeFile(lock, `2147483647 ${randomUUID()}\n`);
if (scenario === "probe" || scenario === "acquire-read")
  await io.writeFile(lock, `${process.pid} ${randomUUID()}\n`);
const kill = process.kill;
if (scenario === "probe")
  process.kill = () => {
    injections++;
    throw Object.assign(new Error("probe"), { code: "EINVAL" });
  };
mock.module("node:fs/promises", () => ({
  ...io,
  writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (scenario === "publish-two" && injections === 0) {
      injections++;
      throw failure("write");
    }
    return io.writeFile(...args);
  },
  readFile: async (...args: Parameters<typeof fs.readFile>) => {
    if (
      args[0] === lock &&
      (scenario === "acquire-read" ||
        (releasing && scenario.startsWith("release-read")))
    ) {
      injections++;
      throw failure("read");
    }
    if (args[0] === lock && scenario === "guard-two" && injections === 0) {
      // Initial observation succeeds; the guarded second observation fails.
      injections++;
      return io.readFile(...args);
    }
    if (args[0] === lock && scenario === "guard-two") {
      injections++;
      throw failure("guard-read");
    }
    return io.readFile(...args);
  },
  stat: async (...args: Parameters<typeof fs.stat>) => {
    if (args[0] === lock && releasing && scenario === "release-read-stat") {
      injections++;
      throw failure("stat");
    }
    return io.stat(...args);
  },
  rename: async (...args: Parameters<typeof fs.rename>) => {
    if (scenario === "deadline")
      throw Object.assign(new Error("guard collision"), { code: "EEXIST" });
    return io.rename(...args);
  },
  readdir: async (...args: Parameters<typeof fs.readdir>) => {
    if (scenario === "deadline") {
      injections++;
      throw Object.assign(new Error("guard vanished"), { code: "ENOENT" });
    }
    return io.readdir(...args);
  },
  rm: async (path: string, options: Parameters<typeof fs.rm>[1]) => {
    if (
      (scenario === "publish-two" &&
        injections === 1 &&
        path.startsWith(`${lock}.marker-`)) ||
      (scenario === "guard-two" &&
        (path.startsWith(`${guard}/`) || path.startsWith(`${guard}-`))) ||
      (scenario === "release-read-unlink" && releasing && path === lock)
    ) {
      injections++;
      throw failure("remove");
    }
    if (
      scenario.startsWith("sibling-") &&
      path.startsWith(`${lock}.marker-`) &&
      injections === 0
    ) {
      injections++;
      if (scenario === "sibling-cancel")
        controller.abort(new Error("cancelled"));
      throw failure("sibling");
    }
    return io.rm(path, options);
  },
  rmdir: async (...args: Parameters<typeof fs.rmdir>) => {
    if (scenario === "guard-two" && args[0] === guard) {
      injections++;
      throw failure("rmdir");
    }
    return io.rmdir(...args);
  },
}));
const messages = (error: unknown): string[] =>
  error instanceof AggregateError
    ? error.errors.flatMap(messages)
    : error instanceof Error
      ? [
          error.message,
          ...(error.cause === undefined ? [] : messages(error.cause)),
        ]
      : [String(error)];
try {
  const { withFileLock, FileLocked } = await import("../../src/file-lock.ts");
  const start = Date.now();
  const error = await withFileLock(
    lock,
    async () => {
      entered++;
      if (scenario === "release-read-foreign" || scenario === "foreign") {
        await io.rename(lock, `${lock}.owned`);
        foreign = `${process.pid} ${randomUUID()}\n`;
        await io.writeFile(lock, foreign);
      }
      releasing = true;
      if (scenario === "sibling-work" || scenario === "release-read-work")
        throw new Error("work");
    },
    30,
    controller.signal,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const errors = error === undefined ? [] : messages(error);
  const exists = await io.stat(lock).then(
    () => true,
    () => false,
  );
  if (scenario.startsWith("release-read")) {
    if (!errors.includes("read") || entered !== 1)
      throw new Error("read error hidden");
    const stranded = [
      "release-read-stat",
      "release-read-unlink",
      "release-read-foreign",
    ].includes(scenario);
    if (exists !== stranded) throw new Error("unsafe fallback");
    if (scenario === "release-read-stat" && !errors.includes("stat"))
      throw new Error("stat error hidden");
    if (scenario === "release-read-unlink" && !errors.includes("remove"))
      throw new Error("unlink error hidden");
    if (scenario === "release-read-work" && !errors.includes("work"))
      throw new Error("work error hidden");
  } else if (scenario.startsWith("sibling-")) {
    if (exists || entered !== (scenario === "sibling-cancel" ? 0 : 1))
      throw new Error("sibling stranded owner");
    if (scenario === "sibling-work" && !errors.includes("work"))
      throw new Error("work lost");
    if (scenario === "sibling-cancel" && !errors.includes("cancelled"))
      throw new Error("cancellation lost");
  } else if (scenario === "publish-two") {
    if (
      injections !== 2 ||
      exists ||
      entered ||
      !errors.includes("write") ||
      !errors.includes("remove")
    )
      throw new Error("publication errors lost");
  } else if (scenario === "guard-two") {
    if (
      !exists ||
      entered ||
      !["guard-read", "remove", "rmdir"].every((message) =>
        errors.includes(message),
      ) ||
      errors.length !== 4
    )
      throw new Error("guard errors lost");
  } else if (scenario === "probe" || scenario === "deadline") {
    if (
      !(error instanceof FileLocked) ||
      entered ||
      !exists ||
      Date.now() - start > 1000
    )
      throw new Error("unbounded or unsafe recovery");
  } else if (scenario === "acquire-read") {
    if (!errors.includes("read") || entered || !exists)
      throw new Error("acquisition read lost");
  } else if (
    scenario === "foreign" &&
    (!exists || !errors.includes("Lock ownership was lost before release"))
  )
    throw new Error("foreign owner lost");
  if (foreign && (await io.readFile(lock, "utf8")) !== foreign)
    throw new Error("foreign marker changed");
  process.kill = kill;
  releasing = false;
  if (!exists)
    await withFileLock(
      lock,
      async () => {
        entered++;
      },
      30,
    );
  console.log(
    JSON.stringify({ injections, errors: errors.length, next: !exists }),
  );
} finally {
  process.kill = kill;
  mock.restore();
}
