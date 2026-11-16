// A local stdio MCP server standing in for a ticket system (slice H5): it lets the MCP client, the
// integration file, schema conversion and identifier masking run end to end without any real
// tracker or credential. `get_issue` is read-only, `update_issue` writes (and is never allowed),
// and `search_issues` has a schema `z.fromJSONSchema` cannot keep (`not`), so it must be refused.
// It refuses to answer unless FIXTURE_TOKEN arrives, to show that only listed variables reach it.
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunStdio from "@effect/platform-bun/BunStdio";

const ISSUES: Record<string, unknown> = {
  "NEU-13": {
    identifier: "NEU-13",
    title: "Build versioned embeddings during ingestion",
    url: "https://tracker.example.test/neuve/issue/NEU-13/build-versioned-embeddings",
    assignee: { name: "Dana Reviewer", email: "dana@example.test" },
    description:
      "## Scope\nEvery retrieved source keeps its revision, blob and range identity.\n\n## Done when\n- Stale vectors are explicit (see NEU-14 and https://tracker.example.test/neuve/issue/NEU-14).\n- UTF-8 text and SHA-256 hashes are kept as they are.\n- Ask dana@example.test or Dana Reviewer before changing the recipe.",
  },
};

const object = (
  properties: Record<string, unknown>,
  required: Array<string>,
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const getIssue = Tool.dynamic("get_issue", {
  description: "Read one issue by its key.",
  parameters: object({ id: { type: "string", minLength: 1, maxLength: 32 } }, [
    "id",
  ]),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const updateIssue = Tool.dynamic("update_issue", {
  description: "Change an issue's title.",
  parameters: object({ id: { type: "string" }, title: { type: "string" } }, [
    "id",
    "title",
  ]),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const searchIssues = Tool.dynamic("search_issues", {
  description: "Search issues by text.",
  parameters: object({ term: { type: "string", not: { const: "" } } }, [
    "term",
  ]),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const Tools = Toolkit.make(getIssue, updateIssue, searchIssues);

const authorised = () => process.env["FIXTURE_TOKEN"] === "fixture-token-value";

const handlers = Tools.toLayer({
  get_issue: (input: unknown) =>
    Effect.gen(function* () {
      if (!authorised())
        return yield* Effect.fail("unauthorised: FIXTURE_TOKEN did not arrive");
      const id = (input as { id: string }).id;
      const issue = ISSUES[id];
      if (issue === undefined) return yield* Effect.fail(`no issue ${id}`);
      return JSON.stringify(issue);
    }),
  update_issue: () => Effect.fail("this fixture never writes"),
  search_issues: () => Effect.succeed("[]"),
} as never);

const server = McpServer.toolkit(Tools).pipe(
  Layer.provide(handlers),
  Layer.provide(
    McpServer.layerStdio({
      name: "scope-fixture",
      version: "0.1.0",
      protocols: [
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
      ],
    }),
  ),
  Layer.provide(BunStdio.layer),
);

BunRuntime.runMain(Layer.launch(server) as never, {
  disableErrorReporting: true,
});
