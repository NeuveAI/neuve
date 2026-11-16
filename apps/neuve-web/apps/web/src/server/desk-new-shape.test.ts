// Why: the desk now reads a review through records-core's read model of both packet shapes
// (`readStanding`). A new-shape review must reach the overview, the unit page and the Reviews page
// whole (every unit's lane, every one of a large unit's ranges, the pending count never counted as
// waiting on a person, a unit no agent decided marked without its cause, the impact finding first,
// the lane it rose from), and an old-shape review beside it must project exactly as the version 1
// reader gave it, so nothing a person reads today moves. An old unit link must lead to the unit that
// holds its work now (and nothing else), a unit's page must carry a row per section with the mark on
// each one no agent decided, and a missing sections blob or judgements body must reach the page as a
// limitation in a reader's words, never as a thrown read. These run the loads' Records reads on a
// real temporary store seeded with the records lane's fixtures; git is replaced by hand-built
// sources, since the fixtures' commits are not in any repository.
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  Blobs,
  HumanCommands,
  Identity,
  Log,
  PublishedPackets,
  ReviewList,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core"
import {
  contentLayer,
  storeContent,
} from "../../../../../../packages/records-core/tests/new-shape-support"
import {
  newShapeReview,
  reviewEvents,
} from "../../../../../../packages/records-core/tests/review-fixtures"
import {
  agent,
  envelope,
  freshLocation,
  human,
  removeTemporaryDirectories,
  runOn,
} from "../../../../../../packages/records-core/tests/support"

import {
  deskMissing,
  deskRead,
  deskReady,
  overviewOf,
  opening,
  opensAt,
  overviewRead,
  rangeOf,
  replacedBatchSuccessor,
} from "./desk.server"
import { LANE_FACTS } from "./lane-facts"
import { overviewData, personFrom } from "./projection"
import type { Sources } from "./projection"
import { NO_STANDING, summaryOf } from "./reviews.server"

afterAll(removeTemporaryDirectories)

type Location = ReturnType<typeof freshLocation>

const range = {
  baseRef: "refs/heads/main",
  baseOid: "b".repeat(40),
  headOid: "a".repeat(40),
}

/**
 * The old-shape review with a manifest Records holds. Its third unit is
 * left out of the manifest, as a unit of a packet a later one superseded
 * is: the new-shape review's lineage names it as an earlier unit.
 */
const oldShape = () => {
  const fixture = reviewEvents()
  const events = [...fixture.structure, ...Object.values(fixture.comments)]
  const onUnit = (unitId: string) =>
    events
      .filter((e) =>
        (
          e.attribution as { unitIds?: ReadonlyArray<string> } | undefined
        )?.unitIds?.includes(unitId)
      )
      .map((e) => ({ kind: e.kind, id: e.id }))
  const manifest = canonicalJson({
    batches: [
      {
        batch: "b1",
        batchId: fixture.batchId,
        units: fixture.units.slice(0, 2).map((unitId, index) => ({
          unit: `b1.u${index + 1}`,
          unitId,
          events: onUnit(unitId),
        })),
        events: [],
      },
    ],
  })
  return { fixture, manifest }
}

/**
 * Runs a load's Records read on the store, with its blobs and computations:
 * the services `readRecords` provides a load (the store and file system come
 * from `runOn`).
 */
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

/**
 * A store holding both reviews. `published` leaves the new-shape review at
 * its first publication (one batch out, one pending); `skip` leaves stored
 * content out by the fixture's label.
 */
const seed = async (
  options: {
    readonly published?: 1 | 2
    readonly skip?: ReadonlyArray<string>
    /** Changes the new-shape fixture's events before they are appended. */
    readonly mutate?: (fixture: ReturnType<typeof newShapeReview>) => void
    /** The new-shape fixture's own options (`carried`, `excluded`). */
    readonly review?: Omit<Parameters<typeof newShapeReview>[0], "earlier">
    /** Events appended after the registrations, before the reviews' (another person's registration). */
    readonly before?: ReadonlyArray<Parameters<typeof Log.append>[0][number]>
  } = {}
) => {
  const location = freshLocation()
  const old = oldShape()
  const fixture = newShapeReview({
    ...options.review,
    earlier: { unitId: old.fixture.units[2], cycleId: old.fixture.cycleId },
  })
  options.mutate?.(fixture)
  const second = [fixture.events.second.id, fixture.events.gaps.second.id]
  const oldPacket = await read(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode(old.manifest),
        mediaType: "application/json",
        retention: "durable",
      })
      const packet = {
        ...old.fixture.packet,
        refs: [{ ref: `blob:${held.blob.hash}`, role: "manifest" }],
      }
      yield* storeContent(fixture, options.skip ?? [])
      yield* Log.append([
        ...old.fixture.registrations,
        ...(options.before ?? []),
        ...old.fixture.structure,
        ...Object.values(old.fixture.comments),
        packet,
        ...fixture.all.filter(
          (e) =>
            e.kind !== "actor.registered@1" &&
            (options.published === 1 ? !second.includes(e.id) : true)
        ),
        // The request whose run publishes it, so the Reviews page lists it.
        envelope(
          "review.requested@1",
          `request:${fixture.cycleId}`,
          agent,
          { cycleId: fixture.cycleId, range },
          {
            runKey: sha256Hex(fixture.runId),
            generation: 0,
            pipeline: { version: 1, config: {} },
          }
        ),
      ])
      return packet.id
    })
  )
  return { location, old: old.fixture, fixture, oldPacket }
}

const NOBODY = { people: false, viewer: undefined } as const

/** Git's files for the large unit: every line of both sides changed, so all its ranges draw. */
const largeSources = (): Sources => {
  const contents = Array.from({ length: 2_600 }, (_, i) => `line ${i + 1}`)
    .join("\n")
    .concat("\n")
  return {
    mergeBase: range.baseOid,
    head: range.headOid,
    blobs: {},
    files: {
      "src/large.ts": {
        path: "src/large.ts",
        oldPath: "src/large.ts",
        newPath: "src/large.ts",
        binary: false,
        oldContents: contents,
        newContents: contents,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2_600,
            newStart: 1,
            newLines: 2_600,
            text: "@@ -1,2600 +1,2600 @@\n",
            added: 2_600,
            deleted: 2_600,
            changed: [
              { side: "old", startLine: 1, lineCount: 2_600 },
              { side: "new", startLine: 1, lineCount: 2_600 },
            ],
          },
        ],
      },
    },
  }
}

const NO_SOURCES: Sources = {
  mergeBase: range.baseOid,
  head: range.headOid,
  files: {},
  blobs: {},
}

