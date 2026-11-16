// Why: the web app's BFF links only the `request`, `git-objects` and `held-reviews` subpaths (M5,
// HX1, S4). If an import added anywhere under them reached ACP, MCP, a model provider, the parser or
// sigstore, the web app would link that code without any error. This walks each subpath's static
// import graph (value imports only; type-only imports are erased) from the file `package.json`
// exports and checks that none of that code is in it. The package's main entry is walked too, as a
// control: the same walk must find that code there, or a broken walk would pass trivially. The
// Graph source parsing runs in a separate executable, called only when structure is requested.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const exportsMap = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    exports: Record<string, string>;
  }
).exports;

/** ACP, MCP, the model providers and the sign-in, the parser, and sigstore. */
const FORBIDDEN = [
  /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?@agentclientprotocol\//,
  /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?@modelcontextprotocol\//,
  /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?@effect\/ai-/,
  /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?@sigstore\//,
  /\/harness\/src\/(?:acp|mcp|mcp-client|openai-route|openai-auth|route-provider)\.ts$/,
  /\/harness\/src\/stack\/(?:provenance|sigstore-trusted-root)\.ts$/,
];

const transpiler = new Bun.Transpiler({ loader: "ts" });

const graphOf = (entry: string) => {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(file)) continue;
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (path.startsWith("node:") || path.startsWith("bun:")) continue;
      const resolved = Bun.resolveSync(path, dirname(file));
      if (resolved.startsWith("/")) queue.push(resolved);
    }
  }
  return [...seen];
};

const forbiddenIn = (entry: string) =>
  graphOf(join(root, entry)).filter((file) =>
    FORBIDDEN.some((pattern) => pattern.test(file)),
  );

test("the request, git-objects and held-reviews subpaths link no ACP, MCP, model provider, parser or sigstore code", () => {
  expect(exportsMap["./request"]).toBe("./src/request.ts");
  expect(exportsMap["./git-objects"]).toBe("./src/git-objects.ts");
  expect(exportsMap["./held-reviews"]).toBe("./src/held-reviews.ts");
  expect(forbiddenIn(exportsMap["./request"]!)).toEqual([]);
  expect(forbiddenIn(exportsMap["./git-objects"]!)).toEqual([]);
  // The held jobs' one definition: zod and node:fs, nothing of the harness.
  expect(
    graphOf(join(root, exportsMap["./held-reviews"]!)).filter((file) =>
      file.includes("/harness/src/"),
    ),
  ).toEqual([join(root, "src/held-reviews.ts")]);
  // The main entry still links live integrations and providers, while ACP is absent there too.
  const main = forbiddenIn(exportsMap["."]!).join("\n");
  expect(main).not.toContain("@agentclientprotocol/");
  for (const name of [
    "@modelcontextprotocol/",
    "@effect/ai-anthropic/",
    "@sigstore/",
    "/src/route-provider.ts",
  ])
    expect(main).toContain(name);
});
