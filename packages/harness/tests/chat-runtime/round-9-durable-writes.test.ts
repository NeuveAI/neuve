import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { RuntimeRegistryShape, SessionStart } from "@neuve/runtime";
import {
  ChatRuntimeBridge,
  NativeHeads,
} from "../../src/chat-runtime/index.ts";
import { headDigest } from "../../src/chat-runtime/transcript.ts";
import { account, caps, fixture } from "./fixture.ts";

type Cut = {
  pair: string;
  head: "clean" | "pending" | "ahead" | "rollback" | "fork" | "none";
  checkpoint: boolean;
  tool?: true;
  foreign?: true;
  handoff?: true;
  legacy?: true;
  receipt?: true;
  partial?: true;
  outcome: "resume" | "fork" | "new";
};
// These are disk/transcript snapshots for the head cuts in durable-writes.md B, rather than a process kill.
// B17's real Harness submissions are covered in round-12.test.ts; question commits use the CLI test.
const cuts: Cut[] = [
  {
    pair: "B6 receipt before first pi assistant",
    head: "ahead",
    checkpoint: false,
    receipt: true,
    outcome: "fork",
  },
  {
    pair: "B6 receipt before later pi assistant",
    head: "ahead",
    checkpoint: true,
    receipt: true,
    outcome: "fork",
  },
  {
    pair: "D throttled partial ahead of H with checkpoint",
    head: "clean",
    checkpoint: true,
    partial: true,
    outcome: "resume",
  },
  {
    pair: "D throttled partial ahead of H without checkpoint",
    head: "none",
    checkpoint: false,
    partial: true,
    outcome: "new",
  },

  {
    pair: "B1 pi input -> open",
    head: "clean",
    checkpoint: true,
    outcome: "resume",
  },
  {
    pair: "B1 new pi input -> open",
    head: "none",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B2 open -> owning head",
    head: "clean",
    checkpoint: true,
    outcome: "resume",
  },
  {
    pair: "B2 new open -> owning head",
    head: "none",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B3 owning head -> pending",
    head: "clean",
    checkpoint: true,
    outcome: "resume",
  },
  {
    pair: "B3 empty owning head -> pending",
    head: "clean",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B4 input -> native message",
    head: "pending",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B4 first input -> native message",
    head: "pending",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B5 native message -> checkpoint head",
    head: "pending",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B5 first native message -> checkpoint head",
    head: "pending",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B6 checkpoint head -> pi assistant",
    head: "ahead",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B6 first checkpoint head -> pi assistant",
    head: "ahead",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B6 foreign matching UUID is not a checkpoint for this session",
    head: "ahead",
    checkpoint: false,
    foreign: true,
    outcome: "new",
  },
  {
    pair: "B4 handoff input -> native message",
    head: "pending",
    checkpoint: false,
    handoff: true,
    outcome: "new",
  },
  {
    pair: "B5 handoff native message -> checkpoint head",
    head: "pending",
    checkpoint: false,
    handoff: true,
    outcome: "new",
  },
  {
    pair: "B6 handoff checkpoint head -> pi assistant",
    head: "ahead",
    checkpoint: false,
    handoff: true,
    outcome: "new",
  },
  {
    pair: "B7 pi assistant -> next input",
    head: "clean",
    checkpoint: true,
    outcome: "resume",
  },
  {
    pair: "B7 pi assistant -> close",
    head: "clean",
    checkpoint: true,
    outcome: "resume",
  },
  {
    pair: "B8 pi toolUse -> pi result",
    head: "clean",
    checkpoint: true,
    tool: true,
    outcome: "new",
  },
  {
    pair: "B9 pi result/steer -> pending",
    head: "clean",
    checkpoint: true,
    tool: true,
    outcome: "new",
  },
  {
    pair: "B9 pending -> native delivery",
    head: "pending",
    checkpoint: true,
    tool: true,
    outcome: "new",
  },
  {
    pair: "B10 native delivery -> native message",
    head: "pending",
    checkpoint: true,
    tool: true,
    outcome: "new",
  },
  {
    pair: "B11 abort -> rollback",
    head: "ahead",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B11 first abort -> rollback",
    head: "ahead",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B11 rollback -> pi error",
    head: "rollback",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B11 first rollback -> pi error",
    head: "rollback",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B11 pi error -> rollback",
    head: "ahead",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B12 close -> pi aborted",
    head: "pending",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B12 first close -> pi aborted",
    head: "pending",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B12 pi Stop/terminate -> close",
    head: "pending",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B13 clean close -> writer drain",
    head: "clean",
    checkpoint: true,
    outcome: "resume",
  },
  {
    pair: "B13 pending close -> writer drain",
    head: "pending",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B14 pending -> input",
    head: "pending",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B14 first pending -> input",
    head: "pending",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B14 fork pending -> input",
    head: "fork",
    checkpoint: true,
    outcome: "fork",
  },
  {
    pair: "B15 pi.reset -> head removal",
    head: "ahead",
    checkpoint: false,
    outcome: "new",
  },
  {
    pair: "B16 head removal -> close",
    head: "none",
    checkpoint: false,
    outcome: "new",
  },

  {
    pair: "B4 legacy head with checkpoint",
    head: "clean",
    checkpoint: true,
    legacy: true,
    outcome: "fork",
  },
  {
    pair: "B4 legacy head without checkpoint",
    head: "clean",
    checkpoint: false,
    legacy: true,
    outcome: "new",
  },
];

