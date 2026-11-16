/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Feedback controls
 *
 *    0ms   hover on an option or a trigger: tone shift (surfaceTone
 *          120ms, CSS, real pointer hover only)
 *    0ms   the unit's call, a reference's grade and rubric, or a digest's
 *          rubric opens as a layer from its trigger: fade in (hint 140ms,
 *          iOS ease-out, the popover's CSS)
 *    0ms   save: the form leaves (cardExit 160ms, accelerate), then the
 *          saved answer drops in, y -4 → 0, opacity 0 → 1 (card 220ms,
 *          emphasized decelerate); "Change" swaps them back the same way.
 *          A reference's layer closes on save instead (the popover's fade
 *          out), and its chip gains the check
 *
 * Reduced motion: opacity-only 150ms tweens; the tone shifts stay.
 * ───────────────────────────────────────────────────────── */

import * as React from "react"
import { useAtomValue, useSetAtom, useStore } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { CheckIcon, XIcon } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import {
  EASE,
  OFFSET,
  REDUCED_TRANSITION,
  TIMING,
  ms,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  DeskFeedbackContext,
  FeedbackSinkContext,
  currentAnswer,
  editFeedbackAtom,
  feedbackDraftsAtom,
  feedbackFocusAtom,
  feedbackEditingAtom,
  feedbackLayerAtom,
  feedbackMessageAtom,
  feedbackPendingAtom,
  feedbackSavedAtom,
  setFeedbackDraftAtom,
  submitFeedbackAtom,
  useFeedbackTarget,
} from "@workspace/ui/neuve/review-desk/feedback/atoms"
import type {
  DeskFeedback,
  DigestContent,
  FeedbackAnswer,
  FeedbackOn,
  FeedbackSubmission,
  FeedbackTarget,
} from "@workspace/ui/neuve/types"

const SWAP = {
  offsetY: -OFFSET.card,
  enter: { duration: ms(TIMING.card), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.cardExit), ease: EASE.emphasizedAccelerate },
} as const

/* ── Scales (the sheet's, FB2) ─────────────────────────── */

interface ScaleOption {
  value: string
  label: string
  /** How the saved answer reads it. */
  said: string
  /** A small tag after the label, e.g. "harness" on the harness's grade. */
  tag?: { text: string; spoken: string }
  /** A key that picks it while its form has focus, e.g. "1". */
  key?: string
}

interface Scale {
  field: string
  legend: string
  options: ReadonlyArray<ScaleOption>
  /** One row (question, then answers at the end), whatever the count. */
  row?: boolean
  /** A quiet hint at the end of the legend, e.g. the keys "1–4". */
  hint?: string
}

const option = (value: string, label: string, said = label): ScaleOption => ({
  value,
  label,
  said,
})

const UNIT_SCALES: ReadonlyArray<Scale> = [
  {
    field: "complexity",
    legend: "Complexity",
    options: [
      option("low", "Low", "Low complexity"),
      option("high", "High", "High complexity"),
    ],
  },
  {
    field: "easeOfValidation",
    legend: "Ease of validation",
    options: [
      option("easy", "Easy", "Easy to validate"),
      option("hard", "Hard", "Hard to validate"),
    ],
  },
  {
    field: "lane",
    legend: "Lane",
    options: [
      option("human-required", "Human-required"),
      option("human-suggested", "Human-suggested"),
      option("agentic-review", "Agentic review"),
      option("static-automation", "Static automation"),
    ],
  },
  {
    field: "verdict",
    legend: "Verdict",
    options: [
      option("approve", "Approve"),
      option("request-changes", "Request changes"),
    ],
  },
]

const FINDING_SCALES: ReadonlyArray<Scale> = [
  {
    field: "judged",
    legend: "This finding is",
    options: [
      option("valid", "Valid"),
      option("invalid", "Invalid"),
      option("unsure", "Unsure"),
    ],
  },
]

const GRADES = [
  option("necessary", "Necessary"),
  option("useful", "Useful"),
  option("irrelevant", "Irrelevant"),
  option("misleading", "Misleading"),
] as const

const NOT_BETWEEN = ""

