import { useMemo } from "react";

import type { Listing } from "@ace/host/protocol";
import { AgentLabel, AgentStateIcon, RoleAvatar, Timeline } from "@ace/ui";

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

/** The channel's work log: its build agents, one line each, then their conversation or one agent's own work. */
export function WorkLog({ channel, channels, user, chat, onChat, onOpen }: Props) {
	const { builds } = useDetails(channel.id);
	const list = builds?.list ?? [];
	const agents = list.flatMap((build) => build.agents);
	const chosen = agents.find((agent) => agent.chat === chat);
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
					{agents.map((agent) => {
						const line = lineView(agent);
						const on = agent.chat === chosen?.chat;
						return (
							<li key={agent.chat}>
								<button
									type="button"
									aria-pressed={on}
									className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md squircle px-2 text-left text-xs outline-none transition-colors duration-120 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring/50 aria-pressed:bg-muted motion-reduce:transition-none"
									onClick={() => onChat(on ? undefined : agent.chat)}
								>
									<RoleAvatar role={agent.role} size={20} />
									<AgentLabel agent={line} />
									<span className="ml-auto flex shrink-0">
										<AgentStateIcon state={agent.state} />
									</span>
								</button>
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
