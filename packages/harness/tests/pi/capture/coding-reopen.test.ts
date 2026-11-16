import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";

test("production coding owner survives fresh idle and genuine safe native continuation", async () => {
  const root = mkdtempSync(join(tmpdir(), "coding-certificate-reopen-"));
  const resolve = (path: string) => JSON.stringify(import.meta.resolve(path));
  const driver = join(root, "driver.ts");
  mkdirSync(join(root, "datasets", "coding"), { recursive: true });
  writeFileSync(
    driver,
    `
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from ${resolve("@earendil-works/chord/context")};
import { Harness, createRegistry } from ${resolve("@earendil-works/pi-durable")};
import { openNodeSqliteStorage } from ${resolve("@earendil-works/pi-durable/storage/sqlite/node")};
import { Effect } from ${resolve("effect")};
import { builtinModels } from ${resolve("@earendil-works/pi-ai/providers/all")};
import { codingWorkerSetup } from ${resolve("../../../../../apps/neuve-cli/src/workspace-cli.ts")};
import { SOL_ROUTE } from ${resolve("../../../src/route.ts")};
import { CaptureRecords, DumpFailed, exportCapturedDump, readSessionDump, exportPortableSnapshot } from ${resolve("../../../src/session-dump.ts")};
import { storeLocationIn } from ${resolve("@neuve/records-core")};
import { stopStoreWorker } from ${resolve("../../../../records-core/tests/worker-process.ts")};
import { runIn, value, scanCaptures, awaitStoreWorker } from ${resolve("./fixture.ts")};
import { openCaptureJournal } from ${resolve("../../../src/pi/capture/journal.ts")};
import { openEndpoint, tokenCommand, sse, created, messageItem, completed } from ${resolve("../providers/fixture.ts")};
// Each step's wall time and the 1-minute load go to stderr, which the test keeps with NEUVE_CAPTURE_INTEGRITY_KEEP=1.
const timed = async (step, work) => {
  const started = performance.now();
  try { return await work(); } finally { console.error(JSON.stringify({ step, ms: Math.round(performance.now() - started), end: Date.now(), load1: Number(loadavg()[0]?.toFixed(1)) })); }
};
console.error(JSON.stringify({ step: "imports", ms: Math.round(performance.now()) }));
const root = join(${JSON.stringify(root)}, process.argv[3] ?? "safe");
mkdirSync(join(root, "datasets", "coding"), { recursive: true });
const phase = process.argv[2];
const captures = join( ${JSON.stringify(root)}, "recorded", process.argv[3] ?? "safe");
mkdirSync(join(captures, "coding"), {recursive: true});
const database = join(root, "channel.sqlite");
const token = join(root, "lease");
if (!existsSync(token)) tokenCommand(root, "lease");
const worker = { sessionId: "fresh-coding", stateDirectory: root, config: {} };
const endpoint = openEndpoint();
const setup = codingWorkerSetup({ paths: { captures, state: join(root,"state"), tmp: join(root,"tmp") } }, SOL_ROUTE, { auth: { tokenCommand: token }, fetch: endpoint.fetch });
const release = await timed("setup.openSource", () => setup.openSource(worker));
const nativeModels = () => builtinModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
const models = phase === "mutate" ? undefined : await timed("setup.models", () => setup.models(worker, nativeModels()));
const before = existsSync(database) ? createHash("sha256").update(readFileSync(database)).digest("hex") : null;
let storage;
let captureWorkerStopped = false;
try {
  if (phase === "turn" || phase === "echo" || phase === "crash") {
    const raw = await openNodeSqliteStorage(database);
    const records = (await raw.scanConversations({}, 256, undefined, context)).items;
    const harness = await Harness.open(raw, { models, registry: createRegistry(), settings: { retry: { enabled: false }, compaction: { enabled: false } } }, context);
    const conversation = records.length ? await harness.conversation(records[0].id, context) : await harness.root(context, { agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } } });
    setup.onConversation(worker, conversation.id);
    endpoint.respond(request => {
      const secret = request.headers.get("authorization").replace(/^Bearer /, "");
      return sse([created("safe-" + phase + readFileSync(token + ".count", "utf8").trim()), ...messageItem(0, "safe-" + phase + readFileSync(token + ".count", "utf8").trim(), "final_answer", phase === "echo" ? secret : "Safe response."), completed("safe-" + phase + readFileSync(token + ".count", "utf8").trim())]);
    });
    await timed("turn", async () => (await conversation.submit({ type: "input", content: "Safe input." }, context)).wait(context));
    await timed("harness.close", () => harness.close(context));
    if (phase === "crash") process.kill(process.pid, "SIGKILL");
  }
  if (phase === "mutate") {
    const journal = openCaptureJournal(join(root, "capture"), worker.sessionId);
    journal.capture({ type: "artifact", scope: { runId: worker.sessionId }, name: "unobserved.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("Unobserved output.") });
    journal.close();
    setup.models(worker, nativeModels());
  }
  if (phase === "native-mutate") {
    const changed = new DatabaseSync(database);
    try { changed.exec("PRAGMA user_version = 41"); } finally { changed.close(); }
  }
  storage = await openNodeSqliteStorage(database);
  await timed("setup.close", () => setup.close({ worker, reads: storage, context }));
  const location = storeLocationIn(join(captures, "coding"));
  const run = runIn(location);
  // The close started the store's capture worker; stop it once it listens, so this driver scans alone.
  await timed("awaitStoreWorker", () => awaitStoreWorker(location));
  await timed("stopStoreWorker", () => stopStoreWorker(location));
  captureWorkerStopped = true;
  const raws = value(await run(CaptureRecords.rawCaptures(0, worker.sessionId)));
  const latest = raws.at(-1);
  if (!latest || latest._tag === "Invalid") throw new Error("invalid synthetic filing");
  const capture = latest.rawCapture;
  let status;
  let passes = 0;
  await timed("scan", async () => {
  for (let i = 0; i < 300; i++) {
    passes++;
    value(await run(scanCaptures(location)));
    status = value(await run(CaptureRecords.scanStatus(capture)));
    if (status.status !== "pending") break;
    await Bun.sleep(100);
  }
  });
  console.error(JSON.stringify({ step: "scan.passes", passes }));
  if (status.status !== "clean") throw new DumpFailed({reason: status.reason ?? "capture scan remained pending"});
  mkdirSync(join(root, "datasets", "coding-exports"), {recursive: true});
  const snapshot = value(await timed("exportCapturedDump", () => run(exportCapturedDump({capture, root: join(root, "datasets", "coding-exports"), retention: {policy: "coding snapshots retained by the workspace profile"}}))));
  const restored = await timed("readSessionDump", () => Effect.runPromise(readSessionDump(snapshot.directory)));
  await timed("exportPortableSnapshot", () => exportPortableSnapshot({ directory: snapshot.directory, root: join(root, "datasets", "coding"), retention: { policy: "coding snapshots retained by the workspace profile" } }));
  console.log(JSON.stringify({ ok: true, requests: endpoint.received.length, leases: Number(readFileSync(token + ".count", "utf8")), turns: restored.sessions.reduce((n, s) => n + s.turns.length, 0), complete: restored.run.complete, identity: restored.sessions[0].calls[0].callId, backup: restored.run.backup, before, after: createHash("sha256").update(readFileSync(database)).digest("hex") }));
} catch (error) { console.log(JSON.stringify({ ok: false, tag: error._tag, reason: error.reason ?? error.message, retained: existsSync(database) })); }
finally {
  await timed("finally", async () => {
  endpoint.stop(); if (storage) await storage.close(context); release();
  const location = storeLocationIn(join(captures, "coding"));
  if (!captureWorkerStopped) await timed("finally.stopStoreWorker", () => stopStoreWorker(location));
  });
  console.error(JSON.stringify({ step: "process", ms: Math.round(performance.now()) }));
}
`,
  );
  const run = async (phase: string, scenario = "safe") => {
    const started = performance.now();
    const child = Bun.spawn([process.execPath, driver, phase, scenario], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    console.error(
      `[coding-reopen] ${scenario}-${phase} ${Math.round(performance.now() - started)} ms, load ${loadavg()[0]?.toFixed(1)}\n${err}`,
    );
    if (phase === "crash" && code === 137) return { crashed: true };
    if (code !== 0) throw new Error(`coding fixture exited ${code}: ${err}`);
    writeFileSync(join(root, `${scenario}-${phase}-${Date.now()}.stdout`), out);
    writeFileSync(join(root, `${scenario}-${phase}-${Date.now()}.stderr`), err);
    return JSON.parse(out.trim());
  };
  try {
    const first = await run("turn");
    expect(first).toMatchObject({
      ok: true,
      complete: true,
      turns: 1,
      requests: 1,
      leases: 1,
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      const idle = await run("idle");
      expect(idle).toMatchObject({
        ok: true,
        complete: true,
        turns: 1,
        requests: 0,
        leases: 1,
        identity: first.identity,
      });
      expect(idle.before).toBe(idle.after);
    }
    const continued = await run("turn");
    expect(continued).toMatchObject({
      ok: true,
      complete: true,
      turns: 2,
      requests: 1,
    });
    expect(await run("idle")).toMatchObject({ ok: true, complete: true });
    expect(await run("mutate")).toMatchObject({ ok: true, complete: true });
    expect(await run("turn", "physical")).toMatchObject({ ok: true, turns: 1 });
    expect(await run("native-mutate", "physical")).toMatchObject({
      ok: true,
      complete: true,
    });
    expect(await run("turn", "exposure")).toMatchObject({ ok: true, turns: 1 });
    expect(await run("echo", "exposure")).toMatchObject({
      ok: false,
      tag: "DumpFailed",
      retained: true,
      reason: expect.stringContaining("credential exposure"),
    });
    expect(await run("idle", "exposure")).toMatchObject({
      ok: false,
      tag: "DumpFailed",
      retained: true,
      reason: expect.stringContaining("credential exposure"),
    });
    expect(await run("turn", "crash")).toMatchObject({ ok: true, turns: 1 });
    expect(await run("crash", "crash")).toEqual({ crashed: true });
    expect(await run("turn", "crash")).toMatchObject({
      ok: true,
      complete: false,
    });
  } finally {
    if (process.env["NEUVE_CAPTURE_INTEGRITY_KEEP"] === "1")
      console.log(`Coding reopen evidence: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
