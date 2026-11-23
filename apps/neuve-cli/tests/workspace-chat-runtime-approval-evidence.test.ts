// Check that the card's decision reaches the runtime as a reply to the same Codex request.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, type Event } from "@ace/channel";
import { createModels } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  AccountName,
  type AccountStatus,
  type RuntimeEvent,
} from "@neuve/runtime";
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

async function approvalChannel(beforeReply: () => Promise<void>) {
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
  const runtimeEvents: RuntimeEvent[] = [];
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
        }).pipe(
          Effect.provide(fake.layer),
          Effect.map((session) => ({
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            events: session.events.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  runtimeEvents.push(event);
                }),
              ),
            ),
            respondToApproval: (
              answer: Parameters<typeof session.respondToApproval>[0],
            ) =>
              Effect.promise(beforeReply).pipe(
                Effect.andThen(session.respondToApproval(answer)),
              ),
          })),
        ),
    },
  });
  let channel: Channel | undefined;
  let watch: { stop(): Promise<unknown> } | undefined;
  const close = async () => {
    await watch?.stop();
    await channel?.close();
    await runtime.close();
    await rm(folder, { recursive: true, force: true });
  };
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
    const bound = channel;
    const ignore = () => {};
    const turns = () =>
      fake.processes
        .flatMap(({ io }) => io.written)
        .filter((line) => line.method === "turn/start").length;
    const startTurn = async () => {
      const previous = turns();
      const { submission } = (await bound.handle(
        {
          op: "ask",
          author: "person",
          text: "Run a command that needs network access",
          attended: true,
        },
        ignore,
      )) as { submission: number };
      await until(() => turns() > previous);
      return submission;
    };
    const snapshot = () => events.at(-1)?.requests;
    const request = async (id: number) => {
      const command = `curl https://example.test/${id}`;
      fake.current().io.send({
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
      const find = () =>
        snapshot()?.find((record) => record.callId === `command-${id}`);
      await until(() => find() !== undefined);
      return find()!;
    };
    const answer = (requestId: string, decision: "allow" | "deny") =>
      bound.handle(
        { op: "approval-answer", author: "person", requestId, decision },
        ignore,
      );
    const wait = (submission: number) =>
      bound.handle({ op: "wait", submission }, ignore);
    return {
      close,
      fake,
      events,
      logs,
      runtimeEvents,
      snapshot,
      startTurn,
      request,
      answer,
      wait,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test("Allow and Deny reach Codex before appearing in full approval snapshots", async () => {
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const run = await approvalChannel(async () => {
    started.resolve();
    await proceed.promise;
  });
  const { fake, events, logs } = run;
  try {
    expect(run.snapshot()).toEqual([]);
    const submission = await run.startTurn();
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
      const record = await run.request(id);
      expect(record.state).toEqual({ kind: "open" });
      expect(record.asked).toMatchObject({
        kind: "command",
        command: `curl https://example.test/${id}`,
      });
      const answering = run.answer(record.requestId, decision);
      if (id === 501) {
        await started.promise;
        expect(run.snapshot()?.[0]?.state).toEqual({ kind: "open" });
        expect(
          process.io.written.find((line) => line.id === id),
        ).toBeUndefined();
        proceed.resolve();
      }
      await answering;
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
    expect(await run.wait(submission)).toBe("done");
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
    proceed.resolve();
    await run.close();
  }
});

test.each(["turn-ended", "runtime-resolved", "write refused"] as const)(
  "a reply that loses to %s is refused and the chat still works",
  async (failure) => {
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const run = await approvalChannel(async () => {
      started.resolve();
      await proceed.promise;
    });
    try {
      const submission = await run.startTurn();
      const request = await run.request(501);
      const process = run.fake.current();
      const answering = run.answer(request.requestId, "allow");
      await started.promise;
      expect(run.snapshot()?.[0]?.state).toEqual({ kind: "open" });
      const resolved = failure === "runtime-resolved";
      if (resolved) {
        run.fake.send("serverRequest/resolved", {
          threadId: "thread-1",
          requestId: 501,
        });
        await until(() =>
          run.runtimeEvents.some((event) => event.type === "approval.resolved"),
        );
      } else if (failure === "turn-ended") {
        run.fake.send("turn/completed", completed("completed"));
        await until(() =>
          run.runtimeEvents.some((event) => event.type === "turn.finished"),
        );
      } else {
        process.io.refuseInput();
      }
      proceed.resolve();
      await expect(answering).rejects.toThrow(
        resolved
          ? "This approval request closed because the runtime resolved it."
          : "This approval request closed when its turn ended.",
      );
      const reason = resolved ? "runtime-resolved" : "turn-ended";
      await until(() => run.snapshot()?.[0]?.state.kind === "closed");
      expect(run.snapshot()?.[0]?.state).toEqual({ kind: "closed", reason });
      expect(
        run.events
          .flatMap((event) => event.requests)
          .some(
            (record) =>
              record.requestId === request.requestId &&
              record.state.kind === "answered",
          ),
      ).toBe(false);
      if (failure === "write refused")
        expect(process.io.refused).toContainEqual({
          id: 501,
          result: { decision: "accept" },
        });
      expect(
        process.io.written.find((line) => line.id === 501)?.result,
      ).not.toEqual({ decision: "accept" });
      if (resolved) {
        expect(
          process.io.written.find((line) => line.id === 501),
        ).toBeUndefined();
        run.fake.send("turn/completed", completed("completed"));
      }
      await run.wait(submission);
      const next = await run.startTurn();
      expect(run.fake.current() === process).toBe(failure !== "write refused");
      const nextRequest = await run.request(502);
      await run.answer(nextRequest.requestId, "deny");
      expect(
        run.fake.current().io.written.find((line) => line.id === 502),
      ).toEqual({
        id: 502,
        result: { decision: "decline" },
      });
      run.fake.send("turn/completed", completed("completed"));
      expect(await run.wait(next)).toBe("done");
    } finally {
      proceed.resolve();
      await run.close();
    }
  },
);
