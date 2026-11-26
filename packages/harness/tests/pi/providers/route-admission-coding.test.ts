import { runIn, value, scanCaptures } from "../capture/fixture.ts";
import { CaptureRecords } from "../../../src/session-dump.ts";
import { Effect } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  hook,
  CompactionTask,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../../../scripts/pi-storage.ts";
import { codingWorkerSetup } from "../../../../../apps/neuve-cli/src/workspace-cli.ts";
import * as WorkerCli from "../../../../../apps/neuve-cli/src/worker-cli.ts";
import { openWorkerStorage, type WorkerContext } from "@ace/host/worker";
import {
  Fixture,
  OWNER,
} from "../../../../../packages/channel/tests/helpers.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import { rejectedToken } from "../../../src/openai-auth.ts";
import { readCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { openRouteAdmission, createRouteModels } from "../../../src/coding.ts";
import {
  openEndpoint,
  tokenCommand,
  sse,
  created,
  messageItem,
  completed,
} from "./fixture.ts";

const nativeModels = () =>
  builtinModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });

const model = { provider: "openai", modelId: SOL_ROUTE.model };
const root = () => mkdtempSync(join(tmpdir(), "coding-route-admission-"));
const worker = (path: string): WorkerContext => ({
  sessionId: "coding-route-proof",
  stateDirectory: path,
  config: {
    home: path,
    lanes: path,
    user: OWNER,
    port: 0,
    environment: {},
    worker: [process.execPath],
    workerCloseTimeoutMs: 10000,
    channelScope: "local",
  },
});
const ok = (id: string) =>
  sse([
    created(id),
    ...messageItem(0, `message-${id}`, "final_answer", "fixture response"),
    completed(id),
  ]);
const until = async (ready: () => boolean) => {
  const limit = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > limit) throw new Error("fixture deadline exceeded");
    await Bun.sleep(5);
  }
};
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});
const setup = async (
  path: string,
  endpoint: ReturnType<typeof openEndpoint>,
  quietMs = 60000,
) => {
  const token = tokenCommand(path, "lease");
  const configured = codingWorkerSetup(
    {
      paths: {
        ...PI_TRANSITION_STORAGE_PROFILE.paths,
        state: join(path, "state"),
        tmp: join(path, "tmp"),
        captures: join(path, "snapshots"),
      },
    },
    SOL_ROUTE,
    {
      auth: { tokenCommand: token.path },
      fetch: endpoint.fetch,
      stallLimits: { quietMs, reasoningMs: quietMs },
    },
  );
  const release = await configured.openSource?.(worker(path));
  if (release) releases.push(release);
  return configured;
};

