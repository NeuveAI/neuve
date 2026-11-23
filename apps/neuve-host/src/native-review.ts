import { observeJudgementBranch } from "./judgement-hooks";
import { ReviewAdmissionSchema, ReviewStatusSchema, ReviewOutcomeSchema, ReviewRefusalSchema, ReviewRefusalError, reviewRefusal } from "@ace/channel/review-protocol";
import { ReviewFeedReplySchema, ReviewSubmissionSchema, reviewFeedFailure } from "./review-protocol";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Cursor, type ConversationId } from "@earendil-works/pi-durable";
import type { Channel, Log } from "@ace/channel";
import { z } from "zod";
import type { ReviewFeedSource } from "./review-protocol";
import { ReviewCardsDoc, type ReviewCard } from "@ace/channel/review-cards";
export { ReviewCardsDoc } from "@ace/channel/review-cards";
import { ReviewFeedSnapshotSchema } from "./review-protocol";
import { projectReviewCard } from "./review";
import { git } from "./review-projects";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Review } from "@ace/channel/review";
import { ReviewFeedDefinition } from "@ace/channel/protocol";
import { randomUUID } from "node:crypto";
import {
	NativeReviewResultSchema,
	PreparedReviewSchema,
	ReviewSnapshotSchema,
} from "./review-protocol";
import { token } from "./auth";
import { config } from "./config";
import { GatewayClient } from "./private-gateway-client";

const GitHeadSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

/** The private capability stays in this server closure, outside pi configuration and capture. */
export function nativeReview(channel: string): {
	review: Review;
	source: ReviewFeedSource;
	close(): void;
} {
	let client: GatewayClient | undefined;
	let endpoint: number | undefined;
	const connection = async () => {
		const port = Number(readFileSync(join(config.home, "host.port"), "utf8"));
		if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
			throw new Error("Neuve review host is unavailable");
		if (!client || port !== endpoint || client.status === "closed") {
			client?.close();
			client = new GatewayClient(`ws://127.0.0.1:${port}/ws`, token());
			endpoint = port;
		}
		const connected = client;
		if (connected.status !== "open")
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					stop();
					reject(new Error("Neuve review host is unavailable"));
				}, 5000);
				const stop = connected.subscribe(() => {
					if (connected.status === "open") {
						clearTimeout(timer);
						stop();
						resolve();
					} else if (connected.status === "closed") {
						clearTimeout(timer);
						stop();
						reject(new Error("Neuve review host disconnected"));
					}
				});
			});
		return connected;
	};
	const close = () => { client?.close(); client = undefined; };
	return {
		review: {
			async prepare(target, snapshot) {
				try {
					return PreparedReviewSchema.parse(await (await connection()).request({ op: "review-prepare", channel, target, snapshot: ReviewSnapshotSchema.parse(snapshot) }));
				} catch (error) {
					const refusal = reviewRefusal(error, target);
					throw new ReviewRefusalError(refusal.reason, refusal.detail);
				}
			},
			async submit(prepared) {
				try {
					const value = NativeReviewResultSchema.parse(await (await connection()).request({ op: "review-submit", channel, prepared: ReviewSubmissionSchema.parse(prepared) }));
					if (value.kind === "failure") return reviewRefusal(new Error(value.message));
					if (!value.admission) throw new Error("Records admission is missing its recovered identity and range count");
					return ReviewAdmissionSchema.parse({ outcome: "admitted", review: value.request,
						recovered: value.admission.recovered, notify: value.admission.notify,
						range: { branch: value.admission.branch, base: value.base, head: value.head, commits: value.admission.commits } });
				} catch (error) { return reviewRefusal(error, prepared.target); }
			},
			async status(query) {
				try {
					const value = await (await connection()).request({ op: "review-status", channel, query });
					const refusal = ReviewRefusalSchema.safeParse(value);
					return refusal.success ? refusal.data : ReviewStatusSchema.parse(value);
				} catch (error) { return reviewRefusal(error); }
			},
			async outcome(query) {
				try {
					const value = await (await connection()).request({ op: "review-outcome", channel, query });
					const refusal = ReviewRefusalSchema.safeParse(value);
					return refusal.success ? refusal.data : ReviewOutcomeSchema.parse(value);
				} catch (error) { return reviewRefusal(error); }
			},
		},
		source: {
			async watch(review, receive, context, failed) {
				let stopped = false;
				let after: string | undefined;
				const abort = () => { stopped = true; };
				context.abortSignal?.addEventListener("abort", abort, { once: true });
				const read = async () => {
					const raw = await (await connection()).request({ op: "review-feed", channel, query: { review, ...(after ? { after } : {}) } });
					if (stopped || raw === null) return;
					const refusal = ReviewRefusalSchema.safeParse(raw);
					if (refusal.success) throw new ReviewRefusalError(refusal.data.reason, refusal.data.detail);
					const reply = ReviewFeedReplySchema.parse(raw);
					await receive(reply.snapshot);
					after = reply.stamp;
				};
				try {
					if (context.abortSignal?.aborted) throw context.abortSignal.reason;
					await read();
				} catch (error) {
					context.abortSignal?.removeEventListener("abort", abort);
					throw error;
				}
				const task = (async () => {
					while (!stopped) {
						try { await read(); }
						catch (error) {
							if (stopped) break;
							failed?.(error);
							break;
						}
					}
				})();
				return async () => {
					abort();
					context.abortSignal?.removeEventListener("abort", abort);
					await task;
				};
			},
		},
		close,
	};
}

