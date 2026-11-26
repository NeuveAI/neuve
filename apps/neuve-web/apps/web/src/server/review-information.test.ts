// Why: later observations must be prepared beside the EXACT packet being read without changing
// its decisions. Real Records fixtures exercise publication identity, stable ownership and bounded
// drilldown; this helper alone does not expose information in the human UI.
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { rm } from "node:fs/promises"
import {
  Blobs,
  Log,
  PublishedPackets,
  ReviewInformation,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core"
import type { PublishedPackets as Packets } from "@neuve/records-core"
import {
  contentLayer,
  storeContent,
} from "../../../../../../packages/records-core/tests/new-shape-support"
import {
  newShapeReview,
  reviewEvents,
} from "../../../../../../packages/records-core/tests/review-fixtures"
import {
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "../../../../../../packages/records-core/tests/support"
import { readReviewInformation } from "./review-information.server"
import type { ReviewInformationView } from "./review-information.server"

afterAll(removeTemporaryDirectories)

type Location = ReturnType<typeof freshLocation>
const on = <A, E, R>(location: Location, effect: Effect.Effect<A, E, R>) =>
  runOn(
    location,
    effect.pipe(Effect.provide(contentLayer(location))) as Effect.Effect<
      A,
      unknown,
      never
    >
  )

const seed = async (skip: ReadonlyArray<string> = []) => {
  const fixture = newShapeReview()
  const location = freshLocation()
  const packet = await on(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture, skip)
      yield* Log.append(fixture.all)
      return yield* PublishedPackets.readExact(fixture.events.second.id)
    })
  )
  if (packet?.kind !== "packet.published@2")
    throw new Error("Expected a V2 packet")
  return { fixture, location, packet }
}

type Seed = Awaited<ReturnType<typeof seed>>
const fact = (
  { fixture, packet }: Seed,
  claim = "late-claim"
): ReviewInformation.InformationInput => ({
  cycleId: fixture.cycleId,
  runKey: packet.sequence!.runKey,
  runId: "current-registrar-not-original-producer",
  claim,
  producer: { assignment: "original-reviewer", task: 7 },
  anchor: { path: "src/large.ts", side: "old", startLine: 1, endLine: 2 },
  destination: {
    kind: "owned",
    batchId: fixture.batches[0],
    assignmentId: "destination-assignment",
    sectionKey: fixture.sectionKeys.k1,
  },
  classification: "later-review-information",
  verify: { outcome: "confirmed", task: 9, computation: "verify-computation" },
  report: {
    text: "<script>alert('report')</script>&",
    references: ["src/large.ts:1", "src/small.ts:3"],
  },
  source: {
    run: "original-run",
    cycle: fixture.cycleId,
    ref: "javascript:source-is-data",
    nested: { text: "<b>not trusted HTML</b>" },
  },
})
const unknown = (
  input: ReviewInformation.InformationInput
): ReviewInformation.InformationInput => ({
  ...input,
  claim: `unknown:${input.claim}`,
  classification: "unknown-ownership",
  destination: {
    kind: "unassigned",
    reason: "No supported destination",
    sectionKeys: [],
  },
})
const available = (view: ReviewInformationView) => {
  if (view.status !== "available") throw new Error(view.reason)
  return view
}
const ownedPage = (view: ReviewInformationView) => {
  const own = available(view).owned
  if (own.status !== "available") throw new Error("Expected owned information")
  return own
}

