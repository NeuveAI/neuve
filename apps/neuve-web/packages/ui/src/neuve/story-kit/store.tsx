/**
 * Story kit, the one story store (stories only; never imported by product
 * code).
 *
 * Every story gets its own jotai store and MotionConfig, seeded with the
 * desk, overview and agent slices it names. The inline comment store is a
 * fresh in-memory repository per mounted story (never the reviewer's local
 * comments, and never shared with the story opened before it).
 */
import * as React from "react"
import { Provider } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { MotionConfig } from "motion/react"
import type { Decorator } from "@storybook/react-vite"

import { agentRegistryFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import { agentsHydration } from "@workspace/ui/neuve/agents/atoms"
import type { AgentConnector } from "@workspace/ui/neuve/agents/atoms"
import { batchOverviewHydration } from "@workspace/ui/neuve/batch-overview/atoms"
import type { BatchOverviewState } from "@workspace/ui/neuve/batch-overview/atoms"
import {
  commentRepositoryHydration,
  railHydration,
  reviewDeskHydration,
} from "@workspace/ui/neuve/review-desk/atoms"
import type { ReviewDeskState } from "@workspace/ui/neuve/review-desk/atoms"
import { createMemoryReviewCommentRepository } from "@workspace/ui/neuve/review-comments/repository"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type { ReviewCommentRepository } from "@workspace/ui/neuve/review-comments/repository"
import type {
  ReviewThread,
  ThreadEventSource,
} from "@workspace/ui/neuve/review-comments/thread"
import { threadsHydration } from "@workspace/ui/neuve/review-comments/threads"
import type { AgentRegistry } from "@workspace/ui/neuve/types"

/** Agent and thread extras a story can seed. */
export interface StoryExtras {
  threads?: ReadonlyArray<ReviewThread>
  threadEvents?: ThreadEventSource
  agents?: AgentRegistry
  agentConnector?: AgentConnector
  agentsOpen?: boolean
}

export interface StoryStore extends StoryExtras {
  /** Seeds the review desk's interaction state (and its comment store). */
  desk?: Partial<ReviewDeskState>
  /** Seeds the batch overview's state. */
  overview?: Partial<BatchOverviewState>
  /** Records the per-story memory comment store starts with. */
  comments?: ReadonlyArray<ReviewCommentRecord>
  /** A comment store to use instead of the fresh per-story one. */
  repository?: ReviewCommentRepository
}

/** A fresh in-memory comment store per mount, seeded with `comments`. */
export function useStoryRepository(
  comments?: ReadonlyArray<ReviewCommentRecord>,
  repository?: ReviewCommentRepository
) {
  return React.useMemo(
    () => repository ?? createMemoryReviewCommentRepository(comments),
    [comments, repository]
  )
}

function HydrateDesk({
  store,
  children,
}: {
  store: StoryStore
  children: React.ReactNode
}) {
  const desk = store.desk ?? {}
  const repository = useStoryRepository(store.comments, store.repository)
  useHydrateAtoms(reviewDeskHydration(desk))
  useHydrateAtoms(railHydration(desk))
  useHydrateAtoms(commentRepositoryHydration(repository))
  useHydrateAtoms(threadsHydration(store.threads, store.threadEvents))
  return children
}

function HydrateOverview({
  state,
  children,
}: {
  state: Partial<BatchOverviewState>
  children: React.ReactNode
}) {
  useHydrateAtoms(batchOverviewHydration(state))
  return children
}

function HydrateAgents({
  store,
  children,
}: {
  store: StoryStore
  children: React.ReactNode
}) {
  // Agent tags (rail, judgment rows, threads) read the registry.
  useHydrateAtoms(
    agentsHydration(
      store.agents ?? agentRegistryFixture,
      store.agentConnector,
      store.agentsOpen
    )
  )
  return children
}

/** The isolated store a story renders in, as a component. */
export function StoryStoreProvider({
  store,
  children,
}: {
  store: StoryStore
  children: React.ReactNode
}) {
  let content = <HydrateAgents store={store}>{children}</HydrateAgents>
  if (store.overview)
    content = (
      <HydrateOverview state={store.overview}>{content}</HydrateOverview>
    )
  if (store.desk || store.comments || store.repository || store.threads)
    content = <HydrateDesk store={store}>{content}</HydrateDesk>
  return (
    <Provider>
      <MotionConfig reducedMotion="user">{content}</MotionConfig>
    </Provider>
  )
}

/** Story decorator: one isolated store seeded with `store`. */
export function withStory(store: StoryStore = {}): Decorator {
  return (Story) => (
    <StoryStoreProvider store={store}>
      <Story />
    </StoryStoreProvider>
  )
}

/**
 * Review-desk store seeded with `state`; `repository` replaces the fresh
 * per-story comment store when given.
 */
export function withReviewDeskState(
  state: Partial<ReviewDeskState> = {},
  repository?: ReviewCommentRepository,
  extras: StoryExtras = {}
): Decorator {
  return withStory({ ...extras, desk: state, repository })
}

/** Batch-overview store seeded with `state`. */
export function withBatchOverviewState(
  state: Partial<BatchOverviewState> = {}
): Decorator {
  return withStory({ overview: state })
}
