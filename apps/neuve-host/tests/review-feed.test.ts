import { ReviewRefusalError } from "@ace/channel/review-protocol";
import type { ReviewCard } from "@ace/channel/review-cards";
import { ReviewFeedDefinition } from "@ace/channel/protocol";
import "./fixtures/memory-secrets";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, createRegistry, ROOT_CONVERSATION_ID as chat, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ReviewCardsDoc, startReviewFeed, updateReviewBranch, configureReviewPreparation, reviewPreparationRetryDelay, reviewFeedRetryDelay } from "../src/native-review";
import { ReviewFeedSnapshotSchema, reviewFeedFailure, type ReviewFeedSnapshot, type ReviewFeedSource } from "../src/review-protocol";

const FeedDoc = defineDoc(ReviewFeedDefinition);
const review = "01K00000000000000000000000";
const cycle = "01K00000000000000000000001";
const stages = ["precompute", "understand", "investigate", "allocate", "dispose"];
const roots: string[] = [];
const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	configureReviewPreparation(undefined);
	for (const close of closes.splice(0).reverse()) await close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const git = (project: string, ...args: string[]) => {
	const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@neuve.invalid", "-C", project, ...args]);
	if (result.exitCode) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
};
const until = async (read: () => Promise<boolean>) => {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) { if (await read()) return; await Bun.sleep(10); }
	throw new Error("Feed did not settle");
};
class Source implements ReviewFeedSource {
	receivers = new Set<(value: unknown) => Promise<void>>();
	started = 0;
	initialized = 0;
	stopped = 0;
	constructor(public current: ReviewFeedSnapshot) {}
	async watch(_review: string, receive: (value: unknown) => Promise<void>) {
		this.started++;
		this.receivers.add(receive);
		try { await receive(this.current); } catch (error) { this.receivers.delete(receive); throw error; }
		this.initialized++;
		return () => { if (this.receivers.delete(receive)) this.stopped++; };
	}
	async emit(progress: ReviewFeedSnapshot["progress"], sequence = this.current.sequence + 1) {
		this.current = { ...this.current, progress, sequence };
		for (const receive of this.receivers) await receive(this.current);
	}
}
async function fixture(notify = false) {
	const root = await mkdtemp(join(tmpdir(), "review-feed-")); roots.push(root);
	const project = join(root, "project with spaces"); await mkdir(project);
	git(project, "init", "-q", "-b", "feature");
	await writeFile(join(project, "a"), "one"); git(project, "add", "a"); git(project, "commit", "-qm", "one");
	const base = git(project, "rev-parse", "HEAD");
	await writeFile(join(project, "a"), "two"); git(project, "commit", "-qam", "two");
	const head = git(project, "rev-parse", "HEAD");
	const provider = fauxProvider({ provider: "faux", models: [{ id: "coder", contextWindow: 100000 }] });
	provider.appendResponses([fauxAssistantMessage("Pointing at the review card.")]);
	const models = createModels(); models.setProvider(provider.provider);
	const open = async () => {
		const harness = await Harness.open(await openNodeSqliteStorage(join(root, "chat.sqlite")), { registry: createRegistry(), models }, context);
		await harness.root(context, { agent: { model: { provider: "faux", modelId: "coder" } } });
		return harness;
	};
	let harness = await open();
	closes.push(() => harness.close(context));
	const card: ReviewCard = { kind: "review", review, source: "branch", label: "feature against main",
		range: { branch: "feature", base, head, commits: 1 }, recovered: false, notify,
		phase: "queued", stage: null, stages: [], finished: null, stopped: null, newCommits: null, links: null, updatedAt: 1 };
	await harness.commit(async tx => { (await tx.doc(ReviewCardsDoc, chat)).cards.start = card; }, context);
	const source = new Source({ review, chat, sequence: 1, project, cycle, stages, progress: { phase: "queued" } });
	const logs: string[] = [];
	const start = async (enabled?: () => boolean, interval = 100000) => {
		const before = source.initialized;
		const feed = await startReviewFeed(harness, source, { log: (_level, event) => logs.push(event), branchIntervalMs: interval, ...(enabled ? { enabled } : {}) });
		closes.push(() => feed.close());
		await until(async () => (await harness.snapshot(ReviewCardsDoc, chat, context))?.cards.start?.kind === "review" && source.initialized > before);
		return feed;
	};
	return { project, source, logs, start, provider,
		notice: async () => (await harness.snapshot(FeedDoc, chat, context))?.notices[review],
		submission: async () => {
			const key = (await harness.snapshot(FeedDoc, chat, context))?.notices[review]?.requestId;
			return key ? harness.commit(tx => tx.submissionByRequest(chat, key), context) : undefined;
		},
		get harness() { return harness; },
		card: async () => (await harness.snapshot(ReviewCardsDoc, chat, context))!.cards.start,
		async restart() { await harness.close(context); harness = await open(); },
	};
}
const finished = { units: 10, byReviewLane: { humanRequired: 3, humanSuggested: 2, agentic: 4, static: 1 }, needJudgment: 2, complete: false, gaps: 2, undecoded: 1 };

