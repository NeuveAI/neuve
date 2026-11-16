/** This entry point also runs in browsers. Platform transports are supplied by callers. */
export type SharedOutcome<A, E> =
  | { readonly kind: "succeeded"; readonly value: A }
  | { readonly kind: "failed"; readonly error: E };
export interface PublishedSharedOutcome<A, E> {
  readonly publication: string;
  readonly outcome: SharedOutcome<A, E>;
}
export type SharedExecutionOutcome<A, E> =
  SharedOutcome<A, E> | PublishedSharedOutcome<A, E>;
export type SharedFloor = "unreachable" | "old-host" | "host-changed";
export interface SharedResult<A, E> {
  readonly outcome: SharedOutcome<A, E>;
  readonly floor?: SharedFloor;
}
export type SharedRole = "holder" | "waiter" | "takeover" | "held" | "floor";
export interface SharedWorkEvent {
  readonly role: SharedRole;
  readonly floor?: SharedFloor;
}
export type ClaimEvent =
  | {
      readonly kind: "claimed";
      readonly takeover: boolean;
      readonly waiters: number;
      readonly declaring: boolean;
    }
  | { readonly kind: "waiting" }
  | { readonly kind: "held" }
  | { readonly kind: "withdrawn" }
  | {
      readonly kind: "waiters" | "retained";
      readonly count: number;
      readonly declaring: boolean;
    }
  | {
      readonly kind: "done";
      readonly outcome: "succeeded" | "failed";
      readonly publication: string;
    }
  | { readonly kind: "lost" };
export interface SharedClaim {
  next(): Promise<ClaimEvent>;
  withdraw(): void;
  settle(outcome: "succeeded" | "failed", publication: string): Promise<void>;
  close(): void;
}
export interface SharedWorkTransport {
  claim(input: {
    readonly store: string;
    readonly key: string;
    readonly insideGrant: boolean;
    readonly redeclare: boolean;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly kind: "connected"; readonly claim: SharedClaim }
    | { readonly kind: "floor"; readonly reason: SharedFloor }
  >;
  /** The budget supplies its existing recovery path. Only workers may elect. */
  recover?(): Promise<void>;
}
export class KeyHeld extends Error {
  readonly _tag = "KeyHeld";
  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super("Shared work key is held");
  }
}
export class SharedPublicationMissing extends Error {
  readonly _tag = "SharedPublicationMissing";
  constructor() {
    super("Shared work was settled without a stored outcome");
  }
}
export type SharedWorkOptions<A, E> = {
  readonly scope: string;
  readonly key: string;
  readonly signal?: AbortSignal;
  readonly insideGrant?: boolean;
  readonly keepRunning?: boolean;
  readonly onTakeover?: (signal: AbortSignal) => Promise<void>;
  readonly onEvent?: (event: SharedWorkEvent) => void;
} & (
  | {
      readonly crossProcess?: undefined;
      readonly run: (signal: AbortSignal) => Promise<SharedOutcome<A, E>>;
    }
  | {
      /** Resolve only after atomic publication; reject if publication fails. */
      readonly run: (
        signal: AbortSignal,
      ) => Promise<PublishedSharedOutcome<A, E>>;
      readonly crossProcess: {
        /** Opt-in readers may resolve a host-loss publication to its recorded delivery failure. */
        readonly acceptDeliveryFailure?: boolean;
        /** Local warm values are returned before claiming, or published after a grant. */
        readonly local?: {
          readonly read: () => Promise<{ readonly value: A } | undefined>;
          readonly publish: (
            value: A,
            signal: AbortSignal,
          ) => Promise<PublishedSharedOutcome<A, E>>;
        };
        readonly store: string;
        readonly transport: SharedWorkTransport;
        readonly read: (
          publication?: string,
        ) => Promise<PublishedSharedOutcome<A, E> | undefined>;
      };
    }
);
type Subscriber<A, E> = {
  resolve(result: SharedResult<A, E>): void;
  reject(cause: unknown): void;
  cleanup(): void;
  event(event: SharedWorkEvent): void;
};
type Lifecycle =
  | { readonly kind: "running" }
  | {
      readonly kind: "withdrawing" | "stopping";
      readonly queued: Set<() => void>;
    }
  | { readonly kind: "ended" };
type Entry<A, E> = {
  readonly controller: AbortController;
  readonly subscribers: Set<Subscriber<A, E>>;
  keepRunning: boolean;
  /** Prior demand is a lower bound until the host's re-declaration window closes. */
  remote: number;
  declaring: boolean;
  lifecycle: Lifecycle;
  connecting: boolean;
  role: SharedWorkEvent | undefined;
  claim: SharedClaim | undefined;
};

/** One instance per result type; scopes and keys partition its active runs. No completed cache. */
export class SharedWork<A, E = never> {
  private readonly scopes = new Map<string, Map<string, Entry<A, E>>>();

