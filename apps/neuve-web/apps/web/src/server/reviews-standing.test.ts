// Why: the Reviews page's "units wait on you", its "Waiting on you" filter, each row's squares and
// "to decide", and "Open next" must count what Records' own closure rule leaves open, and only in
// the review that holds the work now. These run the loader's Records reads (`standingOf`) on real
// temporary stores, so the closure, the carried decision, the lockfile mark and the lineage are
// Records' own, not a hand-written answer.
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  Blobs,
  Lineage,
  Log,
  ReviewList,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core"
import {
  contentLayer,
  storeContent,
} from "../../../../../../packages/records-core/tests/new-shape-support"
import { newShapeReview } from "../../../../../../packages/records-core/tests/review-fixtures"
import {
  agent,
  envelope,
  freshLocation,
  human,
  removeTemporaryDirectories,
  runOn,
} from "../../../../../../packages/records-core/tests/support"

import { deskRead, successorOf } from "./desk.server"
import { standingOf, summaryOf, waitingOf } from "./reviews.server"
import type { UnitStanding } from "./reviews.server"

afterAll(removeTemporaryDirectories)

type Location = ReturnType<typeof freshLocation>
type Lane =
  "human-required" | "human-suggested" | "agentic" | "static-automation"
type Verdict = "approve" | "request-changes"

const read = <TResult, TError, TNeeds>(
  location: Location,
  program: Effect.Effect<TResult, TError, TNeeds>
) =>
  runOn(
    location,
    program.pipe(Effect.provide(contentLayer(location))) as Effect.Effect<
      TResult,
      unknown,
      never
    >
  )

const registrations = [
  envelope("actor.registered@1", `actor:${agent}`, agent, undefined, {
    actorKind: "agent",
    harness: "neuve",
    sessionId: "reviews-standing",
  }),
  envelope("actor.registered@1", `actor:${human}`, human, undefined, {
    actorKind: "human",
    harness: "git",
    email: "owner@example.com",
  }),
]

interface UnitSpec {
  readonly lane: Lane
  /** The agent's disposition on it. */
  readonly agent?: Verdict
  /** A person's disposition on it. */
  readonly person?: Verdict
  /** The agent's own retraction of its disposition (`disposition.retracted@1`). */
  readonly agentRetracted?: true
  /** Earlier units whose work this one now holds (`lineage.recorded@1`). */
  readonly from?: ReadonlyArray<{
    readonly unitId: string
    readonly cycleId: string
  }>
}

/** The agent's disposition on a unit, and its own retraction of it when `spec` asks. */
const agentDecision = (
  spec: UnitSpec,
  unitId: string,
  attribution: { readonly cycleId: string; readonly unitIds: Array<string> },
  headOid: string
) => {
  if (!spec.agent) return []
  const decision = envelope(
    "disposition.recorded@1",
    `disposition:${unitId}:agent`,
    agent,
    attribution,
    { verdict: spec.agent, reviewedHeadOid: headOid }
  )
  return spec.agentRetracted
    ? [
        decision,
        envelope(
          "disposition.retracted@1",
          `retraction:${unitId}:agent`,
          agent,
          attribution,
          {},
          { supersedes: decision.id }
        ),
      ]
    : [decision]
}

/**
 * One review of the old shape: a cycle on `head`, one batch of `units`,
 * each recorded, assessed in its lane and disposed as asked, its lineage,
 * a packet of record whose manifest names them, and the request whose run
 * lists it on the Reviews page.
 */
