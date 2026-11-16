import type {
  SharedWorkMessage,
  SharedWorkReply,
} from "./shared-work-protocol.ts";
import { randomUUID } from "node:crypto";

type Connection = {
  readonly destroyed: boolean;
  write(line: string): unknown;
  end(line: string): unknown;
};
type Claim = {
  holder: Connection | undefined;
  readonly waiters: Set<Connection>;
};
/** Connection ownership and arrival order only. The scheduler is not involved. */
export class SharedWorkHost {
  readonly hostId = randomUUID();
  private readonly deliveryClients = new WeakSet<Connection>();
  private readonly deliveries = new Map<
    Connection,
    { key: string; publication: string }
  >();
  private readonly keys = new Map<string, Claim>();
  private readonly connections = new Map<
    Connection,
    { key: string; claim: Claim }
  >();
  private declaring = true;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly declaration = Promise.withResolvers<void>();
  readonly ready = this.declaration.promise;

  constructor(redeclaring = true) {
    this.declaring = redeclaring;
    if (!redeclaring) this.declaration.resolve();
    this.timer = setTimeout(
      () => {
        this.declaring = false;
        for (const [key, claim] of this.keys) {
          if (!claim.holder) this.promote(key, claim, false);
          else this.count(claim);
        }
        this.declaration.resolve();
      },
      redeclaring ? 5000 : 0,
    );
    this.timer.unref?.();
  }
  get size() {
    return this.connections.size + this.deliveries.size;
  }
  has(connection: Connection) {
    return this.connections.has(connection) || this.deliveries.has(connection);
  }
  private send(connection: Connection, reply: SharedWorkReply, end = false) {
    if (connection.destroyed) return;
    const advertised =
      this.deliveryClients.has(connection) &&
      (reply.kind === "claimed" ||
        reply.kind === "waiting" ||
        reply.kind === "held" ||
        reply.kind === "done")
        ? { ...reply, host: this.hostId }
        : reply;
    const line = `${JSON.stringify(advertised)}\n`;
    if (end) connection.end(line);
    else connection.write(line);
  }
  private count(claim: Claim) {
    if (claim.holder)
      this.send(claim.holder, {
        kind: "waiters",
        count: claim.waiters.size,
        declaring: this.declaring,
      });
  }
  private promote(key: string, claim: Claim, takeover: boolean) {
    for (const next of claim.waiters) {
      claim.waiters.delete(next);
      if (next.destroyed) {
        this.connections.delete(next);
        continue;
      }
      claim.holder = next;
      this.send(next, {
        kind: "claimed",
        takeover,
        waiters: claim.waiters.size,
        declaring: this.declaring,
      });
      return;
    }
    this.keys.delete(key);
  }
  message(connection: Connection, message: SharedWorkMessage) {
    if (message.kind === "delivery") {
      void this.ready.then(() => {
        const key = JSON.stringify([message.store, message.key]);
        this.send(
          connection,
          {
            kind: "delivery",
            host: this.hostId,
            claimed: this.keys.has(key),
            unread: [...this.deliveries.values()].some(
              (value) =>
                value.key === key &&
                (message.publication === undefined ||
                  value.publication === message.publication),
            ),
          },
          true,
        );
      });
      return;
    }
    if (message.kind === "ownership") {
      void this.ready.then(() =>
        this.send(
          connection,
          {
            kind: "ownership",
            live: this.keys.has(JSON.stringify([message.store, message.key])),
          },
          true,
        ),
      );
      return;
    }
    if (message.kind === "withdraw") {
      const owned = this.connections.get(connection);
      if (!owned || owned.claim.holder !== connection)
        throw new Error("Only a claim holder may withdraw");
      if (this.declaring || owned.claim.waiters.size) {
        this.send(connection, {
          kind: "retained",
          count: owned.claim.waiters.size,
          declaring: this.declaring,
        });
      } else {
        this.send(connection, { kind: "withdrawn" });
      }
      return;
    }
    if (message.kind === "settle") {
      const owned = this.connections.get(connection);
      if (!owned || owned.claim.holder !== connection)
        throw new Error("Only a claim holder may settle");
      this.keys.delete(owned.key);
      this.connections.delete(connection);
      for (const waiter of owned.claim.waiters) {
        this.connections.delete(waiter);
        const acknowledging = this.deliveryClients.has(waiter);
        if (acknowledging)
          this.deliveries.set(waiter, {
            key: owned.key,
            publication: message.publication,
          });
        this.send(
          waiter,
          {
            kind: "done",
            outcome: message.outcome,
            publication: message.publication,
          },
          !acknowledging,
        );
      }
      owned.claim.waiters.clear();
      // Acknowledgement makes publication completion observable before client cleanup.
      this.send(
        connection,
        {
          kind: "done",
          outcome: message.outcome,
          publication: message.publication,
        },
        true,
      );
      return;
    }
    if (this.connections.has(connection))
      throw new Error("One claim per connection");
    if (message.deliveryAcknowledgement) this.deliveryClients.add(connection);
    const key = JSON.stringify([message.store, message.key]);
    let claim = this.keys.get(key);
    if (
      message.insideGrant &&
      (claim || (this.declaring && !message.redeclare))
    ) {
      this.send(connection, { kind: "held" }, true);
      return;
    }
    if (!claim) {
      claim = { holder: undefined, waiters: new Set() };
      this.keys.set(key, claim);
    }
    this.connections.set(connection, { key, claim });
    if (!claim.holder && (!this.declaring || message.redeclare)) {
      claim.holder = connection;
      this.send(connection, {
        kind: "claimed",
        takeover: false,
        waiters: claim.waiters.size,
        declaring: this.declaring,
      });
    } else {
      claim.waiters.add(connection);
      this.count(claim);
      this.send(connection, { kind: "waiting" });
    }
  }
  disconnected(connection: Connection) {
    this.deliveries.delete(connection);
    const owned = this.connections.get(connection);
    if (!owned) return;
    this.connections.delete(connection);
    if (owned.claim.holder === connection) {
      owned.claim.holder = undefined;
      this.promote(owned.key, owned.claim, true);
    } else {
      owned.claim.waiters.delete(connection);
      this.count(owned.claim);
      if (!owned.claim.holder && !owned.claim.waiters.size)
        this.keys.delete(owned.key);
    }
  }
  close() {
    clearTimeout(this.timer);
    this.connections.clear();
    this.deliveries.clear();
    this.keys.clear();
  }
}
