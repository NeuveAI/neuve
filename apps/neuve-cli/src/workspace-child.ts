import { closeSync, openSync } from "node:fs";
import { z } from "zod";

export async function closeChild(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

const Ready = z.strictObject({
  kind: z.literal("review-ready"),
  url: z.string().url(),
});

/** Only the child knows its port. No request or port probe precedes this announcement. */
export async function announcedChild(options: {
  command: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  base: string;
  log: string;
  signal: AbortSignal;
  deadlineMs?: number;
}): Promise<{ child: Bun.Subprocess; url: string; log: string }> {
  options.signal.throwIfAborted();
  let announce: (value: unknown) => void = () => {};
  const ready = new Promise<string>((resolve, reject) => {
    announce = (value) => {
      const parsed = Ready.safeParse(value);
      if (!parsed.success)
        return reject(new Error("Invalid ready announcement"));
      const url = new URL(parsed.data.url);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== options.base ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return reject(new Error("Invalid ready address"));
      resolve(url.href);
    };
  });
  const output = openSync(options.log, "a", 0o600);
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: output,
      stderr: output,
      ipc: (value: unknown) => announce(value),
    });
  } catch (error) {
    throw new Error(`Project web app could not start. See ${options.log}`, {
      cause: error,
    });
  } finally {
    closeSync(output);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error("Workspace stopped before ready"));
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
    timer = setTimeout(
      () => reject(new Error("Project web app did not announce ready")),
      options.deadlineMs ?? 90_000,
    );
  });
  try {
    const url = await Promise.race([
      ready,
      interrupted,
      child.exited.then((code) => {
        throw new Error(`Project web app exited ${code} before ready`);
      }),
    ]);
    options.signal.throwIfAborted();
    if (child.exitCode !== null)
      throw new Error("Project web app stopped before ready");
    return { child, url, log: options.log };
  } catch (error) {
    await closeChild(child);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. See ${options.log}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
  }
}
