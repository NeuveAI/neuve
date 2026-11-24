// Why: settings, environment, and both binary layouts must select the same engine for Graph and hybrid.
import { afterAll, expect, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Option } from "effect";
import { searchRuntimeFrom } from "../src/search-config.ts";
import { Settings } from "../src/settings.ts";

const root = mkdtempSync(join(tmpdir(), "search-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const reranker = fileURLToPath(
  new URL("../../semantic-client/src/reranker_worker.py", import.meta.url),
);
const file = (path: string, mode = 0o755) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode });
  return path;
};
const configured = (explicit?: string) =>
  Option.some(
    Settings.parse({
      version: 1,
      search: {
        graph: explicit === undefined ? {} : { executable: explicit },
        hybrid: {
          device: "cpu",
          python: "/python",
          e0: { snapshot: "/e0", worker: "/encoder.py" },
          reranker: { snapshot: "/reranker", worker: reranker },
          ...(explicit === undefined
            ? {}
            : { graph: { executable: explicit } }),
        },
      },
    }),
  );

for (const scenario of [
  "explicit",
  "environment",
  "installed",
  "workspace",
] as const)
  test(`Graph and hybrid discovery prefer ${scenario}`, () => {
    const directory = join(root, scenario);
    const cli = file(join(directory, "apps/neuve-cli/dist/neuve"));
    const linked = join(directory, "neuve-link");
    symlinkSync(cli, linked);
    const installed = join(dirname(cli), "../lib/neuve/entire-graph");
    const workspace = file(
      join(dirname(cli), "../../neuve-graph/entire-graph"),
    );
    if (scenario !== "workspace") file(installed);
    const override =
      scenario === "explicit" || scenario === "environment"
        ? file(join(directory, "override"))
        : undefined;
    const explicit =
      scenario === "explicit" ? file(join(directory, "explicit")) : undefined;
    const runtime = searchRuntimeFrom(
      configured(explicit),
      join(directory, "store"),
      { override, executable: linked },
    );
    const expected =
      explicit ??
      override ??
      (scenario === "workspace" ? workspace : installed);
    expect(runtime.graph?.executable).toBe(expected);
    expect(runtime.hybrid?.graph.executable).toBe(expected);
    expect(runtime.problems).toEqual({});
  });

/** As the rule decides it: a file the current user can run. */
const runnable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

for (const scenario of [
  "explicit",
  "environment",
  "missing",
  "non-executable",
] as const)
  test(`Graph discovery discloses ${scenario} engine failure, falling back only to a runnable source engine`, () => {
    const directory = join(root, `bad-${scenario}`);
    const cli = file(join(directory, "bin/neuve"));
    const installed = join(directory, "lib/neuve/entire-graph");
    if (scenario !== "missing") file(installed);
    if (scenario === "non-executable") chmodSync(installed, 0o644);
    const missing = join(directory, "missing");
    const runtime = searchRuntimeFrom(
      configured(scenario === "explicit" ? missing : undefined),
      join(directory, "store"),
      {
        override: scenario === "environment" ? missing : undefined,
        executable: cli,
      },
    );
    // A checkout with the Graph engine built falls back to that engine when running from source.
    const source = fileURLToPath(
      new URL("../../../apps/neuve-graph/entire-graph", import.meta.url),
    );
    if (
      (scenario === "missing" || scenario === "non-executable") &&
      runnable(source)
    ) {
      expect(runtime.graph?.executable).toBe(source);
      expect(runtime.problems.graph_search).toBeUndefined();
      return;
    }
    expect(runtime.graph).toBeUndefined();
    expect(runtime.hybrid).toBeUndefined();
    for (const problem of [
      runtime.problems.graph_search,
      runtime.problems.hybrid,
    ]) {
      expect(problem).toContain(
        scenario === "explicit"
          ? "no Graph engine at"
          : scenario === "environment"
            ? "NEUVE_GRAPH_BINARY does not name an executable file"
            : "Neuve Graph binary is unavailable",
      );
      expect(problem).toContain(
        scenario === "explicit" || scenario === "environment"
          ? missing
          : installed,
      );
    }
  });
