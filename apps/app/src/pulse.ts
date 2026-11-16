import type { ReviewNotice, RunEnd } from "@ace/channel/protocol";
import { isInactive, type Listing, type People, type Presence } from "@ace/host/protocol";

import { present } from "./presence";
import { reviewNotice } from "./review-card";

/**
 * A teammate by GitHub login where known; `here` is unset while they have nothing open. `neuve`
 * marks the row for runs Neuve's review wake started, which no person asked for.
 */
export type Teammate = {
	login: string;
	neuve?: true;
	here?: "here" | "away";
	active: Listing[];
	finished: Listing[];
	failed: Listing[];
};

const ACTIVE = 3;

/** The name Neuve's row shows; `neuve`, not this name, keeps it apart from a person's. */
const NEUVE = "Neuve";

/** A run's end, with the host's mark when its review wake started it. */
type Ran = RunEnd & { system?: ReviewNotice };

/**
 * Deterministic team pulse from listings and the lobby: who is here, their active channels, and
 * runs they asked for that ended after `since`, in anyone's channel. Teammates with none of these
 * are left out. Runs Neuve's review wake started go to one Neuve row, after everyone else's.
 */
export function pulse(
	channels: Listing[],
	presence: Presence[] | undefined,
	people: People,
	user: string,
	since: number,
	now: number,
): Teammate[] {
	const team = new Map<string, Teammate>();
	const get = (login: string) => {
		let value = team.get(login);
		if (!value) {
			value = { login, active: [], finished: [], failed: [] };
			team.set(login, value);
		}
		return value;
	};
	let neuve: Teammate | undefined;
	for (const member of present(presence, people[user])) {
		get(member.id).here = member.away ? "away" : "here";
	}
	const latest = (channel: Listing) => channel.active || channel.created;
	for (const channel of [...channels].sort((a, b) => latest(b) - latest(a))) {
		const live = channel.state !== "archived" && !isInactive(channel, now);
		if (live && channel.owner !== user) {
			const owner = get(people[channel.owner] || channel.owner);
			if (owner.active.length < ACTIVE) owner.active.push(channel);
		}
		// A run ended belongs to whoever asked for it, which may be a guest in someone else's channel.
		const ran = channel.ran as Ran | undefined;
		if (!ran || ran.at <= since) continue;
		// The host's mark, never the author, says Neuve's review wake started the run.
		if (reviewNotice(ran)) {
			if (ran.outcome !== "done" && ran.outcome !== "failed") continue;
			neuve ??= { login: NEUVE, neuve: true, active: [], finished: [], failed: [] };
			neuve[ran.outcome === "done" ? "finished" : "failed"].push(channel);
			continue;
		}
		if (ran.author === user) continue;
		if (ran.outcome === "done") get(people[ran.author] || ran.author).finished.push(channel);
		if (ran.outcome === "failed") get(people[ran.author] || ran.author).failed.push(channel);
	}
	const order = { here: 0, away: 1 };
	const rows = [...team.values()].sort((a, b) =>
		(a.here ? order[a.here] : 2) - (b.here ? order[b.here] : 2) || a.login.localeCompare(b.login)
	);
	return neuve ? [...rows, neuve] : rows;
}
