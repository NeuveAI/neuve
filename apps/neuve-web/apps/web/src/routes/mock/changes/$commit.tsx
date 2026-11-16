import { createFileRoute, notFound } from "@tanstack/react-router"

import {
  REVIEWER,
  REVIEW_UNIT_ID,
  agentRegistryFixture,
  commitLineageFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { LineageSkeleton } from "@workspace/ui/neuve/states/skeletons"
import { LineagePage } from "@workspace/ui/neuve/states/pages"
import type { CommitLineageLoad } from "@workspace/ui/neuve/types"

import {
  NotFoundEmpty,
  UnknownCommitEmpty,
} from "@workspace/ui/neuve/states/empty-states"

import { isUnknownCommit } from "@/components/commit-id"
import type { UnknownCommitData } from "@/components/commit-id"
import { PENDING, RouteError } from "@/components/route-states"
import {
  mockDelay,
  ssrUnlessDelayed,
  validateMockSearch,
} from "@/mock/mock-search"

/** Sample commit lineage (fixtures). `?delay=ms`, `?state=empty`. */
export const Route = createFileRoute("/mock/changes/$commit")({
  validateSearch: validateMockSearch,
  loaderDeps: ({ search }) => search,
  ssr: ssrUnlessDelayed,
  loader: async ({
    params,
    deps,
    abortController,
  }): Promise<CommitLineageLoad> => {
    await mockDelay(deps.delay, abortController.signal)
    if (deps.state) return { status: "empty", reason: "no-batch" }
    if (params.commit !== commitLineageFixture.to) {
      const data: UnknownCommitData = {
        reason: "unknown-commit",
        commit: params.commit,
      }
      throw notFound({ data })
    }
    return {
      status: "ready",
      lineage: commitLineageFixture,
      agents: agentRegistryFixture,
      reviewer: REVIEWER,
    }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `What ${loaderData?.status === "ready" ? loaderData.lineage.to : "the new commit"} asks of you (sample) · Neuve`,
      },
    ],
  }),
  ...PENDING,
  pendingComponent: LineageSkeleton,
  notFoundComponent: MockCommitNotFound,
  errorComponent: RouteError,
  component: MockChangesRoute,
})

function MockCommitNotFound({ data }: { data?: unknown }) {
  if (isUnknownCommit(data))
    return (
      <UnknownCommitEmpty commit={data.commit} candidates={data.candidates} />
    )
  return <NotFoundEmpty />
}

function MockChangesRoute() {
  return (
    <LineagePage
      load={Route.useLoaderData()}
      back={{ to: "unit", unitId: REVIEW_UNIT_ID }}
    />
  )
}
