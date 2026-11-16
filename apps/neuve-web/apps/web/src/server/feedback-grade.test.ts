// Why (10.107): the export puts the harness's grade beside the owner's grade, and the climbs
// compare the two, so the grade must be the one the harness published, never one the browser
// claims. This runs the BFF's command seam on a real store in a temporary directory: the command's
// schema refuses a grade from the browser, `recordAnswer` reads it from the packet of the
// reference's own cycle only when the harness's call was visible, a forged grade that got past the
// schema is replaced by the packet's, and the export reads what was recorded. The packet read is
// the desk's (`standingPacket`); here it is a packet of the same shape, since a published packet
// with its assembled batch is the harness's to build.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { afterAll, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import {
  Feedback,
  Identity,
  Log,
  Store,
  mintUlid,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core"
import type { FeedbackSubmission } from "@workspace/ui/neuve/types"

import { Submission } from "./feedback"
import { gradeIn, recordAnswer } from "./feedback.server"

const directories: Array<string> = []
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

const location = () => {
  const directory = mkdtempSync(join(tmpdir(), "feedback-grade-"))
  directories.push(directory)
  return storeLocationIn(directory)
}

const run = <TResult, TError, TNeeds>(
  at: ReturnType<typeof storeLocationIn>,
  program: Effect.Effect<TResult, TError, TNeeds>
) =>
  Effect.runPromise(
    Effect.andThen(Store.prepareForWrite, program).pipe(
      Effect.provide(Store.layer(at, { create: true })),
      Effect.provide(BunFileSystem.layer)
    ) as Effect.Effect<TResult, unknown, never>
  )

const agent = sha256Hex("neuve-actor/1\u0000test\u0000session")
const owner = { email: "owner@example.com", displayName: "Owner" }
const ownerActor = Identity.humanFingerprint(owner.email)
const HEAD = "a".repeat(40)

const envelope = (kind: string, attribution: unknown, payload: unknown) => {
  const id = mintUlid()
  return {
    id,
    kind,
    idempotencyKey: `test:${id}`,
    actor: agent,
    occurredAt: "2026-10-23T10:00:00.000Z",
    ...(attribution === undefined ? {} : { attribution }),
    payload,
  }
}

const cycleId = mintUlid()
const batchId = mintUlid()
const unitId = mintUlid()
const on = { cycleId, batchId, unitIds: [unitId] }
const reference = (summary: string) =>
  envelope("context.referenced@2", on, {
    markerKind: "doc",
    source: { kind: "doc", locator: "docs/retry.md" },
    summary,
    anchor: { path: "src/a.ts", side: "new", startLine: 3, endLine: 4 },
    stance: "supports",
    origin: "committed",
    provenance: { kind: "git", revision: HEAD, path: "docs/retry.md" },
  })
const shown = reference("The retry policy")
const hidden = reference("The retry budget")

const events = [
  envelope("actor.registered@1", undefined, {
    actorKind: "agent",
    harness: "test",
    sessionId: "session",
  }),
  envelope(
    "cycle.opened@1",
    {
      cycleId,
      range: {
        baseRef: "refs/heads/main",
        baseOid: "b".repeat(40),
        headOid: HEAD,
      },
    },
    {}
  ),
  envelope(
    "batch.recorded@1",
    { cycleId, batchId },
    { title: "Batch", focus: "Focus" }
  ),
  envelope("unit.recorded@2", on, {
    title: "Unit",
    ownedRanges: [
      {
        kind: "lines",
        path: "src/a.ts",
        side: "new",
        startLine: 1,
        endLine: 20,
      },
    ],
    grouping: { gapLines: 20 },
  }),
  shown,
  hidden,
]

/** The packet of the cycle as the desk reads it: the harness graded both references. */
const packet = {
  batches: [
    {
      units: [
        {
          referenceDetails: {
            [shown.id]: { grade: "useful" },
            [hidden.id]: { grade: "necessary" },
          },
        },
      ],
    },
  ],
} as unknown as Parameters<typeof gradeIn>[0]