const oldReview = (head: string, units: ReadonlyArray<UnitSpec>) => {
  const cycleId = mintUlid()
  const batchId = mintUlid()
  const runId = mintUlid()
  const range = {
    baseRef: "refs/heads/main",
    baseOid: "b".repeat(40),
    headOid: head.padEnd(40, "0"),
  }
  const unitIds = units.map(() => mintUlid())
  const on = (unitId: string) => ({ cycleId, unitIds: [unitId] })
  const perUnit = units.map((spec, index) => {
    const unitId = unitIds[index]
    return [
      envelope(
        "unit.recorded@2",
        `unit:${unitId}`,
        agent,
        { cycleId, batchId, unitIds: [unitId] },
        {
          title: `Unit ${index + 1}`,
          ownedRanges: [
            {
              kind: "lines",
              path: `src/${index}.ts`,
              side: "new",
              startLine: 1,
              endLine: 9,
            },
          ],
          grouping: { gapLines: 20 },
        }
      ),
      envelope(
        "assessment.recorded@1",
        `assessment:${unitId}`,
        agent,
        on(unitId),
        {
          lane: spec.lane,
          complexity: "low",
          easeOfValidation: "easy",
          rationale: "As the test asks.",
        }
      ),
      ...agentDecision(spec, unitId, on(unitId), range.headOid),
      ...(spec.person
        ? [
            envelope(
              "disposition.recorded@1",
              `disposition:${unitId}:person`,
              human,
              on(unitId),
              {
                verdict: spec.person,
                reviewedHeadOid: range.headOid,
              }
            ),
          ]
        : []),
      ...(spec.from
        ? [
            envelope(
              "lineage.recorded@1",
              `lineage:${unitId}`,
              agent,
              {
                cycleId,
                unitIds: [unitId, ...spec.from.map((entry) => entry.unitId)],
              },
              {
                from: spec.from.map((entry) => ({
                  ...entry,
                  relation: "changed",
                  unchanged: 0,
                  changed: 1,
                  lane: "human-required",
                })),
              }
            ),
          ]
        : []),
    ]
  })
  const structure = [
    envelope(
      "cycle.opened@1",
      `cycle:${cycleId}`,
      agent,
      { cycleId, range },
      {}
    ),
    envelope(
      "batch.recorded@1",
      `batch:${batchId}`,
      agent,
      { cycleId, batchId },
      {
        title: `Review of ${head}`,
        focus: "Focus",
      }
    ),
    ...perUnit.flat(),
  ]
  const manifest = canonicalJson({
    batches: [
      {
        batch: "b1",
        batchId,
        units: unitIds.map((unitId, index) => ({
          unit: `b1.u${index + 1}`,
          unitId,
          events: perUnit[index].map((event) => ({
            kind: event.kind,
            id: event.id,
          })),
        })),
        events: [],
      },
    ],
  })
  const run = { cycleId, range, runId }
  const packet = (hash: string) => ({
    ...envelope("packet.published@1", `review:${runId}:packet`, agent, run, {
      complete: true,
      counts: {
        batches: 1,
        units: units.length,
        contextReferences: 0,
        assessments: units.length,
        deliveries: 0,
        dispositions: units.filter((unit) => unit.agent).length,
        comments: 0,
        gaps: 0,
      },
    }),
    refs: [{ ref: `blob:${hash}`, role: "manifest" }],
  })
  const request = envelope(
    "review.requested@1",
    `request:${cycleId}`,
    agent,
    { cycleId, range },
    {
      runKey: sha256Hex(runId),
      generation: 0,
      pipeline: { version: 1, config: {} },
    }
  )
  return { cycleId, unitIds, structure, manifest, packet, request }
}

type Review = ReturnType<typeof oldReview>

/** Appends the reviews in order, each published and requested; ULIDs keep the order. */
const seed = async (reviews: ReadonlyArray<Review>) => {
  const location = freshLocation()
  await read(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore
      yield* Log.append(registrations)
      for (const review of reviews) {
        const held = yield* blobs.put({
          bytes: new TextEncoder().encode(review.manifest),
          mediaType: "application/json",
          retention: "durable",
        })
        yield* Log.append([
          ...review.structure,
          review.packet(held.blob.hash),
          review.request,
        ])
      }
    })
  )
  return location
}

/** The loader's Records reads: the listed reviews and Records' word on their units. */
const load = (location: Location) =>
  read(
    location,
    Effect.gen(function* () {
      const listed = (yield* ReviewList.reviews({ limit: 200 })).reviews
      return { listed, standing: yield* standingOf(listed) }
    })
  )

