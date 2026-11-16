/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Comment thread (Threads.dc.html, Main.dc.html)
 *
 *    0ms   thread opens from its pin: opacity 0 → 1, y -4 → 0
 *          (card 220ms, emphasized decelerate)
 *    0ms   chosen from a line's list: swaps in for the list, no motion;
 *          its back chevron (or Escape) swaps the list back in
 *    0ms   a message arrives (yours or the agent's reply): opacity 0 → 1,
 *          y 6 → 0 (message 260ms, emphasized decelerate)
 *    0ms   delivery line swaps text (queued → sent → picked up): crossfade
 *          (reduced 150ms)
 *  loop    working: three dots pulse 0.3 → 1 → 0.3, 180ms apart
 *          (working 1100ms, ease-in-out); steps collapse under "working"
 *    0ms   needs your input / failed: the row rises (message 260ms)
 *  close   thread exits: opacity → 0, y → -4 (cardExit 160ms, accelerate)
 *
 * Reduced motion: opacity-only 150ms; the dots stay still at 60%.
 * ───────────────────────────────────────────────────────── */

import { useAtomValue, useSetAtom } from "jotai"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  GitCommitHorizontalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  EASE,
  REDUCED_TRANSITION,
  TIMING,
  ms,
  OFFSET,
  OPACITY,
} from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import { CardBackButton } from "@workspace/ui/neuve/review-desk/floating"
import type { CardBack } from "@workspace/ui/neuve/review-desk/floating"
import { AgentAvatar } from "@workspace/ui/neuve/agents/agent-avatar"
import { agentByIdAtom } from "@workspace/ui/neuve/agents/atoms"
import { commentThreadAuthor } from "@workspace/ui/neuve/review-comments/record"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import { relativeTime } from "@workspace/ui/neuve/review-comments/thread"
import type {
  ReviewThread,
  ThreadAuthor,
  ThreadMessage,
  ThreadState,
} from "@workspace/ui/neuve/review-comments/thread"
import {
  answerPermissionAtom,
  openStepsAtom,
  retryThreadAtom,
  sendThreadReplyAtom,
  threadOperationErrorsAtom,
  threadOperationsAtom,
  setReplyDraftAtom,
  threadReplyDraftsAtom,
  toggleStepsAtom,
} from "@workspace/ui/neuve/review-comments/threads"
import { FindingFeedback } from "@workspace/ui/neuve/review-desk/feedback/feedback-controls"
import { PersonAvatar } from "@workspace/ui/neuve/shared/person-avatar"

const THREAD = {
  offsetY: -OFFSET.card,
  enter: { duration: ms(TIMING.card), ease: EASE.emphasizedDecelerate },
  exit: { duration: ms(TIMING.cardExit), ease: EASE.emphasizedAccelerate },
} as const

const MESSAGE = {
  offsetY: OFFSET.rise,
  enter: { duration: ms(TIMING.message), ease: EASE.emphasizedDecelerate },
} as const

const DOTS = {
  stagger: ms(TIMING.workingStagger),
  low: OPACITY.workingLow,
  loop: { duration: ms(TIMING.working), ease: EASE.inOut },
} as const

/**
 * The author's avatar from the review identity, 20px: a person's chat
 * bubble or the agent's antenna square in its role tint. Decorative; the
 * name sits beside it. Agents outside the registry read as implementers
 * (a thread is with the agent that owns the unit).
 */
export function MessageAvatar({ author }: { author: ThreadAuthor }) {
  const agents = useAtomValue(agentByIdAtom)
  return (
    <span className="flex h-5 w-5 items-center justify-center">
      {author.kind === "agent" ? (
        <AgentAvatar
          agent={{
            short: author.short,
            role: agents[author.agentId]?.role ?? "implementer",
          }}
          size={20}
        />
      ) : (
        <PersonAvatar person={author} size={20} />
      )}
    </span>
  )
}

