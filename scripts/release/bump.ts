import { parseArgs } from "node:util";
import { resolve } from "node:path";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});
const release = positionals[0];
if (
  positionals.length !== 1 ||
  release === undefined ||
  !/^(major|minor|patch|\d+\.\d+\.\d+)$/.test(release)
)
  throw new Error(
    "Usage: bun scripts/release/bump.ts <major|minor|patch|x.y.z> [--dry-run]",
  );
const command = [
  "bunx",
  "bumpp@12.3.0",
  "package.json",
  "apps/neuve-cli/package.json",
  "--release",
  release,
  "--commit",
  "Release v{version}",
  "--tag",
  "v{version}",
  "--no-push",
  "--yes",
  "--ignore-scripts",
];
if (values["dry-run"]) {
  await Bun.write(Bun.stdout, `Dry run: ${JSON.stringify(command)}\n`);
} else {
  const child = Bun.spawn(command, {
    cwd: resolve(import.meta.dir, "../.."),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) process.exitCode = code;
}
await Bun.write(
  Bun.stdout,
  "After reviewing the commit and tag, push with: git push --follow-tags\n",
);
