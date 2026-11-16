import { homedir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

/**
 * The macOS launchd user agent (6.9, D19): it runs `neuve worker sweep` at login and every five
 * minutes, so queued work is picked up even when no hook fires. It is installed and removed only by
 * explicit commands, never as a side effect.
 */
export const AGENT_LABEL = "dev.neuve.worker";
export const SWEEP_INTERVAL_SECONDS = 300;

export const agentPlistPath = (home = homedir()) =>
  join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);

export const agentLogPath = (home = homedir()) =>
  join(home, "Library", "Logs", "neuve-worker-sweep.log");

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The agent's property list. `command` must be absolute: launchd runs it without a login shell. */
export const agentPlist = (options: {
  readonly command: ReadonlyArray<string>;
  readonly home?: string;
}) => {
  const log = escapeXml(agentLogPath(options.home));
  const args = [...options.command, "worker", "sweep"]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${SWEEP_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
};

export class LaunchctlFailed extends Data.TaggedError("LaunchctlFailed")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stderr: string;
}> {}

const launchctl = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(async () => {
      const child = Bun.spawn(["launchctl", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stderr, exitCode };
    });
    if (result.exitCode !== 0)
      return yield* new LaunchctlFailed({
        args,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
      });
  });

const domain = () => `gui/${process.getuid?.() ?? 0}`;

export interface AgentOptions {
  readonly home?: string;
  /** Also bootstrap or boot out the agent with launchctl; off only for a dry install into a temporary home. */
  readonly load: boolean;
}

/** Writes the plist, then (re)loads it into the user's launchd domain when `load` is set. */
export const installAgent = (
  options: AgentOptions & { readonly command: ReadonlyArray<string> },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = agentPlistPath(options.home);
    yield* fs.makeDirectory(join(path, ".."), { recursive: true });
    yield* fs.makeDirectory(join(agentLogPath(options.home), ".."), {
      recursive: true,
    });
    yield* fs.writeFileString(path, agentPlist(options));
    if (options.load) {
      yield* Effect.ignore(
        launchctl(["bootout", `${domain()}/${AGENT_LABEL}`]),
      );
      yield* launchctl(["bootstrap", domain(), path]);
    }
    return { path, loaded: options.load };
  });

/** Boots the agent out of launchd when `load` is set, then removes the plist. */
export const uninstallAgent = (options: AgentOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = agentPlistPath(options.home);
    if (options.load)
      yield* Effect.ignore(
        launchctl(["bootout", `${domain()}/${AGENT_LABEL}`]),
      );
    const existed = yield* fs.exists(path);
    if (existed) yield* fs.remove(path);
    return { path, removed: existed, unloaded: options.load };
  });
