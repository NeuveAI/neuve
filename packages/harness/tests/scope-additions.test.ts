// Why: 3.12 and 10.53 forbid a silent update of a cycle's scope: Understand may add at most 10
// items per run, an item already in the snapshot is served from it and never fetched again, and
// once Understand completed nothing is added. A broken cap or freeze would still answer every
// call, so nothing downstream would show it. Runs against the local fixture server.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { IntegrationServer } from "../src/integrations.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { additionTools, freezeSnapshot, isFrozen } from "../src/scope.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-additions-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("additions are capped per run, shared within the cycle and refused once frozen", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const server = IntegrationServer.parse({
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "scope-server.ts")],
      env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" },
    },
    variables: ["FIXTURE_TOKEN"],
    tools: ["get_issue"],
    identifiers: {
      identifier: "key",
      url: "url",
      name: "person",
      email: "email",
    },
  });
  const location = storeLocationIn(directory);
  const cycleId = "01M5AAAAAAAAAAAAAAAAAAAAAA";
  const records = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
  );
  const texts = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const clients = yield* McpClients;
        const connection = yield* clients.get("tracker");
        const context = yield* Effect.context<
          Blobs.BlobStore | Computations.ComputationStore
        >();
        const tools = (
          frozen: boolean,
          budget: { left: number; added: Array<string> },
        ) =>
          additionTools({
            location,
            cycleId,
            connections: [{ connection, server }],
            frozen,
            budget,
            records: context,
          })[0]!;
        const first = { left: 1, added: [] as Array<string> };
        const run1 = tools(false, first);
        const fetched = yield* run1.handle({ id: "NEU-13" });
        const again = yield* run1.handle({ id: "NEU-13" });
        const capped = yield* run1.handle({ id: "NEU-14" });
        yield* freezeSnapshot(cycleId, first.added);
        const run2 = tools(yield* isFrozen(cycleId), { left: 10, added: [] });
        const served = yield* run2.handle({ id: "NEU-13" });
        const refused = yield* run2.handle({ id: "NEU-14" });
        return {
          fetched,
          again,
          capped,
          served,
          refused,
          added: first.added.length,
        };
      }),
    ).pipe(
      Effect.provide(
        mcpClientsLayer({
          status: "configured",
          path: "integrations.json",
          file: { version: 1, servers: { tracker: server } },
        }),
      ),
      Effect.provide(records),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(texts.fetched.text).toContain('"identifier":"NEU-13"');
  expect(texts.again.text).toBe(texts.fetched.text);
  expect(texts.added).toBe(1);
  expect(texts.capped.text).toContain("No more additions");
  expect(texts.served.text).toBe(texts.fetched.text);
  expect(texts.refused.text).toContain("frozen");
}, 30_000);
