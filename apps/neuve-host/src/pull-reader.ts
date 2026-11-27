import type { GithubPull, Log } from "@ace/channel";
import { SharedWork } from "@neuve/records-core/shared-work";

import { pullGithub, pullSnapshot, repository, type PullSnapshot } from "./github";
import { failure } from "./log";

type Github = ReturnType<typeof pullGithub>;
type PlanPull = {
	id: string;
	title: string;
	open: boolean;
	text(): Promise<string>;
	ready(head: string): boolean;
	readiness?: { head(node: string): string | undefined; record(node: string, head: string): void };
	changed?(): void;
	merged(number: number, head: string, at: number): Promise<void>;
};
type Listener = (state: { pull: GithubPull | null; error?: string }) => void;
type Reader = {
	repo: string;
	branch: string;
	headRepos: string[];
	number?: number;
	snapshot?: PullSnapshot | null;
	error?: string;
	cache: Parameters<Github["find"]>[3];
	checkHead?: string;
	readied?: { node: string; head: string | undefined };
	plan?: PlanPull;
	finalized?: string;
	wake: boolean;
	findAgain: boolean;
	timer?: ReturnType<typeof setTimeout>;
	listeners: Set<Listener>;
	controller: AbortController;
};

const terminal = (value: PullSnapshot | null | undefined) =>
	value?.pull.state === "merged" || value?.pull.state === "closed";

export class PullReaders {
	#readers = new Map<string, Reader>();
	#reads = new SharedWork<PullSnapshot | null>();
	#merges = new SharedWork<void>();
	#finishes = new SharedWork<void>();
	#lifetime = new AbortController();

	constructor(private github: Github, private log: Log, private cadence = { pending: 20_000, idle: 120_000 }) {}