const ReviewFeedDoc = defineDoc(ReviewFeedDefinition);

/** Retry deadlines are bounded even for a long-lived outage. */
export function reviewFeedRetryDelay(failures: number): number {
	return Math.min(30_000, 250 * 2 ** Math.min(Math.max(0, failures - 1), 7));
}

type FeedWatch = {
	chat: ConversationId; call: string; review: string;
	state: "opening" | "following" | "retrying" | "settled" | "ended";
	mode: "records" | "wake";
	passive: boolean;
	waking?: boolean;
	failures: number; nextAt: number; generation: number;
	logged?: string;
	refusal?: "not_found" | "records_mismatch";
	cancel?: () => void;
	stop?: () => void | Promise<void>;
	branch?: () => Promise<void>;
};

/** Records watches end at terminal delivery. Branch checks only run while this worker is open. */
export async function startReviewFeed(
	harness: Harness,
	source: ReviewFeedSource,
	submitInput: Channel["submitInput"],
	options: { log: Log; branchIntervalMs?: number; enabled?(): boolean; now?(): number },
): Promise<{ close(): Promise<void>; pending(): boolean }> {
	const watches = new Map<string, FeedWatch>();
	const lifetime = withCancel(BACKGROUND_CONTEXT);
	const work = new Set<Promise<unknown>>();
	const now = options.now ?? Date.now;
	let closed = false;
	let closing: Promise<void> | undefined;
	let scanning = Promise.resolve();
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	const enabled = () => !closed && options.enabled?.() !== false;
	const key = (watch: FeedWatch) => `${watch.chat}:${watch.call}`;
	const track = (task: Promise<unknown>) => {
		work.add(task);
		void task.catch(() => {}).finally(() => work.delete(task));
	};
	const state = (watch: FeedWatch, value: FeedWatch["state"], reason?: string) => {
		watch.state = value;
		const label = `${value}:${reason ?? ""}`;
		if (watch.logged === label) return;
		watch.logged = label;
		options.log(value === "retrying" || value === "ended" ? "warn" : "info", "review.feed.state", {
			chat: watch.chat, review: watch.review, state: value, ...(reason ? { reason } : {}),
		});
	};
	const detach = (watch: FeedWatch) => {
		watch.cancel?.();
		const stop = watch.stop;
		watch.stop = undefined;
		if (stop) track(Promise.resolve().then(stop));
	};
	const notify = async (chat: ConversationId, review: string) => {
		if (!enabled()) return;
		const notice = await harness.commit(async tx => {
			const saved = (await tx.doc(ReviewFeedDoc, chat)).notices[review];
			if (!saved || saved.delivered || saved.chat !== chat) return;
			// Persist before submitting, so restart reuses our key without trusting older client keys.
			if (!saved.requestId) {
				let requestId: string;
				do { requestId = `neuve.review:${review}:terminal:${randomUUID()}`; }
				while (await tx.submissionByRequest(chat, requestId));
				saved.requestId = requestId;
			}
			return { ...saved };
		}, BACKGROUND_CONTEXT);
		if (!notice) return;
		const conversation = await harness.conversation(chat, BACKGROUND_CONTEXT);
		if (!conversation) return;
		const submission = await submitInput(conversation, {
			type: "input", whenBusy: "followUp", requestId: notice.requestId,
			content: `[Neuve system note] Review ${review} is ${notice.phase}. Point the person at the review card without summarizing findings. Completing a review does not approve the change.`,
		}, BACKGROUND_CONTEXT);
		const acknowledged = await harness.commit(async tx => {
			const doc = await tx.doc(ReviewFeedDoc, chat);
			const saved = doc.notices[review];
			if (!saved || saved.delivered) return false;
			saved.submission = submission.id;
			saved.delivered = true;
			return true;
		}, BACKGROUND_CONTEXT);
		if (acknowledged) options.log("info", "review.notify.delivered", { chat, review, phase: notice.phase });
	};
	const scheduleRetry = () => {
		clearTimeout(retryTimer);
		const deadline = Math.min(...[...watches.values()].filter(watch => watch.state === "retrying").map(watch => watch.nextAt));
		if (enabled() && Number.isFinite(deadline)) {
			retryTimer = setTimeout(rescan, Math.max(1, deadline - now()));
			retryTimer.unref();
		}
	};
	const fail = (watch: FeedWatch, error: unknown) => {
		if (!enabled() || watches.get(key(watch)) !== watch) return;
		detach(watch);
		const failure = reviewFeedFailure(error);
		if (watch.mode === "records" && failure.permanent) {
			watch.refusal = failure.reason === "not_found" ? "not_found" : "records_mismatch";
			state(watch, "ended", failure.reason);
			track(harness.commit(async tx => {
				const doc = await tx.doc(ReviewFeedDoc, watch.chat);
				doc.ended = { ...doc.ended, [watch.review]: failure.reason === "not_found" ? "not_found" : "records_mismatch" };
			}, BACKGROUND_CONTEXT));
		} else {
			watch.nextAt = now() + reviewFeedRetryDelay(++watch.failures);
			state(watch, "retrying", failure.reason);
		}
		scheduleRetry();
	};
	const wake = async (watch: FeedWatch) => {
		watch.state = "opening";
		watch.waking = true;
		try {
			await notify(watch.chat, watch.review);
			if (!enabled() || watches.get(key(watch)) !== watch) return;
			state(watch, watch.refusal ? "ended" : "settled", watch.refusal);
			detach(watch);
			if (!watch.refusal && !watch.branch && watch.generation === 0) {
				watch.passive = true;
				watch.mode = "records";
				track(follow(watch));
			}
		} catch (error) { fail(watch, error); }
		finally { watch.waking = false; }
	};
	const follow = async (watch: FeedWatch) => {
		const attempt = ++watch.generation;
		const invocation = withCancel(lifetime.context);
		watch.cancel = invocation.cancel;
		watch.state = "opening";
		const current = () => enabled() && watches.get(key(watch)) === watch && watch.generation === attempt && !invocation.context.abortSignal?.aborted;
		try {
			const stop = await source.watch(watch.review, async raw => {
				if (!current()) return;
				const snapshot = ReviewFeedSnapshotSchema.parse(raw);
				if (snapshot.review !== watch.review) throw new ReviewRefusalError("records_mismatch", "Records feed returned a different review request");
				const updated = await harness.commit(async tx => {
					const doc = await tx.doc(ReviewCardsDoc, watch.chat);
					const card = doc.cards[watch.call];
					if (card?.kind !== "review" || card.review !== watch.review) return false;
					const feed = await tx.doc(ReviewFeedDoc, watch.chat);
					if (snapshot.sequence < (feed.positions[watch.call] ?? -1)) return false;
					const next = await projectReviewCard(card, snapshot, card.updatedAt);
					const changed = JSON.stringify(card) !== JSON.stringify(next);
					if (changed) {
						doc.cards[watch.call] = { ...next, updatedAt: Date.now() };
						feed.positions[watch.call] = snapshot.sequence;
					}
					const phase = next.phase;
					if (card.notify && snapshot.chat === watch.chat && (phase === "finished" || phase === "stopped") && !feed.notices[watch.review])
						feed.notices[watch.review] = { phase, delivered: false, chat: watch.chat };
					return changed;
				}, BACKGROUND_CONTEXT);
				if (!current()) return;
				watch.failures = 0;
				if (!watch.branch) {
					let checking = Promise.resolve();
					watch.branch = () => checking = checking.catch(() => {}).then(() => enabled() ? updateReviewBranch(harness, watch.chat, watch.call, snapshot.project, snapshot.chat === watch.chat, options.log, now) : undefined);
				}
				track(watch.branch().catch(() => { watch.branch = undefined; }));
				if (updated) options.log("info", "review.card.updated", { chat: watch.chat, review: watch.review, phase: snapshot.progress.phase, sequence: snapshot.sequence });
				if (snapshot.progress.phase === "finished" || snapshot.progress.phase === "stopped") {
					watch.mode = "wake";
					await wake(watch);
				} else state(watch, "following");
			}, invocation.context, error => { if (current()) fail(watch, error); });
			if (current()) watch.stop = stop;
			else await stop();
		} catch (error) { if (current()) fail(watch, error); }
	};
	const scan = async () => {
		if (!enabled()) {
			const previous = [...watches.values()];
			watches.clear();
			for (const watch of previous) detach(watch);
			clearTimeout(retryTimer);
			return;
		}
		let cursor: Cursor | undefined;
		do {
			const page = await harness.commit(tx => tx.scanConversations({}, 256, cursor), BACKGROUND_CONTEXT);
			for (const conversation of page.items) {
				const doc = await harness.snapshot(ReviewCardsDoc, conversation.id, BACKGROUND_CONTEXT);
				const feed = await harness.snapshot(ReviewFeedDoc, conversation.id, BACKGROUND_CONTEXT);
				for (const [call, card] of Object.entries(doc?.cards || {})) {
					if (card.kind !== "review") continue;
					const id = `${conversation.id}:${call}`;
					let watch = watches.get(id);
					if (!watch) {
						const terminal = card.phase === "finished" || card.phase === "stopped";
						const notice = feed?.notices[card.review];
						const pendingWake = !!notice && !notice.delivered && notice.chat === conversation.id;
						watch = { chat: conversation.id, call, review: card.review, state: "opening", mode: "records", refusal: feed?.ended?.[card.review], passive: terminal && !pendingWake, failures: 0, nextAt: 0, generation: 0 };
						watches.set(id, watch);
						if (pendingWake) {
							watch.mode = "wake";
							track(wake(watch));
						}
						if (feed?.ended?.[card.review]) state(watch, "ended", feed.ended[card.review]);
						else if (!pendingWake) track(follow(watch));
					} else if (watch.state === "retrying" && now() >= watch.nextAt) {
						track(watch.mode === "wake" ? wake(watch) : follow(watch));
					}
				}
			}
			cursor = page.next;
		} while (cursor && enabled());
		scheduleRetry();
	};
	function rescan() {
		if (closed) return;
		scanning = scanning.catch(() => {}).then(scan);
		track(scanning);
	}
	const unsubscribe = harness.subscribeCommits(({ changes }) => {
		if (changes.some(change => change.type === "conversation" || (change.type === "document" && change.record.kind === ReviewCardsDoc.definition.kind))) rescan();
	});
	const timer = setInterval(() => {
		if (closed) return;
		for (const watch of watches.values()) if (watch.branch) track(watch.branch().catch(() => { watch.branch = undefined; }));
		rescan();
	}, options.branchIntervalMs ?? 2000);
	timer.unref();
	rescan();
	await scanning;
	return {
		pending: () => [...watches.values()].some(watch => watch.waking || (!watch.passive && (watch.state === "opening" || watch.state === "following" || watch.state === "retrying"))),
		close() {
			return closing ??= (async () => {
				closed = true;
				clearInterval(timer);
				clearTimeout(retryTimer);
				unsubscribe();
				lifetime.cancel();
				for (const watch of watches.values()) detach(watch);
				while (work.size) await Promise.allSettled([...work]);
			})();
		},
	};
}

