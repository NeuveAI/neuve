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
 * channel's other chats be. A mode chosen in this browser wins; until one is, the chat's stored
 * mode. The per-channel value it replaces is removed, not carried to a chat.
 */
export function useChatMode(channel: string, chat: number, stored: ChatMode | undefined) {
	if (!forgotten.has(channel)) {
		forgotten.add(channel);
		try {
			localStorage.removeItem(`ace:mode:/channels/${channel}`);
		} catch {}
	}
	const [remembered, change] = useLocalStorage<string | null>(
		`ace:mode:/channels/${channel}/${chat}`,
		null,
	);
	return [remembered ?? stored ?? "ace", change] as const;
}
