import { type ComponentType, createContext, type CSSProperties, type ReactNode, use } from "react";

import {
	IconCircleCheck,
	IconCircleDashed,
	IconCircleX,
	IconCode,
	IconEye,
	IconHand,
	IconLoader,
} from "../../icons";
import { cn } from "../../lib/utils";
import type { AgentLineView, AgentRole } from "../../types";

type Icon = ComponentType<{ className?: string }>;

/**
 * A build's agent's state, with `waiting` for an open question. Its run ends `done` after every
 * exchange, which says nothing of the work, so it is muted.
 */
export const AGENT_STATE_ICONS: Record<AgentLineView["state"], [Icon, string]> = {
	running: [IconLoader, "animate-spin text-muted-foreground motion-reduce:animate-none"],
	waiting: [IconHand, "text-warning"],
	done: [IconCircleCheck, "text-muted-foreground"],
	failed: [IconCircleX, "text-destructive"],
	stopped: [IconCircleDashed, "text-muted-foreground"],
};

/** A subagent's `done` is the answer its call returned, so it keeps the success tone. */
export const SUBAGENT_STATE_ICONS = { ...AGENT_STATE_ICONS, done: [IconCircleCheck, "text-success"] } satisfies typeof AGENT_STATE_ICONS;

export function AgentStateIcon({ state }: { state: AgentLineView["state"] }) {
	const [Icon, color] = AGENT_STATE_ICONS[state];
	return (
		<span className="inline-flex shrink-0" role="img" aria-label={state}>
			<Icon className={cn("size-3.5", color)} aria-hidden />
		</span>
	);
}

const ROLES: Record<AgentRole, Icon> = { implementer: IconCode, reviewer: IconEye };

/** A role's avatar, in the tone of a person's initials, which an agent's messages carry instead. */
export function RoleAvatar(
	{ role, size, className, style }: { role: AgentRole; size: number; className?: string; style?: CSSProperties },
) {
	const Icon = ROLES[role];
	return (
		<span
			aria-hidden
			className={cn("grid shrink-0 place-items-center rounded-full bg-muted text-muted-foreground", className)}
			style={{ inlineSize: size, blockSize: size, ...style }}
		>
			<Icon className="size-[55%]" />
		</span>
	);
}

/**
 * An agent's name and what it says it is doing, isolated so neither can reorder the other. Both
 * truncate before the line's model and effort, which always show in full.
 */
function AgentLabel({ agent }: { agent: Pick<AgentLineView, "name" | "caption"> }) {
	return (
		<>
			<bdi className="min-w-0 max-w-[60%] truncate font-medium text-foreground">{agent.name}</bdi>
			{agent.caption && <bdi className="min-w-0 flex-1 truncate text-muted-foreground">{agent.caption}</bdi>}
		</>
	);
}

/**
 * The model and effort an agent's chat runs on, as the app draws them on its line; `plain` where
 * the line is itself a control, as in the mention list.
 */
const AgentModelContext = createContext<((chat: number, plain?: boolean) => ReactNode) | null>(null);
export const AgentModelProvider = AgentModelContext.Provider;

/** An agent's line, the same wherever it is listed: the work log, the build's card and the mention list. */
export function AgentLine({ agent, plain }: { agent: AgentLineView; plain?: boolean }) {
	let model = use(AgentModelContext);
	return (
		<>
			{agent.role
				? <RoleAvatar role={agent.role} size={20} />
				: <img className="size-5 shrink-0 rounded-full object-cover" src={agent.avatar} alt="" />}
			<AgentLabel agent={agent} />
			<span className="ml-auto flex shrink-0 items-center gap-1.5">
				{model?.(agent.chat, plain)}
				<AgentStateIcon state={agent.state} />
			</span>
		</>
	);
}
