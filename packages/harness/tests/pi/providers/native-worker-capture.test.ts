import { stopStoreWorker } from "../../../../records-core/tests/worker-process.ts";
import { storeLocationIn } from "@neuve/records-core";
import { runIn, value } from "../capture/fixture.ts";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import {
  CaptureRecords,
  exportCapturedDump,
  exportPortableSnapshot,
  exportSnapshot,
  openCaptureJournal,
  readSessionDump,
} from "../../../src/session-dump.ts";
import { exportWhileOpen } from "../capture/open-source.ts";
import {
  created,
  completed,
  functionCallItem,
  messageItem,
  reasoningItem,
  sse,
} from "./fixture.ts";

const key = "synthetic-native-worker-key-a37b9f";
const thought = "synthetic-legitimate-thought";
const thoughts = "synthetic-legitimate-thoughts";
const reasoning = "synthetic-native-raw-reasoning";
const encrypted = "synthetic-native-raw-encrypted";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const frame = z.union([
  z.object({ id: z.number(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
  z.object({ id: z.number(), event: z.unknown() }),
]);

// R8 crosses native dispatch, physical SDK transport, durable journal and public dump exports.
test("actual non-route native worker keeps credential-masked raw reasoning and thought fields and preserves uncertified dump refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "r8-"));
  const evidence = process.env["NATIVE_CAPTURE_EVIDENCE"];
  const id = "c8a7b6d5e4f32100";
  const home = join(root, "h");
  const state = join(home, "channels", id);
  for (const path of [
    state,
    join(root, "tmp"),
    join(root, "lanes"),
    join(root, "project"),
  ])
    mkdirSync(path, { recursive: true });
  // A real channel's project admission requires a committed Git repository before chat placement.
  for (const args of [
    ["init", "-q", "-b", "main"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@neuve.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "fixture",
    ],
  ]) {
    const result = Bun.spawnSync(["git", "-C", join(root, "project"), ...args]);
    if (!result.success)
      throw new Error(`Native fixture Git admission failed: ${result.stderr}`);
  }
  writeFileSync(
    join(state, "channel.json"),
    JSON.stringify({
      version: 2,
      id,
      name: "raw-proof",
      prefix: "raw-proof",
      named: true,
      owner: "fixture",
      local: true,
      project: join(root, "project"),
      created: Date.now(),
    }),
  );
  const received: Array<{
    path: string;
    body: unknown;
    credentialMatched: boolean;
  }> = [];
  let generations = 0;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body: unknown = await request.json();
      received.push({
        path: new URL(request.url).pathname,
        body,
        credentialMatched:
          request.headers.get("authorization") === `Bearer ${key}`,
      });
      const first = ++generations === 1;
      return sse([
        created(`native-${generations}`),
        ...(first
          ? [
              ...reasoningItem(0, "r8-reasoning", encrypted),
              {
                type: "response.reasoning_summary_text.delta",
                output_index: 0,
                summary_index: 0,
                delta: reasoning,
              },
              ...functionCallItem(1, {
                id: "r8-tool",
                callId: "r8-call",
                name: "bash",
                arguments: JSON.stringify({
                  command: "printf native-tool-proof",
                  thought,
                  thoughts: [thoughts],
                }),
              }).map(({ item, ...event }) => ({
                ...event,
                ...(item && typeof item === "object"
                  ? {
                      item: Object.fromEntries(
                        Object.entries(item).filter(
                          ([name]) => name !== "namespace",
                        ),
                      ),
                    }
                  : {}),
              })),
            ]
          : messageItem(
              0,
              "r8-answer",
              "final_answer",
              "Native fixture complete",
            )),
        completed(`native-${generations}`),
      ]);
    },
  });
  const fixture = join(
    import.meta.dir,
    "../../fixtures/native-worker-capture.ts",
  );
  const environment = Object.fromEntries(
    Object.entries({
      PATH: process.env["PATH"],
      TMPDIR: root,
      TMP: process.env["TMP"],
      TEMP: process.env["TEMP"],
      BUN_TMPDIR: process.env["BUN_TMPDIR"],
      BUN_RUNTIME_TRANSPILER_CACHE_PATH:
        process.env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"],
      XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
      HOME: home,
      ACE_HOME: home,
      ACE_CONFIG_HOME: join(home, "settings"),
      ACE_KEYCHAIN_SERVICE: "synthetic-r8-private",
      NATIVE_CAPTURE_ROOT: root,
      NATIVE_CAPTURE_ENDPOINT: endpoint.url.origin,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const config = {
    home,
    lanes: join(root, "lanes"),
    user: "fixture",
    port: 0,
    channelScope: "local",
    environment,
    worker: [process.execPath, fixture],
    workerCloseTimeoutMs: 60000,
  };
  const worker = Bun.spawn([process.execPath, fixture, id], {
    env: { ...environment, NEUVE_HOST_CONFIG: JSON.stringify(config) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(worker.stdout).text();
  const stderr = new Response(worker.stderr).text();
  let socket: ReturnType<typeof connect> | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(state, "channel.sock"))) {
      if (Date.now() > deadline || worker.exitCode !== null)
        throw new Error(`Native worker did not open in fixture ${root}`);
      await Bun.sleep(10);
    }
    socket = connect(join(state, "channel.sock"));
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", resolve);
      socket!.once("error", reject);
    });
    let buffer = "";
    let next = 1;
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    socket.on("close", () => {
      for (const receiver of pending.values())
        receiver.reject(new Error("Native fixture IPC closed"));
      pending.clear();
    });
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const parsed = frame.parse(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
        if ("event" in parsed) continue;
        const receiver = pending.get(parsed.id);
        pending.delete(parsed.id);
        if (parsed.ok) receiver?.resolve(parsed.value);
        else receiver?.reject(new Error(parsed.error));
      }
    });
    const request = (body: Record<string, unknown>) =>
      new Promise<unknown>((resolve, reject) => {
        const requestId = next++;
        pending.set(requestId, { resolve, reject });
        socket!.write(`${JSON.stringify({ id: requestId, ...body })}\n`);
      });
    const selected = z
      .object({
        native: z.object({
          provider: z.string(),
          modelId: z.string(),
          api: z.string(),
        }),
        configured: z.object({ provider: z.string(), modelId: z.string() }),
      })
      .parse(JSON.parse(readFileSync(join(root, "selection.json"), "utf8")));
    expect(selected.native.modelId).not.toBe(selected.configured.modelId);
    const submission = z.object({ submission: z.number() }).parse(
      await request({
        op: "ask",
        author: "fixture",
        text: "Run the native capture fixture",
        model: {
          provider: selected.native.provider,
          modelId: selected.native.modelId,
        },
      }),
    );
    expect(
      await request({ op: "wait", submission: submission.submission }),
    ).toBe("done");
    const settledBy = Date.now() + 5000;
    while (
      generations < 3 ||
      (
        readFileSync(join(state, "capture/events.jsonl"), "utf8").match(
          /"type":"model.end"/g,
        ) ?? []
      ).length < 3
    ) {
      if (Date.now() > settledBy)
        throw new Error("Native caption did not settle");
      await Bun.sleep(10);
    }
    worker.kill("SIGTERM");
    expect(await worker.exited).toBe(0);
    const logs = { stdout: await stdout, stderr: await stderr };
    const nativeLog = readFileSync(
      join(home, "logs", `channel-${id}.jsonl`),
      "utf8",
    );
    const toolEnds = nativeLog
      .trim()
      .split("\n")
      .map((line) =>
        z.object({ event: z.string() }).passthrough().parse(JSON.parse(line)),
      )
      .filter((line) => line.event === "tool.end")
      .map((line) =>
        z
          .object({ event: z.literal("tool.end"), error: z.boolean() })
          .parse(line),
      );
    expect(toolEnds).toEqual([{ event: "tool.end", error: false }]);
    expect(generations).toBeGreaterThanOrEqual(2);
    expect(received.every((request) => request.credentialMatched)).toBe(true);
    expect(received.every((request) => request.path === "/v1/responses")).toBe(
      true,
    );
    expect(
      received.map(
        (request) => z.object({ model: z.string() }).parse(request.body).model,
      ),
    ).not.toContain(selected.configured.modelId);
    const journal = readFileSync(join(state, "capture/events.jsonl"));
    const raw = journal.toString();
    for (const marker of [
      reasoning,
      encrypted,
      thought,
      thoughts,
      "synthetic-schema-thought",
    ])
      expect(raw).toContain(marker);
    expect(raw).not.toContain(key);
    expect(raw).toContain('"name":"native_capture_gap"');
    expect(raw).not.toContain('"name":"sdk_invocation_end"');
    const reason =
      "call 1: SDK context unavailable; frame 0 other/other; callbacks 0/unknown (retained-stream-prefix); unavailable credential source census; source retained privately, export refused";
    expect(
      JSON.parse(readFileSync(join(state, "worker-close.json"), "utf8")),
    ).toMatchObject({ ok: true, errors: [] });
    const captureLocation = storeLocationIn(join(root, "captures/coding"));
    const run = runIn(captureLocation);
    const filed = value(await run(CaptureRecords.rawCaptures(0, id))).at(-1)!;
    if (filed._tag === "Invalid") throw new Error(filed.reason);
    let status;
    for (let i = 0; i < 300; i++) {
      status = value(await run(CaptureRecords.scanStatus(filed.rawCapture)));
      if (status.status !== "pending") break;
      await Bun.sleep(100);
    }
    expect(status).toMatchObject({ status: "refused", reason });
    const refused = await run(
      exportCapturedDump({
        capture: filed.rawCapture,
        root: join(root, "public-dump"),
        retention: { policy: "synthetic R8 native refusal" },
      }),
    );
    expect(refused._tag).toBe("Failure");
    const database = readFileSync(join(state, "channel.sqlite"));
    for (const marker of [thought, thoughts])
      expect(database.includes(marker)).toBe(true);
    expect(database.includes(key)).toBe(false);
    await expect(
      exportWhileOpen({
        runId: id,
        journal: join(state, "capture"),
        nativeDatabase: join(state, "channel.sqlite"),
        root: join(root, "public-dump"),
        retention: { policy: "synthetic R8 native refusal" },
      }),
    ).rejects.toMatchObject({
      _tag: "DumpFailed",
      reason: expect.stringMatching(new RegExp(`${RegExp.escape(reason)}$`)),
    });
    expect(readFileSync(join(state, "channel.sqlite"))).toEqual(database);
    expect(readFileSync(join(state, "capture/events.jsonl"))).toEqual(journal);
    const receipt = {
      root,
      selected,
      received: received.map(({ body, ...request }) => ({
        ...request,
        body: JSON.stringify(body).replaceAll(key, "[REDACTED]"),
      })),
      journalSha256: hash(journal),
      databaseSha256: hash(database),
      publicDumpRefusal: reason,
      nativeLog,
      logs,
    };
    console.log("NATIVE_RAW_CAPTURE_PROOF", JSON.stringify(receipt));
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "worker-proof.json"),
        JSON.stringify(receipt, null, 2),
      );
    }
  } finally {
    socket?.destroy();
    if (worker.exitCode === null) {
      worker.kill("SIGTERM");
      await worker.exited;
    }
    await stopStoreWorker(storeLocationIn(join(root, "captures/coding")));
    endpoint.stop(true);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "worker.stdout.log"), await stdout);
      writeFileSync(join(evidence, "worker.stderr.log"), await stderr);
      writeFileSync(join(evidence, "fixture-root.txt"), root);
    }
    if (!evidence) rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test("public portable export withholds synthetic reasoning while preserving thought fields and byte-exact restricted originals", async () => {
  const root = mkdtempSync(join(tmpdir(), "r8-portable-"));
  const evidence = process.env["NATIVE_CAPTURE_EVIDENCE"];
  try {
    mkdirSync(join(root, "datasets"));
    const journal = openCaptureJournal(join(root, "journal"), "r8-portable");
    journal.capture({
      type: "run.start",
      scope: { runId: "r8-portable" },
      runKind: "coding",
      sourceRevision: {
        status: "not-applicable",
        reason: "Synthetic portable export fixture",
      },
      route: "synthetic",
      pricing: "subscription",
    });
    const original = Buffer.from(
      JSON.stringify({
        type: "thinking",
        thinking: reasoning,
        signature: encrypted,
        tool: { thought, thoughts: [thoughts] },
      }) + "\n",
    );
    journal.capture({
      type: "artifact",
      scope: { runId: "r8-portable" },
      name: "synthetic-reasoning.json",
      mediaType: "application/json",
      bytes: original,
    });
    journal.close();
    const rawJournal = readFileSync(join(root, "journal/events.jsonl"));
    const restricted = await exportSnapshot({
      runId: "r8-portable",
      journal: join(root, "journal"),
      root: join(root, "datasets"),
      retention: { policy: "synthetic portable R8 fixture" },
    });
    const dump = await Effect.runPromise(readSessionDump(restricted.directory));
    const object = (name: string) => {
      const manifest = z
        .object({
          files: z.array(z.object({ name: z.string(), sha256: z.string() })),
        })
        .parse(
          JSON.parse(
            readFileSync(join(restricted.directory, "manifest.json"), "utf8"),
          ),
        );
      const entry = manifest.files.find((file) => file.name === name);
      if (!entry) throw new Error(`Missing dump file ${name}`);
      return readFileSync(join(restricted.directory, "objects", entry.sha256));
    };
    expect(dump.run.journal.status).toBe("captured");
    expect(object("journal/events.jsonl")).toEqual(rawJournal);
    const artifact = dump.run.artifacts[0];
    if (!artifact?.original.file)
      throw new Error("Restricted artifact original absent");
    expect(artifact.original.file).toEndWith(".original");
    expect(object(artifact.original.file)).toEqual(original);
    const portable = await exportPortableSnapshot({
      directory: restricted.directory,
      root: join(root, "datasets"),
      retention: { policy: "synthetic portable R8 fixture" },
    });
    const inspection = await Effect.runPromise(
      readSessionDump(portable.directory),
    );
    const portableObjects = readdirSync(join(portable.directory, "objects"))
      .map((name) =>
        readFileSync(join(portable.directory, "objects", name), "utf8"),
      )
      .join("\n");
    for (const marker of [reasoning, encrypted, key])
      expect(portableObjects).not.toContain(marker);
    for (const marker of [thought, thoughts])
      expect(portableObjects).toContain(marker);
    expect(inspection.run.journal.status).toBe("withheld");
    expect(inspection.run.backup.status).toBe("withheld");
    expect(inspection.run.artifacts[0]?.original.file).toBeNull();
    expect(object("journal/events.jsonl")).toEqual(rawJournal);
    expect(object(artifact.original.file)).toEqual(original);
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "portable-proof.json"),
        JSON.stringify(
          {
            root,
            restricted: restricted.directory,
            portable: portable.directory,
            journalSha256: hash(rawJournal),
            originalSha256: hash(original),
            nativeBackup: inspection.run.backup,
            rawJournal: inspection.run.journal,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    if (!evidence) rmSync(root, { recursive: true, force: true });
  }
});
