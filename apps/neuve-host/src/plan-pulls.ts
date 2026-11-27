import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@ace/channel";
import { BuildSchema } from "@ace/channel/frame";
import { z } from "zod";

import * as catalog from "./catalog";
import { request } from "./client";
import { project, pullGithub } from "./github";
import { failure, log } from "./log";
import { PullReaders } from "./pull-reader";
import type { HostRequest, Listing } from "./protocol";

const file = "build-pulls.json";
const Projection = z.array(z.object({
	build: BuildSchema,
	ended: z.array(z.number()),
	finishedReview: z.object({ humanRequired: z.int().nonnegative(), reviewerHeads: z.array(z.string()) }).optional(),
}));
type Projection = z.output<typeof Projection>;
const ReadiedHeads = z.record(z.string(), z.string());

function writeProjection(path: string, json: string) {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, json, { mode: 0o600 });
	renameSync(temporary, path);
}

export function publishBuildPulls(channel: string, builds: Parameters<NonNullable<Options["onBuildPulls"]>>[0]) {
	const path = join(catalog.dir(channel), file);
	const projection = JSON.stringify(builds);
	if (!builds.length && !existsSync(path)) return;
	if (existsSync(path) && readFileSync(path, "utf8") === projection) return;
	writeProjection(path, projection);
}

function readiness(channel: string) {
	const path = join(catalog.dir(channel), "readied-pulls.json");
	const read = () => existsSync(path) ? ReadiedHeads.parse(JSON.parse(readFileSync(path, "utf8"))) : {};
	return {
		head: (node: string) => {
			const heads = read();
			return Object.hasOwn(heads, node) ? heads[node] : undefined;
		},
		record: (node: string, head: string) => writeProjection(path, JSON.stringify({ ...read(), [node]: head })),
	};
}

type TrackedPull = { repo: string; branch: string; ended: string; reviewed: string; detach(): void };
type ChannelPlans = { rows: Projection; pulls: Map<string, TrackedPull>; summary?: Listing["plans"] };

type MergeRequest = Extract<HostRequest, { op: "plan-pull-merge" }>;

export function requirePullOwner(client: { peer: boolean; user: string }, owner: string, channelOwner: string | undefined) {
	if (client.peer || client.user !== owner || client.user !== channelOwner || client.user.startsWith("agent@")) {
		throw new Error("Only the channel's owner can merge its plan's pull request.");
	}
}

export class PlanPulls {
	readonly readers: PullReaders;
	#channels = new Map<string, ChannelPlans>();
	#closed = false;

	constructor(readers = new PullReaders(pullGithub(), log), private listingsChanged = () => {}) {
		this.readers = readers;
	}

	start() {
		this.#scan(true);
	}

	changed(path: string | null) {
		if (!path || path === "." || path === "channels" || path === catalog.dir("")) return this.#scan(false);
		const match = /^([0-9a-f]{16})(?:\/(?:build-pulls\.json|channel\.json))?$/.exec(path);
		if (match) this.#sync(match[1]!);
	}

	#scan(startup: boolean) {
		try {
			const present = new Set(catalog.list().map(({ id }) => id));
			for (const id of present) this.#sync(id, startup);
			for (const id of this.#channels.keys()) if (!present.has(id)) this.#drop(id);
		} catch (error) {
			log("warn", "pull.plan.scan.failed", failure(error));
		}
	}

