import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

// This module is loaded only by the external evaluator through Bun's runtime
// preload option. It observes invocation; it does not replace the executable.
const configurationText = process.env.NEUVE_EVALUATION_GRAPH_OBSERVER;
if (configurationText !== undefined) {
  const configuration: unknown = JSON.parse(configurationText);
  if (
    typeof configuration !== "object" ||
    configuration === null ||
    !("engineBinary" in configuration) ||
    typeof configuration.engineBinary !== "string" ||
    !("sha256" in configuration) ||
    typeof configuration.sha256 !== "string" ||
    !("log" in configuration) ||
    typeof configuration.log !== "string" ||
    !("ownedRoot" in configuration) ||
    typeof configuration.ownedRoot !== "string"
  ) {
    throw new Error("Evaluation graph observer configuration is malformed.");
  }
  const { engineBinary, sha256, log, ownedRoot } = configuration;
  const spawnSync = Bun.spawnSync.bind(Bun);
  const identify = (argumentsList: readonly unknown[]) => {
    const invocation = argumentsList[0];
    const command = Array.isArray(invocation)
      ? invocation
      : typeof invocation === "object" &&
          invocation !== null &&
          "cmd" in invocation
        ? invocation.cmd
        : undefined;
    if (
      !Array.isArray(command) ||
      !command.every((item) => typeof item === "string")
    )
      return undefined;
    const executable = command[0];
    if (typeof executable !== "string") return undefined;
    const path = isAbsolute(executable) ? executable : Bun.which(executable);
    if (path === null) return undefined;
    let actualSha256: string;
    try {
      actualSha256 = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    } catch {
      return undefined;
    }
    if (actualSha256 !== sha256) return undefined;
    const argv: string[] = command;
    const repoIndex = argv.indexOf("--repo");
    const repository = repoIndex < 0 ? undefined : argv[repoIndex + 1];
    let repositoryRevision: string | undefined;
    let repositoryOwned: boolean | undefined;
    if (repository !== undefined) {
      const revision = spawnSync(
        ["git", "-C", repository, "rev-parse", "HEAD"],
        { stdout: "pipe", stderr: "pipe" },
      );
      repositoryRevision = revision.stdout.toString().trim();
      try {
        const scope = relative(
          realpathSync(ownedRoot),
          realpathSync(repository),
        );
        repositoryOwned =
          scope !== ".." && !scope.startsWith(`..${sep}`) && !isAbsolute(scope);
      } catch {
        repositoryOwned = false;
      }
    }
    return {
      target: engineBinary,
      executable: path,
      executable_sha256: actualSha256,
      argv: argv.slice(1),
      ...(repository === undefined
        ? {}
        : {
            repository,
            repository_revision: repositoryRevision,
            repository_owned: repositoryOwned,
          }),
    };
  };
  const record = (
    invocation: ReturnType<typeof identify>,
    exitCode: number | null,
  ): void => {
    if (invocation === undefined) return;
    appendFileSync(
      log,
      `${JSON.stringify({ ...invocation, exit_code: exitCode })}\n`,
    );
  };
  Bun.spawn = new Proxy(Bun.spawn, {
    apply(target, thisArgument, argumentsList) {
      const invocation = identify(argumentsList);
      const child: ReturnType<typeof Bun.spawn> = Reflect.apply(
        target,
        thisArgument,
        argumentsList,
      );
      if (invocation !== undefined)
        void child.exited.then((exitCode) => record(invocation, exitCode));
      return child;
    },
  });
  Bun.spawnSync = new Proxy(Bun.spawnSync, {
    apply(target, thisArgument, argumentsList) {
      const invocation = identify(argumentsList);
      const child: ReturnType<typeof Bun.spawnSync> = Reflect.apply(
        target,
        thisArgument,
        argumentsList,
      );
      record(invocation, child.exitCode);
      return child;
    },
  });
}
