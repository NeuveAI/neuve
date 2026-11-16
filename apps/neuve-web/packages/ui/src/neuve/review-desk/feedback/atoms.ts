import * as React from "react"
import { atom, useAtomValueRawSync } from "jotai"
import type { WritableAtom } from "jotai"
import { atomWithStorage } from "jotai/utils"

import type {
  DeskFeedback,
  FeedbackAnswer,
  FeedbackSubmission,
  FeedbackTarget,
  SavedFeedback,
} from "@workspace/ui/neuve/types"

/**
 * Feedback in the review desk (vocabulary: Feedback; 10.100): the owner's
 * answers on a unit, a finding, a context reference and a digest, recorded
 * in Records. It changes nothing in the review and shows only behind its
 * setting.
 *
 *   feedbackSettingAtom   the setting (a cookie, off by default), written by
 *                         the settings page. The BFF reads the same cookie
 *                         and sends the desk its feedback only when it is on,
 *                         so the server renders the controls and nothing
 *                         moves after hydration
 *   DeskFeedbackContext   what each control answers on, and the reader's
 *                         answers, from the desk's data (Records)
 *   FeedbackSinkContext   records one answer (the BFF's command)
 *   the atoms below       what the reader is doing with a control
 *
 * A correction is a new answer that supersedes the current one, so a form
 * always sends every scale it shows, starting from the current answer.
 */

/* ── The setting ───────────────────────────────────────── */

export interface FeedbackSetting {
  enabled: boolean
}

/** The cookie the setting lives in; the BFF reads it too (feedback.server.ts). */
export const FEEDBACK_COOKIE = "neuve-feedback"

const OFF: FeedbackSetting = { enabled: false }

/**
 * The setting as a cookie, so the server knows it: "on" or "off". Anything
 * else, or no cookie, reads as off.
 */