// A real thirty-second server floor catches accidental native-only two-second retries.
test("actual worker setup shares a real 30-second floor across Channel generation, caption and recap", async () => {
  const path = root();
  const endpoint = openEndpoint();
  const times: number[] = [];
  endpoint.respond(
    () => {
      times.push(Date.now());
      return Response.json(
        { error: { code: "rate_limit_exceeded", message: "fixture throttle" } },
        { status: 429, headers: { "retry-after": "30" } },
      );
    },
    ...Array.from({ length: 12 }, (_, i) => () => {
      times.push(Date.now());
      return ok(`normal-${i}`);
    }),
  );
  const configured = await setup(path, endpoint, 1000);
  const native = worker(path);
  const fixture = await Fixture.create({
    models: await configured.models(native, nativeModels()),
    defaultModel: async () => model,
    nonTurnModels: (purpose, chat) =>
      configured.nonTurnModels!(native, purpose, chat, nativeModels()),
  });
  try {
    const pending = await fixture.request<{ submission: number }>({
      op: "ask",
      author: OWNER,
      text: "throttle proof",
      model,
    });
    await until(() => {
      try {
        return (
          JSON.parse(readFileSync(join(path, "route-admission.json"), "utf8"))
            .until > Date.now()
        );
      } catch {
        return false;
      }
    });
    const auxiliary = ["caption", "recap"] as const;
    const calls = auxiliary.map((purpose) => {
      const models = configured.nonTurnModels!(
        native,
        purpose,
        ROOT_CONVERSATION_ID,
        nativeModels(),
      );
      return models.completeSimple(
        models.getModel("openai", SOL_ROUTE.model)!,
        {
          messages: [
            {
              role: "user",
              content: `declared ${purpose}`,
              timestamp: Date.now(),
            },
          ],
        },
      );
    });
    expect(
      (await Promise.all(calls)).map((message) => message.stopReason),
    ).toEqual(["stop", "stop"]);
    expect(
      await fixture.request<string>({
        op: "wait",
        submission: pending.submission,
      }),
    ).toBe("done");
    expect(times.length).toBeGreaterThanOrEqual(4);
    for (const at of times.slice(1))
      expect(at - times[0]!).toBeGreaterThanOrEqual(30000);
    const events = readFileSync(join(path, "capture/events.jsonl"), "utf8");
    expect(events).toContain('"purpose":"caption"');
    expect(events).toContain('"purpose":"recap"');
    const generations = fixture.log.filter(
      (entry) => entry.event === "harness.report",
    );
    expect(generations).toEqual([]);
    expect(
      fixture.log.filter((entry) => entry.event === "model.request"),
    ).toHaveLength(2);
    expect(statSync(join(path, "route-admission.json")).mode & 0o777).toBe(
      0o600,
    );
    console.log(
      "ROUTE_CHANNEL_30S",
      JSON.stringify({
        times,
        delays: times.slice(1).map((at) => at - times[0]!),
        requests: endpoint.received.length,
        log: fixture.log,
      }),
    );
  } finally {
    await fixture.dispose();
    endpoint.stop();
    rmSync(path, { recursive: true, force: true });
  }
}, 45000);

