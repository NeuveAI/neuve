import { MENTION, type QueuedMessage, type Reactions } from "@ace/channel/protocol";
import type { Listing, People } from "@ace/host/protocol";
import type { Event } from "@ace/ui";

import { AGENT_ALIAS, withAgentMention } from "./agent-mention";
import { placement } from "./placement";
import { planTool } from "./plan-card";
import { type ReviewCards, reviewNotice, reviewTool, wakeNote, wakePhase } from "./review-card";
import type { Item, Tool } from "./transcript";

/** The sender value of this channel's agent, which also keys its avatar. */
export const AGENT = "ace:agent";

/**
 * Channels on the viewed channel's host keyed by the author their agent's messages carry. The prefix
 * outlives renames, so messages sent before one still find their channel.
 */
export function sources(channels: Listing[], host: string): Map<string, Listing> {
	return new Map(
		channels.flatMap((channel) =>
			channel.host === host && channel.prefix ? [[`agent@${channel.prefix}`, channel]] : []
		),
	);
}

/**
 * Human authors are Tailscale logins; without a known GitHub login, the name before the domain
 * reads as a handle. Agent authors name the chat or channel after the `@`, so they stay whole.
 */
export function authorName(
	author: string,
	people: People,
	channels: Map<string, Listing>,
): string {
	const source = channels.get(author);
	if (source) return `#${source.name}`;
	if (author.startsWith("agent@")) return author;
	return people[author] || author.split("@")[0]!;
}

/**
 * People get withdrawn messages back as drafts. Another channel's agent has no composer, so its
 * message stays withdrawn, and naming that channel tells whoever stopped where to follow up.
 */
function withdrawal(
	messages: QueuedMessage[],
	people: People,
	channels: Map<string, Listing>,
): string {
	const names = (authors: string[]) =>
		[...new Set(authors)].map((author) => authorName(author, people, channels)).join(", ");
	// The host's review wake belongs to no person, so it is neither returned nor named.
	const notes = messages.filter((message) => reviewNotice(message));
	const others = messages.filter((message) => !reviewNotice(message));
	const humans = others.filter((message) => !message.author.startsWith("agent@"));
	const agents = others.filter((message) => message.author.startsWith("agent@"));
	const lines = [];
	if (humans.length) {
		const many = humans.length > 1;
		lines.push(
			`Returned ${humans.length} queued ${many ? "messages" : "message"} to ${
				names(humans.map((message) => message.author))
			} as ${many ? "drafts" : "a draft"}.`,
		);
	}
	if (agents.length) {
		const count = agents.length === 1 ? "a queued message" : `${agents.length} queued messages`;
		lines.push(`Withdrew ${count} from ${names(agents.map((message) => message.author))}.`);
	}
	if (notes.length) lines.push("Withdrew Neuve's note telling the agent the review ended.");
	return lines.join(" ");
}

/**
 * Who asked for a teammate's run and what ran it, written for the viewer. A local channel's agents
 * run as its owner on the owner's host with the owner's model keys; a hosted or cloud channel's
 * service runs them with its own keys.
 */
export function credit(
	asker: string,
	channel: Listing,
	user: string,
	people: People,
	channels: Map<string, Listing>,
): string | undefined {
	if (asker === channel.owner || asker.startsWith("agent@")) return;
	const name = (login: string) => login === user ? "you" : authorName(login, people, channels);
	const place = placement(channel);
	const where = place.kind === "cloud"
		? `ran in a cloud container on ${place.service} with its key`
		: place.kind === "hosted"
		? `ran on ${place.workspace} with ${place.service}'s key`
		: channel.owner === user
		? `ran on your ${place.host} with your key`
		: `ran on ${name(channel.owner)}'s ${place.host} with their key`;
	return `asked by ${name(asker)} · ${where}`;
}

function text(value: string): Event.Message.Content.Text {
	const parts = [...value.matchAll(MENTION)].map((match) => ({
		type: "mention" as const,
		value: match[1]!,
		index: match.index,
	}));
	return parts.length ? { type: "text", text: value, parts } : { type: "text", text: value };
}

const NOT_RUN = "Not run";

function tool(
	tool: Tool,
	busy: boolean,
	reviews: ReviewCards,
	caption?: string,
	recap?: string,
): Event.Message.Content.Tool {
	const status = tool.result ? (tool.result.error ? "error" : "success") : busy ? "start" : "error";
	// Neuve's review tools and the plan's writing tool read as one plain line; their state lives in their card.
	const review = reviewTool(tool, reviews) ?? planTool(tool);
	return {
		type: "tool",
		id: tool.call,
		name: review?.name ?? tool.name,
		arguments: review
			? review.summary ? { summary: review.summary } : {}
			: (tool.args ?? {}) as Record<string, unknown>,
		status,
		...(tool.unrun ? { caption: NOT_RUN } : caption ? { caption } : {}),
		...(recap ? { recap } : {}),
		...(tool.unrun
			? { result: { content: `${NOT_RUN}: the run ended while the agent was writing this call.` } }
			: {}),
		...(tool.result
			? {
				result: {
					content: review?.result ?? tool.result.text,
					...(tool.result.images
						? {
							images: tool.result.images.map((image) =>
								`data:${image.mimeType};base64,${image.data}`
							),
						}
						: {}),
				},
			}
			: {}),
		...(!tool.result && tool.progress
			? {
				result: {
					content: tool.progress.truncated
						? `… earlier output not shown\n${tool.progress.text}`
						: tool.progress.text,
				},
			}
			: {}),
	};
}