const DIGEST_SCALES: ReadonlyArray<Scale> = [
  {
    field: "accurate",
    legend: "Accurate",
    options: [
      option("yes", "Yes", "Accurate"),
      option("no", "No", "Not accurate"),
    ],
  },
  {
    field: "complete",
    legend: "Complete",
    options: [
      option("yes", "Yes", "Complete"),
      option("no", "No", "Incomplete"),
    ],
  },
  {
    field: "misleadingClaim",
    legend: "Misleading claim",
    options: [
      option("none", "None", "No misleading claim"),
      option("some", "Some", "A misleading claim"),
    ],
  },
  {
    field: "neutralBeforeVerdict",
    legend: "Neutral before the verdict",
    options: [
      option("yes", "Yes", "Neutral before the verdict"),
      option("no", "No", "Not neutral before the verdict"),
    ],
  },
]

/**
 * The note's rubric on a reference (10.107): five optional rows, one per
 * complaint. The saved answer reads each row in lower case after the grade.
 */
const yesNo = (
  field: string,
  legend: string,
  yes: string,
  no: string
): Scale => ({
  field,
  legend,
  options: [option("yes", "Yes", yes), option("no", "No", no)],
})

const SAYS_WHY = yesNo(
  "saysWhy",
  "Says why it's here",
  "says why it's here",
  "doesn't say why it's here"
)
const TIED_TO_LINES = yesNo(
  "tiedToLines",
  "Tied to these lines",
  "tied to these lines",
  "not tied to these lines"
)
const CHECK_ACTIONABLE = yesNo(
  "checkActionable",
  "Check is actionable",
  "check is actionable",
  "check not actionable"
)
const ACCURATE = yesNo("accurate", "Accurate", "accurate", "not accurate")
const LENGTH: Scale = {
  field: "length",
  legend: "Length",
  row: true,
  options: [
    option("too-short", "Too short", "too short"),
    option("right", "Right", "right length"),
    option("too-long", "Too long", "too long"),
  ],
}

/** What a reference's layer knows about it beyond its target. */
interface ReferenceContext {
  /** The harness's grade the card shows, marked on its option. */
  harnessGrade?: string
  /** The card has a "Before you decide" check; without one its row is not asked. */
  hasCheck: boolean
}

/**
 * A reference's scales: its grade (1–4 pick it, the harness's grade marked
 * on its option), the grade it sits between once one is chosen, then the
 * note's rubric, with the check's row only when the card has a check.
 */
function referenceScales(
  grade: string | undefined,
  context: ReferenceContext = { hasCheck: true }
): ReadonlyArray<Scale> {
  const scales: Array<Scale> = [
    {
      field: "grade",
      legend: "This reference is",
      hint: "1–4",
      options: GRADES.map((entry, at) => ({
        ...entry,
        key: String(at + 1),
        ...(entry.value === context.harnessGrade
          ? { tag: { text: "harness", spoken: "the harness's grade" } }
          : {}),
      })),
    },
  ]
  if (grade)
    scales.push({
      field: "between",
      legend: "Between it and",
      options: [
        ...GRADES.filter((entry) => entry.value !== grade),
        option(NOT_BETWEEN, "None"),
      ],
    })
  scales.push(SAYS_WHY, TIED_TO_LINES)
  if (context.hasCheck) scales.push(CHECK_ACTIONABLE)
  scales.push(ACCURATE, LENGTH)
  return scales
}

const RUBRIC_FIELDS = [
  "saysWhy",
  "tiedToLines",
  "checkActionable",
  "accurate",
  "length",
] as const

/** The answer a form's values give, with only what the reader chose. */
function answerFrom(
  on: FeedbackOn,
  values: Partial<Record<string, string>>,
  /** The fields the form shows; a value for a scale not shown is left out. */
  shown: ReadonlyArray<string>
): FeedbackAnswer {
  const chosen = (field: string) => {
    const value = values[field]
    return value === undefined || value === "" ? undefined : value
  }
  const note = values["note"]?.trim() || undefined
  const shape = (fields: ReadonlyArray<string>) =>
    Object.fromEntries(
      fields.flatMap((field) => {
        const value = chosen(field)
        return value === undefined ? [] : [[field, value]]
      })
    )
  switch (on) {
    case "unit":
      return {
        on,
        ...shape(["complexity", "easeOfValidation", "lane", "verdict"]),
        ...(note ? { note } : {}),
      }
    case "finding":
      return { on, ...shape(["judged"]), ...(note ? { note } : {}) }
    case "reference": {
      const grade = chosen("grade")
      const between = chosen("between")
      return {
        on,
        ...shape(["grade"]),
        // An in-between grade sits beside a different grade.
        ...(between && grade && between !== grade ? { between } : {}),
        // Only rows the reader answered: a blank row is left out, never yes.
        ...shape(RUBRIC_FIELDS.filter((field) => shown.includes(field))),
        ...(note ? { note } : {}),
      } as FeedbackAnswer
    }
    case "digest":
      return {
        on,
        ...shape([
          "accurate",
          "complete",
          "misleadingClaim",
          "neutralBeforeVerdict",
        ]),
        ...(note ? { note } : {}),
      }
  }
}

