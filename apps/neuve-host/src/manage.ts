import {extendModels} from "./model-availability";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";

import type { Changes, ChannelInfo, ModelRef } from "@ace/channel/protocol";
import { available, choose, usable } from "@ace/channel/models";

import * as catalog from "./catalog";
import { Connection, hostedAuth, request } from "./client";
import { frozen } from "./compute";
import { config } from "./config";
import { forkLane } from "./fork-origin";
import { refusal } from "./http";
import { models as providers } from "./keys";
import { preference } from "./preferences";
import { checkout, git, workLanes } from "./projects";
import { isInactive } from "./protocol";
import { failure, log } from "./log";
import { stopLaneWorkspaces } from "./lane-workspace";

export function parseModel(value: string): ModelRef {
	const split = value.indexOf("/");
	if (split < 1) throw new Error("A model is written provider/id, such as openai/gpt-6-astra");
	return { provider: value.slice(0, split), modelId: value.slice(split + 1) };
}

/** Models with credentials on this machine. */
export async function models(): Promise<ModelRef[]> {
	return extendModels(available(providers()));
}

/** `models` lets Settings resolve it without waiting on a keychain prompt. */
export async function defaultModel(models: Models = providers()): Promise<ModelRef> {
	const configured = config.model && parseModel(config.model);
	if (configured && await usable(models, configured).catch(() => false)) return configured;
	const saved = preference();
	if (saved && await usable(models, saved).catch(() => false)) return saved;
	return choose(models);
}

/** The Git top level containing `dir`, which needs a commit for lanes to start from. */
export async function project(dir: string): Promise<string> {
	dir = resolve(dir === "~" ? homedir() : dir.startsWith("~/") ? homedir() + dir.slice(1) : dir);
	if (!existsSync(dir)) throw new Error(`${dir} doesn't exist.`);
	const result = await git(dir, ["rev-parse", "--show-toplevel"]);
	if (result.status === null) throw new Error("Git is unavailable. Check Settings → Neuve Helper.");
	if (result.status !== 0) {
		throw new Error(`${dir} is not a Git repository. Initialize Git to start channels in it.`);
	}
	if ((await git(dir, ["rev-parse", "--verify", "-q", "HEAD"])).status !== 0) {
		throw new Error(`${dir} has no commits yet. Commit its files to start channels in it.`);
	}
	return result.stdout.trim();
}

/** Hosted channels are always reachable; local ones run while their worker does. */
export function isRunning(id: string): boolean {
	if (catalog.read(id).hosted) return true;
	return existsSync(catalog.paths(id).socket) && isWorkerAlive(id);
}

/** PID liveness also covers startup, before the worker has opened its listener. */
export function isWorkerAlive(id: string): boolean {
	try {
		const owner = Number(readFileSync(catalog.paths(id).pid, "utf8"));
		if (!Number.isSafeInteger(owner) || owner <= 0) return false;
		process.kill(owner, 0);
		return true;
	} catch {
		return false;
	}
}

/** What the hosting service stores for a channel whose workspace is this host. */
export function hostedConfig(record: catalog.Listing) {
	return {
		version: 2,
		id: record.id,
		name: record.name,
		prefix: record.prefix,
		named: record.named,
		owner: record.owner,
		project: record.project,
		lanes: catalog.paths(record.id).lanes,
		model: record.model,
		workspace: `host:${hostname()}`,
	};
}

/**
 * Forks a channel into a new sibling channel in its project, seeded with the source's summary and
 * a link back to it. The root chat's lane continues in a new lane from its current commit, where
 * uncommitted work stays behind. The source is only read, never written.
 */
export async function fork(id: string, author: string): Promise<catalog.Listing> {
	const source = catalog.read(id);
	if (source.compute) {
		throw new Error(
			"Cloud compute channels can't be forked yet: their lanes are in the container.",
		);
	}
	const connection = await Connection.open(id);
	let info: ChannelInfo;
	let changes: Changes;
	try {
		[info, changes] = await Promise.all([
			connection.request<ChannelInfo>({ op: "info" }),
			connection.request<Changes>({ op: "changes" }),
		]);
	} finally {
		connection.close();
	}
	const root = info.chats.find((chat) => chat.id === ROOT_CONVERSATION_ID);
	const record = catalog.fork(source, root?.model || source.model);
	const lane = changes.lane
		? {
			name: changes.lane,
			path: await forkLane(record, changes.head, changes.lane),
			// The source's fork point, so the Diff shows its commits as well as the fork's own.
			base: changes.base,
		}
		: undefined;
	const saved = catalog.save(lane ? { ...record, lane } : record);
	await (await import("./runtime-hooks")).runtimeHooks().onFork?.(id, record.id);
	await request(record.id, { op: "say", author, text: seed(info, changes, lane) });
	return saved;
}

function seed(info: ChannelInfo, changes: Changes, lane: { name: string } | undefined): string {
	const lines = [`Forked from #${info.name} (channel ${info.id}).`];
	if (info.summary) lines.push("", info.summary);
	if (lane) {
		const dirty = changes.dirs?.length
			|| changes.files.some((file) => file.state === "uncommitted" || file.state === "untracked");
		lines.push(
			"",
			`Lane ${lane.name} continues from ${changes.branch || "its lane"} at ${
				changes.head.slice(0, 12)
			}.${dirty ? " Its uncommitted changes stayed in the source." : ""}`,
		);
	}
	return lines.join("\n");
}

