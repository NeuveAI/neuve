import { host } from "./host";

/**
 * Asks the channel to approve this version of a plan. The answer is not read: a card and the
 * Plan tab show Approved only once the channel's plans event says so.
 */
export async function approvePlan(channel: string, chat: number, author: string, plan: string, hash: string) {
	await host.channel(channel, { op: "plan-approve", chat, author, plan, hash });
}
