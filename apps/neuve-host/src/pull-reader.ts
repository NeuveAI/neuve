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
	merged(number: number, head: string, at: number): Promise<void>;
};
type Listener = (state: { pull: GithubPull | null; error?: string }) => void;
type Reader = {
	repo: string;
	branch: string;
	number?: number;
	snapshot?: PullSnapshot | null;
	error?: string;
	cache: Parameters<Github["find"]>[3];
	checkHead?: string;
	readiedHead?: string;
	plan?: PlanPull;
	finalized?: string;
	wake: boolean;
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
			repo: repo.toLowerCase(), branch, wake: false, cache: new Map(), listeners: new Set(),
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

	plan(repo: string, branch: string, plan: PlanPull): () => void {
		const reader = this.#get(repo, branch);
		reader.plan = { ...plan, open: plan.open || reader.plan?.open === true };
		this.#wake(reader);
		return () => {
			if (reader.plan?.id !== plan.id) return;
			reader.plan = undefined;
			this.#drop(reader);
		};
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
		if (snapshot.pull.state !== "open") throw new Error("The pull request must be open and ready for review before merging.");
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
				this.#publish(reader, merged);
				clearTimeout(reader.timer);
				await this.#finish(reader, merged);
				return { kind: "succeeded", value: undefined };
			},
		});
		return outcome.kind === "succeeded" ? outcome.value : undefined;
	}

	#state(reader: Reader) {
		return { pull: reader.snapshot?.pull ?? null, ...(reader.error ? { error: reader.error } : {}) };
	}

	#publish(reader: Reader, value: PullSnapshot | null) {
		const prior = this.#state(reader);
		const initial = reader.snapshot === undefined;
		reader.snapshot = value;
		reader.error = undefined;
		const state = this.#state(reader);
		if (initial || JSON.stringify(prior) !== JSON.stringify(state)) {
			for (const listener of reader.listeners) listener(state);
		}
	}

	#wake(reader: Reader) {
		reader.wake = true;
		clearTimeout(reader.timer);
		void this.#read(reader).catch(() => {});
	}

	async #read(reader: Reader) {
		const result = await this.#reads.run({
			scope: reader.repo, key: reader.branch, signal: reader.controller.signal,
			run: async signal => {
				reader.wake = false;
				try {
					return { kind: "succeeded", value: await this.#tick(reader, signal) };
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
						else if (reader.error || !terminal(reader.snapshot) && (pull || !reader.plan)) {
							this.#schedule(reader, pending && !reader.error ? this.cadence.pending : this.cadence.idle);
						}
					}
				}
			},
		});
		return result.outcome.kind === "succeeded" ? result.outcome.value : null;
	}

	#schedule(reader: Reader, delay: number) {
		clearTimeout(reader.timer);
		reader.timer = setTimeout(() => {
			reader.timer = undefined;
			void this.#read(reader).catch(() => {});
		}, delay);
	}

	async #tick(reader: Reader, signal: AbortSignal) {
		const { repo, branch, cache } = reader;
		if (terminal(reader.snapshot)) {
			if (reader.snapshot?.pull.state === "merged") await this.#finish(reader, reader.snapshot);
			return reader.snapshot ?? null;
		}
		const started = Date.now();
		const plan = reader.plan;
		let status: number;
		if (reader.number === undefined) {
			const found = await this.github.find(repo, branch, signal, cache);
			status = found.status;
			reader.number = found.number;
			if (reader.number === undefined && plan?.open) {
				reader.number = await this.github.draft(repo, branch, plan.title, plan.text, signal);
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
		if (value.head.ref !== branch || value.head.repo && value.head.repo.full_name.toLowerCase() !== repo) {
			throw new Error("GitHub returned a pull request from a different branch.");
		}
		if (reader.checkHead !== head) {
			for (const path of cache.keys()) if (path.includes("/commits/")) cache.delete(path);
			reader.checkHead = head;
		}
		const review = value.state === "open" && detail.status !== 304
			? await this.github.review(value.node_id, signal).catch(error => {
				if (!signal.aborted) this.log("warn", "pull.review.failed", { repo, number: value.number, ...failure(error) });
				return reader.snapshot?.pull.review;
			})
			: reader.snapshot?.pull.review;
		const checks = value.state === "open"
			? await this.github.checks(repo, head, signal, cache)
			: reader.snapshot?.pull.checks ?? [];
		signal.throwIfAborted();
		// A person can merge while a conditional read is still answering.
		if (reader.snapshot?.pull.state === "merged") return reader.snapshot;
		const snapshot = pullSnapshot(value, checks, review);
		this.#publish(reader, snapshot);
		if (snapshot.pull.state === "merged") await this.#finish(reader, snapshot);
		if (snapshot.pull.state === "draft" && reader.readiedHead !== head && reader.plan?.ready(head)) {
			await this.github.ready(snapshot.node, signal);
			reader.readiedHead = head;
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
					const removed = await this.github.deleteBranch(reader.repo, reader.branch, sha, signal);
					this.log("info", "pull.branch.cleanup", { repo: reader.repo, branch: reader.branch, number, result: removed });
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