test("fact-only append changes side-data, not the selected frozen packet, comments, proof or dispositions", async () => {
  const s = await seed()
  const target = { kind: "unit" as const, unitId: s.fixture.units.large }
  const before = await on(s.location, readReviewInformation(s.packet, target))
  expect(ownedPage(before).items).toEqual([])
  const snapshot = canonicalJson(s.packet)
  const beforeEvents = await on(
    s.location,
    Log.history({ cycleId: s.fixture.cycleId, limit: 1000 })
  )
  const input = fact(s)
  const recorded = await on(s.location, ReviewInformation.record(input))
  const after = available(
    await on(s.location, readReviewInformation(s.packet, target))
  )
  const row = ownedPage(after).items[0]!
  expect(row.event.id).toBe(recorded.id)
  expect(row.event.payload.producer).toEqual(input.producer)
  expect(row.event.attribution.runId).toBe(input.runId)
  expect(row.event.payload.verify.outcome).toBe("confirmed")
  expect(row.details).toEqual({
    status: "available",
    value: { report: input.report, source: input.source },
  })
  // Text and source URIs are untouched JSON data, not escaped, rendered, marked trusted or obeyed.
  expect(JSON.stringify(row.details)).toContain("<script>")
  expect(after.notice).toContain(
    "verification is not approval, resolution or an additional vote"
  )
  expect(after).not.toHaveProperty("disposition")
  const reloaded = await on(
    s.location,
    PublishedPackets.readExact(s.packet.eventId)
  )
  expect(canonicalJson(s.packet)).toBe(snapshot)
  expect(canonicalJson(reloaded)).toBe(snapshot)
  const afterEvents = await on(
    s.location,
    Log.history({ cycleId: s.fixture.cycleId, limit: 1000 })
  )
  expect(
    afterEvents.filter(
      ({ event }) => event.kind !== "review.information-recorded@1"
    )
  ).toEqual(beforeEvents)
})

test("selected publication cycle/run and stable sections isolate facts before paging, not anchor proximity or current run", async () => {
  const s = await seed()
  const input = fact(s)
  const sibling = {
    ...input,
    claim: "sibling",
    destination: {
      ...input.destination,
      kind: "owned" as const,
      assignmentId: "sibling",
      batchId: s.fixture.batches[1],
      sectionKey: s.fixture.sectionKeys.k3,
    },
  }
  await on(
    s.location,
    Effect.gen(function* () {
      // These preceding facts must not consume the selected target's first page.
      for (const value of [
        { ...input, claim: "other-cycle", cycleId: mintUlid() },
        { ...input, claim: "other-run", runKey: sha256Hex("other-run") },
        unknown({ ...input, claim: "other-cycle", cycleId: mintUlid() }),
        unknown({
          ...input,
          claim: "other-run",
          runKey: sha256Hex("other-run"),
        }),
        { ...input, claim: "incoming", classification: "incoming" as const },
        sibling,
        input,
        {
          ...input,
          claim: "second-section",
          destination: {
            ...sibling.destination,
            batchId: s.fixture.batches[0],
            sectionKey: s.fixture.sectionKeys.k2,
          },
        },
        unknown(input),
      ])
        yield* ReviewInformation.record(value)
      // A newer unrelated run in the SAME cycle cannot supply this packet's side-data identity.
      yield* Log.append([
        envelope(
          "review.requested@1",
          "unrelated-current-run",
          s.fixture.events.registration.actor,
          s.fixture.events.cycle.attribution,
          {
            runKey: sha256Hex("other-run"),
            generation: 0,
            pipeline: { version: 12, config: {} },
          }
        ),
      ])
    })
  )
  const unit = available(
    await on(
      s.location,
      readReviewInformation(
        s.packet,
        { kind: "unit", unitId: s.fixture.units.large },
        { limit: 2 }
      )
    )
  )
  expect(ownedPage(unit).items.map((row) => row.event.payload.claim)).toEqual([
    input.claim,
  ])
  expect(ownedPage(unit).hasMore).toBe(true)
  expect(
    unit.cycleUnassigned.items.map((row) => row.event.payload.claim)
  ).toEqual([`unknown:${input.claim}`])
  const second = await on(
    s.location,
    readReviewInformation(
      s.packet,
      { kind: "batch", batchId: s.fixture.batches[0] },
      {
        limit: 2,
        ownedAfterSeq: ownedPage(unit).nextSeq,
        cycleAfterSeq: unit.cycleUnassigned.nextSeq,
      }
    )
  )
  expect(ownedPage(second).items.map((row) => row.event.payload.claim)).toEqual(
    ["second-section"]
  )
  expect(available(second).cycleUnassigned.items).toEqual([])
  expect(available(second).cycleUnassigned.nextSeq).toBe(
    unit.cycleUnassigned.nextSeq
  )
  const neighbor = await on(
    s.location,
    readReviewInformation(s.packet, {
      kind: "unit",
      unitId: s.fixture.units.small,
    })
  )
  expect(
    ownedPage(neighbor).items.map((row) => row.event.payload.claim)
  ).toEqual(["sibling"])
  // Its anchor was identical to our unit's: only stable destination keys confer ownership.
  expect(ownedPage(neighbor).items[0]!.event.payload.anchor).toEqual(
    input.anchor
  )
  const firstPacket = await on(
    s.location,
    PublishedPackets.readExact(s.fixture.events.first.id)
  )
  if (!firstPacket) throw new Error("Expected first packet")
  expect(
    ownedPage(
      await on(
        s.location,
        readReviewInformation(firstPacket, {
          kind: "unit",
          unitId: s.fixture.units.large,
        })
      )
    ).items
  ).toHaveLength(2)
})

