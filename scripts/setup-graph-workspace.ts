import { resolve } from "node:path";
import { realpath } from "node:fs/promises";

export type GraphWorkspaceContract = Readonly<{
  originUrl: string;
  upstreamUrl: string;
  upstreamPushUrl: "DISABLED";
  baselineTag: string;
  baselineRevision: string;
}>;

export const NEUVE_GRAPH_WORKSPACE_CONTRACT = {
  originUrl: "https://github.com/NeuveAI/neuve-graph.git",
  upstreamUrl: "https://github.com/entireio/entire-graph.git",
  upstreamPushUrl: "DISABLED",
  baselineTag: "neuve-upstream-baseline-2026-09-27",
  baselineRevision: "5637039f7da7c8f35726eec22c230491a3f90b9f",
} satisfies GraphWorkspaceContract;

// Existing SSH clones keep their transport. SSH users cloning HTTPS URLs can
// also set url."git@github.com:".insteadOf to "https://github.com/".
const comparableUrl = (url: string): string =>
  url.replace(
    /^(git@github\.com:|ssh:\/\/git@github\.com\/)/,
    "https://github.com/",
  );

type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

const runGit = async (
  repository: string,
  args: readonly string[],
): Promise<CommandResult> => {
  const child = Bun.spawn(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
};

const successfulGit = async (
  repository: string,
  args: readonly string[],
  label: string,
): Promise<string> => {
  const result = await runGit(repository, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${result.stderr || result.stdout || `git exited ${result.exitCode}`}`,
    );
  }
  return result.stdout;
};

export const configureGraphWorkspace = async (
  input: Readonly<{
    repository: string;
    contract: GraphWorkspaceContract;
  }>,
): Promise<void> => {
  const repository = await realpath(resolve(input.repository));
  const repositoryRoot = await realpath(
    await successfulGit(
      repository,
      ["rev-parse", "--show-toplevel"],
      "Graph repository lookup",
    ),
  );
  if (repositoryRoot !== repository) {
    throw new Error(
      `Graph repository must be its Git top level: ${repositoryRoot}.`,
    );
  }

  const originUrl = await successfulGit(
    repository,
    ["config", "--get", "remote.origin.url"],
    "Graph origin lookup",
  );
  if (comparableUrl(originUrl) !== comparableUrl(input.contract.originUrl)) {
    throw new Error(
      `Graph origin URL must be ${input.contract.originUrl}; found ${originUrl}.`,
    );
  }

  const remotes = (
    await successfulGit(repository, ["remote"], "Graph remote listing")
  )
    .split("\n")
    .filter(Boolean);
  if (remotes.includes("upstream")) {
    const upstreamUrl = await successfulGit(
      repository,
      ["config", "--get", "remote.upstream.url"],
      "Graph upstream lookup",
    );
    if (
      comparableUrl(upstreamUrl) !== comparableUrl(input.contract.upstreamUrl)
    )
      await successfulGit(
        repository,
        ["remote", "set-url", "upstream", input.contract.upstreamUrl],
        "Graph upstream update",
      );
  } else {
    await successfulGit(
      repository,
      ["remote", "add", "upstream", input.contract.upstreamUrl],
      "Graph upstream creation",
    );
  }
  await successfulGit(
    repository,
    [
      "config",
      "--replace-all",
      "remote.upstream.pushurl",
      input.contract.upstreamPushUrl,
    ],
    "Graph upstream push disablement",
  );

  const [configuredUpstream, configuredPush, tagType, tagTarget] =
    await Promise.all([
      successfulGit(
        repository,
        ["config", "--get", "remote.upstream.url"],
        "Configured upstream lookup",
      ),
      successfulGit(
        repository,
        ["remote", "get-url", "--push", "upstream"],
        "Configured upstream push lookup",
      ),
      successfulGit(
        repository,
        ["cat-file", "-t", `refs/tags/${input.contract.baselineTag}`],
        "Graph baseline tag lookup",
      ),
      successfulGit(
        repository,
        ["rev-parse", `${input.contract.baselineTag}^{commit}`],
        "Graph baseline target lookup",
      ),
    ]);
  if (
    comparableUrl(configuredUpstream) !==
    comparableUrl(input.contract.upstreamUrl)
  ) {
    throw new Error("Configured Graph upstream fetch URL did not persist.");
  }
  if (configuredPush !== input.contract.upstreamPushUrl) {
    throw new Error("Configured Graph upstream push URL is not disabled.");
  }
  if (tagType !== "tag") {
    throw new Error(
      `Graph baseline ${input.contract.baselineTag} must be an annotated tag.`,
    );
  }
  if (tagTarget !== input.contract.baselineRevision) {
    throw new Error(
      `Graph baseline tag must target ${input.contract.baselineRevision}; found ${tagTarget}.`,
    );
  }
  const ancestry = await runGit(repository, [
    "merge-base",
    "--is-ancestor",
    input.contract.baselineRevision,
    "HEAD",
  ]);
  if (ancestry.exitCode !== 0) {
    throw new Error(
      `Graph HEAD must descend from ${input.contract.baselineRevision}.`,
    );
  }
};

const main = async (): Promise<void> => {
  if (Bun.argv.length !== 2) {
    throw new Error("Usage: bun run setup:graph");
  }
  const repository = resolve(import.meta.dir, "../apps/neuve-graph");
  await configureGraphWorkspace({
    repository,
    contract: NEUVE_GRAPH_WORKSPACE_CONTRACT,
  });
  await Bun.write(
    Bun.stdout,
    `Neuve Graph workspace configured and verified at ${repository}.\n`,
  );
};

if (import.meta.main) {
  await main();
}
