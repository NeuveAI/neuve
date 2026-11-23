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
