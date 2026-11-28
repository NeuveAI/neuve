import { useMemo, useSyncExternalStore } from "react";

import type { Listing } from "@ace/host/protocol";

import { Approval } from "./approval";
import { approvalView } from "./approval-card";
import { host } from "./host";
import { pendingQuestion, Question } from "./question";
import { useTranscript } from "./transcript";

/**
 * The question or permission requests a plan's agent waits on, in the chat that planned it. They
 * are the agent's own chat's, answered there as on the work log, so there is one answer for both.
 */
export function AgentAsks({ channel, chat, name, user, mayAnswer }: {
	channel: Listing;
	/** The waiting agent's chat. */
	chat: number;
	/** The name the agent goes by. */
	name: string;
	user: string;
	mayAnswer: boolean;
}) {
	const placement = channel.hosted || channel.host;
	const transcript = useTranscript(
		channel.id,
		chat,
		channel.state === "offline",
		channel.moving ? `${placement} → ${channel.moving}` : placement,
	);
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	const reply = transcript.items.findLast((item) => item.kind === "reply");
	const question = reply?.kind === "reply" && pendingQuestion(reply.tools, transcript.busy);
	const approvals = useMemo(
		() =>
			transcript.approvals.flatMap((request) =>
				request.state.kind === "open"
					? [approvalView(request, (author) => author === user ? "you" : people[author] || author)]
					: []
			),
		[transcript.approvals, user, people],
	);
	if (!transcript.live) return null;
	return (
		<>
			{question && (
				<Question
					key={question.call}
					channel={channel}
					chat={chat}
					call={question}
					user={user}
					mayAnswer={mayAnswer}
					requester={name}
				/>
			)}
			{approvals.length > 0 && (
				<div className="max-h-[60vh] overflow-y-auto">
					{approvals.map((view) => (
						<Approval
							key={view.request}
							channel={channel.id}
							chat={chat}
							user={user}
							view={view}
							mayAnswer={mayAnswer}
							requester={name}
						/>
					))}
				</div>
			)}
		</>
	);
}
