// Follow-on execution has a different native database. Its immutable destination bases must
// come from the existing retained publication chain, including a partially written plan.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  batchKeyOf,
  closedPublicationBatches,
  publishSettled,
  publishSettledForTest,
} from "../src/publish-sections.ts";
import {
  eventsOf,
  inputOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

test("publication closure readback survives a new host/store and does not freeze unrelated batches", async () => {
  const store = scratch();
  const ctx = store.ctx();
  const { a, b } = threeBatches();
  expect(
    await store.run(closedPublicationBatches(ctx.cycleId, ctx.runKey)),
  ).toEqual([]);
  await store.run(publishSettled(ctx, inputOf([a])));
  // A new store service/process reads the retained selection, not the old native task document.
  const twin = store.copy();
  const read = await twin.run(
    closedPublicationBatches(ctx.cycleId, ctx.runKey),
  );
  expect(read).toEqual([
    {
      key: batchKeyOf(a.paths),
      paths: [...a.paths].sort(),
      sectionKeys: a.sections.map((section) => section.identity.key).sort(),
      publication: { status: "written", ordinal: 1 },
    },
  ]);
  expect(read.some((basis) => basis.key === batchKeyOf(b.paths))).toBe(false);
  expect(
    await twin.run(closedPublicationBatches(ctx.cycleId, "different-config")),
  ).toEqual([]);
});

test("an interrupted append retains its selected basis without pretending the packet published", async () => {
  const store = scratch();
  const ctx = store.ctx();
  const { a } = threeBatches();
  await store.run(
    publishSettledForTest(ctx, inputOf([a]), "batches").pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
  );
  expect(
    await store.run(eventsOf(ctx.cycleId, "packet.published@2")),
  ).toHaveLength(0);
  const selected = await store.run(
    closedPublicationBatches(ctx.cycleId, ctx.runKey),
  );
  expect(selected).toEqual([
    {
      key: batchKeyOf(a.paths),
      paths: [...a.paths].sort(),
      sectionKeys: a.sections.map((section) => section.identity.key).sort(),
      publication: { status: "selected", ordinal: 1 },
    },
  ]);
  const twin = store.copy();
  expect(
    await twin.run(closedPublicationBatches(ctx.cycleId, ctx.runKey)),
  ).toEqual(selected);
  await twin.run(
    publishSettled({ ...ctx, repository: twin.directory }, inputOf([a])),
  );
  const written = await twin.run(
    closedPublicationBatches(ctx.cycleId, ctx.runKey),
  );
  expect(written[0]!.publication.status).toBe("written");
  expect(written[0]!.sectionKeys).toEqual(selected[0]!.sectionKeys);
  expect(
    await twin.run(eventsOf(ctx.cycleId, "packet.published@2")),
  ).toHaveLength(1);
});
