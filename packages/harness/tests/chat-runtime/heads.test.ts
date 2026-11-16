import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headDigest } from "../../src/chat-runtime/transcript.ts";
import { NativeHeads } from "../../src/chat-runtime/heads.ts";
import { fixture } from "./fixture.ts";

test("native heads reopen from disk with their conversation owner, so a worker restart preserves safe resume decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-runtime-heads-"));
  const run = await fixture({ headsDirectory: directory });
  try {
    run.fake.frames.push({ text: "saved" });
    await run.submit("first");
    await run.bridge.close();
    const heads = await NativeHeads.open(directory);
    expect(heads.get(String(run.conversation.id))).toEqual({
      session: "session-1",
      continuation: { runtime: "claude-code", key: "/shared" },
      previousDigest: run.heads.get(String(run.conversation.id))!
        .previousDigest,
      resumePoint: "point-1",
      completed: true,
      checkpointThrough: run.heads.get(String(run.conversation.id))!
        .checkpointThrough,
      digest: run.heads.get(String(run.conversation.id))!.digest,
    });
    expect(await readdir(directory)).toEqual(["native-heads.json"]);
    await heads.close();
  } finally {
    await run.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ruling 25(b) persists a failed first turn as requiring fresh replay", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "chat-runtime-partial-heads-"),
  );
  const run = await fixture({ headsDirectory: directory });
  try {
    run.fake.frames.push({
      beforeMessage: () =>
        run.fake.opened[0]!.session.emit({ type: "text", text: "partial" }),
      failure: {
        _tag: "TurnFailed",
        account: run.statuses.values[0]!.name,
        reason: "provider-failed",
      },
    });
    await run.submit("first");
    await run.bridge.close();
    const heads = await NativeHeads.open(directory);
    expect(heads.get(String(run.conversation.id))).toEqual({
      session: "session-1",
      continuation: { runtime: "claude-code", key: "/shared" },
      previousDigest: run.heads.get(String(run.conversation.id))!
        .previousDigest,
      forkRequired: true,
      inputs: [{ kind: "message", through: headDigest(await run.messages()) }],
      digest: run.heads.get(String(run.conversation.id))!.digest,
    });
    expect(await readdir(directory)).toEqual(["native-heads.json"]);
    await heads.close();
  } finally {
    await run.close();
    await rm(directory, { recursive: true, force: true });
  }
});
