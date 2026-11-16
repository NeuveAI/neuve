import { AccountStore, type AccountStatus } from "@neuve/runtime";
import { config } from "./host-config";

/** The full set now, then the full set on each change. */
export interface AccountStatusSource {
  current(): readonly AccountStatus[];
  subscribe(listener: (statuses: readonly AccountStatus[]) => void): () => void;
}

const empty: AccountStatusSource = {
  current: () => [],
  subscribe: () => () => {},
};
let source: AccountStatusSource | undefined;
let latest: readonly AccountStatus[] = [];
let warned = false;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
const sent = new WeakMap<object, string>();

function accountSource(): AccountStatusSource {
  const home = (config.environment ?? process.env).HOME;
  // Some host tests inherit HOME; Bun's test mode must still keep them off the person's store.
  return (source ??=
    home && process.env.NODE_ENV !== "test"
      ? AccountStore.statusSource(home)
      : empty);
}

function failed(error: unknown) {
  if (!(error instanceof AccountStore.StoreError)) throw error;
  if (!warned) console.warn("[accounts]", error.message);
  warned = true;
}

function current(): readonly AccountStatus[] {
  try {
    latest = accountSource().current();
    warned = false;
  } catch (error) {
    failed(error);
  }
  ensureListening();
  return latest;
}

function changed() {
  for (const listener of listeners) listener();
}

function listen(): (() => void) | undefined {
  let subscribing = true;
  try {
    return accountSource().subscribe((statuses) => {
      latest = statuses;
      warned = false;
      if (!subscribing) changed();
    });
  } catch (error) {
    failed(error);
  } finally {
    subscribing = false;
  }
}

function ensureListening() {
  if (!listeners.size || unsubscribe) return;
  unsubscribe = listen();
  if (unsubscribe) changed();
}

export function setAccountStatusSource(next: AccountStatusSource) {
  unsubscribe?.();
  unsubscribe = undefined;
  source = next;
  latest = [];
  warned = false;
  current();
  changed();
}

export function frame(): { accounts: AccountStatus[] } {
  return { accounts: [...current()] };
}

/** Each local socket gets its current set once, including after acquisition recovers. */
export function send(socket: { send(data: string): unknown }): void {
  const message = JSON.stringify(frame());
  if (sent.get(socket) === message) return;
  socket.send(message);
  sent.set(socket, message);
}

export function onChange(listener: () => void): () => void {
  listeners.add(listener);
  ensureListening();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    unsubscribe?.();
    unsubscribe = undefined;
  };
}