const row = (
  listed: ReadonlyArray<ReviewList.ListedReview>,
  standing: UnitStanding,
  cycleId: string
) => {
  const review = listed.find((entry) => entry.cycleId === cycleId)
  if (!review) throw new Error(`review ${cycleId} is not listed`)
  return summaryOf(review, standing, new Set(), undefined)
}

test("Records' closure decides what waits: an agent's disposition closes human-suggested work, never human-required", async () => {
  const review = oldReview("1111111", [
    { lane: "human-suggested", agent: "approve" },
    { lane: "human-suggested" },
    { lane: "human-required", agent: "request-changes" },
    { lane: "human-required", person: "approve" },
    { lane: "agentic", agent: "approve" },
  ])
  const { listed, standing } = await load(await seed([review]))
  const summary = row(listed, standing, review.cycleId)
  // The agent's approval stands on the first, as the vocabulary's Human-suggested says.
  expect(summary.gate).toEqual([
    { lane: "human-suggested", mark: "approved" },
    { lane: "human-suggested", mark: "waiting" },
    { lane: "human-required", mark: "waiting" },
    { lane: "human-required", mark: "approved" },
  ])
  expect(summary.batches[0]?.needYou).toBe(2)
  expect(summary.newer).toBeUndefined()
  const across = waitingOf(listed, standing)
  expect(across.units).toBe(2)
  expect(across.waiting.map((entry) => entry.cycleId)).toEqual([review.cycleId])
  // Open next opens the first waiting unit in packet order: the undecided human-suggested one.
  expect(across.nextUnitId).toBe(review.unitIds[1])
})

/** A new-shape review from the records lane's fixture, stored with its content. */
const seedNewShape = async (options: Parameters<typeof newShapeReview>[0]) => {
  const location = freshLocation()
  const fixture = newShapeReview(options)
  await read(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture)
      yield* Log.append([
        ...registrations,
        ...fixture.all.filter((event) => event.kind !== "actor.registered@1"),
        envelope(
          "review.requested@1",
          `request:${fixture.cycleId}`,
          agent,
          {
            cycleId: fixture.cycleId,
            range: {
              baseRef: "refs/heads/main",
              baseOid: "b".repeat(40),
              headOid: "a".repeat(40),
            },
          },
          {
            runKey: sha256Hex(fixture.runId),
            generation: 0,
            pipeline: { version: 1, config: {} },
          }
        ),
      ])
    })
  )
  return { location, fixture }
}

test("a person's carried decision closes a human-required unit no agent decided", async () => {
  const without = await seedNewShape({})
  const before = await load(without.location)
  // Without the carried decision the unit no agent decided waits on a person.
  expect(before.standing.decided.has(without.fixture.units.small)).toBe(false)
  expect(
    waitingOf(before.listed, before.standing).units
  ).toBeGreaterThanOrEqual(1)
  const carried = await seedNewShape({ carried: true })
  const after = await load(carried.location)
  expect(after.standing.decided.get(carried.fixture.units.small)).toBe(
    "approve"
  )
  const summary = row(after.listed, after.standing, carried.fixture.cycleId)
  expect(summary.gate).toContainEqual({
    lane: "human-required",
    mark: "approved",
  })
})

test("a lockfile unit no agent read never waits on a person, and draws no square", async () => {
  const { location, fixture } = await seedNewShape({ excluded: true })
  const lock = fixture.lock!.unitId
  const { listed, standing } = await load(location)
  // Records holds it open (human-suggested with no disposition); the page still never asks for it.
  expect(standing.decided.has(lock)).toBe(false)
  expect(standing.notRead.has(lock)).toBe(true)
  const summary = row(listed, standing, fixture.cycleId)
  const lockBatch = summary.batches.find(
    (batch) => batch.id === fixture.lock!.batchId
  )
  expect(lockBatch).toMatchObject({ unitCount: 1, needYou: 0 })
  expect(waitingOf(listed, standing).nextUnitId).not.toBe(lock)
})