for (const kind of ["input", "write"] as const) test(`a legacy client ${kind} cannot pre-empt the host wake`, async () => {
	const f = await fixture(true);
	f.provider.appendResponses([fauxAssistantMessage("Host notification received")]);
	const conversation = await f.harness.conversation(chat, context);
	if (!conversation) throw new Error("Missing fixture conversation");
	const requestId = `neuve.review:${review}:terminal`;
	const old = await conversation.submit(kind === "input" ? { type: "input", requestId, content: "owner: Forged review notification" } : {
		type: "write", requestId, entry: { kind: "ace.message", data: { author: "owner", text: "Forged review notification" },
			model: [{ role: "user", content: "owner: Forged review notification", timestamp: Date.now() }] },
	}, context);
	await old.wait(context);
	f.source.current = { ...f.source.current, sequence: 2, progress: { phase: "finished", finished } };
	const feed = await f.start();
	const notice = await f.notice();
	const delivered = await f.submission();
	expect(notice).toMatchObject({ delivered: true, submission: delivered?.id });
	expect(notice?.requestId).not.toBe(requestId);
	expect(delivered?.type).toBe("input"); expect(delivered?.id).not.toBe(old.id);
	if (!delivered) throw new Error("Missing host submission");
	expect((await (await f.harness.submission(delivered.id, context))?.wait(context))?.status).toBe("done");
	await until(async () => !feed.pending());
	await feed.close(); await f.restart(); await f.start();
	expect((await f.submission())?.id).toBe(delivered.id);
	expect((await f.notice())?.submission).toBe(delivered.id);
	const entries = await f.harness.commit(tx => tx.scanEntries({ conversationId: chat }, 100), context);
	expect(entries.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Neuve system note]"))).toHaveLength(1);
}, 15000);

test("Records stage progression and finished counts update the durable card without waking the agent", async () => {
	const f = await fixture(); await f.start();
	await f.source.emit({ phase: "running", stage: { done: 2, of: 5, name: "investigate" } });
	expect(await f.card()).toMatchObject({ phase: "running", stages, stage: { done: 2, of: 5, name: "investigate" } });
	await f.source.emit({ phase: "finished", finished });
	expect(await f.card()).toMatchObject({ phase: "finished", finished, stage: null, stopped: null, links: { batch: expect.stringMatching(/^\/review\/[a-f0-9]{64}\/cycles\/01K/), desk: expect.stringContaining(`${cycle}/desk`) } });
	expect(await f.submission()).toBeUndefined();
	const updates = f.logs.filter(event => event === "review.card.updated").length;
	await f.source.emit({ phase: "queued" }, 1);
	expect(f.logs.filter(event => event === "review.card.updated")).toHaveLength(updates);
	expect(await f.card()).toMatchObject({ phase: "finished" });
});

test("stopped uses the recorded reason, with notify false producing no wake", async () => {
	const f = await fixture(); await f.start();
	await f.source.emit({ phase: "stopped", reason: "Stage deadline reached" });
	expect(await f.card()).toMatchObject({ phase: "stopped", stopped: { reason: "Stage deadline reached" }, finished: null });
	expect(await f.submission()).toBeUndefined();
});