test("a new-shape review reads whole on the overview, the unit page and the Reviews page", async () => {
  const { location, fixture } = await seed()
  const [batchA, batchB] = fixture.batches
  const loads = await read(
    location,
    Effect.gen(function* () {
      return {
        a: yield* overviewRead(batchA, NOBODY),
        b: yield* overviewRead(batchB, NOBODY),
        large: yield* deskRead(fixture.units.large, { viewer: undefined }),
        small: yield* deskRead(fixture.units.small, { viewer: undefined }),
        listed: yield* ReviewList.reviews({ limit: 10 }),
      }
    })
  )
  if (!loads.a || !loads.b) throw new Error("expected both batches")
  const a = overviewOf(loads.a, "acme/docs-app")
  const b = overviewOf(loads.b, "acme/docs-app")

  // Lanes per unit, from the version 4 assessments; nothing pending once whole.
  expect(a.units?.map((unit) => [unit.id, unit.lane])).toEqual([
    [fixture.units.large, "human-suggested"],
  ])
  expect(b.units?.map((unit) => [unit.id, unit.lane])).toEqual([
    [fixture.units.small, "human-required"],
  ])
  expect(a.batches?.all.map((batch) => batch.id)).toEqual([batchA, batchB])
  expect(a.batches).not.toHaveProperty("pending")

  // The large unit rose from agentic review (its lineage), and code titled
  // it, so it is named by its file and every new-side span it owns.
  const large = a.units?.[0]
  expect(large?.raisedFrom).toBe("agentic-review")
  expect(large?.title).toBe("Large file")
  expect(large?.untitled?.files).toHaveLength(1)
  expect(large?.untitled?.files[0]?.path).toBe("src/large.ts")
  expect(large?.untitled?.files[0]?.lines).toHaveLength(550)

  // The impact finding leads the batch's briefing in its one-line summary
  // (the body stays the full comment), linking to its unit.
  expect(a.contextualBriefing?.removed).toEqual([
    {
      kind: "phrase",
      text: "Retries stop after two attempts instead of five.",
      target: { kind: "unit", unitId: fixture.units.large },
    },
  ])
  expect(a.briefing).toBe("Retries stop after two attempts instead of five.")
  // This batch's gap and the review's, never another batch's or why a
  // section went undecided; a gap Records does not hold, in a reader's words.
  expect(a.contextualBriefing?.limitations).toEqual([
    "The batch gap.",
    "Part of this review's limitations couldn't be read, so some may not be shown.",
  ])

  // The unit no agent decided: human-required work, marked, with no review.
  expect(b.needYou).toBe(1)
  expect(b.judgment).toEqual([
    expect.objectContaining({
      id: fixture.units.small,
      title: "Small file",
      noAgentDecision: true,
      untitled: {
        files: [{ path: "src/small.ts", lines: [{ start: 4, end: 6 }] }],
      },
    }),
  ])
  expect(b.units?.[0]).not.toHaveProperty("review")

  // The unit page: every one of the 1,100 ranges owned, the impact finding
  // first, the rise on the unit.
  if ("missing" in loads.large || "missing" in loads.small)
    throw new Error("expected both units to open")
  const deskLarge = deskReady(loads.large, "acme/docs-app", largeSources())
  if (deskLarge.load.status !== "ready") throw new Error("expected a desk")
  const desk = deskLarge.load.data
  // With no Briefed, its Facts lead, read as a Briefed is: the link to its
  // own unit is a plain phrase, and no local ID shows.
  expect(desk.unit.briefing).toEqual([
    { kind: "text", text: "The retry loop changes." },
  ])
  expect(desk.unit).toMatchObject({
    title: "Large file",
    lane: "human-suggested",
    raisedFrom: "agentic-review",
  })
  expect(desk.unit).not.toHaveProperty("noAgentDecision")
  const file = desk.files[0]
  expect(file.path).toBe("src/large.ts")
  expect(
    file.responsibility?.kind === "changed-ranges"
      ? file.responsibility.ownedSource.length
      : 0
  ).toBe(1_100)
  expect(desk.commentRecords?.[0]?.id).toBe(fixture.events.impact.id)
  expect(desk.batches?.all.map((batch) => batch.id)).toEqual([batchA, batchB])

  const deskSmall = deskReady(loads.small, "acme/docs-app", NO_SOURCES)
  if (deskSmall.load.status !== "ready") throw new Error("expected a desk")
  expect(deskSmall.load.data.unit).toMatchObject({
    lane: "human-required",
    noAgentDecision: true,
  })
  expect(deskSmall.load.data.unit).not.toHaveProperty("attribution")

  // Nothing of why the section went undecided reaches either page.
  const shown = JSON.stringify([a, b, desk, deskSmall.load.data])
  for (const word of ["undecided", "failed", "The second gap."])
    expect(shown).not.toContain(word)

  // The Reviews page: its lanes, both units waiting on a person, nothing pending.
  const listed = loads.listed.reviews.find(
    (review) => review.cycleId === fixture.cycleId
  )
  if (!listed) throw new Error("expected the review listed")
  const summary = summaryOf(listed, NO_STANDING, new Set(), undefined)
  expect(summary.lanes).toEqual([
    { lane: "human-required", count: 1 },
    { lane: "human-suggested", count: 1 },
  ])
  expect(summary.gate).toHaveLength(2)
  expect(summary).not.toHaveProperty("pendingBatches")
})

test("a batch still to publish is counted as pending, never as waiting on a person, until it arrives", async () => {
  const { location, fixture } = await seed({ published: 1 })
  const [batchA, batchB] = fixture.batches
  const first = await read(
    location,
    Effect.gen(function* () {
      return {
        overview: yield* overviewRead(undefined, NOBODY),
        missing: yield* overviewRead(batchB, NOBODY),
        listed: yield* ReviewList.reviews({ limit: 10 }),
      }
    })
  )
  if (!first.overview) throw new Error("expected the first batch")
  const overview = overviewOf(first.overview, "acme/docs-app")
  expect(overview.batches?.pending).toBe(1)
  // Its run's job is still open, so the review has not stopped short.
  expect(overview.batches).not.toHaveProperty("stopped")
  expect(overview.batches?.all).toEqual([
    expect.objectContaining({ id: batchA, unitCount: 1, needYou: 0 }),
  ])
  expect(overview.needYou).toBe(0)
  // The batch to come has no overview yet.
  expect(first.missing).toBeUndefined()
  const listed = first.listed.reviews.find(
    (review) => review.cycleId === fixture.cycleId
  )
  if (!listed) throw new Error("expected the review listed")
  const summary = summaryOf(listed, NO_STANDING, new Set(), undefined)
  expect(summary.pendingBatches).toBe(1)
  // Only the published human-suggested unit waits; nothing of the pending batch.
  expect(summary.gate).toEqual([{ lane: "human-suggested", mark: "waiting" }])

  // The second batch arrives.
  await runOn(
    location,
    Log.append([fixture.events.gaps.second, fixture.events.second])
  )
  const after = await read(location, overviewRead(batchB, NOBODY))
  if (!after) throw new Error("expected the second batch")
  const arrived = overviewOf(after, "acme/docs-app")
  expect(arrived.batches).not.toHaveProperty("pending")
  expect(arrived.needYou).toBe(1)
})

