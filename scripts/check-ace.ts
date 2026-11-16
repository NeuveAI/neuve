import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readStorageProfile,
  StorageProfile,
  prepareStorage,
  spawnEnvironment,
  validateStorageProfile,
} from "./pi-storage.ts";

const source = resolve(import.meta.dirname, "..");
const supplied = process.env.NEUVE_WORKSPACE_PROFILE;
const profile = supplied
  ? StorageProfile.parse(JSON.parse(supplied))
  : await readStorageProfile(source);
const storage = await prepareStorage(
  await validateStorageProfile(profile, { checkout: source }),
);
for (const path of ["packages/split-tabs", "packages/ui", "apps/app"]) {
  const compiler = join(
    source,
    path,
    "node_modules/@typescript/native-preview/bin/tsgo.js",
  );
  const typecheck = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      compiler,
      "--noEmit",
      ...(path === "packages/ui" ? ["--skipLibCheck"] : []),
    ],
    {
      cwd: join(source, path),
      env: spawnEnvironment(storage, process.env),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const status = await typecheck.exited;
  if (status !== 0) process.exit(status);
}
const output = await mkdtemp(join(storage.paths.builds, "ace-check-"));
const child = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    "--bun",
    resolve(source, "apps/app/node_modules/vite/bin/vite.js"),
    "build",
    "--outDir",
    output,
  ],
  {
    cwd: join(source, "apps/app"),
    env: spawnEnvironment(storage, process.env),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
