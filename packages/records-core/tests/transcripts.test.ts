// Why: token figures are cost records that outlive the transcripts (8.10), and nothing downstream can
// tell a miscount or a lost segment from a real one. These cases pin that capture segments tile a
// transcript exactly (no line lost or counted twice, a half-written line deferred to the next
// segment), that a re-run reuses the stored blob, summary and event, and how each harness's usage is
// counted: Claude Code's repeated streaming rows once, Codex's cumulative snapshots as deltas.
import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Logger, Option } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import type { RecordEvent } from "@neuve/records-schema";
import {
  Admin,
  Blobs,
  Computations,
  Identity,
  JobQueue,
  Log,
  JOB_POLICIES,
  Transcripts,
  Worker,
  mintUlid,
  sha256Hex,
  type StoreLocation,
} from "../src/index.ts";
import {
  agent,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const withStores = <A, E>(
  location: StoreLocation,
  program: Effect.Effect<
    A,
    E,
    | Computations.ComputationStore
    | Blobs.BlobStore
    | JobQueue.JobQueue
    | SqlClient
    | FileSystem
  >,
) =>
  runOn(
    location,
    Effect.provide(
      program,
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        Logger.layer([]),
      ),
    ),
  );

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 17, 12, 0, second)).toISOString();
const assistant = (
  id: string,
  second: number,
  output: number,
  content: ReadonlyArray<unknown>,
) =>
  line({
    type: "assistant",
    timestamp: at(second),
    message: {
      id,
      model: "claude-opus-5-5",
      content,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: output,
      },
    },
  });

const event = (
  kind: string,
  key: string,
  attribution: unknown,
  payload: unknown,
  actor: string = agent,
) => ({
  id: mintUlid(),
  kind,
  idempotencyKey: key,
  actor,
  occurredAt: at(0),
  attribution,
  payload,
});

/** Runs every waiting capture job in order, as the worker would, until one fails. */
const captureAll = Effect.gen(function* () {
  const queue = yield* JobQueue.JobQueue;
  const reports: Array<Transcripts.CaptureReport> = [];
  const jobs: Array<JobQueue.Job> = [];
  for (;;) {
    const job = yield* queue.take(["transcript.capture"]);
    if (Option.isNone(job)) break;
    jobs.push(job.value);
    const report = yield* Effect.result(
      Transcripts.captureTranscript(job.value),
    );
    if (report._tag === "Failure")
      return { reports, jobs, failure: report.failure };
    reports.push(report.success);
    yield* queue.complete(job.value.seq, job.value.attempts);
  }
  return { reports, jobs, failure: undefined };
});

