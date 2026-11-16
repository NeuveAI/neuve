// Why: `install:cli` puts the review desk beside the CLI, and replacing it must keep the install's
// ownership rule: only a desk Neuve installed is replaced, a damaged one is kept and named, and a
// folder that isn't a desk is never touched. Real folders under a scratch prefix, no build.
import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalCli } from "../scripts/install-local.ts";
import { readDesk } from "../src/review-desk-config.ts";
import { hashDesk } from "../src/review-desk-files.ts";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

/** A desk folder as build-desk.ts writes it, with `label` as its content. */
const fakeDesk = async (at: string, label: string, version = "0.1.0") => {
  await mkdir(join(at, "client"), { recursive: true });
  await mkdir(join(at, "server"), { recursive: true });
  await writeFile(join(at, "client/index.html"), label);
  await writeFile(
    join(at, "server/server.js"),
    `export default ${JSON.stringify(label)};`,
  );
  const sha256 = await hashDesk(at);
  await writeFile(
    join(at, "desk.json"),
    JSON.stringify({ schemaVersion: 1, base: "/", version, sha256 }),
  );
  return sha256;
};

const setting = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "install-desk-")));
  directories.push(root);
  const cli = join(root, "neuve");
  const graph = join(root, "entire-graph");
  await writeFile(cli, "cli");
  await writeFile(graph, "graph");
  const prefix = join(root, "prefix");
  const install = (desk: string) =>
    installLocalCli({
      cli,
      graph,
      desk,
      prefix,
      graphVersion: "fixture",
      graphWorkspaceRevision: null,
    });
  return { root, prefix, install, installed: join(prefix, "lib/neuve/desk") };
};

test("the desk is installed beside the CLI and replaced only when Neuve installed it", async () => {
  const { root, prefix, install, installed } = await setting();
  const first = await fakeDesk(join(root, "one/desk"), "one");
  const manifest = await install(join(root, "one/desk"));
  expect((await readDesk(installed, "0.1.0")).sha256).toBe(first);
  // The install record keeps main's shape: the desk is known by its own desk.json.
  expect(Object.keys(manifest)).not.toContain("desk");
  const second = await fakeDesk(join(root, "two/desk"), "two");
  await install(join(root, "two/desk"));
  expect((await readDesk(installed, "0.1.0")).sha256).toBe(second);
  // The intact desk it replaced is gone, and nothing is left beside the new one.
  expect((await readdir(join(prefix, "lib/neuve"))).sort()).toEqual([
    "desk",
    "entire-graph",
    "install.json",
  ]);
});

test("a damaged desk is kept beside the new one and named", async () => {
  const { root, prefix, install, installed } = await setting();
  await fakeDesk(join(root, "one/desk"), "one");
  await install(join(root, "one/desk"));
  await writeFile(join(installed, "client/index.html"), "changed by hand");
  const second = await fakeDesk(join(root, "two/desk"), "two");
  await install(join(root, "two/desk"));
  expect((await readDesk(installed, "0.1.0")).sha256).toBe(second);
  const kept = (await readdir(join(prefix, "lib/neuve"))).filter((name) =>
    name.startsWith("desk.replaced-"),
  );
  expect(kept).toHaveLength(1);
  expect(
    await readFile(
      join(prefix, "lib/neuve", kept[0]!, "client/index.html"),
      "utf8",
    ),
  ).toBe("changed by hand");
});

test("a folder that isn't a Neuve desk is refused and left as it was", async () => {
  const { root, install, installed } = await setting();
  await mkdir(join(installed, "client"), { recursive: true });
  await writeFile(join(installed, "client/mine"), "a person's file");
  await fakeDesk(join(root, "one/desk"), "one");
  await expect(install(join(root, "one/desk"))).rejects.toThrow(
    `Refusing to replace ${installed}: it isn't a review desk Neuve installed.`,
  );
  expect(await readdir(installed)).toEqual(["client"]);
  expect(await readFile(join(installed, "client/mine"), "utf8")).toBe(
    "a person's file",
  );
});

test("a desk whose files don't match its desk.json is refused before anything is installed", async () => {
  const { root, prefix, install } = await setting();
  await fakeDesk(join(root, "one/desk"), "one");
  await writeFile(
    join(root, "one/desk/client/index.html"),
    "changed after the build",
  );
  await expect(install(join(root, "one/desk"))).rejects.toThrow(
    "doesn't match its desk.json",
  );
  expect(
    await readdir(join(prefix, "lib/neuve")).catch(() => []),
  ).not.toContain("desk");
});

test("an install stopped half-way leaves nothing the next install keeps", async () => {
  const { root, prefix, install, installed } = await setting();
  const lib = join(prefix, "lib/neuve");
  await mkdir(join(lib, `desk.tmp-123-${crypto.randomUUID()}`, "client"), {
    recursive: true,
  });
  await fakeDesk(
    join(lib, `desk.replaced-2026-11-13T10-00-00Z-${crypto.randomUUID()}`),
    "old",
  );
  const sha256 = await fakeDesk(join(root, "one/desk"), "one");
  await install(join(root, "one/desk"));
  expect((await readDesk(installed, "0.1.0")).sha256).toBe(sha256);
  expect(
    (await readdir(lib)).filter((name) => name.startsWith("desk.")),
  ).toEqual([]);
});
