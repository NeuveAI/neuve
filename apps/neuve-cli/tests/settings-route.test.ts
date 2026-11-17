// Why: `neuve setup --route` writes the one settings file every review reads. It must change only
// `review.route`, never overwrite a file it can't read, and never write a route the harness's
// settings schema would refuse. Real files in a scratch home; the owner's settings are never read.
import { afterAll, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { settingsPath } from "../../../packages/harness/src/settings.ts";
import {
  RouteRefused,
  settingsRoute,
  SettingsUnreadable,
  writeRoute,
} from "../src/settings-route.ts";

const homes: string[] = [];
afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});
const scratchHome = async (contents?: string) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "neuve-route-")));
  homes.push(home);
  const path = settingsPath(home);
  if (contents !== undefined) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return { home, path };
};

test("a settings file with other keys keeps every byte but the route", async () => {
  const original = `{
    "version": 1,
  "telemetry":{"enabled":false},
  "review": { "effort": "high",   "route": "anthropic" }
}
`;
  const { home, path } = await scratchHome(original);
  await writeRoute("openai", home);
  expect(await readFile(path, "utf8")).toBe(
    original.replace('"route": "anthropic"', '"route": "openai"'),
  );
  expect(await settingsRoute(home)).toBe("openai");
});

test("a route is added where none was set, and nothing else moves", async () => {
  const withReview = `{"version": 1, "review": {"effort": "low"}}\n`;
  const first = await scratchHome(withReview);
  await writeRoute("openai", first.home);
  expect(await readFile(first.path, "utf8")).toBe(
    `{"version": 1, "review": {"route": "openai", "effort": "low"}}\n`,
  );
  const withoutReview = `{\n  "version": 1\n}\n`;
  const second = await scratchHome(withoutReview);
  await writeRoute("anthropic", second.home);
  expect(await readFile(second.path, "utf8")).toBe(
    `{\n  "version": 1, "review": {"route": "anthropic"}\n}\n`,
  );
  // No file: one holding only the route.
  const none = await scratchHome();
  await writeRoute("openai", none.home);
  expect(JSON.parse(await readFile(none.path, "utf8"))).toEqual({
    version: 1,
    review: { route: "openai" },
  });
});

test("a file setup can't read is refused and left byte for byte", async () => {
  for (const unreadable of [
    "{ not json",
    `{"version": 2, "review": {"route": "openai"}}`,
    `{"version": 1, "mystery": true}`,
  ]) {
    const { home, path } = await scratchHome(unreadable);
    await expect(writeRoute("openai", home)).rejects.toBeInstanceOf(
      SettingsUnreadable,
    );
    expect(await readFile(path, "utf8")).toBe(unreadable);
  }
});

test("a route over an existing one changes it; a route the schema refuses writes nothing", async () => {
  const original = `{"version": 1, "review": {"route": "openai"}}\n`;
  const { home, path } = await scratchHome(original);
  await writeRoute("anthropic", home);
  expect(await settingsRoute(home)).toBe("anthropic");
  const before = await readFile(path, "utf8");
  for (const invalid of ["chatgpt", "OPENAI", ""])
    await expect(writeRoute(invalid, home)).rejects.toBeInstanceOf(
      RouteRefused,
    );
  expect(await readFile(path, "utf8")).toBe(before);
  // No file and a refused route: still no file. An added account's name is not a route.
  const none = await scratchHome();
  await expect(writeRoute("work", none.home)).rejects.toBeInstanceOf(
    RouteRefused,
  );
  expect(await Bun.file(none.path).exists()).toBe(false);
});

// Why: `neuve setup --route claude` is how a Claude subscriber skips `--route claude` on every
// review; the harness's own schema must take what setup writes.
test("the Claude route is written and read back like the others", async () => {
  const { home, path } = await scratchHome();
  await writeRoute("claude", home);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    version: 1,
    review: { route: "claude" },
  });
  expect(await settingsRoute(home)).toBe("claude");
});

// Why: settings kept in a dotfiles folder reach the settings path through a link. Renaming over
// the path replaced the link with a plain file and left the real one stale.
test("a linked settings file is written through the link, which stays; a link to no file of yours is refused", async () => {
  const { home, path } = await scratchHome();
  const dotfiles = join(home, "dotfiles");
  await mkdir(dotfiles);
  const real = join(dotfiles, "neuve-settings.json");
  await writeFile(real, '{"version": 1}\n');
  await chmod(real, 0o644);
  await mkdir(dirname(path), { recursive: true });
  await symlink(real, path);
  await writeRoute("openai", home);
  expect(await readlink(path)).toBe(real);
  expect(await readFile(real, "utf8")).toBe(
    '{"version": 1, "review": {"route": "openai"}}\n',
  );
  expect((await lstat(real)).mode & 0o777).toBe(0o644);
  expect(await settingsRoute(home)).toBe("openai");
  expect(await readdir(dotfiles)).toEqual(["neuve-settings.json"]);
  expect(await readdir(dirname(path))).toEqual(["settings.json"]);
  // A link to nothing, or to a folder, is refused and left as it was.
  for (const target of [join(home, "gone.json"), dotfiles]) {
    await rm(path);
    await symlink(target, path);
    await expect(writeRoute("anthropic", home)).rejects.toBeInstanceOf(
      SettingsUnreadable,
    );
    expect(await readlink(path)).toBe(target);
  }
  expect(await readFile(real, "utf8")).toContain('"route": "openai"');
});
