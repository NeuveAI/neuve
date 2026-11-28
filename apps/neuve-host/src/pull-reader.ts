import type { GithubPull, Log } from "@ace/channel";
import { SharedWork } from "@neuve/records-core/shared-work";

import { pullGithub, pullSnapshot, repository } from "./github";
import { failure } from "./log";

type Github = ReturnType<typeof pullGithub>;
type Listener = (state: { pull: GithubPull | null; error?: string }) => void;
type Reader = {
	repo: string;
	branch: string;
	pull?: GithubPull | null;
	error?: string;
	cache: Parameters<Github["find"]>[3];
	timer?: ReturnType<typeof setTimeout>;
	listeners: Set<Listener>;
	controller: AbortController;
};

const open = (pull: GithubPull | null | undefined): pull is GithubPull & { state: "open" | "draft" } =>
	pull?.state === "open" || pull?.state === "draft";

export class PullReaders {
	#readers = new Map<string, Reader>();
	#reads = new SharedWork<void>();

	constructor(
		private github: Github,
		private log: Log,
		private changed?: (repo: string, branch: string) => void,
		private cadence = { pending: 20_000, idle: 120_000 },
	) {}

	#key(repo: string, branch: string) {
		return JSON.stringify([repository(repo).toLowerCase(), branch]);
	}

	watch(repo: string, branch: string, listener: Listener): () => void {
		if (!branch || branch.startsWith("-") || branch.split("/").some(part => [".", "..", ""].includes(part))) {
			throw new Error("Choose a Git branch.");
		}
		const key = this.#key(repo, branch);
		let reader = this.#readers.get(key);
		if (!reader) this.#readers.set(key, reader = {
			repo: repository(repo).toLowerCase(), branch, cache: new Map(), listeners: new Set(),
			controller: new AbortController(),
		});
		reader.listeners.add(listener);
		if (reader.pull !== undefined || reader.error) listener(this.#state(reader));
		void this.#read(reader);
		return () => {
			reader.listeners.delete(listener);
			if (reader.listeners.size || reader.controller.signal.aborted) return;
			clearTimeout(reader.timer);
			reader.controller.abort();
			this.#readers.delete(key);
			if (reader.pull) this.changed?.(reader.repo, branch);
		};
	}

	current(repo: string, branch: string): GithubPull | undefined {
		return this.#readers.get(this.#key(repo, branch))?.pull ?? undefined;
	}

	close() {
		for (const reader of this.#readers.values()) {
			clearTimeout(reader.timer);
			reader.controller.abort();
		}
		this.#readers.clear();
	}

	#state(reader: Reader) {
		return { pull: reader.pull ?? null, ...(reader.error ? { error: reader.error } : {}) };
	}

	async #read(reader: Reader) {
		const { repo, branch, controller } = reader;
		clearTimeout(reader.timer);
		await this.#reads.run({
			scope: repo, key: branch, signal: controller.signal,
			run: async signal => {
				const prior = this.#state(reader);
				const initial = reader.pull === undefined;
				try {
					reader.pull = await this.#pull(reader, signal);
					reader.error = undefined;
				} catch (error) {
					if (signal.aborted) return { kind: "succeeded", value: undefined };
					this.log("warn", "pull.read.failed", { repo, branch, number: reader.pull?.number, ...failure(error) });
					reader.error = error instanceof Error ? error.message : "GitHub could not read the pull request.";
				}
				const state = this.#state(reader);
				const changed = JSON.stringify(prior.pull) !== JSON.stringify(state.pull);
				if (changed || prior.error !== state.error || initial && !state.error) {
					for (const listener of reader.listeners) listener(state);
				}
				if (changed) this.changed?.(repo, branch);
				if (!signal.aborted && open(state.pull)) {
					const pending = state.pull.merge === "unknown" || state.pull.checks.some(check => check.state === "pending");
					reader.timer = setTimeout(() => void this.#read(reader), pending && !state.error ? this.cadence.pending : this.cadence.idle);
				}
				return { kind: "succeeded", value: undefined };
			},
		}).catch(error => {
			if (!controller.signal.aborted) this.log("warn", "pull.read.failed", { repo, branch, ...failure(error) });
		});
	}

	async #pull({ repo, branch, cache, pull }: Reader, signal: AbortSignal): Promise<GithubPull | null> {
		const started = Date.now();
		let number = pull?.number;
		if (number === undefined || !open(pull)) {
			const found = await this.github.find(repo, branch, signal, cache);
			number = found.number;
			if (number === undefined) {
				signal.throwIfAborted();
				this.log("info", "pull.read", { repo, branch, number: null, status: found.status, ms: Date.now() - started });
				return null;
			}
			if (pull && number !== pull.number) cache.delete(`/repos/${repo}/pulls/${pull.number}`);
		}
		const { status, value } = await this.github.detail(repo, number, signal, cache);
		const { head } = value;
		if (head.ref !== branch || head.repo?.full_name.toLowerCase() !== repo) {
			throw new Error("GitHub returned a pull request from a different branch.");
		}
		if (pull?.sha !== head.sha) {
			for (const path of cache.keys()) if (path.includes("/commits/")) cache.delete(path);
		}
		const samePull = pull?.number === number ? pull : undefined;
		const review = value.state === "open" && status !== 304
			? await this.github.review(value.node_id, signal).catch(error => {
				if (!signal.aborted) this.log("warn", "pull.review.failed", { repo, number, ...failure(error) });
				return samePull?.review;
			})
			: samePull?.review;
		const checks = value.state === "open"
			? await this.github.checks(repo, head.sha, signal, cache)
			: samePull?.checks ?? [];
		signal.throwIfAborted();
		this.log("info", "pull.read", { repo, branch, number, status, ms: Date.now() - started });
		return pullSnapshot(value, checks, review);
	}
}
