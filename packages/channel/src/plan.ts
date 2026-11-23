import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, LiveDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { Admission } from "./extensions";
import type { Log } from "./log";
import type { IsPlanning } from "./plan-mode";
import { PLAN_TOOL, type Plan } from "./protocol";

declare const crypto: {
	randomUUID(): string;
	subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
};
declare class TextEncoder {
	encode(text: string): Uint8Array;
}
declare const TextDecoder: new (encoding: string, options: { ignoreBOM: boolean }) => {
	decode(bytes: Uint8Array): string;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

type StoredPlan = { plan: Plan; file: string; text: string };
export type PlansState = { chats: Record<string, StoredPlan[]> };

export const PlansDoc = defineDoc<PlansState>({
	kind: "neuve.plans",
	version: 1,
	scope: "session",
	initial: () => ({ chats: {} }),
});

export type PlanFiles = {
	stage(file: string, hash: string, bytes: Uint8Array): Promise<void>;
	read(file: string, hash: string, bytes: Uint8Array): Promise<Uint8Array>;
};

async function sha256(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

function find(plans: readonly StoredPlan[] | undefined, id: string): StoredPlan {
	const found = plans?.find(({ plan }) => plan.id === id);
	if (!found) throw new Error("Unknown plan in this chat.");
	return found;
}

export class Plans {
	constructor(private readonly files?: PlanFiles) {}

	private async bytes({ plan, file, text }: StoredPlan): Promise<Uint8Array> {
		const saved = encoder.encode(text);
		return this.files ? this.files.read(file, plan.hash, saved) : saved;
	}

	async read(harness: Harness, chat: ConversationId, id: string, context: Context) {
		const doc = await harness.snapshot(PlansDoc, context);
		const bytes = await this.bytes(find(doc?.chats[chat], id));
		return { hash: await sha256(bytes), text: decoder.decode(bytes) };
	}

	async approve(harness: Harness, chat: ConversationId, id: string, hash: string, author: string, context: Context) {
		// The chat's admission queue covers the file read and the approval commit.
		const doc = await harness.snapshot(PlansDoc, context);
		const record = find(doc?.chats[chat], id);
		if (record.plan.state === "replaced") throw new Error("A later plan has already replaced this plan.");
		const current = await sha256(await this.bytes(record));
		if (current !== hash) {
			throw new Error("The plan has changed. Read the current version before approving it.");
		}
		if (current !== record.plan.hash) {
			throw new Error("The plan file differs from the saved version. Ask the agent to write a draft.");
		}
		if (record.plan.state === "approved") return record.plan;
		const approved: Plan = { ...record.plan, hash: current, state: "approved", approved: { by: author, at: Date.now() } };
		await harness.commit(async tx => {
			for (const stored of (await tx.doc(PlansDoc)).chats[chat] ?? []) {
				if (stored.plan.id === id) stored.plan = approved;
				else if (stored.plan.state === "approved") stored.plan.state = "replaced";
			}
		}, context);
		return approved;
	}

	extension(planning: IsPlanning, serialize: Admission["serialize"], log: Log) {
		const files = this.files;
		if (!files) return;
		return defineExtension({
			name: "neuve-plan",
			tools: [defineTool({
				name: PLAN_TOOL,
				description: "In Plan mode, save the complete Markdown plan for human approval. Call this tool on its own when the plan is ready.",
				parameters: Type.Object({ text: Type.String() }),
				async execute({ text }, api, context) {
					const chat = api.conversationId;
					if (!await planning(chat, context)) {
						return { isError: true, content: [{ type: "text", text: "Plans can only be written in Plan mode." }] };
					}
					// Pi ends a round only when every tool result requests termination.
					if ((await api.snapshot(LiveDoc, chat, context))?.tools?.length !== 1) {
						return { isError: true, content: [{ type: "text", text: "Call plan_write on its own to end the turn." }] };
					}
					return serialize(chat, async () => {
						const bytes = encoder.encode(text);
						const markdown = decoder.decode(bytes);
						const hash = await sha256(bytes);
						const doc = await api.snapshot(PlansDoc, context);
						const latest = doc?.chats[chat]?.at(-1);
						const draft = latest?.plan.state === "draft" ? latest : undefined;
						const file = draft?.file ?? `${crypto.randomUUID()}.md`;
						await files.stage(file, hash, bytes);
						const plan: Plan = {
							id: draft?.plan.id ?? crypto.randomUUID(), hash, call: api.callId,
							title: title(markdown), state: "draft", written: Date.now(),
						};
						const record = { plan, file, text: markdown };
						await api.commit(async tx => {
							const { chats } = await tx.doc(PlansDoc);
							const plans = chats[chat];
							if (!plans) chats[chat] = [record];
							else if (draft) plans[plans.length - 1] = record;
							else plans.push(record);
						}, context);
						await files.read(file, hash, bytes);
						log("info", "plan.written", { chat });
						return { content: [{ type: "text", text: `Plan ready for approval.\n\n${markdown}` }], control: { terminate: true } };
					});
				},
			})],
		});
	}
}

function title(markdown: string): string {
	const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
	let fence: string | undefined;
	for (const [index, line] of lines.entries()) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const fenceMarker = marker?.[1];
		if (fence) {
			if (fenceMarker?.startsWith(fence) && !marker?.[2]?.trim()) fence = undefined;
			continue;
		}
		if (fenceMarker) {
			fence = fenceMarker;
			continue;
		}
		const heading = /^ {0,3}#{1,6}(?:[\t ]+|$)(.*)$/.exec(line)?.[1];
		if (heading !== undefined) return heading.trim().replace(/(?:^|\s+)#+$/, "").trimEnd();
		if (/^ {0,3}\S/.test(line) && /^ {0,3}(?:=+|-+)[\t ]*$/.test(lines[index + 1] ?? "")) return line.trim();
	}
	return "";
}
