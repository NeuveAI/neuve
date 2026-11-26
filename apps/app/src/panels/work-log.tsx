import { useMemo } from "react";

import type { Listing } from "@ace/host/protocol";
import { type AgentLineView, AgentLine, Timeline } from "@ace/ui";

import { AGENT_ALIAS } from "../agent-mention";
import { useAgentAvatar } from "../agent-avatar";
import { agentAuthor, lineView, workEvents } from "../build-card";
import { Conversation } from "../conversation";
import { useDetails } from "../details";

type Props = {
	channel: Listing;
	channels: Listing[];
	user: string;
	/** The agent whose own chat is shown; none shows what the agents said to each other. */
	chat?: number;
	onChat: (chat?: number) => void;
	onOpen: (channel: Listing) => void;
};

const NOTHING = () => {};

/**
 * The channel's work log: one line for the main agent of each chat that planned, and one for each
 * of its builds' agents, then their conversation or one agent's own work.
 */
export function WorkLog({ channel, channels, user, chat, onChat, onOpen }: Props) {
	const { builds, info } = useDetails(channel.id);
	const avatar = useAgentAvatar();
	const list = builds?.list ?? [];
	const agents = list.flatMap((build) => build.agents);
	const lines: AgentLineView[] = [
		...new Set(list.filter((build) => build.agents.length).map((build) => build.chat)),
	].map((planner): AgentLineView => ({
		chat: planner,
		name: AGENT_ALIAS.label,
		avatar,
		state: info?.chats.find((value) => value.id === planner)?.busy ? "running" : "done",
	})).concat(agents.map(lineView));
	const chosen = lines.find((line) => line.chat === chat);
	const events = useMemo(
		() => workEvents(builds?.list ?? [], builds?.messages ?? [], channel.id),
		[builds, channel.id],
	);
	const roles = useMemo(
		() => Object.fromEntries(agents.map((agent) => [agentAuthor(agent.chat), agent.role])),
		[builds],
	);
	return (
		<section className="flex h-full min-h-0 flex-col bg-background">
			{agents.length > 0 && (
				<ul aria-label="Agents" className="flex shrink-0 flex-col gap-0.5 border-b border-border px-2 py-1.5">
					{lines.map((line) => {
						const on = line.chat === chosen?.chat;
						// The row is the button, laid under the line so the line's model picker stays its own control.
						return (
							<li
								key={line.chat}
								className={`relative flex h-7 w-full min-w-0 items-center gap-2 rounded-lg squircle border border-transparent bg-clip-padding px-2 text-xs transition-colors duration-120 motion-reduce:transition-none ${
									on ? "bg-popover/35 selected-surface dark:bg-black/32" : "hover:bg-muted/60"
								}`}
							>
								<button
									type="button"
									aria-pressed={on}
									aria-label={line.name}
									className="absolute inset-0 rounded-[inherit] outline-none focus-visible:outline-2 focus-visible:outline-ring/50"
									onClick={() => onChat(on ? undefined : line.chat)}
								/>
								<AgentLine agent={line} />
							</li>
						);
					})}
				</ul>
			)}
			<div className="flex min-h-0 flex-1 flex-col">
				{chosen
					? (
						<Conversation
							key={chosen.chat}
							channel={channel}
							channels={channels}
							chat={chosen.chat}
							user={user}
							onDraftLoaded={NOTHING}
							onOpen={onOpen}
							beside
						/>
					)
					: (
						<Timeline
							className="h-full min-h-0 contain-paint scroll-fade [--fade:3rem]"
							events={events}
							currentUser={{ login: user, own: [user] }}
							toolbar={false}
							roles={roles}
						/>
					)}
			</div>
		</section>
	);
}