type PrepareRange = (project: string, range: { baseOid: string; headOid: string }) => Promise<void>;
let prepareRange: PrepareRange | undefined;

/** Root supplies Records preparation; the host keeps its public types independent of the harness. */
export function configureReviewPreparation(prepare: PrepareRange | undefined): void { prepareRange = prepare; }

type PreparationState =
  | { head: string; kind: "ready" }
  | { head: string; kind: "running"; failures: number }
  | { head: string; kind: "retry"; failures: number; nextAt: number };
const preparedHeads = new WeakMap<Harness, Map<string, PreparationState>>();

/** Persistent refusal retries at 2, 4, 8, 16, 32, then 60 seconds per unchanged head. */
export function reviewPreparationRetryDelay(failures: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(5, Math.max(0, failures - 1)));
}

/** Read the pinned branch ref, so changing the checkout's HEAD cannot create a false row. */
export async function updateReviewBranch(harness: Harness, chat: ConversationId, call: string, project: string, emit = true, log: Log = () => {}, now: () => number = Date.now): Promise<void> {
	const card = (await harness.snapshot(ReviewCardsDoc, chat, BACKGROUND_CONTEXT))?.cards[call];
	if (card?.kind !== "review" || !card.range.branch) return;
	const ref = `refs/heads/${card.range.branch}`;
	const value = await git(project, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
	const head = value.stdout.trim();
	if (value.status !== 0 || head === card.range.head) return;
	const parsed = GitHeadSchema.parse(head);
	await observeJudgementBranch({ project, branch: card.range.branch, base: card.range.base, head: parsed, previousHead: card.range.head, reviewed: true, openPullRequest: false, trigger: "head" });
	const key = `${project}\0${ref}\0${card.range.base}`;
	let prepared = preparedHeads.get(harness);
	if (!prepared) { prepared = new Map(); preparedHeads.set(harness, prepared); }
	const held = prepared.get(key);
	const previous = held?.head === parsed ? held : undefined;
	if (prepareRange && (!previous || (previous.kind === "retry" && now() >= previous.nextAt))) {
		const running: PreparationState = { head: parsed, kind: "running", failures: previous?.kind === "retry" ? previous.failures : 0 };
		prepared.set(key, running);
		try {
			await prepareRange(project, { baseOid: card.range.base, headOid: parsed });
			if (prepared.get(key) === running) prepared.set(key, { head: parsed, kind: "ready" });
		} catch (error) {
			const failures = Math.min(6, running.failures + 1);
			if (prepared.get(key) === running) prepared.set(key, { head: parsed, kind: "retry", failures, nextAt: now() + reviewPreparationRetryDelay(failures) });
			log("warn", "review.prepare.failed", { project, head: parsed, error: error instanceof Error ? error.name : "unknown" });
		}
	}
	if (head === card.newCommits?.head) return;
	if ((await git(project, ["merge-base", "--is-ancestor", card.range.head, head])).status !== 0) return;

	await harness.commit(async tx => {
		const doc = await tx.doc(ReviewCardsDoc, chat);
		const current = doc.cards[call];
		if (current?.kind !== "review" || current.review !== card.review) return;
		const feed = await tx.doc(ReviewFeedDoc, chat);
		current.newCommits = { head: parsed };
		current.updatedAt = Date.now();
		if (!emit || feed.rows[current.review]) return;
		await tx.appendEntry(chat, {
			kind: "neuve:review:new-commits",
			data: { review: current.review, branch: current.range.branch, reviewedHead: current.range.head,
				head: parsed, label: current.label, at: Date.now() },
		});
		feed.rows[current.review] = true;
	}, BACKGROUND_CONTEXT);
}
