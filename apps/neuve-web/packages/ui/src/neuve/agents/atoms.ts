import { atom } from "jotai"

import type {
  AgentConnection,
  AgentRegistry,
  BranchAgent,
} from "@workspace/ui/neuve/types"

/**
 * Agents on the branch: the registry (typed data in, never edited here) and
 * live connection status (jotai).
 *
 * Neuve owns roles, scopes and routing; the ACP connection carries none of
 * them. Connect picks a harness from the server-side registry by id — the
 * browser never supplies a command. There are no real ACP calls yet: the
 * connector is injectable and the default one is a local mock.
 *
 *   disconnected ── Connect (pick a configured agent) ──▶ connecting ──▶ connected
 *   connected ── Disconnect (warns: context lost, thread history stays) ──▶ disconnected
 */

export interface AgentConnector {
  authoritative?: boolean
  connect: (agentId: string, harnessId: string) => Promise<AgentConnection>
  disconnect: (agentId: string) => Promise<void>
}

const MOCK_CONNECT_MS = 1400

/** Local stand-in for the BFF's ACP connector. */
export const mockAgentConnector: AgentConnector = {
  connect: (_agentId, harnessId) =>
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ status: "connected", harnessId, activity: "Idle" }),
        MOCK_CONNECT_MS
      )
    ),
  disconnect: () => Promise.resolve(),
}

/** A connector that never finishes connecting (stories of that state). */
export const pendingAgentConnector: AgentConnector = {
  connect: () => new Promise(() => {}),
  disconnect: () => Promise.resolve(),
}

const EMPTY_REGISTRY: AgentRegistry = {
  agents: [],
  configured: [],
  connections: {},
}

export const agentRegistryAtom = atom<AgentRegistry>(EMPTY_REGISTRY)
export const agentConnectionsAtom = atom<Record<string, AgentConnection>>({})
const connectionAttemptsAtom = atom<Record<string, string>>({})
export const agentConnectorAtom = atom<AgentConnector>(mockAgentConnector)

/** The Agents popover. */
export const agentsOpenAtom = atom(false)
/** The agent whose Connect picker is open. */
export const connectPickerAtom = atom<string | null>(null)
/** The agent whose Disconnect warning is showing. */
export const confirmDisconnectAtom = atom<string | null>(null)

export function agentsHydration(
  registry: AgentRegistry,
  connector?: AgentConnector,
  open = false
) {
  return [
    [agentRegistryAtom, registry],
    [agentConnectionsAtom, registry.connections],
    [agentConnectorAtom, connector ?? mockAgentConnector],
    [agentsOpenAtom, open],
  ] as const
}

export function connectionOf(
  connections: Record<string, AgentConnection>,
  agentId: string
): AgentConnection {
  return connections[agentId] ?? { status: "disconnected" }
}

export const liveCountAtom = atom((get) => {
  const connections = get(agentConnectionsAtom)
  return get(agentRegistryAtom).agents.filter(
    (agent) => connectionOf(connections, agent.id).status === "connected"
  ).length
})

export const agentByIdAtom = atom((get) => {
  const byId: Record<string, BranchAgent> = {}
  for (const agent of get(agentRegistryAtom).agents) byId[agent.id] = agent
  return byId
})

function setConnection(
  connections: Record<string, AgentConnection>,
  agentId: string,
  next: AgentConnection
) {
  return { ...connections, [agentId]: next }
}

/** Connect an agent with a configured harness (by id only). */
export const connectAgentAtom = atom(
  null,
  async (get, set, agentId: string, harnessId: string) => {
    const configured = get(agentRegistryAtom).configured
    if (!configured.some((entry) => entry.id === harnessId)) return
    const attemptId = crypto.randomUUID()
    set(connectionAttemptsAtom, {
      ...get(connectionAttemptsAtom),
      [agentId]: attemptId,
    })
    set(connectPickerAtom, null)
    set(
      agentConnectionsAtom,
      setConnection(get(agentConnectionsAtom), agentId, {
        status: "connecting",
        harnessId,
      })
    )
    try {
      const connection = await get(agentConnectorAtom).connect(
        agentId,
        harnessId
      )
      if (get(connectionAttemptsAtom)[agentId] !== attemptId) return
      set(
        agentConnectionsAtom,
        setConnection(get(agentConnectionsAtom), agentId, connection)
      )
    } catch (cause) {
      if (get(connectionAttemptsAtom)[agentId] !== attemptId) return
      set(
        agentConnectionsAtom,
        setConnection(get(agentConnectionsAtom), agentId, {
          ...connectionOf(get(agentConnectionsAtom), agentId),
          detail:
            cause instanceof Error && cause.message
              ? cause.message
              : "Could not confirm the agent connection",
        })
      )
    }
  }
)

/** After the warning: the agent's context is lost, its threads stay. */
export const disconnectAgentAtom = atom(
  null,
  async (get, set, agentId: string) => {
    set(confirmDisconnectAtom, null)
    if (
      connectionOf(get(agentConnectionsAtom), agentId).status === "connecting"
    )
      return
    const attemptId = crypto.randomUUID()
    set(connectionAttemptsAtom, {
      ...get(connectionAttemptsAtom),
      [agentId]: attemptId,
    })
    try {
      await get(agentConnectorAtom).disconnect(agentId)
      if (get(connectionAttemptsAtom)[agentId] !== attemptId) return
      set(
        agentConnectionsAtom,
        setConnection(get(agentConnectionsAtom), agentId, {
          status: "disconnected",
        })
      )
    } catch (cause) {
      // Retain the connection until the server confirms it was closed.
      const previous = connectionOf(get(agentConnectionsAtom), agentId)
      if (get(connectionAttemptsAtom)[agentId] === attemptId)
        set(
          agentConnectionsAtom,
          setConnection(get(agentConnectionsAtom), agentId, {
            ...previous,
            detail:
              cause instanceof Error && cause.message
                ? cause.message
                : "Disconnect failed",
          })
        )
    }
  }
)
