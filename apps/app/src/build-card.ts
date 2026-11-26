import type { AgentFailure, AgentName, Build, BuildAgent, Chat, ChatId, WorkMessage } from "@ace/channel/protocol";
import type { AgentLineView, BuildCardView, Event, Mention } from "@ace/ui";

import { AGENT_ALIAS } from "./agent-mention";

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const ROLES = { implementer: "Implementer", reviewer: "Reviewer" } as const;

/** The name an agent goes by in its build: its role, and its part where it has one. */
export function agentName({ role, part }: AgentName): string {
	return part ? `${ROLES[role]} · ${part}` : ROLES[role];
}

/** An agent's name as a mention token: its role, and its part where it has one. */
export function mentionName({ role, part }: AgentName): string {
	return part ? `${role}-${part.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}` : role;
}

/**
 * The agents a person can mention: those of each planning chat's newest build that has agents,
 * whatever their state, since a mention restarts a stopped one. Where two share a name, the plan's
 * title tells them apart.
 */
export function mentionable(builds: Build[]): Mention[] {
	const newest = new Map<ChatId, Build>();
	for (const build of builds) {
		const kept = newest.get(build.chat);
		if (build.agents.length && (!kept || kept.approved.at < build.approved.at)) newest.set(build.chat, build);
	}
	const agents = [...newest.values()].flatMap((build) =>
		build.agents.map((agent) => ({ build, agent, name: mentionName(agent) }))
	);
	return agents.map(({ build, agent, name }) => {
		const shared = agents.filter((other) => other.name === name).length > 1;
		return {
			name,
			id: String(agent.chat),
			agent: { ...lineView(agent), ...(shared ? { caption: build.plan.title } : {}) },
		};
	});
}

/** The author an agent's messages to another agent carry. */
export function agentAuthor(chat: ChatId): string {
	return `agent@${chat}`;
}

/** Every build's agents by the author their messages carry; any other author is not a build's agent. */
export function agentAuthors(builds: Build[]): Map<string, BuildAgent> {
	return new Map(builds.flatMap((build) => build.agents.map((agent) => [agentAuthor(agent.chat), agent])));
}

/**
 * Whether chat `id` is one a build's agent works in, which people read and do not write in. The
 * chat's own record says so once `info` is read; the pushed builds say so before it is.
 */
export function readOnly(id: ChatId, chat: Chat | undefined, builds: Build[]): boolean {
	return !!chat?.build || builds.some((build) => build.agents.some((agent) => agent.chat === id));
}

/** Why a failed agent stopped, in place of the caption its last work left. */
function failureCaption({ reason, attempts }: AgentFailure): string {
	switch (reason) {
		case "retry-budget-exhausted":
			return `Failed after ${attempts} attempts`;
		case "ambiguous-tool-effect":
			return "Stopped: a tool may have run without a recorded result";
		case "unsafe-continuation":
			return "Failed: the turn couldn't resume safely";
		case "no_model":
			return "Failed: no model to run on";
		default:
			return "Failed without an answer";
	}
}

export function lineView(agent: BuildAgent): AgentLineView {
	const caption = agent.state === "failed" && agent.failure ? failureCaption(agent.failure) : agent.caption;
	return {
		chat: agent.chat,
		role: agent.role,
		name: agentName(agent),
		...(caption ? { caption } : {}),
		state: agent.state,
	};
}

const alive = (agent: BuildAgent) => agent.state === "running" || agent.state === "waiting";

/**
 * A build's card: its agents, and a head only where the person must act or is blocked. A build
 * still starting, or a plan delivered to agents already building, has no card: the plan's card
 * turning Approved answers the press, and the card comes with the first agent.
 */
export function buildView(build: Build, name: (author: string) => string): BuildCardView | undefined {
	const { state, agents } = build;
	const card = (title?: string, meta?: string, tone?: "error"): BuildCardView => ({
		build: build.id,
		...(title === undefined ? {} : { title }),
		...(meta === undefined ? {} : { meta }),
		...(tone ? { tone } : {}),
		agents: agents.map(lineView),
		stoppable: state.kind !== "stopped" && agents.some(alive),
	});
	const waiting = agents.some((agent) => agent.state === "waiting");
	switch (state.kind) {
		case "starting":
		case "delivered":
			return;
		case "started":
			return card(waiting ? "Waiting for an answer" : undefined);
		case "unavailable":
			return card(
				"Not started",
				state.reason === "shared"
					? "Other people can ask this channel's agents"
					: "Agents don't start in a hosted or cloud channel",
			);
		case "paused":
			return card(
				waiting ? "Paused, waiting for an answer" : "Paused",
				"Other people can now ask this channel's agents",
			);
		case "stopped":
			return card("Stopped", `${name(state.by)} · ${TIME.format(state.at)}`);
		case "failed":
			return card("Could not start", state.detail, "error");
	}
}

/** The cards of the builds whose plans were approved in chat `chat`, by the call that wrote each plan. */
export function buildCards(builds: Build[], chat: ChatId, name: (author: string) => string) {
	return new Map(
		builds.flatMap((build) => {
			const view = build.chat === chat && buildView(build, name);
			return view ? [[build.plan.call, view] as const] : [];
		}),
	);
}

/**
 * What the agents said to each other, drawn as chat messages under each sender's role. The chat
 * that drafted a plan writes as Neuve and names its recipient; between agents the recipient is
 * named only where a build has more than two agents.
 */
export function workEvents(builds: Build[], messages: WorkMessage[], topic: string): Event[] {
	const agents = new Map(builds.flatMap((build) => build.agents.map((agent) => [agent.chat, { agent, build }])));
	const planners = new Set(builds.map((build) => build.chat));
	return messages.flatMap((message, index) => {
		const from = agents.get(message.from);
		if (!from && !planners.has(message.from)) return [];
		const recipient = agents.get(message.to)?.agent;
		const to = (!from || from.build.agents.length > 2) && recipient;
		return [{
			id: `${topic}::work:${index}`,
			uid: `work:${index}`,
			type: "message",
			topic,
			created_at: Math.floor(message.at / 1000),
			sender: {
				kind: "user",
				value: agentAuthor(message.from),
				display: from ? agentName(from.agent) : AGENT_ALIAS.label,
				...(to ? { credit: `to ${agentName(to)}` } : {}),
			},
			// Agents' talk names no one by text: no `@name` in it is drawn as a mention.
			content: [{ type: "text", text: message.text, parts: [] }],
		} as Event];
	});
}
