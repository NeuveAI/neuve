import { useSyncExternalStore } from "react";

import { useLocalStorage } from "@ace/ui";
import type { ChatMode } from "@ace/channel/protocol";

/** The composer modes whose messages are for the chat's agent. */
export function agentMode(mode: string): ChatMode | undefined {
	return mode === "plan" || mode === "ace" ? mode : undefined;
}

/**
 * The mode an ask carries: only one that changes the chat's stored mode, so a message in the mode
 * the chat already has is the plain ask the channel has always taken. A Chat message carries none.
 */
export function askMode(mode: string, stored: ChatMode | undefined): ChatMode | undefined {
	const asked = agentMode(mode);
	return asked && asked !== (stored ?? "ace") ? asked : undefined;
}

const forgotten = new Set<string>();
type Selection = { mode: string; revision: number };
const selections = new Map<string, Selection>();
const effective = new Map<string, string>();
const listeners = new Set<() => void>();
const scopeOf = (channel: string, chat: number) => `/channels/${channel}/${chat}`;
const modeKey = (scope: string) => `ace:mode:${scope}`;
const returnKey = (scope: string) => `ace:plan-return:${scope}`;
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
};
function read(key: string): unknown {
	try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function save(key: string, value: string) {
	try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function select(scope: string, mode: string) {
	selections.set(scope, { mode, revision: (selections.get(scope)?.revision ?? 0) + 1 });
	effective.set(scope, mode);
	for (const listener of listeners) listener();
}

/** Capture at the explicit approval action, never on a plan event or a reconnect. */
export function beginPlanApproval(channel: string, chat: number) {
	const scope = scopeOf(channel, chat);
	const revision = selections.get(scope)?.revision ?? 0;
	const mode = effective.get(scope) ?? read(modeKey(scope));
	const saved = read(returnKey(scope));
	const returning = saved === "chat" ? "chat" : "ace";
	let completed = false;
	return () => {
		if (completed) return;
		completed = true;
		if (mode !== "plan" || (selections.get(scope)?.revision ?? 0) !== revision) return;
		save(modeKey(scope), returning);
		select(scope, returning);
	};
}

/** Browser-local choice and pre-Plan return mode, isolated per channel and chat. */
export function useChatMode(channel: string, chat: number, stored: ChatMode | undefined) {
	if (!forgotten.has(channel)) {
		forgotten.add(channel);
		try { localStorage.removeItem(`ace:mode:/channels/${channel}`); } catch {}
	}
	const scope = scopeOf(channel, chat);
	const [remembered, remember] = useLocalStorage<string | null>(modeKey(scope), null);
	const selection = useSyncExternalStore(subscribe, () => selections.get(scope), () => undefined);
	const mode = selection?.mode ?? remembered ?? stored ?? "ace";
	effective.set(scope, mode);
	const change = (next: string, chosen = false) => {
		if (!chosen && stored === undefined) return;
		const previous = effective.get(scope) ?? mode;
		if (next === "plan" && previous !== "plan") save(returnKey(scope), previous === "chat" ? "chat" : "ace");
		if (chosen) remember(next);
		// Temporary draft and keyboard changes remain temporary, but their return choice is durable.
		select(scope, next);
	};
	return [mode, change] as const;
}
