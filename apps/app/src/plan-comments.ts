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

/**
 * The person's words in each send of plan comments, by its submission, with the chat entry it
 * became once placed: each under the passage it is on.
 */
export function commentSends(comments: PlanComment[]): Map<number, { entry?: number; text: string }> {
	const sends = new Map<number, { entry?: number; said: { at: number; quote: string; text: string }[] }>();
	for (const comment of comments) {
		for (const { sent, at, text } of [comment, ...comment.replies.filter((reply) => reply.kind === "person")]) {
			if (!sent) continue;
			const send = sends.get(sent.submission) ?? { entry: sent.entry, said: [] };
			send.said.push({ at, quote: comment.anchor.quote, text });
			sends.set(sent.submission, send);
		}
	}
	return new Map([...sends].map(([submission, { entry, said }]) => [submission, {
		entry,
		text: said.sort((a, b) => a.at - b.at).map(({ quote, text }) => `${quoted(quote)}\n\n${text}`).join("\n\n"),
	}]));
}

/** A passage's plain words as a Markdown quotation, its marks kept as written. */
function quoted(passage: string) {
	return passage.split("\n").map((line) => `> ${line.replace(/[\\`*_[\]<>#|~]/g, "\\$&")}`).join("\n");
}
