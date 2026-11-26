import { RunLog } from "@neuve/harness";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ReviewFeedSnapshotSchema } from "@ace/host/review-protocol";
import { afterAll, expect, spyOn, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Actors,
  Blobs,
  Cycles,
  Identity,
  JobQueue,
  Log,
  Proofs,
  ReviewOrigins,
  Sessions,
  Vents,
  mintUlid,
  resolveStoreLocation,
  sha256Hex,
} from "@neuve/records-core";
import { RecordEvent } from "@neuve/records-schema";
import { defaultConfig } from "@neuve/harness/config";
import {
  nativeReviewCallbacks,
  nativeReviewStatus,
  recordsReviewFeed,
  readReviewFeedSnapshot,
} from "../src/workspace-native-review";
import { execute, withStore } from "../src/records-cli";
import { requestRangeReview } from "../src/review-cli";
import {
  newShapeReview,
  receipt,
} from "../../../packages/records-core/tests/review-fixtures";
import {
  contentLayer,
  storeContent,
} from "../../../packages/records-core/tests/new-shape-support";
import type {
  PreparedReview,
  ReviewStatusQuery,
} from "@ace/host/review-protocol";

const root = mkdtempSync(join(tmpdir(), "native-review-records-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", root, ...args]);
  if (r.exitCode) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const mockProcessTable = (rows: string) => {
  const bin = mkdtempSync(join(tmpdir(), "native-review-process-table-"));
  const path = process.env.PATH;
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nprintf '%s\\n' '${rows}'\n`, {
    mode: 0o700,
  });
  process.env.PATH = `${bin}:${path ?? ""}`;
  return () => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  };
};
git("init", "-qb", "main");
git("config", "user.email", "fixture@example.test");
git("config", "user.name", "Fixture");
for (const text of ["before", "after"]) {
  writeFileSync(join(root, "work.txt"), text);
  git("add", "work.txt");
  git("commit", "-qm", text);
}
const base = git("rev-parse", "HEAD^");
const head = git("rev-parse", "HEAD");
const config = defaultConfig();
if (config.route.provider !== "anthropic")
  throw new Error("Unexpected fixture route");
// defaultConfig() hands out the shared OPUS_ROUTE: mutating it would change every later file's
// default route in this test process, so the fixture's route is a copy.
config.route = {
  ...config.route,
  credentialVariable: "NEUVE_FIXTURE_MISSING_REVIEW_KEY",
};
const link = async (_project: string, reference: string) =>
  `http://127.0.0.1:4040/?cycle=${reference}`;
// Every queued or recovered review asks for a worker of this build; here they are recorded, so the
// tests below drive the queue themselves (review-worker.test.ts runs the real keeper).
const kept: Array<{ readonly project: string; readonly job: number }> = [];
const callbacks = nativeReviewCallbacks(
  link,
  async (project) => project,
  async (input) => kept.push(input),
  () => Effect.succeed(config),
);
const prepared = (): PreparedReview => ({
  requestId: mintUlid(),
  target: { kind: "project-branch", against: base },
  handoff: {
    project: root,
    cwd: root,
    base,
    head,
    channel: "native-fixture",
    chat: 0,
    origin: {
      kind: "channel",
      host: "fixture",
      channel: "native-fixture",
      chat: 0,
      items: [],
    },
    externalSources: [],
  },
  config: z.json().parse(JSON.parse(JSON.stringify(config))),
});
const write = <A, E>(
  program: Effect.Effect<A, E, SqlClient | JobQueue.JobQueue>,
) =>
  execute(
    withStore(root, "write", program.pipe(Effect.provide(JobQueue.layer))),
  );
const requireReview = (
  result: Awaited<ReturnType<typeof callbacks.reviewSubmit>>,
) => {
  if (result.kind !== "review") throw new Error(result.message);
  return result;
};

test("real admission is queued without credentials; lost reply after failure recovers exact job despite source drift", async () => {
  const intent = prepared();
  const validations: boolean[] = [];
  const first = requireReview(
    await callbacks.reviewSubmit(intent, async (current) => {
      validations.push(current);
    }),
  );
  expect(first).toMatchObject({
    state: "queued",
    queue: "waiting",
    base,
    head,
  });
  await write(
    Effect.gen(function* () {
      const q = yield* JobQueue.JobQueue;
      yield* q.drop(first.job);
    }),
  );
  writeFileSync(join(root, "work.txt"), "moved and dirty");
  const repeated = requireReview(
    await callbacks.reviewSubmit(intent, async (current) => {
      validations.push(current);
      if (current) throw new Error("Dirty source");
    }),
  );
  expect(repeated).toMatchObject({
    request: first.request,
    reference: first.reference,
    job: first.job,
    run: first.run,
    state: "failed",
  });
  expect(validations).toEqual([true, false]);
  const span = z.object({
    type: z.string(),
    name: z.string().optional(),
    spanId: z.string().optional(),
  });
  const submissions = readFileSync(
    join(root, ".git", "neuve", "admission-logs", `${intent.requestId}.jsonl`),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => span.parse(JSON.parse(line)))
    .filter(
      (record) =>
        record.type === "span" &&
        record.name === "harness.admission.review-submit",
    );
  expect(submissions).toHaveLength(2);
  expect(new Set(submissions.map((record) => record.spanId)).size).toBe(2);

  const fresh = requireReview(
    await callbacks.reviewSubmit(prepared(), async () => {}),
  );
  expect(fresh.job).not.toBe(first.job);
  // The queued, recovered and fresh submits each asked for a worker of this build for their job.
  expect(kept.slice(-3).map((entry) => entry.job)).toEqual([
    first.job,
    first.job,
    fresh.job,
  ]);
  expect(fresh.run).not.toBe(first.run);
  expect(await nativeReviewStatus(root, first, link)).toMatchObject({
    state: "failed",
    job: first.job,
    run: first.run,
  });
  await expect(
    nativeReviewStatus(root, { ...first, job: fresh.job }, link),
  ).rejects.toThrow("do not belong");
  await expect(
    nativeReviewStatus(root, { ...first, reference: mintUlid() }, link),
  ).rejects.toThrow("does not belong");
  const registered = await execute(
    withStore(
      root,
      "read",
      Log.history({ kind: "actor.registered@1", limit: 10 }),
    ),
  );
  expect(registered).toHaveLength(1);
  expect(registered[0]?.event).toMatchObject({
    payload: {
      harness: "neuve-pi",
      sessionId: "native-fixture",
      subagentId: "0",
    },
  });
  git("checkout", "--", "work.txt");
});

test("exact status distinguishes running, queue-only completion, receipt completion and pruned jobs", async () => {
  const intent = prepared();
  const accepted = requireReview(
    await callbacks.reviewSubmit(intent, async () => {}),
  );
  const query: ReviewStatusQuery = accepted;
  const active = await write(
    Effect.gen(function* () {
      const q = yield* JobQueue.JobQueue;
      return Option.getOrThrow(yield* q.take(["review.run", "review.run@2"]));
    }),
  );
  expect(active.seq).toBe(accepted.job);
  expect(await nativeReviewStatus(root, query, link)).toMatchObject({
    state: "running",
    recorded: { receipt: null },
  });
  await write(
    Effect.gen(function* () {
      const q = yield* JobQueue.JobQueue;
      yield* q.complete(active.seq, active.attempts);
    }),
  );
  expect(await nativeReviewStatus(root, query, link)).toMatchObject({
    state: "incomplete",
    queue: "completed",
    recorded: { receipt: null, complete: false },
  });
  const requested = await execute(
    withStore(root, "read", Log.get(accepted.request)),
  );
  if (
    Option.isNone(requested) ||
    requested.value.event.kind !== "review.requested@1"
  )
    throw new Error("Missing request");
  const request = requested.value.event;
  const receiptId = mintUlid();
  await write(
    Log.append([
      RecordEvent.parse({
        id: receiptId,
        kind: "run.completed@1",
        idempotencyKey: `receipt:${receiptId}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: { ...request.attribution, runId: accepted.run },
        payload: {
          ...receipt(request.payload.runKey, 0),
          jobSeq: accepted.job,
          generation: request.payload.generation,
        },
      }),
    ]),
  );
  expect(await nativeReviewStatus(root, query, link)).toMatchObject({
    state: "completed",
    recorded: { receipt: receiptId, packet: null, complete: false },
  });
  await write(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM jobs WHERE job_seq=${accepted.job}`;
    }),
  );
  expect(await nativeReviewStatus(root, query, link)).toMatchObject({
    state: "completed",
    queue: null,
    recorded: { receipt: receiptId },
  });
  expect(
    await callbacks.reviewSubmit(intent, async (current) => {
      expect(current).toBe(false);
    }),
  ).toMatchObject({
    request: accepted.request,
    job: accepted.job,
    run: accepted.run,
    state: "completed",
    queue: null,
  });
});

test("a recorded timed-out run remains timed-out without a published packet", async () => {
  const intent = prepared();
  const changed = defaultConfig();
  if (changed.route.provider !== "anthropic")
    throw new Error("Unexpected fixture route");
  changed.route = {
    ...changed.route,
    credentialVariable: "NEUVE_FIXTURE_MISSING_REVIEW_KEY",
  };
  changed.budgets.lifetimeMs += 11;
  intent.config = z.json().parse(JSON.parse(JSON.stringify(changed)));
  const accepted = requireReview(
    await callbacks.reviewSubmit(intent, async () => {}),
  );
  const requested = await execute(
    withStore(root, "read", Log.get(accepted.request)),
  );
  if (
    Option.isNone(requested) ||
    requested.value.event.kind !== "review.requested@1"
  )
    throw new Error("Missing request");
  const request = requested.value.event;
  const payload = receipt(request.payload.runKey, 0);
  const id = mintUlid();
  await write(
    Log.append([
      RecordEvent.parse({
        id,
        kind: "run.completed@1",
        idempotencyKey: `receipt:${id}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: { ...request.attribution, runId: accepted.run },
        payload: {
          ...payload,
          outcome: "timed-out",
          timeout: { ...payload.timeout, reached: true },
          jobSeq: accepted.job,
          generation: request.payload.generation,
        },
      }),
    ]),
  );
  expect(await nativeReviewStatus(root, accepted, link)).toMatchObject({
    state: "timed-out",
    recorded: { receipt: id, packet: null, complete: false, units: null },
  });
});

test("incomplete undecoded packet stays disclosed and a later standing packet is not attributed to the admitted run", async () => {
  const intent = prepared();
  const ownConfig = defaultConfig();
  if (ownConfig.route.provider !== "anthropic")
    throw new Error("Unexpected fixture route");
  ownConfig.route = {
    ...ownConfig.route,
    credentialVariable: "NEUVE_FIXTURE_MISSING_REVIEW_KEY",
  };
  ownConfig.budgets.lifetimeMs += 22;
  intent.config = z.json().parse(JSON.parse(JSON.stringify(ownConfig)));
  const accepted = requireReview(
    await callbacks.reviewSubmit(intent, async () => {}),
  );
  const requested = await execute(
    withStore(root, "read", Log.get(accepted.request)),
  );
  if (
    Option.isNone(requested) ||
    requested.value.event.kind !== "review.requested@1"
  )
    throw new Error("Missing request");
  const request = requested.value.event;
  const blob = await execute(
    withStore(root, "write", (location) =>
      Effect.gen(function* () {
        const b = yield* Blobs.BlobStore;
        return yield* b.put({
          bytes: new TextEncoder().encode("{}"),
          mediaType: "application/json",
          retention: "durable",
        });
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );
  const packet = (id: string, run: string, supersedes?: string) =>
    RecordEvent.parse({
      id,
      kind: "packet.published@1",
      idempotencyKey: `packet:${id}`,
      actor: request.actor,
      occurredAt: new Date().toISOString(),
      attribution: { ...request.attribution, runId: run },
      ...(supersedes ? { causation: { supersedes } } : {}),
      payload: {
        complete: false,
        counts: {
          batches: 0,
          units: 0,
          contextReferences: 0,
          assessments: 0,
          deliveries: 0,
          dispositions: 0,
          comments: 0,
          gaps: 1,
        },
      },
      refs: [{ ref: `blob:${blob.blob.hash}`, role: "manifest" }],
    });
  const firstPacket = mintUlid();
  await write(Log.append([packet(firstPacket, accepted.run)]));
  expect(await nativeReviewStatus(root, accepted, link)).toMatchObject({
    state: "queued",
    recorded: { packet: firstPacket, complete: false, undecoded: 1 },
  });
  ownConfig.budgets.lifetimeMs += 1;
  const newer = prepared();
  newer.config = z.json().parse(JSON.parse(JSON.stringify(ownConfig)));
  const later = requireReview(
    await callbacks.reviewSubmit(newer, async () => {}),
  );
  await write(Log.append([packet(mintUlid(), later.run, firstPacket)]));
  expect(await nativeReviewStatus(root, accepted, link)).toMatchObject({
    run: accepted.run,
    recorded: {
      packet: null,
      units: null,
      message: expect.stringContaining("newer standing packet"),
    },
  });
});

const settle = async (condition: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error("Records feed did not converge");
};
const newIntent = (lifetime: number) => {
  const intent = prepared();
  const frozen = defaultConfig();
  if (frozen.route.provider !== "anthropic")
    throw new Error("Unexpected fixture route");
  frozen.route = {
    ...frozen.route,
    credentialVariable: "NEUVE_FIXTURE_MISSING_REVIEW_KEY",
  };
  frozen.budgets.lifetimeMs += lifetime;
  intent.config = z.json().parse(JSON.parse(JSON.stringify(frozen)));
  intent.handoff.branch = "main";
  return intent;
};

// Requests must retain their targets and reach only their owning channel, including after catch-up.
test("the Records request feed catches up on CLI reviews of its channel", async () => {
  const channel = "request-feed";
  const requester = {
    _tag: "Agent" as const,
    ...Identity.aceChatIdentity(channel, 7),
  };
  const range = `${base}..${head}`;
  const branch = "request-feed-branch";
  git("branch", branch, head);
  try {
    const tool = newIntent(61);
    tool.handoff.channel = channel;
    tool.handoff.chat = 7;
    tool.handoff.origin = {
      kind: "channel",
      host: "fixture",
      channel,
      chat: 7,
      items: [],
    };
    await callbacks.reviewSubmit(tool, async () => {});
    const first = mintUlid();
    await requestRangeReview(root, range, {
      requestId: first,
      requester,
      branch,
      frozenConfig: config,
    });
    await requestRangeReview(root, range, {
      requester: {
        _tag: "Agent",
        ...Identity.aceChatIdentity("foreign-request-feed", 7),
      },
      frozenConfig: config,
    });
    git("branch", "-D", branch);
    const signal = AbortSignal.timeout(5000);
    expect(
      (await callbacks.reviewRequests(root, channel, 0, signal))?.requests,
    ).toEqual([
      {
        review: first,
        chat: 7,
        at: expect.any(Number),
        baseRef: base,
        range: { base, head, branch, commits: 1 },
        pullRequest: null,
      },
    ]);
  } finally {
    git("update-ref", "-d", `refs/heads/${branch}`);
  }
}, 15000);

// A review committed after subscription must reach the worker without a polling interval.
test("a Records file change wakes a waiting CLI review request", async () => {
  const channel = "live-request-feed";
  const pull = "refs/pull/42/head";
  const stop = new AbortController();
  git("update-ref", pull, head);
  const following = callbacks.reviewRequests(root, channel, 0, stop.signal);
  void following.catch(() => {});
  try {
    await Bun.sleep(150);
    const second = mintUlid();
    await requestRangeReview(root, `${base}..${pull}`, {
      requestId: second,
      requester: { _tag: "Agent", ...Identity.aceChatIdentity(channel, 7) },
      frozenConfig: config,
    });
    expect((await following)?.requests).toEqual([
      {
        review: second,
        chat: 7,
        at: expect.any(Number),
        baseRef: base,
        range: { base, head, branch: "", commits: 1 },
        pullRequest: 42,
      },
    ]);
  } finally {
    stop.abort();
    await following.catch(() => {});
    git("update-ref", "-d", pull);
  }
}, 15000);

// A batch with no usable requests must still advance, or it blocks every later card.
test("the Records request feed advances past a missing presentation", async () => {
  const channel = "missing-presentation";
  const requester = {
    _tag: "Agent" as const,
    ...Identity.aceChatIdentity(channel, 7),
  };
  const range = `${base}..${head}`;
  const seed = mintUlid();
  const bad = mintUlid();
  await requestRangeReview(root, range, {
    requestId: seed,
    requester,
    frozenConfig: config,
  });
  const { after, skippedThrough } = await write(
    Effect.gen(function* () {
      const initial = Option.getOrThrow(yield* Log.get(seed));
      const [skipped] = yield* Log.append([
        {
          ...initial.event,
          id: bad,
          idempotencyKey: `review.requested:${bad}`,
          refs: [
            { role: "command-line-review", ref: `blob:${"0".repeat(64)}` },
          ],
        },
      ]);
      return { after: initial.seq, skippedThrough: skipped!.seq };
    }),
  );
  const warning = spyOn(console, "error");
  try {
    const signal = AbortSignal.timeout(5000);
    expect(
      await callbacks.reviewRequests(root, channel, after, signal),
    ).toEqual({ after: skippedThrough, requests: [] });
    const good = mintUlid();
    await requestRangeReview(root, range, {
      requestId: good,
      requester,
      frozenConfig: config,
    });
    expect(
      (await callbacks.reviewRequests(root, channel, skippedThrough, signal))
        ?.requests,
    ).toEqual([
      {
        review: good,
        chat: 7,
        at: expect.any(Number),
        baseRef: base,
        range: { base, head, branch: "main", commits: 1 },
        pullRequest: null,
      },
    ]);
    const skipped = warning.mock.calls.filter((call) =>
      call.includes(`Skipping review request ${bad}`),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContainEqual(
      expect.objectContaining({ _tag: "BlobMissing" }),
    );
  } finally {
    warning.mockRestore();
  }
}, 15000);

// A missing worker process row must leave channel startup available.
test("a channel worker with no process row opens without a live session", async () => {
  const channel = "no-worker-row";
  const location = await execute(resolveStoreLocation(root));
  await execute(withStore(root, "create", Effect.void));
  const warnings: unknown[] = [];
  const restoreProcessTable = mockProcessTable("");
  try {
    expect(
      await Sessions.openAceChannelSession(root, channel, (error) =>
        warnings.push(error),
      ),
    ).toBeUndefined();
  } finally {
    restoreProcessTable();
  }
  expect(warnings).toEqual([
    expect.objectContaining({
      message: "Cannot identify the channel worker process",
    }),
  ]);
  expect(
    await execute(
      withStore(
        root,
        "read",
        Sessions.readSession(location, "neuve-pi", channel),
      ),
    ),
  ).toBeUndefined();
});

// A chat's first CLI command can arrive before Records has registered its actor or opened a turn.
test("CLI review, proof and vent record their owning Ace chats", async () => {
  const previousChat = process.env.NEUVE_ACE_CHAT;
  const location = await execute(resolveStoreLocation(root));
  const channel = "cli-fixture";
  const range = `${base}..${head}`;
  const requestId = mintUlid();
  await execute(withStore(root, "create", Effect.void));
  const restoreProcessTable = mockProcessTable(
    `${process.pid} 1 Sat Oct 17 13:30:35 2026 bun`,
  );
  try {
    const close = await Sessions.openAceChannelSession(
      root,
      channel,
      (error) => {
        throw error;
      },
    );
    if (!close) throw new Error("The fixture's Records store was not opened");
    try {
      expect(
        await execute(withStore(root, "read", Sessions.listSessions(location))),
      ).toEqual([]);
      process.env.NEUVE_ACE_CHAT = "cli-fixture/7";
      await requestRangeReview(root, range, {
        requestId,
        branch: "main",
        frozenConfig: {
          ...config,
          budgets: {
            ...config.budgets,
            lifetimeMs: config.budgets.lifetimeMs + 57,
          },
        },
      });
      expect(
        await readReviewFeedSnapshot(root, channel, { chat: 7 }),
      ).toMatchObject({
        review: requestId,
        chat: 7,
        progress: { phase: "queued" },
      });
      process.env.NEUVE_ACE_CHAT = "other-channel/7";
      const unownedId = mintUlid();
      const unowned = await requestRangeReview(root, range, {
        requestId: unownedId,
        branch: "main",
        frozenConfig: config,
      });
      expect(unowned.request.actor).toBe(
        Identity.humanFingerprint("fixture@example.test"),
      );
      await expect(
        callbacks.reviewLookup(root, channel, { review: unownedId, chat: 7 }),
      ).rejects.toThrow("does not hold this review request");
      process.env.NEUVE_ACE_CHAT = "cli-fixture/8";
      const proof = await execute(
        withStore(
          root,
          "write",
          Proofs.recordAsCaller(location, {
            repository: root,
            input: {
              kind: "log",
              range,
              text: "fixture output",
              claim: "The fixture ran.",
              requirement: "Keep the chat's proof.",
            },
            mask: (text) => text,
          }).pipe(Effect.provide(Blobs.layer(location))),
        ),
      );
      expect(proof).toMatchObject({
        status: "recorded",
        caller: { subagentId: "8" },
      });
      process.env.NEUVE_ACE_CHAT = "cli-fixture/9";
      const vent = await execute(
        withStore(
          root,
          "write",
          Vents.ventAsCaller(location, { text: "fixture vent" }).pipe(
            Effect.provide(Blobs.layer(location)),
          ),
        ),
      );
      expect(vent).toMatchObject({
        status: "recorded",
        caller: { subagentId: "9" },
      });
      const rows = await execute(
        withStore(
          root,
          "read",
          Effect.all({
            actors: Actors.list,
            proofs: Log.history({ kind: "proof.recorded@1" }),
            vents: Log.history({ kind: "vent.recorded@2" }),
          }),
        ),
      );
      expect(
        rows.actors
          .filter((actor) => actor.sessionId === channel)
          .map((actor) => actor.subagentId)
          .sort(),
      ).toEqual(["7", "8", "9"]);
      expect(rows.proofs.at(-1)?.event).toMatchObject({
        actor: Identity.aceChatIdentity(channel, 8).actorId,
        attribution: { sessionId: channel },
      });
      expect(rows.proofs.at(-1)?.event.attribution).not.toHaveProperty(
        "turnKey",
      );
      expect(rows.vents.at(-1)?.event).toMatchObject({
        actor: Identity.aceChatIdentity(channel, 9).actorId,
        attribution: { sessionId: channel },
      });
    } finally {
      await close();
    }
    expect(
      await execute(
        withStore(
          root,
          "read",
          Sessions.readSession(location, "neuve-pi", channel),
        ),
      ),
    ).toBeUndefined();
  } finally {
    restoreProcessTable();
    if (previousChat === undefined) delete process.env.NEUVE_ACE_CHAT;
    else process.env.NEUVE_ACE_CHAT = previousChat;
  }
});

test("request-only lookup resolves the chat's latest job/run and the Records watch reports queue and stage progression", async () => {
  const intent = newIntent(41);
  const accepted = requireReview(
    await callbacks.reviewSubmit({ ...intent, notify: true }, async () => {}),
  );
  expect(accepted.admission).toEqual({
    recovered: false,
    notify: true,
    commits: 1,
    branch: "main",
  });
  const recovered = requireReview(
    await callbacks.reviewSubmit({ ...intent, notify: true }, async () => {}),
  );
  expect(recovered.admission?.recovered).toBe(true);
  expect(
    await callbacks.reviewLookup(root, "native-fixture", { chat: 0 }),
  ).toMatchObject({ review: intent.requestId, state: "queued" });
  await expect(
    callbacks.reviewLookup(root, "other-channel", {
      chat: 0,
      review: intent.requestId,
    }),
  ).rejects.toThrow("does not hold this review request");
  const values: import("@ace/host/review-protocol").ReviewFeedSnapshot[] = [];
  const failures: unknown[] = [];
  const source = recordsReviewFeed(root, "native-fixture", {
    intervalMs: 300,
    report: (error) => failures.push(error),
  });
  const stop = await source.watch(
    intent.requestId,
    async (raw) => {
      values.push(ReviewFeedSnapshotSchema.parse(raw));
    },
    BACKGROUND_CONTEXT,
  );
  try {
    expect(values.at(-1)?.progress).toEqual({ phase: "queued" });
    const initialSequence = values.at(-1)!.sequence;
    await write(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`UPDATE jobs SET state = 'active' WHERE job_seq = ${accepted.job}`;
      }),
    );
    await settle(() => values.at(-1)?.progress.phase === "running");
    expect(values.at(-1)!.sequence).toBe(initialSequence);
    const requested = Option.getOrThrow(
      await execute(withStore(root, "read", Log.get(intent.requestId))),
    ).event;
    for (const [stage, next] of [
      ["precompute", "frame"],
      ["frame", "map"],
    ] as const) {
      const id = mintUlid();
      await write(
        Log.append([
          RecordEvent.parse({
            id,
            kind: "stage.completed@1",
            idempotencyKey: `stage:${id}`,
            actor: requested.actor,
            occurredAt: new Date().toISOString(),
            attribution: {
              ...requested.attribution,
              runId: accepted.run,
              stage,
            },
            payload: {
              stage,
              agent: `${stage}.plan`,
              status: "computed",
              wallMs: 1,
              modelCalls: 0,
              usage: {
                input: 0,
                cacheWrite5m: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
                output: 0,
              },
              costUsd: null,
            },
          }),
        ]),
      );
      await write(
        Log.append([
          RecordEvent.parse({
            id: mintUlid(),
            kind: "stage.started@1",
            idempotencyKey: `start:${id}`,
            actor: requested.actor,
            occurredAt: new Date().toISOString(),
            attribution: {
              ...requested.attribution,
              runId: accepted.run,
              stage: next,
            },
            payload: { agent: `${next}.plan` },
          }),
        ]),
      );
      await settle(() => {
        const progress = values.at(-1)?.progress;
        return progress?.phase === "running" && progress.stage?.name === next;
      });
    }
    expect(
      await callbacks.reviewLookup(root, "native-fixture", {
        review: intent.requestId,
        chat: 0,
      }),
    ).toMatchObject({
      state: "running",
      stage: { name: "map", done: 2, of: 7 },
    });
    const body = receipt(
      requested.kind === "review.requested@1" ? requested.payload.runKey : "",
      0,
    );
    body.jobSeq = accepted.job;
    const ended = RecordEvent.parse({
      id: mintUlid(),
      kind: "run.completed@1",
      idempotencyKey: `stopped:${accepted.run}`,
      actor: requested.actor,
      occurredAt: new Date().toISOString(),
      attribution: { ...requested.attribution, runId: accepted.run },
      payload: {
        ...body,
        outcome: "timed-out",
        timeout: {
          ...body.timeout,
          reached: true,
          disclosed: [
            {
              stage: "find",
              status: "interrupted",
              note: "Recorded fixture deadline",
            },
          ],
        },
      },
    });
    await write(Log.append([ended]));
    await settle(() => values.at(-1)?.progress.phase === "stopped");
    expect(values.at(-1)?.progress).toEqual({
      phase: "stopped",
      reason: "find: Recorded fixture deadline",
    });
    expect(
      await callbacks.reviewOutcome(root, "native-fixture", {
        chat: 0,
        review: intent.requestId,
      }),
    ).toEqual({ outcome: "not_finished", state: "stopped" });
    expect(failures).toEqual([]);
  } finally {
    await stop();
  }
}, 15000);

test("finished Records packets supply counts by review lane, open human judgment and completeness", async () => {
  const intent = newIntent(42);
  const accepted = requireReview(
    await callbacks.reviewSubmit({ ...intent, notify: false }, async () => {}),
  );
  const request = Option.getOrThrow(
    await execute(withStore(root, "read", Log.get(intent.requestId))),
  ).event;
  if (request.kind !== "review.requested@1") throw new Error("Missing request");
  const batchId = mintUlid();
  const events = [
    RecordEvent.parse({
      id: batchId,
      kind: "batch.recorded@1",
      idempotencyKey: `batch:${batchId}`,
      actor: request.actor,
      occurredAt: new Date().toISOString(),
      attribution: { cycleId: accepted.reference, batchId },
      payload: { title: "Fixture", focus: "Counts" },
    }),
  ];
  const units: { unit: string; unitId: string }[] = [];
  for (const [index, lane] of [
    "human-required",
    "human-suggested",
    "agentic",
    "static-automation",
  ].entries()) {
    const unitId = mintUlid();
    units.push({ unit: `u${index + 1}`, unitId });
    events.push(
      RecordEvent.parse({
        id: mintUlid(),
        kind: "unit.recorded@2",
        idempotencyKey: `unit:${unitId}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: {
          cycleId: accepted.reference,
          batchId,
          unitIds: [unitId],
        },
        payload: {
          title: lane,
          ownedRanges: [
            {
              kind: "lines",
              path: "work.txt",
              side: "new",
              startLine: index + 1,
              endLine: index + 1,
            },
          ],
          grouping: { gapLines: 20 },
        },
      }),
    );
    events.push(
      RecordEvent.parse({
        id: mintUlid(),
        kind: "assessment.recorded@1",
        idempotencyKey: `assessment:${unitId}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: { cycleId: accepted.reference, unitIds: [unitId] },
        payload: {
          lane,
          complexity: "high",
          easeOfValidation: "hard",
          rationale: "Fixture",
        },
      }),
    );
  }
  await write(Log.append(events));
  const manifest = {
    batches: [
      {
        batch: "b1",
        batchId,
        units,
        events: events.map((event) => ({ id: event.id, kind: event.kind })),
      },
    ],
  };
  const blob = await execute(
    withStore(root, "write", (location) =>
      Effect.gen(function* () {
        const store = yield* Blobs.BlobStore;
        return yield* store.put({
          bytes: new TextEncoder().encode(JSON.stringify(manifest)),
          mediaType: "application/json",
          retention: "durable",
        });
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );
  const payload = receipt(request.payload.runKey, 0);
  payload.jobSeq = accepted.job;
  payload.gaps = [];
  await write(
    Log.append([
      RecordEvent.parse({
        id: mintUlid(),
        kind: "packet.published@1",
        idempotencyKey: `packet:${accepted.run}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: { ...request.attribution, runId: accepted.run },
        payload: {
          complete: true,
          counts: {
            batches: 1,
            units: 4,
            contextReferences: 0,
            assessments: 4,
            deliveries: 0,
            dispositions: 0,
            comments: 0,
            gaps: 0,
          },
        },
        refs: [{ ref: `blob:${blob.blob.hash}`, role: "manifest" }],
      }),
      RecordEvent.parse({
        id: mintUlid(),
        kind: "run.completed@1",
        idempotencyKey: `completed:${accepted.run}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: { ...request.attribution, runId: accepted.run },
        payload,
      }),
    ]),
  );
  const snapshot = await readReviewFeedSnapshot(root, "native-fixture", {
    review: intent.requestId,
  });
  expect(snapshot.progress).toEqual({
    phase: "finished",
    finished: {
      units: 4,
      byReviewLane: {
        humanRequired: 1,
        humanSuggested: 1,
        agentic: 1,
        static: 1,
      },
      needJudgment: 1,
      complete: true,
      gaps: 0,
      undecoded: 1,
    },
  });
  expect(
    await callbacks.reviewOutcome(root, "native-fixture", {
      chat: 0,
      review: intent.requestId,
    }),
  ).toEqual({
    review: intent.requestId,
    complete: true,
    units: 4,
    gaps: 0,
    undecoded: 1,
  });
  const reply = await callbacks.reviewFeed(root, "native-fixture", {
    review: intent.requestId,
  });
  expect(reply?.snapshot.progress.phase).toBe("finished");
  const repeated: import("@ace/host/review-protocol").ReviewFeedSnapshot[] = [];
  const stop = await recordsReviewFeed(root, "native-fixture").watch(
    intent.requestId,
    async (raw) => {
      repeated.push(ReviewFeedSnapshotSchema.parse(raw));
    },
    BACKGROUND_CONTEXT,
  );
  await stop();
  expect(repeated[0]?.progress).toEqual(snapshot.progress);
  const later = requireReview(
    await callbacks.reviewSubmit(
      { ...newIntent(43), notify: false },
      async () => {},
    ),
  );
  const [originalPacket] = await execute(
    withStore(
      root,
      "read",
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{
          id: string;
        }>`SELECT id FROM events WHERE kind = 'packet.published@1'
      AND json_extract(envelope, '$.attribution.runId') = ${accepted.run} ORDER BY id LIMIT 1`;
      }),
    ),
  );
  if (!originalPacket) throw new Error("Missing original packet");
  await write(
    Log.append([
      RecordEvent.parse({
        id: mintUlid(),
        kind: "packet.published@1",
        idempotencyKey: `newer-packet:${later.run}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: { ...request.attribution, runId: later.run },
        causation: { supersedes: originalPacket.id },
        payload: {
          complete: false,
          counts: {
            batches: 1,
            units: 9,
            contextReferences: 0,
            assessments: 0,
            deliveries: 0,
            dispositions: 0,
            comments: 0,
            gaps: 0,
          },
        },
        refs: [{ ref: `blob:${blob.blob.hash}`, role: "manifest" }],
      }),
    ]),
  );
  expect(
    (
      await readReviewFeedSnapshot(root, "native-fixture", {
        review: intent.requestId,
      })
    ).progress,
  ).toEqual(snapshot.progress);
}, 15000);

test("concurrent replay of one admission recovers the same Records identity", async () => {
  const intent = { ...newIntent(44), notify: true };
  const [first, replay] = await Promise.all([
    callbacks.reviewSubmit(intent, async () => {}),
    callbacks.reviewSubmit(intent, async () => {}),
  ]);
  const a = requireReview(first),
    b = requireReview(replay);
  expect([a.request, a.job, a.run]).toEqual([b.request, b.job, b.run]);
  expect(a.admission?.recovered).toBe(false);
  expect(b.admission?.recovered).toBe(true);
});

test("a stopped card never exposes raw job error text", async () => {
  const intent = { ...newIntent(45), notify: false };
  const admitted = requireReview(
    await callbacks.reviewSubmit(intent, async () => {}),
  );
  const request = Option.getOrThrow(
    await execute(withStore(root, "read", Log.get(intent.requestId))),
  ).event;
  await write(
    Log.append([
      RecordEvent.parse({
        id: mintUlid(),
        kind: "stage.started@1",
        idempotencyKey: `failed-stage:${admitted.run}`,
        actor: request.actor,
        occurredAt: new Date().toISOString(),
        attribution: {
          ...request.attribution,
          runId: admitted.run,
          stage: "understand",
        },
        payload: { agent: "understand" },
      }),
    ]),
  );
  const raw =
    "ProviderFailure: internal request trace with implementation details";
  await write(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const cause = JSON.stringify({
        tag: "ProviderFailure",
        message: raw,
        at: new Date().toISOString(),
        attempt: 1,
      });
      yield* sql`UPDATE jobs SET state = 'failed', last_error = ${cause} WHERE job_seq = ${admitted.job}`;
    }),
  );
  const snapshot = await readReviewFeedSnapshot(root, "native-fixture", {
    review: intent.requestId,
  });
  expect(snapshot.progress).toEqual({
    phase: "stopped",
    reason:
      "understand: Records marked the review job as failed without a terminal receipt.",
  });
  expect(JSON.stringify(snapshot)).not.toContain(raw);
});

// Admission must retain names in Records across recovery, independently of later checkout names.
test("admission keeps project, branch and comparison names in Records without changing the pinned commits", async () => {
  const intent = newIntent(151);
  intent.handoff.origin.display = {
    project: "limits",
    branch: "feature/size-limits",
    base: "main",
  };
  const accepted = requireReview(
    await callbacks.reviewSubmit(intent, async () => {}),
  );
  const recovered = requireReview(
    await callbacks.reviewSubmit(intent, async () => {}),
  );
  expect(recovered.reference).toBe(accepted.reference);
  const origins = await execute(
    withStore(
      root,
      "read",
      ReviewOrigins.list({ reference: accepted.reference }),
    ),
  );
  expect(origins.filter((entry) => entry.origin.display)).toEqual([
    expect.objectContaining({
      base,
      head,
      origin: expect.objectContaining({
        display: {
          project: "limits",
          branch: "feature/size-limits",
          base: "main",
        },
      }),
    }),
  ]);
});

test("abandoned and rejected admissions are not discovered as review runs", async () => {
  const intent = newIntent(160);
  const onlyPrepared = await callbacks.reviewPrepare(intent.handoff);
  await expect(
    callbacks.reviewSubmit(intent, async () => {
      throw new Error("fixture refuses submission");
    }),
  ).rejects.toThrow("fixture refuses submission");
  const location = await execute(resolveStoreLocation(root));
  const actualRun = mintUlid();
  RunLog.openRunLog(location, actualRun).write({
    type: "run.started",
    runId: actualRun,
  });
  const ids = RunLog.listRunLogs(location);
  expect(ids).toContain(actualRun);
  expect(ids).not.toContain(onlyPrepared.requestId);
  expect(ids).not.toContain(intent.requestId);
  const files = readdirSync(RunLog.runLogDirectory(location)).map((name) =>
    join(RunLog.runLogDirectory(location), name),
  );
  expect(files).toContain(RunLog.runLogPath(location, actualRun));
  expect(
    files.some(
      (file) =>
        file.endsWith(`${onlyPrepared.requestId}.jsonl`) ||
        file.endsWith(`${intent.requestId}.jsonl`),
    ),
  ).toBeFalse();
}, 30000);

// A lane's review can lose its scope if admission uses the project's checkout.
test("a workspace review takes the lane checkout's open cycle", async () => {
  const cwd = join(root, "feature-checkout");
  git("worktree", "add", "-q", "-b", "feature", cwd, head);
  try {
    git("-C", cwd, "commit", "--allow-empty", "-qm", "Lane change");
    const laneHead = git("-C", cwd, "rev-parse", "HEAD");
    const { cycleId } = await execute(
      withStore(
        root,
        "create",
        Cycles.openOrJoinCycle(
          {
            baseRef: head,
            baseOid: head,
            branch: "feature",
            branchTipOid: laneHead,
          },
          Identity.UNRESOLVED_ACTOR,
        ),
      ),
    );
    const intent = prepared();
    const review = requireReview(
      await callbacks.reviewSubmit(
        {
          ...intent,
          target: { kind: "lane" },
          handoff: {
            ...intent.handoff,
            cwd,
            lane: "feature",
            branch: "feature",
            base: head,
            head: laneHead,
            channel: "native-lane-fixture",
            origin: {
              kind: "channel",
              host: "fixture",
              channel: "native-lane-fixture",
              chat: 0,
              lane: "feature",
              items: [],
            },
          },
        },
        async () => {},
      ),
    );
    expect(review.reference).toBe(cycleId);
  } finally {
    git("worktree", "remove", cwd);
  }
});

// Why: the card is what Ace shows a person. A run of the new shape publishes a chain of cumulative
// packets, so the card's own packet is the run's newest, not its first: it is exact while it
// stands, counts lanes and open judgment from it and carries what is still being judged. Only
// another run's packet standing gives the "newer standing packet" message.
test("a run's newest cumulative packet is its card's own: exact, its lanes counted and its pending counts carried", async () => {
  const intent = newIntent(170);
  requireReview(
    await callbacks.reviewSubmit({ ...intent, notify: false }, async () => {}),
  );
  const request = Option.getOrThrow(
    await execute(withStore(root, "read", Log.get(intent.requestId))),
  ).event;
  if (request.kind !== "review.requested@1") throw new Error("Missing request");
  const fixture = newShapeReview();
  const { events } = fixture;
  const runKey = sha256Hex(`run:${fixture.runId}`);
  // The new-shape run's own request, from the connected chat, under the fixture's run and cycle.
  const run = RecordEvent.parse({
    ...request,
    id: fixture.runId,
    idempotencyKey: `request:${fixture.runId}`,
    attribution: { ...request.attribution, cycleId: fixture.cycleId },
    payload: { ...request.payload, runKey },
  });
  if (run.kind !== "review.requested@1") throw new Error("Expected a request");
  // Records queues the run's job as it records the request; the receipt names that job.
  await write(Log.append([events.registration, events.cycle, run]));
  const [queued] = await execute(
    withStore(
      root,
      "read",
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{
          seq: number;
        }>`SELECT job_seq AS seq FROM jobs WHERE event_id = ${run.id} AND kind = 'review.run@2'`;
      }),
    ),
  );
  if (queued === undefined) throw new Error("Expected the run's job");
  const jobSeq = queued.seq;
  const payload = receipt(runKey, 0);
  payload.jobSeq = jobSeq;
  payload.generation = run.payload.generation;
  payload.gaps = [];
  await execute(
    withStore(root, "write", (location) =>
      Effect.gen(function* () {
        yield* storeContent(fixture);
        yield* Log.append([
          events.humanRegistration,
          ...events.batchEvents,
          events.units.large,
          events.units.small,
          events.assessments.large,
          events.assessments.small,
          events.impact,
          events.lineage,
          events.facts,
          events.gaps.firstOnly,
          events.gaps.batch,
          events.first,
          RecordEvent.parse({
            id: mintUlid(),
            kind: "run.completed@1",
            idempotencyKey: `completed:${fixture.runId}`,
            actor: request.actor,
            occurredAt: new Date().toISOString(),
            attribution: { ...run.attribution, runId: fixture.runId },
            payload,
          }),
        ]);
      }).pipe(Effect.provide(contentLayer(location))),
    ),
  );
  const query = {
    request: fixture.runId,
    reference: fixture.cycleId,
    job: jobSeq,
    run: fixture.runId,
  };
  const snapshot = () =>
    readReviewFeedSnapshot(root, "native-fixture", { review: fixture.runId });

  // The first publication: one batch settled, one still being judged.
  expect(await nativeReviewStatus(root, query, link)).toMatchObject({
    state: "completed",
    recorded: {
      packet: events.first.id,
      complete: false,
      units: 1,
      pending: { batches: 1, sections: 1 },
      message: expect.stringContaining("Recorded packet summary only"),
    },
  });
  expect((await snapshot()).progress).toEqual({
    phase: "finished",
    finished: {
      units: 1,
      byReviewLane: {
        humanRequired: 0,
        humanSuggested: 1,
        agentic: 0,
        static: 0,
      },
      needJudgment: 0,
      complete: false,
      gaps: 2,
      undecoded: 0,
      pending: { batches: 1, sections: 1 },
    },
  });

  // The second, cumulative, supersedes it: the card follows the run's newest, never its first.
  await write(Log.append([events.gaps.second, events.second]));
  expect(await nativeReviewStatus(root, query, link)).toMatchObject({
    recorded: {
      packet: events.second.id,
      complete: true,
      units: 2,
      pending: { batches: 0, sections: 0 },
      message: expect.stringContaining("Recorded packet summary only"),
    },
  });
  const finished = (await snapshot()).progress;
  expect(finished).toEqual({
    phase: "finished",
    finished: {
      units: 2,
      byReviewLane: {
        humanRequired: 1,
        humanSuggested: 1,
        agentic: 0,
        static: 0,
      },
      needJudgment: 1,
      complete: true,
      gaps: 2,
      // The gap the manifest names that Records does not hold.
      undecoded: 1,
      pending: { batches: 0, sections: 0 },
    },
  });

  // Another run's packet now stands: said, never attributed to this run.
  const other = mintUlid();
  await write(
    Log.append([
      RecordEvent.parse({
        ...events.second,
        id: mintUlid(),
        idempotencyKey: `other-packet:${other}`,
        attribution: { ...events.second.attribution, runId: other },
        causation: { supersedes: events.second.id },
      }),
    ]),
  );
  const status = await nativeReviewStatus(root, query, link);
  expect(status).toMatchObject({
    recorded: {
      packet: null,
      units: null,
      message: expect.stringContaining("newer standing packet"),
    },
  });
  if (status.kind !== "review") throw new Error("Expected a review");
  expect(status.recorded.pending).toBeUndefined();
  // The run's own finished counts stay its own newest packet's.
  expect((await snapshot()).progress).toEqual(finished);
}, 30000);
