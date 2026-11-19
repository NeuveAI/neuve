// Why: the worker owns the hybrid model processes, and two failures there pass silently or take
// the worker down (the review of 83f6259b). An idle exit that fires while a call is still running
// kills a busy process and fails the rest of the job; and a write to a reranker that is gone must
// fail that call, never crash the worker. A fake reranker process stands in for the model, so these
// run on any machine.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SemanticClient } from "@neuve/semantic-client";
import { BENCH_R_IDENTITY } from "../src/hybrid.ts";
import { chunkEncoder, Holder, RerankerProcess } from "../src/hybrid-models.ts";
import { Cause, Effect } from "effect";
import { JOB_POLICIES, Worker } from "@neuve/records-core";
import {
  CONTINUE_DELAY_MS,
  HybridContinues,
  FIRST_PAUSE_MS,
  LONGEST_PAUSE_MS,
  nextPauseMs,
} from "../src/commit-hybrid.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-hybrid-processes-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** A fake reranker: the real one's identity, then `behaviour` for each request. */
const fakeWorker = (name: string, behaviour: string) => {
  const path = join(directory, `${name}.py`);
  writeFileSync(
    path,
    `import hashlib, json, sys, time
from pathlib import Path
identity = {
  "modelId": ${JSON.stringify(BENCH_R_IDENTITY.hfId)},
  "revision": ${JSON.stringify(BENCH_R_IDENTITY.revision)},
  "weightsSha256": ${JSON.stringify(BENCH_R_IDENTITY.weights["model.safetensors"])},
  "workerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
  "instructionSha256": ${JSON.stringify(sha256(BENCH_R_IDENTITY.rerank.instruction))},
  "prefixSha256": ${JSON.stringify(sha256(BENCH_R_IDENTITY.rerank.prefix))},
  "suffixSha256": ${JSON.stringify(sha256(BENCH_R_IDENTITY.rerank.suffix))},
  "device": "cpu", "dtype": "float32", "maxTokens": ${BENCH_R_IDENTITY.maxTokens},
}
print(json.dumps({"kind": "ready", "identity": identity, "loadMillis": 1, "maxRssBytes": 1}), flush=True)
for line in sys.stdin:
  request = json.loads(line)
${behaviour}
`,
  );
  return {
    python: "python3",
    worker: path,
    snapshot: directory,
    device: "cpu" as const,
    workerSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
};

const answer = `  print(json.dumps({"kind": "reranked", "id": request["id"], "scores": [0.5] * len(request["documents"]), "truncated": [False] * len(request["documents"]), "rerankMillis": 1, "maxRssBytes": 1}), flush=True)`;

test("a reranker that is gone fails the call, never the worker, and a fresh one answers", async () => {
  // It answers once, then exits: the next write lands on a process that is gone.
  const config = fakeWorker("dies", `${answer}\n  sys.exit(0)`);
  const process = new RerankerProcess(config);
  expect((await process.score("q", ["d"])).scores).toEqual([0.5]);
  await Bun.sleep(200);
  await expect(process.score("q", ["d"])).rejects.toThrow();
  expect(process.failed).toBe(true);
  // After close, a call is refused at once rather than written to the ended input.
  const closed = new RerankerProcess(fakeWorker("plain", answer));
  expect((await closed.score("q", ["a", "b"])).scores).toEqual([0.5, 0.5]);
  await closed.close();
  await expect(closed.score("q", ["d"])).rejects.toThrow("closed");
  // The holder replaces a failed process on the next call.
  const holder = new Holder(
    "cpu",
    () => ({}) as unknown as SemanticClient,
    () => new RerankerProcess(fakeWorker("again", answer)),
  );
  const first = holder.reranker();
  await first.close();
  const second = holder.reranker();
  expect(second).not.toBe(first);
  // A late handler for the failed one leaves its replacement running.
  await holder.closeReranker("failed", first);
  expect(holder.reranker()).toBe(second);
  expect(second.failed).toBe(false);
  await holder.close("idle");
});

test("the idle exit waits for calls in flight, and fires after the last one ends", async () => {
  const closed: Array<string> = [];
  const holder = new Holder(
    "cpu",
    () =>
      ({
        stats: () => ({ pid: null }),
        close: async () => {
          closed.push("encoder");
        },
      }) as unknown as SemanticClient,
    () => new RerankerProcess(fakeWorker("idle", answer)),
    50,
  );
  holder.client();
  holder.begin("client");
  // A long call: well past the idle time, nothing is closed.
  await Bun.sleep(150);
  expect(closed).toEqual([]);
  holder.end("client");
  await Bun.sleep(150);
  expect(closed).toEqual(["encoder"]);
});

// Why: this machine holds one model at a time (the overseer's call, 24 October 2026). Starting one
// model must close the other when it is idle, so the two never sit in memory together, and never
// while a call is still using it.
test("under a one-model limit, starting one model closes the other only when it is idle", async () => {
  const closed: Array<string> = [];
  const encoder = () =>
    ({
      stats: () => ({ pid: null }),
      close: async () => {
        closed.push("encoder");
      },
    }) as unknown as SemanticClient;
  const holder = new Holder(
    "cpu",
    encoder,
    () => new RerankerProcess(fakeWorker("limit", answer)),
    60_000,
    1,
  );
  holder.client();
  const first = holder.reranker();
  await Bun.sleep(20);
  expect(closed).toEqual(["encoder"]);
  // Back to the encoder: the idle reranker is closed for it.
  holder.client();
  expect(first.failed).toBe(true);
  // A busy encoder stays while the reranker starts beside it.
  holder.begin("client");
  const second = holder.reranker();
  await Bun.sleep(20);
  expect(closed).toEqual(["encoder"]);
  holder.end("client");
  await holder.close("idle");
  expect(second.failed).toBe(true);
});

// Why: a paused hybrid job waits longer each time the machine is still past its limits, up to
// about 30 minutes, and starts again from the first delay after a run that did not pause.
test("a paused job waits two minutes, then twice as long each time, at most thirty", () => {
  const delays: Array<number> = [];
  let last: { tag: string; detail?: unknown } | null = null;
  for (let pause = 0; pause < 6; pause++) {
    const delay = nextPauseMs(last);
    delays.push(delay / 60_000);
    last = { tag: "HybridPaused", detail: { pauseMs: delay } };
  }
  expect(delays).toEqual([2, 4, 8, 16, 30, 30]);
  expect(nextPauseMs({ tag: "DeadlineExceeded" })).toBe(FIRST_PAUSE_MS);
  expect(LONGEST_PAUSE_MS).toBe(30 * 60_000);
});

// Why: a continuation must reach the queue as a short pause that does not count the attempt, so
// it can repeat as often as a large commit needs and still lets other work in first.
test("a continuation is a short, uncounted pause to the queue", () => {
  const failure = Worker.describeFailure(
    Cause.fail(
      new HybridContinues({
        message: "left",
        pauseMs: CONTINUE_DELAY_MS,
        left: 7,
      }),
    ),
    JOB_POLICIES["commit.hybrid"],
  );
  expect(failure).toMatchObject({
    tag: "HybridContinues",
    pauseMs: CONTINUE_DELAY_MS,
    detail: { left: 7 },
  });
  expect(CONTINUE_DELAY_MS).toBeLessThan(60_000);
  // A continuation does not grow the next pause: that starts from its first delay.
  expect(
    nextPauseMs({
      tag: "HybridContinues",
      detail: { pauseMs: CONTINUE_DELAY_MS },
    }),
  ).toBe(FIRST_PAUSE_MS);
});

/** A worker script of its own, with the real reranker's identity and a given startup. */
const startupWorker = (name: string, startup: string) => {
  const config = fakeWorker(name, answer);
  const text = readFileSync(config.worker, "utf8").replace(
    'print(json.dumps({"kind": "ready"',
    `${startup}\nprint(json.dumps({"kind": "ready"`,
  );
  writeFileSync(config.worker, text);
  return {
    ...config,
    workerSha256: createHash("sha256").update(text).digest("hex"),
  };
};

// Why (Neuve's review of db59b684, defect 1): the semantic client refuses a request that breaks
// its own bounds, an empty or oversized batch, before it reaches the process. Taking that refusal
// for a dead process closed a healthy encoder under any call sharing it.
test("a request the encoder refuses for its own bounds keeps the encoder", async () => {
  const closed: Array<string> = [];
  const client = {
    stats: () => ({ pid: null, loadMillis: null }),
    close: async () => {
      closed.push("encoder");
    },
    encodeBatch: async (inputs: ReadonlyArray<unknown>) =>
      inputs.length > 1
        ? { kind: "refusal", reason: "invalid-batch-size" }
        : {
            kind: "encoded",
            items: [{ values: Array.from({ length: 768 }, () => 0.036) }],
          },
  } as unknown as SemanticClient;
  const holder = new Holder(
    "cpu",
    () => client,
    () => new RerankerProcess(fakeWorker("bounds", answer)),
  );
  const encoder = chunkEncoder(holder, "cpu", "e".repeat(64));
  const encoded = await Effect.runPromise(
    encoder.encode([
      { path: "a.ts", text: "a" },
      { path: "b.ts", text: "b" },
    ]),
  );
  expect(encoded.map((item) => item.kind)).toEqual(["vector", "vector"]);
  expect(await Effect.runPromise(encoder.encode([]))).toEqual([]);
  expect(closed).toEqual([]);
  expect(holder.client()).toBe(client);
  await holder.close("idle");
});

// Why (defect 2): a reranker that never says it is ready must count as failed, or the holder keeps
// it and every later call fails on the same rejected startup until the idle exit.
test("a reranker that does not start in time is failed, and the holder replaces it", async () => {
  const silent = startupWorker("silent", "time.sleep(30)");
  const holder = new Holder(
    "cpu",
    () => ({}) as unknown as SemanticClient,
    () => new RerankerProcess({ ...silent, startupTimeoutMs: 200 }),
  );
  const first = holder.reranker();
  await expect(first.score("q", ["d"])).rejects.toThrow("did not load in time");
  expect(first.failed).toBe(true);
  expect(holder.reranker()).not.toBe(first);
  await holder.close("idle");
});

// Why (defect 3): a call waiting for the reranker to start must not write once it is closed. A
// worker that ignores the close signal and only then says it is ready shows whether the call
// re-checks after the startup it waited on.
test("closing a reranker that is still starting settles the waiting call, which writes nothing", async () => {
  const log = join(directory, "late-requests.log");
  const late = startupWorker(
    "late",
    `import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(0.4)`,
  );
  const text = readFileSync(late.worker, "utf8").replace(
    "  request = json.loads(line)",
    `  open(${JSON.stringify(log)}, "a").write(line)\n  request = json.loads(line)`,
  );
  writeFileSync(late.worker, text);
  const process = new RerankerProcess({
    ...late,
    workerSha256: createHash("sha256").update(text).digest("hex"),
  });
  const scored = process.score("q", ["d"]);
  await Bun.sleep(50);
  await process.close();
  await expect(scored).rejects.toThrow("closed");
  await Bun.sleep(600);
  expect(existsSync(log)).toBe(false);
});

/** A fake encoder whose model output is unusable for any text containing "bad". */
const modelOutputClient = (closed: Array<string>) =>
  ({
    stats: () => ({ pid: null, loadMillis: null }),
    close: async () => {
      closed.push("encoder");
    },
    encodeBatch: async (inputs: ReadonlyArray<{ text: string }>) =>
      inputs.some((input) => input.text.includes("bad"))
        ? { kind: "refusal", reason: "unnormalizable-model-output" }
        : {
            kind: "encoded",
            items: inputs.map(() => ({
              values: Array.from({ length: 768 }, () => 0.036),
            })),
            usage: { generated: inputs.length },
          },
  }) as unknown as SemanticClient;

// Why (the reviewer's note on 380a06ef): the model's output can be unusable for one input, and
// that must not fail a whole job; but when every input fails alone the model itself is broken,
// and refusing each chunk would store a permanent refusal for chunks that are fine.
test("one input's unusable model output is refused alone; all inputs failing is a process failure", async () => {
  const closed: Array<string> = [];
  const holder = new Holder(
    "cpu",
    () => modelOutputClient(closed),
    () => new RerankerProcess(fakeWorker("model-output", answer)),
  );
  const encoder = chunkEncoder(holder, "cpu", "e".repeat(64));
  const mixed = await Effect.runPromise(
    encoder.encode([
      { path: "a.ts", text: "good" },
      { path: "b.ts", text: "bad" },
      { path: "c.ts", text: "good too" },
    ]),
  );
  expect(mixed.map((item) => item.kind)).toEqual([
    "vector",
    "refused",
    "vector",
  ]);
  expect(closed).toEqual([]);
  const broken = await Effect.runPromise(
    Effect.flip(
      encoder.encode([
        { path: "d.ts", text: "bad" },
        { path: "e.ts", text: "bad again" },
      ]),
    ),
  );
  expect(broken.message).toContain("for every input alone");
  expect(closed).toEqual(["encoder"]);
  await holder.close("idle");
});

// Why: a reranker that ignores the request to stop must not outlive its close (the reviewer's
// note): it is killed after a short grace, as graph-client's commands are.
test("closing a reranker that ignores SIGTERM kills it after the grace", async () => {
  // The process says when it ignores SIGTERM. A close sent before then (a slow interpreter start
  // on a loaded runner) ends it at once, and the grace is never exercised.
  const ignoring = join(directory, "stubborn.ignoring");
  const stubborn = startupWorker(
    "stubborn",
    `import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nPath(${JSON.stringify(ignoring)}).touch()`,
  );
  const text = readFileSync(stubborn.worker, "utf8").replace(
    "for line in sys.stdin:",
    "while True:\n  time.sleep(1)\nfor line in sys.stdin:",
  );
  writeFileSync(stubborn.worker, text);
  const process = new RerankerProcess({
    ...stubborn,
    workerSha256: createHash("sha256").update(text).digest("hex"),
  });
  // Started: its first call waits on a process that never answers or exits on its own.
  const scored = process.score("q", ["d"]);
  for (let i = 0; !existsSync(ignoring) && i < 1_000; i++) await Bun.sleep(10);
  expect(existsSync(ignoring)).toBe(true);
  const pid = process.pid!;
  const started = performance.now();
  await process.close();
  await expect(scored).rejects.toThrow("closed");
  // The grace was given. A close that never killed would not return: the process ignores SIGTERM
  // and never exits, so the test's own timeout is the upper bound.
  expect(performance.now() - started).toBeGreaterThanOrEqual(1_500);
  expect(() => globalThis.process.kill(pid, 0)).toThrow();
}, 15_000);

// Why (the review of 3969dc3a): a reranker whose spawn fails emits "error" and never "exit". A
// close that waited for the exit hung, and with it the hunk and the job, until the deadline.
test("closing a reranker that never spawned returns at once", async () => {
  const process = new RerankerProcess({
    ...fakeWorker("never", answer),
    python: join(directory, "no-such-python"),
  });
  await expect(process.score("q", ["d"])).rejects.toThrow();
  expect(process.failed).toBe(true);
  // A close that waited for an exit would never return: the test's own timeout is the bound.
  await process.close();
});

// Why: one bad input alone must be refused, not fail every later job that meets it again; but a
// model that fails a known-good control text too is broken, a process failure.
test("a lone input with unusable model output is checked against a control text", async () => {
  const closed: Array<string> = [];
  const holder = new Holder(
    "cpu",
    () => modelOutputClient(closed),
    () => new RerankerProcess(fakeWorker("control", answer)),
  );
  const encoder = chunkEncoder(holder, "cpu", "e".repeat(64));
  const alone = await Effect.runPromise(
    encoder.encode([{ path: "b.ts", text: "bad" }]),
  );
  expect(alone).toEqual([
    { kind: "refused", reason: "unnormalizable-model-output" },
  ]);
  expect(closed).toEqual([]);
  await holder.close("idle");
  // Every text fails, the control too: the model is broken.
  const brokenClosed: Array<string> = [];
  const broken = {
    ...modelOutputClient(brokenClosed),
    stats: () => ({ pid: null, loadMillis: null }),
    close: async () => {
      brokenClosed.push("encoder");
    },
    encodeBatch: async () => ({
      kind: "refusal",
      reason: "invalid-model-output",
    }),
  } as unknown as SemanticClient;
  const brokenHolder = new Holder(
    "cpu",
    () => broken,
    () => new RerankerProcess(fakeWorker("broken", answer)),
  );
  const failure = await Effect.runPromise(
    Effect.flip(
      chunkEncoder(brokenHolder, "cpu", "e".repeat(64)).encode([
        { path: "c.ts", text: "anything" },
      ]),
    ),
  );
  expect(failure.message).toContain("control text");
  expect(brokenClosed).toEqual(["encoder"]);
  await brokenHolder.close("idle");
});

// Why (the review of 0a43d9e3): the client serves a text it has encoded before from its cache,
// without the model. A control text that could be cached would pass every later probe even after
// the model broke, and store permanent refusals for chunks that are fine.
test("the control probe tests the model each time, not the client's cache", async () => {
  let broken = false;
  const cache = new Set<string>();
  const client = {
    stats: () => ({ pid: null, loadMillis: null }),
    close: async () => {},
    encodeBatch: async (inputs: ReadonlyArray<{ text: string }>) => {
      const misses = inputs.filter((input) => !cache.has(input.text));
      if (misses.some((input) => broken || input.text.includes("bad")))
        return { kind: "refusal", reason: "invalid-model-output" };
      for (const input of misses) cache.add(input.text);
      return {
        kind: "encoded",
        items: inputs.map(() => ({
          values: Array.from({ length: 768 }, () => 0.036),
        })),
        usage: { generated: misses.length },
      };
    },
  } as unknown as SemanticClient;
  const holder = new Holder(
    "cpu",
    () => client,
    () => new RerankerProcess(fakeWorker("cached", answer)),
  );
  const encoder = chunkEncoder(holder, "cpu", "e".repeat(64));
  expect(
    await Effect.runPromise(encoder.encode([{ path: "a.ts", text: "bad" }])),
  ).toEqual([{ kind: "refused", reason: "invalid-model-output" }]);
  // The model breaks: a lone input now fails, and so must the probe.
  broken = true;
  const failure = await Effect.runPromise(
    Effect.flip(encoder.encode([{ path: "b.ts", text: "fine" }])),
  );
  expect(failure.message).toContain("control text");
  await holder.close("idle");
});
