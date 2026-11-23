import type { ComponentType, CSSProperties } from "react";

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

/** An agent's state as the details sidebar draws a subagent's, with `waiting` for an open question. */
export const AGENT_STATE_ICONS: Record<AgentLineView["state"], [Icon, string]> = {
	running: [IconLoader, "animate-spin text-muted-foreground motion-reduce:animate-none"],
	waiting: [IconHand, "text-warning"],
	done: [IconCircleCheck, "text-success"],
	failed: [IconCircleX, "text-destructive"],
	stopped: [IconCircleDashed, "text-muted-foreground"],
};

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

/** An agent's name and what it says it is doing, isolated so neither can reorder the other. */
export function AgentLabel({ agent }: { agent: Pick<AgentLineView, "name" | "caption"> }) {
	return (
		<>
			<bdi className="max-w-[60%] shrink-0 truncate font-medium text-foreground">{agent.name}</bdi>
			{agent.caption && <bdi className="min-w-0 flex-1 truncate text-muted-foreground">{agent.caption}</bdi>}
		</>
	);
}
