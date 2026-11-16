import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ToolTask, defineExtension, hook } from "@earendil-works/pi-durable";
import { CapturedStorage } from "./captured-storage.ts";
import { context, fixture, until } from "./fixture.ts";

// Reason: Ruling 28b aborts every unlisted tool in both durable phases; read reruns with its result gated.
for (const phase of ["call", "execute"] as const) {
  for (const toolName of [
    "message",
    "subagent",
    "bash",
    "new-tool",
    "read",
  ] as const) {
    test(`recovered ${toolName} in ${phase} ${toolName === "read" ? "reruns and holds its result" : "stops at source and holds its error"} until the person acts`, async () => {
      const storage = new CapturedStorage();
      const source = await fixture({
        storage,
        toolName,
        executionMode: "sequential",
        execute: waitForClose,
      });
      let entered = false;
      if (phase === "call")
        source.pi.install(
          defineExtension({
            name: "hold-before-intent",
            hooks: [
              hook(ToolTask, {
                async beforeTool(_call, _api, callContext) {
                  entered = true;
                  await waitForAbort(callContext.abortSignal);
                },
              }),
            ],
          }),
        );
      source.fake.frames.push({
        calls: [
          { callId: "recovered", toolName, input: { n: 1 } },
          ...(phase === "call"
            ? [{ callId: "successor", toolName, input: { n: 3 } }]
            : []),
        ],
      });
      const work = source.submit("original request").catch(() => undefined);
      let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
      // This fixture is a separate Harness, as a real message target's worker would be.
      const target = await fixture();
      const targetSubmissions = new Set<string>();
      const stop = target.harness.subscribeCommits(({ changes }) => {
        for (const change of changes)
          if (change.type === "submission")
            targetSubmissions.add(String(change.value.id));
      });
      try {
        await until(() =>
          phase === "call" ? entered : source.executed.length === 1,
        );
        const copy = await storage.snapshot();
        await source.close();
        await work;
        const active =
          Promise.withResolvers<Awaited<ReturnType<typeof fixture>>>();
        reopened = await fixture({
          storage: copy,
          conversationId: source.conversation.id,
          toolName,
          executionMode: "sequential",
          execute: async (n, _read, _signal, api) => {
            if (n === 1 && toolName === "message") {
              target.fake.frames.push({ text: "unrequested target answer" });
              await target.submit("automatic recovered message");
            } else if (n === 1 && toolName === "subagent") {
              const run = await active.promise;
              const child = await run.harness.createConversation(
                {
                  ownership: { kind: "ownerless" },
                  agent: {
                    model: { provider: "subscription", modelId: "sonnet" },
                  },
                },
                context,
              );
              run.fake.frames.push({ text: "unrequested child answer" });
              await (
                await child.submit(
                  {
                    type: "input",
                    content: "automatic child request",
                    requestId: "subagent:t",
                  },
                  context,
                )
              ).wait(context);
            }
            return {
              content: [{ type: "text", text: `ran ${n} for ${api.callId}` }],
            };
          },
        });
        active.resolve(reopened);
        // Attach must finish durable abort marks while scheduling is still paused.
        const attached = await reopened.harness.inspect(context);
        expect(attached.scheduling).toBe("paused");
        expect(
          attached.tasks
            .filter(({ record }) => record.kind === ToolTask.definition.name)
            .map(({ record }) => record.abortRequested),
        ).toEqual([toolName !== "read"]);
        await reopened.harness.waitForIdle(context);
        expect(targetSubmissions.size).toBe(0);
        expect(target.fake.requests).toEqual([]);
        expect(reopened.executed).toEqual(
          toolName === "read" ? (phase === "call" ? [1, 3] : [1]) : [],
        );
        expect(reopened.fake.requests).toEqual([]);
        const results = (await reopened.messages()).filter(
          (message) => message.role === "toolResult",
        );
        // The second sequential task did not exist at attach and must inherit its generation's gate.
        expect(results).toHaveLength(phase === "call" ? 2 : 1);
        expect(results.every((result) => result.isError)).toBe(
          toolName !== "read",
        );
        const result = (await reopened.messages()).find(
          (message) => message.role === "toolResult",
        );
        expect(result).toMatchObject({
          toolName,
          isError: toolName !== "read",
        });
        if (toolName !== "read") {
          expect(JSON.stringify(result)).toContain(
            `Tool ${toolName} was aborted`,
          );
          if (phase === "call")
            expect(JSON.stringify(results[1])).toContain(
              "Tool call blocked: Stopped when Neuve restarted.",
            );
        }
        reopened.fake.frames.push(
          { calls: [{ callId: "requested", toolName, input: { n: 2 } }] },
          { text: "requested answer" },
        );
        expect((await reopened.submit("person asks to continue")).status).toBe(
          "done",
        );
        if (toolName !== "read") {
          expect(JSON.stringify(reopened.fake.requests[0]?.input)).toContain(
            `The ${toolName} call returned an error:`,
          );
          expect(JSON.stringify(reopened.fake.requests[0]?.input)).toContain(
            `Tool ${toolName} was aborted`,
          );
        } else
          expect(JSON.stringify(reopened.fake.requests[0]?.input)).toContain(
            "ran 1 for recovered",
          );
        expect(reopened.executed).toEqual(
          toolName === "read" ? (phase === "call" ? [1, 3, 2] : [1, 2]) : [2],
        );
      } finally {
        stop();
        await reopened?.close();
        await target.close();
        await source.close();
        await work;
      }
    });
  }
}

// Loop ownership is the boundary: pi tools retain their behavior in either durable phase.
for (const phase of ["call", "execute"] as const) {
  test(`a recovered bash in ${phase} on a pi account still executes`, async () => {
    const storage = new CapturedStorage();
    const source = await fixture({
      storage,
      toolName: "bash",
      execute: waitForClose,
    });
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    let entered = false;
    if (phase === "call")
      source.pi.install(
        defineExtension({
          name: "hold-pi-before-intent",
          hooks: [
            hook(ToolTask, {
              async beforeTool(_call, _api, callContext) {
                entered = true;
                await waitForAbort(callContext.abortSignal);
              },
            }),
          ],
        }),
      );
    await source.conversation.configure(
      { model: { provider: "faux", modelId: "coder" } },
      context,
    );
    source.faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "pi-bash",
            name: "bash",
            arguments: { n: 1 },
          },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const work = source.submit("pi request").catch(() => undefined);
    try {
      await until(() =>
        phase === "call" ? entered : source.executed.length === 1,
      );
      const copy = await storage.snapshot();
      await source.close();
      await work;
      reopened = await fixture({
        storage: copy,
        conversationId: source.conversation.id,
        toolName: "bash",
      });
      reopened.faux.setResponses([fauxAssistantMessage("pi resumed reply")]);
      await reopened.harness.waitForIdle(context);
      expect(reopened.executed).toEqual([1]);
      expect(
        (await reopened.messages()).findLast(
          (message) => message.role === "assistant",
        )?.stopReason,
      ).toBe("stop");
      expect(reopened.fake.requests).toEqual([]);
    } finally {
      await reopened?.close();
      await source.close();
      await work;
    }
  });
}

async function waitForAbort(signal: AbortSignal | undefined) {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitForClose(
  _n: number,
  _read: unknown,
  signal: AbortSignal | undefined,
) {
  await waitForAbort(signal);
  return { content: [{ type: "text" as const, text: "old result" }] };
}
