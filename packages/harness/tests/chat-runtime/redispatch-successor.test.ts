import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import { context, fixture, until } from "./fixture.ts";

const TMP = tmpdir();

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

// A tools-phase successor has a new task ID but still belongs to the gated conversation.
test("restart during a tool round must not send the round's results to Claude", async () => {
  const storage = new CapturedStorage();
  const live = await mkdtemp(join(TMP, "heads-live-"));
  const crashed = await mkdtemp(join(TMP, "heads-crash-"));
  const source = await fixture({
    storage,
    headsDirectory: live,
    execute: async (_n, _read, signal) => {
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { content: [{ type: "text", text: "never" }] };
    },
  });
  source.fake.frames.push({
    calls: [{ callId: "c1", toolName: "probe", input: { n: 1 } }],
  });
  const work = source.submit("run the probe").catch(() => undefined);
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await until(() => source.executed.length === 1);
    // Crash snapshot: pi storage and the head file at the same instant.
    const copy = await storage.snapshot();
    await copyFile(
      join(live, "native-heads.json"),
      join(crashed, "native-heads.json"),
    );
    await source.close();
    await work;
    reopened = await fixture({
      storage: copy,
      conversationId: source.conversation.id,
      headsDirectory: crashed,
      // The reopened fake would number its first session "session-1" again; keep ids unique.
      registry: (registry) => ({
        ...registry,
        openSession: (...args) =>
          registry.openSession(...args).pipe(
            Effect.map((session) => ({
              ...session,
              get nativeSessionId() {
                return `reopened-${session.nativeSessionId}`;
              },
            })),
          ),
      }),
    });
    reopened.fake.frames.push({ text: "automatic reply" });
    expect(reopened.fake.opened).toEqual([]);
    await reopened.harness.waitForIdle(context);
    await Bun.sleep(200);
    const sent = JSON.stringify(reopened.fake.requests);
    const opened = reopened.fake.opened.map((item) => item.start);
    // Ruling 28b aborts the unlisted probe; its successor still waits behind the gate.
    expect(reopened.executed).toEqual([]);
    expect(JSON.stringify(await reopened.messages())).toContain(
      "Tool probe was aborted",
    );
    // Ruling 26: nothing may be opened or sent without the person asking.
    expect(opened).toEqual([]);
    expect(sent).toBe("[]");
  } finally {
    await reopened?.close();
    await source.close();
    await work;
    await rm(live, { recursive: true, force: true });
    await rm(crashed, { recursive: true, force: true });
  }
});