function MessageRow({
  message,
  delivery,
}: {
  message: ThreadMessage
  delivery?: React.ReactNode
}) {
  const reduce = useReducedMotion()
  const name = message.author.name
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: MESSAGE.offsetY }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? REDUCED_TRANSITION : MESSAGE.enter}
      className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 gap-y-[3px]"
      data-message-author={message.author.kind}
    >
      <MessageAvatar author={message.author} />
      <span className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-semibold">{name}</span>
        <span className="font-mono text-[10.5px] text-ink-muted">
          {relativeTime(message.at)}
        </span>
      </span>
      <span />
      <span className="flex flex-col gap-1.5">
        <span className="text-[12.5px] leading-[18px] whitespace-pre-line text-ink-2">
          {message.body}
        </span>
        {message.chips && message.chips.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {message.chips.map((chip) => (
              <span
                key={chip.text}
                className={cn(
                  "rounded-sm px-1.5 py-px font-mono text-[10.5px]",
                  chip.tone === "agt"
                    ? "bg-agt-tint-2 text-agt-ink"
                    : "bg-raised text-ink-2"
                )}
              >
                {chip.text}
              </span>
            ))}
          </span>
        )}
      </span>
      {delivery && (
        <>
          <span />
          {delivery}
        </>
      )}
    </motion.div>
  )
}

function WorkingDots() {
  const reduce = useReducedMotion()
  return (
    <span aria-hidden="true" className="inline-flex gap-[3px]">
      {[0, 1, 2].map((i) =>
        reduce ? (
          <span key={i} className="size-[5px] rounded-full bg-agt-fg/60" />
        ) : (
          <motion.span
            key={i}
            className="size-[5px] rounded-full bg-agt-fg"
            animate={{ opacity: [DOTS.low, 1, DOTS.low] }}
            transition={{
              ...DOTS.loop,
              repeat: Infinity,
              delay: i * DOTS.stagger,
            }}
          />
        )
      )}
    </span>
  )
}

const DELIVERY: Partial<Record<ThreadState, (agent: string) => string>> = {
  queued: (agent) => `Queued · reaches ${agent} when it’s free`,
  sent: (agent) => `Sent to ${agent}`,
  "picked-up": (agent) => `Picked up by ${agent}`,
}