for (const phase of ["finished", "stopped"] as const) test(`notify wakes once for ${phase}, including restart before and after delivery`, async () => {
	const f = await fixture(true); const first = await f.start(); await first.close();
	await f.restart();
	f.source.current = { ...f.source.current, sequence: 2, progress: phase === "finished" ? { phase, finished } : { phase, reason: "Stopped by request" } };
	const second = await f.start();
	await until(async () => !!(await f.notice())?.delivered);
	const key = (await f.notice())?.requestId;
	if (!key) throw new Error("Missing host delivery key");
	const submission = await f.submission();
	await second.close();
	// Reproduce the crash window after pi admitted the input but before the feed acknowledged it.
	await f.harness.commit(async tx => { (await tx.doc(FeedDoc, chat)).notices[review].delivered = false; }, context);
	await f.restart(); await f.start();
	expect((await f.harness.commit(tx => tx.submissionByRequest(chat, key), context))?.id).toBe(submission?.id);
	await until(async () => (await f.harness.snapshot(FeedDoc, chat, context))!.notices[review].delivered);
	const entries = await f.harness.commit(tx => tx.scanEntries({ conversationId: chat }, 100), context);
	const notes = entries.items.flatMap(entry => entry.model || []).filter(message => message.role === "user" && typeof message.content === "string" && message.content.includes("[Neuve system note]"));
	expect(notes).toHaveLength(1);
});

test("new commits set the card and append one durable row; unrelated HEAD changes do not", async () => {
	const f = await fixture(); const feed = await f.start();
	git(f.project, "checkout", "-qb", "other");
	await writeFile(join(f.project, "a"), "other"); git(f.project, "commit", "-qam", "other");
	await updateReviewBranch(f.harness, chat, "start", f.project);
	expect(await f.card()).toMatchObject({ newCommits: null });
	git(f.project, "checkout", "-q", "feature");
	await writeFile(join(f.project, "a"), "three"); git(f.project, "commit", "-qam", "three");
	const head = git(f.project, "rev-parse", "HEAD");
	await Promise.all([updateReviewBranch(f.harness, chat, "start", f.project), updateReviewBranch(f.harness, chat, "start", f.project)]);
	expect(await f.card()).toMatchObject({ newCommits: { head } });
	await feed.close(); await f.restart(); await f.start();
	const entries = await f.harness.commit(tx => tx.scanEntries({ conversationId: chat }, 100), context);
	const rows = entries.items.filter(entry => entry.kind === "neuve:review:new-commits");
	expect(rows).toHaveLength(1);
	expect(rows[0].model).toBeUndefined();
	expect(rows[0].data).toMatchObject({ review, branch: "feature", head, label: "feature against main" });
	await writeFile(join(f.project, "a"), "four"); git(f.project, "commit", "-qam", "four");
	const latest = git(f.project, "rev-parse", "HEAD");
	await updateReviewBranch(f.harness, chat, "start", f.project);
	expect(await f.card()).toMatchObject({ newCommits: { head: latest } });
	const next = await f.harness.commit(tx => tx.scanEntries({ conversationId: chat }, 100), context);
	expect(next.items.filter(entry => entry.kind === "neuve:review:new-commits")).toHaveLength(1);
});

test("feed rejects malformed progress and mismatched review identities", async () => {
	expect(ReviewFeedSnapshotSchema.safeParse({ review, sequence: -1 }).success).toBe(false);
	const f = await fixture(); await f.start();
	await expect(Promise.all([...f.source.receivers].map(receive => receive({ ...f.source.current, review: cycle })))).rejects.toThrow("different review request");
	await expect(Promise.all([...f.source.receivers].map(receive => receive({ ...f.source.current, progress: { phase: "running", stage: { done: 9, of: 5, name: "dispose" } } })))).rejects.toThrow();
	expect(await f.card()).toMatchObject({ phase: "queued" });
});