export async function kill(id: string): Promise<void> {
	// Only the owner reaches this, through archive, delete, or ace kill.
	const { hosted, compute, owner } = catalog.read(id);
	if (hosted) {
		if (compute && await frozen(id)) return;
		return request<void>(id, { op: "kill", author: owner });
	}
	const connection = await Connection.running(id);
	if (!connection) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			(async () => {
				await connection.request({ op: "kill", author: owner });
				// The reply only confirms the abort; the worker closes sockets after storage and tools.
				await connection.closed;
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Channel ${id} did not close within 10 seconds`)),
					10_000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		connection.close();
	}
}

export async function archive(id: string, archived: boolean, stopWorkspaces = stopLaneWorkspaces): Promise<catalog.Listing> {
	if (archived) await kill(id);
	const record = { ...catalog.read(id), archived };
	catalog.write(record);
	if (archived && !record.hosted && !record.compute) {
		await stopChannelLaneWorkspaces(record, stopWorkspaces);
		await disposeLanes(record, "chat");
	}
	return record;
}

async function stopChannelLaneWorkspaces(record: catalog.Listing, stop = stopLaneWorkspaces): Promise<void> {
	const paths = new Set(Object.values(record.chatLanes ?? {}).map(lane => lane.path));
	if (record.lane) paths.add(record.lane.path);
	const warn = (error: unknown) => log("warn", "lane.workspace.retained", { channel: record.id, ...failure(error) });
	try {
		await stop([...paths], warn);
	} catch (error) {
		warn(error);
	}
}

async function disposeLanes(record: catalog.Listing, scope: "chat" | "all"): Promise<void> {
	const { lanes: folder } = catalog.paths(record.id);
	const retained = (path: string, error: unknown) =>
		log("warn", "chat.lane.retained", { channel: record.id, path, ...failure(error) });
	const lanes = await workLanes(record.project, folder).catch(error => {
		retained(folder, error);
		return [];
	});
	for (const { name, path, branch } of lanes) {
		try {
			if (scope === "chat") {
				const owned = record.chatLanes?.[name];
				if (!owned || record.lane?.path === path || !existsSync(path)) continue;
				if (!/^chat-\d+$/.test(name) || owned.path !== path || owned.branch !== `${record.prefix}/${name}`) {
					throw new Error("The work lane does not match its host-owned location and branch");
				}
				if (branch !== owned.branch) throw new Error("The work lane's Git registration changed, so it was kept");
			}
			// Do not let status.showUntrackedFiles=no hide work from Git's removal check.
			const removed = await git(record.project, ["worktree", "remove", "--", path], ["status.showUntrackedFiles=normal"]);
			if (removed.status !== 0) throw new Error((removed.stderr || removed.stdout).trim() || "Git could not remove the work lane");
			if (existsSync(path)) throw new Error("Git reported removal but the work lane folder remains");
			log("info", "chat.lane.removed", { channel: record.id, path, branch });
		} catch (error) {
			retained(path, error);
		}
	}
}

/** Dormant workers retire only once idle, so only a live worker can have work in progress. */
async function busy(id: string): Promise<boolean> {
	const { hosted, compute } = catalog.read(id);
	if (compute && await frozen(id)) return false;
	const connection = hosted ? await Connection.hosted(hosted, id) : await Connection.running(id);
	if (!connection) return false;
	try {
		const { chats } = await connection.request<ChannelInfo>({ op: "info" });
		return chats.some((chat) => chat.busy);
	} finally {
		connection.close();
	}
}

/** Archives a project's inactive channels on this host, judged by this host's clock; returns their IDs. */
export async function archiveInactive(root: string): Promise<string[]> {
	const now = Date.now();
	const inactive = catalog.list().filter((record) => !record.archived && isInactive(record, now));
	const roots = await Promise.all(inactive.map((record) => checkout(record.project)));
	const open = inactive.filter((_, index) => roots[index]!.root === root);
	const idle = await Promise.all(open.map(async ({ id }) => (await busy(id)) ? undefined : id));
	const ids = idle.filter((id) => id !== undefined);
	await Promise.all(ids.map((id) => archive(id, true)));
	return ids;
}

/**
 * Kills the worker and keeps its lock, so a client still watching the channel cannot start another
 * worker over storage being removed. A worker that started before the lock is killed in turn.
 */
async function hold(id: string): Promise<void> {
	for (let wait = 50; wait < 5000; wait *= 2) {
		await kill(id);
		if (catalog.lock(id)) return;
		await Bun.sleep(wait);
	}
	throw new Error("The channel's worker kept restarting; try deleting it again");
}

/**
 * Removes the channel and its clean worktrees. Lane branches stay in the project.
 */
export async function remove(id: string): Promise<void> {
	const record = catalog.read(id);
	const { hosted, compute } = record;
	if (compute) {
		// The service's DELETE also deletes the channel and ends its run, which a frozen channel
		// (a failed start) would refuse to the host's own kill.
		const response = await fetch(`${hosted}/workspaces/${id}`, {
			method: "DELETE",
			headers: await hostedAuth(),
		});
		if (!response.ok) {
			const reason = await refusal(response, "Cloud compute");
			throw new Error(`${reason} The channel and its cloud workspace were kept.`);
		}
	} else if (hosted) {
		await kill(id);
		const response = await fetch(`${hosted}/channels/${id}`, {
			method: "DELETE",
			headers: await hostedAuth(),
		});
		if (!response.ok && response.status !== 404) {
			throw new Error(
				`${await refusal(response, "The hosting service")} The channel was not deleted.`,
			);
		}
	} else {
		await hold(id);
		await stopChannelLaneWorkspaces(record);
	}
	try {
		await disposeLanes(record, "all");
		catalog.remove(id);
	} catch (error) {
		if (!hosted) catalog.unlock(id);
		throw error;
	}
}
