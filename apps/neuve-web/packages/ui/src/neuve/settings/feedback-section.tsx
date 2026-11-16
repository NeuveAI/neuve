import { useSetAtom } from "jotai"

import { cn } from "@workspace/ui/lib/utils"
import {
  useFeedbackSetting,
  useFeedbackSettingAtom,
} from "@workspace/ui/neuve/review-desk/feedback/atoms"

/**
 * Settings section "Feedback" (10.100): the owner's instrument, off until
 * they turn it on. With it on, the review desk shows a control beside each
 * unit's lane, on finding and context cards, and under each digest.
 */
export function FeedbackSection() {
  const { enabled } = useFeedbackSetting()
  const setSetting = useSetAtom(useFeedbackSettingAtom())
  return (
    <section
      id="feedback"
      aria-labelledby="feedback-title"
      className="flex max-w-[640px] scroll-mt-6 flex-col gap-5"
    >
      {/* A section of its own, beside Review delivery, not under it. */}
      <h2
        id="feedback-title"
        className="m-0 text-[32px] leading-[38px] font-semibold tracking-[-0.025em]"
      >
        Feedback
      </h2>
      <label className="flex cursor-pointer items-center gap-4 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--nv-line)] pointer-coarse:min-h-11">
        <span className="flex min-w-0 flex-auto flex-col gap-0.5">
          <span id="feedback-label" className="text-sm text-ink">
            Feedback in the review desk
          </span>
          <span
            id="feedback-help"
            className="text-[13px] leading-[19px] text-ink-muted"
          >
            Your answers on units, findings, context and digests. They change
            nothing in the review.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={enabled}
          onChange={(event) => setSetting({ enabled: event.target.checked })}
          aria-labelledby="feedback-label"
          aria-describedby="feedback-help"
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-surface-tone ease-standard motion-reduce:transition-none",
            "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:outline-solid",
            enabled
              ? "bg-ink"
              : "bg-raised-2 shadow-[inset_0_0_0_1px_var(--nv-line-strong)]"
          )}
        >
          <span
            className={cn(
              "size-4 rounded-full bg-surface shadow-[0_1px_2px_rgba(0,0,0,.16)] transition-transform duration-surface-tone ease-standard motion-reduce:transition-none",
              enabled && "translate-x-4"
            )}
          />
        </span>
      </label>
    </section>
  )
}