test("segments tile the transcript, a response split across segments is counted once, and a re-run reuses everything", async () => {
  const location = freshLocation();
  const path = join(location.directory, "..", "transcript.jsonl");
  const sessionId = "session-1";
  const harness = "claude-code";

  // Turn 1: a prompt and one response streamed as two rows (the second carries the final count).
  writeFileSync(
    path,
    line({ type: "user", timestamp: at(1), message: { content: "prompt" } }) +
      assistant("msg_1", 2, 5, [{ type: "tool_use", id: "tool_1" }]) +
      assistant("msg_1", 3, 40, [{ type: "text" }]),
  );
  const t1End = Bun.file(path).size;
  // Turn 2: a large tool result (a file blob), a response's first row, a subagent's row written into
  // the session's transcript (older Claude Code; it is the subagent's), and the response's second row,
  // still being written when the stop hook records the size: the response straddles the boundary.
  const big = "x".repeat(Blobs.INLINE_MAX_BYTES + 10);
  appendFileSync(
    path,
    line({ type: "user", timestamp: at(4), message: { content: big } }) +
      assistant("msg_2", 5, 7, []) +
      line({
        ...JSON.parse(assistant("msg_side", 5, 1_000, [])),
        isSidechain: true,
      }),
  );
  const straddling = assistant("msg_2", 6, 20, []);
  appendFileSync(path, straddling.slice(0, 20));
  const t2End = Bun.file(path).size;
  appendFileSync(path, straddling.slice(20) + assistant("msg_3", 7, 9, []));
  const sessionEnd = Bun.file(path).size;

  const events = [
    event(
      "session.started@1",
      "session:start",
      { sessionId },
      { harness, transcriptPath: path },
    ),
    event(
      "turn.started@1",
      "t1:start",
      { sessionId, turnKey: "t1" },
      { harness, transcriptPath: path, transcriptOffset: 0 },
    ),
    event(
      "turn.ended@1",
      "t1:end",
      { sessionId, turnKey: "t1" },
      { harness, transcriptPath: path, transcriptOffset: t1End },
    ),
    event(
      "turn.ended@1",
      "t2:end",
      { sessionId, turnKey: "t2" },
      { harness, transcriptPath: path, transcriptOffset: t2End },
    ),
    event(
      "session.ended@1",
      "session:end",
      { sessionId },
      { harness, transcriptPath: path, transcriptOffset: sessionEnd },
    ),
  ];

  const result = await withStores(
    location,
    Effect.gen(function* () {
      yield* Log.append(events);
      const { reports, jobs } = yield* captureAll;
      const rerun = yield* Transcripts.captureTranscript(jobs[0]!);
      const blobs = yield* Blobs.BlobStore;
      const segments: Array<Uint8Array> = [];
      for (const report of reports) {
        const read = yield* blobs.get(report.blob!.hash);
        if (read._tag === "Present") segments.push(read.bytes);
      }
      const summaries = (yield* Log.history({
        kind: "turn.summarized@1",
      })).map(
        (stored) =>
          stored.event as Extract<RecordEvent, { kind: "turn.summarized@1" }>,
      );
      const sql = yield* SqlClient;
      const [activity] =
        yield* sql`SELECT summaries, tokens_input, tokens_cache_creation,
        tokens_cache_read, tokens_output, api_calls, tool_calls
        FROM projection_actor_activity WHERE actor_id = ${agent}`;
      return {
        reports,
        rerun,
        joined: Buffer.concat(segments).toString("utf8"),
        summaries: summaries.map((s) => ({
          segment: s.payload.segment,
          turnKey: s.attribution.turnKey,
          input: s.payload.tokens.input,
          output: s.payload.tokens.output,
          apiCalls: s.payload.apiCalls,
          toolCalls: s.payload.toolCalls,
        })),
        activity,
        checks: yield* Admin.fsck(location),
      };
    }),
  );

  const file = await Bun.file(path).text();
  expect(result.joined).toBe(file);
  expect(
    result.reports.map((r) => [r.segment.fromOffset, r.segment.toOffset]),
  ).toEqual([
    [0, t1End],
    [t1End, t2End - 20],
    [t2End - 20, sessionEnd],
  ]);
  expect(result.reports.map((r) => r.blob?.placement)).toEqual([
    "inline",
    "file",
    "inline",
  ]);
  // The tail adds only msg_2's growth (output 7 to 20) and msg_3; the sidechain row is not counted.
  expect(result.summaries).toEqual([
    {
      segment: "turn",
      turnKey: "t1",
      input: 10,
      output: 40,
      apiCalls: 1,
      toolCalls: 1,
    },
    {
      segment: "turn",
      turnKey: "t2",
      input: 10,
      output: 7,
      apiCalls: 1,
      toolCalls: 0,
    },
    {
      segment: "session-tail",
      turnKey: "t2",
      input: 10,
      output: 22,
      apiCalls: 1,
      toolCalls: 0,
    },
  ]);
  expect(result.rerun).toMatchObject({
    blob: { status: "existing" },
    summary: "reused",
    event: "existing",
  });
  expect(result.activity).toEqual({
    summaries: 3,
    tokensInput: 30,
    tokensCacheCreation: 300,
    tokensCacheRead: 3000,
    tokensOutput: 69,
    apiCalls: 3,
    toolCalls: 1,
  });
  expect(result.checks.filter((c) => c.status !== "ok")).toEqual([]);

  // A transcript other than the session's own is refused; a transcript replaced by different bytes
  // is refused rather than read on from the previous segment's offset.
  const other = join(location.directory, "..", "other.jsonl");
  writeFileSync(other, assistant("msg_9", 8, 1, []));
  writeFileSync(path, "y".repeat(sessionEnd) + assistant("msg_4", 9, 1, []));
  const refused = await withStores(
    location,
    Effect.gen(function* () {
      yield* Log.append([
        event(
          "turn.ended@1",
          "t3:end",
          { sessionId, turnKey: "t3" },
          { harness, transcriptPath: other, transcriptOffset: 10 },
        ),
        event(
          "session.ended@1",
          "session:end:2",
          { sessionId },
          {
            harness,
            transcriptPath: path,
            transcriptOffset: Bun.file(path).size,
          },
        ),
      ]);
      const first = yield* captureAll;
      const second = yield* captureAll;
      return [first.failure?._tag, second.failure?._tag];
    }),
  );
  expect(refused).toEqual(["TranscriptPathRefused", "TranscriptRewritten"]);
});

