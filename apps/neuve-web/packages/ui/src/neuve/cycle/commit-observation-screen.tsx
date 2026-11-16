import { Provider, useStore } from "jotai"
import { useEffect } from "react"
import { useHydrateAtoms } from "jotai/utils"
import { MotionConfig } from "motion/react"
import { ArrowLeftIcon } from "lucide-react"
import {
  agentsHydration,
  agentRegistryAtom,
  agentConnectionsAtom,
  agentConnectorAtom,
} from "@workspace/ui/neuve/agents/atoms"
import type { AgentConnector } from "@workspace/ui/neuve/agents/atoms"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import type { NeuveDestination } from "@workspace/ui/neuve/shared/nav-link"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import type { CommitLineageLoad } from "@workspace/ui/neuve/types"

type Load = Extract<CommitLineageLoad, { status: "observed" | "unavailable" }>
type Props = {
  load: Load
  back: NeuveDestination
  agentConnector?: AgentConnector
}
function Observation({ load, back, agentConnector }: Props) {
  const repo = load.status === "observed" ? load.commit.repo : load.batch.repo
  const branch =
    load.status === "observed" ? load.commit.branch : load.batch.branch
  const from =
    load.status === "observed" ? load.commit.from : load.batch.revision
  const to = load.status === "observed" ? load.commit.to : load.commit
  const agents = load.status === "observed" ? load.agents : load.batch.agents
  useHydrateAtoms(agentsHydration(agents, agentConnector))
  const store = useStore()
  // Effect: synchronizes the external Jotai store with authoritative backend snapshots.
  useEffect(() => {
    if (!agentConnector?.authoritative) return
    store.set(agentRegistryAtom, agents)
    store.set(agentConnectionsAtom, agents.connections)
    store.set(agentConnectorAtom, agentConnector)
  }, [store, agents, agentConnector])
  return (
    <div className="min-h-svh bg-paper font-sans text-sm text-ink">
      <AppHeader repo={repo} branch={branch} commit={to} />
      <main
        {...regionTransition("lineage", 1)}
        className="mx-auto box-border flex max-w-[1080px] content-fade flex-col gap-7 px-6 pt-8 pb-24"
      >
        <div className="flex flex-col gap-2">
          <NeuveLink
            destination={back}
            className="inline-flex h-[30px] items-center gap-1.5 self-start rounded-lg pr-2.5 pl-1.5 text-[12.5px] text-ink-muted no-underline hover:bg-raised"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            Back to {from.slice(0, 8)}
          </NeuveLink>
          <h1 className="m-0 text-[30px] leading-9 font-semibold tracking-[-0.03em]">
            {load.status === "observed"
              ? "What " + to.slice(0, 8) + " asks of you"
              : "Commit information unavailable"}
          </h1>
        </div>
        <section
          aria-label="Commit review status"
          className="flex flex-col gap-3 rounded-xl bg-surface p-5 shadow-[0_0_0_1px_var(--nv-line)]"
        >
          <h2 className="m-0 text-lg font-semibold">
            {load.status === "observed"
              ? "Review assessment pending"
              : "Observation unavailable"}
          </h2>
          <p className="m-0 leading-6 text-ink-2">
            {load.status === "observed"
              ? "The submitted branch points to this commit. A recorded review assessment and unit relationships are needed to show which units require decisions for it."
              : load.reason}
          </p>
          <p className="m-0 text-sm text-ink-muted">
            Your current review stays on {from.slice(0, 8)}.
          </p>
          {load.status === "observed" && (
            <p className="m-0 font-mono text-xs text-ink-muted">
              Observed from {branch} · {load.commit.observedAt}
            </p>
          )}
        </section>
      </main>
    </div>
  )
}
export function CommitObservationScreen(props: Props) {
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        <Observation {...props} />
      </MotionConfig>
    </Provider>
  )
}
