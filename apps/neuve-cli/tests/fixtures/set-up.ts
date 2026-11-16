import { writeInstallation } from "../../src/installation.ts";

/**
 * Records `neuve setup` in a test repository with setup's own writer, without its Graph index: the
 * review commands refuse a repository until setup has run there (setup-status.ts). The CLI and
 * engine it names default to this process and a path nothing runs.
 */
export const markSetUp = async (
  repository: string,
  binaries: Readonly<{ cliBinary: string; graphBinary: string }> = {
    cliBinary: process.execPath,
    graphBinary: "/nonexistent/entire-graph",
  },
) => writeInstallation(repository, binaries);
