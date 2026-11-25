import { useCallback, useState } from "react";

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

/**
 * The composer's mode, remembered per chat so a composer left on Plan in one chat leaves its
 * channel's other chats be. Only a person's choice in the mode menu is remembered; a mode the
 * draft or a key moved to lasts while the chat is open. Until the chat's stored mode is known
 * (`stored` undefined), nothing but a choice moves the mode, so a planning chat opens in Plan.
 * The per-channel value it replaces is removed, not carried to a chat. Only the menu enters Plan,
 * and the mode it left is kept as the one approving the plan returns to.
 */
export function useChatMode(channel: string, chat: number, stored: ChatMode | undefined) {
	if (!forgotten.has(channel)) {
		forgotten.add(channel);
		try {
			localStorage.removeItem(`ace:mode:/channels/${channel}`);
		} catch {}
	}
	const scope = `/channels/${channel}/${chat}`;
	const [remembered, remember] = useLocalStorage<string | null>(`ace:mode:${scope}`, null);
	const [, rememberReturn] = useLocalStorage<string | null>(`ace:plan-return:${scope}`, null);
	const [moved, move] = useState<{ scope: string; mode: string }>();
	const mode = (moved?.scope === scope ? moved.mode : undefined) ?? remembered ?? stored ?? "ace";
	const change = (next: string, chosen = false) => {
		if (next === "plan" && mode !== "plan") rememberReturn(mode);
		if (chosen) {
			remember(next);
			move(undefined);
		} else if (stored !== undefined) move({ scope, mode: next });
	};
	return [mode, change] as const;
}

/**
 * Returns this browser's composer to the mode it had before Plan, once the person's approval of
 * the chat's plan succeeds. A composer the person has since moved out of Plan is left as it is.
 */
export function usePlanReturn(channel: string, chat: number) {
	const scope = `/channels/${channel}/${chat}`;
	const [, remember] = useLocalStorage<string | null>(`ace:mode:${scope}`, null);
	const [before] = useLocalStorage<string | null>(`ace:plan-return:${scope}`, null);
	return useCallback(
		() => remember((mode) => (mode === null || mode === "plan" ? (before === "chat" ? "chat" : "ace") : mode)),
		[remember, before],
	);
}
