// Why (23 October 2026): the overview counted every human-required unit as waiting on the person and
// listed it under "Needs your decision", ignoring decisions the desk already showed. A unit waits only
// while no person has a current decision on it, by the same rule the desk uses: records-core's
// `judge` (a retracted disposition, or one recorded in an earlier cycle, is not current) read through
// the BFF's `humanDispositions`. This runs that chain on a real store in a temporary directory: the
// human commands record, `judge` reads, the projection decides what waits. A comment alone and an
// agent's disposition are not a person's decision.
// Why (23 October 2026, the batch menu): the header's menu says how many units of each batch still
// need the person; it must agree with the overview's own count, so it is read through the same rule.
// Why (23 October 2026, the overview's unit rows): every laned unit is listed with the review that
// stands on it. On human-required work only a person's decision shows; elsewhere the standing one,
// the agent's unless a person's overrides it. The same `judge` chain decides it.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  Dispositions,
  HumanCommands,
  Identity,
  Log,
  Store,
  mintUlid,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core"

import { humanDispositions, overviewData, personFrom } from "./projection"
import type { PacketContext } from "./projection"

const directories: Array<string> = []
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

const location = () => {
  const directory = mkdtempSync(join(tmpdir(), "overview-decisions-"))
  directories.push(directory)
  return storeLocationIn(directory)
}

/** Runs `program` on the store at `at`, created and prepared as a first writer does. */
const run = <TResult, TError, TNeeds>(
  at: ReturnType<typeof storeLocationIn>,
  program: Effect.Effect<TResult, TError, TNeeds>
) =>
  Effect.runPromise(
    // The store and file system layers provide everything these programs need.
    Effect.andThen(Store.prepareForWrite, program).pipe(
      Effect.provide(Store.layer(at, { create: true })),
      Effect.provide(BunFileSystem.layer)
    ) as Effect.Effect<TResult, unknown, never>
  )

const agent = sha256Hex("neuve-actor/1\u0000test\u0000session")
const owner = { email: "owner@example.com", displayName: "Owner" }
const ownerActor = Identity.humanFingerprint(owner.email)
const HEAD = "a".repeat(40)
const NEXT_HEAD = "c".repeat(40)

const envelope = (
  kind: string,
  attribution: unknown,
  payload: unknown,
  actor = agent
) => {
  const id = mintUlid()
  return {
    id,
    kind,
    idempotencyKey: `test:${id}`,
    actor,
    occurredAt: "2026-10-23T10:00:00.000Z",
    ...(attribution === undefined ? {} : { attribution }),
    payload,
  }
}

const cycle = (headOid: string) => {
  const cycleId = mintUlid()
  const batchId = mintUlid()
  return {
    cycleId,
    batchId,
    events: [
      envelope(
        "cycle.opened@1",
        {
          cycleId,
          range: {
            baseRef: "refs/heads/main",
            baseOid: "b".repeat(40),
            headOid,
          },
        },
        {}
      ),
      envelope(
        "batch.recorded@1",
        { cycleId, batchId },
        {
          title: "Batch",
          focus: "Focus",
        }
      ),
    ],
  }
}

/** A unit recorded in a cycle in the given lane (owned lines src/<title>.ts new 1-20). */
const laned = (
  lane: "human-required" | "human-suggested" | "agentic",
  at: { cycleId: string; batchId: string },
  unitId: string,
  title: string
) => [
  envelope(
    "unit.recorded@2",
    { cycleId: at.cycleId, batchId: at.batchId, unitIds: [unitId] },
    {
      title,
      ownedRanges: [
        {
          kind: "lines",
          path: `src/${title}.ts`,
          side: "new",
          startLine: 1,
          endLine: 20,
        },
      ],
      grouping: { gapLines: 20 },
    }
  ),
  envelope(
    "assessment.recorded@1",
    { cycleId: at.cycleId, unitIds: [unitId] },
    {
      lane,
      complexity: "high",
      easeOfValidation: "hard",
      rationale: "Needs a person",
    }
  ),
]

const humanRequired = (
  at: { cycleId: string; batchId: string },
  unitId: string,
  title: string
) => laned("human-required", at, unitId, title)

const CITATIONS = { cited: [], resolved: 0, unresolved: 0 }

