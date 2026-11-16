import { createHash } from "node:crypto";
import { SharedWorkHost } from "@neuve/records-core/shared-work-host";
import {
  SharedWorkMessage,
  SharedWorkReply,
} from "@neuve/records-core/shared-work-protocol";
import type {
  SharedWorkTransport,
  ClaimEvent,
} from "@neuve/records-core/shared-work";
import type { sharedWorkOwnership } from "@neuve/records-core/shared-work-socket";

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/** Only the socket is replaced. The real authority owns claims, delivery acknowledgements and pushed replies. */
export const publicationHost = (directory: string) => {
  let host = new SharedWorkHost(false);
  const transport: SharedWorkTransport = {
    claim: async (request) => {
      const queue: ClaimEvent[] = [];
      let receive: ((event: ClaimEvent) => void) | undefined;
      const settled = Promise.withResolvers<void>();
      const push = (event: ClaimEvent) => {
        if (receive) {
          const pending = receive;
          receive = undefined;
          pending(event);
        } else queue.push(event);
      };
      const connection = {
        destroyed: false,
        write(line: string) {
          const reply = SharedWorkReply.parse(JSON.parse(line));
          if (
            reply.kind === "ownership" ||
            reply.kind === "delivery" ||
            reply.kind === "error"
          )
            throw new Error("Unexpected claim reply");
          if (reply.kind === "done") settled.resolve();
          push(reply);
        },
        end(line: string) {
          this.write(line);
        },
      };
      const close = () => {
        if (connection.destroyed) return;
        connection.destroyed = true;
        host.disconnected(connection);
        push({ kind: "lost" });
      };
      request.signal.addEventListener("abort", close, { once: true });
      host.message(
        connection,
        SharedWorkMessage.parse({
          version: 1,
          kind: "claim",
          store: digest(request.store),
          key: digest(request.key),
          insideGrant: request.insideGrant,
          redeclare: request.redeclare,
          deliveryAcknowledgement: true,
        }),
      );
      return {
        kind: "connected",
        claim: {
          next: () =>
            queue.length
              ? Promise.resolve(queue.shift()!)
              : new Promise((resolve) => {
                  receive = resolve;
                }),
          settle: async (outcome, publication) => {
            host.message(connection, {
              version: 1,
              kind: "settle",
              outcome,
              publication,
            });
            await settled.promise;
          },
          withdraw: () =>
            host.message(connection, { version: 1, kind: "withdraw" }),
          close,
        },
      };
    },
  };
  const ownership: typeof sharedWorkOwnership = (store, key) =>
    new Promise((resolve) => {
      host.message(
        {
          destroyed: false,
          write: () => {},
          end: (line) => {
            const reply = SharedWorkReply.parse(JSON.parse(line));
            resolve(
              reply.kind === "ownership"
                ? reply.live
                  ? "live"
                  : "ended"
                : "unknown",
            );
          },
        },
        {
          version: 1,
          kind: "ownership",
          store: digest(store),
          key: digest(key),
        },
      );
    });
  const authority = (
    scope: string,
  ): import("../../src/shared-publication.ts").PublicationAuthority => ({
    transport,
    host: () => host.hostId,
    status: (key) =>
      new Promise((resolve) =>
        host.message(
          {
            destroyed: false,
            write: () => {},
            end: (line) => {
              const reply = SharedWorkReply.parse(JSON.parse(line));
              resolve(reply.kind === "delivery" ? reply : undefined);
            },
          },
          { version: 1, kind: "delivery", store: digest(scope), key },
        ),
      ),
  });
  return {
    get host() {
      return host;
    },
    transport,
    ownership,
    authority,
    replace: () => {
      host.close();
      host = new SharedWorkHost(false);
    },
  };
};
