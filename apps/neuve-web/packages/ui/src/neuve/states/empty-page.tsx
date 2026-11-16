import { Provider } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { MotionConfig } from "motion/react"
import { ArrowRightIcon } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { agentsHydration } from "@workspace/ui/neuve/agents/atoms"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import type { DeskBatchContext } from "@workspace/ui/neuve/types"

/**
 * The one action of an empty state. A link when it navigates, a button when
 * it acts (modern-web-guidance: element semantics follow the behaviour).
 */
export interface EmptyAction {
  label: string
  destination: NeuveDestination
}

const PRIMARY_ACTION =
  "group/cta inline-flex h-11 items-center gap-2.5 rounded-[10px] border-0 bg-ink px-[18px] font-sans text-sm font-medium text-paper no-underline transition-colors duration-surface-tone ease-standard hover:bg-ink/90 hover:text-paper motion-reduce:transition-none"

function ActionArrow() {
  return (
    <ArrowRightIcon
      aria-hidden="true"
      strokeWidth={1.75}
      className="size-[15px] transition-transform duration-nudge ease-ios-out group-hover/cta:translate-x-(--nv-offset-nudge) motion-reduce:transition-none"
    />
  )
}

/** Stable, so React calls it once, when the heading mounts. */
const focusOnMount = (node: HTMLHeadingElement | null) => node?.focus()

function Hydrate({
  batch,
  children,
}: {
  batch: DeskBatchContext | undefined
  children: React.ReactNode
}) {
  useHydrateAtoms(
    agentsHydration(
      batch?.agents ?? { agents: [], configured: [], connections: {} }
    )
  )
  return children
}

/**
 * A page with nothing to show yet: the app header (just the brand and theme
 * when there is no batch), then one centred empty state — an icon, a title,
 * one line saying why, and at most one action. The heading is the page's
 * h1; no live region (an empty state is a page, not an update).
 */
export function EmptyPage({
  batch,
  icon: Icon,
  title,
  children,
  action,
  actionSlot,
  focusTitle,
}: {
  /** The batch around the page, when there is one (header, agents). */
  batch?: DeskBatchContext
  icon: LucideIcon
  title: string
  /** One line: why there is nothing here. */
  children: React.ReactNode
  action?: EmptyAction
  /** A custom single action (e.g. a button that acts). */
  actionSlot?: React.ReactNode
  /**
   * Moves focus to the heading when the page appears, for a page that
   * replaces the control the reader just pressed.
   */
  focusTitle?: boolean
}) {
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        <Hydrate batch={batch}>
          <div className="flex min-h-svh flex-col bg-paper font-sans text-sm text-ink">
            <AppHeader
              repo={batch?.repo}
              branch={batch?.branch}
              commit={batch?.revision}
            />
            <main
              {...regionTransition("state", 1)}
              className="flex flex-auto content-fade items-center justify-center px-6 pt-16 pb-24"
            >
              <Empty className="max-w-[520px]">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Icon aria-hidden="true" strokeWidth={1.75} />
                  </EmptyMedia>
                  <EmptyTitle>
                    <h1
                      className="m-0 text-inherit focus:outline-none"
                      {...(focusTitle
                        ? { tabIndex: -1, ref: focusOnMount }
                        : {})}
                    >
                      {title}
                    </h1>
                  </EmptyTitle>
                  <EmptyDescription>{children}</EmptyDescription>
                </EmptyHeader>
                {(action || actionSlot) && (
                  <EmptyContent>
                    {actionSlot ??
                      (action && (
                        <NeuveLink
                          destination={action.destination}
                          className={PRIMARY_ACTION}
                        >
                          {action.label}
                          <ActionArrow />
                        </NeuveLink>
                      ))}
                  </EmptyContent>
                )}
              </Empty>
            </main>
          </div>
        </Hydrate>
      </MotionConfig>
    </Provider>
  )
}
