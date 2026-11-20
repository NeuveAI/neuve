import type { ChatMode } from "@ace/channel/protocol";

/** A mode chosen in this browser wins; until one is, the chat's stored mode, then the agent's. */
export function composerMode(remembered: string | null, stored: ChatMode | undefined): string {
	return remembered ?? stored ?? "ace";
}

/** Remembered per chat, so a composer left on Plan in one chat leaves its channel's other chats be. */
export function modeKey(channel: string, chat: number): string {
	return `ace:mode:/channels/${channel}/${chat}`;
}

/** The mode used to be remembered per channel; that value is dropped, not carried to a chat. */
export function forgetChannelMode(channel: string, storage?: Pick<Storage, "removeItem">) {
	try {
		(storage ?? localStorage).removeItem(`ace:mode:/channels/${channel}`);
	} catch {}
}
