import { refuseReview } from "@ace/channel/review-protocol";
import { reviewFeedFailure } from "./review-protocol";
import { reviewRefusal } from "@ace/channel/review-protocol";
import { rememberReviewNotification, reviewHasNewCommits } from "./review";
import { PlanningConnectionsSchema, PlanningStateSchema } from "@ace/channel/planning";
import { RequestSchema } from "@ace/channel/parse";
import { ExtensionRequestSchema, HOST_ONLY } from "@ace/channel/operations";
import type { HostOptions } from "./host";
import type { HostRequest, ReviewReceipt } from "./extension-protocol";
import type { HostRequest as NativeHostRequest } from "./protocol";
import * as catalog from "./catalog";
import { Connection } from "./client";
import * as projects from "./projects";
import * as reviewProjects from "./review-projects";
import * as github from "./review-github";
import { handoff, nativeHandoff, validateNative, pullHandoff } from "./review";
import { failure, log } from "./log";
import { runtimeHooks } from "./runtime-hooks";

function owned(channel: string): void {
	if (!catalog.owns(channel)) throw new Error("This channel does not belong to this host");
	const record = catalog.read(channel);
	if (record.hosted || record.moving) throw new Error("The channel is hosted or moving");
}

export async function dispatchGateway(
	client: {local: boolean; peer: boolean; user: string}, request: HostRequest, trace: string,
	connection: (channel: string) => Promise<Connection>,
	native: (request: NativeHostRequest) => Promise<unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const options: Partial<HostOptions> = runtimeHooks().host || {};
	const requireOwner = () => {
		if (!client.local || client.peer || client.user !== catalog.user) throw new Error("Neuve review is available only to this host's authenticated local owner");
	};
	if (request.op === "channel") {
		const extension = ExtensionRequestSchema.safeParse(request.request);
		if (extension.success) {
			requireOwner();
			if (HOST_ONLY.has(extension.data.op)) throw new Error("Only the host records a review association");
			owned(request.channel);
			return (await connection(request.channel)).request("author" in extension.data ? {...extension.data, author: client.user} : extension.data);
		}
		return native({...request, request: RequestSchema.parse(request.request)});
	}
	if (request.op === "create") {
		const {items, lane, ...plain} = request;
		if (lane) {
			requireOwner();
			if (plain.cloud) throw new Error("An explicit local lane cannot be assigned to a cloud channel");
		}
		const value = await native(plain);
		let assigned: catalog.Listing | undefined;
		if (lane) {
			const record = CreatedRecord.parse(value);
			assigned = await (await import("./channel-create")).assign(catalog.read(record.id), lane);
		}
		if (runtimeHooks().channelProvenance && !plain.cloud && items?.length) {
			void Promise.resolve().then(async () => {
				const record = CreatedRecord.parse(value);
				await (await connection(record.id)).request({op: "review-origin-set", items});
			}).catch(error => {
				try {
					log("warn", "review.origin.failed", {trace, ...failure(error)});
				} catch {
					// Provenance stays best-effort even when its warning cannot be written.
				}
			});
		}
		return assigned ?? value;
	}
	if (nativeOperations.has(request.op)) return native(parseNativeHostRequest(request));
	requireOwner();
	switch (request.op) {
		case "review-prepare": {
			owned(request.channel);
			if (!options.reviewPrepare) throw new Error("Native Neuve review is unavailable on this host");
			const handoff = await nativeHandoff(request.channel, request.target, request.snapshot);
			return { ...(await options.reviewPrepare(handoff)), target: request.target, handoff };
		}
		case "review-submit": {
			owned(request.channel);
			if (!options.reviewSubmit) throw new Error("Native Neuve review is unavailable on this host");
			await validateNative(request.channel, request.prepared, false);
			const notify = await rememberReviewNotification(catalog.paths(request.channel).base, request.prepared.requestId, request.prepared.notify ?? false, request.prepared.handoff.branch ?? "", request.prepared.handoff.head);
			return options.reviewSubmit({ ...request.prepared, notify }, current => validateNative(request.channel, request.prepared, current));
		}
		case "review-status": {
			owned(request.channel);
			if ("request" in request.query) {
				if (!options.reviewStatus) throw new Error("Native Neuve review status is unavailable on this host");
				return options.reviewStatus(catalog.read(request.channel).project, request.query);
			}
			try {
				if (!options.reviewLookup) throw new Error("Native Neuve review status is unavailable on this host");
				const project = catalog.read(request.channel).project;
				const status = await options.reviewLookup(project, request.channel, request.query);
				if ("outcome" in status) return status;
				return { ...status, new_commits: await reviewHasNewCommits(catalog.paths(request.channel).base, status.review, project) };
			} catch (error) { return reviewRefusal(error); }
		}
		case "review-outcome": {
			owned(request.channel);
			try {
				if (!options.reviewOutcome) throw new Error("Native Neuve review outcome is unavailable on this host");
				return await options.reviewOutcome(catalog.read(request.channel).project, request.channel, request.query);
			} catch (error) { return reviewRefusal(error); }
		}
		case "review-feed": {
			owned(request.channel);
			try {
				if (!options.reviewFeed) throw new Error("Native Neuve review feed is unavailable on this host");
				return await options.reviewFeed(catalog.read(request.channel).project, request.channel, request.query);
			}
			catch (error) {
				const failure = reviewFeedFailure(error);
				return refuseReview(failure.reason, failure.permanent ? "The recorded review is no longer available." : "Records is temporarily unavailable.");
			}
		}
		case "review-requests": {
			owned(request.channel);
			if (!options.reviewRequests || !signal) throw new Error("Native Neuve review requests are unavailable on this host");
			return options.reviewRequests(catalog.read(request.channel).project, request.channel, request.after, signal);
		}
		case "planning-connections":
			return PlanningConnectionsSchema.parse(await options.planningConnections?.() || { connections: [], status: "unavailable", message: "Linear planning is not configured on this host." });
		case "reviews": {
			if (request.item !== undefined) {
				await reviewProjects.validateRepository(request.project);
				if (!(await projects.list()).some(project => project.path === request.project)) throw new Error("Open this project on this host before reading its review history.");
				if (!options.reviewHistory) throw new Error("Records review history is not connected on this host.");
				const remotes = await projects.git(request.project, github.REMOTES);
				const matches = remotes.status === 0 && remotes.stdout.split("\n").some(line => github.remote(line) === request.item.repo.toLowerCase());
				const receipts = await options.reviewHistory({ project: request.project, item: request.item });
				if (!matches && !receipts.length) throw new Error("This GitHub item does not match a configured project remote or an existing Records association.");
				return receipts.map(acceptedReceipt);
			}
			owned(request.channel);
			if (!options.reviewHistory) throw new Error("Records review history is not connected on this host.");
			return options.reviewHistory({ project: catalog.read(request.channel).project, channel: request.channel, ...(request.chat === undefined ? {} : { chat: request.chat }) });
		}
		case "review-pull": {
			if (!options.review) throw new Error("Review handoff is not connected on this host");
			const value = await pullHandoff(request.project,request.repo,request.number,request.expectedHead);
			return acceptedReceipt(await options.review(value));
		}
		case "review-link": {
			owned(request.channel);
			if (options.reviewHistory) {
				const receipts = await options.reviewHistory({ project: catalog.read(request.channel).project, channel: request.channel, ...(request.chat === undefined ? {} : { chat: request.chat }) });
				if (receipts[0]) return acceptedReceipt(receipts[0]);
			}
			const target = await connection(request.channel);
			const state = PlanningStateSchema.parse(await target.request({ op: "planning-state", ...(request.chat === undefined ? {} : { chat: request.chat }) }));
			if (!state.review) return null;
			if (!options.reviewLink) throw new Error("Review links are not connected on this host");
			const url = new URL(await options.reviewLink(catalog.read(request.channel).project, state.review.reference));
			if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Records did not return a loopback review URL");
			return { reference: state.review.reference, url: url.href } satisfies ReviewReceipt;
		}
		case "review": {
			owned(request.channel);
			if (!options.review) throw new Error("Review handoff is not connected on this host");
			const target = await connection(request.channel);
			const value = await handoff(request.channel, request.chat, target, request.items);
			log("info", "review.handoff", { trace, channel: value.channel, chat: value.chat, project: value.project, lane: value.lane, base: value.base, head: value.head, origin: value.origin, sources: value.externalSources?.map(source => ({ item: source.item, version: source.version, complete: source.complete })) });
			const receipt = acceptedReceipt(await options.review(value));
			await target.request({ op: "planning-reviewed", chat: value.chat, source: value.source || null, review: { reference: receipt.reference, base: value.base, head: value.head } });
			if (value.origin?.kind === "channel") await target.request({ op: "review-origin-set", chat: value.chat, items: value.origin.items });
			return receipt;
		}
		case "github-descriptor": return github.descriptor(request.repo, request.number);
	}
}

import { z } from "zod";
import { NativeOperations, parseNativeHostRequest } from "./native-request";
const nativeOperations = NativeOperations;
const CreatedRecord = z.object({id: z.string().regex(/^[0-9a-f]{16}$/)});

function acceptedReceipt(receipt: ReviewReceipt): ReviewReceipt {
	if (!receipt || typeof receipt.reference !== "string" || !receipt.reference) throw new Error("Records did not return a review reference");
	const url = new URL(receipt.url);
	if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Records did not return a loopback review URL");
	return { ...receipt, url: url.href };
}
