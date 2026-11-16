import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { repositoryFingerprint } from "../src/repository-fingerprint.ts";

type Mutation = Readonly<{
  name: string;
  file: string;
  search: string;
  replacement: string;
  fullTestName: string;
  testCommand: readonly string[];
}>;

const repository = resolve(import.meta.dir, "../../..");

const run = async (command: readonly string[], cwd: string) => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
};

const mutations: readonly Mutation[] = [
  {
    name: "public response drops declared provider capabilities",
    file: "apps/neuve-cli/src/graph-query.ts",
    search: "  file_extensions: value.supportedFileExtensions,",
    replacement: "  file_extensions: [],",
    fullTestName:
      "neuve CLI boundary > sends the unchanged question and explicit plan to Graph",
    testCommand: [
      "bun",
      "test",
      "apps/neuve-cli/tests/cli.test.ts",
      "--test-name-pattern",
      "sends the unchanged question and explicit plan",
    ],
  },
  {
    name: "public response fabricates requested relation",
    file: "apps/neuve-cli/src/graph-query.ts",
    search:
      "  direction: value.direction,\n  relation: value.relation,\n  from: endpoint(value.from),",
    replacement:
      '  direction: value.direction,\n  relation: "CALLS",\n  from: endpoint(value.from),',
    fullTestName:
      "neuve CLI boundary > sends the unchanged question and explicit plan to Graph",
    testCommand: [
      "bun",
      "test",
      "apps/neuve-cli/tests/cli.test.ts",
      "--test-name-pattern",
      "sends the unchanged question and explicit plan",
    ],
  },
  {
    name: "public boundary ignores missing explicit provider",
    file: "apps/neuve-cli/src/graph-query.ts",
    search: "    if (!(await isExecutableFile(override))) {",
    replacement: "    if (false) {",
    fullTestName:
      "neuve CLI boundary > does not fall back when the explicit graph binary is unavailable",
    testCommand: [
      "bun",
      "test",
      "apps/neuve-cli/tests/cli.test.ts",
      "--test-name-pattern",
      "does not fall back",
    ],
  },
  {
    name: "relationship evaluator accepts missing call-site evidence",
    file: "packages/evaluation/src/external-validation-stages.ts",
    search: "  return observation.evidence.some(({ kind, location }) => {",
    replacement:
      "  return true || observation.evidence.some(({ kind, location }) => {",
    fullTestName:
      "combined external graph stage > maps independent missing-evidence outcomes",
    testCommand: [
      "bun",
      "test",
      "packages/evaluation/tests/external-validation-stages.test.ts",
      "--test-name-pattern",
      "maps independent missing-evidence outcomes",
    ],
  },
];

const initial = await repositoryFingerprint(repository);
const temporaryRoot = await mkdtemp(join(tmpdir(), "neuve-sensitivity-"));
const survivors: string[] = [];

try {
  for (const [index, mutation] of mutations.entries()) {
    const copy = join(temporaryRoot, `mutant-${index + 1}`);
    await cp(repository, copy, {
      recursive: true,
      filter: (source) => {
        const relative = source.slice(repository.length + 1);
        return (
          relative === "" ||
          relative === "package.json" ||
          relative === "bun.lock" ||
          relative === "tsconfig.json" ||
          relative === "tsconfig.base.json" ||
          relative === "apps" ||
          relative === "apps/neuve-cli" ||
          relative.startsWith("apps/neuve-cli/") ||
          relative === "packages" ||
          relative === "packages/graph-client" ||
          relative.startsWith("packages/graph-client/") ||
          relative === "packages/evaluation" ||
          relative.startsWith("packages/evaluation/")
        );
      },
    });

    const baseline = await run(mutation.testCommand, copy);
    if (
      baseline.exitCode !== 0 ||
      !baseline.output.includes(`(pass) ${mutation.fullTestName}`)
    ) {
      throw new Error(
        `${mutation.name}: pristine targeted test did not pass:\n${baseline.output}`,
      );
    }

    const path = join(copy, mutation.file);
    const original = await readFile(path, "utf8");
    const occurrences = original.split(mutation.search).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `${mutation.name}: expected one mutation anchor, found ${occurrences}.`,
      );
    }
    await writeFile(
      path,
      original.replace(mutation.search, mutation.replacement),
    );
    const execution = await run(mutation.testCommand, copy);
    if (
      execution.exitCode !== 0 &&
      execution.output.includes(`(fail) ${mutation.fullTestName}`)
    ) {
      process.stdout.write(`caught: ${mutation.name}\n`);
    } else if (execution.exitCode !== 0) {
      throw new Error(
        `${mutation.name}: targeted test failed for an unexpected reason:\n${execution.output}`,
      );
    } else {
      survivors.push(mutation.name);
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

if ((await repositoryFingerprint(repository)) !== initial) {
  throw new Error("The sensitivity run changed repository content or shape.");
}
if (survivors.length > 0) {
  throw new Error(`Sensitivity mutants survived: ${survivors.join(", ")}.`);
}
process.stdout.write(
  `All ${mutations.length} representative mutants were caught.\n`,
);
