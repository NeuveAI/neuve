import { useEffect, useState, useSyncExternalStore } from "react";

import type { Listing } from "@ace/host/protocol";
import { NOT_ALLOWED_TO_APPROVE, PlanView } from "@ace/ui";

import { useDetails } from "../details";
import { host } from "../host";
import { approvePlan } from "../plan-approve";
import { planView } from "../plan-card";

type Props = { channel: Listing; chat: number; user: string; plan?: string };

/** A plan's text as the host read it, for the plan and the listed version it was asked for. */
type Loaded = { plan: string; listed: string; hash?: string; text?: string; error?: string };

const NEWER = "The plan changed; its new version is loading";

/** The chat's plan, at `plan` or its newest, read through the channel since its file is the host's. */
export function Plan({ channel, chat, user, plan }: Props) {
	const { plans, shared } = useDetails(channel.id);
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	const list = plans?.chat === chat ? plans.list : undefined;
	// The channel shows one chat's plans; a tab saved for another chat's plan cannot read it here.
	const elsewhere = !!plans && plans.chat !== chat;
	const shown = plan ? list?.find((value) => value.id === plan) : list?.at(-1);
	const [loaded, setLoaded] = useState<Loaded>();
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState<string>();

	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const id = shown?.id;
	const listed = shown?.hash;
	// Read again once the host is back; a dropped connection isn't the plan's failure.
	useEffect(() => {
		if (!id || !listed || status !== "open") return;
		let live = true;
		setError(undefined);
		host.channel<{ hash: string; text: string }>(channel.id, { op: "plan", chat, plan: id }).then(
			(value) => live && setLoaded({ plan: id, listed, hash: value.hash, text: value.text }),
			(cause: Error) =>
				live && host.status === "open" && setLoaded({ plan: id, listed, error: cause.message }),
		);
		return () => void (live = false);
	}, [channel.id, chat, id, listed, status]);

	if (elsewhere) return <Note>This plan belongs to another chat.</Note>;
	if (!list) return <Note>Loading the plan…</Note>;
	if (!shown) return <Note>{plan ? "This plan is no longer in the chat." : "No plan in this chat yet."}</Note>;

	const current = loaded?.plan === shown.id && loaded.listed === shown.hash ? loaded : undefined;
	const mayApprove = channel.owner === user || shared !== false;
	const blocked = !mayApprove
		? NOT_ALLOWED_TO_APPROVE
		: current?.error
		? `The plan could not be read: ${current.error}`
		: !current?.hash
		? "The plan is loading"
		: current.hash !== shown.hash
		? NEWER
		: undefined;

	async function approve() {
		if (!current?.hash) return;
		setApproving(true);
		setError(undefined);
		try {
			await approvePlan(channel.id, chat, user, shown!.id, current.hash);
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setApproving(false);
		}
	}

	return (
		<PlanView
			plan={planView(shown, (author) => author === user ? "you" : people[author] || author)}
			text={current?.text}
			error={current?.error}
			approve={shown.state === "draft"
				? { onApprove: () => void approve(), approving, blocked, error }
				: undefined}
		/>
	);
}

function Note({ children }: { children: string }) {
	return (
		<section className="grid h-full min-h-0 place-items-center bg-background px-4 text-center text-sm text-muted-foreground">
			{children}
		</section>
	);
}
