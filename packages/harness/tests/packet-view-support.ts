import { Effect } from "effect";
import {
  Blobs,
  Log,
  canonicalJson,
  type StoreLocation,
} from "@neuve/records-core";
import {
  contentLayer,
  storeContent,
} from "../../records-core/tests/new-shape-support.ts";
import {
  newShapeReview,
  reviewEvents,
} from "../../records-core/tests/review-fixtures.ts";
import {
  agent,
  freshLocation,
  headOid,
  runOn,
} from "../../records-core/tests/support.ts";

/**
 * One store holding an old-shape review (`reviewEvents`, its manifest naming every event of its
 * batch and units) and the new-shape cycle Records' tests build (`newShapeReview`), with every
 * blob and computation the new one names and the proof record its checkpoints name. What
 * `review show` reads, for the printer's and the CLI's tests; in a fresh store unless `location`
 * names one. `extra` events are appended with them, after the reviews.
 */
export const bothShapes = async (
  location: StoreLocation = freshLocation(),
  extra: (
    fixture: ReturnType<typeof newShapeReview>,
  ) => ReadonlyArray<unknown> = () => [],
  /**
   * `newShapeReview`'s own options but `earlier` (the old review's unit), such as `mismatch`,
   * `excluded`, `carried` or `floor`; `plantOld` may change the old review's events before they are
   * stored, such as to plant hostile text in them.
   */
  options: Omit<
    NonNullable<Parameters<typeof newShapeReview>[0]>,
    "earlier"
  > & {
    readonly plantOld?: (old: ReturnType<typeof reviewEvents>) => void;
  } = {},
) => {
  const old = reviewEvents();
  options.plantOld?.(old);
  const { plantOld: _plantOld, ...own } = options;
  const fixture = newShapeReview({
    ...own,
    earlier: { unitId: old.units[1], cycleId: old.cycleId },
  });
  const oldEvents = old.all.filter(
    (e) => e.kind !== "actor.registered@1" && e.kind !== "packet.published@1",
  );
  const onUnit = (unitId: string) =>
    oldEvents
      .filter((e) =>
        (
          e.attribution as { unitIds?: ReadonlyArray<string> } | undefined
        )?.unitIds?.includes(unitId),
      )
      .map((e) => ({ kind: e.kind, id: e.id }));
  const manifest = canonicalJson({
    batches: [
      {
        batch: "b1",
        batchId: old.batchId,
        units: old.units.map((unitId, index) => ({
          unit: `b1.u${index + 1}`,
          unitId,
          events: onUnit(unitId),
        })),
        events: oldEvents
          .filter(
            (e) =>
              e.kind === "batch.recorded@1" ||
              (e.kind === "delivery.recorded@1" &&
                (e.payload as { content?: string }).content === "batch-digest"),
          )
          .map((e) => ({ kind: e.kind, id: e.id })),
      },
    ],
  });
  await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode(manifest),
        mediaType: "application/json",
        retention: "durable",
      });
      const artefact = new TextEncoder().encode("2 pass\n0 fail\n");
      const stored = yield* blobs.put({
        bytes: artefact,
        mediaType: "text/plain; charset=utf-8",
        retention: "raw-capture",
      });
      yield* storeContent(fixture);
      yield* Log.append([
        ...old.registrations,
        ...oldEvents,
        {
          ...old.packet,
          refs: [{ ref: `blob:${held.blob.hash}`, role: "manifest" }],
        },
        ...fixture.all.filter((e) => e.kind !== "actor.registered@1"),
        {
          id: fixture.namedProof,
          kind: "proof.recorded@1",
          idempotencyKey: `proof:${fixture.namedProof}`,
          actor: agent,
          occurredAt: "2026-10-19T10:00:00.000Z",
          attribution: {
            range: {
              baseRef: "refs/heads/main",
              baseOid: "b".repeat(40),
              headOid,
            },
            sessionId: "session-1",
          },
          refs: [{ ref: `blob:${stored.blob.hash}`, role: "artefact" }],
          payload: {
            kind: "test-run",
            revision: headOid,
            claim: "The retry test passes.",
            requirement: { text: "The retry loop keeps retrying" },
            artefact: {
              mediaType: "text/plain; charset=utf-8",
              bytes: artefact.byteLength,
            },
            worktree: { head: headOid, scope: "tracked-tree", dirty: false },
          },
        },
        ...extra(fixture),
      ]);
    }).pipe(Effect.provide(contentLayer(location))),
  );
  return { location, old, fixture };
};

/**
 * `review show`'s lines with the fixture's random parts named by order of first appearance: each
 * ULID, each short ID (`…` and its last ten characters) and each hex digest, so text printed from
 * a fresh store compares with text printed once from the base build.
 */
export const normalized = (lines: ReadonlyArray<string>) => {
  const names = new Map<string, string>();
  const name = (prefix: string) => (token: string) => {
    const known = names.get(token);
    if (known !== undefined) return known;
    const fresh = `<${prefix}${names.size + 1}>`;
    names.set(token, fresh);
    return fresh;
  };
  return lines
    .join("\n")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, name("id"))
    .replace(/…[0-9A-HJKMNP-TV-Z]{10}/g, name("short"))
    .replace(/\b[0-9a-f]{12,64}\b/g, name("hex"));
};