/** The overview of the given units as the page load builds it, with `judge` read now. */
const overviewOf = (
  at: ReturnType<typeof storeLocationIn>,
  units: ReadonlyArray<{ unitId: string; title: string }>
) =>
  run(
    at,
    Effect.gen(function* () {
      const packetUnits = []
      for (const unit of units)
        packetUnits.push({
          local: unit.title,
          unitId: unit.unitId,
          recorded: { payload: { title: unit.title, ownedRanges: [] } },
          assessment: undefined,
          content: {},
          references: [],
          referenceDetails: {},
          comments: [],
          disposition: undefined,
          judgement: yield* Dispositions.judge(unit.unitId),
          citations: CITATIONS,
          // Records gives every unit its checkpoints (11.16).
          checkpoints: [],
          proofCurrency: {},
        })
      const batch = {
        local: "batch",
        batchId: "batch",
        recorded: undefined,
        digest: undefined,
        digestCitations: CITATIONS,
        assembled: undefined,
        units: packetUnits,
      } as unknown as PacketContext["batch"]
      const context = {
        repo: "repo",
        range: {
          baseRef: "refs/heads/main",
          baseOid: "b".repeat(40),
          headOid: HEAD,
        },
        packet: { batches: [batch], gaps: [], undecoded: [] },
        batch,
      } as unknown as PacketContext
      const viewer = personFrom(ownerActor, owner)
      return overviewData(context, {
        viewer,
        people: { [ownerActor]: viewer },
        dispositions: humanDispositions(batch.units),
      })
    })
  )

test("only units no person has a current decision on wait on the person", async () => {
  const at = location()
  const first = cycle(HEAD)
  const unit = (title: string) => ({ unitId: mintUlid(), title })
  const approved = unit("approved")
  const changes = unit("changes")
  const undone = unit("undone")
  const commented = unit("commented")
  const agentOnly = unit("agent-only")
  const all = [approved, changes, undone, commented, agentOnly]
  await run(
    at,
    Log.append([
      envelope("actor.registered@1", undefined, {
        actorKind: "agent",
        harness: "test",
        sessionId: "session",
      }),
      ...first.events,
      ...all.flatMap((u) => humanRequired(first, u.unitId, u.title)),
    ])
  )
  const before = await overviewOf(at, all)

  await run(
    at,
    Effect.gen(function* () {
      yield* HumanCommands.recordDisposition({
        person: owner,
        unitId: approved.unitId,
        verdict: "approve",
      })
      yield* HumanCommands.recordDisposition({
        person: owner,
        unitId: changes.unitId,
        verdict: "request-changes",
        comments: [{ body: "Handle the empty list." }],
      })
      const toUndo = yield* HumanCommands.recordDisposition({
        person: owner,
        unitId: undone.unitId,
        verdict: "approve",
      })
      yield* HumanCommands.retractDisposition({
        person: owner,
        dispositionId: toUndo.dispositionId,
      })
      yield* HumanCommands.recordComment({
        person: owner,
        unitId: commented.unitId,
        comment: { body: "A note on the whole unit, not a decision." },
      })
      yield* Log.append([
        envelope(
          "disposition.recorded@2",
          { cycleId: first.cycleId, unitIds: [agentOnly.unitId] },
          {
            verdict: "request-changes",
            reviewedHeadOid: HEAD,
            restsOn: [],
            proof: [],
          }
        ),
      ])
    })
  )
  const after = await overviewOf(at, all)

  expect(before.needYou).toBe(5)
  expect(before.judgment.map((u) => u.title)).toEqual(all.map((u) => u.title))
  expect(before.decided).toBeUndefined()

  // The undone, comment-only and agent-only units still wait; the decided ones moved.
  expect(after.needYou).toBe(3)
  // The header's batch menu counts what waits by the same rule.
  expect(before.batches?.all.map((b) => b.needYou)).toEqual([5])
  expect(after.batches).toEqual({
    current: "batch",
    newest: false,
    all: [{ id: "batch", title: "batch", unitCount: 5, needYou: 3 }],
  })
  expect(after.judgment.map((u) => u.title)).toEqual([
    "undone",
    "commented",
    "agent-only",
  ])
  expect(after.decided).toEqual([
    {
      id: approved.unitId,
      title: "approved",
      review: {
        actor: {
          kind: "person",
          person: { id: ownerActor, name: "Owner", initials: "OW" },
          isYou: true,
        },
        verdict: "approved",
      },
    },
    {
      id: changes.unitId,
      title: "changes",
      review: {
        actor: {
          kind: "person",
          person: { id: ownerActor, name: "Owner", initials: "OW" },
          isYou: true,
        },
        verdict: "changes_requested",
      },
    },
  ])
  // The rows show a person's decision only: the agent's request on human-required work is not one.
  expect(after.units?.map((u) => [u.title, u.review?.verdict])).toEqual([
    ["approved", "approved"],
    ["changes", "changes_requested"],
    ["undone", undefined],
    ["commented", undefined],
    ["agent-only", undefined],
  ])
  // The lane still counts all five; the first action opens the first unit that waits.
  expect(
    after.lanes.find((lane) => lane.lane === "human-required")?.count
  ).toBe(5)
  expect(after.firstUnitId).toBe(undone.unitId)
})