test("a response is counted once per transcript: rows split by a tool result, and responses re-written after a compaction", async () => {
  const location = freshLocation();
  const folder = join(location.directory, "..", "projects");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "session-2.jsonl");
  const sessionId = "session-2";
  const harness = "claude-code";
  const toolResult = line({
    type: "user",
    timestamp: at(2),
    message: { content: [{ type: "tool_result", tool_use_id: "tool_a" }] },
  });
  // Turn 1 ends between a tool result and the second row of the response that called the tool.
  writeFileSync(
    path,
    line({ type: "user", timestamp: at(1), message: { content: "prompt" } }) +
      assistant("msg_A", 1, 5, [{ type: "tool_use", id: "tool_a" }]) +
      toolResult,
  );
  const t1End = Bun.file(path).size;
  appendFileSync(
    path,
    assistant("msg_A", 3, 30, []) + assistant("msg_B", 4, 3, []),
  );
  const t2End = Bun.file(path).size;
  // A compaction re-writes earlier responses with their IDs and usage, then a new response follows.
  appendFileSync(
    path,
    line({ type: "system", subtype: "compact_boundary", timestamp: at(5) }) +
      assistant("msg_A", 3, 30, []) +
      toolResult +
      assistant("msg_B", 4, 3, []) +
      assistant("msg_C", 6, 7, []),
  );
  const sessionEnd = Bun.file(path).size;
  const turn = (key: string, offset: number) =>
    event(
      "turn.ended@1",
      `${key}:end`,
      { sessionId, turnKey: key },
      { harness, transcriptPath: path, transcriptOffset: offset },
    );
  const result = await withStores(
    location,
    Effect.gen(function* () {
      yield* Log.append([
        event(
          "session.started@1",
          "session-2:start",
          { sessionId },
          { harness, transcriptPath: path },
        ),
        turn("t1", t1End),
        turn("t2", t2End),
        event(
          "session.ended@1",
          "session-2:end",
          { sessionId },
          { harness, transcriptPath: path, transcriptOffset: sessionEnd },
        ),
      ]);
      const { failure } = yield* captureAll;
      const summaries = (yield* Log.history({ kind: "turn.summarized@1" })).map(
        (stored) =>
          stored.event as Extract<RecordEvent, { kind: "turn.summarized@1" }>,
      );
      return {
        failure,
        segments: summaries.map((s) => [
          s.payload.tokens.input,
          s.payload.tokens.cacheRead,
          s.payload.tokens.output,
          s.payload.apiCalls,
        ]),
      };
    }),
  );
  expect(result.failure).toBeUndefined();
  // [input, cache read, output, calls]: msg_A once (5, then grown to 30), msg_B once, msg_C once.
  expect(result.segments).toEqual([
    [10, 1000, 5, 1],
    [10, 1000, 28, 1],
    [10, 1000, 7, 1],
  ]);
});

