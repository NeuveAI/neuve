import { AccountStore, type AccountStatus } from "@neuve/runtime"

/** The full set now, then the full set on each change. */
export interface AccountStatusSource {
  current(): readonly AccountStatus[]
  subscribe(listener: (statuses: readonly AccountStatus[]) => void): () => void
}

const empty: AccountStatusSource = {
  current: () => [],
  subscribe: () => () => {},
}
let source: AccountStatusSource | undefined
let latest: readonly AccountStatus[] = []
let warned = false
const listeners = new Set<(statuses: readonly AccountStatus[]) => void>()
let unsubscribe: (() => void) | undefined

function accountSource(): AccountStatusSource {
  const home = process.env.HOME
  // Bun sets NODE_ENV=test; imports and existing stream tests must never use the person's store.
  return (source ??=
    home && process.env.NODE_ENV !== "test"
      ? AccountStore.statusSource(home)
      : empty)
}

function failed(error: unknown) {
  if (!(error instanceof AccountStore.StoreError)) throw error
  if (!warned) console.warn("[accounts]", error.message)
  warned = true
}

export function currentAccounts(): AccountStatus[] {
  try {
    latest = accountSource().current()
    warned = false
  } catch (error) {
    failed(error)
  }
  ensureListening()
  return [...latest]
}

function changed(statuses: readonly AccountStatus[]) {
  for (const listener of listeners) listener(statuses)
}

function listen(): (() => void) | undefined {
  let subscribing = true
  try {
    return accountSource().subscribe((statuses) => {
      latest = statuses
      warned = false
      if (!subscribing) changed(statuses)
    })
  } catch (error) {
    failed(error)
  } finally {
    subscribing = false
  }
}

function ensureListening() {
  if (!listeners.size || unsubscribe) return
  unsubscribe = listen()
  if (unsubscribe) changed(latest)
}

export function setAccountStatusSource(next: AccountStatusSource) {
  unsubscribe?.()
  unsubscribe = undefined
  source = next
  latest = []
  warned = false
  changed(currentAccounts())
}

/** One source subscription shared by the open tabs, released by the last tab. */
export function subscribeAccounts(
  listener: (statuses: readonly AccountStatus[]) => void
): () => void {
  let previous: string | undefined
  const send = (statuses: readonly AccountStatus[]) => {
    const snapshot = JSON.stringify(statuses)
    if (snapshot === previous) return
    previous = snapshot
    listener(statuses)
  }
  listeners.add(send)
  send(currentAccounts())
  return () => {
    listeners.delete(send)
    if (listeners.size) return
    unsubscribe?.()
    unsubscribe = undefined
  }
}
