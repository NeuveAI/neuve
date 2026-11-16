import { expect, test } from "bun:test";
import { writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import { RecordEvent } from "@neuve/records-schema";
import { SqlClient } from "effect/sql/SqlClient";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  Store,
  storeLocationIn,
  mintUlid,
} from "@neuve/records-core";
import { Fixture, git, OWNER } from "../../channel/tests/helpers";
import type { PlanningState } from "../../channel/src/planning";
import { createPlanning } from "../../../apps/neuve-host/src/planning";
import { linearMcpSession } from "../src/linear-planning";
import { IntegrationServer } from "../src/integrations";
import { requestReview } from "../src/request";
import { cycleSnapshot, freezeSnapshot, isFrozen } from "../src/scope";
import { mcpClientsLayer } from "../src/mcp-client";

test("native reopened selection is admitted before opening, fetched into Records once, and cannot replace joined scope", async () => {
  const definition = IntegrationServer.parse({
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "linear-planning-server.ts")],
    },
    variables: [],
    tools: ["read_issue"],
    identifiers: {},
    fetch: { tool: "read_issue", argument: "id", keyPrefixes: ["NEU"] },
  });
  const integrations = {
    status: "configured" as const,
    path: "fixture",
    file: { version: 1 as const, servers: { linear: definition } },
  };
  const client = linearMcpSession(integrations);
  const planning = createPlanning({
    client,
    mappings: {
      linear: {
        search: { tool: "read_issue", queryArgument: "id" },
        issue: { tool: "read_issue", idArgument: "id" },
        dependencies: { tool: "read_issue", idArgument: "id" },
      },
    },
  });
  const fixture = await Fixture.create({ planning });
  try {
    await fixture.request({
      op: "planning-select",
      author: OWNER,
      connection: "linear",
      issue: "NEU-59",
    });
    await fixture.restart();
    const state = await fixture.request<PlanningState>({
      op: "planning-state",
    });
    if (!state.selection) throw new Error("Missing committed selection");
    const source = state.selection.source;
    await writeFile(join(fixture.lane.path, "work.txt"), "committed work\n");
    git(fixture.lane.path, "add", "work.txt");
    git(fixture.lane.path, "commit", "-qm", "Implement chosen scope");
    const base = git(fixture.lane.path, "rev-parse", "HEAD~1").trim();
    const head = git(fixture.lane.path, "rev-parse", "HEAD").trim();
    await writeFile(join(fixture.lane.path, "next.txt"), "separate range\n");
    git(fixture.lane.path, "add", "next.txt");
    git(fixture.lane.path, "commit", "-qm", "Second range");
    const nextHead = git(fixture.lane.path, "rev-parse", "HEAD").trim();
    const location = storeLocationIn(join(fixture.root, "isolated-records"));
    const scopeSource = {
      server: source.connection,
      item: source.key,
      workspace: source.workspace,
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Store.prepareForWrite;
        const args = {
          repository: fixture.lane.path,
          location,
          range: `${base}..${head}`,
          requester: { _tag: "Unresolved" as const },
          search: {},
          stack: undefined,
          deadline: undefined,
          scopeIntegrations: integrations,
        };
        const first = yield* requestReview({ ...args, scopeSource });
        const selected = yield* Log.history({
          kind: "cycle.scope-selected@1",
          cycleId: first.cycleId,
        });
        const opened = yield* Log.history({
          kind: "cycle.opened@1",
          cycleId: first.cycleId,
        });
        const snapshot = yield* cycleSnapshot({
          repository: fixture.lane.path,
          location,
          cycleId: first.cycleId,
          range: first.range,
          integrations,
        });
        yield* freezeSnapshot(first.cycleId, []);
        const repeated = yield* cycleSnapshot({
          repository: fixture.lane.path,
          location,
          cycleId: first.cycleId,
          range: first.range,
          integrations,
        });
        const joined = yield* requestReview({ ...args, scopeSource });
        const mismatch = yield* Effect.exit(
          requestReview({
            ...args,
            scopeSource: { ...scopeSource, item: "NEU-58" },
          }),
        );
        const old = yield* requestReview({
          ...args,
          range: `${head}..${nextHead}`,
        });
        const attach = yield* Effect.exit(
          requestReview({
            ...args,
            range: `${head}..${nextHead}`,
            scopeSource,
          }),
        );
        const oldOpened = yield* Log.history({
          kind: "cycle.opened@1",
          cycleId: old.cycleId,
        });
        const oldSelected = yield* Log.history({
          kind: "cycle.scope-selected@1",
          cycleId: old.cycleId,
        });
        const selectedEvent = selected[0]!.event;
        const late = yield* Effect.exit(
          Log.append([
            RecordEvent.parse({
              ...selectedEvent,
              id: mintUlid(),
              idempotencyKey: "late-selection",
              attribution: oldOpened[0]!.event.attribution,
            }),
          ]),
        );
        const duplicate = yield* Effect.exit(
          Log.append([
            RecordEvent.parse({
              ...selectedEvent,
              id: mintUlid(),
              idempotencyKey: "duplicate-selection",
            }),
          ]),
        );
        const rollbackCycle = mintUlid();
        const firstSelection = RecordEvent.parse({
          ...selectedEvent,
          id: mintUlid(),
          idempotencyKey: "rollback-first",
          attribution: { ...selectedEvent.attribution, cycleId: rollbackCycle },
        });
        const secondSelection = RecordEvent.parse({
          ...firstSelection,
          id: mintUlid(),
          idempotencyKey: "rollback-second",
        });
        const rollback = yield* Effect.exit(
          Log.append([firstSelection, secondSelection]),
        );
        const rolledBack = yield* Log.history({ cycleId: rollbackCycle });
        const sql = yield* SqlClient;
        const cycles = yield* sql<{
          n: number;
        }>`SELECT count(*) AS n FROM projection_cycles`;
        const batches = yield* sql<{
          n: number;
        }>`SELECT count(*) AS n FROM projection_batches`;
        return {
          first,
          selected,
          opened,
          oldOpened,
          oldSelected,
          attach,
          late,
          duplicate,
          rollback,
          rolledBack,
          snapshot: snapshot.value,
          repeated: repeated.status,
          joined,
          mismatch,
          frozen: yield* isFrozen(first.cycleId),
          cycles,
          batches,
        };
      }).pipe(
        Effect.provide(mcpClientsLayer(integrations)),
        Effect.provide(
          Layer.mergeAll(
            JobQueue.layer,
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    await fixture.request({
      op: "planning-reviewed",
      chat: ROOT_CONVERSATION_ID,
      source,
      review: { reference: result.first.cycleId, base, head },
    });
    await fixture.restart();
    const linked = await fixture.request<PlanningState>({
      op: "planning-state",
    });
    expect(linked.review).toEqual({
      reference: result.first.cycleId,
      base,
      head,
    });
    expect(result.selected[0]?.seq).toBeLessThan(result.opened[0]!.seq);
    expect(result.selected[0]?.event.payload).toEqual(scopeSource);
    expect(result.opened[0]?.event.payload).toEqual({});
    expect(result.snapshot.sources).toContainEqual(
      expect.objectContaining({
        kind: "ticket",
        status: "fetched",
        ref: expect.objectContaining({
          server: "linear",
          item: "NEU-59",
          found: "explicit planning selection",
        }),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        fetchedAt: expect.any(String),
      }),
    );
    expect(result.repeated).toBe("reused");
    expect(result.frozen).toBe(true);
    expect(result.joined.cycleId).toBe(result.first.cycleId);
    expect(result.mismatch._tag).toBe("Failure");
    expect(result.late._tag).toBe("Failure");
    expect(result.duplicate._tag).toBe("Failure");
    expect(result.rollback._tag).toBe("Failure");
    expect(result.rolledBack).toEqual([]);
    expect(result.oldOpened[0]?.event.payload).toEqual({});
    expect(result.oldSelected).toEqual([]);
    expect(result.attach._tag).toBe("Failure");
    expect(result.cycles).toEqual([{ n: 2 }]);
    expect(result.batches).toEqual([{ n: 0 }]);
    const evidence = process.env["NEUVE_PLANNING_EVIDENCE"];
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await writeFile(
        join(evidence, "records-runtime.json"),
        JSON.stringify(
          {
            selectedState: state,
            linkedState: linked,
            events: [...result.selected, ...result.opened, ...result.oldOpened],
            snapshot: result.snapshot,
            reused: result.repeated,
            frozen: result.frozen,
            mismatch: result.mismatch._tag,
            attachToOld: result.attach._tag,
            lateAppend: result.late._tag,
            duplicateAppend: result.duplicate._tag,
            atomicRollback: result.rollback._tag,
            rolledBack: result.rolledBack,
            projectionCycles: result.cycles,
            projectionBatches: result.batches,
            nativeLog: fixture.log,
          },
          null,
          2,
        ),
      );
      await fixture.channel.close();
      await cp(location.directory, join(evidence, "isolated-records"), {
        recursive: true,
      });
      await cp(join(fixture.root, "state"), join(evidence, "native-state"), {
        recursive: true,
      });
    }
  } finally {
    await client.close();
    await fixture.dispose();
  }
});