test("an old-shape review projects exactly as the version 1 reader gave it, and reads nothing of the new shape through it", async () => {
  const { location, old, fixture, oldPacket } = await seed()
  const reads = await read(
    location,
    Effect.gen(function* () {
      return {
        before: yield* PublishedPackets.standingPacket(old.cycleId, {
          repository: process.cwd(),
        }),
        range: yield* rangeOf(old.cycleId),
        overview: yield* overviewRead(old.batchId, NOBODY),
        unit: yield* deskRead(old.units[0], { viewer: undefined }),
        newStanding: yield* PublishedPackets.standingPacket(fixture.cycleId),
        newExact: yield* PublishedPackets.exactPacket(fixture.events.second.id),
        newRun: yield* PublishedPackets.runPacket(fixture.runId),
      }
    })
  )
  if (!reads.before || !reads.range || !reads.overview)
    throw new Error("expected the old review")
  expect(reads.overview.found.packet.eventId).toBe(oldPacket)
  const before = overviewData({
    repo: "acme/docs-app",
    range: reads.range,
    packet: reads.before,
    batch: reads.before.batches[0],
    newest: false,
  })
  expect(overviewOf(reads.overview, "acme/docs-app")).toEqual(before)
  expect(before.units?.length).toBeGreaterThan(0)
  // The unit page too: the same unit, read either way, projects the same.
  if ("missing" in reads.unit) throw new Error("expected the old unit to open")
  const oldBatch = reads.before.batches[0]
  const oldUnit = oldBatch.units.find((unit) => unit.unitId === old.units[0])
  if (!oldUnit) throw new Error("expected the old unit")
  expect(deskReady(reads.unit, "acme/docs-app", NO_SOURCES)).toEqual(
    deskReady(
      {
        ...reads.unit,
        // The version 1 reader's packet, marked with its kind as `readStanding` marks it.
        found: {
          ...reads.unit.found,
          packet: { kind: "packet.published@1" as const, ...reads.before },
        },
        batch: oldBatch,
        unit: oldUnit,
      },
      "acme/docs-app",
      NO_SOURCES
    )
  )
  // An old-shape unit's Facts still lead as written when it has no Briefed.
  const withFacts = {
    ...oldUnit,
    content: { facts: { text: "The [guard](h1a2b3c4d) holds.", cites: [] } },
  }
  const factsPage = deskReady(
    {
      ...reads.unit,
      batch: { ...oldBatch, units: [withFacts] },
      unit: withFacts,
    },
    "acme/docs-app",
    NO_SOURCES
  )
  if (factsPage.load.status !== "ready") throw new Error("expected a desk")
  expect(factsPage.load.data.unit.briefing).toEqual([
    { kind: "text", text: "The [guard](h1a2b3c4d) holds." },
  ])
  // The version 1 readers return nothing for a new-shape cycle: the desk
  // no longer reads through them, so it never half-reads one.
  expect(reads.newStanding).toBeUndefined()
  expect(reads.newExact).toBeUndefined()
  expect(reads.newRun).toBeUndefined()
  // The new seam answers neutrally for every old-shape unit.
  for (const unit of reads.before.batches[0].units) {
    expect(LANE_FACTS.noAgentDecision(unit)).toBe(false)
    expect(LANE_FACTS.titledByCode(unit)).toBe(false)
    expect(LANE_FACTS.raisedFrom(unit)).toBeUndefined()
  }
  expect(LANE_FACTS.pendingBatches(reads.before)).toBe(0)
})

/** A lineage event saying `successor` now holds sections of `earlier`. */
const lineageEvent = (
  cycleId: string,
  successor: string,
  earlier: string,
  relation: "unchanged" | "changed"
) =>
  envelope(
    "lineage.recorded@1",
    `lineage:${successor}:${earlier}`,
    agent,
    { cycleId, unitIds: [successor, earlier] },
    {
      from: [
        {
          unitId: earlier,
          cycleId,
          relation,
          unchanged: 1,
          changed: relation === "changed" ? 1 : 0,
          lane: "agentic",
        },
      ],
    }
  )

test("an old unit link opens the unit that holds its work now; anything that does not lead to an open unit is unknown", async () => {
  const { location, old, fixture } = await seed()
  // Units no packet holds: a two-step chain to the large unit, a loop of
  // two (bad lineage data) and a successor that does not open.
  const [chained, between, loopA, loopB, deadEnd, nowhere] = Array.from(
    { length: 6 },
    () => mintUlid()
  )
  await runOn(
    location,
    Log.append([
      lineageEvent(fixture.cycleId, between, chained, "unchanged"),
      lineageEvent(fixture.cycleId, fixture.units.large, between, "changed"),
      lineageEvent(fixture.cycleId, loopB, loopA, "changed"),
      lineageEvent(fixture.cycleId, loopA, loopB, "changed"),
      lineageEvent(fixture.cycleId, nowhere, deadEnd, "unchanged"),
    ])
  )
  const reads = await read(
    location,
    Effect.gen(function* () {
      return {
        earlier: yield* deskRead(old.units[2], { viewer: undefined }),
        chained: yield* deskRead(chained, { viewer: undefined }),
        loopA: yield* deskRead(loopA, { viewer: undefined }),
        loopB: yield* deskRead(loopB, { viewer: undefined }),
        deadEnd: yield* deskRead(deadEnd, { viewer: undefined }),
        unknown: yield* deskRead(mintUlid(), { viewer: undefined }),
      }
    })
  )
  const missing = (key: keyof typeof reads) => {
    const entry = reads[key]
    if (!("missing" in entry)) throw new Error(`expected ${key} not to open`)
    return deskMissing(entry, "x", "acme/docs-app")
  }
  // An old-cycle unit its packet left out, and one two lineage steps back.
  expect(missing("earlier")).toMatchObject({
    load: { status: "missing", reason: "unknown-unit" },
    successor: { unitId: fixture.units.large, relation: "changed" },
  })
  expect(missing("chained").successor).toEqual({
    unitId: fixture.units.large,
    relation: "changed",
  })
  // A loop and a successor that does not open end as an unknown unit, never
  // as a link to follow.
  for (const key of ["loopA", "loopB", "deadEnd", "unknown"] as const) {
    const load = missing(key)
    expect(load.load).toMatchObject({
      status: "missing",
      reason: "unknown-unit",
    })
    expect(load).not.toHaveProperty("successor")
  }
})

