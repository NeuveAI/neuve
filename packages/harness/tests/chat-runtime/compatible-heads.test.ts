import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { RuntimeRegistryShape } from "@neuve/runtime";
import {
  ChatRuntimeBridge,
  NativeHeads,
} from "../../src/chat-runtime/index.ts";
import { resumeFailed } from "../../src/chat-runtime/failure.ts";
import { headDigest } from "../../src/chat-runtime/transcript.ts";
import { account, caps, context, fixture } from "./fixture.ts";

const known = {
  session: "saved-session",
  resumePoint: "saved-point",
  digest: headDigest([]),
  continuation: { runtime: "claude-code", key: "/shared" },
  previousDigest: headDigest([]),
  completed: true,
} satisfies Parameters<NativeHeads["set"]>[1];
const newer = {
  ...known,
  future: { flag: true },
  forkedFrom: { session: "parent", resumePoint: "parent-point", future: 7 },
  inputs: [{ kind: "message", through: "input", future: "retained" }],
};

async function inDirectory(
  run: (directory: string, path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "compatible-heads-"));
  try {
    await run(directory, join(directory, "native-heads.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Newer keys at every object depth must not prevent the coding session's setup.
test("native heads and session setup read additive top-level and nested fields", () =>
  inDirectory(async (directory, path) => {
    await writeFile(path, JSON.stringify({ saved: newer }));
    const run = await fixture({ headsDirectory: directory });
    try {
      expect(run.heads.get("saved")).toEqual({
        ...known,
        forkedFrom: { session: "parent", resumePoint: "parent-point" },
        inputs: [{ kind: "message", through: "input" }],
      });
    } finally {
      await run.close();
    }
  }));

// A known update must retain the newer writer's keys without reviving stale known fields.
test("setting an additive head preserves newer fields through repeated write-back", () =>
  inDirectory(async (directory, path) => {
    await writeFile(path, JSON.stringify({ saved: newer }));
    const heads = await NativeHeads.open(directory);
    try {
      const before = heads.get("saved")!;
      await heads.set("saved", { ...before, digest: "updated" });
      await heads.set("other", known);
      expect(JSON.parse(await readFile(path, "utf8")).saved).toEqual({
        ...newer,
        digest: "updated",
      });
      const reopened = await NativeHeads.open(directory);
      try {
        expect(reopened.get("saved")?.digest).toBe("updated");
      } finally {
        await reopened.close();
      }
    } finally {
      await heads.close();
    }
  }));

// An unreadable owner must never open or send, while a sibling chat still resumes and writes.
test("a refused head fails only its own chat and retains its original JSON bytes", () =>
  inDirectory(async (directory, path) => {
    let registry: RuntimeRegistryShape | undefined;
    const run = await fixture({ registry: (value) => (registry = value) });
    let bridge: ChatRuntimeBridge | undefined;
    try {
      const good = await run.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      const messages: Message[] = [
        { role: "user", content: "saved input", timestamp: 1 },
        { role: "user", content: "good chat", timestamp: 2 },
      ];
      const goodHead = { ...known, digest: headDigest(messages.slice(0, 1)) };
      const refused =
        '{ "session" : "future", "digest": "saved", "inputs": [{"kind":"future","through":"input"}], "future": [1e2, "\\u0061", {"text":"},:\\\""}] }';
      await writeFile(
        path,
        `{${JSON.stringify(String(run.conversation.id))}:${refused},${JSON.stringify(String(good.id))}:${JSON.stringify(goodHead)}}`,
      );
      const heads = await NativeHeads.open(directory);
      bridge = new ChatRuntimeBridge({ registry: registry!, heads });
      const route = {
        name: account().name,
        capabilities: caps,
        continuation: known.continuation,
      };
      const model = run.models.getModel("subscription", "sonnet")!;
      const blocked: Message[] = [
        { role: "user", content: "continue", timestamp: 1 },
      ];
      for (let attempt = 0; attempt < 2; attempt++) {
        bridge.identify(blocked, run.conversation.id, `blocked-${attempt}`);
        const result = await bridge
          .stream(route, model, { messages: blocked })
          .result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toBe(resumeFailed);
      }
      expect(run.fake.opened).toHaveLength(0);
      expect(run.fake.requests).toHaveLength(0);
      bridge.identify(messages, good.id, "good");
      run.fake.frames.push({ text: "continued" });
      const result = await bridge.stream(route, model, { messages }).result();
      expect(result.stopReason).toBe("stop");
      expect(run.fake.opened).toHaveLength(1);
      expect(run.fake.opened[0]?.start).toEqual({
        kind: "resume",
        session: "saved-session",
        fork: false,
      });
      expect(run.fake.requests).toHaveLength(1);
      await bridge.close();
      expect(await readFile(path, "utf8")).toContain(`:${refused},`);
      await expect(
        heads.set(String(run.conversation.id), known),
      ).rejects.toThrow(resumeFailed);
      expect(await readFile(path, "utf8")).toContain(`:${refused},`);
    } finally {
      await bridge?.close();
      await run.close();
    }
  }));

// Losing the location of a newer nested field must refuse the update and retain the old entry.
test("a head whose newer fields cannot survive an update becomes refused", () =>
  inDirectory(async (directory, path) => {
    await writeFile(path, JSON.stringify({ saved: newer, other: known }));
    const heads = await NativeHeads.open(directory);
    try {
      await expect(heads.set("saved", known)).rejects.toThrow(resumeFailed);
      await expect(heads.set("saved", known)).rejects.toThrow(resumeFailed);
      await heads.set("other", { ...known, digest: "other-updated" });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        saved: newer,
        other: { ...known, digest: "other-updated" },
      });
    } finally {
      await heads.close();
    }
  }));

// A preservation refusal before sending or while saving a receipt must stop that chat visibly.
test.each(["opening", "receipt"])(
  "a write-back refusal during %s ends the bridge turn and prevents further requests",
  (phase) =>
    inDirectory(async (directory, path) => {
      let registry: RuntimeRegistryShape | undefined;
      const run = await fixture({ registry: (value) => (registry = value) });
      let bridge: ChatRuntimeBridge | undefined;
      try {
        const owner = String(run.conversation.id);
        const messages: Message[] = [
          { role: "user", content: "saved input", timestamp: 1 },
          { role: "user", content: "next", timestamp: 2 },
        ];
        const saved = {
          ...known,
          digest: headDigest(messages.slice(0, 1)),
          forkedFrom: newer.forkedFrom,
          ...(phase === "opening" ? { inputs: newer.inputs } : {}),
        };
        await writeFile(path, JSON.stringify({ [owner]: saved }));
        const heads = await NativeHeads.open(directory);
        bridge = new ChatRuntimeBridge({ registry: registry!, heads });
        const route = {
          name: account().name,
          capabilities: caps,
          continuation: known.continuation,
        };
        const model = run.models.getModel("subscription", "sonnet")!;
        run.fake.frames.push({ text: "answer" });
        for (let attempt = 0; attempt < 2; attempt++) {
          bridge.identify(
            messages,
            run.conversation.id,
            `write-refusal-${attempt}`,
          );
          const result = await bridge
            .stream(route, model, { messages })
            .result();
          expect(result.stopReason).toBe("error");
          expect(result.errorMessage).toBe(resumeFailed);
        }
        await bridge.close();
        expect(run.fake.opened).toHaveLength(1);
        expect(run.fake.opened[0]?.session.closed).toBe(1);
        expect(run.fake.requests).toHaveLength(phase === "opening" ? 0 : 1);
        const disk = JSON.parse(await readFile(path, "utf8"))[owner];
        expect(disk.forkedFrom).toEqual(newer.forkedFrom);
        if (phase === "opening") expect(disk).toEqual(saved);
      } finally {
        await bridge?.close();
        await run.close();
      }
    }),
);

// Per-head tolerance must not turn a non-object file into an empty store.
test("non-object native-head files remain failures", () =>
  inDirectory(async (directory, path) => {
    for (const invalid of ["null", "[]", '"text"', "1", "true"]) {
      await writeFile(path, invalid);
      await expect(NativeHeads.open(directory)).rejects.toThrow();
    }
  }));

// Rollback of a head created by this build still removes it instead of retaining a phantom head.
test("restoring a newly written head with no previous head removes it", () =>
  inDirectory(async (directory, path) => {
    const heads = await NativeHeads.open(directory);
    try {
      await heads.set("saved", known);
      await heads.restore("saved", known, undefined);
      expect(heads.get("saved")).toBeUndefined();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({});
    } finally {
      await heads.close();
    }
  }));