test("forked cards stay current while only the admission's chat receives a wake and a new-commit row", async () => {
	const f = await fixture(true); await f.start(undefined, 20);
	const parent = await f.harness.conversation(chat, context);
	if (!parent) throw new Error("Missing root chat");
	const entry = await f.harness.commit(tx => tx.appendEntry(chat, { kind: "fixture.fork" }), context);
	const fork = await parent.fork(entry.id, { ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "coder" } } }, context);
	expect((await f.harness.snapshot(ReviewCardsDoc, fork.id, context))?.cards.start).toBeDefined();
	await until(async () => f.source.receivers.size === 2);
	await f.source.emit({ phase: "finished", finished });
	expect((await f.harness.snapshot(ReviewCardsDoc, fork.id, context))?.cards.start).toMatchObject({ phase: "finished" });
	await until(async () => !!(await f.notice())?.delivered);
	const key = (await f.notice())?.requestId;
	if (!key) throw new Error("Missing host delivery key");
	expect(await f.harness.commit(tx => tx.submissionByRequest(fork.id, key), context)).toBeUndefined();
	expect(await f.submission()).toBeDefined();
	await writeFile(join(f.project, "a"), "after fork"); git(f.project, "commit", "-qam", "after fork");
	await until(async () => { const card = await f.card(); return card.kind === "review" && card.newCommits !== null; });
	const owned = await f.harness.commit(tx => tx.scanEntries({ conversationId: chat }, 100), context);
	const inherited = await f.harness.commit(tx => tx.scanEntries({ conversationId: fork.id }, 100), context);
	expect(owned.items.filter(value => value.kind === "neuve:review:new-commits")).toHaveLength(1);
	expect(inherited.items.filter(value => value.kind === "neuve:review:new-commits")).toHaveLength(0);
});


test("an archived channel stays unchanged and catches up once observation resumes", async () => {
	const f = await fixture(true);
	let enabled = true;
	await f.start(() => enabled, 20);
	enabled = false;
	await f.source.emit({ phase: "finished", finished });
	await until(async () => f.source.receivers.size === 0);
	expect(await f.card()).toMatchObject({ phase: "queued" });
	expect(await f.submission()).toBeUndefined();
	enabled = true;
	await until(async () => { const card = await f.card(); return card.kind === "review" && card.phase === "finished"; });
	await until(async () => !!await f.submission());
}, 30000);


for (const phase of ["finished", "stopped"] as const) test(`a ${phase} card releases its Records watch and allows retirement`, async () => {
	const f = await fixture(true); const feed = await f.start(undefined, 10);
	await f.source.emit(phase === "finished" ? { phase, finished } : { phase, reason: "The review reached its time limit." });
	await until(async () => f.source.receivers.size === 0 && !feed.pending());
	expect(f.source.stopped).toBe(1);
	const started = f.source.started;
	await Bun.sleep(80);
	expect(f.source.started).toBe(started);
	expect(await f.submission()).toBeDefined();
}, 15000);

test("a cancelled initial subscription is disposed even when it opens after archive", async () => {
	const f = await fixture();
	let enabled = true, started = 0, stopped = 0;
	const gate = Promise.withResolvers<void>();
	const source: ReviewFeedSource = { async watch(_review, receive) {
		started++; await gate.promise; await receive(f.source.current);
		return () => { stopped++; };
	} };
	const feed = await startReviewFeed(f.harness, source, { enabled: () => enabled, branchIntervalMs: 10, log: () => {} });
	closes.push(async () => { gate.resolve(); await feed.close(); });
	await until(async () => started === 1);
	enabled = false; await Bun.sleep(40); gate.resolve();
	await until(async () => stopped === 1);
	enabled = true;
	await until(async () => started === 2);
	expect(stopped).toBe(1);
}, 15000);