test("a new-shape unit's page has a row per section the read model holds, marking each section no agent decided", async () => {
  const { location, fixture } = await seed()
  const opened = await read(
    location,
    deskRead(fixture.units.large, { viewer: undefined })
  )
  if ("missing" in opened) throw new Error("expected the unit to open")
  const { k1, k2 } = fixture.sectionKeys
  const unit = opened.unit as PublishedPackets.ReadUnit
  // The large unit made human-required, its second section undecided: the
  // mix a file's human-required sections form.
  const mix = (options: {
    readonly briefed?: string
    readonly content: boolean
    /** The second section has content of its own too. */
    readonly every?: boolean
    /** The unit's own Facts text in place of the fixture's. */
    readonly facts?: string
  }) => {
    const changed: PublishedPackets.ReadUnit = {
      ...unit,
      judgement: { ...unit.judgement, lane: "human-required" },
      content: {
        ...unit.content,
        ...(options.briefed === undefined
          ? {}
          : { briefed: { text: options.briefed } }),
        ...(options.facts === undefined
          ? {}
          : { facts: { text: options.facts, cites: [] } }),
      },
      sections: unit.sections.map((section) => {
        const { content, ...rest } = section
        const own =
          options.every && content === undefined
            ? {
                ...unit.sections.find((other) => other.content)!.content!,
                briefed: "The entry point is renamed.",
                facts: { text: "The entry point is renamed.", cites: [] },
              }
            : content
        return {
          ...rest,
          ...(options.content && own ? { content: own } : {}),
          ...(section.key === k2
            ? { undecided: { cause: "failed", reading: "assess" } }
            : {}),
        }
      }),
    }
    const load = deskReady(
      {
        ...opened,
        unit: changed,
        batch: {
          ...(opened.batch as PublishedPackets.ReadBatch),
          units: [changed],
        },
      },
      "acme/docs-app",
      NO_SOURCES
    )
    if (load.load.status !== "ready") throw new Error("expected a desk")
    return load.load.data.unit
  }
  const rows = (page: ReturnType<typeof mix>) =>
    page.sections?.map((row) => [row.id, row.title, row.noAgentDecision])

  // No briefing at all: still one row per section, the undecided one marked.
  const bare = mix({ content: false })
  expect(bare).not.toHaveProperty("noAgentDecision")
  expect(rows(bare)).toEqual([
    [k1, "The retry loop", undefined],
    [k2, "The exported entry point", true],
  ])
  expect(bare.sections?.map((row) => row.briefing)).toEqual([[], []])

  // A one-paragraph briefing that does not split by section: the same rows,
  // and the paragraph leads.
  const paragraph = mix({
    briefed: "Retries give up sooner across the file.",
    content: false,
  })
  expect(rows(paragraph)).toEqual(rows(bare))
  expect(paragraph.briefing).toEqual([
    { kind: "text", text: "Retries give up sooner across the file." },
  ])

  // With the read model's content: the first row's own briefing, facts and
  // explained; the second, with none, keeps its mark.
  const told = mix({ content: true })
  expect(rows(told)).toEqual(rows(bare))
  expect(told.sections?.[0]).toMatchObject({
    briefing: [
      { kind: "text", text: "The retry loop now gives up after two attempts." },
    ],
    facts: [{ kind: "text", text: "The retry loop stops sooner." }],
    explained: { before: "It retried five times.", after: "It retries twice." },
  })
  expect(told.sections?.[1]).toMatchObject({ briefing: [] })
  expect(told.sections?.[1]).not.toHaveProperty("facts")
  // A part with no text of its own: the unit's Facts still lead, so nothing
  // of it is lost.
  expect(told.briefing).not.toEqual([])

  // Why: the unit's Facts are its parts' facts joined (now after a plain
  // sentence about the unit), so once every part says its own on its row, a
  // lead of the unit's Facts would say each twice. The lead keeps only what
  // the parts do not say, and is empty when that is nothing.
  const joined = "The retry loop stops sooner. The entry point is renamed."
  const every = mix({ content: true, every: true, facts: joined })
  expect(every.briefing).toEqual([])
  const sentence = mix({
    content: true,
    every: true,
    facts: `Retries and the entry point change. ${joined}`,
  })
  expect(sentence.briefing).toEqual([
    { kind: "text", text: "Retries and the entry point change." },
  ])
  expect(every.sections?.map((row) => row.briefing)).toEqual([
    [{ kind: "text", text: "The retry loop now gives up after two attempts." }],
    [{ kind: "text", text: "The entry point is renamed." }],
  ])
  // A Briefed of the unit's own still leads.
  const own = mix({
    content: true,
    every: true,
    briefed: "Retries give up sooner across the file.",
  })
  expect(own.briefing).toEqual([
    { kind: "text", text: "Retries give up sooner across the file." },
  ])
})

test("a missing sections blob or judgements body is a limitation on the page in a reader's words, never a thrown read", async () => {
  const { location, fixture, old } = await seed({
    skip: ["sections:Large file", "judgements:small"],
  })
  const [batchA, batchB] = fixture.batches
  const loads = await read(
    location,
    Effect.gen(function* () {
      return {
        a: yield* overviewRead(batchA, NOBODY),
        b: yield* overviewRead(batchB, NOBODY),
        old: yield* overviewRead(old.batchId, NOBODY),
        large: yield* deskRead(fixture.units.large, { viewer: undefined }),
      }
    })
  )
  if (!loads.a || !loads.b || !loads.old)
    throw new Error("expected every batch")
  type Read = NonNullable<typeof loads.a>
  const LINES =
    "The lines Large file owns couldn't be read, so its changes aren't shown."
  const JUDGED =
    "What the agents judged of Small file couldn't be read in full, so some of its checkpoints may not be shown."
  const DIGEST = { digest: "Retries and guards change." }
  /** The batch's page with no digest and no removal, and with a digest. */
  const pages = (loaded: Read) => {
    const without = {
      ...loaded,
      batch: {
        ...loaded.batch,
        digest: undefined,
        units: loaded.batch.units.map((unit) => ({ ...unit, comments: [] })),
      },
    }
    const digested = {
      ...loaded,
      batch: { ...loaded.batch, digest: DIGEST },
    }
    return [without, digested].map((page) =>
      overviewOf(page as Read, "acme/docs-app")
    )
  }
  for (const [loaded, sentence] of [
    [loads.a, LINES],
    [loads.b, JUDGED],
  ] as const) {
    const [without, digested] = pages(loaded)
    // No digest: the limitations reach the page with no segments of their own.
    expect(without.contextualBriefing).toMatchObject({ segments: [] })
    expect(without.contextualBriefing?.limitations).toContain(sentence)
    expect(digested.contextualBriefing?.limitations).toContain(sentence)
    expect(digested.contextualBriefing?.segments).toEqual([
      { kind: "text", text: DIGEST.digest },
    ])
  }
  // As read: the first batch also leads with its removal.
  expect(
    overviewOf(loads.a, "acme/docs-app").contextualBriefing?.limitations
  ).toContain(LINES)

  // The units keep their lanes and titles, and the small one its mark from
  // the assessment's counts.
  const a = overviewOf(loads.a, "acme/docs-app")
  const b = overviewOf(loads.b, "acme/docs-app")
  expect(a.units?.[0]).toMatchObject({
    lane: "human-suggested",
    title: "Large file",
  })
  expect(b.judgment[0]).toMatchObject({
    id: fixture.units.small,
    noAgentDecision: true,
  })

  // An old-shape batch keeps today's gate: with no digest, a limitation
  // still gives it no briefing.
  const oldUnread = {
    ...loads.old,
    found: {
      ...loads.old.found,
      packet: {
        ...loads.old.found.packet,
        undecoded: [
          { what: "manifest", ref: "blob:x", issue: "x", part: "manifest" },
        ],
      },
    },
  } as Read
  expect(
    overviewOf(oldUnread, "acme/docs-app").contextualBriefing
  ).toBeUndefined()

  // The unit page says its lines did not read, first, rather than open empty.
  if ("missing" in loads.large) throw new Error("expected the unit to open")
  const desk = deskReady(loads.large, "acme/docs-app", largeSources())
  if (desk.load.status !== "ready") throw new Error("expected a desk")
  expect(desk.load.data.files).toEqual([])
  expect(desk.load.data.unit.briefing[0]).toEqual({ kind: "text", text: LINES })
})

