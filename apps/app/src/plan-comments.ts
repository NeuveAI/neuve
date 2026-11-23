import type { PlanComment } from "@ace/channel/protocol";
import type { PlanCommentMessageView, PlanCommentView } from "@ace/ui";

import { AGENT_ALIAS } from "./agent-mention";

/** A plan's comments as the Plan tab shows them, for the person `user`; `name` gives a person's name. */
export function planCommentViews(
	comments: PlanComment[],
	plan: string,
	user: string,
	name: (author: string) => string,
): PlanCommentView[] {
	const person = (id: string, author: string, text: string, sent: unknown): PlanCommentMessageView => ({
		id,
		agent: false,
		name: name(author),
		initial: (name(author).trim()[0] ?? "?").toUpperCase(),
		text,
		kept: !sent,
		mine: author === user,
	});
	return comments.filter((comment) => comment.plan === plan).map((comment) => ({
		id: comment.id,
		placement: comment.placement,
		quote: comment.anchor.quote,
		section: comment.anchor.section,
		state: comment.state,
		failure: comment.failure,
		messages: [
			person(comment.id, comment.author, comment.text, comment.sent),
			...comment.replies.map((reply) =>
				reply.kind === "agent"
					? { id: reply.id, agent: true, name: AGENT_ALIAS.label, initial: "N", text: reply.text, kept: false, mine: false }
					: person(reply.id, reply.author, reply.text, reply.sent)
			),
		],
	}));
}

export type Said = { quote: string; text: string };

/** Each send of plan comments by its submission, with the chat entry it became once placed. */
export function commentSends(comments: PlanComment[]): Map<number, { entry?: number; said: Said[] }> {
	const sends = new Map<number, { entry?: number; said: (Said & { at: number })[] }>();
	for (const comment of comments) {
		for (const { sent, at, text } of [comment, ...comment.replies.filter((reply) => reply.kind === "person")]) {
			if (!sent) continue;
			const send = sends.get(sent.submission) ?? { entry: sent.entry, said: [] };
			send.said.push({ at, quote: comment.anchor.quote, text });
			sends.set(sent.submission, send);
		}
	}
	for (const send of sends.values()) send.said.sort((a, b) => a.at - b.at);
	return sends;
}

/** The words of a send, each under its passage quoted; as Markdown, the passage's marks are escaped. */
export function commentWords(said: Said[], markdown = false) {
	const line = (text: string) => `> ${markdown ? text.replace(/[\\`*_[\]<>#|~]/g, "\\$&") : text}`;
	return said.map(({ quote, text }) => `${quote.split("\n").map(line).join("\n")}\n\n${text}`).join("\n\n");
}