/** The state row under the latest message: working, needs input, failed. */
function StateRow({
  thread,
  agent,
}: {
  thread: ReviewThread
  agent: { name: string; short: string; agentId: string }
}) {
  const openSteps = useAtomValue(openStepsAtom)
  const toggleSteps = useSetAtom(toggleStepsAtom)
  const answer = useSetAtom(answerPermissionAtom)
  const retry = useSetAtom(retryThreadAtom)
  const pending = useAtomValue(threadOperationsAtom)[thread.commentId] ?? false
  const reduce = useReducedMotion()
  const author: ThreadAuthor = { kind: "agent", ...agent }
  const rise = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: MESSAGE.offsetY },
    animate: { opacity: 1, y: 0 },
    transition: reduce ? REDUCED_TRANSITION : MESSAGE.enter,
  }
  const steps = thread.steps
  const stepsOpen = openSteps.includes(thread.commentId)

  const stepList =
    steps.length > 0 ? (
      <Collapsible
        open={stepsOpen}
        onOpenChange={() => toggleSteps(thread.commentId)}
      >
        <CollapsibleTrigger
          className={cn(
            "relative inline-flex items-center gap-1 rounded-sm border-0 bg-transparent p-0 font-mono text-[10.5px] text-ink-muted hover:text-ink",
            // The 15px line's hit area grows into the free space above it
            // and the 4px gap below, never over the open list (WCAG 2.5.8):
            // 33px under the working row, 24px under a permission panel,
            // where Allow and Deny keep their own space.
            "after:absolute after:inset-x-0 after:-bottom-1",
            thread.permission && thread.state === "needs-input"
              ? "after:-top-[5px]"
              : "after:-top-3.5"
          )}
        >
          {steps.length} step{steps.length > 1 ? "s" : ""}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3 transition-transform duration-chevron ease-standard motion-reduce:transition-none",
              stepsOpen && "rotate-180"
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {steps.map((step) => (
              <li
                key={step.id}
                className="flex items-start gap-1.5 font-mono text-[10.5px] leading-[15px] text-ink-muted"
              >
                {step.kind === "commit" ? (
                  <GitCommitHorizontalIcon
                    aria-hidden="true"
                    className="mt-px size-3 shrink-0"
                  />
                ) : step.kind === "tool" ? (
                  <WrenchIcon
                    aria-hidden="true"
                    className="mt-px size-3 shrink-0"
                  />
                ) : (
                  <span aria-hidden="true" className="w-3 shrink-0 text-center">
                    ·
                  </span>
                )}
                <span className="wrap-anywhere">{step.text}</span>
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    ) : null

  if (thread.state === "working" || thread.state === "picked-up") {
    if (thread.state === "picked-up" && steps.length === 0) return null
    return (
      <motion.div
        {...rise}
        role="status"
        className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1"
      >
        <MessageAvatar author={author} />
        <span className="flex min-h-5 items-center gap-2 text-[12.5px] text-ink-muted">
          <WorkingDots />
          {agent.name} is working
        </span>
        {stepList && (
          <>
            <span />
            {stepList}
          </>
        )}
      </motion.div>
    )
  }

  if (thread.state === "needs-input" && thread.permission) {
    return (
      <motion.div
        {...rise}
        role="alert"
        className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5"
      >
        <MessageAvatar author={author} />
        <span className="flex min-h-5 items-center text-[12.5px] font-semibold">
          Needs your input
        </span>
        <span />
        <div className="flex flex-col gap-2 rounded-lg bg-sug-tint px-2.5 py-2">
          <span className="font-mono text-[11.5px] leading-4 wrap-anywhere text-sug-ink">
            {thread.permission.request}
          </span>
          {thread.permission.detail && (
            <span className="text-xs leading-[17px] text-ink-2">
              {thread.permission.detail}
            </span>
          )}
          <span className="flex gap-1.5">
            <Button
              type="button"
              variant="ink"
              size="xs"
              className="h-7 px-2.5 text-xs font-medium"
              disabled={pending}
              aria-busy={pending}
              onClick={() => answer(thread.commentId, "allowed")}
            >
              Allow once
            </Button>
            <Button
              type="button"
              variant="quiet"
              size="xs"
              className="h-7 px-2.5 text-xs font-normal"
              disabled={pending}
              aria-busy={pending}
              onClick={() => answer(thread.commentId, "denied")}
            >
              Deny
            </Button>
          </span>
        </div>
        {stepList && (
          <>
            <span />
            {stepList}
          </>
        )}
      </motion.div>
    )
  }

  if (thread.state === "failed") {
    return (
      <motion.div
        {...rise}
        role="alert"
        className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5"
      >
        <span className="inline-flex size-5 items-center justify-center text-req-fg">
          <CircleAlertIcon aria-hidden="true" className="size-4" />
        </span>
        <span className="text-[12.5px] leading-[18px] text-req-fg">
          {thread.failure ?? `Couldn’t reach ${agent.name}.`}
        </span>
        <span />
        <Button
          type="button"
          variant="raised"
          size="xs"
          className="h-7 justify-self-start px-2.5 text-xs font-normal"
          disabled={pending}
          aria-busy={pending}
          onClick={() => retry(thread.commentId)}
        >
          Retry
        </Button>
      </motion.div>
    )
  }
  return null
}

/**
 * A comment shown in place while "Show comments" is on: author, lines, two
 * lines of the comment and where its thread stands. It does not isolate the
 * margin; clicking it opens the thread (which does).
 */
export function CommentPreviewCard({
  record,
  rangeLabel,
  thread,
  onOpen,
  floating = false,
}: {
  record: ReviewCommentRecord
  rangeLabel: string
  thread: ReviewThread | undefined
  onOpen: () => void
  floating?: boolean
}) {
  const reduce = useReducedMotion()
  const replies = thread?.messages.length ?? 0
  const status: Record<ThreadState, string> = {
    queued: "queued",
    sent: "sent",
    "picked-up": "picked up",
    working: "working",
    replied: replies > 0 ? "replied" : "",
    "needs-input": "needs your input",
    failed: "failed",
  }
  const state = thread ? status[thread.state] : ""
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      aria-label={`Open thread on ${rangeLabel}: ${record.author.name}: ${record.body}`}
      data-comment-preview=""
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: THREAD.offsetY }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: REDUCED_TRANSITION }}
      transition={reduce ? REDUCED_TRANSITION : THREAD.enter}
      className={cn(
        "box-border flex w-full shrink-0 flex-col gap-1.5 rounded-[10px] border-0 bg-surface px-3 py-2.5 text-left font-sans text-ink transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none",
        !floating && "shadow-card"
      )}
    >
      <span className="flex w-full items-center gap-2 text-xs leading-4">
        <MessageAvatar author={commentThreadAuthor(record.author)} />
        <span className="min-w-0 flex-auto truncate font-semibold">
          {record.author.name}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">
          {rangeLabel}
        </span>
      </span>
      <span className="line-clamp-2 text-[12.5px] leading-[18px] text-ink-2">
        {record.body}
      </span>
      {(replies > 0 || state) && (
        <span className="font-mono text-[10.5px] text-ink-muted">
          {replies} repl{replies === 1 ? "y" : "ies"}
          {state ? ` · ${state}` : ""}
        </span>
      )}
    </motion.button>
  )
}

