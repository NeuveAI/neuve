// Why: a local capture refusal crosses an SDK that can report it as a connection error.
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { chmodSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { storeLocationIn } from "@neuve/records-core";
import { openRunLog } from "../../../src/run-log.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import {
  createPrivateInspection,
  openPrivateInspection,
} from "../../../src/pi/capture/private-inspection.ts";
import {
  JOURNAL_FILE,
  IDLE_RELEASE_MS,
  decodeCaptureLosses,
  readCaptureJournal,
  readCaptureLosses,
  openCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { decodeCredentialLossReserve } from "../../../src/pi/capture/credential-loss-reserve.ts";
import { buildDump } from "../../../src/pi/capture/build.ts";
import {
  captureRunDump,
  exportCapturedDump,
  exportPortableSnapshot,
  exportSnapshot,
  readCapturedDump,
  readSessionDump,
  sealCapturedDump,
} from "../../../src/pi/capture/export.ts";
import { fileRawCapture, scanRawCapture } from "../../../src/pi/capture/raw.ts";
import { scanStatus } from "../../../src/pi/capture/records.ts";
import { runIn, scanCaptures, value } from "../capture/fixture.ts";
import {
  CAPTURE_LOSS_FILE,
  CREDENTIAL_LOSS_RESERVE_FILE,
  CaptureFailed,
  DEFAULT_LIMITS,
} from "../../../src/pi/capture/types.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { captureNativeModels } from "../../../src/pi/providers/native-models-capture.ts";
import { routeFailureOf } from "../../../src/pi/providers/failure.ts";
import {
  completed,
  created,
  messageItem,
  sse,
  tokenCommand,
} from "./fixture.ts";

const prompt = {
  messages: [
    { role: "user" as const, content: "Check the work.", timestamp: 1 },
  ],
};

const answer = (text: string) =>
  sse([
    created("resp_note"),
    ...messageItem(0, "msg_note", "final_answer", text),
    completed("resp_note"),
  ]);

const diskFull = () =>
  Object.assign(new Error("disk is full"), { code: "ENOSPC" });

const captureWholeCall = (
  journal: ReturnType<typeof openCaptureJournal>,
  runId: string,
  text: string,
) => {
  const scope = { runId };
  const callId = "later-call";
  journal.capture({
    type: "model.request",
    scope,
    callId,
    route: "synthetic",
    provider: "synthetic",
    model: "synthetic",
    headerNames: [],
    credentialCoverage: "none",
    body: { status: "sent", json: { text } },
  });
  journal.capture({ type: "model.response", scope, callId, status: 200 });
  journal.capture({ type: "model.end", scope, callId, outcome: "completed" });
};

// An interrupted channel with no credential loss must still export the calls it kept.
for (const lostBind of [false, true]) {
  test(`an interrupted channel exports without a credential hold (${lostBind ? "lost bind" : "crash"})`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "neuve-interrupted-channel-"),
    );
    const runId = "interrupted-channel";
    const scope = { runId };
    const nativeDatabase = join(directory, "pi.sqlite");
    const storage = await openNodeSqliteStorage(nativeDatabase);
    try {
      const journal = openCaptureJournal(join(directory, "capture"), runId, {
        allowCredentialLoss: true,
      });
      journal.capture({
        type: "run.start",
        scope,
        runKind: "coding",
        sourceRevision: { status: "not-applicable", reason: "Scratch chat" },
        route: "synthetic",
        pricing: "subscription",
      });
      captureWholeCall(journal, runId, "Done.");
      if (lostBind) {
        const fault = spyOn(fs, "appendFileSync").mockImplementation(() => {
          throw diskFull();
        });
        try {
          expect(() =>
            journal.capture({
              type: "session.bind",
              scope: { runId, conversationId: ROOT_CONVERSATION_ID },
            }),
          ).toThrow(
            expect.objectContaining({ kind: "io", event: "session.bind" }),
          );
        } finally {
          fault.mockRestore();
        }
        expect(journal.close).toThrow(
          expect.objectContaining({ event: "session.bind" }),
        );
      }
      const root = join(directory, "datasets");
      await mkdir(root);
      const output = { root, retention: { policy: "synthetic" } };
      const input = { runId, journal: journal.directory, nativeDatabase };
      const direct = await exportSnapshot({ ...input, ...output });
      const directPortable = await exportPortableSnapshot({
        ...output,
        directory: direct.directory,
      });
      const location = storeLocationIn(join(directory, "records"));
      const run = runIn(location);
      const { capture } = value(await run(captureRunDump(input)));
      value(await run(scanCaptures(location)));
      expect(value(await run(scanStatus(capture))).status).toBe("clean");
      const restricted = value(
        await run(exportCapturedDump({ ...output, capture })),
      );
      const portable = value(
        await run(
          exportCapturedDump({
            ...output,
            capture,
            redaction: "portable",
          }),
        ),
      );
      const dumps = [
        value(await run(readCapturedDump(capture))),
        ...(await Promise.all(
          [direct, directPortable, restricted, portable].map(({ directory }) =>
            Effect.runPromise(readSessionDump(directory)),
          ),
        )),
      ];
      for (const { run, unjoined } of dumps) {
        expect(
          unjoined.map(({ callId, end }) => [callId, end?.outcome]),
        ).toEqual([["later-call", "completed"]]);
        expect(run.gaps).toContainEqual({
          code: "journal-interrupted",
          count: 1,
          kind: "capture",
          detail: expect.stringContaining(
            lostBind
              ? "Lost writes: session.bind"
              : "ended without a clean close",
          ),
        });
      }
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  "registered",
  "unregistered",
  "unwritable",
  "no reserve",
] as const) {
  test(`a restarted channel handles credential loss (${scenario})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "neuve-capture-start-"));
    const source = join(directory, "source");
    await mkdir(source);
    const ownership = SourceOwnership.acquire(source);
    const inspection = createPrivateInspection({
      ownership,
      source,
      directory: join(directory, "private"),
      excludedRoots: [source],
    });
    const nativeDatabase = join(source, "pi.sqlite");
    const storage = await openNodeSqliteStorage(nativeDatabase);
    try {
      const runId = "restarted-channel";
      const captureDirectory = join(source, "capture");
      const hasReserve = scenario !== "no reserve";
      const writable = scenario === "registered" || scenario === "unregistered";
      const previous = openCaptureJournal(captureDirectory, runId, {
        ...(hasReserve ? { allowCredentialLoss: true } : {}),
      });
      previous.capture({
        type: "run.start",
        scope: { runId },
        runKind: "coding",
        sourceRevision: { status: "not-applicable", reason: "Scratch chat" },
        route: SOL_ROUTE.provider,
        pricing: "subscription",
      });
      const append = spyOn(fs, "appendFileSync").mockImplementation(() => {
        throw diskFull();
      });
      try {
        expect(previous.close).toThrow(
          expect.objectContaining({ event: "journal.close" }),
        );
      } finally {
        append.mockRestore();
      }
      const before = await readFile(join(captureDirectory, JOURNAL_FILE));
      const limits = writable
        ? { ...DEFAULT_LIMITS, journalBytes: before.byteLength }
        : DEFAULT_LIMITS;
      const auth = { tokenCommand: tokenCommand(directory, "lease").path };
      const log = openRunLog(storeLocationIn(directory), "worker");
      const appendFault = writable
        ? undefined
        : spyOn(fs, "appendFileSync").mockImplementation(() => {
            throw diskFull();
          });
      const write = fs.writeFileSync;
      const sideFileFault = writable
        ? undefined
        : spyOn(fs, "writeFileSync").mockImplementation(
            (path, data, options) => {
              if (
                typeof path === "number" ||
                (typeof path === "string" &&
                  path.startsWith(captureDirectory + "/"))
              )
                throw diskFull();
              write(path, data, options);
            },
          );
      const exec = Database.prototype.exec;
      const authorityFault =
        scenario === "unregistered"
          ? spyOn(Database.prototype, "exec").mockImplementation(function (
              this: Database,
              ...args
            ) {
              if (
                args[0] === "COMMIT" &&
                this.filename.endsWith("/private/authority.sqlite")
              )
                throw Object.assign(new Error("registration write failed"), {
                  code: "SQLITE_FULL",
                });
              return exec.apply(this, args);
            })
          : undefined;
      try {
        const restarted = openCaptureJournal(captureDirectory, runId, {
          allowCredentialLoss: true,
          limits,
          log,
        });
        let sent = 0;
        const models = createRouteModels({
          route: SOL_ROUTE,
          retry: { maxRetries: 1, baseDelayMs: 1 },
          log,
          runId,
          sessionAffinity: runId,
          auth,
          credentialInspection: inspection,
          capture: restarted.capture,
          fetch: Object.assign(
            async () => {
              sent++;
              return answer("Done.");
            },
            { preconnect() {} },
          ),
        });
        const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
        if (!model) throw new Error("Expected coding route model");
        if (hasReserve) {
          for (const result of [
            await models.complete(model, prompt),
            await models.complete(model, prompt),
          ]) {
            expect(result.stopReason).toBe("stop");
            expect(result.content).toContainEqual(
              expect.objectContaining({ type: "text", text: "Done." }),
            );
          }
          expect(sent).toBe(2);
        } else {
          const result = await models.complete(model, prompt);
          expect(result.errorMessage).toContain(
            "The call stopped because a credential could slip through unrecorded.",
          );
          expect(routeFailureOf(result)).toMatchObject({ kind: "capture" });
          expect(isRetryableAssistantError(result)).toBe(false);
          expect(sent).toBe(0);
        }
        expect(restarted.close).toThrow(
          expect.objectContaining({ event: "journal.open" }),
        );
      } finally {
        authorityFault?.mockRestore();
        sideFileFault?.mockRestore();
        appendFault?.mockRestore();
      }
      expect(await readFile(join(captureDirectory, JOURNAL_FILE))).toEqual(
        before,
      );
      await log.flush?.();
      const events = log.read();
      const losses = events
        .filter(({ type }) => type === "model.call")
        .map(({ call }) => ({
          callId: String(call),
          event: "credential.registration",
          kind: scenario === "registered" ? "full" : "io",
          reason: scenario === "registered" ? "journal limit" : "disk full",
        }));
      expect(losses).toHaveLength(hasReserve ? 2 : 1);
      expect(events.filter(({ type }) => type === "capture.loss")).toEqual(
        losses.map((loss) =>
          expect.objectContaining({ ...loss, persisted: hasReserve }),
        ),
      );
      const lossFile = join(captureDirectory, CAPTURE_LOSS_FILE);
      const reserve = join(captureDirectory, CREDENTIAL_LOSS_RESERVE_FILE);
      const expected = losses.map((loss) => expect.objectContaining(loss));
      if (scenario === "registered") {
        expect(decodeCaptureLosses(await readFile(lossFile))).toEqual(expected);
        expect(
          decodeCredentialLossReserve(await readFile(reserve), true),
        ).toEqual([]);
      } else {
        expect(fs.existsSync(lossFile)).toBe(false);
        if (hasReserve)
          expect(
            decodeCredentialLossReserve(await readFile(reserve), true),
          ).toEqual(expected);
        else expect(fs.existsSync(reserve)).toBe(false);
      }
      const input = {
        journal: captureDirectory,
        runId,
        limits,
        nativeDatabase,
        credentialInspection: inspection,
      };
      if (scenario === "unregistered") {
        await expect(buildDump(input)).rejects.toThrow(
          "the scan could not identify the credential",
        );
      } else {
        const { run } = await buildDump(input);
        expect(run.complete).toBe(false);
        expect(run.gaps).toContainEqual(
          expect.objectContaining({
            code: "journal-interrupted",
            count: 1,
          }),
        );
        if (hasReserve) {
          const gap = run.gaps.find(({ code }) => code === "journal-failed");
          expect(gap?.count).toBe(2);
          for (const loss of losses)
            expect(gap?.detail).toContain(
              `call ${loss.callId} lost capture at credential.registration`,
            );
        }
      }
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      inspection.close();
      ownership.release();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const reserveWritable of [true, false]) {
  test(`ordinary capture loss when the loss record fails and the reserve is ${reserveWritable ? "writable" : "unwritable"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "neuve-ordinary-loss-"));
    try {
      const runId = "ordinary-loss";
      const log = openRunLog(storeLocationIn(directory), "worker");
      const captureDirectory = join(directory, "capture");
      const journal = openCaptureJournal(captureDirectory, runId, {
        allowCredentialLoss: true,
        log,
      });
      const auth = { tokenCommand: tokenCommand(directory, "lease").path };
      const models = createRouteModels({
        route: SOL_ROUTE,
        retry: { maxRetries: 1, baseDelayMs: 1 },
        log,
        runId,
        sessionAffinity: runId,
        auth,
        credentialInspection: "ephemeral",
        capture: journal.capture,
        fetch: Object.assign(async () => answer("Done."), { preconnect() {} }),
      });
      const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
      if (!model) throw new Error("Expected coding route model");
      const append = fs.appendFileSync;
      const journalFault = spyOn(fs, "appendFileSync").mockImplementation(
        (path, data, options) => {
          if (String(data).includes('"type":"model.request"')) throw diskFull();
          append(path, data, options);
        },
      );
      const writeFile = fs.writeFileSync;
      const lossFault = spyOn(fs, "writeFileSync").mockImplementation(
        (path, data, options) => {
          if (
            typeof path === "string" &&
            path.startsWith(captureDirectory + "/") &&
            path.endsWith(".partial")
          )
            throw diskFull();
          writeFile(path, data, options);
        },
      );
      let reserveWriteAttempts = 0;
      const reserveFault = reserveWritable
        ? undefined
        : spyOn(fs, "writeSync").mockImplementation(() => {
            reserveWriteAttempts++;
            throw diskFull();
          });
      try {
        const result = await models.complete(model, prompt);
        expect(result.stopReason).toBe("stop");
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: "text", text: "Done." }),
        );
      } finally {
        reserveFault?.mockRestore();
        lossFault.mockRestore();
        journalFault.mockRestore();
      }
      const read = () =>
        decodeCredentialLossReserve(
          fs.readFileSync(join(captureDirectory, CREDENTIAL_LOSS_RESERVE_FILE)),
          true,
        );
      await log.flush?.();
      const call = log.read().find(({ type }) => type === "model.call");
      const loss = {
        callId: String(call?.call),
        event: "model.request",
        kind: "io",
        reason: "disk full",
      };
      expect(read()).toEqual(
        reserveWritable ? [expect.objectContaining(loss)] : [],
      );
      if (!reserveWritable) expect(reserveWriteAttempts).toBe(1);
      expect(
        log.read().find(({ type }) => type === "capture.loss"),
      ).toMatchObject({
        ...loss,
        persisted: reserveWritable,
      });
      if (reserveWritable) journal.close();
      else
        expect(journal.close).toThrow(
          expect.objectContaining({ event: "model.request" }),
        );
      const { run } = await buildDump({ journal: captureDirectory, runId });
      expect(run.complete).toBe(false);
      if (reserveWritable) {
        expect(run.gaps).toContainEqual(
          expect.objectContaining({
            code: "journal-failed",
            detail: expect.stringContaining(
              `call ${loss.callId} lost capture at model.request`,
            ),
          }),
        );
      } else {
        expect(run.gaps).toContainEqual(
          expect.objectContaining({
            code: "journal-interrupted",
            count: 1,
          }),
        );
        expect(run.gaps.map(({ code }) => code)).not.toContain(
          "journal-failed",
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("capture exhaustion leaves the first call, later calls and a reopened call answered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-full-capture-"));
  const runId = "full-capture";
  const limits = {
    objectBytes: 1024 * 1024,
    totalBytes: 2 * 1024 * 1024,
    manifestBytes: 4096,
    journalBytes: 4096,
  };
  try {
    const source = join(directory, "source");
    await mkdir(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    const inspection = createPrivateInspection({
      ownership,
      source,
      directory: join(directory, "private"),
      excludedRoots: [source],
    });
    const nativeDatabase = join(source, "pi.sqlite");
    const storage = await openNodeSqliteStorage(nativeDatabase);
    try {
      const token = tokenCommand(directory, "lease");
      const log = openRunLog(storeLocationIn(directory), "worker");
      const captureDirectory = join(source, "capture");
      let sent = 0;
      const text = "x".repeat(4096);
      const retry = { maxRetries: 1, baseDelayMs: 1_000 };
      const open = () => {
        const journal = openCaptureJournal(captureDirectory, runId, {
          limits,
          log,
        });
        if (sent === 0)
          journal.capture({
            type: "run.start",
            scope: { runId },
            runKind: "coding",
            sourceRevision: {
              status: "not-applicable",
              reason: "Scratch chat",
            },
            route: SOL_ROUTE.provider,
            pricing: "subscription",
          });
        const models = createRouteModels({
          route: SOL_ROUTE,
          retry,
          log,
          runId,
          sessionAffinity: runId,
          auth: { tokenCommand: token.path },
          credentialInspection: inspection,
          capture: journal.capture,
          fetch: Object.assign(
            async () => {
              sent++;
              return answer(text);
            },
            { preconnect() {} },
          ),
        });
        const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
        if (!model) throw new Error("Expected coding route model");
        return { journal, complete: () => models.complete(model, prompt) };
      };
      const first = open();
      const firstResult = await first.complete();
      const started = performance.now();
      const results = [firstResult, await first.complete()];
      expect(performance.now() - started).toBeLessThan(retry.baseDelayMs);
      first.journal.close();
      const reopened = open();
      results.push(await reopened.complete());
      for (const result of results) {
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: "text", text }),
        );
        expect(result.stopReason).toBe("stop");
        expect(routeFailureOf(result)).toBeUndefined();
      }
      expect(sent).toBe(3);
      await log.flush?.();
      const calls = log.read().filter(({ type }) => type === "model.call");
      expect(
        calls.map(({ failureKind, sentAt }) => [failureKind, typeof sentAt]),
      ).toEqual([
        [undefined, "string"],
        [undefined, "string"],
        [undefined, "string"],
      ]);
      const losses = readCaptureLosses(captureDirectory, limits);
      expect(
        losses.map(({ event, kind, reason }) => [event, kind, reason]),
      ).toEqual([
        ["model.event", "full", "journal limit"],
        ["credential.registration", "full", "journal limit"],
        ["model.request", "full", "journal limit"],
      ]);
      expect(losses.map(({ callId }) => callId)).toEqual(
        calls.map(({ call }) => String(call)),
      );
      expect(losses[1]?.epochId).toBe(losses[0]?.callId);
      const journal = readCaptureJournal(captureDirectory, limits);
      expect(journal._tag).toBe("Read");
      if (journal._tag !== "Read") throw new Error("Expected journal");
      const requests = journal.lines.flatMap(({ event }) =>
        event.type === "model.request" ? [event.callId] : [],
      );
      expect(requests).toEqual(losses.slice(0, 1).map(({ callId }) => callId));
      const { run } = await buildDump({
        journal: captureDirectory,
        runId,
        limits,
        credentialInspection: inspection,
        nativeDatabase,
      });
      expect(run.complete).toBe(false);
      const gap = run.gaps.find(({ code }) => code === "journal-failed");
      expect(gap?.kind).toBe("capture");
      expect(gap?.count).toBe(3);
      for (const loss of losses)
        expect(gap?.detail).toContain(
          `call ${loss.callId} lost capture at ${loss.event}`,
        );
      expect(run.journal.status).toBe("captured");
      expect(run.gaps.map(({ code }) => code)).not.toContain(
        "run-start-missing",
      );
      const root = join(directory, "dataset");
      await mkdir(root);
      const retention = { policy: "test" };
      const restricted = await exportSnapshot({
        journal: captureDirectory,
        runId,
        limits,
        root,
        retention,
        credentialInspection: inspection,
        nativeDatabase,
      });
      const portable = await exportPortableSnapshot({
        directory: restricted.directory,
        root,
        retention,
      });
      const read = await Effect.runPromise(readSessionDump(portable.directory));
      expect(read.run.gaps).toEqual(run.gaps);
      expect(read.run.complete).toBe(false);
      const location = storeLocationIn(join(directory, "records"));
      const useStore = runIn(location);
      const filed = value(
        await useStore(
          fileRawCapture({
            runId,
            journal: captureDirectory,
            nativeDatabase,
            credentialInspection: inspection,
          }),
        ),
      );
      expect(filed.manifest.counts.calls).toBe(3);
      expect(filed.manifest.files.map(({ name }) => name)).toContain(
        "capture/capture-loss.json",
      );
      const scanned = value(
        await useStore(
          scanRawCapture({
            location,
            rawCapture: filed.rawCapture,
            seal: (sources, scan) => sealCapturedDump(sources, scan, false),
          }),
        ),
      );
      expect(scanned.run.gaps).toEqual(run.gaps);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      await inspection.close();
      ownership.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a full channel journal leaves the reserve empty when the private authority registers each call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-full-channel-"));
  const source = join(directory, "source");
  await mkdir(source);
  const ownership = SourceOwnership.acquire(source);
  const credentialInspection = createPrivateInspection({
    ownership,
    source,
    directory: join(directory, "private"),
    excludedRoots: [source],
  });
  try {
    const runId = "full-channel";
    const journal = openCaptureJournal(join(source, "capture"), runId, {
      allowCredentialLoss: true,
      limits: { ...DEFAULT_LIMITS, journalBytes: 4096 },
    });
    const models = createRouteModels({
      route: SOL_ROUTE,
      retry: { maxRetries: 1, baseDelayMs: 1 },
      log: openRunLog(storeLocationIn(directory), "worker"),
      runId,
      sessionAffinity: runId,
      auth: { tokenCommand: tokenCommand(directory, "lease").path },
      credentialInspection,
      capture: journal.capture,
      fetch: Object.assign(async () => answer("Done."), { preconnect() {} }),
    });
    const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
    if (!model) throw new Error("Expected coding route model");
    for (let call = 0; call < 20; call++) {
      const result = await models.complete(model, prompt);
      expect(routeFailureOf(result)).toBeUndefined();
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "Done." }),
      );
    }
    const losses = decodeCaptureLosses(
      await readFile(join(journal.directory, CAPTURE_LOSS_FILE)),
    );
    expect(
      losses.filter(({ event }) => event === "credential.registration").length,
    ).toBeGreaterThan(8);
    expect(losses.every(({ reason }) => reason === "journal limit")).toBe(true);
    const reserve = await readFile(
      join(journal.directory, CREDENTIAL_LOSS_RESERVE_FILE),
    );
    expect(decodeCredentialLossReserve(reserve, true)).toEqual([]);
  } finally {
    credentialInspection.close();
    ownership.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transient write refusal retries the same request and keeps its capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-capture-retry-"));
  try {
    const runId = "capture-retry";
    const journal = openCaptureJournal(directory, runId);
    const path = join(directory, JOURNAL_FILE);
    // The journal releases its descriptor after an idle interval. chmod then affects the next open.
    await Bun.sleep(2 * IDLE_RELEASE_MS + 50);
    chmodSync(path, 0o400);
    let attempts = 0;
    let sent = 0;
    const token = tokenCommand(directory, "lease");
    const capture = Object.assign(
      (event: Parameters<typeof journal.capture>[0]) => {
        if (event.type === "model.request" && ++attempts === 1)
          setTimeout(() => chmodSync(path, 0o600), 0);
        journal.capture(event);
      },
      journal.capture,
    );
    const models = createRouteModels({
      capture,
      credentialInspection: "ephemeral",
      route: SOL_ROUTE,
      retry: { maxRetries: 1, baseDelayMs: 20 },
      runId,
      sessionAffinity: runId,
      auth: { tokenCommand: token.path },
      fetch: Object.assign(
        async () => {
          sent++;
          return answer("Done.");
        },
        { preconnect() {} },
      ),
    });
    const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
    if (!model) throw new Error("Expected coding route model");
    expect((await models.complete(model, prompt)).stopReason).toBe("stop");
    expect({ attempts, sent }).toEqual({ attempts: 2, sent: 1 });
    expect(readCaptureLosses(directory)).toEqual([]);
    journal.close();
    const recorded = readCaptureJournal(directory);
    expect(recorded._tag).toBe("Read");
    if (recorded._tag !== "Read") throw new Error("Expected journal");
    expect(
      recorded.lines.filter(({ event }) => event.type === "model.request"),
    ).toHaveLength(1);
    expect(
      recorded.lines.filter(({ event }) => event.type === "model.end"),
    ).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transient session bind write refusal leaves later calls captured whole", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-capture-bind-"));
  try {
    const runId = "capture-bind";
    const conversationId = ROOT_CONVERSATION_ID;
    const journal = openCaptureJournal(directory, runId);
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "coding",
      sourceRevision: { status: "not-applicable", reason: "Scratch chat" },
      route: SOL_ROUTE.provider,
      pricing: "subscription",
    });
    const path = join(directory, JOURNAL_FILE);
    await Bun.sleep(2 * IDLE_RELEASE_MS + 50);
    chmodSync(path, 0o400);
    try {
      expect(() =>
        journal.capture({
          type: "session.bind",
          scope: { runId, conversationId },
        }),
      ).toThrow(expect.objectContaining({ kind: "io", event: "session.bind" }));
    } finally {
      chmodSync(path, 0o600);
    }

    const models = createRouteModels({
      capture: journal.capture,
      credentialInspection: "ephemeral",
      route: SOL_ROUTE,
      retry: { maxRetries: 1, baseDelayMs: 1 },
      runId,
      conversationId,
      sessionAffinity: runId,
      auth: { tokenCommand: tokenCommand(directory, "lease").path },
      fetch: Object.assign(async () => answer("Done."), { preconnect() {} }),
    });
    const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
    if (!model) throw new Error("Expected coding route model");
    for (const result of [
      await models.complete(model, prompt),
      await models.complete(model, prompt),
    ]) {
      expect(result.stopReason).toBe("stop");
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "Done." }),
      );
    }
    expect(readCaptureLosses(directory)).toEqual([]);
    expect(() => journal.close()).toThrow(
      expect.objectContaining({ kind: "io", event: "session.bind" }),
    );

    const recorded = readCaptureJournal(directory);
    if (recorded._tag !== "Read") throw new Error("Expected journal");
    const events = recorded.lines.map(({ event }) => event);
    expect(events.map(({ type }) => type)).not.toContain("journal.close");
    const requests = events.flatMap((event) =>
      event.type === "model.request" ? [event.callId] : [],
    );
    expect(requests).toHaveLength(2);
    expect(
      events.flatMap((event) =>
        event.type === "model.response" ? [event.callId] : [],
      ),
    ).toEqual(requests);
    expect(
      events.flatMap((event) =>
        event.type === "model.end" && event.outcome === "completed"
          ? [event.callId]
          : [],
      ),
    ).toEqual(requests);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a native provider answers with a full journal and no recorded request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-native-full-capture-"));
  try {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({
      type: "api_key",
      key: "synthetic-key",
    }));
    const defaults = await builtinModels({ credentials });
    const model = defaults
      .getModels("openai")
      .find(({ api }) => api === "openai-responses");
    if (!model) throw new Error("Expected a native Responses model");
    const journal = openCaptureJournal(directory, "native-full", {
      limits: {
        journalBytes: 400,
        objectBytes: 4096,
        totalBytes: 4096,
        manifestBytes: 4096,
      },
    });
    let dispatches = 0;
    let sent = 0;
    const models = captureNativeModels(defaults, {
      runId: "native-full",
      credentialInspection: "ephemeral",
      retry: { maxRetries: 1, baseDelayMs: 1 },
      capture: Object.assign((event: Parameters<typeof journal.capture>[0]) => {
        if (event.type === "model.request") dispatches++;
        journal.capture(event);
      }, journal.capture),
      fetch: Object.assign(
        async () => {
          sent++;
          return answer("Done.");
        },
        { preconnect() {} },
      ),
    });
    const result = await models.complete(
      model,
      {
        messages: [{ role: "user", content: "Check the work.", timestamp: 1 }],
      },
      { maxRetries: 2 },
    );
    expect(result.stopReason).toBe("stop");
    expect(routeFailureOf(result)).toBeUndefined();
    expect([dispatches, sent]).toEqual([2, 1]);
    const [loss] = readCaptureLosses(directory);
    expect(loss).toMatchObject({
      event: "model.request",
      kind: "full",
      reason: "journal limit",
    });
    const { run } = await buildDump({
      journal: directory,
      runId: "native-full",
    });
    expect(run.complete).toBe(false);
    expect(run.gaps).toContainEqual({
      code: "journal-failed",
      count: 1,
      kind: "capture",
      detail: expect.stringContaining(
        `call ${loss?.callId} lost capture at model.request`,
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a capture without a durable hold ends before send if credential registration loss cannot be recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-capture-refusal-"));
  try {
    const source = join(directory, "source");
    await mkdir(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    const inspection = createPrivateInspection({
      ownership,
      source,
      directory: join(directory, "private"),
      excludedRoots: [source],
    });
    try {
      const token = tokenCommand(directory, "lease");
      let sent = 0;
      const models = createRouteModels({
        route: SOL_ROUTE,
        runId: "capture-refusal",
        sessionAffinity: "capture-refusal",
        auth: { tokenCommand: token.path },
        credentialInspection: inspection,
        fetch: Object.assign(
          async () => {
            sent++;
            throw new Error("The provider must not be called");
          },
          { preconnect() {} },
        ),
        capture(event) {
          expect(event.type).toBe("credential.registration");
          throw new CaptureFailed({
            kind: "io",
            event: event.type,
            detail: "Call recording reached its cap.",
          });
        },
      });
      const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model)!;
      const result = await models.complete(model, {
        messages: [{ role: "user", content: "Check the work.", timestamp: 1 }],
      });
      expect(result.errorMessage).toBe(
        "OpenAI API error: capture failed, the call could not be recorded",
      );
      expect(routeFailureOf(result)).toEqual({
        kind: "capture",
        detail:
          "capture failed: credential registration was not recorded: io: Call recording reached its cap.",
      });
      expect(isRetryableAssistantError(result)).toBe(false);
      expect(result.usage.totalTokens).toBe(0);
      expect(sent).toBe(0);
      expect(token.runs()).toBe(1);
    } finally {
      await inspection.close();
      ownership.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The call and the export have different failure rules. Check both with the same capture.
for (const variant of [
  "exposed",
  "clean",
  "unknown",
  "journal",
  "torn",
  "zeroed",
  "missing",
  "full",
  "full-native",
] as const) {
  test(`a channel with a lost credential registration (${variant})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "neuve-registration-loss-"));
    const source = join(directory, "source");
    const privateDirectory = join(directory, "private");
    await mkdir(source);
    const ownership = SourceOwnership.acquire(source);
    const inspectionOptions = {
      ownership,
      source,
      directory: privateDirectory,
      excludedRoots: [source],
    };
    let credentialInspection = createPrivateInspection(inspectionOptions);
    const nativeDatabase = join(source, "pi.sqlite");
    const storage = await openNodeSqliteStorage(nativeDatabase);
    try {
      const runId = "channel-registration-loss";
      const scope = { runId };
      const captureDirectory = join(source, "capture");
      const log = openRunLog(storeLocationIn(directory), "worker");
      const journal = openCaptureJournal(captureDirectory, runId, {
        allowCredentialLoss: true,
        log,
      });
      journal.capture({
        type: "run.start",
        scope,
        runKind: "coding",
        sourceRevision: { status: "not-applicable", reason: "Scratch chat" },
        route: SOL_ROUTE.provider,
        pricing: "subscription",
      });
      const journalWrite = variant === "journal";
      const clean = variant === "clean" || journalWrite;
      const full = variant === "full" || variant === "full-native";
      const canIdentify = variant !== "unknown" && !full;
      const reserve = join(captureDirectory, CREDENTIAL_LOSS_RESERVE_FILE);
      const lossFile = join(captureDirectory, CAPTURE_LOSS_FILE);
      const auth = { tokenCommand: tokenCommand(directory, "lease").path };
      if (full) {
        for (let slot = 0; slot < 8; slot++)
          journal.capture.recordLoss?.(
            {
              callId: randomUUID(),
              event: "credential.registration",
              at: new Date().toISOString(),
              kind: "io",
              reason: "disk full",
            },
            false,
            true,
          );
      }
      let defaults: Awaited<ReturnType<typeof builtinModels>> | undefined;
      if (variant === "full-native") {
        const credentials = new InMemoryCredentialStore();
        await credentials.modify("openai", async () => ({
          type: "api_key",
          key: "synthetic-key",
        }));
        defaults = await builtinModels({ credentials });
      }
      let writes = 0;
      let sent = 0;
      const capture = Object.assign(
        (event: Parameters<typeof journal.capture>[0]) => {
          if (journalWrite && event.type === "credential.registration") {
            writes++;
            throw new CaptureFailed({
              kind: "io",
              event: event.type,
              detail: "disk is full",
              writeCode: "ENOSPC",
            });
          }
          journal.capture(event);
        },
        journal.capture,
      );
      const authorityPath = join(
        await realpath(privateDirectory),
        "authority.sqlite",
      );
      const exec = Database.prototype.exec;
      const fault = spyOn(Database.prototype, "exec").mockImplementation(
        function (this: Database, ...args) {
          if (
            !journalWrite &&
            args[0] === "COMMIT" &&
            this.filename === authorityPath
          ) {
            writes++;
            // An uncertain commit can leave a durable detector that the scan can verify.
            if (canIdentify) exec.apply(this, args);
            throw Object.assign(new Error("registration write failed"), {
              code: "SQLITE_FULL",
            });
          }
          return exec.apply(this, args);
        },
      );
      // Journal appends and side-file creation require new space. The reserved
      // positional write and sync still work on an already allocated file.
      const appendFileSync = fs.appendFileSync;
      const append = spyOn(fs, "appendFileSync").mockImplementation(
        (path, data, options) => {
          if (typeof path === "number") throw diskFull();
          appendFileSync(path, data, options);
        },
      );
      const writeFileSync = fs.writeFileSync;
      const grow = spyOn(fs, "writeFileSync").mockImplementation(
        (path, data, options) => {
          if (
            typeof path === "number" ||
            (typeof path === "string" &&
              path.startsWith(captureDirectory + "/"))
          )
            throw diskFull();
          writeFileSync(path, data, options);
        },
      );
      const options = {
        route: SOL_ROUTE,
        retry: { maxRetries: 1, baseDelayMs: 1 },
        log,
        runId,
        sessionAffinity: runId,
        auth,
        credentialInspection,
        capture,
        fetch: Object.assign(
          async () => {
            sent++;
            return answer("Done.");
          },
          { preconnect() {} },
        ),
      };
      try {
        const models =
          defaults === undefined
            ? createRouteModels(options)
            : captureNativeModels(defaults, options);
        const model =
          defaults === undefined
            ? models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model)
            : models
                .getModels("openai")
                .find(({ api }) => api === "openai-responses");
        if (!model) throw new Error("Expected coding route model");
        const result = await models.complete(model, prompt);
        if (full) {
          expect(routeFailureOf(result)).toMatchObject({
            kind: "capture",
            detail: expect.stringContaining(
              "credential registration loss reserve is full. The call stopped because a credential could slip through unrecorded.",
            ),
          });
          expect(result.errorMessage).toContain(
            "credential registration loss reserve is full. The call stopped because a credential could slip through unrecorded.",
          );
          expect(isRetryableAssistantError(result)).toBe(false);
          expect([writes, sent]).toEqual([2, 0]);
          return;
        }
        expect(routeFailureOf(result)).toBeUndefined();
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: "text", text: "Done." }),
        );
        expect(result.stopReason).toBe("stop");
        expect([writes, sent]).toEqual([2, 1]);
      } finally {
        grow.mockRestore();
        append.mockRestore();
        fault.mockRestore();
      }
      await log.flush?.();
      const call = log.read().find(({ type }) => type === "model.call");
      expect(call?.failureKind).toBeUndefined();
      expect(typeof call?.sentAt).toBe("string");
      expect(
        log.read().find(({ type }) => type === "capture.loss"),
      ).toMatchObject({
        callId: String(call?.call),
        event: "credential.registration",
        reason: "disk full",
        persisted: true,
      });
      expect(fs.existsSync(lossFile)).toBe(false);
      expect(readCaptureLosses(captureDirectory)).toEqual([
        {
          callId: String(call?.call),
          event: "credential.registration",
          kind: "io",
          reason: "disk full",
          at: expect.any(String),
        },
      ]);
      captureWholeCall(journal, runId, clean ? "Next." : "tok-1");
      // Leave the session unclosed. The reserve alone accounts for credential loss.
      if (variant === "missing") await rm(reserve);
      if (variant === "zeroed") await writeFile(reserve, Buffer.alloc(4096));
      if (variant === "torn") {
        const fd = fs.openSync(reserve, "r+");
        try {
          fs.writeSync(fd, Buffer.alloc(129, 0xa5), 0, 129, 0);
        } finally {
          fs.closeSync(fd);
        }
      }
      if (variant === "missing" || variant === "zeroed" || variant === "torn") {
        const beforeRestart =
          variant === "missing" ? undefined : await readFile(reserve);
        credentialInspection.close();
        credentialInspection = openPrivateInspection(inspectionOptions);
        const restarted = openCaptureJournal(captureDirectory, runId, {
          allowCredentialLoss: true,
          log,
        });
        try {
          const models = createRouteModels({
            ...options,
            credentialInspection,
            capture: restarted.capture,
          });
          const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model);
          if (!model) throw new Error("Expected coding route model");
          const result = await models.complete(model, prompt);
          expect(routeFailureOf(result)).toBeUndefined();
          expect(result.content).toContainEqual(
            expect.objectContaining({ type: "text", text: "Done." }),
          );
          if (beforeRestart === undefined)
            expect(fs.existsSync(reserve)).toBe(false);
          else expect(await readFile(reserve)).toEqual(beforeRestart);
        } finally {
          restarted.close();
        }
      }

      const input = {
        runId,
        journal: captureDirectory,
        nativeDatabase,
        credentialInspection,
      };
      const location = storeLocationIn(join(directory, "records"));
      const run = runIn(location);
      const root = join(directory, "datasets");
      await mkdir(root);
      const { capture: raw, raw: manifest } = value(
        await run(captureRunDump(input)),
      );
      if (variant !== "missing")
        expect(manifest.files).toContainEqual(
          expect.objectContaining({
            name: "capture/credential-loss.reserve",
            size: 4096,
          }),
        );
      if (clean || variant === "exposed" || variant === "unknown")
        expect(manifest.counts.calls).toBe(2);
      const output = { capture: raw, root, retention: { policy: "synthetic" } };
      const expectHeld = async () => {
        for (const result of [
          await run(readCapturedDump(raw)),
          await run(exportCapturedDump(output)),
          await run(exportCapturedDump({ ...output, redaction: "portable" })),
        ])
          expect(result._tag).toBe("Failure");
      };
      expect(value(await run(scanStatus(raw))).status).toBe("pending");
      await expectHeld();
      value(await run(scanCaptures(location)));
      if (!clean) {
        const status = value(await run(scanStatus(raw)));
        expect(status.status).toBe("refused");
        const reason =
          variant === "exposed"
            ? "credential exposure in exact source"
            : variant === "unknown"
              ? "the scan could not identify the credential"
              : variant === "missing"
                ? "credential registration loss reserve is missing"
                : "credential registration loss reserve is damaged";
        expect(status).toMatchObject({
          reason: expect.stringContaining(reason),
        });
        await expectHeld();
        await expect(exportSnapshot({ ...input, ...output })).rejects.toThrow(
          reason,
        );
        return;
      }
      expect(value(await run(scanStatus(raw))).status).toBe("clean");
      for (const redaction of ["restricted", "portable"] as const) {
        const saved = value(
          await run(exportCapturedDump({ ...output, redaction })),
        );
        const dump = await Effect.runPromise(readSessionDump(saved.directory));
        expect(
          dump.unjoined.map(({ callId, end }) => [callId, end?.outcome]),
        ).toEqual([["later-call", "completed"]]);
        expect(dump.run.gaps).toContainEqual({
          code: "journal-failed",
          count: 1,
          kind: "capture",
          detail: expect.stringContaining(
            `call ${call?.call} lost capture at credential.registration`,
          ),
        });
      }
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      credentialInspection.close();
      ownership.release();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
