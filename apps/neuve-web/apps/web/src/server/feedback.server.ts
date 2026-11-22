import { Effect, Option } from "effect"
import { getCookie } from "@tanstack/react-start/server"
import {
  Feedback,
  HumanCommands,
  Log,
  PublishedPackets,
} from "@neuve/records-core"
import type { FeedbackAnswerV2 as RecordsAnswer } from "@neuve/records-schema"
import { gitHuman } from "@neuve/harness/request"
import type {
  DeskFeedback,
  DigestContent,
  FeedbackAnswer,
  FeedbackSubmission,
  FeedbackTarget,
  ReferenceGrade,
  ReviewLane,
  SavedFeedback,
} from "@workspace/ui/neuve/types"

import { FEEDBACK_COOKIE } from "@workspace/ui/neuve/review-desk/feedback/atoms"

import type { DeskBatch, DeskUnit } from "./lane-facts"
import { repository, writeRecords } from "./records.server"

/**
 * The reader's feedback in the desk (M5 S7; 10.100, FB1–FB5), over
 * records-core. The desk load (desk.server.ts) names what each control
 * answers on, inside its own packet read and only while the owner's setting
 * is on (`feedbackOn`), as Records
 * event IDs: the unit's `unit.recorded`, the agent's comments, the unit's
 * context references and its delivery stops, with the reader's current
 * answer on each. The command records one answer as the person git names in
 * the repository (ID1) through `HumanCommands.recordFeedback`, whose append
 * rules decide; a correction supersedes the reader's current answer there.
 * Feedback changes nothing in the review (FB3).
 */

/** The UI's lane names and Records' (the projection's `laneOf` maps the other way). */
const TO_RECORDS_LANE = {
  "human-required": "human-required",
  "human-suggested": "human-suggested",
  "agentic-review": "agentic",
  "static-automation": "static-automation",
} as const satisfies Record<ReviewLane, string>

const FROM_RECORDS_LANE: Record<string, ReviewLane> = {
  "human-required": "human-required",
  "human-suggested": "human-suggested",
  agentic: "agentic-review",
  "static-automation": "static-automation",
}

const DIGESTS: ReadonlyArray<DigestContent> = [
  "facts",
  "briefed",
  "explained",
  "guided",
]

/** The person git names in the repository (10.5, ID1), as the harness reads them. */
export const gitPerson = async () => {
  const human = Option.getOrUndefined(
    await Effect.runPromise(gitHuman(repository()))
  )
  return human?._tag === "Human"
    ? { email: human.email, displayName: human.displayName }
    : undefined
}

/**
 * A Records answer in the desk's words. A reference's answer keeps its
 * rubric rows (10.107); the harness's grade it saw is not an answer, so the
 * desk reads it from its own target instead.
 */
const deskAnswer = (answer: RecordsAnswer): FeedbackAnswer => {
  const { target: _target, harnessCallVisible: _visible, ...rest } = answer
  if (rest.on === "reference") {
    const { harnessGrade: _grade, ...reference } = rest
    return reference
  }
  if (rest.on !== "unit") return rest
  const { lane, ...unit } = rest
  const shown = lane === undefined ? undefined : FROM_RECORDS_LANE[lane]
  return { ...unit, ...(shown ? { lane: shown } : {}) }
}

const savedOf = (answer: Feedback.Answer): SavedFeedback => ({
  eventId: answer.eventId,
  at: answer.at,
  answer: deskAnswer(answer.payload),
})

/**
 * Whether the owner turned feedback on: the settings page's cookie
 * (feedback/atoms.ts). Read per request, so the server renders the controls
 * and the desk never moves after hydration.
 */
export const feedbackOn = (): boolean => getCookie(FEEDBACK_COOKIE) === "on"

/**
 * What the desk's controls answer on for one unit of the standing packet the
 * desk load already read, with the reader's current answers (their own only).
 * Runs inside that load's Records read, so it adds no packet read.
 */
export const feedbackTargets = (input: {
  readonly batch: DeskBatch
  readonly unit: DeskUnit
  /** The reader's actor; without one, no answers are read. */
  readonly actorId: string | undefined
}) =>
  Effect.gen(function* () {
    const { batch, unit, actorId } = input
    const answers =
      actorId === undefined
        ? []
        : yield* Feedback.answers({ actorId, unitId: unit.unitId })
    const current = new Map(
      answers.map((held) => [held.target, savedOf(held.final ?? held.first)])
    )
    const target = (id: string): FeedbackTarget => {
      const saved = current.get(id)
      return { target: id, ...(saved ? { saved } : {}) }
    }
    const digests: DeskFeedback["digests"] = {}
    for (const content of DIGESTS) {
      // Empty when Records holds no such delivery stop.
      const id = yield* Feedback.deliveryTarget({
        batchId: batch.batchId,
        content,
        unitId: unit.unitId,
      })
      if (id) digests[content] = target(id)
    }
    return {
      ...(unit.recorded ? { unit: target(unit.recorded.id) } : {}),
      findings: Object.fromEntries(
        unit.comments.map((comment) => [comment.id, target(comment.id)])
      ),
      references: Object.fromEntries(
        unit.references.map((reference) => {
          // The read model holds a reference whole only when the assembled
          // batch does.
          const grade = Object.hasOwn(unit.referenceDetails, reference.id)
            ? unit.referenceDetails[reference.id].grade
            : undefined
          return [
            reference.id,
            {
              ...target(reference.id),
              ...(grade ? { harnessGrade: grade } : {}),
            },
          ]
        })
      ),
      digests,
    } satisfies DeskFeedback
  }).pipe(Effect.withSpan("web.load.feedback"))