const cookieStorage = {
  getItem: (_key: string, initialValue: FeedbackSetting): FeedbackSetting => {
    if (typeof document === "undefined") return initialValue
    const value = document.cookie
      .split("; ")
      .find((part) => part.startsWith(`${FEEDBACK_COOKIE}=`))
      ?.slice(FEEDBACK_COOKIE.length + 1)
    return value === undefined ? initialValue : { enabled: value === "on" }
  },
  setItem: (_key: string, value: FeedbackSetting) => {
    document.cookie = `${FEEDBACK_COOKIE}=${value.enabled ? "on" : "off"}; Path=/; Max-Age=31536000; SameSite=Lax`
  },
  removeItem: () => {
    document.cookie = `${FEEDBACK_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
  },
}

/** Off until the owner turns it on. */
export const feedbackSettingAtom = atomWithStorage<FeedbackSetting>(
  FEEDBACK_COOKIE,
  OFF,
  cookieStorage
)

export type FeedbackSettingAtom = WritableAtom<
  FeedbackSetting,
  [FeedbackSetting],
  void
>

/**
 * Which setting atom a subtree reads: the cookie by default; the `/mock`
 * layout and stories provide their own, so they never touch the real one.
 */
const FeedbackSettingAtomContext =
  React.createContext<FeedbackSettingAtom>(feedbackSettingAtom)

export const FeedbackSettingAtomProvider = FeedbackSettingAtomContext.Provider

export function useFeedbackSettingAtom(): FeedbackSettingAtom {
  return React.useContext(FeedbackSettingAtomContext)
}

/**
 * The setting, read through useSyncExternalStore: jotai 3's useAtomValue
 * misses the value atomWithStorage loads on mount (see useDeliverySettings).
 * A malformed stored value reads as off.
 */
export function useFeedbackSetting(): FeedbackSetting {
  const value: unknown = useAtomValueRawSync(useFeedbackSettingAtom())
  return typeof value === "object" &&
    value !== null &&
    "enabled" in value &&
    value.enabled === true
    ? { enabled: true }
    : OFF
}

/* ── The desk's data and sink ──────────────────────────── */

export type FeedbackSink = (
  submission: FeedbackSubmission
) => Promise<SavedFeedback>

/** Present only while the setting is on: the BFF sends it then. */
export const DeskFeedbackContext = React.createContext<
  DeskFeedback | undefined
>(undefined)

export const FeedbackSinkContext = React.createContext<
  FeedbackSink | undefined
>(undefined)

/**
 * A control's target, when the desk carries feedback and can record it;
 * undefined hides the control.
 */
export function useFeedbackTarget(
  pick: (feedback: DeskFeedback) => FeedbackTarget | undefined
): FeedbackTarget | undefined {
  const feedback = React.useContext(DeskFeedbackContext)
  const sink = React.useContext(FeedbackSinkContext)
  if (!feedback || !sink) return undefined
  return pick(feedback)
}

/* ── What the reader is doing ──────────────────────────── */

/** A form's chosen values by field name, before they are saved. */
export type FeedbackDraft = Partial<Record<string, string>>

/** Answers recorded in this session, by target; newer than the data until it reloads. */
export const feedbackSavedAtom = atom<Record<string, SavedFeedback>>({})
/** Values chosen but not saved, by target. */
export const feedbackDraftsAtom = atom<Record<string, FeedbackDraft>>({})
/** Targets whose answer is being recorded: their submit stays disabled. */
export const feedbackPendingAtom = atom<Record<string, true>>({})
/** What each form announces: a refusal, or that the answer was saved. */
export const feedbackMessageAtom = atom<
  Record<string, { kind: "error" | "saved"; text: string }>
>({})
/** Targets whose form is open over their saved answer (a correction). */
export const feedbackEditingAtom = atom<Record<string, true>>({})
/** The target whose layer (the unit's call, a digest's rubric) is open. */
export const feedbackLayerAtom = atom<string | null>(null)
/**
 * Where focus goes once a control swaps its form and its saved answer, so it
 * never drops to the page: "Change" after a save or a cancel, the first
 * answer after "Change".
 */
export const feedbackFocusAtom = atom<{
  target: string
  to: "change" | "answer"
} | null>(null)

const without = <T>(record: Record<string, T>, key: string) =>
  Object.fromEntries(
    Object.entries(record).filter(([entry]) => entry !== key)
  ) as Record<string, T>

/** The newer of the loaded answer and one saved in this session (ULIDs sort by time). */
export function currentAnswer(
  target: FeedbackTarget,
  session: Record<string, SavedFeedback>
): SavedFeedback | undefined {
  const local = session[target.target]
  const loaded = target.saved
  if (!local) return loaded
  if (!loaded) return local
  return local.eventId > loaded.eventId ? local : loaded
}

export const setFeedbackDraftAtom = atom(
  null,
  (
    get,
    set,
    { target, field, value }: { target: string; field: string; value: string }
  ) => {
    const drafts = get(feedbackDraftsAtom)
    set(feedbackDraftsAtom, {
      ...drafts,
      [target]: { ...drafts[target], [field]: value },
    })
    const message = get(feedbackMessageAtom)[target]
    // A change clears a refusal; the reader is correcting it.
    if (message)
      set(feedbackMessageAtom, without(get(feedbackMessageAtom), target))
  }
)

export const editFeedbackAtom = atom(
  null,
  (get, set, { target, open }: { target: string; open: boolean }) => {
    set(
      feedbackEditingAtom,
      open
        ? { ...get(feedbackEditingAtom), [target]: true }
        : without(get(feedbackEditingAtom), target)
    )
    set(feedbackFocusAtom, { target, to: open ? "answer" : "change" })
    // Opening or cancelling starts clean: no earlier draft or announcement.
    set(feedbackDraftsAtom, without(get(feedbackDraftsAtom), target))
    set(feedbackMessageAtom, without(get(feedbackMessageAtom), target))
  }
)

/** What the answer is on, and what the reader could see: never an answer. */
const NOT_ANSWERS = new Set(["on", "target", "harnessCallVisible"])

/** True when the answer gives at least one scale or a note. */
export function answersSomething(answer: FeedbackAnswer): boolean {
  return Object.entries(answer).some(
    ([key, value]) => !NOT_ANSWERS.has(key) && (value as unknown) !== undefined
  )
}

/**
 * Records one answer, and resolves true once Records holds it. A second
 * submit while one runs is ignored, and a failed call is never retried: it
 * may have appended, so the reader sees the refusal and decides.
 */
export const submitFeedbackAtom = atom(
  null,
  async (
    get,
    set,
    { sink, submission }: { sink: FeedbackSink; submission: FeedbackSubmission }
  ) => {
    const target = submission.target
    if (get(feedbackPendingAtom)[target]) return false
    if (!answersSomething(submission)) {
      set(feedbackMessageAtom, {
        ...get(feedbackMessageAtom),
        [target]: { kind: "error", text: "Choose an answer or add a note." },
      })
      return false
    }
    set(feedbackPendingAtom, { ...get(feedbackPendingAtom), [target]: true })
    set(feedbackMessageAtom, without(get(feedbackMessageAtom), target))
    try {
      const saved = await sink(submission)
      set(feedbackSavedAtom, { ...get(feedbackSavedAtom), [target]: saved })
      set(feedbackDraftsAtom, without(get(feedbackDraftsAtom), target))
      set(feedbackEditingAtom, without(get(feedbackEditingAtom), target))
      set(feedbackMessageAtom, {
        ...get(feedbackMessageAtom),
        [target]: { kind: "saved", text: "Saved" },
      })
      set(feedbackFocusAtom, { target, to: "change" })
      return true
    } catch (cause) {
      set(feedbackMessageAtom, {
        ...get(feedbackMessageAtom),
        [target]: {
          kind: "error",
          text:
            cause instanceof Error && cause.message
              ? cause.message
              : "Feedback was not recorded.",
        },
      })
      return false
    } finally {
      set(feedbackPendingAtom, without(get(feedbackPendingAtom), target))
    }
  }
)
