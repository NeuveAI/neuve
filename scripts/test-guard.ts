import { watchLauncher } from "./test-process.ts";

// runTestProcess makes this guard the group leader. The command and its
// descendants stay in that group and receive the pool's signals together.
watchLauncher();
let signalExit: number | undefined;
process.on("SIGINT", () => {
  signalExit = 130;
});
process.on("SIGTERM", () => {
  signalExit = 143;
});
const child = Bun.spawn(Bun.argv.slice(2), {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const code = await child.exited;
process.exitCode = signalExit ?? code;