/** Two branches: branch one reviewed at two heads, the second holding the first's work; branch two once. */
const twoBranches = () => {
  const first = oldReview("aaaaaaa", [
    { lane: "human-required" },
    { lane: "human-suggested" },
    { lane: "agentic", agent: "approve" },
  ])
  const other = oldReview("ccccccc", [{ lane: "human-required" }])
  const on = (index: number) => ({
    unitId: first.unitIds[index],
    cycleId: first.cycleId,
  })
  const moved = oldReview("bbbbbbb", [
    { lane: "human-required", from: [on(0)] },
    { lane: "human-suggested", agent: "approve", from: [on(1)] },
    { lane: "agentic", agent: "approve", from: [on(2)] },
  ])
  return { first, other, moved }
}

test("an older review of a branch counts nothing; the newer counts its own, and another branch counts too", async () => {
  const { first, other, moved } = twoBranches()
  const { listed, standing } = await load(await seed([first, other, moved]))
  const older = row(listed, standing, first.cycleId)
  // Its row asks for nothing a newer review holds, and says a newer one does.
  expect(older).toMatchObject({ newer: true, gate: [] })
  expect(older.batches.map((batch) => batch.needYou)).toEqual([0])
  // Its lanes stay as published.
  expect(older.lanes).toEqual([
    { lane: "human-required", count: 1 },
    { lane: "human-suggested", count: 1 },
    { lane: "agentic-review", count: 1 },
  ])
  expect(row(listed, standing, moved.cycleId)).toMatchObject({
    gate: [
      { lane: "human-required", mark: "waiting" },
      { lane: "human-suggested", mark: "approved" },
    ],
  })
  const across = waitingOf(listed, standing)
  // The newer review's one undecided unit, and the other branch's: never the older review's two.
  expect(across.units).toBe(2)
  expect(across.waiting.map((entry) => entry.cycleId).sort()).toEqual(
    [moved.cycleId, other.cycleId].sort()
  )
  expect(across.nextUnitId).toBe(moved.unitIds[0])
})

test("a review a newer one took over in part counts the units it still holds", async () => {
  const first = oldReview("ddddddd", [
    { lane: "human-required" },
    { lane: "human-required" },
  ])
  const moved = oldReview("eeeeeee", [
    {
      lane: "human-required",
      person: "approve",
      from: [{ unitId: first.unitIds[0], cycleId: first.cycleId }],
    },
  ])
  const { listed, standing } = await load(await seed([first, moved]))
  const summary = row(listed, standing, first.cycleId)
  expect(summary.newer).toBeUndefined()
  expect(summary.gate).toEqual([{ lane: "human-required", mark: "waiting" }])
  expect(summary.batches[0]?.needYou).toBe(1)
  expect(waitingOf(listed, standing)).toMatchObject({
    units: 1,
    nextUnitId: first.unitIds[1],
  })
})

test("the Reviews page stops counting a unit exactly where its desk page links to a newer review", async () => {
  const { first, other, moved } = twoBranches()
  const location = await seed([first, other, moved])
  const { standing } = await load(location)
  // The human units: the ones the page asks about.
  const units = [
    first.unitIds[0],
    first.unitIds[1],
    other.unitIds[0],
    moved.unitIds[0],
    moved.unitIds[1],
  ]
  // The unit page's own load: its header's "Newer review" link is `newer`.
  const linked = await read(
    location,
    Effect.forEach(units, (unitId) =>
      Effect.map(
        deskRead(unitId, { viewer: undefined }),
        (found) => "newer" in found && found.newer !== undefined
      )
    )
  )
  // One rule: the desk links a unit to a newer review exactly when the page stops counting it.
  expect(units.map((unitId) => standing.takenOver.has(unitId))).toEqual(linked)
  expect(linked).toEqual([true, true, false, false, false])
})