test("reopened native summarize reads persisted floor without a repeated compaction hook", async () => {
  const path = root();
  const captures = root();
  const endpoint = openEndpoint();
  const times: number[] = [];
  let hooks = 0;
  endpoint.respond(
    () => {
      times.push(Date.now());
      return sse([created("interrupted")], { hold: true });
    },
    () =>
      Response.json(
        { error: { code: "rate_limit_exceeded", message: "auxiliary floor" } },
        { status: 429, headers: { "retry-after": "2" } },
      ),
    () => {
      times.push(Date.now());
      return ok("restored");
    },
  );
  const token = tokenCommand(path, "floor-identity");
  const auth = { tokenCommand: token.path };
  const open = async () => {
    mkdirSync(join(captures, "coding"), { recursive: true });
    const configured = codingWorkerSetup(
      {
        paths: {
          ...PI_TRANSITION_STORAGE_PROFILE.paths,
          state: join(path, "state"),
          tmp: join(path, "tmp"),
          captures,
        },
      },
      SOL_ROUTE,
      {
        auth,
        fetch: endpoint.fetch,
        stallLimits: { quietMs: 1000, reasoningMs: 1000 },
      },
    );
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "count-compaction",
        hooks: [
          hook(CompactionTask, {
            beforeCompact() {
              hooks++;
            },
          }),
        ],
      }),
    );
    const storage = await openWorkerStorage(configured, worker(path), () =>
      openNodeSqliteStorage(join(path, "channel.sqlite")),
    );
    const harness = await Harness.open(
      storage,
      {
        models: await configured.models(worker(path), nativeModels()),
        registry,
        settings: { compaction: { keepRecentTokens: 1 } },
      },
      context,
    );
    return {
      harness,
      configured,
      chat: await harness.root(context, { agent: { model } }),
    };
  };
  // The fixture drains the capture queue itself, so it owns every scan.
  const startCaptureWorker = spyOn(
    WorkerCli,
    "startCaptureWorker",
  ).mockReturnValue(Effect.void);
  try {
    const first = await open();
    for (const content of ["older material ".repeat(100), "recent material"])
      await (
        await first.chat.submit(
          {
            type: "write",
            entry: {
              kind: "proof",
              model: [{ role: "user", content, timestamp: Date.now() }],
            },
          },
          context,
        )
      ).wait(context);
    const taskId = await first.chat.compact(undefined, context);
    await until(() => times.length === 1);
    const auxiliary = first.configured.nonTurnModels!(
      worker(path),
      "recap",
      ROOT_CONVERSATION_ID,
      nativeModels(),
    );
    const receivedAt = Date.now();
    const refused = await auxiliary.completeSimple(
      auxiliary.getModel("openai", SOL_ROUTE.model)!,
      {
        messages: [
          {
            role: "user",
            content: "recap requests a floor",
            timestamp: Date.now(),
          },
        ],
      },
    );
    expect(refused.stopReason).toBe("error");
    console.log(
      "BEFORE_CLOSE_TASK",
      JSON.stringify(await first.harness.getTask(taskId, context)),
    );
    const exportRefusal = {
      _tag: "DumpFailed",
      reason:
        "call 1: original SDK cancellation boundary unavailable; frame 0 other/other; callbacks 0/unknown (retained-stream-prefix); unavailable credential source census; source retained privately, export refused",
    };
    await first.harness.close(context);
    expect(statSync(join(path, "channel.sqlite")).size).toBeGreaterThan(0);
    expect(existsSync(join(captures, "coding/neuve/records.sqlite"))).toBe(
      true,
    );
    const closedBytes = readFileSync(
      join(path, "capture/events.jsonl"),
      "utf8",
    );
    const closedJournal = readCaptureJournal(join(path, "capture"));
    if (closedJournal._tag !== "Read")
      throw new Error("Fixture journal is unreadable");
    const closedCapture = closedJournal.lines;
    const artifact = closedCapture.findIndex(
      (line) =>
        line.event.type === "artifact" &&
        line.event.name === "route-admission.json",
    );
    const closed = closedCapture.findIndex(
      (line) => line.event.type === "journal.close",
    );
    expect(artifact).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(artifact);
    const interrupted = closedCapture.find(
      (line) =>
        line.event.type === "model.end" &&
        line.event.responseId === "interrupted",
    )?.event;
    expect(interrupted).toMatchObject({
      type: "model.end",
      outcome: "aborted",
      responseId: "interrupted",
      stopReason: "aborted",
      messageTimestamp: expect.any(Number),
    });
    if (interrupted?.type !== "model.end")
      throw new Error("Missing interrupted call end");
    const interruptedCall = closedCapture.filter(
      (line) =>
        "callId" in line.event && line.event.callId === interrupted.callId,
    );
    expect(
      interruptedCall.map(({ event }) =>
        event.type === "model.event" ? event.name : event.type,
      ),
    ).toEqual([
      "credential.registration",
      "model.request",
      "credential_guard",
      "model.response",
      "response.created",
      "sdk_invocation_end",
      "credential_guard",
      "model.end",
    ]);
    expect(interruptedCall[5]!.event).toEqual({
      type: "model.event",
      scope: { runId: "coding-route-proof" },
      callId: interrupted.callId,
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: interrupted.callId,
        callbacks: 1,
        abort: {
          status: "aborted",
          afterCallbacks: 1,
          boundary: "unresolved",
          reason: {
            kind: "error",
            name: "AbortError",
            message: "The operation was aborted.",
          },
        },
      },
    });
    expect(interruptedCall[7]!.seq).toBeLessThan(closedCapture[artifact]!.seq);
    const admissionBytes = readFileSync(join(path, "route-admission.json"));
    const admissionHash = createHash("sha256")
      .update(admissionBytes)
      .digest("hex");
    expect(closedCapture[artifact]!.event).toMatchObject({
      sha256: admissionHash,
      size: admissionBytes.length,
    });
    expect(readFileSync(join(path, "capture/objects", admissionHash))).toEqual(
      admissionBytes,
    );
    expect(JSON.parse(admissionBytes.toString()).until).toBeGreaterThanOrEqual(
      receivedAt + 2000,
    );
    console.log(
      "ROUTE_ABORT_REFUSAL",
      JSON.stringify({
        taskId,
        callId: interrupted.callId,
        invocationEnd: interruptedCall[5]!.event,
        exportRefusal,
        admissionHash,
      }),
    );
    console.log(
      "ROUTE_CLOSE_ARTIFACT",
      JSON.stringify({
        artifact: closedCapture[artifact],
        journalClose: closedCapture[closed],
      }),
    );
    const second = await open();
    const task = await second.harness.getTask(taskId, context);
    console.log("REOPEN_TASK", JSON.stringify(task));
    expect(task?.state.status).toBe("pending");
    expect(
      task?.state.status === "pending" && task.state.checkpoint,
    ).toMatchObject({ phase: "summarize", attempt: 1 });
    second.harness.resume();
    const outcome = await second.harness.waitForTask(taskId, context);
    expect(outcome.state.outcome.status).toBe("completed");
    expect(hooks).toBe(1);
    expect(times[1]! - receivedAt).toBeGreaterThanOrEqual(2000);
    console.log(
      "ROUTE_COMPACTION_REOPEN",
      JSON.stringify({ taskId, hooks, task, outcome, times, receivedAt }),
    );
    await second.harness.close(context);
    expect(
      readFileSync(join(path, "capture/events.jsonl"), "utf8").startsWith(
        closedBytes,
      ),
    ).toBe(true);
    expect(existsSync(join(captures, "coding/neuve/records.sqlite"))).toBe(
      true,
    );
    expect(statSync(join(path, "channel.sqlite")).size).toBeGreaterThan(0);
    const location = storeLocationIn(join(captures, "coding"));
    const run = runIn(location);
    value(await run(scanCaptures(location)));
    const filed = value(await run(CaptureRecords.rawCaptures()));
    expect(filed.length).toBeGreaterThanOrEqual(2);
    for (const raw of filed) {
      if (raw._tag === "Invalid") throw new Error(raw.reason);
      expect(
        value(await run(CaptureRecords.scanStatus(raw.rawCapture))),
      ).toMatchObject({ status: "refused", reason: exportRefusal.reason });
    }
  } finally {
    startCaptureWorker.mockRestore();
    endpoint.stop();
    rmSync(path, { recursive: true, force: true });
    rmSync(captures, { recursive: true, force: true });
  }
}, 10000);