test("a sections blob that reads but disagrees with its unit's counts keeps every line and says only that some may not be shown", async () => {
  const { location, fixture } = await seed({
    mutate: (review) => {
      // The unit counts one range more than its blob holds.
      ;(
        review.events.units.large.payload as { ranges: { count: number } }
      ).ranges.count += 1
    },
  })
  const loads = await read(
    location,
    Effect.gen(function* () {
      return {
        a: yield* overviewRead(fixture.batches[0], NOBODY),
        large: yield* deskRead(fixture.units.large, { viewer: undefined }),
      }
    })
  )
  if (!loads.a) throw new Error("expected the batch")
  if ("missing" in loads.large) throw new Error("expected the unit to open")
  // The read model disclosed it, and kept every range.
  expect(
    loads.a.found.packet.undecoded.some(
      (item) => item.part === "unit-sections" && item.unit === "b1.u1"
    )
  ).toBe(true)
  const SOME = "Some of the lines Large file owns may not be shown."
  const limitations =
    overviewOf(loads.a, "acme/docs-app").contextualBriefing?.limitations ?? []
  expect(limitations).toContain(SOME)
  expect(limitations.join(" ")).not.toContain("couldn't be read, so its")
  const desk = deskReady(loads.large, "acme/docs-app", largeSources())
  if (desk.load.status !== "ready") throw new Error("expected a desk")
  expect(desk.load.data.unit.briefing[0]).toEqual({ kind: "text", text: SOME })
  const file = desk.load.data.files[0]
  expect(
    file.responsibility?.kind === "changed-ranges"
      ? file.responsibility.ownedSource.length
      : 0
  ).toBe(1_100)
})

test("an old link never leads to a unit the desk does not open", async () => {
  const { location } = await seed()
  // A review whose cycle has a standing packet but no `cycle.opened@1`: its
  // units are in that packet, and laned, yet the unit page cannot open them.
  const rangeless = oldShape()
  const orphan = mintUlid()
  await read(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode(rangeless.manifest),
        mediaType: "application/json",
        retention: "durable",
      })
      yield* Log.append([
        ...rangeless.fixture.structure.filter(
          (e) => e.kind !== "cycle.opened@1"
        ),
        ...Object.values(rangeless.fixture.comments),
        {
          ...rangeless.fixture.packet,
          refs: [{ ref: `blob:${held.blob.hash}`, role: "manifest" }],
        },
        lineageEvent(
          rangeless.fixture.cycleId,
          rangeless.fixture.units[0],
          orphan,
          "unchanged"
        ),
      ])
    })
  )
  const reads = await read(
    location,
    Effect.gen(function* () {
      return {
        held: yield* PublishedPackets.standingUnits(rangeless.fixture.cycleId),
        target: yield* deskRead(rangeless.fixture.units[0], {
          viewer: undefined,
        }),
        orphan: yield* deskRead(orphan, { viewer: undefined }),
      }
    })
  )
  // The successor is in its standing packet, and its own page does not open.
  expect(reads.held).toContain(rangeless.fixture.units[0])
  expect("missing" in reads.target).toBe(true)
  if (!("missing" in reads.orphan)) throw new Error("expected no unit")
  // No link to follow: the page is the unknown-unit state, framed by the
  // newest packet (here the rangeless one, so the frame itself is empty).
  const load = deskMissing(reads.orphan, orphan, "acme/docs-app")
  expect(load.load.status).not.toBe("ready")
  expect(load).not.toHaveProperty("successor")
})

