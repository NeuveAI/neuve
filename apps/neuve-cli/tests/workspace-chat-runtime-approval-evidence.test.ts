// Check that the card's decision reaches the runtime as a reply to the same Codex request.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, type Event } from "@ace/channel";
import { createModels } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AccountName, type AccountStatus } from "@neuve/runtime";
import { Effect, Stream } from "effect";
import {
  caps,
  Statuses,
  testModels,
  until,
} from "../../../packages/harness/tests/chat-runtime/fixture.ts";
import { ATTENDED_SECTION } from "../../../packages/harness/src/chat-runtime/transcript.ts";
import type { LogEntry } from "../../../packages/runtime-codex/src/log.ts";
import { openCodexSession } from "../../../packages/runtime-codex/src/session.ts";
import {
  codex,
  completed,
} from "../../../packages/runtime-codex/tests/codex-fake.ts";
import { workspaceChatRuntime } from "../src/workspace-chat-runtime.ts";

test("Allow and Deny reach Codex and appear in full approval snapshots", async () => {
  const folder = await mkdtemp(join(tmpdir(), "approval-evidence-"));
  const name = AccountName.parse("codex");
  const status = {
    name,
    kind: "chatgpt-subscription",
    models: testModels,
    signIn: { state: "signed-in" },
    limits: [],
    checkedAt: "2026-11-10T12:00:00Z",
  } satisfies AccountStatus;
  const fake = codex();
  const logs: LogEntry[] = [];
  const events: Extract<Event, { kind: "approval-requests" }>[] = [];
  const capabilities = {
    ...caps,
    ownTools: true,
    approvals: true,
    toolEndsTurn: false,
    resumeInTurn: false,
  };
  const runtime = await workspaceChatRuntime(createModels(), folder, {
    statuses: new Statuses([status]),
    registry: {
      accountEvents: Stream.empty,
      capabilities: () => Effect.succeed(capabilities),
      continuation: () => Effect.succeed({ runtime: "codex", key: "fixture" }),
      probe: () => Effect.succeed(status),
      signOut: () => Effect.void,
      openSession: (account, policy, start) =>
        openCodexSession({
          account,
          program: "/test/codex",
          cwd: policy.folder ?? folder,
          environment: {},
          // The fake only uses Codex's native command tool and needs no local tool server.
          policy: { ...policy, tools: [] },
          start: start ?? { kind: "new" },
          stopWait: "10 millis",
          log: (line) => logs.push(line),
        }).pipe(Effect.provide(fake.layer)),
    },
  });
  let channel: Channel | undefined;
  let watch: { stop(): Promise<unknown> } | undefined;
  try {
    channel = await Channel.open({
      id: "approvals",
      name: "approvals",
      project: folder,
      owner: "person",
      model: { provider: name, modelId: "sonnet" },
      storage: new MemoryStorage(),
      models: runtime.models,
      env: (cwd) => new NodeExecutionEnv({ cwd }),
      directory: {
        self: { id: "approvals", name: "approvals" },
        list: async () => [],
        deliver: async () => {
          throw new Error("The fixture has one channel.");
        },
      },
      log: () => {},
      extension: {
        extensions: runtime.extensions,
        attach: runtime.attach,
      },
    });
    watch = (await channel.handle({ op: "watch", approvals: true }, (event) => {
      if (event.kind === "approval-requests") events.push(event);
    })) as { stop(): Promise<unknown> };
    expect(events.at(-1)?.requests).toEqual([]);
    const ignore = () => {};
    const { submission } = (await channel.handle(
      {
        op: "ask",
        author: "person",
        text: "Run two commands that need network access",
        attended: true,
      },
      ignore,
    )) as { submission: number };
    await until(() =>
      fake.current()?.io.written.some((line) => line.method === "turn/start"),
    );
    const process = fake.current();
    const start = fake.processes
      .flatMap(({ io }) => io.written)
      .find((line) => line.method === "thread/start");
    expect(start).toMatchObject({
      params: { developerInstructions: expect.any(String) },
    });
    expect(JSON.stringify(start)).not.toContain(ATTENDED_SECTION);
    for (const [id, decision, reply] of [
      [501, "allow", "accept"],
      [502, "deny", "decline"],
    ] as const) {
      const command = `curl https://example.test/${id}`;
      process.io.send({
        id,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "codex-turn",
          itemId: `command-${id}`,
          command,
          cwd: folder,
          reason: "Network access",
          networkApprovalContext: { host: "example.test", protocol: "https" },
        },
      });
      await until(
        () =>
          events
            .at(-1)
            ?.requests.some((record) => record.callId === `command-${id}`) ??
          false,
      );
      const record = events
        .at(-1)!
        .requests.find((record) => record.callId === `command-${id}`)!;
      expect(record.state).toEqual({ kind: "open" });
      expect(record.asked).toMatchObject({ kind: "command", command });
      expect(process.io.written.find((line) => line.id === id)).toBeUndefined();
      await channel.handle(
        {
          op: "approval-answer",
          author: "person",
          requestId: record.requestId,
          decision,
        },
        ignore,
      );
      await until(() => process.io.written.some((line) => line.id === id));
      expect(process.io.written.find((line) => line.id === id)).toEqual({
        id,
        result: { decision: reply },
      });
    }
    await until(
      () =>
        events
          .at(-1)
          ?.requests.every((record) => record.state.kind === "answered") ??
        false,
    );
    expect(events.at(-1)?.requests.map(({ state }) => state)).toEqual([
      {
        kind: "answered",
        by: "person",
        at: expect.any(Number),
        decision: "allow",
      },
      {
        kind: "answered",
        by: "person",
        at: expect.any(Number),
        decision: "deny",
      },
    ]);
    fake.send("turn/completed", completed("completed"));
    expect(await channel.handle({ op: "wait", submission }, ignore)).toBe(
      "done",
    );
    if (Bun.env.NEUVE_APPROVAL_EVIDENCE === "1") {
      for (const line of logs) {
        const { message } = line;
        if (
          message &&
          typeof message === "object" &&
          "id" in message &&
          (message.id === 501 || message.id === 502)
        )
          console.log(JSON.stringify({ kind: "codex-protocol", ...line }));
      }
      for (const event of events) console.log(JSON.stringify(event));
    }
  } finally {
    await watch?.stop();
    await channel?.close();
    await runtime.close();
    await rm(folder, { recursive: true, force: true });
  }
});
