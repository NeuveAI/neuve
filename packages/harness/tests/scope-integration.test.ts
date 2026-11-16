// Why: the integration boundary fails silently in every direction that matters (10.51–10.53, 10.24):
// a write tool or a tool whose schema zod cannot keep would still answer, a variable the user did
// not list would still reach the server, and an identifier left in a capture would still be stored.
// This runs the real SDK client against a local stdio MCP server (tests/fixtures/scope-server.ts).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { IntegrationServer } from "../src/integrations.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { declaredValues, scopeMasker } from "../src/scope-masking.ts";
import { keyCandidates, linkedPaths } from "../src/scope.ts";

const fixture = join(import.meta.dir, "fixtures", "scope-server.ts");

const server = (variables: Array<string>, env: Record<string, string> = {}) =>
  IntegrationServer.parse({
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [fixture],
      env,
    },
    variables,
    tools: ["get_issue", "search_issues", "update_issue", "list_projects"],
    fetch: { tool: "get_issue", argument: "id", keyPrefixes: ["NEU"] },
    identifiers: {
      identifier: "key",
      url: "url",
      name: "person",
      email: "email",
    },
  });

const withClient = <A>(
  definition: IntegrationServer,
  use: (clients: McpClients["Service"]) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clients = yield* McpClients;
      return yield* use(clients);
    }).pipe(
      Effect.provide(
        mcpClientsLayer({
          status: "configured",
          path: "integrations.json",
          file: { version: 1, servers: { tracker: definition } },
        }),
      ),
    ) as Effect.Effect<A, unknown, never>,
  );

test("only allowed tools with lossless schemas are proxied, and only listed variables arrive", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const listed = await withClient(
    server(["FIXTURE_TOKEN"], { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" }),
    (clients) =>
      Effect.gen(function* () {
        const connection = yield* clients.get("tracker");
        const issue = yield* connection.call("get_issue", { id: "NEU-13" });
        const write = yield* Effect.result(
          connection.call("update_issue", { id: "NEU-13", title: "x" }),
        );
        const tooLong = yield* Effect.result(
          connection.call("get_issue", { id: "X".repeat(40) }),
        );
        return { connection, issue, write, tooLong };
      }),
  );
  expect(listed.connection.tools.map((tool) => tool.name)).toEqual([
    "get_issue",
  ]);
  expect(listed.connection.refused.map((entry) => entry.tool).sort()).toEqual([
    "list_projects",
    "search_issues",
    "update_issue",
  ]);
  // Listed by the user, but the server marks it as writing: refused anyway.
  expect(
    listed.connection.refused.find((entry) => entry.tool === "update_issue")
      ?.reason,
  ).toContain("readOnlyHint: false");
  expect(
    listed.connection.refused.find((entry) => entry.tool === "search_issues")
      ?.reason,
  ).toContain("lossy schema");
  expect(listed.issue.isError).toBe(false);
  expect(JSON.parse(listed.issue.text).identifier).toBe("NEU-13");
  expect(listed.write._tag).toBe("Failure");
  expect(listed.tooLong._tag).toBe("Failure");

  // The same server without the variable listed: the process starts without it and refuses.
  const unlisted = await withClient(server([]), (clients) =>
    Effect.flatMap(clients.get("tracker"), (connection) =>
      connection.call("get_issue", { id: "NEU-13" }),
    ),
  );
  expect(unlisted.isError).toBe(true);
  expect(unlisted.text).toContain("unauthorised");

  // A `${NAME}` the user did not list refuses the server before anything starts.
  const refused = await withClient(
    server([], { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" }),
    (clients) => Effect.result(clients.get("tracker")),
  );
  expect(refused._tag).toBe("Failure");
}, 30_000);

test("masking covers declared identifiers and the shapes fetched, and nothing else", () => {
  const response = {
    identifier: "NEU-13",
    url: "https://tracker.example.test/neuve/issue/NEU-13/x",
    assignee: { name: "Dana Reviewer", email: "dana@example.test" },
  };
  const masker = scopeMasker(
    declaredValues(response, {
      identifier: "key",
      url: "url",
      name: "person",
      email: "email",
    }),
  );
  const masked = masker.mask(
    "NEU-13 links NEU-14 at https://tracker.example.test/neuve/issue/NEU-14 for Dana Reviewer (dana@example.test); keep UTF-8, SHA-256 and ABC-12.",
  );
  expect(masked).toBe(
    "[ticket-1] links [ticket-2] at [url-1] for [person-1] ([email-1]); keep UTF-8, SHA-256 and ABC-12.",
  );
  // Ticket candidates are only candidates: the generic shape also finds `UTF-8`.
  expect(keyCandidates("fix NEU-13, keep UTF-8")).toEqual(["NEU-13", "UTF-8"]);
});

// Why: an agent guide is repository text; a link that is not valid percent-encoding must become a
// disclosed gap, never a thrown error that stops the scope fetch (1.8).
test("links that do not decode are returned as undecodable, never thrown", () => {
  expect(
    linkedPaths(
      "docs/AGENTS.md",
      "[a](reports/100%.md) [b](a%20b.md) [c](https://x.test/y) [d](../up.md)",
    ),
  ).toEqual({
    paths: ["docs/a b.md", "up.md"],
    undecodable: ["reports/100%.md"],
  });
});