// Why (12 November 2026, the owner's approval): a newer review of the same range replaces the
// standing one only when it is whole, and the live reload that brings it must not move a reader off
// the page they are on. Entering the page with a unit or batch that left the standing packet still
// follows the work (the old link's rule); a reload of that page keeps it, read from the packet it was
// in, and says where the work is now, by the redirect's own rule, or, with no unit that opens, where
// the newer review starts. A unit no packet holds is unknown either way.
test("a reload keeps a replaced unit or batch in place and says a newer review holds it; entering follows the work", async () => {
  const { location, old, fixture, oldPacket } = await seed()
  // The newer review of the old range: a packet that replaces the old one
  // whole, holding nothing of its batch.
  await read(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode('{"batches":[]}'),
        mediaType: "application/json",
        retention: "durable",
      })
      yield* Log.append([
        {
          ...old.packet,
          id: mintUlid(),
          idempotencyKey: `replacement:${old.runId}`,
          causation: { supersedes: oldPacket },
          attribution: { ...old.packet.attribution, runId: mintUlid() },
          refs: [{ ref: `blob:${held.blob.hash}`, role: "manifest" }],
        },
        // The first unit's work is in the large unit now; the second's in
        // no unit that opens.
        lineageEvent(
          old.cycleId,
          fixture.units.large,
          old.units[0],
          "unchanged"
        ),
      ])
    })
  )
  const reads = await read(
    location,
    Effect.gen(function* () {
      const on = (unitId: string, stay: boolean) =>
        deskRead(unitId, { viewer: undefined, stay })
      return {
        enteredFollowed: yield* on(old.units[0], false),
        stayedFollowed: yield* on(old.units[0], true),
        stayedNoSuccessor: yield* on(old.units[1], true),
        stayedUnknown: yield* on(mintUlid(), true),
        overviewEntered: yield* overviewRead(old.batchId, NOBODY),
        overviewStayed: yield* overviewRead(old.batchId, {
          ...NOBODY,
          stay: true,
        }),
      }
    })
  )
  // Entering: the old link's rule, unchanged.
  if (!("missing" in reads.enteredFollowed))
    throw new Error("expected entering to follow the work")
  expect(
    deskMissing(reads.enteredFollowed, old.units[0], "acme/docs-app").successor
  ).toEqual({ unitId: fixture.units.large, relation: "unchanged" })
  // Staying: the same unit, from the packet it was in, with the successor
  // that opens, and no redirect to follow.
  if ("missing" in reads.stayedFollowed)
    throw new Error("expected the reload to keep the unit")
  const kept = deskReady(reads.stayedFollowed, "acme/docs-app", NO_SOURCES)
  expect(kept).not.toHaveProperty("successor")
  expect(kept.load.status).toBe("ready")
  if (kept.load.status !== "ready") return
  expect(kept.load.data.unit.id).toBe(old.units[0])
  expect(kept.load.data.newer).toEqual({ unitId: fixture.units.large })
  expect(reads.stayedFollowed.found.packet.eventId).toBe(oldPacket)
  // No successor that opens: the newer review's start (its packet has no
  // batch here, so the Reviews page).
  if ("missing" in reads.stayedNoSuccessor)
    throw new Error("expected the reload to keep the unit")
  const alone = deskReady(reads.stayedNoSuccessor, "acme/docs-app", NO_SOURCES)
  expect(alone.load.status === "ready" && alone.load.data.newer).toEqual({})
  // A unit no packet holds is unknown on a reload too.
  expect("missing" in reads.stayedUnknown).toBe(true)
  // The overview: unknown on entering, kept and marked on a reload.
  expect(reads.overviewEntered).toBeUndefined()
  if (!reads.overviewStayed) throw new Error("expected the batch to stay")
  const overview = overviewOf(reads.overviewStayed, "acme/docs-app")
  expect(reads.overviewStayed.found.packet.eventId).toBe(oldPacket)
  expect(overview.newer).toEqual({})
  expect(overview.unitCount).toBe(2)
})

/** The person the fixtures register, as the desk names the viewer. */
const OWNER_EMAIL = "owner@example.com"
const owner = personFrom(human, { email: OWNER_EMAIL })
/** The person whose carried decision the Undo test retracts. */
const UNDO_EMAIL = "carried@example.com"

/** A lineage event of a later review: `successor` holds sections of an earlier review's unit. */
const laterLineage = (
  cycleId: string,
  successor: string,
  earlierCycle: string,
  earlier: ReadonlyArray<string>
) =>
  envelope(
    "lineage.recorded@1",
    `lineage:${successor}:${earlier.join(",")}`,
    agent,
    { cycleId, unitIds: [successor, ...earlier] },
    {
      from: earlier.map((unitId) => ({
        unitId,
        cycleId: earlierCycle,
        relation: "changed",
        unchanged: 0,
        changed: 1,
        lane: "agentic",
      })),
    }
  )

// Why (14.12, and the Undo records allows): a person's decision carried onto an unchanged unit is
// theirs on the unit page as on the overview, so the dock opens decided and its Undo retracts the
// carried event itself; once undone, the unit waits on them in every place again. Run on a real
// store, through the command the dock's Undo sends.
test("a carried decision is the person's on the unit page, and its Undo reopens the unit everywhere", async () => {
  // The carried decision is the person git names here (the fixtures' own actor predates the
  // fingerprint the commands use), registered as the desk's commands register them.
  const person = Identity.humanFingerprint(UNDO_EMAIL)
  const viewer = personFrom(person, { email: UNDO_EMAIL })
  const { location, fixture } = await seed({
    review: { carried: true },
    before: [
      envelope("actor.registered@1", `actor:${person}`, person, undefined, {
        actorKind: "human",
        harness: "git",
        email: UNDO_EMAIL,
      }),
    ],
    mutate: (review) => {
      const carried = review.events.carried as { actor: string } | undefined
      if (carried) carried.actor = person
    },
  })
  const small = fixture.units.small
  const batchB = fixture.batches[1]
  const loads = () =>
    read(
      location,
      Effect.gen(function* () {
        return {
          desk: yield* deskRead(small, { viewer }),
          overview: yield* overviewRead(batchB, { people: true, viewer }),
        }
      })
    )
  const pages = async () => {
    const { desk, overview } = await loads()
    if ("missing" in desk || !overview) throw new Error("expected both pages")
    const page = deskReady(desk, "acme/docs-app", NO_SOURCES)
    if (page.load.status !== "ready") throw new Error("expected a desk")
    return { desk: page.load.data, overview: overviewOf(overview, "acme") }
  }
  const before = await pages()
  const carriedId = fixture.events.carried?.id
  if (carriedId === undefined) throw new Error("expected the carried decision")
  expect(before.desk.currentDecision).toEqual({
    commandId: carriedId,
    decision: "approve",
  })
  expect(before.desk.carriedUnits?.map((row) => row.id)).toEqual([small])
  expect(before.desk.railUnits).toEqual([])
  expect(before.overview.needYou).toBe(0)
  expect(before.overview.decided?.map((row) => row.id)).toEqual([small])

  // The dock's Undo: a retraction of the decision it shows.
  await read(
    location,
    HumanCommands.retractDisposition({
      person: { email: UNDO_EMAIL },
      dispositionId: before.desk.currentDecision?.commandId ?? "",
    })
  )
  const after = await pages()
  expect(after.desk).not.toHaveProperty("currentDecision")
  expect(after.desk).not.toHaveProperty("carriedUnits")
  expect(after.desk.railUnits.map((row) => row.id)).toEqual([small])
  expect(after.desk.humanRequiredTotal).toBe(1)
  expect(after.desk.humanDecidedUnitIds).toEqual([])
  expect(after.overview.needYou).toBe(1)
  expect(after.overview).not.toHaveProperty("decided")
})

