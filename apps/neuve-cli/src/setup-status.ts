import { realpath } from "node:fs/promises";
import { resolveStoreLocation } from "@neuve/records-core";
import { readInstallation } from "./installation.ts";
import { execute } from "./records-cli.ts";
import { gitAvailability, gitRefusal } from "./git-available.ts";

/**
 * Whether `neuve setup` ran in this repository, as doctor and the review commands decide it. State
 * that can't be read safely (a link, a relocated repository) counts as not set up: setup itself
 * then says what is wrong.
 */
export const repositorySetup = async (repository: string) =>
  readInstallation(repository).catch(() => undefined);

/** The refusal `neuve review` and `neuve review desk` print until setup has run. */
export const notSetUpMessage = (repository: string) =>
  `Neuve isn't set up in ${repository}.\nRun neuve setup there first.\n`;

/**
 * The repository's top level when Neuve is set up there; otherwise prints the refusal and returns
 * undefined, before any store or job is created. Outside Git it keeps review's own refusal.
 */
export const requireRepositorySetup = async (repository: string) => {
  // On a Mac without the command-line tools, git only opens Apple's installer.
  const available = gitAvailability();
  if (!available.usable) {
    await Bun.write(Bun.stderr, gitRefusal(available));
    return undefined;
  }
  const child = Bun.spawn(
    ["git", "-C", repository, "rev-parse", "--show-toplevel"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) {
    // Throws the same "not inside a git repository" refusal review gives today.
    await execute(resolveStoreLocation(repository));
    await Bun.write(
      Bun.stderr,
      "--repo must name a folder inside a Git working tree.\n",
    );
    return undefined;
  }
  const root = await realpath(stdout.trim());
  if ((await repositorySetup(root)) !== undefined) return root;
  await Bun.write(Bun.stderr, notSetUpMessage(root));
  return undefined;
};