/**
 * Channel transcript items in the shape the original timeline renders. The streamed draft joins
 * the timeline as the newest agent message so it is laid out and scrolled like the rest.
 */
export function toEvents(
	items: Item[],
	topic: string,
	busy: boolean,
	draft: { text: string; model?: string },
	people: People,
	channels: Map<string, Listing>,
	captions: Record<string, string>,
	recaps: Record<string, string>,
	reactions: Reactions,
	by: (asker: string) => string | undefined,
	reviews: ReviewCards,
): Event[] {
	// A run answers the newest message that invoked it, as the channel's run end reports.
	let asker: string | undefined;
	const sender = (model: string | undefined): Event.Sender.Agent => {
		const value = [model, asker && by(asker)].filter(Boolean).join(" · ");
		return {
			kind: "agent",
			value: AGENT,
			display: AGENT_ALIAS.label,
			...(value ? { credit: value } : {}),
		};
	};
	const events = items.map((item) => {
		const reacted = item.entry === undefined ? undefined : reactions[item.entry];
		const base = {
			id: `${topic}::${item.key}`,
			uid: item.key,
			type: "message",
			topic,
			created_at: Math.floor(item.at / 1000),
			...(reacted
				? {
					reactions: reacted.map(({ from, emoji }) => ({
						from,
						display: authorName(from, people, channels),
						emoji,
					})),
				}
				: {}),
		} as const;
		// The host's notify wake reads as a quiet Neuve row, and the run it starts was asked by no one.
		const wake = wakeNote(item);
		if (wake) {
			asker = undefined;
			return {
				...base,
				type: "neuve:review:told",
				review: wake.review,
				phase: wakePhase(reviews, wake.review),
			} as Event;
		}
		if (item.kind === "message") {
			if (item.invoked) asker = item.author;
			return {
				...base,
				sender: {
					kind: "user",
					value: item.author,
					display: authorName(item.author, people, channels),
				},
				...(item.edited && !item.deleted ? { last_updated: Math.floor(item.edited / 1000) } : {}),
				content: item.deleted ? [text("Message deleted")] : [
					text(item.invoked ? withAgentMention(item.text) : item.text),
					...(item.images || []).map((image) => ({
						type: "image" as const,
						image: `data:${image.mimeType};base64,${image.data}`,
					})),
					// Contents travel in the transcript, not at a URL; the block opens them.
					...(item.files || []).map((file) => ({
						type: "file" as const,
						name: file.name,
						file: "",
						text: file.text,
					})),
				],
			} as Event;
		}
		if (item.kind === "review-commits") {
			const { review, branch, reviewedHead, head, label } = item;
			return {
				...base,
				type: "neuve:review:new-commits",
				review,
				branch,
				reviewedHead,
				head,
				label,
			} as Event;
		}
		// Models narrate before calling tools, so the text introduces the group that follows it.
		const content: Event.Message.Agent["content"] = item.text ? [text(item.text)] : [];
		for (const call of item.tools) {
			content.push(tool(call, busy, reviews, captions[call.call], recaps[call.call]));
		}
		for (const call of item.tools) {
			const name = (reviewTool(call, reviews) ?? planTool(call))?.name ?? call.name;
			if (call.result?.interrupted) {
				content.push(
					text(`The channel restarted while ${name} ran, so it may have partially run.`),
				);
			}
			if (call.result?.handoff) {
				content.push(text(`Stopped ${name} for a message from another channel.`));
			}
		}
		if (item.error) content.push(text(`Run failed: ${item.error}`));
		if (item.stopped) {
			content.push(
				text(
					item.stopper
						? `Stopped by ${authorName(item.stopper, people, channels)}.`
						: "Stopped.",
				),
			);
		}
		if (item.withdrawn) content.push(text(withdrawal(item.withdrawn, people, channels)));
		return {
			...base,
			sender: sender(item.model),
			content,
			// Each reply carries the mode its own run ran in, so earlier replies keep their label.
			...(item.mode === "plan" ? { agent: { mode: "plan" } } : {}),
		} as Event;
	});
	if (!draft.text) return events;
	events.push({
		id: `${topic}::draft`,
		uid: "draft",
		type: "message",
		topic,
		created_at: Math.floor(Date.now() / 1000),
		sender: sender(draft.model),
		content: [text(draft.text)],
		streaming: true,
	} as Event);
	return events;
}