const storedPayload = (at: ReturnType<typeof storeLocationIn>, id: string) =>
  run(
    at,
    Effect.map(Log.get(id), (held) =>
      Option.match(held, {
        onNone: () => undefined,
        onSome: (stored) => stored.event.payload as Record<string, unknown>,
      })
    )
  )

test("the browser cannot send the harness's grade: the command's schema refuses it", () => {
  const answer = {
    on: "reference",
    target: shown.id,
    harnessCallVisible: true,
    grade: "useful",
    saysWhy: "yes",
  }
  expect(Submission.safeParse(answer).success).toBe(true)
  expect(
    Submission.safeParse({ ...answer, harnessGrade: "misleading" }).success
  ).toBe(false)
})

test("the harness's grade is filled from the packet when visible, never from the browser, and absent when not", async () => {
  const at = location()
  await run(at, Log.append(events))
  const read: Array<string> = []
  const packetOf = (cycle: string) => {
    read.push(cycle)
    return Effect.succeed(packet)
  }

  // Visible: the packet's grade is recorded.
  const first = await run(
    at,
    recordAnswer({
      person: owner,
      packetOf,
      submission: {
        on: "reference",
        target: shown.id,
        harnessCallVisible: true,
        grade: "irrelevant",
        tiedToLines: "no",
      },
    })
  )
  // A forged grade that got past the schema is replaced by the packet's.
  const forged = await run(
    at,
    recordAnswer({
      person: owner,
      packetOf,
      submission: {
        on: "reference",
        target: shown.id,
        harnessCallVisible: true,
        harnessGrade: "misleading",
        grade: "useful",
        // Forged: the shared type has no such field, as the schema has none.
      } as FeedbackSubmission,
    })
  )
  // Not visible: no grade is read or recorded, even one the browser forged.
  const notShown = await run(
    at,
    recordAnswer({
      person: owner,
      packetOf,
      submission: {
        on: "reference",
        target: hidden.id,
        harnessCallVisible: false,
        harnessGrade: "useful",
        grade: "necessary",
      } as FeedbackSubmission,
    })
  )

  expect(await storedPayload(at, first.done.feedbackId)).toMatchObject({
    harnessCallVisible: true,
    harnessGrade: "useful",
    grade: "irrelevant",
    tiedToLines: "no",
  })
  expect(
    (await storedPayload(at, forged.done.feedbackId))?.["harnessGrade"]
  ).toBe("useful")
  const hiddenPayload = await storedPayload(at, notShown.done.feedbackId)
  expect(hiddenPayload).toMatchObject({ harnessCallVisible: false })
  expect(hiddenPayload && "harnessGrade" in hiddenPayload).toBe(false)
  // Only the visible answers read the packet, from the reference's own cycle.
  expect(read).toEqual([cycleId, cycleId])

  // The export carries the published grade, and null where it was not visible.
  const exported = await run(
    at,
    Feedback.sheetAnswers({
      actorId: ownerActor,
      cycleId,
      readAt: "2026-10-23T12:00:00.000Z",
    })
  )
  const answers = exported.answers as Record<string, Record<string, unknown>>
  expect(answers[`reference:${shown.id}`]).toMatchObject({
    first: "irrelevant",
    final: "useful",
    harnessGrade: "useful",
    harnessCallVisible: true,
  })
  expect(answers[`reference:${hidden.id}`]).toMatchObject({
    first: "necessary",
    harnessGrade: null,
    harnessCallVisible: false,
  })
})

test("a grade outside the scale, or a reference the packet does not hold, gives no grade", () => {
  expect(gradeIn(packet, shown.id)).toBe("useful")
  expect(gradeIn(packet, mintUlid())).toBeUndefined()
  expect(gradeIn(undefined, shown.id)).toBeUndefined()
  const odd = {
    batches: [
      { units: [{ referenceDetails: { [shown.id]: { grade: "vital" } } }] },
    ],
  } as unknown as Parameters<typeof gradeIn>[0]
  expect(gradeIn(odd, shown.id)).toBeUndefined()
})
