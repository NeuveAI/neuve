// Why: `neuve records stats` exits 1 when a projection table has no declared entity count or holds
// more rows than its entities, and that is how the owner sees a state copy. A projection added
// without its count (proof records, from migration 8, had none) made every store from then on fail
// the check. So a store at the current migration, with a row in every projection, must pass it.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { Admin, Blobs, HumanCommands, Log, mintUlid } from "../src/index.ts";
import { reviewEvents } from "./review-fixtures.ts";
import {
  actor,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

test("stats finds no state copy and no undeclared table on a store at the current migration", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  const result = await runOn(
    location,
    Effect.gen(function* () {
      yield* Log.append(fixture.all);
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "review.origin-recorded@1",
          idempotencyKey: `origin:${fixture.cycleId}`,
          actor,
          occurredAt: "2026-10-19T10:00:00.000Z",
          attribution: {
            cycleId: fixture.cycleId,
            range: {
              baseRef: "main",
              baseOid: "b".repeat(40),
              headOid,
            },
          },
          payload: {
            identity: "d".repeat(64),
            origin: {
              kind: "channel",
              host: "local",
              channel: "stats",
              chat: 1,
              lane: "fix",
              items: [],
            },
          },
        },
      ]);
      const blobs = yield* Blobs.BlobStore;
      const bytes = new TextEncoder().encode("3 pass\n0 fail\n");
      const stored = yield* blobs.put({
        bytes,
        mediaType: "text/plain; charset=utf-8",
        retention: "raw-capture",
      });
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "proof.recorded@1",
          idempotencyKey: `proof:${mintUlid()}`,
          actor,
          occurredAt: "2026-10-19T10:00:00.000Z",
          attribution: {
            range: {
              baseRef: "main",
              baseOid: "b".repeat(40),
              headOid: "c".repeat(40),
            },
            sessionId: "session-1",
          },
          refs: [{ ref: `blob:${stored.blob.hash}`, role: "artefact" }],
          payload: {
            kind: "test-run",
            revision: "c".repeat(40),
            claim: "The revoke test passes.",
            requirement: { text: "A revoked link stops working" },
            artefact: {
              mediaType: "text/plain; charset=utf-8",
              bytes: bytes.byteLength,
            },
            worktree: {
              head: "c".repeat(40),
              scope: "tracked-tree",
              dirty: false,
            },
          },
        },
      ]);
      // A first answer and its correction: two feedback rows for two events.
      for (const judged of ["unsure", "valid"] as const)
        yield* HumanCommands.recordFeedback({
          person: { email: "owner@example.com" },
          answer: {
            on: "finding",
            target: fixture.comments.defect.id,
            harnessCallVisible: true,
            judged,
          },
        });
      return yield* Admin.stats(location);
    }).pipe(Effect.provide(Blobs.layer(location))),
  );
  const rows = (table: string) =>
    result.tables.find((t) => t.table === table)?.rows;

  expect(rows("projection_proofs")).toBe(1);
  expect(rows("projection_feedback")).toBe(2);
  expect(rows("projection_review_origins")).toBe(1);
  expect(result.stateCopies).toEqual([]);
  expect(result.undeclaredTables).toEqual([]);
});