test("an agent's approval it retracted no longer closes human-suggested work: the unit waits again", async () => {
  const review = oldReview("2222222", [
    { lane: "human-suggested", agent: "approve", agentRetracted: true },
    { lane: "human-suggested", agent: "approve" },
  ])
  const { listed, standing } = await load(await seed([review]))
  // Records' rule for a disposition in force: its author's retraction ends it.
  expect(standing.decided.has(review.unitIds[0])).toBe(false)
  expect(standing.decided.get(review.unitIds[1])).toBe("approve")
  expect(row(listed, standing, review.cycleId).gate).toEqual([
    { lane: "human-suggested", mark: "waiting" },
    { lane: "human-suggested", mark: "approved" },
  ])
  expect(waitingOf(listed, standing)).toMatchObject({
    units: 1,
    nextUnitId: review.unitIds[0],
  })
})

// Why: the Reviews page hands the desk's successor walk the lineage it already read in one batch,
// so the walk skips its own reads; it must give exactly the answers the walk gives reading each
// unit itself, or the page and the "Newer review" link would part ways.
test("the batched lineage gives the desk's successor walk the same answers as its own reads: a chain, a split, no lineage", async () => {
  const unit = { lane: "human-required" as const }
  const first = oldReview("1111111", [unit, unit, unit])
  // A chain: each unit's work moves on, head by head.
  const second = oldReview("2222222", [
    { ...unit, from: [{ unitId: first.unitIds[0], cycleId: first.cycleId }] },
    // A split: one earlier unit's work is held by two later ones.
    { ...unit, from: [{ unitId: first.unitIds[1], cycleId: first.cycleId }] },
    { ...unit, from: [{ unitId: first.unitIds[1], cycleId: first.cycleId }] },
  ])
  const third = oldReview("3333333", [
    { ...unit, from: [{ unitId: second.unitIds[0], cycleId: second.cycleId }] },
  ])
  // No lineage: first.unitIds[2] and another branch's unit.
  const other = oldReview("4444444", [unit])
  const reviews = [first, second, third, other]
  const location = await seed(reviews)
  const all = reviews.flatMap((review) =>
    review.unitIds.map((unitId) => ({ unitId, cycleId: review.cycleId }))
  )
  // Each walk as an older page asks it (later than its review), later than a review the
  // chain passes through (so the walk takes a second step), and with no bound.
  const asks = all.flatMap(({ unitId, cycleId }) => [
    { unitId, laterThan: cycleId },
    { unitId, laterThan: second.cycleId },
    { unitId, laterThan: undefined },
  ])
  const answers = await read(
    location,
    Effect.gen(function* () {
      const everything = yield* Lineage.successorsMany(
        all.map(({ unitId }) => unitId)
      )
      // Only the first review's units: later steps read their own lineage.
      const part = yield* Lineage.successorsMany(first.unitIds)
      const walk = (
        successors:
          ReadonlyMap<string, ReadonlyArray<Lineage.Successor>> | undefined
      ) =>
        Effect.forEach(asks, ({ unitId, laterThan }) =>
          successorOf(unitId, {
            laterThan,
            ...(successors ? { successors } : {}),
          })
        )
      return {
        own: yield* walk(undefined),
        batched: yield* walk(everything),
        partial: yield* walk(part),
      }
    })
  )
  expect(answers.batched).toEqual(answers.own)
  expect(answers.partial).toEqual(answers.own)
  // The walks found what the store holds: the chain to its newest head, the split's newest unit,
  // the second step past the second review, and nothing for the units no lineage names.
  const of = (unitId: string, laterThan: string | undefined) =>
    answers.own[
      asks.findIndex(
        (ask) => ask.unitId === unitId && ask.laterThan === laterThan
      )
    ]?.unitId
  expect(of(first.unitIds[0], first.cycleId)).toBe(second.unitIds[0])
  expect(of(first.unitIds[0], second.cycleId)).toBe(third.unitIds[0])
  expect([second.unitIds[1], second.unitIds[2]]).toContain(
    of(first.unitIds[1], first.cycleId) ?? "none"
  )
  expect(of(first.unitIds[2], first.cycleId)).toBeUndefined()
  expect(of(other.unitIds[0], other.cycleId)).toBeUndefined()
})