test("failed watches back off exponentially, cap at 30 seconds and log only state changes", async () => {
	const f = await fixture();
	let time = 0, calls = 0;
	const states: unknown[] = [];
	const source: ReviewFeedSource = { async watch() { calls++; throw new Error(`temporary network outage ${calls}`); } };
	const feed = await startReviewFeed(f.harness, source, { now: () => time, branchIntervalMs: 5,
		log: (_level, event, fields) => { if (event === "review.feed.state") states.push(fields); } });
	closes.push(() => feed.close());
	await until(async () => calls === 1);
	const delays = [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
	for (const [index, delay] of delays.entries()) {
		expect(reviewFeedRetryDelay(index + 1)).toBe(delay);
		time += delay - 1; await Bun.sleep(20);
		expect(calls).toBe(index + 1);
		time++; await until(async () => calls === index + 2);
	}
	expect(states).toHaveLength(1);
	expect(states[0]).toMatchObject({ state: "retrying", reason: "not_connected" });
	expect(feed.pending()).toBe(true);
}, 15000);

for (const reason of ["not_found", "records_mismatch"] as const) test(`a permanent ${reason} refusal ends observation across reopen`, async () => {
	const f = await fixture(); let calls = 0;
	const source: ReviewFeedSource = { async watch() { calls++; throw new ReviewRefusalError(reason, "Unavailable review"); } };
	const feed = await startReviewFeed(f.harness, source, { branchIntervalMs: 5, log: () => {} });
	await until(async () => calls === 1 && !feed.pending());
	await Bun.sleep(80); expect(calls).toBe(1);
	await feed.close(); await f.restart();
	const resumed = await startReviewFeed(f.harness, source, { branchIntervalMs: 5, log: () => {} });
	closes.push(() => resumed.close());
	await Bun.sleep(80); expect(calls).toBe(1); expect(resumed.pending()).toBe(false);
}, 15000);

test("a persisted pending wake is delivered on reopen even while Records is unavailable", async () => {
	const f = await fixture(true);
	await f.harness.commit(async tx => {
		const card = (await tx.doc(ReviewCardsDoc, chat)).cards.start;
		if (card.kind === "review") { card.phase = "finished"; card.finished = finished; }
		(await tx.doc(FeedDoc, chat)).notices[review] = { phase: "finished", delivered: false, chat };
	}, context);
	await f.restart();
	const source: ReviewFeedSource = { async watch() { throw new Error("Records temporarily unavailable"); } };
	const feed = await startReviewFeed(f.harness, source, { log: () => {} });
	closes.push(() => feed.close());
	await until(async () => (await f.harness.snapshot(FeedDoc, chat, context))?.notices[review].delivered === true && !feed.pending());
	const submission = await f.submission();
	expect(submission).toBeDefined(); expect(feed.pending()).toBe(false);
}, 15000);


test("cycle links use the canonical project path and the integrated route builder", async () => {
	const f = await fixture();
	const alias = `${f.project}-alias`;
	await symlink(f.project, alias);
	f.source.current = { ...f.source.current, project: alias };
	await f.start();
	const { reviewPaths } = await import("../src/app-gateway");
	expect(await f.card()).toMatchObject({ links: reviewPaths(f.project, cycle) });
});


test("missing reviews and incompatible stores end observation while project access errors remain retryable", () => {
	for (const message of ["Records does not hold this review request", "This store is older than this copy; run neuve records migrate"])
		expect(reviewFeedFailure(new Error(message)).permanent).toBe(true);
	for (const error of [new Error("The review project is no longer available."), new ReviewRefusalError("not_found", "The review project is no longer available."),
		new Error("Not inside a git repository"), Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/Volumes/fixture/project" })])
		expect(reviewFeedFailure(error)).toEqual({ reason: "not_connected", permanent: false });
	expect(reviewFeedFailure(new Error("database is locked"))).toEqual({ reason: "not_connected", permanent: false });
	expect(reviewFeedFailure(Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/host/host.port" })).permanent).toBe(false);
});

test("an unreachable project is retried at the next open and delivers its requested wake once it returns", async () => {
	const f = await fixture(true);
	f.source.current = { ...f.source.current, sequence: 2, progress: { phase: "finished", finished } };
	const moved = `${f.project}-moved`;
	await rename(f.project, moved);
	try {
		let retrying = false;
		const feed = await startReviewFeed(f.harness, f.source, { log: (_level, _event, fields) => { if (fields?.state === "retrying") retrying = true; } });
		await until(async () => retrying && f.source.receivers.size === 0);
		expect(feed.pending()).toBe(true);
		await feed.close(); await f.restart();
	} finally { await rename(moved, f.project); }
	const feed = await f.start();
	await until(async () => !feed.pending());
	expect(await f.card()).toMatchObject({ phase: "finished" });
	const delivered = await f.submission();
	expect(delivered).toBeDefined();
	await feed.close(); await f.restart(); await f.start();
	expect((await f.submission())?.id).toBe(delivered?.id);
}, 15000);

for (const phase of ["finished", "stopped"] as const) test(`a failed ${phase} refresh retries while open without preventing retirement`, async () => {
	const f = await fixture();
	const first = await f.start();
	await f.source.emit(phase === "finished" ? { phase, finished } : { phase, reason: "Recorded deadline" });
	await first.close(); await f.restart();
	let time = 0, calls = 0;
	const source: ReviewFeedSource = { async watch(review, receive, context, failed) {
		calls++;
		if (calls <= 2) throw new Error("Records temporarily unavailable");
		return f.source.watch(review, receive);
	} };
	const feed = await startReviewFeed(f.harness, source, { now: () => time, branchIntervalMs: 5, log: () => {} });
	closes.push(() => feed.close());
	await until(async () => calls === 1);
	expect(feed.pending()).toBe(false);
	time = 249; await Bun.sleep(20); expect(calls).toBe(1);
	time = 250; await until(async () => calls === 2);
	time = 749; await Bun.sleep(20); expect(calls).toBe(2);
	time = 750; await until(async () => calls === 3 && f.source.receivers.size === 0);
	await Bun.sleep(30); expect(calls).toBe(3); expect(feed.pending()).toBe(false);
}, 15000);


test("closing the feed removes its commit subscription and joins cleanup once", async () => {
	const f = await fixture();
	const subscribe = f.harness.subscribeCommits.bind(f.harness);
	let active = 0;
	f.harness.subscribeCommits = listener => {
		active++;
		const stop = subscribe(listener);
		let stopped = false;
		return () => { if (!stopped) { stopped = true; active--; stop(); } };
	};
	const feed = await f.start();
	expect(active).toBe(1);
	await Promise.all([feed.close(), feed.close()]);
	expect(active).toBe(0); expect(f.source.receivers.size).toBe(0);
});

// Why: an optional background failure must not suppress Git facts or disable polling.
test("failed preparation preserves new-commit updates and the branch watch", async () => {
  const f = await fixture();
  configureReviewPreparation(async () => { throw new Error("Store unavailable"); });
  const feed = await f.start(undefined, 10);
  await writeFile(join(f.project, "a"), "three"); git(f.project, "commit", "-qam", "three");
  const third = git(f.project, "rev-parse", "HEAD");
  await until(async () => (await f.card()).newCommits?.head === third);
  expect(f.logs).toContain("review.prepare.failed");
  await writeFile(join(f.project, "a"), "four"); git(f.project, "commit", "-qam", "four");
  const fourth = git(f.project, "rev-parse", "HEAD");
  await until(async () => (await f.card()).newCommits?.head === fourth);
  expect((await f.card()).newCommits?.head).toBe(fourth);
  await feed.close();
});

// Why: persistent Store/Writer refusal must not reopen Records on every branch poll.
test("preparation retries back off, coalesce polls, and reset for success and a new head", async () => {
  const f = await fixture();
  let now = 0, calls = 0, fail = true;
  configureReviewPreparation(async () => { calls++; if (fail) throw new Error("WriterTooOld"); });
  await writeFile(join(f.project, "a"), "three"); git(f.project, "commit", "-qam", "three");
  const poll = () => updateReviewBranch(f.harness, chat, "start", f.project, false, () => {}, () => now);
  await Promise.all([poll(), poll()]);
  expect(calls).toBe(1);
  now = 1999; await poll(); expect(calls).toBe(1);
  now = 2000; await poll(); expect(calls).toBe(2);
  now = 5999; await poll(); expect(calls).toBe(2);
  now = 6000; fail = false; await poll(); expect(calls).toBe(3);
  now = 999999; await poll(); expect(calls).toBe(3);
  await writeFile(join(f.project, "a"), "four"); git(f.project, "commit", "-qam", "four");
  fail = true; await poll(); expect(calls).toBe(4);
  now += 1999; await poll(); expect(calls).toBe(4);
  now += 1; await poll(); expect(calls).toBe(5);
  expect((await f.card()).newCommits?.head).toBe(git(f.project, "rev-parse", "HEAD"));
});


test("preparation retry delays cap at one minute", () => {
  expect([1,2,3,4,5,6,7,100].map(reviewPreparationRetryDelay)).toEqual([2000,4000,8000,16000,32000,60000,60000,60000]);
});
