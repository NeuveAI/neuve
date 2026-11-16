// Stands in for a worker: starts the real child with piped output, as `runPreparationChild` does, and relays it.
const child = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    `${import.meta.dir}/../../src/cli.ts`,
    ...Bun.argv.slice(2),
    // A worker from before a reinstall names no one.
    ...(process.env.PREPARATION_PARENT_UNNAMED === "1"
      ? []
      : ["--parent-pid", String(process.pid)]),
  ],
  {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  },
);
console.log(`child ${child.pid}`);
const decoder = new TextDecoder();
for await (const part of child.stdout)
  process.stdout.write(decoder.decode(part));
await new Promise(() => {});
