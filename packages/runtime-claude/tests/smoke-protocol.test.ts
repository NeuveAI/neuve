import { expect, test } from "bun:test";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { checkCompletedInputs } from "../src/smoke-resume.ts";
import { assistant, result, SESSION_ID } from "./frames.ts";
import { inbound, out, type Entry } from "./replay.ts";
import { account, runReplay } from "./smoke-fixture.ts";

const late = (reply: SDKAssistantMessage): Entry[] => [
  inbound(reply),
  inbound({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
    event: { type: "message_stop" },
  }),
  inbound(reply),
];

// Reason: either half of completed-input persistence must report a frame after message_stop.
for (const mode of ["input", "resume"] as const) {
  test(`completed-input smoke reports protocol failure in ${mode}`, async () => {
    const first = assistant(undefined);
    first.message.id = "first";
    const last = assistant(undefined);
    last.message.id = "last";
    const recall = assistant(undefined);
    recall.message.id = "recall";
    const entries: Entry[] = [
      out({ type: "query.open" }),
      out({ type: "prompt.offer", message: /^Remember messageToken as / }),
      out({
        type: "prompt.offer",
        message: /^Remember steerToken as /,
        priority: "now",
      }),
      ...(mode === "input"
        ? late(first)
        : [
            inbound(first),
            inbound(result({ queued_turn_count: 1 })),
            inbound(last),
            inbound(result()),
          ]),
      out({ type: "query.close" }),
      ...(mode === "input"
        ? []
        : [
            out({
              type: "query.open",
              check: (options) => {
                expect(options.resume).toBe(SESSION_ID);
                expect(options.resumeSessionAt).toBe(last.uuid);
                expect(options.forkSession).toBe(false);
              },
            }),
            out({ type: "query.close" }),
            out({ type: "query.open" }),
            out({
              type: "prompt.offer",
              message:
                "Return the remembered messageToken and steerToken in the requested schema.",
            }),
            ...late(recall),
            out({ type: "query.close" }),
          ]),
    ];
    const counts = await runReplay(entries, (runtime) =>
      checkCompletedInputs(runtime, account),
    );
    expect(counts).toMatchObject({
      inputCompleted: mode === "resume",
      resumeCompleted: false,
      messageTokenFound: false,
      steerTokenFound: false,
      protocolError: true,
      requests: mode === "input" ? 1 : 3,
    });
  });
}