  run(options: SharedWorkOptions<A, E>): Promise<SharedResult<A, E>> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    let keys = this.scopes.get(options.scope);
    if (!keys) this.scopes.set(options.scope, (keys = new Map()));
    let entry = keys.get(options.key);
    const existing = entry !== undefined;
    if (entry && options.insideGrant) {
      options.onEvent?.({ role: "held" });
      return Promise.reject(new KeyHeld(options.scope, options.key));
    }
    // Cancellation belongs to the old subscribers. Re-enter only when safe to join.
    if (
      entry?.lifecycle.kind === "withdrawing" ||
      entry?.lifecycle.kind === "stopping"
    ) {
      const queued = entry.lifecycle.queued;
      return new Promise((resolve, reject) => {
        const retry = () => {
          queued.delete(retry);
          options.signal?.removeEventListener("abort", abort);
          resolve(this.run(options));
        };
        const abort = () => {
          queued.delete(retry);
          options.signal?.removeEventListener("abort", abort);
          reject(options.signal?.reason);
        };
        queued.add(retry);
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (!entry) {
      entry = {
        controller: new AbortController(),
        subscribers: new Set(),
        keepRunning: options.keepRunning ?? false,
        remote: 0,
        declaring: false,
        lifecycle: { kind: "running" },
        connecting: options.crossProcess !== undefined,
        role: undefined,
        claim: undefined,
      };
      keys.set(options.key, entry);
    }
    const current = entry;
    current.keepRunning ||= options.keepRunning ?? false;
    const result = new Promise<SharedResult<A, E>>((resolve, reject) => {
      const subscriber: Subscriber<A, E> = {
        resolve,
        reject,
        cleanup: () => options.signal?.removeEventListener("abort", abort),
        event: (event) => options.onEvent?.(event),
      };
      const abort = () => {
        if (!current.subscribers.delete(subscriber)) return;
        subscriber.cleanup();
        reject(options.signal?.reason);
        this.cancelUnused(current);
      };
      current.subscribers.add(subscriber);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (existing) {
        subscriber.event(
          current.role?.floor
            ? { role: "floor", floor: current.role.floor }
            : { role: "waiter" },
        );
      }
    });
    if (!existing) {
      const finish = () => {
        if (keys.get(options.key) === current) keys.delete(options.key);
        if (keys.size === 0) this.scopes.delete(options.scope);
        for (const subscriber of current.subscribers) subscriber.cleanup();
        this.transition(current, "ended");
      };
      void Promise.resolve()
        .then(() => this.execute(options, current))
        .then(
          (value) => {
            finish();
            for (const s of current.subscribers) s.resolve(value);
          },
          (cause: unknown) => {
            finish();
            for (const s of current.subscribers) s.reject(cause);
          },
        );
    }
    return result;
  }

  private transition(entry: Entry<A, E>, next: Lifecycle["kind"]) {
    const previous = entry.lifecycle;
    switch (next) {
      case "running":
        // Retained remote demand or host loss can revoke an unacknowledged withdrawal.
        if (previous.kind !== "withdrawing") return;
        entry.lifecycle = { kind: "running" };
        for (const retry of previous.queued) retry();
        break;
      case "withdrawing":
        if (previous.kind !== "running") return;
        entry.lifecycle = { kind: "withdrawing", queued: new Set() };
        entry.claim?.withdraw();
        break;
      case "stopping":
        if (previous.kind !== "running" && previous.kind !== "withdrawing")
          return;
        entry.lifecycle = {
          kind: "stopping",
          queued: previous.kind === "withdrawing" ? previous.queued : new Set(),
        };
        entry.controller.abort();
        break;
      case "ended":
        if (previous.kind === "ended") return;
        entry.lifecycle = { kind: "ended" };
        entry.claim?.close();
        if (previous.kind !== "running")
          for (const retry of previous.queued) retry();
        break;
      default: {
        const exhaustive: never = next;
        return exhaustive;
      }
    }
  }

  private cancelUnused(entry: Entry<A, E>) {
    if (
      !entry.subscribers.size &&
      !entry.remote &&
      !entry.keepRunning &&
      !entry.connecting &&
      entry.lifecycle.kind === "running"
    ) {
      if (
        entry.claim &&
        (entry.role?.role === "holder" || entry.role?.role === "takeover")
      ) {
        if (!entry.declaring) {
          this.transition(entry, "withdrawing");
        }
        return;
      }
      this.transition(entry, "stopping");
      entry.claim?.close();
    }
  }

  private async execute(
    options: SharedWorkOptions<A, E>,
    entry: Entry<A, E>,
  ): Promise<SharedResult<A, E>> {
    const signal = entry.controller.signal;
    const event = (value: SharedWorkEvent) => {
      entry.role = value;
      for (const subscriber of entry.subscribers) subscriber.event(value);
    };
    let floor: SharedFloor | undefined;
    const atFloor = (reason: SharedFloor) => {
      floor = reason;
      event({ role: "floor", floor: reason });
      console.warn(
        JSON.stringify({
          type: "shared-work.floor",
          floor: reason,
          message: "work may have been duplicated",
        }),
      );
    };
    const cross = options.crossProcess;
    const compute = async (takeover: boolean): Promise<SharedResult<A, E>> => {
      signal.throwIfAborted();
      if (takeover) await options.onTakeover?.(signal);
      const local = cross?.local ? await cross.local.read() : undefined;
      if (local && floor && !entry.claim)
        return {
          outcome: { kind: "succeeded", value: local.value },
          floor,
        };
      const completed =
        local && cross?.local
          ? await cross.local.publish(local.value, signal)
          : await options.run(signal);
      const outcome =
        "publication" in completed ? completed.outcome : completed;
      if (cross && !("publication" in completed))
        throw new SharedPublicationMissing();
      if (!cross) signal.throwIfAborted();
      await recovering;
      if ("publication" in completed)
        await entry.claim?.settle(outcome.kind, completed.publication);
      await recovering;
      return { outcome, ...(floor ? { floor } : {}) };
    };
    let recovering: Promise<void> | undefined;
    if (!cross) {
      entry.connecting = false;
      event({ role: "holder" });
      this.cancelUnused(entry);
      return compute(false);
    }
    const read = (publication?: string) => cross.read(publication);
    const local = cross.local ? await cross.local.read() : undefined;
    if (local) {
      event({ role: "waiter" });
      return { outcome: { kind: "succeeded", value: local.value } };
    }
    const stored = await read();
    if (stored) {
      event({ role: "waiter" });
      return { outcome: stored.outcome };
    }
    const connect = async (redeclare: boolean) => {
      const opened = await cross.transport.claim({
        store: cross.store,
        key: options.key,
        insideGrant: options.insideGrant ?? false,
        redeclare,
        signal,
      });
      if (opened.kind === "floor") {
        entry.claim = undefined;
        atFloor(opened.reason);
      } else entry.claim = opened.claim;
      if (!entry.claim) {
        entry.connecting = false;
        this.cancelUnused(entry);
      }
    };
    await connect(false);
    let holder = false,
      waited = false,
      finished = false;
    const watch = async (): Promise<SharedResult<A, E> | undefined> => {
      while (!finished && entry.claim) {
        const claim = entry.claim;
        const message = await claim.next();
        if (finished) return;
        switch (message.kind) {
          case "held":
            if (holder) {
              claim.close();
              entry.claim = undefined;
              entry.connecting = false;
              atFloor("host-changed");
              return;
            }
            event({ role: "held" });
            throw new KeyHeld(options.scope, options.key);
          case "waiting":
            if (holder) {
              claim.close();
              entry.claim = undefined;
              entry.connecting = false;
              atFloor("host-changed");
              return;
            }
            entry.connecting = false;
            waited = true;
            event({ role: "waiter" });
            this.cancelUnused(entry);
            break;
          case "retained":
          case "waiters":
            entry.declaring = message.declaring;
            entry.remote = message.declaring
              ? Math.max(entry.remote, message.count)
              : message.count;
            if (message.kind === "retained") this.transition(entry, "running");
            this.cancelUnused(entry);
            break;
          case "claimed":
            entry.connecting = false;
            entry.declaring = message.declaring;
            entry.remote = message.declaring
              ? Math.max(entry.remote, message.waiters)
              : message.waiters;
            if (!holder) {
              holder = true;
              // A replacement host cannot know which holder this caller waited on.
              const takeover = message.takeover || waited;
              event({ role: takeover ? "takeover" : "holder" });
              this.cancelUnused(entry);
              // A publication can commit between the pre-claim read and this grant.
              const result = await read();
              if (result) {
                const published =
                  cross.local && result.outcome.kind === "succeeded"
                    ? await cross.local.publish(result.outcome.value, signal)
                    : result;
                await claim.settle(
                  published.outcome.kind,
                  published.publication,
                );
                return { outcome: published.outcome };
              }
              // Keep consuming waiter-count and host-loss pushes while work runs.
              const monitoring = watch();
              void monitoring.catch(() => {});
              try {
                return await compute(takeover);
              } finally {
                finished = true;
                entry.claim?.close();
                await recovering;
                entry.claim?.close();
                await monitoring;
              }
            }
            break;
          case "withdrawn":
            this.transition(entry, "stopping");
            break;
          case "done": {
            if (holder) return;
            const result = await read(message.publication);
            if (
              !result ||
              result.publication !== message.publication ||
              (result.outcome.kind !== message.outcome &&
                !(
                  cross.acceptDeliveryFailure &&
                  result.outcome.kind === "failed"
                ))
            )
              throw new SharedPublicationMissing();
            return { outcome: result.outcome };
          }
          case "lost": {
            if (signal.aborted) return;
            claim.close();
            entry.claim = undefined;
            entry.connecting = true;
            this.transition(entry, "running");
            if (holder) {
              recovering = (async () => {
                try {
                  await cross.transport.recover?.();
                } catch {
                  /* Floor is determined by the connection. */
                }
                await connect(true);
              })();
              await recovering;
            } else {
              const result = await read();
              if (result) return { outcome: result.outcome };
              try {
                await cross.transport.recover?.();
              } catch {
                /* Clients never elect. */
              }
              await connect(false);
            }
            break;
          }
        }
      }
      return undefined;
    };
    try {
      const result = await watch();
      if (result) return result;
      if (!holder) return await compute(false);
      throw new SharedPublicationMissing();
    } finally {
      finished = true;
      entry.claim?.close();
    }
  }
}