test("a capture that cannot succeed fails at once; subagent transcripts must sit in their session's subagents folder", async () => {
  const location = freshLocation();
  const root = realpathSync(join(location.directory, ".."));
  const sessionPath = join(root, "projects", "s3.jsonl");
  const subagents = join(root, "projects", "s3", "subagents");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(subagents, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(root, "projects", "s3", "linked"));
  const sub = sessionPath.replace("s3.jsonl", "other-session.jsonl");
  const transcript = assistant("msg_S", 1, 2, []);
  writeFileSync(sessionPath, transcript);
  writeFileSync(join(subagents, "agent-1.jsonl"), transcript);
  writeFileSync(join(elsewhere, "agent-2.jsonl"), transcript);
  writeFileSync(sub, transcript);
  const harness = "claude-code";
  const subagent = sha256Hex("subagent");
  const subagentEnd = (key: string, path: string, sessionId = "s3") =>
    event(
      "turn.ended@1",
      `${key}:end`,
      { sessionId, turnKey: key },
      { harness, transcriptPath: path, transcriptOffset: transcript.length },
      subagent,
    );
  const outcome = await withStores(
    location,
    Effect.gen(function* () {
      yield* Log.append([
        event(
          "session.started@1",
          "s3:start",
          { sessionId: "s3" },
          { harness, transcriptPath: sessionPath },
        ),
        subagentEnd("ok", join(subagents, "agent-1.jsonl")),
        subagentEnd("other", sub),
        subagentEnd(
          "linked",
          join(root, "projects", "s3", "linked", "agent-2.jsonl"),
        ),
        // A session whose start was never recorded (hooks installed mid-session).
        subagentEnd("unknown", join(subagents, "agent-1.jsonl"), "s4"),
      ]);
      const queue = yield* JobQueue.JobQueue;
      const outcomes: Array<string> = [];
      for (;;) {
        const job = yield* queue.take(["transcript.capture"]);
        if (Option.isNone(job)) break;
        const exit = yield* Effect.exit(
          Transcripts.captureTranscript(job.value),
        );
        if (exit._tag === "Success") {
          yield* queue.complete(job.value.seq, job.value.attempts);
          outcomes.push("captured");
          continue;
        }
        const failure = Worker.describeFailure(
          exit.cause,
          JOB_POLICIES["transcript.capture"],
        );
        const failed = yield* queue.fail(
          job.value.seq,
          job.value.attempts,
          failure,
        );
        outcomes.push(
          `${failure.tag} ${failed.state} after ${failed.job.attempts}`,
        );
      }
      return outcomes;
    }),
  );
  expect(outcome).toEqual([
    "captured",
    "TranscriptPathRefused failed after 1",
    "TranscriptPathRefused failed after 1",
    "TranscriptPathRefused failed after 1",
  ]);
});