test("unknown ownership remains cycle-level for a cycle target, missing unit/batch, or unreadable section data", async () => {
  const s = await seed()
  const input = unknown(fact(s))
  // Candidate section keys are NOT a destination, even when they match a unit on this page.
  if (input.destination.kind !== "unassigned")
    throw new Error("Expected unassigned")
  input.destination.sectionKeys.push(s.fixture.sectionKeys.k1)
  await on(s.location, ReviewInformation.record(input))
  for (const target of [
    { kind: "cycle" as const },
    { kind: "unit" as const, unitId: "not-in-selected-packet" },
    { kind: "batch" as const, batchId: "not-in-selected-packet" },
  ]) {
    const result = available(
      await on(
        s.location,
        readReviewInformation(s.packet, target, { limit: 3, detailsBytes: 101 })
      )
    )
    expect(result.owned.status).toBe(
      target.kind === "cycle" ? "not-requested" : "unavailable"
    )
    expect(result.cycleUnassigned.items[0]?.event.payload.claim).toBe(
      input.claim
    )
    expect(result.cycleUnassigned.bounds).toEqual({
      limit: 3,
      detailsBytes: 101,
    })
  }
  const missing = await seed(["sections:Large file"])
  await on(missing.location, ReviewInformation.record(unknown(fact(missing))))
  // The fixture's actual missing sections blob makes Records disclose the unreadable unit.
  expect(missing.packet.batches[0]!.units[0]!.sections).toHaveLength(0)
  const result = available(
    await on(
      missing.location,
      readReviewInformation(missing.packet, {
        kind: "unit",
        unitId: missing.fixture.units.large,
      })
    )
  )
  expect(result.owned.status).toBe("unavailable")
  expect(result.cycleUnassigned.items).toHaveLength(1)
})

