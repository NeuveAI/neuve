// Bun 1.4.0 can lose a synchronous child's exit during test I/O and spin past the test timeout.
// Keep fixture processes asynchronous, drain both pipes, and bound them before their test expires.
export const runProcess = async (
  command: string[],
  options: { env?: NodeJS.ProcessEnv; timeout: number },
) => {
  const child = Bun.spawn(command, {
    ...options,
    env: options.env ?? { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
};
