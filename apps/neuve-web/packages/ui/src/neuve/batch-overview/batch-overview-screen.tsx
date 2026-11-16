import { Provider, useStore } from "jotai"
import { useEffect } from "react"
import { useHydrateAtoms } from "jotai/utils"
import { MotionConfig } from "motion/react"

import { BatchHero } from "@workspace/ui/neuve/batch-overview/batch-hero"
import { SourceSheet } from "@workspace/ui/neuve/review-desk/source-sheet"
import { isSettled } from "@workspace/ui/neuve/batch-overview/decision-panel"
import { LaneBar } from "@workspace/ui/neuve/batch-overview/lane-bar"
import { UnitList } from "@workspace/ui/neuve/batch-overview/unit-list"
import { batchOverviewHydration } from "@workspace/ui/neuve/batch-overview/atoms"
import type { BatchOverviewState } from "@workspace/ui/neuve/batch-overview/atoms"
import {
  agentsHydration,
  agentRegistryAtom,
  agentConnectionsAtom,
  agentConnectorAtom,
} from "@workspace/ui/neuve/agents/atoms"
import type { AgentConnector } from "@workspace/ui/neuve/agents/atoms"
import type { StartReviewHandler } from "@workspace/ui/neuve/states/start-review"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import type { BatchOverviewData } from "@workspace/ui/neuve/types"

export interface BatchOverviewScreenProps {
  data: BatchOverviewData
  initialState?: Partial<BatchOverviewState>
  /** Connects agents from the header (a local mock by default). */
  agentConnector?: AgentConnector
  /** Opens the Agents popover (stories). */
  agentsOpen?: boolean
  /** What "Start a review" would review now, once the branch moved on. */
  start?: ReviewStart
  onStartReview?: StartReviewHandler
}

function BatchOverview({
  data,
  initialState = {},
  agentConnector,
  agentsOpen = false,
  start,
  onStartReview,
}: BatchOverviewScreenProps) {
  useHydrateAtoms(batchOverviewHydration(initialState))
  useHydrateAtoms(agentsHydration(data.agents, agentConnector, agentsOpen))
  const store = useStore()
  // Effect: synchronizes the external Jotai store with authoritative backend snapshots.
  useEffect(() => {
    if (!agentConnector?.authoritative) return
    store.set(agentRegistryAtom, data.agents)
    store.set(agentConnectionsAtom, data.agents.connections)
    store.set(agentConnectorAtom, agentConnector)
  }, [store, data.agents, agentConnector])
  // Once nothing waits, the decision panel holds the lane counts instead.
  const showLanes =
    !isSettled(data) && data.lanes.some((lane) => lane.count > 0)
  return (
    <div className="min-h-svh bg-paper font-sans text-sm text-ink">
      <AppHeader
        repo={data.repo}
        branch={data.branch}
        commit={data.revision.slice(0, 12)}
        batches={data.batches}
      />
      <main className="mx-auto box-border flex max-w-[1180px] content-fade flex-col gap-14 px-6 pt-14 pb-24">
        <div {...regionTransition("overview-hero", 1)}>
          <BatchHero data={data} start={start} onStartReview={onStartReview} />
        </div>
        {showLanes && (
          <div {...regionTransition("overview-lanes", 2)}>
            <LaneBar
              lanes={data.lanes}
              waiting={data.needYou}
              {...(data.notRead ? { notRead: data.notRead } : {})}
            />
          </div>
        )}
        <div {...regionTransition("overview-units", 3)}>
          <UnitList data={data} />
        </div>
        {data.contextualBriefing && (
          <div className="pointer-events-none fixed inset-0 z-40 [&>aside]:pointer-events-auto [&>div]:pointer-events-auto">
            <SourceSheet
              markers={data.contextualBriefing.markers}
              backLabel="Back to briefing"
            />
          </div>
        )}
      </main>
    </div>
  )
}

/**
 * Batch overview — the current review batch at a glance: the decision panel,
 * the batch digest, the lane split, and the units by lane with how many of
 * each unit's checkpoints are unmet.
 */
export function BatchOverviewScreen(props: BatchOverviewScreenProps) {
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        <BatchOverview {...props} />
      </MotionConfig>
    </Provider>
  )
}
