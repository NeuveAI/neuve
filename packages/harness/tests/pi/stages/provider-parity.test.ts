import { expect, test } from "bun:test";
import { modelCallCounts } from "../../../src/receipt.ts";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SOL_ROUTE, OPUS_ROUTE } from "../../../src/route.ts";
import { Effect } from "effect";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
} from "../../../src/pi/capture/export.ts";
import { AgentContextDoc } from "../../../src/pi/stages/docs.ts";
import { conversationEntries } from "../../../src/pi/stages/tools.ts";
import { RunControlDoc } from "../../../src/pi/control.ts";
import {
  completed,
  created,
  functionCallItem,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";
import { world, settled, agentConversation } from "./fixture.ts";

const toolReply = (tag: string, name: string, args: unknown) => () =>
  sse([
    created(tag),
    ...functionCallItem(0, {
      id: `fc-${tag}`,
      callId: `call-${tag}`,
      name,
      arguments: JSON.stringify(args),
    }),
    completed(tag),
  ]);
const jsonReply = (tag: string) => () =>
  sse([
    created(tag),
    ...messageItem(0, `msg-${tag}`, "final_answer", '{"answer":7}'),
    completed(tag),
  ]);

const withOpenai = async (
  name: string,
  use: (
    endpoint: ReturnType<typeof openEndpoint>,
    run: Awaited<ReturnType<typeof world>>,
  ) => Promise<void>,
) => {
  const endpoint = openEndpoint();
  const directory = mkdtempSync(join(tmpdir(), "provider-parity-"));
  try {
    const token = tokenCommand(directory, "synthetic-token");
    const run = await world(
      name,
      2,
      false,
      false,
      "faux",
      {
        route: SOL_ROUTE,
        fetch: endpoint.fetch,
        auth: { tokenCommand: token.path },
      },
      true,
    );
    try {
      await use(endpoint, run);
    } finally {
      run.journal?.close();
      run.authority?.close();
      run.ownership?.release();
    }
  } finally {
    endpoint.stop();
    rmSync(directory, { recursive: true, force: true });
  }
};

test("physical OpenAI wire and capture use Neuve's rejected result while native exports keep the original validation fact", () =>
  withOpenai("physical-invalid", async (endpoint, run) => {
    endpoint.respond(
      toolReply("bad", "probe", { n: null }),
      toolReply("done", "submit_frame", { answer: 7 }),
    );
    const opened = await run.open();
    try {
      const id = await run.start(opened);
      await opened.harness.resume();
      const record = await settled(opened.harness, id);
      expect(record.agentResult?.turnsUsed).toBe(2);
      expect(run.probes).toEqual([]);
      expect(endpoint.received).toHaveLength(2);
      const expected = {
        type: "function_call_output",
        call_id: "call-bad",
        output:
          "Invalid input for probe: ✖ Invalid input: expected number, received null\n  → at n\n\n[turn 1 / 2; results are capped at about 3,000 tokens; lookup allowance 0 / 4]",
      };
      expect(endpoint.received[1]!.body["input"]).toContainEqual(expected);
      const requests = run.events.filter(
        (event) => event.type === "model.request",
      );
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain(
        JSON.stringify(expected).slice(1, -1),
      );
      const conversationId = await agentConversation(opened.harness);
      const entries = await opened.harness.commit(
        (tx) => conversationEntries(tx, conversationId),
        context,
      );
      const original = entries
        .flatMap((entry) => entry.model ?? [])
        .find(
          (message) =>
            message.role === "toolResult" && message.toolName === "probe",
        );
      if (original?.role !== "toolResult")
        throw new Error("No native tool result");
      const call = entries
        .flatMap((entry) => entry.model ?? [])
        .flatMap((message) =>
          message.role === "assistant" ? message.content : [],
        )
        .find(
          (part) => part.type === "toolCall" && part.id === original.toolCallId,
        );
      expect(call).toMatchObject({
        type: "toolCall",
        name: "probe",
        arguments: { n: null },
      });
      expect(JSON.stringify(original)).toContain("Invalid input");
      expect(JSON.stringify(original)).toContain("<harness>");
      expect(
        (
          await opened.harness.snapshot(
            AgentContextDoc,
            conversationId,
            context,
          )
        )?.applied[original.toolCallId]?.text,
      ).toBe(expected.output);
      run.journal?.close();
      mkdirSync(join(run.root, "datasets"));
      const exported = await exportSnapshot({
        runId: run.ctx.runId,
        journal: join(run.root, "capture"),
        nativeDatabase: run.database,
        credentialInspection: run.authority,
        root: join(run.root, "datasets"),
        retention: { policy: "synthetic boundary test" },
      });
      const portable = await exportPortableSnapshot({
        directory: exported.directory,
        root: join(run.root, "datasets"),
        retention: { policy: "synthetic boundary test" },
      });
      for (const directory of [exported.directory, portable.directory]) {
        const dump = await Effect.runPromise(readSessionDump(directory));
        const session = dump.sessions.find(
          (session) => session.conversationId === conversationId,
        );
        expect(session).toBeDefined();
        expect(JSON.stringify(session?.entries)).toContain("<harness>");
        expect(JSON.stringify(session?.entries)).toContain(original.toolCallId);
        expect(JSON.stringify(session?.calls)).toContain(
          JSON.stringify(expected).slice(1, -1),
        );
        const replayed = session?.calls.find((call) =>
          call.sdkContext?.messages.some(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "role" in message &&
              message.role === "toolResult",
          ),
        );
        expect(replayed?.sdkContext?.messages).toContainEqual({
          role: "toolResult",
          toolCallId: original.toolCallId,
          toolName: "probe",
          isError: true,
          content: [{ type: "text", text: expected.output }],
          timestamp: original.timestamp,
        });
        expect(JSON.stringify(session?.calls)).toContain(
          "lookup allowance 0 / 4",
        );
      }
    } finally {
      await opened.harness.close(context);
    }
  }));

test("physical OpenAI incomplete.content_filter continues, counts both attempts, and ends at the turn budget", () =>
  withOpenai("physical-filter", async (endpoint, run) => {
    for (const id of ["filtered-1", "filtered-2"])
      endpoint.respond(() =>
        sse([
          created(id),
          {
            type: "response.incomplete",
            response: {
              id,
              status: "incomplete",
              output: [],
              incomplete_details: { reason: "content_filter" },
              usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
            },
          },
        ]),
      );
    endpoint.respond(jsonReply("final"));
    const opened = await run.open();
    try {
      const id = await run.start(opened);
      await opened.harness.resume();
      const record = await settled(opened.harness, id);
      expect(endpoint.received).toHaveLength(3);
      expect(endpoint.received[2]!.body["tool_choice"]).toBe("none");
      expect(JSON.stringify(endpoint.received[1]!.body["input"])).toContain(
        "1 turn(s) left",
      );
      expect(modelCallCounts(run.ctx.log.read())).toEqual({
        modelCalls: 3,
        failedModelCalls: 0,
        abortedModelCalls: 0,
      });
      expect(record.agentResult?.turnsUsed).toBe(3);
      expect(record.agentResult?.endedBy).toBe("turn-limit");
      expect(
        run.ctx.log
          .read()
          .filter(
            (entry) => entry.type === "gap" && entry["kind"] === "refusal",
          ),
      ).toHaveLength(2);
      expect(
        (await opened.harness.snapshot(RunControlDoc, context))?.held ?? {},
      ).toEqual({});
    } finally {
      await opened.harness.close(context);
    }
  }));

const anthropicAnswer = (id: string, refusal: boolean) => () =>
  sse([
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: OPUS_ROUTE.model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    ...(!refusal
      ? [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: '{"answer":7}' },
          },
          { type: "content_block_stop", index: 0 },
        ]
      : []),
    {
      type: "message_delta",
      delta: {
        stop_reason: refusal ? "refusal" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);

test("physical Anthropic refusal continues with one counted attempt and gap per response", async () => {
  const endpoint = openEndpoint();
  const variable = "NEUVE_PARITY_SYNTHETIC_KEY";
  process.env[variable] = "synthetic-parity-key";
  const run = await world("physical-anthropic", 2, false, false, "faux", {
    route: { ...OPUS_ROUTE, credentialVariable: variable },
    fetch: endpoint.fetch,
  });
  endpoint.respond(
    anthropicAnswer("anthropic-refusal-1", true),
    anthropicAnswer("anthropic-refusal-2", true),
    anthropicAnswer("anthropic-final", false),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    const record = await settled(opened.harness, id);
    expect(endpoint.received).toHaveLength(3);
    expect(JSON.stringify(endpoint.received[1]!.body["messages"])).toContain(
      "1 turn(s) left",
    );
    expect(modelCallCounts(run.ctx.log.read())).toEqual({
      modelCalls: 3,
      failedModelCalls: 0,
      abortedModelCalls: 0,
    });
    expect(record.agentResult?.turnsUsed).toBe(3);
    expect(record.agentResult?.endedBy).toBe("turn-limit");
    expect(
      run.ctx.log
        .read()
        .filter((entry) => entry.type === "gap" && entry["kind"] === "refusal"),
    ).toHaveLength(2);
  } finally {
    await opened.harness.close(context);
    endpoint.stop();
    delete process.env[variable];
  }
});

// Regression: the production transport records the call before afterResponse runs.
test("production call logging preserves the refusal gap through reopen", async () => {
  const endpoint = openEndpoint();
  const variable = "NEUVE_PARITY_REFUSAL_LOG_KEY";
  process.env[variable] = "synthetic-parity-key";
  const run = await world("physical-refusal-log", 1, false, false, "faux", {
    route: { ...OPUS_ROUTE, credentialVariable: variable },
    fetch: endpoint.fetch,
  });
  endpoint.respond(
    anthropicAnswer("logged-refusal", true),
    anthropicAnswer("logged-final", false),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    await settled(opened.harness, id);
    const records = run.ctx.log.read();
    expect(
      records.filter((row) => row.type === "model.call.start").length,
    ).toBeGreaterThan(0);
    expect(records.filter((row) => row.type === "model.call")).toHaveLength(2);
    expect(
      records.filter((row) => row.type === "gap" && row["kind"] === "refusal"),
    ).toHaveLength(1);
  } finally {
    await opened.harness.close(context);
  }
  try {
    const reopened = await run.open();
    await reopened.harness.close(context);
    expect(
      run.ctx.log
        .read()
        .filter((row) => row.type === "gap" && row["kind"] === "refusal"),
    ).toHaveLength(1);
    expect(endpoint.received).toHaveLength(2);
  } finally {
    endpoint.stop();
    delete process.env[variable];
  }
});