	#drop(channel: string) {
		const plans = this.#channels.get(channel);
		if (!plans) return;
		for (const value of plans.pulls.values()) value.detach();
		this.#channels.delete(channel);
		if (plans.summary) this.listingsChanged();
	}

	#local(channel: string) {
		const record = catalog.owns(channel) ? catalog.read(channel) : undefined;
		return record && record.owner === catalog.user && !record.hosted && !record.moving ? record : undefined;
	}

	#sync(channel: string, startup = false) {
		void this.#load(channel, startup).catch(error => log("warn", "pull.plan.failed", { channel, ...failure(error) }));
	}

	async #load(channel: string, startup: boolean) {
		const path = join(catalog.dir(channel), file);
		const record = this.#local(channel);
		if (!record || !existsSync(path)) return this.#drop(channel);
		const repo = await project(record.project, true);
		if (this.#closed) return;
		const current = this.#local(channel);
		if (!current) return this.#drop(channel);
		if (current.project !== record.project) return;
		if (!existsSync(path)) return this.#drop(channel);
		const rows = Projection.parse(JSON.parse(readFileSync(path, "utf8")));
		this.#apply(channel, repo, rows, startup);
	}

	#apply(channel: string, repo: string | null, rows: Projection, startup: boolean) {
		if (!rows.length) return this.#drop(channel);
		const plans: ChannelPlans = this.#channels.get(channel) ?? { rows, pulls: new Map() };
		plans.rows = rows;
		this.#channels.set(channel, plans);
		const tracked = plans.pulls;
		const current = new Set<string>();
		for (const row of rows) {
			const { build } = row;
			const { branch, review, id } = build;
			if (!repo || !branch || build.merged) continue;
			const prior = tracked.get(id);
			current.add(id);
			const ended = JSON.stringify(row.ended.filter(Boolean));
			const reviewerHeads = row.finishedReview?.reviewerHeads ?? (
				review?.phase === "finished" && build.agents.some(agent => agent.chat === review.chat && agent.role === "reviewer")
					? [review.head] : []
			);
			const reviewed = JSON.stringify(reviewerHeads);
			const newBranch = prior?.branch !== branch || prior.repo !== repo;
			const open = startup || (prior?.ended !== ended && row.ended.some(Boolean));
			if (!open && !newBranch && prior.reviewed === reviewed) continue;
			if (newBranch) prior?.detach();
			const detach = this.readers.plan(repo, branch, {
				id, title: build.plan.title, open,
				text: () => request(channel, { op: "plan-pull-text", build: id, branch }),
				ready: head => reviewerHeads.includes(head),
				readiness: readiness(channel),
				changed: () => this.#summarize(channel),
				merged: (number, head, at) => request(channel, { op: "plan-pull-merged", build: id, branch, number, head, at }),
			});
			tracked.set(id, { repo, branch, ended, reviewed, detach });
		}
		for (const [id, value] of tracked) {
			if (current.has(id)) continue;
			value.detach();
			tracked.delete(id);
		}
		this.#summarize(channel);
	}

	#summarize(channel: string) {
		const plans = this.#channels.get(channel);
		if (!plans) return;
		let ready = false;
		let humanRequired = 0;
		let waiting = false;
		for (const { build, finishedReview } of plans.rows) {
			if (build.merged || build.state.kind === "stopped") continue;
			const tracked = plans.pulls.get(build.id);
			const pull = tracked && this.readers.current(tracked.repo, tracked.branch);
			if (pull?.state === "merged") continue;
			ready ||= pull?.state === "open" && pull.merge === "ready";
			humanRequired += finishedReview?.humanRequired ?? (build.review?.phase === "finished" ? build.review.humanRequired ?? 0 : 0);
			waiting ||= build.agents.some(agent => agent.state === "waiting");
		}
		const before = plans.summary;
		if (ready === !!before?.ready && humanRequired === (before?.humanRequired ?? 0) && waiting === !!before?.waiting) return;
		plans.summary = ready || humanRequired || waiting ? {
			...(ready ? { ready } : {}),
			...(humanRequired ? { humanRequired } : {}),
			...(waiting ? { waiting } : {}),
		} : undefined;
		this.listingsChanged();
	}

	summary(channel: string): Listing["plans"] {
		return this.#channels.get(channel)?.summary;
	}

	async merge(client: { peer: boolean; user: string }, { channel, build, number, head }: MergeRequest) {
		const record = this.#local(channel);
		requirePullOwner(client, catalog.user, record?.owner);
		const plan = this.#channels.get(channel)?.pulls.get(build);
		if (!plan) throw new Error("This plan has no open pull request.");
		await this.readers.merge(plan.repo, plan.branch, build, number, head);
	}

	close() {
		this.#closed = true;
		this.readers.close();
		this.#channels.clear();
	}
}
