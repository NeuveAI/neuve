import { expect, test } from "bun:test";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { context, fixture, until } from "./fixture.ts";

class CapturedStorage extends MemoryStorage {
  readonly commits: (readonly StorageWrite[])[] = [];
  override async commit(...args: Parameters<MemoryStorage["commit"]>) {
    const seq = await super.commit(...args);
    this.commits.push(structuredClone(args[0]));
    return seq;
  }
  async snapshot() {
    const storage = new MemoryStorage();
    for (const writes of [...this.commits])
      await storage.commit(writes, context);
    return storage;
  }
}

// Ruling 26 must stop pi's actual re-dispatch before any native open, yet accept the next explicit message.
for (const signedOut of [false, true]) {
  test(`worker reopen stops the surviving loop-owning generation without opening or sending${signedOut ? " while signed out" : ""}`, async () => {
    const storage = new CapturedStorage();
    let accepted = false;
    const source = await fixture({
      storage,
      registry: (registry) => ({
        ...registry,
        openSession: (...args) =>
          registry.openSession(...args).pipe(
            Effect.map((session) => ({
              ...session,
              get nativeSessionId() {
                return session.nativeSessionId;
              },
              startTurn: () =>
                Effect.sync(() => {
                  accepted = true;
                }),
            })),
          ),
      }),
    });
    let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
    const work = source
      .submit("committed before worker reopen")
      .catch(() => undefined);
    try {
      await until(() => accepted);
      const copy = await storage.snapshot();
      const inspection = await source.harness.inspect(context);
      expect(
        inspection.tasks.some(
          ({ record }) =>
            record.kind === "pi.generation" &&
            record.state.status === "running",
        ),
      ).toBe(true);
      await source.close();
      await work;
      reopened = await fixture({
        storage: copy,
        conversationId: source.conversation.id,
      });
      if (signedOut)
        reopened.statuses.set(
          reopened.statuses.values.map((status) => ({
            ...status,
            signIn: {
              state: "not-signed-in",
              hint: { kind: "settings", entry: "accounts" },
            },
          })),
        );
      expect(reopened.fake.opened).toEqual([]);
      await reopened.harness.waitForIdle(context);
      expect(reopened.fake.opened).toEqual([]);
      expect(reopened.fake.requests).toEqual([]);
      const stopped = (await reopened.conversation.context(context)).entries
        .flatMap((entry) => entry.model ?? [])
        .findLast((message) => message.role === "assistant");
      expect(stopped?.stopReason).toBe("aborted");
      expect(stopped?.errorMessage).toBeUndefined();
      if (signedOut)
        reopened.statuses.set(
          reopened.statuses.values.map((status) => ({
            ...status,
            signIn: { state: "signed-in" },
          })),
        );
      reopened.fake.frames.push({ text: "new reply" });
      expect((await reopened.submit("new explicit message")).status).toBe(
        "done",
      );
      expect(reopened.fake.opened).toHaveLength(1);
      expect(reopened.fake.requests).toHaveLength(1);
      expect(reopened.fake.requests[0]?.input).toEqual([
        { type: "text", text: "committed before worker reopen" },
        { type: "text", text: "new explicit message" },
      ]);
    } finally {
      await reopened?.close();
      await source.close();
      await work;
    }
  });
}

// Ruling 26 is limited to ownsLoop; pi's surviving generation must still complete through its original Models path.
test("worker reopen keeps pi-account re-dispatch unchanged", async () => {
  const storage = new CapturedStorage();
  const source = await fixture({ storage });
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  const slow = fauxProvider({
    provider: "slow",
    models: [{ id: "coder" }],
    tokensPerSecond: 1,
  });
  source.native.setProvider(slow.provider);
  slow.setResponses([fauxAssistantMessage("a slow pi reply")]);
  await source.conversation.configure(
    { model: { provider: "slow", modelId: "coder" } },
    context,
  );
  const submission = await source.conversation.submit(
    { type: "input", content: "pi restart input" },
    context,
  );
  try {
    // Capture a real running request checkpoint before the faux provider finishes streaming.
    await until(async () =>
      (await source.harness.inspect(context)).tasks.some(
        ({ record }) =>
          record.kind === "pi.generation" &&
          record.state.status === "running" &&
          typeof record.state.checkpoint === "object" &&
          record.state.checkpoint !== null &&
          !Array.isArray(record.state.checkpoint) &&
          record.state.checkpoint.phase === "request",
      ),
    );
    const copy = await storage.snapshot();
    await source.close();
    reopened = await fixture({
      storage: copy,
      conversationId: source.conversation.id,
    });
    const resumedProvider = fauxProvider({
      provider: "slow",
      models: [{ id: "coder" }],
      tokensPerSecond: 100_000,
    });
    resumedProvider.setResponses([fauxAssistantMessage("pi resumed reply")]);
    reopened.native.setProvider(resumedProvider.provider);
    await reopened.harness.waitForIdle(context);
    const resumed = await reopened.harness.submission(submission.id, context);
    expect((await resumed?.wait(context))?.status).toBe("done");
    const messages = await reopened.messages();
    expect(
      messages.findLast((message) => message.role === "assistant"),
    ).toMatchObject({ provider: "slow", stopReason: "stop" });
    expect(JSON.stringify(messages)).toContain("pi resumed reply");
    expect(reopened.fake.opened).toEqual([]);
    expect(reopened.fake.requests).toEqual([]);
  } finally {
    await reopened?.close();
    await source.close();
  }
});