// Why (8.15): a session whose start the hooks missed may still be captured, but only from its own
// Claude Code transcript in this repository's project folder. A looser check would copy another
// session's prompts into the store, silently.
test("without a recorded start, only the session's own Claude Code transcript in this repository is captured", async () => {
  const location = freshLocation();
  const root = realpathSync(join(location.directory, ".."));
  const repo = join(root, "repo");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  const config = join(root, "claude-config");
  const folders = await Effect.runPromise(
    Transcripts.claudeCodeProjectFolders(join(repo, ".git"), config),
  );
  const folder = join(
    config,
    "projects",
    Transcripts.claudeCodeProjectName(repo)!,
  );
  const foreign = join(config, "projects", "-somewhere-else");
  mkdirSync(folder, { recursive: true });
  mkdirSync(foreign, { recursive: true });
  const transcript = assistant("msg_M", 1, 2, []);
  const own = (sessionId: string) => join(folder, `${sessionId}.jsonl`);
  for (const sessionId of ["m1", "m2", "m5", "m6"])
    writeFileSync(own(sessionId), transcript);
  writeFileSync(join(foreign, "m3.jsonl"), transcript);
  symlinkSync(own("m1"), own("m4"));
  const turnEnd = (
    sessionId: string,
    path: string,
    harness = "claude-code",
    actor = Identity.agentFingerprint({ harness, sessionId }),
  ) =>
    event(
      "turn.ended@1",
      `${sessionId}:end`,
      { sessionId, turnKey: `${sessionId}-t1` },
      { harness, transcriptPath: path, transcriptOffset: transcript.length },
      actor,
    );
  const home: Transcripts.TranscriptHome = {
    claudeCodeProjects: Effect.succeed(folders),
  };
  const outcome = await withStores(
    location,
    Effect.gen(function* () {
      yield* Log.append([
        turnEnd("m1", own("m1")),
        // Another session's transcript in the same folder.
        turnEnd("m2", own("m1")),
        // The session's file name, in another project's folder.
        turnEnd("m3", join(foreign, "m3.jsonl")),
        // The expected path, but a symbolic link to another session's transcript.
        turnEnd("m4", own("m4")),
        // A subagent's turn naming its session's transcript.
        turnEnd("m5", own("m5"), "claude-code", sha256Hex("subagent of m5")),
        // Codex stays refused until its layout is verified.
        turnEnd("m6", own("m6"), "codex"),
      ]);
      const queue = yield* JobQueue.JobQueue;
      const outcomes: Array<string> = [];
      for (;;) {
        const job = yield* queue.take(["transcript.capture"]);
        if (Option.isNone(job)) break;
        const exit = yield* Effect.exit(
          Transcripts.captureTranscript(job.value, home),
        );
        if (exit._tag === "Success") {
          yield* queue.complete(job.value.seq, job.value.attempts);
          outcomes.push("captured");
          continue;
        }
        const failure = Worker.describeFailure(
          exit.cause,
          JOB_POLICIES["transcript.capture"],
        );
        const failed = yield* queue.fail(
          job.value.seq,
          job.value.attempts,
          failure,
        );
        outcomes.push(`${failure.tag} ${failed.state}`);
      }
      return outcomes;
    }),
  );
  expect(folders).toContain(folder);
  expect(outcome).toEqual([
    "captured",
    "TranscriptPathRefused failed",
    "TranscriptPathRefused failed",
    "TranscriptPathRefused failed",
    "TranscriptPathRefused failed",
    "TranscriptPathRefused failed",
  ]);
});

test("Codex usage is the segment's last cumulative snapshot minus the one before it", () => {
  const snapshot = (input: number, cached: number, output: number) =>
    line({
      timestamp: at(input),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 1,
            total_tokens: input + output,
          },
        },
      },
    });
  const segment =
    line({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }) +
    line({ type: "response_item", payload: { type: "function_call" } }) +
    snapshot(30, 10, 8) +
    snapshot(30, 10, 8) +
    snapshot(50, 20, 12);
  const baseline = Transcripts.codexTotalsOfLine(snapshot(20, 5, 4));
  expect(Transcripts.summarizeCodex(segment, baseline)).toMatchObject({
    model: "gpt-6.1-sol",
    tokens: { input: 15, cacheCreation: 0, cacheRead: 15, output: 8 },
    apiCalls: 2,
    toolCalls: 1,
  });
  // A model name the summary cannot keep is dropped; the segment's tokens are still counted.
  const overlong = line({
    type: "turn_context",
    payload: { model: "m".repeat(200) },
  });
  expect(
    Transcripts.summarizeCodex(
      overlong + segment.split("\n").slice(1).join("\n"),
      baseline,
    ),
  ).toMatchObject({ tokens: { output: 8 } });
  expect(Transcripts.summarizeCodex(overlong, baseline).model).toBeUndefined();
});
