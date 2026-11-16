import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

const source = process.cwd();
for (const path of ["packages/split-tabs", "packages/ui", "apps/app"]) {
  const compiler = join(
    source,
    path,
    "node_modules/@typescript/native-preview/bin/tsgo.js",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      compiler,
      "--noEmit",
      ...(path === "packages/ui" ? ["--skipLibCheck"] : []),
    ],
    {
      cwd: join(source, path),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
const output = await mkdtemp("/tmp/ace-check-");
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
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
