import type { CommandEvidence } from "./external-validation-report.ts";

export type BuildCommandRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<CommandEvidence>;

const requireSuccess = (result: CommandEvidence, label: string): void => {
  if (result.exit_code !== 0) {
    throw new Error(
      `${label} exited with ${result.exit_code}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
};

export const buildNeuveFromFrozenWorkspace = async (input: {
  run: BuildCommandRunner;
  source: string;
  outputArgument: string;
  binary: string;
  signingCwd: string;
}): Promise<readonly CommandEvidence[]> => {
  const evidence: CommandEvidence[] = [];
  const install = await input.run(
    ["bun", "install", "--frozen-lockfile"],
    input.source,
  );
  evidence.push(install);
  requireSuccess(install, "Neuve frozen dependency install");

  const build = await input.run(
    [
      "bun",
      "build",
      "./apps/neuve-cli/src/cli.ts",
      "--compile",
      "--silent",
      "--outfile",
      input.outputArgument,
    ],
    input.source,
  );
  evidence.push(build);
  requireSuccess(build, "Neuve build");

  if (process.platform === "darwin") {
    const signing = await input.run(
      ["codesign", "--force", "--sign", "-", input.binary],
      input.signingCwd,
    );
    evidence.push(signing);
    requireSuccess(signing, "Neuve ad-hoc signing");
  }
  return evidence;
};