test("aggregate row/detail allowances are split once, independently paged and explicitly incomplete", async () => {
  const s = await seed()
  const input = fact(s)
  await on(
    s.location,
    Effect.gen(function* () {
      for (let i = 0; i < 4; i++) {
        yield* ReviewInformation.record({ ...input, claim: `owned-${i}` })
        yield* ReviewInformation.record(
          unknown({ ...input, claim: `cycle-${i}` })
        )
      }
    })
  )
  const target = { kind: "batch" as const, batchId: s.fixture.batches[0] }
  const page = available(
    await on(
      s.location,
      readReviewInformation(s.packet, target, { limit: 3, detailsBytes: 5 })
    )
  )
  const owned = ownedPage(page)
  expect(page.bounds).toEqual({ limit: 3, detailsBytes: 5 })
  expect(owned.bounds).toEqual({ limit: 1, detailsBytes: 2 })
  expect(page.cycleUnassigned.bounds).toEqual({ limit: 2, detailsBytes: 3 })
  expect(owned.items.length + page.cycleUnassigned.items.length).toBe(3)
  expect(owned.hasMore).toBe(true)
  expect(page.cycleUnassigned.hasMore).toBe(true)
  for (const row of [...owned.items, ...page.cycleUnassigned.items]) {
    expect(row.details.status).toBe("unavailable")
    if (row.details.status === "unavailable")
      expect(row.details.reason).toContain("not resolved")
    expect(row.event.payload.details).toMatch(/^[a-f0-9]{64}$/)
  }
  const next = available(
    await on(
      s.location,
      readReviewInformation(s.packet, target, {
        limit: 3,
        ownedAfterSeq: owned.nextSeq,
        cycleAfterSeq: page.cycleUnassigned.nextSeq,
      })
    )
  )
  expect(ownedPage(next).items[0]?.event.payload.claim).toBe("owned-1")
  expect(
    next.cycleUnassigned.items.map((row) => row.event.payload.claim)
  ).toEqual(["unknown:cycle-2", "unknown:cycle-3"])
  expect(next.cycleUnassigned.hasMore).toBe(false)
  // Full retained detail remains available through the same bounded read when allowed.
  expect(ownedPage(next).items[0]?.details).toEqual({
    status: "available",
    value: { report: input.report, source: input.source },
  })
})

test("legacy, absent and mismatched selected identities are unavailable without consulting a current run", async () => {
  const s = await seed()
  const legacy = reviewEvents()
  await on(
    s.location,
    Log.append(
      legacy.all.filter((event) => event.kind !== "actor.registered@1")
    )
  )
  const old = await on(s.location, PublishedPackets.readExact(legacy.packet.id))
  if (!old) throw new Error("Expected a legacy packet")
  for (const packet of [
    old,
    { ...s.packet, eventId: mintUlid() },
    { ...s.packet, eventId: legacy.packet.id },
    { ...s.packet, sequence: undefined },
    { ...s.packet, sequence: { ...s.packet.sequence!, runKey: "invalid" } },
    { ...s.packet, ordinal: s.packet.ordinal + 1 },
    { ...s.packet, manifest: sha256Hex("not-the-selected-manifest") },
    { ...s.packet, sequence: { ...s.packet.sequence!, base: "wrong-base" } },
  ] satisfies Packets.ReadPacket[]) {
    expect(
      (await on(s.location, readReviewInformation(packet, { kind: "cycle" })))
        .status
    ).toBe("unavailable")
  }
})

test("unreadable original detail stays attributed and unavailable, never silently reviewed or resolved", async () => {
  const s = await seed()
  const input = {
    ...fact(s),
    report: { text: "x".repeat(Blobs.INLINE_MAX_BYTES + 1) },
  }
  await on(s.location, ReviewInformation.record(input))
  const target = { kind: "unit" as const, unitId: s.fixture.units.large }
  const first = ownedPage(
    await on(
      s.location,
      readReviewInformation(s.packet, target, { detailsBytes: 400_000 })
    )
  )
  const original = first.items[0]!
  expect(original.details.status).toBe("available")
  // Only a temporary fixture's source blob is removed; neither its immutable fact nor packet moves.
  await rm(Blobs.blobPath(s.location, original.event.payload.details))
  const missing = ownedPage(
    await on(
      s.location,
      readReviewInformation(s.packet, target, { detailsBytes: 400_000 })
    )
  ).items[0]!
  expect(missing.event).toEqual(original.event)
  expect(missing.details).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("not resolved"),
  })
})

test("invalid caller bounds and cursors refuse explicitly rather than widening retrieval", async () => {
  const s = await seed()
  for (const options of [
    { limit: 1 },
    { limit: 129 },
    { detailsBytes: -1 },
    { detailsBytes: 1_048_577 },
    { ownedAfterSeq: -1 },
    { cycleAfterSeq: 1.5 },
  ]) {
    const result = await on(
      s.location,
      Effect.result(readReviewInformation(s.packet, { kind: "cycle" }, options))
    )
    expect(result._tag).toBe("Failure")
  }
})
