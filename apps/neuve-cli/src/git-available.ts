import { realpathSync } from "node:fs";

/**
 * Whether `git` can run here without side effects. On macOS without the Xcode command-line tools,
 * `/usr/bin/git` is a stub that opens Apple's installer instead of running, so nothing may call it
 * then: setup, review and doctor ask this first.
 */
export type GitAvailability =
  | { readonly usable: true; readonly git: string }
  | {
      readonly usable: false;
      readonly detail: string;
      readonly fix: string;
      /** Whether the Xcode command-line tools were found missing (macOS only). */
      readonly tools: boolean;
    };

const realOf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const toolsFix = "xcode-select --install";
const packageFix = "Install Git with your system's package manager";

/** Whether the Xcode command-line tools (or Xcode) are installed; `xcode-select -p` only reads. */
export const xcodeToolsPath = (): string | undefined => {
  try {
    const result = Bun.spawnSync(["xcode-select", "-p"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
};

export const gitAvailability = (
  platform: NodeJS.Platform = process.platform,
): GitAvailability => {
  const git = Bun.which("git");
  if (git === null)
    return {
      usable: false,
      detail: "Git isn't on PATH",
      fix: platform === "darwin" ? toolsFix : packageFix,
      tools: false,
    };
  if (
    platform === "darwin" &&
    (git === "/usr/bin/git" || realOf(git) === "/usr/bin/git") &&
    xcodeToolsPath() === undefined
  )
    return {
      usable: false,
      detail: "Git needs the Xcode command-line tools, which aren't installed",
      fix: toolsFix,
      tools: true,
    };
  return { usable: true, git };
};

/** What a command prints when Git can't run, before it has touched anything. */
export const gitRefusal = (availability: GitAvailability) =>
  availability.usable
    ? ""
    : `Neuve needs Git, and ${availability.detail.replace(/^Git /, "it ")}.\nTo fix it: ${availability.fix}\n`;