// Why (14.18): a lockfile or a generated file no agent read must never read as waiting on a person,
// nor as settled; it shows as not read with the rule that marked it, counted once on the overview.
test("a lockfile no agent read shows as not read, counted once, and never waits on a person", async () => {
  const { location, fixture } = await seed({ review: { excluded: true } })
  const lock = fixture.lock
  if (!lock) throw new Error("expected the lockfile batch")
  const loads = await read(
    location,
    Effect.gen(function* () {
      return {
        overview: yield* overviewRead(lock.batchId, NOBODY),
        desk: yield* deskRead(lock.unitId, { viewer: undefined }),
      }
    })
  )
  if (!loads.overview || "missing" in loads.desk)
    throw new Error("expected both pages")
  const overview = overviewOf(loads.overview, "acme/docs-app")
  expect(overview.needYou).toBe(0)
  expect(overview.judgment).toEqual([])
  expect(overview.notRead).toBe(1)
  expect(overview.units?.[0]).toMatchObject({
    id: lock.unitId,
    excluded: { reason: "lockfile" },
  })
  expect(overview.units?.[0]?.lane).not.toBe("human-required")
  const page = deskReady(loads.desk, "acme/docs-app", NO_SOURCES)
  if (page.load.status !== "ready") throw new Error("expected a desk")
  expect(page.load.data.unit.excluded).toEqual({ reason: "lockfile" })
  expect(page.load.data.unit).not.toHaveProperty("attribution")
  // No agent decided it: it is the rail's "Not read" group's, in its lane,
  // never among the lanes decided by agents and tools.
  expect(
    page.load.data.elsewhere
      .flatMap((lane) => lane.units ?? [])
      .map((entry) => entry.id)
  ).not.toContain(lock.unitId)
  expect(page.load.data.notReadUnits).toEqual([
    expect.objectContaining({
      id: lock.unitId,
      lane: "human-suggested",
      excluded: { reason: "lockfile" },
    }),
  ])
  // The batches without it count none.
  const a = await read(location, overviewRead(fixture.batches[0], NOBODY))
  if (!a) throw new Error("expected the first batch")
  expect(overviewOf(a, "acme/docs-app")).not.toHaveProperty("notRead")
})

// Why (14.12): a changed unit shows each person's standing decision on its earlier version as
// made on an earlier version, closing nothing; an agent's is not a person's and is not shown.
test("a changed unit shows a person's decision on its earlier version, and it closes nothing", async () => {
  const { location, old, fixture } = await seed()
  const earlierUnit = old.units[2]
  const decision = (actor: string, verdict: "approve" | "request-changes") =>
    envelope(
      "disposition.recorded@2",
      `test:${actor}:${earlierUnit}`,
      actor,
      { cycleId: old.cycleId, unitIds: [earlierUnit] },
      { verdict, reviewedHeadOid: "c".repeat(40), restsOn: [], proof: [] }
    )
  await runOn(
    location,
    Log.append([decision(human, "approve"), decision(agent, "request-changes")])
  )
  const opened = await read(
    location,
    deskRead(fixture.units.large, { viewer: owner })
  )
  if ("missing" in opened) throw new Error("expected the unit to open")
  const page = deskReady(opened, "acme/docs-app", NO_SOURCES)
  if (page.load.status !== "ready") throw new Error("expected a desk")
  expect(page.load.data.unit.earlierDecisions).toEqual([
    {
      actor: {
        kind: "person",
        person: { id: human, name: OWNER_EMAIL, initials: "OW" },
        isYou: true,
      },
      verdict: "approved",
      review: "Earlier review, head ccccccc",
    },
  ])
  // It closes nothing: no decision of the reader's stands on this unit.
  expect(page.load.data).not.toHaveProperty("currentDecision")
  expect(page.load.data.unit).not.toHaveProperty("attribution.person")
})

// Why: an older review's page must say once that a newer review holds its work (by Records'
// lineage, the rule an old link's redirect follows), and entering a batch a newer review replaced
// must lead to the batch that holds its work now, as a unit's link does; a reload keeps the page.
test("an older review points to the newer one that holds its work, and a replaced batch's link follows it", async () => {
  const { location, old, fixture, oldPacket } = await seed()
  const [batchA] = fixture.batches
  await runOn(
    location,
    Log.append([
      laterLineage(fixture.cycleId, fixture.units.large, old.cycleId, [
        old.units[0],
        old.units[1],
      ]),
    ])
  )
  const reads = await read(
    location,
    Effect.gen(function* () {
      return {
        oldUnit: yield* deskRead(old.units[0], { viewer: undefined }),
        oldBatch: yield* overviewRead(old.batchId, NOBODY),
        newest: yield* deskRead(fixture.units.large, { viewer: undefined }),
        newestBatch: yield* overviewRead(batchA, NOBODY),
      }
    })
  )
  if ("missing" in reads.oldUnit || "missing" in reads.newest)
    throw new Error("expected both units to open")
  const oldPage = deskReady(reads.oldUnit, "acme/docs-app", NO_SOURCES)
  expect(oldPage.load.status === "ready" && oldPage.load.data.newer).toEqual({
    unitId: fixture.units.large,
  })
  if (!reads.oldBatch || !reads.newestBatch)
    throw new Error("expected both batches")
  expect(overviewOf(reads.oldBatch, "acme/docs-app").newer).toEqual({
    batchId: batchA,
  })
  // The newest review names no newer one.
  const newest = deskReady(reads.newest, "acme/docs-app", NO_SOURCES)
  expect(newest.load.status === "ready" && newest.load.data).not.toHaveProperty(
    "newer"
  )
  expect(overviewOf(reads.newestBatch, "acme/docs-app")).not.toHaveProperty(
    "newer"
  )

  // A newer review of the old range replaces the old packet whole.
  await read(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode('{"batches":[]}'),
        mediaType: "application/json",
        retention: "durable",
      })
      yield* Log.append([
        {
          ...old.packet,
          id: mintUlid(),
          idempotencyKey: `replacement:${old.runId}`,
          causation: { supersedes: oldPacket },
          attribution: { ...old.packet.attribution, runId: mintUlid() },
          refs: [{ ref: `blob:${held.blob.hash}`, role: "manifest" }],
        },
      ])
    })
  )
  const replaced = await read(
    location,
    Effect.gen(function* () {
      return {
        entered: yield* overviewRead(old.batchId, NOBODY),
        successor: yield* replacedBatchSuccessor(old.batchId),
        unknown: yield* replacedBatchSuccessor(mintUlid()),
        stayed: yield* overviewRead(old.batchId, { ...NOBODY, stay: true }),
      }
    })
  )
  // Entering: the batch that holds its work now. A reload keeps the page.
  expect(replaced.entered).toBeUndefined()
  expect(replaced.successor).toEqual({ batchId: batchA })
  expect(replaced.unknown).toBeUndefined()
  expect(replaced.stayed?.found.packet.eventId).toBe(oldPacket)
})

