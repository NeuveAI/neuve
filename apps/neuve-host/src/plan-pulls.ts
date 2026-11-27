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
import type { HostRequest } from "./protocol";

const file = "build-pulls.json";
const Projection = z.array(z.object({
	build: BuildSchema.extend({ branch: z.string() }),
	ended: z.array(z.number()),
}));
type Projection = z.output<typeof Projection>;

export function publishBuildPulls(channel: string, builds: Parameters<NonNullable<Options["onBuildPulls"]>>[0]) {
	const path = join(catalog.dir(channel), file);
	const projection = JSON.stringify(builds);
	if (!builds.length && !existsSync(path)) return;
	if (existsSync(path) && readFileSync(path, "utf8") === projection) return;
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, projection, { mode: 0o600 });
	renameSync(temporary, path);
}

type MergeRequest = Extract<HostRequest, { op: "plan-pull-merge" }>;

export function requirePullOwner(client: { peer: boolean; user: string }, owner: string, channelOwner: string | undefined) {
	if (client.peer || client.user !== owner || client.user !== channelOwner || client.user.startsWith("agent@")) {
		throw new Error("Only the channel's owner can merge its plan's pull request.");
	}
}

export class PlanPulls {
	readonly readers: PullReaders;
	#channels = new Map<string, Map<string, {
		repo: string; branch: string; ended: string; review: string; detach(): void;
	}>>();
	#closed = false;

	constructor(readers = new PullReaders(pullGithub(), log)) {
		this.readers = readers;
	}

	start() {
		this.#scan(true);
	}

	changed(path: string | null) {
		if (path === null) return this.#scan(false);
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
		for (const value of this.#channels.get(channel)?.values() ?? []) value.detach();
		this.#channels.delete(channel);
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
		if (this.#closed || this.#local(channel)?.project !== record.project) return;
		if (!repo || !existsSync(path)) return this.#drop(channel);
		const rows = Projection.parse(JSON.parse(readFileSync(path, "utf8")));
		this.#apply(channel, repo, rows, startup);
	}

	#apply(channel: string, repo: string, rows: Projection, startup: boolean) {
		const tracked = this.#channels.get(channel) ?? new Map();
		const current = new Set<string>();
		for (const row of rows) {
			const { build } = row;
			const { branch, review, id } = build;
			const prior = tracked.get(id);
			if (build.merged) continue;
			current.add(id);
			const ended = JSON.stringify(row.ended.filter(Boolean));
			const reviewed = JSON.stringify(review ?? null);
			const newBranch = prior?.branch !== branch || prior.repo !== repo;
			const open = startup || (prior?.ended !== ended && row.ended.some(Boolean));
			if (!open && !newBranch && prior.review === reviewed) continue;
			if (newBranch) prior?.detach();
			const detach = this.readers.plan(repo, branch, {
				id, title: build.plan.title, open,
				text: () => request(channel, { op: "plan-pull-text", build: id, branch }),
				ready: head => review?.phase === "finished" && review.head === head &&
					build.agents.some(agent => agent.chat === review.chat && agent.role === "reviewer"),
				merged: (number, head, at) => request(channel, { op: "plan-pull-merged", build: id, branch, number, head, at }),
			});
			tracked.set(id, { repo, branch, ended, review: reviewed, detach });
		}
		for (const [id, value] of tracked) {
			if (current.has(id)) continue;
			value.detach();
			tracked.delete(id);
		}
		if (tracked.size) this.#channels.set(channel, tracked);
		else this.#channels.delete(channel);
	}

	async merge(client: { peer: boolean; user: string }, { channel, build, number, head }: MergeRequest) {
		const record = this.#local(channel);
		requirePullOwner(client, catalog.user, record?.owner);
		const plan = this.#channels.get(channel)?.get(build);
		if (!plan) throw new Error("This plan has no open pull request.");
		await this.readers.merge(plan.repo, plan.branch, build, number, head);
	}

	close() {
		this.#closed = true;
		this.readers.close();
		this.#channels.clear();
	}
}
