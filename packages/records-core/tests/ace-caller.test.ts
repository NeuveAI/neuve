import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { Ancestry, Caller, Identity, Sessions } from "../src/index.ts";
import { freshLocation, removeTemporaryDirectories, runFs } from "./support.ts";

afterAll(removeTemporaryDirectories);

// Existing Ace review requests must keep the same actor after attribution moves into Records.
test("an Ace chat keeps the previously recorded review actor", () => {
  expect(Identity.aceChatIdentity("channel-a", 7).actorId).toBe(
    Identity.agentFingerprint({
      harness: "neuve-pi",
      sessionId: "channel-a",
      subagentId: "7",
    }),
  );
});

// A channel marker can narrow live ancestry but cannot supply it or take precedence over a nearer session.
test("an Ace chat needs its own live worker as the nearest session owner", async () => {
  const location = freshLocation();
  const table = Ancestry.parseProcessTable(`
    100 1 Sat Oct 17 13:30:35 2026 bun
    200 100 Sat Oct 17 13:31:35 2026 claude
    300 200 Sat Oct 17 13:32:35 2026 neuve
  `);
  const worker = Ancestry.identityOf(table.get(100)!);
  const claude = Ancestry.identityOf(table.get(200)!);
  const channel = {
    version: 1,
    harness: "neuve-pi",
    sessionId: "channel-a",
    actorId: "a".repeat(64),
  } as const;
  const resolve = (
    value: string | undefined,
    processes: () => Ancestry.Snapshot | undefined = () => table,
  ) =>
    Caller.resolveCaller(location, {
      pid: 300,
      processes,
      environment: { NEUVE_ACE_CHAT: value },
    });
  const results = await runFs(
    Effect.gen(function* () {
      yield* Sessions.writeSession(location, {
        ...channel,
        owner: { ...worker, start: claude.start },
      });
      const stale = yield* resolve("channel-a/7");
      yield* Sessions.writeSession(location, { ...channel, owner: worker });
      const matching = yield* resolve("channel-a/7");
      const mismatched = yield* resolve("channel-b/7");
      const missing = yield* resolve(undefined);
      const unavailable = yield* resolve("channel-a/7", () => undefined);
      yield* Sessions.writeSession(location, {
        version: 1,
        harness: "claude-code",
        sessionId: "standalone",
        actorId: "b".repeat(64),
        owner: claude,
      });
      const nearer = yield* resolve("channel-a/7");
      return { stale, matching, mismatched, missing, unavailable, nearer };
    }),
  );
  expect(results).toEqual({
    stale: { _tag: "None" },
    matching: {
      _tag: "Linked",
      method: "ancestry",
      harness: "neuve-pi",
      sessionId: "channel-a",
      subagentId: "7",
      actorId: Identity.agentFingerprint({
        harness: "neuve-pi",
        sessionId: "channel-a",
        subagentId: "7",
      }),
    },
    mismatched: { _tag: "None" },
    missing: { _tag: "None" },
    unavailable: { _tag: "Unavailable" },
    nearer: {
      _tag: "Linked",
      method: "ancestry",
      harness: "claude-code",
      sessionId: "standalone",
      actorId: "b".repeat(64),
    },
  });
});