/**
 * An open review comment as a thread with the agent that owns the unit:
 * the comment, the replies (people's chat bubbles, agents' antenna squares), where the latest
 * message is (queued → sent → picked up), the agent working (narration and
 * tool calls collapsed into steps), a permission request (Allow once /
 * Deny), a failure (Retry), and the reply box once the agent has replied.
 */
export type ThreadCommentMetadata = Pick<
  ReviewCommentRecord,
  "id" | "unitId" | "revision" | "author" | "body" | "createdAt" | "status"
>

export function ThreadCard({
  record,
  rangeLabel,
  thread,
  fallbackAgentId,
  reviewer,
  onDismiss,
  onToggleStatus,
  back,
  floating = false,
  className,
}: {
  record: ThreadCommentMetadata
  rangeLabel: string
  thread: ReviewThread | undefined
  /** Inside a FloatingCard (it owns surface, shadow, height and motion). */
  floating?: boolean
  /** The unit's agent when the comment has no thread yet. */
  fallbackAgentId?: string
  reviewer: { id: string; name: string; initials: string }
  onDismiss: () => void
  onToggleStatus?: () => void
  /** Chosen from a line's list: a back control returns to it. */
  back?: CardBack
  className?: string
}) {
  const agents = useAtomValue(agentByIdAtom)
  const drafts = useAtomValue(threadReplyDraftsAtom)
  const setDraft = useSetAtom(setReplyDraftAtom)
  const send = useSetAtom(sendThreadReplyAtom)
  const operationError = useAtomValue(threadOperationErrorsAtom)[record.id]
  const reduce = useReducedMotion()
  const agentId = thread?.agentId ?? fallbackAgentId
  const known = agentId ? agents[agentId] : undefined
  const agent = {
    agentId: agentId ?? "agent",
    name: known?.name ?? "the implementer",
    short: known?.short ?? "AI",
  }
  const first: ThreadMessage = {
    id: `${record.id}:comment`,
    author: commentThreadAuthor(record.author),
    body: record.body,
    at: record.createdAt,
  }
  const messages = [first, ...(thread?.messages ?? [])]
  const state = thread?.state ?? "replied"
  const lastHuman = [...messages]
    .reverse()
    .find((message) => message.author.kind === "human")
  const deliveryText = DELIVERY[state]?.(agent.name)
  const draft = drafts[record.id] ?? ""
  const canReply = agentId !== undefined && (state === "replied" || !thread)
  const resolved = record.status === "resolved"
  const replyId = `reply-${record.id}`

  return (
    <motion.article
      aria-label={`Comment thread on ${rangeLabel}`}
      data-thread-state={state}
      initial={
        floating
          ? false
          : reduce
            ? { opacity: 0 }
            : { opacity: 0, y: THREAD.offsetY }
      }
      animate={{ opacity: 1, y: 0 }}
      exit={
        reduce
          ? { opacity: 0, transition: REDUCED_TRANSITION }
          : { opacity: 0, y: THREAD.offsetY, transition: THREAD.exit }
      }
      transition={reduce ? REDUCED_TRANSITION : THREAD.enter}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onDismiss()
        }
      }}
      data-thread-card=""
      className={cn(
        "box-border flex w-full flex-col overflow-x-hidden rounded-xl bg-surface font-sans text-ink",
        floating ? "shrink-0" : "shadow-card",
        className
      )}
    >
      {operationError && (
        <p role="alert" className="px-4 py-2 text-xs text-req">
          {operationError}
        </p>
      )}
      {/* Title over its range and count, so neither is ever cut off in a
          260px margin. */}
      <div
        className={cn(
          "flex items-center gap-1.5 border-b border-line-2 py-2 pr-2",
          back ? "pl-2" : "pl-3.5"
        )}
      >
        {back && <CardBackButton back={back} />}
        <span className="flex min-w-0 flex-auto flex-col">
          <span className="text-[13px] leading-[17px] font-semibold">
            Thread
          </span>
          <span
            data-thread-count=""
            className="font-mono text-[10.5px] leading-[15px] whitespace-nowrap text-ink-muted"
          >
            {rangeLabel} · {messages.length} message
            {messages.length === 1 ? "" : "s"}
          </span>
        </span>
        {onToggleStatus && (
          <Button
            type="button"
            variant="quiet"
            size="xs"
            onClick={onToggleStatus}
            aria-pressed={resolved}
            className="h-[26px] px-1.5 text-xs font-normal"
          >
            {resolved ? (
              <>
                <CheckIcon aria-hidden="true" />
                Reopen
              </>
            ) : (
              "Resolve"
            )}
          </Button>
        )}
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          aria-label="Close thread"
          onClick={onDismiss}
          className="size-[26px]"
        >
          <XIcon aria-hidden="true" className="size-[11px]" />
        </Button>
      </div>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        {record.status === "resolved" && (
          <span className="font-mono text-[10.5px] text-ink-muted">
            Resolved · kept for later cycles
          </span>
        )}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            delivery={
              message === lastHuman && deliveryText ? (
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={state}
                    role="status"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={REDUCED_TRANSITION}
                    className="font-mono text-[10.5px] text-ink-muted"
                  >
                    {deliveryText}
                  </motion.span>
                </AnimatePresence>
              ) : undefined
            }
          />
        ))}
        {thread && <StateRow thread={thread} agent={agent} />}
      </div>
      {record.author.kind === "agent" && (
        <FindingFeedback commentId={record.id} />
      )}
      {canReply && (
        <form
          className="flex items-end gap-2 border-t border-line-2 px-2.5 pt-2 pb-2.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (agentId)
              send({ commentId: record.id, agentId, author: reviewer })
          }}
        >
          <label htmlFor={replyId} className="sr-only">
            Reply
          </label>
          <textarea
            id={replyId}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(record.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={`Reply to ${agent.short}…`}
            aria-keyshortcuts="Meta+Enter"
            className="min-h-8 flex-auto resize-none rounded-lg border-0 bg-raised px-[9px] py-[7px] text-[12.5px] leading-[18px] text-ink outline-none placeholder:text-ink-muted focus-visible:shadow-[inset_0_0_0_1px_var(--nv-focus)]"
          />
          <Button
            type="submit"
            variant="ink"
            size="compact"
            disabled={draft.trim() === ""}
            className="h-8 font-medium disabled:bg-raised-2 disabled:text-ink-muted disabled:opacity-100"
          >
            Send
          </Button>
        </form>
      )}
    </motion.article>
  )
}