// Why: "Moved up from" names where a unit came from; the review's own earlier publication in the
// same cycle (a review published again) is not that, and must not hide the rise from an earlier one.
test("a review published again in its cycle keeps the rise from the earlier review", async () => {
  const sameCycle = mintUlid()
  const { location, fixture } = await seed({
    mutate: (review) => {
      const lineage = review.events.lineage as unknown as {
        attribution: { unitIds: Array<string> }
        payload: { from: Array<Record<string, unknown>> }
      }
      lineage.attribution.unitIds.push(sameCycle)
      lineage.payload.from.push({
        unitId: sameCycle,
        cycleId: review.cycleId,
        relation: "unchanged",
        unchanged: 1,
        changed: 0,
        lane: "human-required",
      })
    },
  })
  const loaded = await read(location, overviewRead(fixture.batches[0], NOBODY))
  if (!loaded) throw new Error("expected the batch")
  expect(overviewOf(loaded, "acme/docs-app").units?.[0]?.raisedFrom).toBe(
    "agentic-review"
  )
})

// Why: Records' every per-unit note is the new shape's to show; a review in today's shape
// (`packet.published@1`) must open its unit page with exactly the notes it showed before (what
// Records could not carry), never the older publisher's notes, which no page showed.
test("a review in today's shape shows on its unit page only the notes it showed before", async () => {
  const { location, old } = await seed()
  const scoped = old.telemetry.find(
    (event) =>
      event.kind === "gap.disclosed@1" &&
      (event.attribution as { unitIds?: unknown } | undefined)?.unitIds !==
        undefined
  )
  if (!scoped) throw new Error("expected the old review's unit gap")
  const carriedNote =
    "Your earlier approval of this unit wasn't carried, because this review disputes it."
  await runOn(
    location,
    Log.append([
      ...old.telemetry.filter((event) => event.kind === "gap.disclosed@1"),
      envelope(
        "gap.disclosed@1",
        `review:${old.runId}:gap:carried`,
        agent,
        scoped.attribution,
        { kind: "earlier-approval-not-carried", detail: carriedNote }
      ),
    ])
  )
  const opened = await read(
    location,
    deskRead(old.units[1], { viewer: undefined })
  )
  if ("missing" in opened) throw new Error("expected the old unit to open")
  const page = deskReady(opened, "acme/docs-app", NO_SOURCES)
  if (page.load.status !== "ready") throw new Error("expected a desk")
  const briefing = JSON.stringify(page.load.data.unit.briefing)
  expect(briefing).not.toContain("The ticket was named but not fetched.")
  expect(page.load.data.unit.briefing[0]).toEqual({
    kind: "text",
    text: carriedNote,
  })
})

// Why: a comment the person's own fresh request for changes rests on shows that request's mark,
// as a carried request's comment does; the person's disposition is not in the packet, so the load
// must read it. Run through the command the dock's Request changes sends.
test("a whole-unit comment the person's fresh request for changes rests on shows its mark", async () => {
  const person = Identity.humanFingerprint(UNDO_EMAIL)
  const viewer = personFrom(person, { email: UNDO_EMAIL })
  const { location, fixture } = await seed({
    before: [
      envelope("actor.registered@1", `actor:${person}`, person, undefined, {
        actorKind: "human",
        harness: "git",
        email: UNDO_EMAIL,
      }),
    ],
  })
  await read(
    location,
    HumanCommands.recordDisposition({
      person: { email: UNDO_EMAIL },
      unitId: fixture.units.small,
      verdict: "request-changes",
      comments: [
        { body: "Say why the retry count changed.", anchor: undefined },
      ],
    })
  )
  const opened = await read(location, deskRead(fixture.units.small, { viewer }))
  if ("missing" in opened) throw new Error("expected the unit to open")
  const page = deskReady(opened, "acme/docs-app", NO_SOURCES)
  if (page.load.status !== "ready") throw new Error("expected a desk")
  expect(page.load.data.unit.comments).toEqual([
    expect.objectContaining({
      body: "Say why the retry count changed.",
      verdict: "changes_requested",
      author: expect.objectContaining({ kind: "person", isYou: true }),
    }),
  ])
  expect(page.load.data.currentDecision?.decision).toBe("request-changes")
})

// Why: whether a successor opens decides the old link's redirect, the "Newer review" link and the
// Reviews page, and is now answered from cheap reads (`opensAt`) instead of reading each later
// review's packet whole (`opening`). The two must agree on every case the redirect tests cover:
// units of both shapes, an excluded one, one of a replaced packet, one of a review with no range,
// one no packet holds, and an ID Records has never seen.
test("the cheap opens decision agrees with the desk's full read on every redirect case", async () => {
  const { location, old, fixture, oldPacket } = await seed({
    review: { excluded: true },
  })
  const rangeless = oldShape()
  const orphan = mintUlid()
  await read(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore
      const rangelessManifest = yield* blobs.put({
        bytes: new TextEncoder().encode(rangeless.manifest),
        mediaType: "application/json",
        retention: "durable",
      })
      const empty = yield* blobs.put({
        bytes: new TextEncoder().encode('{"batches":[]}'),
        mediaType: "application/json",
        retention: "durable",
      })
      yield* Log.append([
        ...rangeless.fixture.structure.filter(
          (e) => e.kind !== "cycle.opened@1"
        ),
        {
          ...rangeless.fixture.packet,
          refs: [
            { ref: `blob:${rangelessManifest.blob.hash}`, role: "manifest" },
          ],
        },
        // The old review replaced whole by a newer one holding nothing.
        {
          ...old.packet,
          id: mintUlid(),
          idempotencyKey: `replacement:${old.runId}`,
          causation: { supersedes: oldPacket },
          attribution: { ...old.packet.attribution, runId: mintUlid() },
          refs: [{ ref: `blob:${empty.blob.hash}`, role: "manifest" }],
        },
      ])
    })
  )
  const ids = [
    fixture.units.large,
    fixture.units.small,
    fixture.lock?.unitId ?? "",
    ...old.units,
    ...rangeless.fixture.units,
    orphan,
    mintUlid(),
  ]
  const answers = await read(
    location,
    Effect.gen(function* () {
      const cache = new Map()
      const out: Array<unknown> = []
      for (const id of ids) {
        const full = yield* opening(id)
        const cheap = yield* opensAt(id, cache)
        out.push({
          id,
          full: full.opens
            ? {
                opens: true,
                cycleId: full.cycleId,
                batchId: full.batch.batchId,
              }
            : { opens: false },
          cheap,
        })
      }
      return out as Array<{ id: string; full: unknown; cheap: unknown }>
    })
  )
  for (const answer of answers) expect(answer.cheap).toEqual(answer.full)
  // Both kinds of answer are covered.
  expect(
    answers.filter((answer) => (answer.full as { opens: boolean }).opens)
  ).toHaveLength(3)
})
