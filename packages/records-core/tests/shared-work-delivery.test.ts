import { test, expect } from "bun:test";
import { SharedWorkHost } from "../src/shared-work-host.ts";
import { SharedWorkReply } from "../src/shared-work-protocol.ts";
const store = "a".repeat(64),
  key = "b".repeat(64);
const connection = () => {
  const messages: Array<{
    reply: ReturnType<typeof SharedWorkReply.parse>;
    ended: boolean;
  }> = [];
  return {
    messages,
    destroyed: false,
    write(line: string) {
      messages.push({
        reply: SharedWorkReply.parse(JSON.parse(line)),
        ended: false,
      });
    },
    end(line: string) {
      messages.push({
        reply: SharedWorkReply.parse(JSON.parse(line)),
        ended: true,
      });
    },
  };
};
for (const optIn of [false, true])
  test(`settlement releases the key immediately, delivery opt-in=${optIn}`, async () => {
    const host = new SharedWorkHost(false),
      holder = connection(),
      waiter = connection(),
      retry = connection();
    const claim = (client: ReturnType<typeof connection>) =>
      host.message(client, {
        version: 1,
        kind: "claim",
        store,
        key,
        insideGrant: false,
        redeclare: false,
        ...(optIn ? { deliveryAcknowledgement: true as const } : {}),
      });
    const delivery = () =>
      new Promise<
        Extract<ReturnType<typeof SharedWorkReply.parse>, { kind: "delivery" }>
      >((resolve) =>
        host.message(
          {
            destroyed: false,
            write: () => {},
            end: (line) => {
              const reply = SharedWorkReply.parse(JSON.parse(line));
              if (reply.kind !== "delivery")
                throw new Error("Unexpected reply");
              resolve(reply);
            },
          },
          { version: 1, kind: "delivery", store, key, publication: "first" },
        ),
      );
    try {
      claim(holder);
      claim(waiter);
      host.message(holder, {
        version: 1,
        kind: "settle",
        outcome: "failed",
        publication: "first",
      });
      expect(holder.messages.at(-1)?.ended).toBe(true);
      expect(waiter.messages.at(-1)?.ended).toBe(!optIn);
      if (!optIn)
        expect(waiter.messages.at(-1)?.reply).toEqual({
          kind: "done",
          outcome: "failed",
          publication: "first",
        });
      expect((await delivery()).claimed).toBe(false);
      expect((await delivery()).unread).toBe(optIn);
      claim(retry);
      expect(retry.messages.at(-1)?.reply.kind).toBe("claimed");
      expect((await delivery()).claimed).toBe(true);
      expect((await delivery()).unread).toBe(optIn);
      host.disconnected(waiter);
      expect((await delivery()).unread).toBe(false);
    } finally {
      host.close();
    }
  });