test("deadline extension, cancellation, route change, expiry and persistence failure", async () => {
  const path = root();
  const file = join(path, "route-admission.json");
  try {
    const admission = openRouteAdmission({
      path: file,
      route: SOL_ROUTE,
      auth: { tokenCommand: "/fixture/lease" },
    });
    admission.observe("0.1", Date.now());
    const started = Date.now();
    const waiting = admission.wait();
    await Bun.sleep(20);
    admission.observe("0.2", Date.now());
    admission.observe(null, Date.now());
    admission.observe("0.01", Date.now());
    await waiting;
    expect(Date.now() - started).toBeGreaterThanOrEqual(210);
    await openRouteAdmission({
      path: file,
      route: SOL_ROUTE,
      auth: { tokenCommand: "/fixture/lease" },
    }).wait(AbortSignal.timeout(20));
    admission.observe("60", Date.now());
    await expect(admission.wait(AbortSignal.timeout(20))).rejects.toThrow();
    const other = openRouteAdmission({
      path: file,
      route: { ...SOL_ROUTE, model: "another-model" },
      auth: { tokenCommand: "/fixture/lease" },
    });
    await other.wait(AbortSignal.timeout(20));
    const restored = openRouteAdmission({
      path: file,
      route: SOL_ROUTE,
      auth: { tokenCommand: "/fixture/lease" },
    });
    await expect(restored.wait(AbortSignal.timeout(20))).rejects.toThrow();
    writeFileSync(file, "malformed");
    expect(() =>
      openRouteAdmission({ path: file, route: SOL_ROUTE }),
    ).toThrow();
    const unavailable = openRouteAdmission({
      path: join(path, "missing/state.json"),
      route: SOL_ROUTE,
    });
    expect(() => unavailable.observe("30", Date.now())).toThrow("persisted");
    await expect(unavailable.wait()).rejects.toThrow("persistence failed");
    mkdirSync(join(path, "missing"));
    await expect(unavailable.wait()).rejects.toThrow("persistence failed");
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("cancellation while actual Models wait sends nothing, and persistence failure blocks the next call", async () => {
  const path = root();
  const endpoint = openEndpoint();
  endpoint.respond(() =>
    Response.json(
      {
        error: { code: "rate_limit_exceeded", message: "wait before sending" },
      },
      { status: 429, headers: { "retry-after": "30" } },
    ),
  );
  const configured = await setup(path, endpoint);
  const native = worker(path);
  try {
    const models = await configured.models(native, nativeModels());
    const selected = models.getModel("openai", SOL_ROUTE.model)!;
    const transcript = {
      messages: [
        {
          role: "user" as const,
          content: "cancel at admission",
          timestamp: Date.now(),
        },
      ],
    };
    expect((await models.completeSimple(selected, transcript)).stopReason).toBe(
      "error",
    );
    expect(
      (
        await models.completeSimple(selected, transcript, {
          signal: AbortSignal.timeout(30),
        })
      ).stopReason,
    ).toBe("aborted");
    expect(endpoint.received).toHaveLength(1);
    const lines = readFileSync(join(path, "capture/events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      lines.filter((line) => line.event?.type === "model.request"),
    ).toHaveLength(1);
    console.log(
      "ROUTE_CANCEL",
      JSON.stringify({ requests: endpoint.received.length, lines }),
    );
  } finally {
    endpoint.stop();
    rmSync(path, { recursive: true, force: true });
  }

  const failedPath = root();
  const failedEndpoint = openEndpoint();
  failedEndpoint.respond(() => {
    mkdirSync(join(failedPath, "route-admission.json"));
    return Response.json(
      { error: { code: "rate_limit_exceeded", message: "cannot persist" } },
      { status: 429, headers: { "retry-after": "30" } },
    );
  });
  try {
    const models = await (
      await setup(failedPath, failedEndpoint)
    ).models(worker(failedPath), nativeModels());
    const selected = models.getModel("openai", SOL_ROUTE.model)!;
    const transcript = {
      messages: [
        {
          role: "user" as const,
          content: "fail closed",
          timestamp: Date.now(),
        },
      ],
    };
    expect((await models.completeSimple(selected, transcript)).stopReason).toBe(
      "error",
    );
    expect((await models.completeSimple(selected, transcript)).stopReason).toBe(
      "error",
    );
    expect(failedEndpoint.received).toHaveLength(1);
    console.log(
      "ROUTE_PERSISTENCE_FAILURE",
      JSON.stringify({ requests: failedEndpoint.received.length }),
    );
  } finally {
    failedEndpoint.stop();
    rmSync(failedPath, { recursive: true, force: true });
  }
});

test("admission precedes the credential owner, including a cancelled call", async () => {
  const path = root();
  const endpoint = openEndpoint();
  try {
    const token = tokenCommand(path, "lease");
    openRouteAdmission({
      path: join(path, "route-admission.json"),
      route: SOL_ROUTE,
      auth: { tokenCommand: token.path },
    }).observe("2", Date.now());
    const models = await (
      await setup(path, endpoint)
    ).models(worker(path), nativeModels());
    expect(
      endpoint.modelLists.map((headers) => headers.get("authorization")),
    ).toEqual(["Bearer tok-1"]);
    const leasesBeforeCall = token.runs();
    expect(leasesBeforeCall).toBe(1);
    // A cached catalogue lease would hide a premature credential request.
    rejectedToken("tok-1");
    await Bun.sleep(0);
    const result = await models.completeSimple(
      models.getModel("openai", SOL_ROUTE.model)!,
      {
        messages: [
          {
            role: "user",
            content: "wait before leasing",
            timestamp: Date.now(),
          },
        ],
      },
      { signal: AbortSignal.timeout(30) },
    );
    expect(result.stopReason).toBe("aborted");
    expect(token.runs()).toBe(leasesBeforeCall);
    expect(endpoint.received).toHaveLength(0);
    console.log(
      "ROUTE_AUTH_ORDER",
      JSON.stringify({
        stopReason: result.stopReason,
        tokenLeases: token.runs() - leasesBeforeCall,
        requests: endpoint.received.length,
      }),
    );
  } finally {
    endpoint.stop();
    rmSync(path, { recursive: true, force: true });
  }
});

test("an access lease that expires during a newly observed floor is renewed by the credential owner", async () => {
  const path = root();
  const endpoint = openEndpoint();
  const command = join(path, "short-lease");
  const count = join(path, "lease-count");
  const leases = join(path, "leases.jsonl");
  const timeline: Array<{ event: string; at: number }> = [];
  const capture: Array<unknown> = [];
  writeFileSync(count, "0");
  writeFileSync(
    command,
    `#!${process.execPath}\nimport { appendFileSync, readFileSync, writeFileSync } from "node:fs";\nconst count = ${JSON.stringify(count)};\nconst run = Number(readFileSync(count, "utf8")) + 1;\nwriteFileSync(count, String(run));\nconst emittedAt = Date.now();\nconst expiresAt = emittedAt + (run === 1 ? 250 : 3600000);\nappendFileSync(${JSON.stringify(leases)}, JSON.stringify({ run, emittedAt, expiresAt }) + "\\n");\nconsole.log(JSON.stringify({ access_token: "token-" + run, expires_at: expiresAt }));\n`,
    { mode: 0o700 },
  );
  const auth = { tokenCommand: command };
  const admission = openRouteAdmission({
    path: join(path, "route-admission.json"),
    route: SOL_ROUTE,
    auth,
  });
  let waits = 0;
  let floor = 0;
  endpoint.respond((request) => {
    timeline.push({ event: "http.received", at: Date.now() });
    expect(request.headers.get("authorization")).toBe("Bearer token-2");
    expect(Date.now()).toBeGreaterThanOrEqual(floor);
    return ok("renewed-token");
  });
  try {
    const models = createRouteModels({
      credentialInspection: "ephemeral" as const,
      route: SOL_ROUTE,
      auth,
      admission: {
        observe: admission.observe,
        async wait(signal) {
          const current = ++waits;
          timeline.push({
            event: `admission.${current}.enter`,
            at: Date.now(),
          });
          if (current === 2) {
            // This wait follows a valid lease and precedes the actual HTTP request.
            expect(readFileSync(count, "utf8").trim()).toBe("1");
            const now = Date.now();
            floor = now + 1500;
            admission.observe("1.5", now);
            timeline.push({ event: "floor.observed", at: now });
          }
          await admission.wait(signal);
          timeline.push({ event: `admission.${current}.exit`, at: Date.now() });
        },
      },
      fetch: endpoint.fetch,
      capture: (event) => capture.push(event),
      runId: "lease-race",
      sessionAffinity: "lease-race",
      stallLimits: { quietMs: 1000, reasoningMs: 1000 },
    });
    const result = await models.completeSimple(
      models.getModel("openai", SOL_ROUTE.model)!,
      {
        messages: [
          { role: "user", content: "renew after floor", timestamp: Date.now() },
        ],
      },
    );
    console.log(
      "ROUTE_LEASE_RENEWAL",
      JSON.stringify({
        timeline,
        leases: readFileSync(leases, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        result,
        capture,
        requests: endpoint.received.map((request) => ({
          path: request.path,
          authorization: request.headers.get("authorization"),
          body: request.body,
        })),
      }),
    );
    expect(result.stopReason).toBe("stop");
    expect(readFileSync(count, "utf8").trim()).toBe("2");
    expect(endpoint.received).toHaveLength(1);
  } finally {
    endpoint.stop();
    rmSync(path, { recursive: true, force: true });
  }
});
