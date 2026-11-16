import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultStorageProfile,
  localStorageProfile,
  readStorageProfile,
  PI_TRANSITION_STORAGE_PROFILE,
  StorageProfile,
  validateStorageProfile,
  prepareStorage,
  validateWorkspaceProject,
} from "../scripts/pi-storage.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "local-storage-")));
afterAll(() => rm(root, { recursive: true, force: true }));
const git = (path: string, ...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-C",
      path,
      ...args,
    ],
    {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};
let serial = 0;
const fixture = async () => {
  const base = join(root, String(++serial)),
    source = join(base, "source");
  await mkdir(source, { recursive: true });
  git(source, "init", "-q");
  git(source, "commit", "--allow-empty", "-qm", "first");
  const profile = await localStorageProfile(source, join(base, "home"));
  return { base, source, profile };
};
// Why: selection must stay stable even when LaCie is absent, and explicit choices must win.
test("default selection depends on declared source paths, with explicit profiles preserved", async () => {
  const paths = PI_TRANSITION_STORAGE_PROFILE.paths;
  expect(defaultStorageProfile(paths.canonicalClone)).toBe("pi-transition");
  expect(defaultStorageProfile(join(paths.worktrees, "lane/impl"))).toBe(
    "pi-transition",
  );
  expect(defaultStorageProfile(`${paths.worktrees}-other`)).toBe("local");
  const { source, profile } = await fixture();
  expect(defaultStorageProfile(source)).toBe("local");
  const home = join(root, "explicit-home");
  expect((await readStorageProfile(source, "local", home)).paths.state).toBe(
    (await localStorageProfile(source, home)).paths.state,
  );
  expect((await localStorageProfile(source, home, "linux")).paths.state).toBe(
    join(home, ".local/state/neuve/workspace/state"),
  );
  expect((await localStorageProfile(source, home, "darwin")).paths.state).toBe(
    join(home, "Library/Application Support/Neuve/workspace/state"),
  );
  expect(await readStorageProfile(source, "pi-transition")).toEqual(
    PI_TRANSITION_STORAGE_PROFILE,
  );
  const file = join(root, "pinned.json");
  await writeFile(file, JSON.stringify(PI_TRANSITION_STORAGE_PROFILE));
  expect(await readStorageProfile(source, file)).toEqual(
    PI_TRANSITION_STORAGE_PROFILE,
  );
  expect((await readStorageProfile(paths.canonicalClone, file)).volume).toEqual(
    PI_TRANSITION_STORAGE_PROFILE.volume,
  );
  expect(
    StorageProfile.safeParse({ paths: { ...profile.paths, tmp: "relative" } })
      .success,
  ).toBe(false);
});
// Why: local uses the main worktree as authority without confining projects to a device.
test("local paths use the temporary home, skip the volume probe, and admit linked source checkouts", async () => {
  const { base, source, profile } = await fixture();
  const linked = join(base, "elsewhere", "linked");
  await mkdir(dirname(linked), { recursive: true });
  git(source, "worktree", "add", "-qb", "lane", linked);
  const local = await localStorageProfile(linked, join(base, "home"));
  expect(local.sourceCheckout).toBe(linked);
  expect(local.paths.canonicalClone).toBe(source);
  expect(local.paths.worktrees).toBe(profile.paths.worktrees);
  await expect(
    validateStorageProfile(profile, { checkout: linked }),
  ).rejects.toMatchObject({ reason: "checkout-outside-profile" });
  const storage = await validateStorageProfile(local, {
    checkout: linked,
    probe: async () => {
      throw new Error("must not probe");
    },
  });
  expect(storage.volume).toBeUndefined();
  expect((await prepareStorage(storage)).paths.state).toBe(profile.paths.state);
});
// Why: optional volume checks must not weaken filesystem or repository safety.
test("local keeps malformed paths, dangling links, writable checkout, and Git refusals", async () => {
  const { base, source, profile } = await fixture();
  const validate = (
    paths: Partial<StorageProfile["paths"]>,
    checkout?: string,
  ) =>
    validateStorageProfile(
      { paths: { ...profile.paths, ...paths } },
      checkout === undefined ? {} : { checkout },
    );
  const dangling = join(base, "dangling");
  await symlink(join(base, "absent"), dangling);
  await expect(validate({ tmp: dangling })).rejects.toMatchObject({
    reason: "path-dangling-link",
  });
  const file = join(base, "file");
  await writeFile(file, "file");
  await expect(validate({ tmp: file })).rejects.toMatchObject({
    reason: "path-not-directory",
  });
  await expect(
    validate({ state: join(source, "state") }),
  ).rejects.toMatchObject({ reason: "path-inside-checkout" });
  const nongit = join(base, "nongit");
  await mkdir(nongit);
  await expect(validate({ canonicalClone: nongit })).rejects.toMatchObject({
    reason: "not-a-git-top-level",
  });
  await expect(validate({}, nongit)).rejects.toMatchObject({
    reason: "checkout-outside-profile",
  });
  await mkdir(profile.paths.worktrees, { recursive: true });
  const foreign = join(profile.paths.worktrees, "foreign");
  await mkdir(foreign);
  git(foreign, "init", "-q");
  await expect(validate({}, foreign)).rejects.toMatchObject({
    reason: "checkout-foreign-repository",
  });
});
// Why: restricted shells and malformed plist output must name the failed command, not leak JSON parsing.
test("the volume probe reports command failures as volume-probe-failed", async () => {
  const bin = join(root, "probe-bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "diskutil"),
    "#!/bin/sh\necho 'The probe is restricted'\n",
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "plutil"),
    "#!/bin/sh\necho 'The conversion failed'\n",
    { mode: 0o700 },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { diskutilVolumeProbe } from ${JSON.stringify(join(import.meta.dir, "../scripts/pi-storage.ts"))}; try { await diskutilVolumeProbe('/'); } catch (error) { console.log(JSON.stringify({ reason: error.reason, message: error.message })); }`,
    ],
    { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe" },
  );
  const text = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(text)).toMatchObject({ reason: "volume-probe-failed" });
  expect(JSON.parse(text).message).toContain("plutil -convert json -o - -");
  expect(JSON.parse(text).message).toContain("The conversion failed");
});

// Why: projects and their Git common directories may live outside the source or storage device.
test("the local profile accepts projects anywhere and still requires a Git top level", async () => {
  const { profile } = await fixture();
  const project = await realpath(await mkdtemp("/tmp/neuve-external-project-"));
  try {
    git(project, "init", "-q");
    const storage = await validateStorageProfile(profile);
    expect(await validateWorkspaceProject(project, storage)).toBe(project);
    const nested = join(project, "nested");
    await mkdir(nested);
    await expect(
      validateWorkspaceProject(nested, storage),
    ).rejects.toMatchObject({ reason: "not-a-git-top-level" });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
