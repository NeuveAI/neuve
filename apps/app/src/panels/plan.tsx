import { useEffect, useState, useSyncExternalStore } from "react";

import type { PlanComment, PlanCommentsSent, Request } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";
import { NOT_ALLOWED_TO_APPROVE, type PlanCommentActions, type PlanSelection, PlanView } from "@ace/ui";

import { useAgentAvatar } from "../agent-avatar";
import { usePlanReturn } from "../composer-mode";
import { useDetails } from "../details";
import { host } from "../host";
import { planView } from "../plan-card";
import { planCommentViews } from "../plan-comments";

type Props = { channel: Listing; chat: number; user: string; plan?: string };

/** A plan's text as the host read it, for the plan and the listed version it was asked for. */
type Loaded = { plan: string; listed: string; hash?: string; text?: string; error?: string };

const NEWER = "The plan changed; its new version is loading";

/** The chat's plan, at `plan` or its newest, read through the channel since its file is the host's. */
export function Plan({ channel, chat, user, plan }: Props) {
	const { plans, planComments, shared } = useDetails(channel.id);
	const agentAvatar = useAgentAvatar();
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState<string>();
	// Why the last send held some of the person's replies back, as the channel said it.
	const [held, setHeld] = useState<string>();
	// The send the channel answered, until its comments event shows the outcome: the answer can
	// come first, and until then the words still look unsent and must not be offered again.
	const [awaiting, setAwaiting] = useState<{ submission: number; ids: string[]; before: string }>();
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	const list = plans?.chat === chat ? plans.list : undefined;
	// The channel shows one chat's plans; a tab saved for another chat's plan cannot read it here.
	const elsewhere = !!plans && plans.chat !== chat;
	const shown = plan ? list?.find((value) => value.id === plan) : list?.at(-1);
	const [loaded, setLoaded] = useState<Loaded>();
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState<string>();
	const returnFromPlan = usePlanReturn(channel.id, chat);

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
	if (!shown) return <Note>{plan ? "This plan is no longer in the chat." : undefined}</Note>;

	const current = loaded?.plan === shown.id && loaded.listed === shown.hash ? loaded : undefined;
	// While a revision loads, the version read before stays in the pane, so the pane keeps its place.
	const stale = !current && loaded?.plan === shown.id ? loaded : undefined;
	const mayApprove = channel.owner === user || shared !== false;
	const blocked = !mayApprove
		? NOT_ALLOWED_TO_APPROVE
		: stale || (current?.hash && current.hash !== shown.hash)
		? NEWER
		: undefined;

	async function approve() {
		if (!current?.hash) return;
		setApproving(true);
		setError(undefined);
		try {
			await host.channel(channel.id, { op: "plan-approve", chat, author: user, plan: shown!.id, hash: current.hash });
			returnFromPlan();
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setApproving(false);
		}
	}

	// Commenting asks the chat's agent, so it needs what approving needs, on the version read.
	const { send: sendKept, ...actions } = planCommentRequests(
		channel.id,
		chat,
		user,
		shown.id,
		current?.hash === shown.hash ? current.hash : undefined,
	);
	const comments = planComments?.chat === chat ? planComments.list : [];
	const replaced = shown.state === "replaced";
	const sends = planComments?.chat === chat ? planComments.sends ?? [] : [];
	// The event showed this send's submission, or changed one of the comments it carried.
	const settled = !awaiting || sends.includes(awaiting.submission) || carried(comments, awaiting.ids) !== awaiting.before;

	async function send() {
		setSending(true);
		setSendError(undefined);
		setHeld(undefined);
		setAwaiting(undefined);
		// The comments as the person saw them when sending; the answer may come after the event.
		const shownComments = comments;
		try {
			const sent = await sendKept();
			setHeld(sent.keptReplies?.reason);
			setAwaiting({ submission: sent.submission, ids: sent.comments, before: carried(shownComments, sent.comments) });
		} catch (cause) {
			setSendError((cause as Error).message);
		} finally {
			setSending(false);
		}
	}

	return (
		<PlanView
			plan={planView(shown, (author) => author === user ? "you" : people[author] || author)}
			text={(current ?? stale)?.text}
			error={current?.error}
			approve={shown.state === "draft"
				? { onApprove: () => void approve(), approving, blocked, error }
				: undefined}
			comments={{
				list: planCommentViews(comments, shown.id, user, (author) => people[author] || author),
				agentAvatar,
				...(mayApprove && !replaced ? actions : {}),
			}}
			send={mayApprove && !replaced ? { onSend: () => void send(), sending: sending || !settled, error: sendError, note: held } : undefined}
		/>
	);
}

/** The comments a send carried, as the channel last showed them. */
function carried(comments: PlanComment[], ids: string[]) {
	return JSON.stringify(comments.filter((comment) => ids.includes(comment.id)));
}

function Note({ children }: { children?: string }) {
	return (
		<section className="grid h-full min-h-0 place-items-center bg-background px-4 text-center text-sm text-muted-foreground">
			{children}
		</section>
	);
}

/**
 * The channel requests behind the Plan tab's comments. Nothing is shown from their answers: the
 * tab draws what the channel's plan-comments event says.
 */
function planCommentRequests(
	channel: string,
	chat: number,
	author: string,
	plan: string,
	hash: string | undefined,
): Pick<PlanCommentActions, "keep" | "reply" | "edit" | "remove"> & { send: () => Promise<PlanCommentsSent> } {
	const ask = async (request: Request) => {
		await host.channel(channel, request);
	};
	return {
		// Only the version the person read can be commented on.
		keep: hash
			? (selection: PlanSelection, text: string) =>
				ask({ op: "plan-comment", chat, author, plan, hash, lines: selection.lines, quote: selection.quote, text })
			: undefined,
		reply: (comment, text) => ask({ op: "plan-comment-reply", chat, author, comment, text }),
		edit: (comment, reply, text) => ask({ op: "plan-comment-edit", chat, author, comment, reply, text }),
		remove: (comment, reply) => ask({ op: "plan-comment-remove", chat, author, comment, reply }),
		send: () =>
			host.channel<PlanCommentsSent>(channel, { op: "plan-comments-send", chat, author, plan, requestId: crypto.randomUUID() }),
	};
}
