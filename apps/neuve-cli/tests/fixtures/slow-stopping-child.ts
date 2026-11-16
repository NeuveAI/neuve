// A heavy child with no parent guard that takes a moment to stop, so only a worker that waits sees it gone.
const [pidFile] = Bun.argv.slice(2);
if (!pidFile) throw new Error("Missing pid file");
process.on("SIGTERM", () => setTimeout(() => process.exit(143), 500));
await Bun.write(pidFile, String(process.pid));
await new Promise(() => {});