const GRADES: ReadonlySet<string> = new Set<ReferenceGrade>([
  "necessary",
  "useful",
  "irrelevant",
  "misleading",
])

/** The batches of a packet, as far as a reference's grade needs them. */
type GradedPacket = {
  readonly batches: ReadonlyArray<{
    readonly units: ReadonlyArray<Pick<DeskUnit, "referenceDetails">>
  }>
}

/**
 * The harness's grade on a reference as the packet published it: the same
 * `referenceDetails` the desk load reads for the card (`feedbackTargets`),
 * so what is recorded is what was shown. Undefined when the packet does not
 * hold the reference whole, or holds a grade outside the scale.
 */
export function gradeIn(
  packet: GradedPacket | undefined,
  referenceId: string
): ReferenceGrade | undefined {
  for (const batch of packet?.batches ?? [])
    for (const unit of batch.units)
      if (Object.hasOwn(unit.referenceDetails, referenceId)) {
        const grade = unit.referenceDetails[referenceId].grade
        return GRADES.has(grade) ? (grade as ReferenceGrade) : undefined
      }
  return undefined
}

/**
 * What Records records for a submission (10.107): the desk's lane in
 * Records' words, and on a reference the harness's grade from the packet,
 * only when the harness's call was visible. A grade the browser sent is
 * never kept (the command's schema refuses one too).
 */
export function recordsAnswer(
  submission: FeedbackSubmission,
  published: ReferenceGrade | undefined
): RecordsAnswer {
  // Whatever reached here, a grade the browser named is dropped.
  const {
    harnessGrade: _sent,
    ...sent
  }: FeedbackSubmission & {
    harnessGrade?: unknown
  } = submission
  switch (sent.on) {
    case "unit": {
      const { lane, ...unit } = sent
      return lane === undefined
        ? unit
        : { ...unit, lane: TO_RECORDS_LANE[lane] }
    }
    case "reference":
      return sent.harnessCallVisible && published
        ? { ...sent, harnessGrade: published }
        : sent
    default:
      return sent
  }
}

/** A cycle's packet as the desk reads it: its standing packet. */
type PacketOf = (
  cycleId: string
) => Effect.Effect<GradedPacket | undefined, unknown, PacketNeeds>
type PacketNeeds = Effect.Services<
  ReturnType<typeof PublishedPackets.readStanding>
>

/**
 * Records one answer over a store: on a reference whose harness's call was
 * visible, its grade is read from the packet of the reference's own cycle
 * (the standing packet, which the desk opened) and recorded with it.
 */
export const recordAnswer = (input: {
  readonly person: { readonly email: string; readonly displayName?: string }
  readonly submission: FeedbackSubmission
  /** The desk's packet read; stories of the seam pass their own. */
  readonly packetOf?: PacketOf
}) =>
  Effect.gen(function* () {
    const { submission, packetOf = PublishedPackets.readStanding } = input
    let published: ReferenceGrade | undefined
    if (submission.on === "reference" && submission.harnessCallVisible) {
      const held = Option.getOrUndefined(yield* Log.get(submission.target))
      const cycleId = (
        held?.event.attribution as { cycleId?: string } | undefined
      )?.cycleId
      if (cycleId !== undefined)
        published = gradeIn(yield* packetOf(cycleId), submission.target)
    }
    const answer = recordsAnswer(submission, published)
    const done = yield* HumanCommands.recordFeedback({
      person: input.person,
      answer,
    })
    return { done, answer }
  })

/** Records one answer and returns it as Records holds it. */
export async function recordFeedback(
  submission: FeedbackSubmission
): Promise<SavedFeedback> {
  const person = await gitPerson()
  if (!person)
    throw new Error(
      "git names no email here (git config user.email), so Neuve cannot record who answered"
    )
  const { done, answer } = await writeRecords("web.command.feedback", () =>
    recordAnswer({ person, submission })
  )
  return {
    eventId: done.feedbackId,
    at: new Date().toISOString(),
    // As the desk load would read it back.
    answer: deskAnswer(answer),
  }
}