test("a decision recorded at an older head does not decide the unit in the new cycle", async () => {
  const at = location()
  const first = cycle(HEAD)
  const unitId = mintUlid()
  await run(
    at,
    Log.append([
      envelope("actor.registered@1", undefined, {
        actorKind: "agent",
        harness: "test",
        sessionId: "session",
      }),
      ...first.events,
      ...humanRequired(first, unitId, "carried"),
    ])
  )
  await run(
    at,
    HumanCommands.recordDisposition({
      person: owner,
      unitId,
      verdict: "approve",
    })
  )
  const decided = await overviewOf(at, [{ unitId, title: "carried" }])

  // A new commit: the next cycle records the unit again at the new head.
  const next = cycle(NEXT_HEAD)
  await run(
    at,
    Log.append([...next.events, ...humanRequired(next, unitId, "carried")])
  )
  const renewed = await overviewOf(at, [{ unitId, title: "carried" }])

  expect(decided.needYou).toBe(0)
  expect(decided.decided?.map((u) => u.review.verdict)).toEqual(["approved"])
  expect(renewed.needYou).toBe(1)
  expect(renewed.judgment.map((u) => u.id)).toEqual([unitId])
  expect(renewed.decided).toBeUndefined()
})

test("the other lanes show the review that stands: the agent's, unless a person's overrides it", async () => {
  const at = location()
  const first = cycle(HEAD)
  const agentic = { unitId: mintUlid(), title: "agentic" }
  const overridden = { unitId: mintUlid(), title: "overridden" }
  const undecided = { unitId: mintUlid(), title: "undecided" }
  const agentDisposition = (unitId: string, verdict: string) =>
    envelope(
      "disposition.recorded@2",
      { cycleId: first.cycleId, unitIds: [unitId] },
      { verdict, reviewedHeadOid: HEAD, restsOn: [], proof: [] }
    )
  await run(
    at,
    Log.append([
      envelope("actor.registered@1", undefined, {
        actorKind: "agent",
        harness: "test",
        sessionId: "session",
      }),
      ...first.events,
      ...laned("agentic", first, agentic.unitId, agentic.title),
      ...laned("human-suggested", first, overridden.unitId, overridden.title),
      ...laned("agentic", first, undecided.unitId, undecided.title),
      agentDisposition(agentic.unitId, "request-changes"),
      agentDisposition(overridden.unitId, "approve"),
    ])
  )
  await run(
    at,
    HumanCommands.recordDisposition({
      person: owner,
      unitId: overridden.unitId,
      verdict: "request-changes",
      comments: [{ body: "Not yet." }],
    })
  )
  const overview = await overviewOf(at, [agentic, overridden, undecided])

  expect(overview.units).toEqual([
    {
      id: agentic.unitId,
      title: "agentic",
      lane: "agentic-review",
      review: {
        actor: {
          kind: "agent",
          agent: {
            id: agent,
            short: "R1",
            name: "Reviewer 1",
            role: "reviewer",
          },
        },
        verdict: "changes_requested",
      },
    },
    {
      id: overridden.unitId,
      title: "overridden",
      lane: "human-suggested",
      review: {
        actor: {
          kind: "person",
          person: { id: ownerActor, name: "Owner", initials: "OW" },
          isYou: true,
        },
        verdict: "changes_requested",
      },
    },
    { id: undecided.unitId, title: "undecided", lane: "agentic-review" },
  ])
  // Nothing on these lanes waits on the person.
  expect(overview.needYou).toBe(0)
})