/** A saved answer as form values, so a correction starts from it. */
function valuesOf(
  answer: FeedbackAnswer | undefined
): Partial<Record<string, string>> {
  if (!answer) return {}
  return Object.fromEntries(
    Object.entries(answer).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "on" && typeof entry[1] === "string"
    )
  )
}

/** How a saved answer reads, scale by scale. */
function sayAnswer(
  answer: FeedbackAnswer,
  scales: ReadonlyArray<Scale>
): string {
  const values = valuesOf(answer)
  return scales
    .flatMap((scale) => {
      const said = scale.options.find(
        (entry) => entry.value === values[scale.field] && entry.value !== ""
      )?.said
      if (!said) return []
      return [
        scale.field === "between" ? `between ${said.toLowerCase()}` : said,
      ]
    })
    .join(" · ")
}

/**
 * A saved reference answer in a line, as the line's list shows it under the
 * reason: the grade, then only what is off ("not tied to these lines", "too
 * long"), so gaps stand out. A rubric row answered yes or "right" is left
 * out; an answer with neither reads as rated.
 */
function sayReferenceSummary(answer: FeedbackAnswer): string {
  const values = valuesOf(answer)
  const off = referenceScales(values["grade"]).filter(
    (scale) =>
      scale.field === "grade" ||
      scale.field === "between" ||
      (values[scale.field] !== "yes" && values[scale.field] !== "right")
  )
  return sayAnswer(answer, off) || (answer.note ? "Noted" : "Rated")
}

/* ── Form parts ────────────────────────────────────────── */

const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"

/**
 * One scale: a fieldset of radios drawn as the segmented control
 * (Shared / Segmented), so it keeps native radio keys and semantics.
 */
