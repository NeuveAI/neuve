import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesk, refuseSharedOutput } from "../scripts/build-desk.ts";
import { liveDesk } from "../src/review-desk-claim.ts";
import { hashDesk } from "../src/review-desk-files.ts";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});
const scratch = async (name: string) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), name)));
  directories.push(directory);
  return directory;
};

// Why: each desk folder belongs to one caller, so an existing output is refused before any build
// runs, and nothing is written beside it.
test("a desk build refuses an output that already exists, before building", async () => {
  const root = await scratch("desk-out-");
  const out = join(root, "desk");
  await mkdir(out);
  await writeFile(join(out, "kept"), "someone else's");
  let built = false;
  await expect(
    buildDesk({
      out,
      run: async () => {
        built = true;
        return { code: 0 };
      },
    }),
  ).rejects.toThrow(`${out} already exists`);
  expect(built).toBe(false);
  expect((await readdir(root)).sort()).toEqual(["desk"]);
  expect(await readdir(out)).toEqual(["kept"]);
});

// Why: a failed web build leaves no desk and no staging folder at the output.
test("a failed web build leaves nothing at the output", async () => {
  const root = await scratch("desk-fail-");
  const out = join(root, "nested", "desk");
  await expect(
    buildDesk({ out, scratch: root, run: async () => ({ code: 3 }) }),
  ).rejects.toThrow("The review desk's web build exited 3.");
  expect(await readdir(join(root, "nested"))).toEqual([]);
  expect((await readdir(root)).sort()).toEqual(["nested"]);
});

// Why: no standalone build may write the shared installed copy (12.24), by any spelling of it.
test("a standalone desk build refuses the shared copy", () => {
  const home = process.env["HOME"] ?? "";
  expect(() => refuseSharedOutput(join(home, ".local/lib/neuve/desk"))).toThrow(
    "Refusing to build the review desk inside the shared copy",
  );
  expect(() => refuseSharedOutput(join(tmpdir(), "desk"))).not.toThrow();
});

// Why: a link that lands in the shared copy is the shared copy too.
test("a standalone desk build refuses a link into the shared copy", async () => {
  // The link may dangle: where it points decides, and nothing is created there.
  const shared = join(process.env["HOME"] ?? "", ".local");
  const root = await scratch("desk-alias-");
  await symlink(shared, join(root, "alias"));
  expect(() => refuseSharedOutput(join(root, "alias/lib/neuve/desk"))).toThrow(
    "Refusing to build the review desk inside the shared copy",
  );
});

// Why: the build takes minutes, so the output's folder can become a link into the shared copy after
// the first check; the guard runs again before the desk is first written, and nothing lands there.
test("a desk build refuses an output whose folder became a link into the shared copy meanwhile", async () => {
  const shared = join(process.env["HOME"] ?? "", ".local/lib/neuve");
  const root = await scratch("desk-swap-");
  const out = join(root, "parent", "desk");
  await mkdir(join(root, "parent"));
  expect(() => refuseSharedOutput(out)).not.toThrow();
  await expect(
    buildDesk({
      out,
      scratch: root,
      guard: refuseSharedOutput,
      run: async () => {
        await rename(join(root, "parent"), join(root, "moved"));
        await symlink(shared, join(root, "parent"));
        return { code: 0 };
      },
    }),
  ).rejects.toThrow("Refusing to build the review desk inside the shared copy");
  expect((await readdir(root)).sort()).toEqual(["moved", "parent"]);
  expect(await readdir(join(root, "moved"))).toEqual([]);
});

// Why: the desk's identity covers every asset's name and bytes, while desk.json can't hash itself.
test("the desk hash leaves out desk.json and covers every asset name and byte", async () => {
  const root = await scratch("desk-hash-");
  await mkdir(join(root, "client"));
  await writeFile(join(root, "client/a"), "a");
  const first = await hashDesk(root);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  await writeFile(join(root, "desk.json"), "metadata");
  expect(await hashDesk(root)).toBe(first);
  await writeFile(join(root, "client/a"), "b");
  const changed = await hashDesk(root);
  expect(changed).not.toBe(first);
  await writeFile(join(root, "client/b"), "b");
  await rm(join(root, "client/a"));
  expect(await hashDesk(root)).not.toBe(changed);
  await Bun.$`ln -s ${join(root, "client/b")} ${join(root, "client/link")}`.quiet();
  await expect(hashDesk(root)).rejects.toThrow("is not a regular file");
});

// Why: an unreadable desk socket must never turn an admitted review into a failed request.
test("a live desk is read only from a well-formed loopback address", async () => {
  const root = await scratch("desk-replies-");
  const path = join(root, "desk.sock");
  const serve = async (
    reply: string | undefined,
    check: () => Promise<void>,
  ) => {
    const clients = new Set<Socket>();
    const listener = createServer((socket) => {
      clients.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => clients.delete(socket));
      if (reply !== undefined) socket.end(reply);
    });
    try {
      await new Promise<void>((resolve) => listener.listen(path, resolve));
      await check();
    } finally {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  };
  for (const reply of [
    "http://127.0.0.1:99999/\n",
    "http://127.0.0.1:0/\n",
    "http://127.0.0.1:65536/\n",
    "http://foreign.invalid:4141/\n",
    "not an address\n",
    "x".repeat(1025),
    "http://127.0.0.1:4141/",
    "",
    undefined,
  ])
    await serve(reply, async () => {
      expect(await liveDesk(path, 25)).toBeUndefined();
    });
  expect(await liveDesk(join(root, "absent.sock"))).toBeUndefined();
  for (const port of [1, 4141, 65535])
    await serve(`http://127.0.0.1:${port}/\n`, async () => {
      expect(await liveDesk(path)).toBe(`http://127.0.0.1:${port}/`);
    });
});
