import type { AgentName, QueuedMessage } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";

import { AGENT_ALIAS } from "./agent-mention";
import { reviewNotice } from "./review-card";
import { authorName } from "./timeline";

/** Authors are named as the timeline names them. */
export function MessageQueue({ messages, people, channels, agents, locked }: {
	messages: QueuedMessage[];
	people: Record<string, string>;
	channels: Map<string, Listing>;
	agents?: ReadonlyMap<string, AgentName>;
	/** A build's agent's chat, where every input asks the agent. */
	locked?: boolean;
}) {
	if (!messages.length) return null;
	return (
		<section
			aria-label="Queued messages"
			className="mb-2 overflow-hidden rounded-lg border border-border/60 bg-muted/40 text-xs"
		>
			<div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-muted-foreground">
				<p role="status">
					{messages.length} queued {messages.length === 1 ? "message" : "messages"}
				</p>
				<span>Waiting for the agent</span>
			</div>
			<ol className="max-h-48 overflow-y-auto overscroll-contain divide-y divide-border/60">
				{messages.map((message) => {
					// The host's review wake waits here too; it is Neuve's note to the agent, not a person's.
					if (reviewNotice(message)) {
						return (
							<li key={message.submission} className="px-3 py-2 text-muted-foreground">
								<span className="font-medium">{AGENT_ALIAS.label}</span>{" "}
								will tell the agent the review ended
							</li>
						);
					}
					return (
						<li key={message.submission} className="px-3 py-2">
							<div className="mb-1 flex min-w-0 items-center gap-2 text-muted-foreground">
								<span className="truncate font-medium">
									{message.system ? AGENT_ALIAS.label : authorName(message.author, people, channels, agents)}
								</span>
								{!locked && (
									<span className="shrink-0">{message.invoked ? `@${AGENT_ALIAS.name}` : "Chat"}</span>
								)}
							</div>
							{message.text && (
								<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
									{message.text}
								</p>
							)}
							{message.images && (
								<div className="mt-2 flex flex-wrap gap-2">
									{message.images.map((image, index) => (
										<img
											key={index}
											src={`data:${image.mimeType};base64,${image.data}`}
											alt={`Queued attachment ${index + 1}`}
											className="size-12 rounded-md object-cover"
										/>
									))}
								</div>
							)}
							{message.files && (
								<p className="mt-1 truncate text-muted-foreground">
									{message.files.map((file) => file.name).join(", ")}
								</p>
							)}
						</li>
					);
				})}
			</ol>
		</section>
	);
}