function ScaleFieldset({
  name,
  scale,
  value,
  onChange,
}: {
  name: string
  scale: Scale
  value: string | undefined
  onChange: (value: string) => void
}) {
  const wide = scale.options.length > 3
  // A two-way scale is one row: its question, then its answers at the end,
  // so a rubric reads as a list (the legend floats to sit in the row).
  const row = scale.row ?? scale.options.length === 2
  return (
    <fieldset className={cn("m-0 min-w-0 border-0 p-0", row && "flow-root")}>
      <legend
        className={cn(
          "p-0 label-mono text-[10px]",
          row
            ? "float-left leading-[34px] pointer-coarse:leading-[50px]"
            : "mb-1.5",
          scale.hint && "w-full"
        )}
      >
        {scale.hint ? (
          <span className="flex items-baseline justify-between gap-2">
            {scale.legend}
            <span
              aria-hidden="true"
              className="font-mono text-[10px] tracking-normal text-faint normal-case"
            >
              {scale.hint}
            </span>
          </span>
        ) : (
          scale.legend
        )}
      </legend>
      <div
        className={cn(
          "max-w-full gap-0 rounded-lg bg-raised p-[3px]",
          // Four answers fill the width in two columns, so the grid's edges
          // line up with the rows' answers.
          wide ? "grid w-full grid-cols-2" : "flex w-fit",
          row && "float-right"
        )}
      >
        {scale.options.map((entry) => (
          <label
            key={entry.value}
            className={cn(
              "relative inline-flex h-7 cursor-pointer items-center justify-center rounded-md px-2.5 text-[12.5px] whitespace-nowrap text-ink-muted transition-colors duration-surface-tone ease-standard select-none hover:text-ink has-checked:bg-surface has-checked:text-ink has-checked:shadow-[0_1px_2px_rgba(0,0,0,.08)] has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-focus has-focus-visible:outline-solid motion-reduce:transition-none pointer-coarse:h-11",
              wide && "justify-start"
            )}
          >
            <input
              type="radio"
              name={name}
              value={entry.value}
              checked={(value ?? null) === entry.value}
              onChange={() => onChange(entry.value)}
              aria-keyshortcuts={entry.key}
              className="sr-only"
            />
            {entry.label}
            {entry.tag && (
              <>
                <span className="sr-only"> ({entry.tag.spoken})</span>
                <span
                  aria-hidden="true"
                  className="ml-1.5 rounded-[4px] px-1 font-mono text-[9.5px] leading-[14px] tracking-[0.06em] text-ink-muted uppercase shadow-[inset_0_0_0_1px_var(--nv-line)]"
                >
                  {entry.tag.text}
                </span>
              </>
            )}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** The answers a control shows: the form, or the saved answer with "Change". */
function FeedbackBody({
  on,
  target,
  harnessCallVisible,
  label,
  scales,
  onSaved,
}: {
  on: FeedbackOn
  target: FeedbackTarget
  harnessCallVisible: boolean
  /** The form's accessible name, e.g. "Feedback on this finding". */
  label: string
  scales: (values: Partial<Record<string, string>>) => ReadonlyArray<Scale>
  /** After Records holds the answer (a reference's layer closes then). */
  onSaved?: () => void
}) {
  const id = React.useId()
  const reduce = useReducedMotion()
  const sink = React.useContext(FeedbackSinkContext)
  const session = useAtomValue(feedbackSavedAtom)
  const draft = useAtomValue(feedbackDraftsAtom)[target.target]
  const editing = !!useAtomValue(feedbackEditingAtom)[target.target]
  const pending = !!useAtomValue(feedbackPendingAtom)[target.target]
  const message = useAtomValue(feedbackMessageAtom)[target.target]
  const setDraft = useSetAtom(setFeedbackDraftAtom)
  const edit = useSetAtom(editFeedbackAtom)
  const submit = useSetAtom(submitFeedbackAtom)
  const store = useStore()
  const saved = currentAnswer(target, session)
  /**
   * A ref that takes focus when the swap asked for it (feedbackFocusAtom),
   * once the new side has mounted, so focus never drops to the page.
   */
  const claimFocus =
    (to: "change" | "answer") => (element: HTMLElement | null) => {
      if (!element) return
      const request = store.get(feedbackFocusAtom)
      if (request?.target !== target.target || request.to !== to) return
      store.set(feedbackFocusAtom, null)
      const focusable =
        to === "change"
          ? element
          : (element.querySelector<HTMLElement>("input:checked") ??
            element.querySelector<HTMLElement>("input, textarea"))
      focusable?.focus()
    }
  const values = { ...valuesOf(saved?.answer), ...draft }
  const shown = scales(values)
  const showForm = !saved || editing
  const send = () => {
    if (!sink) return
    // The harness's grade is never sent: the BFF reads it from the packet
    // when the call was visible.
    const submission: FeedbackSubmission = {
      ...answerFrom(
        on,
        values,
        shown.map((scale) => scale.field)
      ),
      target: target.target,
      harnessCallVisible,
    }
    void submit({ sink, submission }).then((recorded) => {
      if (recorded) onSaved?.()
    })
  }
  /** A scale's key ("1"–"4" for a reference's grade) picks its answer. */
  const pickByKey = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.target instanceof HTMLTextAreaElement
    )
      return false
    for (const scale of shown) {
      const picked = scale.options.find((entry) => entry.key === event.key)
      if (!picked) continue
      event.preventDefault()
      setDraft({
        target: target.target,
        field: scale.field,
        value: picked.value,
      })
      return true
    }
    return false
  }
  const motionProps = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: SWAP.offsetY },
    animate: { opacity: 1, y: 0 },
    exit: reduce
      ? { opacity: 0, transition: REDUCED_TRANSITION }
      : { opacity: 0, transition: SWAP.exit },
    transition: reduce ? REDUCED_TRANSITION : SWAP.enter,
  }
  return (
    <div className="flex flex-col gap-2" data-feedback={on}>
      <AnimatePresence mode="wait" initial={false}>
        {showForm ? (
          <motion.form
            key="form"
            {...motionProps}
            ref={claimFocus("answer")}
            aria-label={label}
            aria-describedby={`${id}-status`}
            aria-keyshortcuts="Meta+Enter"
            noValidate
            onKeyDown={(event) => {
              if (pickByKey(event)) return
              // ⌘↵ anywhere in the form saves it, and never reaches the
              // desk's approve shortcut; IME composition keeps its Enter.
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.requestSubmit()
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
            className="flex flex-col gap-3"
          >
            {shown.map((scale) => (
              <ScaleFieldset
                key={scale.field}
                name={`${id}-${scale.field}`}
                scale={scale}
                value={values[scale.field]}
                onChange={(value) =>
                  setDraft({ target: target.target, field: scale.field, value })
                }
              />
            ))}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-note`} className="label-mono text-[10px]">
                Note
              </label>
              <textarea
                id={`${id}-note`}
                name="note"
                rows={1}
                maxLength={4000}
                value={values["note"] ?? ""}
                onChange={(event) =>
                  setDraft({
                    target: target.target,
                    field: "note",
                    value: event.target.value,
                  })
                }
                aria-keyshortcuts="Meta+Enter"
                className="field-sizing-content min-h-8 w-full resize-y rounded-lg border-0 bg-raised px-2.5 py-[7px] text-[12.5px] leading-[18px] text-ink outline-none placeholder:text-ink-muted focus-visible:shadow-[inset_0_0_0_1px_var(--nv-focus)]"
              />
            </div>
            <div className="flex items-center justify-end gap-1.5">
              {saved && (
                <Button
                  type="button"
                  variant="quiet"
                  size="compact"
                  onClick={() => edit({ target: target.target, open: false })}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                variant="ink"
                size="compact"
                disabled={pending}
                aria-keyshortcuts="Meta+Enter"
                className="disabled:bg-raised-2 disabled:text-ink-muted disabled:opacity-100"
              >
                {pending ? "Saving…" : "Save"}
                {!pending && (
                  <kbd
                    aria-hidden="true"
                    className="ml-1.5 font-mono text-[10px] font-normal opacity-70"
                  >
                    ⌘↵
                  </kbd>
                )}
              </Button>
            </div>
          </motion.form>
        ) : (
          <motion.div
            key="saved"
            {...motionProps}
            className="flex items-start gap-2"
          >
            <CheckIcon
              aria-hidden="true"
              strokeWidth={1.9}
              className="mt-[3px] size-3.5 shrink-0 text-ink-muted"
            />
            <p className="m-0 flex min-w-0 flex-auto flex-col gap-0.5 text-[12.5px] leading-[18px] text-ink">
              <span>
                {sayAnswer(saved.answer, scales(valuesOf(saved.answer)))}
              </span>
              {saved.answer.note && (
                <span className="line-clamp-3 wrap-anywhere text-ink-2">
                  {saved.answer.note}
                </span>
              )}
            </p>
            <Button
              ref={claimFocus("change")}
              type="button"
              variant="quiet"
              size="xs"
              onClick={() => edit({ target: target.target, open: true })}
              className="h-[26px] px-2 text-xs font-normal pointer-coarse:h-11"
            >
              Change
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      <p
        id={`${id}-status`}
        aria-live="polite"
        className={cn(
          "m-0 text-xs leading-4 empty:hidden",
          message?.kind === "error" ? "text-req-fg" : "text-ink-muted"
        )}
      >
        {message?.text ?? ""}
      </p>
    </div>
  )
}

/* ── In a card: a finding, a context reference ─────────── */

/** The card section that holds a control, under a hairline. */
function CardSection({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="Your feedback"
      className="mt-3 border-t border-line-2 px-3.5 pt-3 pb-3"
    >
      {children}
    </section>
  )
}

/** Valid, invalid or unsure, on an agent's finding (its thread card). */
export function FindingFeedback({ commentId }: { commentId: string }) {
  const target = useFeedbackTarget((feedback) => feedback.findings[commentId])
  if (!target) return null
  return (
    <CardSection>
      <FeedbackBody
        on="finding"
        target={target}
        // The finding is the harness's call, and the card shows it.
        harnessCallVisible
        label="Feedback on this finding"
        scales={() => FINDING_SCALES}
      />
    </CardSection>
  )
}

/* ── As a layer: the unit's call, a reference, a digest ── */

const TRIGGER = cn(
  "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 font-sans text-xs text-ink-muted transition-colors duration-surface-tone ease-standard hover:bg-raised hover:text-ink aria-expanded:bg-raised aria-expanded:text-ink motion-reduce:transition-none pointer-coarse:h-11",
  FOCUS
)

/** Whole inside the viewport and inside `holder`'s visible box, when given. */
function inView(element: HTMLElement, holder: HTMLElement | null): boolean {
  const at = element.getBoundingClientRect()
  if (at.width === 0 && at.height === 0) return false
  const box = holder?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
    left: 0,
    right: window.innerWidth,
  }
  return (
    at.top >= Math.max(box.top, 0) - 0.5 &&
    at.bottom <= Math.min(box.bottom, window.innerHeight) + 0.5 &&
    at.left >= Math.max(box.left, 0) - 0.5 &&
    at.right <= Math.min(box.right, window.innerWidth) + 0.5
  )
}

/** Wide enough to open a reference's layer beside its card. */
const WIDE = "(min-width: 768px)"

function subscribeWide(onChange: () => void) {
  const query = matchMedia(WIDE)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/** True on a wide viewport; the server renders the narrow placement. */
function useWideViewport(): boolean {
  return React.useSyncExternalStore(
    subscribeWide,
    () => matchMedia(WIDE).matches,
    () => false
  )
}

function FeedbackLayer({
  target,
  trigger,
  triggerLabel,
  triggerClassName,
  title,
  side = "bottom",
  anchorTo,
  children,
}: {
  target: FeedbackTarget
  /** The trigger's visible words. */
  trigger: string
  /** Its accessible name, when the words need their place to read. */
  triggerLabel?: string
  /** The trigger's look where it sits (a card's chip). */
  triggerClassName?: string
  title: string
  /** Where the layer opens; Radix flips it when there is no room. */
  side?: "bottom" | "right"
  /**
   * The trigger's ancestor the layer opens against, the first selector that
   * matches: a card's visible box, so the layer sits beside it and never
   * over its actions. The trigger by default.
   */
  anchorTo?: ReadonlyArray<string>
  children: React.ReactNode
}) {
  const id = React.useId()
  const anchor = React.useRef<HTMLElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  /** A press or focus outside closed the layer: focus stays where it went. */
  const leftOutside = React.useRef(false)
  /** What had focus when the layer opened (where F was pressed). */
  const openedFrom = React.useRef<HTMLElement | null>(null)
  const open = useAtomValue(feedbackLayerAtom) === target.target
  const setOpen = useSetAtom(feedbackLayerAtom)
  const session = useAtomValue(feedbackSavedAtom)
  const saved = currentAnswer(target, session) !== undefined
  /**
   * Focus after the layer closes, never scrolling: the trigger when the
   * reader can see it, else where focus was when it opened, else the box
   * that holds the trigger (a floating card takes focus; FloatingCard).
   */
  const returnFocus = () => {
    const button = triggerRef.current
    if (!button) return
    const holder = button.closest<HTMLElement>("[data-floating-card]")
    const next = [button, openedFrom.current].find(
      (element): element is HTMLElement =>
        !!element && element.isConnected && inView(element, holder)
    )
    ;(next ?? holder ?? button).focus({ preventScroll: true })
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => setOpen(next ? target.target : null)}
    >
      {anchorTo && <PopoverAnchor virtualRef={anchor} />}
      <PopoverTrigger asChild>
        <button
          ref={(element) => {
            triggerRef.current = element
            let around: HTMLElement | null = null
            for (const selector of anchorTo ?? []) {
              around = element?.closest<HTMLElement>(selector) ?? null
              if (around) break
            }
            anchor.current = around ?? element
          }}
          type="button"
          data-feedback-trigger=""
          aria-label={`${triggerLabel ?? trigger}${saved ? ", saved" : ""}`}
          className={triggerClassName ?? TRIGGER}
        >
          {trigger}
          {saved && (
            <CheckIcon
              aria-hidden="true"
              strokeWidth={1.9}
              className="size-3"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        // The desk's ⌘↵ never decides from inside the layer (its header and
        // Close included): review-desk-screen.tsx fences it.
        data-feedback-layer=""
        side={side}
        align="start"
        sideOffset={side === "right" ? 12 : 6}
        aria-labelledby={`${id}-title`}
        collisionPadding={16}
        // One layer per Escape: this one closes, and the desk's own Escape
        // (closing the card the layer opened from) does not also run.
        onEscapeKeyDown={(event) => event.stopPropagation()}
        // A layer taller than the room left beside its trigger moves fully
        // into view, and scrolls inside when the viewport is shorter still.
        sticky="always"
        onInteractOutside={() => {
          leftOutside.current = true
        }}
        // Focus returns without scrolling what holds it (a card scrolled to
        // its foot by the return would hide its own top), and only to
        // something the reader can see: the trigger when it is in view, else
        // what had focus when the layer opened, else the card's own box.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!leftOutside.current) returnFocus()
          leftOutside.current = false
        }}
        onOpenAutoFocus={(event) => {
          leftOutside.current = false
          openedFrom.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null
          // Land on the first answer (or "Change"), not on Close.
          const content = event.currentTarget
          const first =
            content instanceof HTMLElement
              ? content.querySelector<HTMLElement>(
                  "form input, [data-feedback] button"
                )
              : null
          if (!first) return
          event.preventDefault()
          first.focus()
        }}
        className="max-h-(--radix-popover-content-available-height) w-[340px] max-w-[calc(100vw-32px)] gap-0 overflow-y-auto overscroll-contain rounded-xl bg-surface p-0 font-sans text-ink shadow-card ring-0"
      >
        <div className="flex items-center gap-2 pt-2.5 pr-2.5 pl-3.5">
          <h2
            id={`${id}-title`}
            className="m-0 flex-auto text-[13px] leading-[17px] font-semibold"
          >
            {title}
          </h2>
          <Button
            type="button"
            variant="quiet"
            size="icon-card"
            aria-label="Close"
            onClick={() => setOpen(null)}
            className="size-[26px]"
          >
            <XIcon aria-hidden="true" className="size-[11px]" />
          </Button>
        </div>
        <div className="px-3.5 pt-2 pb-3.5">{children}</div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Feedback on the unit, from "Give feedback" beside its lane label:
 * complexity, ease of validation, lane and verdict. The lane is always on
 * screen in the rail.
 */
export function UnitFeedback() {
  const target = useFeedbackTarget((feedback) => feedback.unit)
  if (!target) return null
  return (
    <FeedbackLayer target={target} trigger="Give feedback" title="Feedback">
      <FeedbackBody
        on="unit"
        target={target}
        harnessCallVisible
        label="Feedback on this unit"
        scales={() => UNIT_SCALES}
      />
    </FeedbackLayer>
  )
}

/** The card's chip: the same quiet pill as its "Open source". */
const CARD_CHIP = cn(
  "inline-flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-[7px] border-0 bg-raised px-[9px] font-sans text-xs whitespace-nowrap text-ink transition-colors duration-surface-tone ease-standard hover:bg-raised-2 aria-expanded:bg-raised-2 motion-reduce:transition-none pointer-coarse:h-11",
  FOCUS
)

type ReferenceTarget = DeskFeedback["references"][string]

function useReferenceTarget(markerKey: string): ReferenceTarget | undefined {
  // The hook returns the plain target; a reference's carries the grade.
  return useFeedbackTarget((feedback) => feedback.references[markerKey])
}

/**
 * Feedback on a context reference (10.107), from "Give feedback" on its
 * card: the grade (the harness's marked on its option), the grade it sits
 * between, the note's rubric and a note. ⌘↵ or Save records it and closes
 * the layer; the chip then shows a check. `F` opens it from the card
 * (`useReferenceFeedbackKey`).
 */
export function ReferenceFeedback({
  markerKey,
  hasCheck,
  className,
}: {
  markerKey: string
  /** The card has a "Before you decide" check, so its row is asked. */
  hasCheck: boolean
  className?: string
}) {
  const reference = useReferenceTarget(markerKey)
  const setLayer = useSetAtom(feedbackLayerAtom)
  const store = useStore()
  const wide = useWideViewport()
  if (!reference) return null
  const harnessGrade = reference.harnessGrade
  const context: ReferenceContext = {
    hasCheck,
    ...(harnessGrade ? { harnessGrade } : {}),
  }
  return (
    <div className={className}>
      <FeedbackLayer
        target={reference}
        trigger="Give feedback"
        triggerClassName={CARD_CHIP}
        title="Feedback"
        side={wide ? "right" : "bottom"}
        // Wide, it opens beside the card's visible box (the floating layer
        // that scrolls a tall card, or the card itself), so the reason stays
        // in view and a scrolled card never drags the layer off; narrow,
        // against its chip, where it flips above when the card runs low.
        {...(wide
          ? { anchorTo: ["[data-floating-card]", "[data-context-card]"] }
          : {})}
      >
        <FeedbackBody
          on="reference"
          target={reference}
          // The card shows the harness's grade, and the layer marks it.
          harnessCallVisible={harnessGrade !== undefined}
          label="Feedback on this reference"
          scales={(values) => referenceScales(values["grade"], context)}
          onSaved={() => {
            // The layer closes and focus returns to its chip, not "Change".
            store.set(feedbackFocusAtom, null)
            setLayer(null)
          }}
        />
      </FeedbackLayer>
    </div>
  )
}

/**
 * `F` on an open reference card opens its feedback layer. A key handler for
 * the card, or undefined while the desk carries no feedback for it. Keys
 * typed in a field or in the layer's own form are left alone.
 */
export function useReferenceFeedbackKey(
  markerKey: string
): ((event: React.KeyboardEvent<HTMLElement>) => void) | undefined {
  const reference = useReferenceTarget(markerKey)
  const setLayer = useSetAtom(feedbackLayerAtom)
  const wide = useWideViewport()
  if (!reference) return undefined
  return (event) => {
    if (
      event.defaultPrevented ||
      (event.key !== "f" && event.key !== "F") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.nativeEvent.isComposing
    )
      return
    const at = event.target
    if (
      at instanceof HTMLElement &&
      (at.isContentEditable ||
        at.closest("input, textarea, select, form") !== null)
    )
      return
    event.preventDefault()
    // Narrow, the layer opens against the chip: bring the chip into the
    // card's view first, as a pointer would have to.
    if (!wide)
      event.currentTarget
        .querySelector<HTMLElement>("[data-feedback-trigger]")
        ?.scrollIntoView({ block: "nearest" })
    setLayer(reference.target)
  }
}

/**
 * How many of these references the reader has rated, for the margin pin
 * ("2 rated"); undefined while the desk carries no feedback.
 */
export function useRatedReferences(
  markerKeys: ReadonlyArray<string>
): number | undefined {
  const feedback = React.useContext(DeskFeedbackContext)
  const sink = React.useContext(FeedbackSinkContext)
  const session = useAtomValue(feedbackSavedAtom)
  if (!feedback || !sink) return undefined
  const asked = markerKeys.flatMap((key) => {
    const target = feedback.references[key]
    return target ? [target] : []
  })
  if (asked.length === 0) return undefined
  return asked.filter((target) => currentAnswer(target, session) !== undefined)
    .length
}

/**
 * The reader's answer on a reference, under its reason in the line's list:
 * "✓ Useful · not tied to these lines". Nothing while it has none.
 */
export function ReferenceFeedbackSummary({
  markerKey,
  className,
}: {
  markerKey: string
  className?: string
}) {
  const reference = useReferenceTarget(markerKey)
  const session = useAtomValue(feedbackSavedAtom)
  const saved = reference ? currentAnswer(reference, session) : undefined
  if (!saved) return null
  return (
    <span
      data-feedback-summary=""
      className={cn(
        "flex min-w-0 items-start gap-1 text-[11.5px] leading-4 text-ink-muted",
        className
      )}
    >
      <CheckIcon
        aria-hidden="true"
        strokeWidth={1.9}
        className="mt-px size-3 shrink-0"
      />
      <span className="sr-only">Your feedback: </span>
      <span className="min-w-0">{sayReferenceSummary(saved.answer)}</span>
    </span>
  )
}

const DIGEST_NAME: Record<DigestContent, string> = {
  facts: "Facts",
  briefed: "Briefed",
  explained: "Explained",
  guided: "Guided",
}

/**
 * The rubric under a digest: accurate, complete, misleading claim and
 * neutral before the verdict.
 */
export function DigestFeedback({
  content,
  harnessCallVisible,
  className,
}: {
  content: DigestContent
  /** True when the unit's verdict (the agent's review or the suggested review) is on screen. */
  harnessCallVisible: boolean
  className?: string
}) {
  const target = useFeedbackTarget((feedback) => feedback.digests[content])
  if (!target) return null
  return (
    <div className={className}>
      <FeedbackLayer
        target={target}
        trigger="Rate digest"
        triggerLabel={`Rate the ${DIGEST_NAME[content]} digest`}
        title={`${DIGEST_NAME[content]} digest`}
      >
        <FeedbackBody
          on="digest"
          target={target}
          harnessCallVisible={harnessCallVisible}
          label={`Feedback on the ${DIGEST_NAME[content]} digest`}
          scales={() => DIGEST_SCALES}
        />
      </FeedbackLayer>
    </div>
  )
}