	#key(repo: string, branch: string) {
		if (!branch || branch.startsWith("-") || branch.split("/").some(part => [".", "..", ""].includes(part))) {
			throw new Error("Choose a Git branch.");
		}
		return JSON.stringify([repository(repo).toLowerCase(), branch]);
	}

	#get(repo: string, branch: string) {
		const key = this.#key(repo, branch);
		let reader = this.#readers.get(key);
		if (!reader) this.#readers.set(key, reader = {
			repo: repo.toLowerCase(), branch, headRepos: [repo.toLowerCase()], wake: false, findAgain: false,
			cache: new Map(), listeners: new Set(),
			controller: new AbortController(),
		});
		return reader;
	}

	#drop(reader: Reader) {
		if (reader.plan || reader.listeners.size) return;
		clearTimeout(reader.timer);
		reader.controller.abort();
		this.#readers.delete(this.#key(reader.repo, reader.branch));
	}

	watch(repo: string, branch: string, listener: Listener): () => void {
		const reader = this.#get(repo, branch);
		reader.listeners.add(listener);
		if (reader.snapshot !== undefined || reader.error) listener(this.#state(reader));
		if (reader.snapshot === undefined) void this.#read(reader).catch(() => {});
		return () => {
			reader.listeners.delete(listener);
			this.#drop(reader);
		};
	}

	current(repo: string, branch: string): GithubPull | undefined {
		return this.#readers.get(this.#key(repo, branch))?.snapshot?.pull;
	}

	wake(repo: string, branch: string, headRepos: readonly string[]) {
		const reader = this.#readers.get(this.#key(repo, branch));
		if (!reader) return;
		this.#headRepos(reader, headRepos);
		this.#wake(reader, true);
	}

	plan(repo: string, branch: string, plan: PlanPull, headRepos: readonly string[] = []): () => void {
		const reader = this.#get(repo, branch);
		const repositoriesChanged = this.#headRepos(reader, headRepos);
		reader.plan = { ...plan, open: plan.open || reader.plan?.open === true };
		this.#wake(reader, plan.open || repositoriesChanged);
		return () => {
			if (reader.plan?.id !== plan.id) return;
			reader.plan = undefined;
			this.#drop(reader);
		};
	}

	#headRepos(reader: Reader, headRepos: readonly string[]) {
		const repositories = [...new Set([...reader.headRepos, ...headRepos.map(repo => repo.toLowerCase())])];
		if (repositories.length === reader.headRepos.length) return false;
		reader.headRepos = repositories;
		return true;
	}

	close() {
		this.#lifetime.abort();
		for (const reader of this.#readers.values()) {
			clearTimeout(reader.timer);
			reader.controller.abort();
		}
		this.#readers.clear();
	}

	async merge(repo: string, branch: string, plan: string, number: number, head: string) {
		const reader = this.#readers.get(this.#key(repo, branch));
		const snapshot = reader?.snapshot;
		if (!reader || reader.plan?.id !== plan || snapshot?.pull.number !== number || snapshot.pull.sha !== head) {
			throw new Error("The pull request changed. Review its latest head before merging.");
		}
		if (snapshot.pull.state === "merged") {
			await this.#finish(reader, snapshot);
			return;
		}
		if (snapshot.pull.state !== "open" || this.#staleReview(reader, snapshot.node, head)) {
			throw new Error("The pull request must be open and ready for review before merging.");
		}
		const { outcome } = await this.#merges.run({
			scope: reader.repo, key: JSON.stringify([number, head]), signal: this.#lifetime.signal,
			run: async signal => {
				try {
					await this.github.merge(reader.repo, number, head, signal);
				} catch (error) {
					this.#wake(reader);
					throw error;
				}
				const merged: PullSnapshot = {
					...snapshot, mergedAt: Date.now(), pull: { ...snapshot.pull, state: "merged", merge: undefined },
				};
				if (reader.number === number) {
					this.#publish(reader, merged);
					if (!reader.wake) clearTimeout(reader.timer);
				}
				await this.#finish(reader, merged);
				return { kind: "succeeded", value: undefined };
			},
		});
		return outcome.kind === "succeeded" ? outcome.value : undefined;
	}

	#state(reader: Reader) {
		return { pull: reader.snapshot?.pull ?? null, ...(reader.error ? { error: reader.error } : {}) };
	}

	#readiedHead(reader: Reader, node: string) {
		if (!reader.plan) return;
		if (reader.readied?.node !== node) reader.readied = { node, head: reader.plan.readiness?.head(node) };
		return reader.readied.head;
	}

	#staleReview(reader: Reader, node: string, head: string) {
		const readied = this.#readiedHead(reader, node);
		return readied !== undefined && readied !== head;
	}

	#publish(reader: Reader, value: PullSnapshot | null) {
		const prior = this.#state(reader);
		const initial = reader.snapshot === undefined;
		reader.snapshot = value;
		reader.error = undefined;
		const state = this.#state(reader);
		if (initial || JSON.stringify(prior) !== JSON.stringify(state)) {
			reader.plan?.changed?.();
			for (const listener of reader.listeners) listener(state);
		}
	}

	#wake(reader: Reader, findAgain = false) {
		reader.wake = true;
		reader.findAgain ||= findAgain;
		this.#schedule(reader, 0);
	}

	async #read(reader: Reader) {
		const result = await this.#reads.run({
			scope: reader.repo, key: reader.branch, signal: reader.controller.signal,
			run: async signal => {
				reader.wake = false;
				const findAgain = reader.findAgain;
				reader.findAgain = false;
				try {
					return { kind: "succeeded", value: await this.#tick(reader, signal, findAgain) };
				} catch (error) {
					if (!signal.aborted) {
						this.log("warn", "pull.read.failed", { repo: reader.repo, branch: reader.branch, number: reader.number, ...failure(error) });
						const message = error instanceof Error ? error.message : "GitHub could not read the pull request.";
						if (reader.error !== message) {
							reader.error = message;
							for (const listener of reader.listeners) listener(this.#state(reader));
						}
					}
					throw error;
				} finally {
					const pull = reader.snapshot?.pull;
					const pending = pull?.merge === "unknown" || pull?.checks.some(check => check.state === "pending");
					if (!signal.aborted) {
						if (reader.wake) this.#schedule(reader, 0);
						else if (this.#shouldSchedule(reader)) {
							this.#schedule(reader, pending && !reader.error ? this.cadence.pending : this.cadence.idle);
						}
					}
				}
			},
		});
		return result.outcome.kind === "succeeded" ? result.outcome.value : null;
	}

	#shouldSchedule(reader: Reader) {
		const pull = reader.snapshot?.pull;
		if (!terminal(reader.snapshot)) return !!reader.error || !!pull || !reader.plan;
		const finalizing = pull?.state === "merged" && reader.plan && reader.finalized !== reader.plan.id;
		return !!reader.error && (reader.number !== pull?.number || finalizing);
	}

	#schedule(reader: Reader, delay: number) {
		clearTimeout(reader.timer);
		reader.timer = setTimeout(() => {
			reader.timer = undefined;
			void this.#read(reader).catch(() => {});
		}, delay);
	}

	async #tick(reader: Reader, signal: AbortSignal, findAgain: boolean) {
		const { repo, branch, cache, headRepos } = reader;
		const previous = reader.snapshot;
		const finished = previous && terminal(previous) ? previous : undefined;
		if (finished) {
			if (finished.pull.state === "merged") await this.#finish(reader, finished);
			if (reader.number === finished.pull.number && !findAgain) return finished;
		}
		const started = Date.now();
		const plan = reader.plan;
		let status: number;
		if (reader.number === undefined || reader.number === finished?.pull.number) {
			const found = await this.github.find(repo, branch, signal, cache, headRepos);
			signal.throwIfAborted();
			status = found.status;
			if (finished && (found.number === undefined || found.number <= finished.pull.number)) {
				this.log("info", "pull.read", { repo, branch, number: found.number ?? null, status, ms: Date.now() - started });
				this.#publish(reader, finished);
				return finished;
			}
			if (finished) cache.delete(`/repos/${repo}/pulls/${finished.pull.number}`);
			reader.number = found.number;
			if (reader.number === undefined && plan?.open) {
				reader.number = await this.github.draft(repo, branch, plan.title, plan.text, signal, headRepos);
				plan.open = false;
			}
			if (reader.number === undefined) {
				this.log("info", "pull.read", { repo, branch, number: null, status, ms: Date.now() - started });
				this.#publish(reader, null);
				return null;
			}
		}
		const detail = await this.github.detail(repo, reader.number, signal, cache);
		this.log("info", "pull.read", { repo, branch, number: reader.number, status: detail.status, ms: Date.now() - started });
		const value = detail.value;
		const head = value.head.sha;
		const headRepo = value.head.repo?.full_name.toLowerCase();
		if (value.head.ref !== branch || headRepo && !headRepos.includes(headRepo)) {
			throw new Error("GitHub returned a pull request from a different branch.");
		}
		signal.throwIfAborted();
		// A person can merge while a conditional read is still answering.
		if (reader.snapshot !== previous && reader.snapshot?.pull.state === "merged") return reader.snapshot;
		if (value.state === "open" && !value.draft && this.#staleReview(reader, value.node_id, head)) {
			const blocked = pullSnapshot(repo, { ...value, mergeable: false, mergeable_state: "blocked" }, [], undefined);
			this.#publish(reader, blocked);
			await this.github.returnToDraft(value.node_id, signal);
			this.log("info", "pull.review.stale", { repo, branch, number: value.number, head, reviewedHead: reader.readied?.head });
			const draft = pullSnapshot(repo, { ...value, draft: true, mergeable: false, mergeable_state: "draft" }, [], undefined);
			this.#publish(reader, draft);
			return draft;
		}
		if (reader.checkHead !== head) {
			for (const path of cache.keys()) if (path.includes("/commits/")) cache.delete(path);
			reader.checkHead = head;
		}
		const samePull = previous?.pull.number === value.number ? previous : undefined;
		const review = value.state === "open" && detail.status !== 304
			? await this.github.review(value.node_id, signal).catch(error => {
				if (!signal.aborted) this.log("warn", "pull.review.failed", { repo, number: value.number, ...failure(error) });
				return samePull?.pull.review;
			})
			: samePull?.pull.review;
		const checks = value.state === "open"
			? await this.github.checks(repo, head, signal, cache)
			: samePull?.pull.checks ?? [];
		signal.throwIfAborted();
		if (reader.snapshot !== previous && terminal(reader.snapshot)) return reader.snapshot ?? null;
		const snapshot = pullSnapshot(repo, value, checks, review);
		this.#publish(reader, snapshot);
		if (snapshot.pull.state === "merged") await this.#finish(reader, snapshot);
		if (findAgain && !finished && terminal(snapshot)) {
			reader.findAgain = true;
			reader.wake = true;
		}
		const active = reader.plan;
		if (snapshot.pull.state === "draft" && active?.ready(head) && this.#readiedHead(reader, snapshot.node) !== head) {
			await this.github.ready(snapshot.node, signal);
			reader.readied = { node: snapshot.node, head };
			active.readiness?.record(snapshot.node, head);
			reader.wake = true;
		}
		return snapshot;
	}

	async #finish(reader: Reader, snapshot: PullSnapshot) {
		const plan = reader.plan;
		const { number, sha } = snapshot.pull;
		if (!plan || reader.finalized === plan.id || sha === undefined || snapshot.mergedAt === undefined) return;
		const at = snapshot.mergedAt;
		await this.#finishes.run({
			scope: reader.repo, key: JSON.stringify([number, sha]), signal: this.#lifetime.signal,
			run: async signal => {
				try {
					if (snapshot.headRepo) {
						const removed = await this.github.deleteBranch(snapshot.headRepo, reader.branch, sha, signal);
						this.log("info", "pull.branch.cleanup", { repo: snapshot.headRepo, branch: reader.branch, number, result: removed });
					}
				} catch (error) {
					this.log("warn", "pull.branch.cleanup.failed", { repo: reader.repo, branch: reader.branch, number, ...failure(error) });
				}
				await plan.merged(number, sha, at);
				reader.finalized = plan.id;
				return { kind: "succeeded", value: undefined };
			},
		});
	}
}
