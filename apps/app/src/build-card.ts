import {
	failureCaption,
	type AgentName,
	type Build,
	type BuildAgent,
	type BuildReview,
	type Chat,
	type ChatId,
	type GithubPull,
	type WorkMessage,
} from "@ace/channel/protocol";
import type { AgentLineView, BuildCardView, DetailsPlan, Event, Mention } from "@ace/ui";

import { AGENT_ALIAS } from "./agent-mention";
import { reviewEntry } from "./review-card";

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const ROLES = { implementer: "Implementer", reviewer: "Reviewer" } as const;

/**
 * The name an agent goes by: its role, and its part where it has one, read short. A part that is a
 * path goes by its last segment, and by as much more of the path as tells it from another agent of
 * the same role among `others`.
 */
export function agentName({ role, part }: AgentName, others: readonly AgentName[] = []): string {
	if (!part) return ROLES[role];
	const parts = others.flatMap((other) => other.role === role && other.part && other.part !== part ? [other.part] : []);
	const segments = part.split("/").filter(Boolean);
	let short = part;
	for (let n = 1; n < segments.length; n++) {
		const tail = segments.slice(-n).join("/");
		if (!parts.some((other) => other === tail || other.endsWith(`/${tail}`))) {
			short = tail;
			break;
		}
	}
	return `${ROLES[role]} · ${short}`;
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
		const line = lineView(agent, build.agents);
		// The text carries the mention's name; its chip reads as the agent's line does.
		return {
			name,
			label: line.name,
			id: String(agent.chat),
			agent: { ...line, ...(shared ? { caption: build.plan.title } : {}) },
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

export function lineView(agent: BuildAgent, others: readonly AgentName[] = []): AgentLineView {
	const caption = agent.state === "failed" && agent.failure ? failureCaption(agent.failure) : agent.caption;
	return {
		chat: agent.chat,
		role: agent.role,
		name: agentName(agent, others),
		...(caption ? { caption } : {}),
		state: agent.state,
	};
}

/**
 * The main agent's line for each chat that planned a build with agents. Where two chats planned,
 * each line carries its chat's newest plan's title, as the mention list tells agents apart.
 */
export function mainLines(builds: Build[], chats: Chat[], avatar: string): AgentLineView[] {
	const planned = new Map<ChatId, string>();
	for (const build of builds) if (build.agents.length) planned.set(build.chat, build.plan.title);
	return [...planned].map(([chat, title]) => ({
		chat,
		name: AGENT_ALIAS.label,
		avatar,
		...(planned.size > 1 ? { caption: title } : {}),
		state: chats.find((value) => value.id === chat)?.busy ? "running" : "done",
	}));
}

const alive = (agent: BuildAgent) => agent.state === "running" || agent.state === "waiting";

/**
 * The plan's newest Neuve review as its card shows it. Once the pull request's head has moved past
 * the reviewed head, the review is stale and no longer counts toward the plan being ready.
 */
function reviewView(review: BuildReview, pull: GithubPull | null | undefined): BuildCardView["review"] {
	// A stopped review, or one whose connection was lost, has nothing on the desk to read.
	const { phase } = review;
	if (phase !== "queued" && phase !== "running" && phase !== "finished") return;
	return {
		phase,
		...(review.humanRequired === undefined ? {} : { humanRequired: review.humanRequired }),
		desk: review.desk && reviewEntry(review.desk) ? review.desk : null,
		stale: !!pull?.sha && pull.sha !== review.head,
	};
}

/**
 * A build's card: the plan's pull request and newest Neuve review, its agents, and a head only
 * where the person must act or is blocked, or once the plan is merged. A build still starting, or
 * a plan delivered to agents already building, has no card: the plan's card turning Approved
 * answers the press, and the card comes with the first agent.
 */
export function buildView(
	build: Build,
	name: (author: string) => string,
	pull?: GithubPull | null,
): BuildCardView | undefined {
	const { state, agents, merged } = build;
	const review = build.review && reviewView(build.review, pull);
	const card =(title?: string, meta?: string, tone?: "error"): BuildCardView => ({
		build: build.id,
		...(title === undefined ? {} : { title }),
		...(meta === undefined ? {} : { meta }),
		...(tone ? { tone } : {}),
		agents: agents.map((agent) => lineView(agent, agents)),
		stoppable: !merged && state.kind !== "stopped" && agents.some(alive),
		...(pull
			? {
				pull: {
					number: pull.number,
					title: pull.title,
					url: pull.url,
					state: pull.state,
					checks: pull.checks,
					conflicts: pull.merge === "conflicts",
				},
			}
			: {}),
		...(review ? { review } : {}),
		// Merge is pinned to the head GitHub has, and only a finished review of that head admits it.
		mergeable: !merged && pull?.state === "open" && pull.merge === "ready" && !!pull.sha
			&& build.review?.phase === "finished" && build.review.head === pull.sha,
	});
	const waiting = agents.some((agent) => agent.state === "waiting");
	if (merged) return card("Merged", `#${merged.number} · ${TIME.format(merged.at)}`);
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

/**
 * The cards of the builds whose plans were approved in chat `chat`, by the call that wrote each
 * plan, each with its branch's pull request from `pulls`.
 */
export function buildCards(
	builds: Build[],
	chat: ChatId,
	name: (author: string) => string,
	pulls: ReadonlyMap<string, GithubPull | null> = new Map(),
) {
	return new Map(
		builds.flatMap((build) => {
			const view = build.chat === chat && buildView(build, name, build.branch ? pulls.get(build.branch) : undefined);
			return view ? [[build.plan.call, view] as const] : [];
		}),
	);
}

/**
 * The channel's approved plans for its details, newest first: each plan's newest build, since a
 * revision of a plan is a build of its own, with its branch's pull request from `pulls`.
 */
export function planDetails(builds: Build[], pulls: ReadonlyMap<string, GithubPull | null>): DetailsPlan[] {
	const newest = new Map<string, Build>();
	for (const build of builds) {
		const kept = newest.get(build.plan.id);
		if (!kept || kept.approved.at < build.approved.at) newest.set(build.plan.id, build);
	}
	return [...newest.values()].toSorted((a, b) => b.approved.at - a.approved.at).map((build) => {
		const pull = build.branch ? pulls.get(build.branch) : undefined;
		const { review } = build;
		return {
			id: build.plan.id,
			title: build.plan.title,
			...(build.branch ? { branch: build.branch } : {}),
			...(pull ? { pull } : {}),
			...(review?.phase === "finished" && review.humanRequired !== undefined
				? {
					review: {
						humanRequired: review.humanRequired,
						desk: review.desk && reviewEntry(review.desk) ? review.desk : null,
					},
				}
				: {}),
		};
	});
}

/** The repository and branch of every build, whose pull requests the card and the details read. */
export function buildBranches(builds: Build[], repo: string | undefined): [string, string][] {
	return repo ? builds.flatMap((build) => build.branch ? [[repo, build.branch] as [string, string]] : []) : [];
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
		const recipient = agents.get(message.to);
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
				display: from ? agentName(from.agent, from.build.agents) : AGENT_ALIAS.label,
				...(to ? { credit: `to ${agentName(to.agent, to.build.agents)}` } : {}),
			},
			// Agents' talk names no one by text: no `@name` in it is drawn as a mention.
			content: [{ type: "text", text: message.text, parts: [] }],
		} as Event];
	});
}