// Rulings 25(b)/26: these later explicit requests resume only completed heads, otherwise fork or open fresh.
test("every durable-write crash cut recovers from a completed or pre-input point on a second bridge", async () => {
  for (const cut of cuts) {
    const directory = await mkdtemp(join(tmpdir(), "chat-runtime-r9-table-"));
    let registry: RuntimeRegistryShape | undefined;
    const run = await fixture({
      headsDirectory: directory,
      registry: (value) => (registry = value),
    });
    let reopened: ChatRuntimeBridge | undefined;
    try {
      run.fake.frames.push({ text: "committed answer" });
      await run.submit("first");
      const committed = await run.messages();
      const answer = committed.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      )!;
      const base = cut.checkpoint
        ? committed.map((message) =>
            message === answer && cut.tool
              ? {
                  ...answer,
                  stopReason: "toolUse" as const,
                  responseId: "native:session-1:point-1",
                  content: [
                    {
                      type: "toolCall" as const,
                      id: "saved",
                      name: "probe",
                      arguments: { n: 1 },
                    },
                  ],
                }
              : message,
          )
        : committed.filter((message) => message.role !== "assistant");
      if (cut.handoff) {
        const { responseId: _pointer, ...piReply } = answer;
        base.push({ ...piReply, provider: "faux", model: "coder" });
      }
      if (cut.foreign)
        base.push({ ...answer, responseId: "native:another-session:point-2" });
      const tail: Message[] = cut.tool
        ? [
            {
              role: "toolResult",
              toolCallId: "saved",
              toolName: "probe",
              content: [{ type: "text", text: "saved output" }],
              isError: false,
              timestamp: 2,
            },
            { role: "user", content: "saved steer", timestamp: 3 },
          ]
        : [];
      if (cut.partial)
        tail.push({
          ...answer,
          responseId: "native:session-1:point-2",
          stopReason: "aborted",
        });
      if (cut.head === "rollback")
        tail.push({
          ...answer,
          stopReason: "error",
          responseId: "native:session-1:",
          errorMessage:
            "This turn did not produce an answer. Try another message.",
          content: [],
        });
      const messages: Message[] = [
        ...base,
        ...tail,
        { role: "user", content: "next", timestamp: 4 },
      ];
      await run.bridge.close();
      const disk = await NativeHeads.open(directory);
      const old = disk.get(String(run.conversation.id))!;
      const head = {
        session: cut.head === "fork" ? "unfinished-fork" : "session-1",
        ...(cut.legacy
          ? {}
          : {
              continuation: { runtime: account().runtime, key: "/shared" },
              previousDigest: headDigest(cut.handoff ? base : []),
            }),
        digest: headDigest(base),
        ...(cut.checkpoint ? { resumePoint: "point-1" } : {}),
        ...(cut.head === "clean" && cut.checkpoint && !cut.tool && !cut.legacy
          ? { completed: true as const }
          : {}),
      };
      if (cut.head === "none")
        await disk.restore(String(run.conversation.id), old, undefined);
      else if (cut.head === "fork")
        await disk.set(String(run.conversation.id), {
          session: "unfinished-fork",
          continuation: { runtime: account().runtime, key: "/shared" },
          digest: head.digest,
          forkedFrom: { session: "session-1", resumePoint: "point-1" },
          pending: true,
        });
      else
        await disk.set(String(run.conversation.id), {
          ...head,
          ...(cut.receipt
            ? { checkpointThrough: headDigest(base), completed: true }
            : {}),
          ...(cut.head === "ahead"
            ? { resumePoint: "point-2", digest: "uncommitted-message-digest" }
            : {}),
          ...(cut.head === "pending" || cut.head === "rollback"
            ? { pending: true }
            : {}),
        });
      await disk.close();
      const count = run.fake.requests.length;
      reopened = new ChatRuntimeBridge({
        registry: registry!,
        heads: await NativeHeads.open(directory),
      });
      expect(run.fake.requests.length, cut.pair).toBe(count);
      // Every head state stays stopped until a person acts; recovery receipts cannot authorize a send.
      const opened = run.fake.opened.length;
      reopened.identify(messages, run.conversation.id, cut.pair, true);
      const stopped = await reopened
        .stream(
          {
            name: account().name,
            capabilities: caps,
            continuation: { runtime: account().runtime, key: "/shared" },
          },
          run.models.getModel("subscription", "sonnet")!,
          { messages },
        )
        .result();
      expect(stopped.stopReason, cut.pair).toBe("aborted");
      expect(run.fake.opened.length, cut.pair).toBe(opened);
      expect(run.fake.requests.length, cut.pair).toBe(count);
      reopened.identify(messages, run.conversation.id, cut.pair);
      run.fake.frames.push({ text: "recovered" });
      const result = await reopened
        .stream(
          {
            name: account().name,
            capabilities: caps,
            continuation: { runtime: account().runtime, key: "/shared" },
          },
          run.models.getModel("subscription", "sonnet")!,
          { messages },
        )
        .result();
      {
        const expected: SessionStart =
          cut.outcome === "new"
            ? { kind: "new" }
            : cut.outcome === "fork"
              ? {
                  kind: "resume",
                  session: "session-1",
                  at: cut.receipt ? "point-2" : "point-1",
                  fork: true,
                }
              : { kind: "resume", session: "session-1", fork: false };
        expect(result.stopReason, cut.pair).toBe("stop");
        expect(run.fake.opened.at(-1)?.start, cut.pair).toEqual(expected);
        expect(run.fake.requests.at(-1)?.input, cut.pair).toEqual([
          ...((!cut.checkpoint && !cut.receipt) || cut.tool
            ? [{ type: "text", text: "first" }]
            : []),
          ...(cut.tool
            ? [
                {
                  type: "text",
                  text: "probe already ran. Do not call it again. Result:\nsaved output",
                },
                { type: "text", text: "saved steer" },
              ]
            : []),
          { type: "text", text: "next" },
        ]);
      }
      expect(run.executed, cut.pair).toEqual([]);
    } finally {
      await reopened?.close();
      await run.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
