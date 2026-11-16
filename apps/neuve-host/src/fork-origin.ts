import {mkdir, realpath} from "node:fs/promises";
import {join} from "node:path";
import * as catalog from "./catalog";
import {Connection} from "./client";
import {git} from "./projects";
import type {ChannelInfo} from "@ace/channel";
import {ExternalRefSchema} from "@ace/channel/external-ref";
import {z} from "zod";

export async function forkLane(project: string, branch: string, base: string, id: string, name: string): Promise<string> {
	const directory = catalog.paths(id).lanes;
	await mkdir(directory, {recursive: true});
	const path = join(directory, name);
	const result = await git(project, ["worktree", "add", "-b", branch, path, base]);
	if (result.status !== 0) throw new Error(result.stderr || "Could not create the fork's lane");
	return realpath(path);
}
export async function forkOrigin(source: string, child: string): Promise<void> {
	const original = await Connection.open(source);
	let items: z.infer<typeof ExternalRefSchema>[];
	let chat: number;
	try {
		const info = await original.request<ChannelInfo>({op: "info"});
		chat = info.chats.find((value) => value.parent === undefined)?.id || 1;
		items = z.array(ExternalRefSchema).max(16).parse(await original.request({op: "review-origin", chat}));
	} finally {original.close();}
	const fork = await Connection.open(child);
	try {await fork.request({op: "review-origin-set", items, forkedFrom: {channel: source, chat}});}
	finally {fork.close();}
}
