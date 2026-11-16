import { z } from "zod";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId, type Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Admission, ChannelExtension } from "./extensions";
import { type ExternalRef } from "./external-ref";
import { LanesDoc } from "./lanes";
import { planning, PlanningDoc, PlanningRequestSchema, PlanningResultSchema, emptyPlanningState, unavailablePlanning, type Planning, type PlanningState } from "./planning";
import { review, type Review } from "./review";
import { ReviewContextDoc } from "./review-context";

import {ExtensionRequestSchema, type ExtensionRequest} from "./operations-protocol";
export {ExtensionRequestSchema, type ExtensionRequest} from "./operations-protocol";
export const MUTATING = new Set<ExtensionRequest["op"]>(["review-origin-set", "planning-select", "planning-clear", "planning-reviewed"]);
export const HOST_ONLY = new Set<ExtensionRequest["op"]>(["review-origin-set", "planning-reviewed"]);

export function channelOperations(options: {log?: import("./log").Log; review?: Review; planning?: Planning; items?: ExternalRef[]; forkedFrom?: {channel: string; chat: number}}): {
	extension: ChannelExtension;
	handle(request: ExtensionRequest): Promise<unknown>;
} {
	let harness: Harness;
	let admission: Admission;
	const read = async (request: z.infer<typeof PlanningRequestSchema>) => {
		const result = options.planning ? PlanningResultSchema.parse(await options.planning(request, context)) : unavailablePlanning();
		options.log?.("info", "planning.read", {operation: request.op, outcome: result.kind, ...(result.kind === "failure" ? {reason: result.reason} : {})});
		return result;
	};
	const resolve = async (chat?: number) => {
		const conversation = await harness.conversation((chat ?? ROOT_CONVERSATION_ID) as ConversationId, context);
		if (!conversation) throw new Error(`No chat ${chat}`);
		return conversation.id;
	};
	return {
		extension: {
			extensions: [review(options.review), ...(options.planning ? [planning(options.planning)] : [])],
			async attach(bound, gate) {
				harness = bound;
				admission = gate;
				await harness.commit(async (tx) => {
					const doc = await tx.doc(ReviewContextDoc);
					if (options.items?.length && !doc.chats[String(ROOT_CONVERSATION_ID)]) doc.chats[String(ROOT_CONVERSATION_ID)] = options.items;
					if (options.forkedFrom && !doc.forkedFrom) doc.forkedFrom = options.forkedFrom;
				}, context);
			},
		},
		async handle(request) {
			switch (request.op) {
				case "review-origin": return (await harness.snapshot(ReviewContextDoc, context))?.chats[String(await resolve(request.chat))] || [];
				case "review-origin-set": {
					const id = await resolve(request.chat);
					await harness.commit(async (tx) => { const doc = await tx.doc(ReviewContextDoc); doc.chats[String(id)] = request.items; if (request.forkedFrom) doc.forkedFrom = request.forkedFrom; }, context);
					return;
				}
				case "planning-read": return read(request.request);
				case "planning-state": return (await harness.snapshot(PlanningDoc, context))?.chats[String(await resolve(request.chat))] || emptyPlanningState();
				case "planning-select":
				case "planning-clear": return admission.serialize(request.chat, async () => {
					await admission.invoke(request.author);
					const id = await resolve(request.chat);
					const cwd = (await harness.snapshot(AgentDoc, id, context))?.cwd;
					const lane = Object.entries((await harness.snapshot(LanesDoc, context))?.lanes || {}).find(([,value]) => value.path === cwd);
					if (!lane) throw new Error("Select a lane before connecting Linear scope");
					let value: PlanningState = emptyPlanningState();
					if (request.op === "planning-select") {
						const result = await read({ op: "issue", connection: request.connection, issue: request.issue });
						if (result.kind === "failure") return result;
						if (result.kind !== "issue") throw new Error("Linear did not return the selected issue");
						value = { selection: { source: result.issue, lane: lane[0] }, review: null };
					}
					await harness.commit(async (tx) => { (await tx.doc(PlanningDoc)).chats[String(id)] = value; }, context);
					return value;
				});
				case "planning-reviewed": {
					const id = await resolve(request.chat);
					await harness.commit(async (tx) => {
						const doc = await tx.doc(PlanningDoc);
						const state = doc.chats[String(id)] || emptyPlanningState();
						if (JSON.stringify(state.selection?.source || null) !== JSON.stringify(request.source)) throw new Error("Records accepted this review, but the selected scope changed before its association could be saved");
						doc.chats[String(id)] = { ...state, review: request.review };
					}, context);
					return;
				}
			}
		},
	};
}
