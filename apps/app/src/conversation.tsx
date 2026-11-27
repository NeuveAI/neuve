import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { MENTION } from "@ace/channel/protocol";
import {
	BuildActionsProvider,
	Button,
	ChatStatus,
	PlanActionsProvider,
	ReviewActionsProvider,
	Timeline,
	toast,
} from "@ace/ui";
import { channelProject, type Listing } from "@ace/host/protocol";

import { origin } from "./address";
import { useAgentAvatar } from "./agent-avatar";
import { Approval } from "./approval";
import { approvalView, shownApprovals } from "./approval-card";
import { isAgentAlias } from "./agent-mention";
import { agentAuthor, agentAuthors, agentName, buildCards, mentionName, readOnly } from "./build-card";
import { Checks } from "./checks";
import { Composer } from "./composer";
import { usePlanReturn } from "./composer-mode";
import { DeleteMessage } from "./delete-message";
import { desktop } from "./desktop";
import { EditMessage } from "./edit-message";
import { publish, useDetails } from "./details";
import { host } from "./host";
import { MessageQueue } from "./message-queue";
import { OfflineHost, useRoster } from "./onboarding";
import { present } from "./presence";
import { planCards } from "./plan-card";
import { commentSends, commentWords } from "./plan-comments";
import { pendingQuestion, Question } from "./question";
import { newestReview, reviewActions, reviewTab, withCards } from "./review-card";
import { AGENT, credit, sources, toEvents } from "./timeline";
import { type TurnRetry, useTranscript, useTyping } from "./transcript";
import { Usage } from "./usage";

const stopped = (who: string) => `${who} isn't responding. The chat continues when it answers.`;

function retryLine(retry: TurnRetry | undefined) {
	if (retry?.state !== "scheduled" && retry?.state !== "started") return undefined;
	const cause = retry.reason === "reusable-protocol-failure" ? "The reply broke off" : "The model provider failed";
	if (retry.state === "started" || !retry.nextAt) return `${cause}. Retrying now, attempt ${retry.attempt}.`;
	const at = new Date(retry.nextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	return `${cause}. Retrying at ${at}, attempt ${retry.attempt}.`;
}

type Props = {
	channel: Listing;
	/** Every listed channel, to name and open the channels that message this one. */
	channels: Listing[];
	chat: number;
	user: string;
	/** Others' messages after `since` and up to `until` arrived while this person was away. */
	unread?: { since?: number; until?: number };
	draft?: string;
	onDraftLoaded: () => void;
	onProviders?: () => void;
	onOpen: (channel: Listing) => void;
	/** Called once the chat loads and whenever its agent may have changed files since. */
	onWork?: () => void;
	/** A build's agent's chat on the work log, beside the channel's own: read-only, and it publishes nothing. */
	beside?: boolean;
};

/** One chat's timeline and composer over its transcript; the content of a Chat tab. */
export function Conversation(
	{
		channel,
		channels,
		chat: id,
		user,
		unread,
		draft,
		onDraftLoaded,
		onProviders,
		onOpen,
		onWork,
		beside,
	}: Props,
) {
	const offline = channel.state === "offline";
	const placement = channel.hosted || channel.host;
	const moving = channel.moving && `Moving to ${channel.moving}…`;
	const computing = channel.computing
		&& `${channel.computing === "starting" ? "Starting" : "Stopping"} the cloud workspace…`;
	const transition = moving || computing;
	// The service refuses a computing channel, so the chat is watched again only once that ends.
	const transcript = useTranscript(
		computing ? undefined : channel.id,
		id,
		offline,
		channel.moving ? `${placement} → ${channel.moving}` : placement,
	);
	// The watch retries once the host is back or the move or compute transition ends, so its error
	// until then is not the user's to retry.
	const failed = !offline && !transition && transcript.error;
	const chat = transcript.info?.chats.find((value) => value.id === id);
	const { diff, plan: openPlan, work: openWork, builds: known } = useDetails(channel.id);
	// The work log shows only agents' chats; elsewhere the channel's last known builds say so while
	// this chat's own watch loads.
	const locked = beside || readOnly(id, chat, transcript.live ? transcript.builds : known?.list ?? []);
	const model = chat?.model || channel.model;
	const people = useSyncExternalStore(host.subscribe, () => host.people);
	// This app's own host, or the peer host relaying this channel to it, stopped answering.
	const stalled = useSyncExternalStore(host.subscribe, () => host.stalled);
	const notice = stalled
		? stopped(desktop ? "Neuve Helper" : "Your host")
		: channel.stalled
		? stopped(channel.host)
		: channel.state === "archived"
			&& (channel.owner === user
				? "Archived. Unarchive it from the sidebar to send messages."
				: "Archived. Only its owner can unarchive it.");
	const waiting = stalled
		? `Waiting for ${desktop ? "Neuve Helper" : "your host"}`
		: channel.stalled
		? `Waiting for ${channel.host}`
		: channel.state === "dormant"
		? "Starting channel"
		: "Sending";
	const retrying = retryLine(transcript.turnRetry);
	const reply = transcript.items.findLast((item) => item.kind === "reply");
	const question = reply?.kind === "reply" && pendingQuestion(reply.tools, transcript.busy);
	const last = transcript.items.at(-1);
	const failure = !transcript.busy && last?.kind === "reply" ? last.error : undefined;
	const senders = useMemo(() => sources(channels, channel.host), [channels, channel.host]);
	// Neuve review cards sit in the timeline under the turn whose start call made them.
	const reviews = transcript.reviews;
	const newest = useMemo(() => newestReview(reviews), [reviews]);
	const connected = !offline && !stalled && !channel.stalled;
	const mayAsk = channel.owner === user || transcript.shared !== false;
	const plans = useMemo(
		() => planCards(transcript.plans, (author) => author === user ? "you" : people[author] || author),
		[transcript.plans, user, people],
	);
	const planned = transcript.plans.length > 0;
	const agents = useMemo(() => agentAuthors(transcript.builds), [transcript.builds]);
	const own = useMemo(() => {
		const agent = agents.get(agentAuthor(id)) ?? chat?.build;
		return agent && { author: agentAuthor(id), agent };
	}, [agents, chat?.build, id]);
	const builds = useMemo(
		() => buildCards(transcript.builds, id, (author) => author === user ? "you" : people[author] || author),
		[transcript.builds, id, user, people],
	);
	const approvals = useMemo(
		() =>
			shownApprovals(transcript.approvals, transcript.items).map((request) =>
				approvalView(request, (author) => author === user ? "you" : people[author] || author)
			),
		[transcript.approvals, transcript.items, user, people],
	);
	const sends = useMemo(() => commentSends(transcript.planComments), [transcript.planComments]);
	const said = useMemo(
		() => new Map([...sends.values()].flatMap(({ entry, said }) => entry === undefined ? [] : [[entry, said]])),
		[sends],
	);
	const events = useMemo(
		() =>
			withCards(
				toEvents(
					transcript.items,
					channel.id,
					transcript.busy,
					{
						text: transcript.draft,
						model: model?.modelId,
					},
					people,
					senders,
					transcript.captions,
					transcript.recaps,
					transcript.reactions,
					(asker) => credit(asker, channel, user, people, senders),
					reviews,
					said,
					agents,
					own,
					origin,
				),
				transcript.items,
				reviews,
				plans,
				channel.id,
				transcript.busy,
				connected,
				builds,
			),
		[
			transcript.items,
			channel.id,
			transcript.busy,
			transcript.draft,
			model,
			people,
			senders,
			transcript.captions,
			transcript.recaps,
			transcript.reactions,
			channel,
			user,
			reviews,
			plans,
			connected,
			said,
			agents,
			own,
			builds,
		],
	);
	const returnFromPlan = usePlanReturn(channel.id, id);
	const planActions = useMemo(
		() => ({
			mayApprove: mayAsk,
			open: (plan: string) => openPlan?.(plan),
			approve: (plan: string, hash: string) => {
				const returned = returnFromPlan();
				return host.channel(channel.id, { op: "plan-approve", chat: id, author: user, plan, hash }).then(
					() => returned(),
					(error: Error) => void toast.error("Could not approve the plan", { description: error.message }),
				);
			},
		}),
		[mayAsk, openPlan, channel.id, id, user, returnFromPlan],
	);
	const buildActions = useMemo(
		() => ({
			mayStop: mayAsk,
			open: (chat?: number) => openWork?.(chat),
			stop: (build: string) =>
				host.channel(channel.id, { op: "build-stop", author: user, build }).then(
					() => {},
					(error: Error) => void toast.error("Could not stop the agents", { description: error.message }),
				),
		}),
		[mayAsk, openWork, channel.id, user],
	);
	const review = useMemo(
		() =>
			reviewActions(
				reviews,
				// A new review is a person's message, which a build's agent's chat takes from no one.
				mayAsk && !locked,
				(text) =>
					host.channel(channel.id, { op: "ask", chat: id, author: user, text }).then(
						() => {},
						(error: Error) => {
							toast.error("Could not ask for a new review", { description: error.message });
						},
					),
				reviewTab(channel.id),
			),
		[reviews, mayAsk, locked, channel.id, id, user],
	);
	const byKey = useMemo(
		() => new Map(transcript.items.map((item) => [item.key, item])),
		[transcript.items],
	);
	const { since, until = 0 } = unread || {};
	const first = since === undefined
		? undefined
		: transcript.items.find((item) =>
			item.kind === "message" && item.author !== user && item.at > since && item.at <= until
			&& !item.system
		)?.key;
	// Mentions name people by GitHub login, as the channel's host counts them.
	const self = people[user]?.toLowerCase();
	const mentioned = useMemo(
		() =>
			new Set(
				self
					? transcript.items.flatMap((item) =>
						item.kind === "message" && item.author !== user && !item.deleted
							&& [...item.text.matchAll(MENTION)].some((match) => match[1]!.toLowerCase() === self)
							? [item.key]
							: []
					)
					: [],
			),
		[transcript.items, user, self],
	);
	// Reactions and deletions target stored entries; the streamed draft and tool-only replies have none.
	const actions = (uid: string) => {
		const item = byKey.get(uid);
		const stored = item?.entry !== undefined && !(item.kind === "message" && item.deleted);
		// An archived channel refuses changes to its history, and a build's agent's chat any person's edit.
		const open = stored && channel.state !== "archived";
		return { react: open, copy: stored && !!item.text, delete: open && !locked, permalink: false };
	};
	const [deleting, setDeleting] = useState<string>();
	// Only a person's own stored messages are edited, and an archived channel refuses edits. Plan
	// comments are edited in the Plan tab, not as the message that sent them.
	const editable = useMemo(
		() =>
			new Set(
				channel.state === "archived" || locked
					? []
					: transcript.items.flatMap((item) =>
						item.kind === "message" && item.author === user && !item.deleted && !said.has(item.entry) ? [item.key] : []
					),
			),
		[transcript.items, user, channel.state, locked, said],
	);
	const [editing, setEditing] = useState<string>();
	const edited = editing === undefined || !editable.has(editing) ? undefined : byKey.get(editing);
	const act = (
		request: { op: "react"; emoji: string; remove: boolean } | { op: "delete" },
		uid: string,
	) => {
		const entry = byKey.get(uid)!.entry!;
		host.channel(channel.id, { ...request, chat: id, author: user, entry }).catch((error: Error) =>
			toast.error(
				request.op === "react" ? "Could not react" : "Could not delete the message",
				{ description: error.message },
			)
		);
	};
	// Keyed by Tailscale login for message authors and by GitHub login for mentions.
	const avatars = useMemo(
		() =>
			Object.fromEntries(
				Object.entries(people).flatMap(([login, github]) => {
					const src = `https://github.com/${github}.png?size=64`;
					return [[login, src], [github, src]];
				}),
			),
		[people],
	);
	// The agent's replies carry Neuve's mark; Ace's mentions and composer never see this key.
	const agentAvatar = useAgentAvatar();
	const timelineAvatars = useMemo(
		() => ({ ...avatars, [AGENT]: agentAvatar }),
		[avatars, agentAvatar],
	);
	const roles = useMemo(
		() => Object.fromEntries([...agents].map(([author, agent]) => [author, agent.role])),
		[agents],
	);
	const mentions = useMemo(() => [
		...Object.entries(timelineAvatars).map(([name, avatar]) => ({ name, avatar })),
		...[...agents.values()].map((agent) => ({ name: mentionName(agent), label: agentName(agent, [...agents.values()]) })),
	], [timelineAvatars, agents]);
	const presence = useSyncExternalStore(host.subscribe, () => host.presence);
	const roster = useRoster();
	// Mentions name people by GitHub login. A name still holding @ is a Tailscale login with no
	// GitHub account, or an agent from another channel (`agent@<prefix>`), and can't be mentioned.
	const members = useMemo(() => {
		const self = people[user] || user;
		const names = new Set([
			...present(presence[channelProject(channel)], self, channel.id).map((value) => value.name),
			...transcript.items.flatMap((item) =>
				item.kind === "message" && !item.system ? [people[item.author] || item.author] : []
			),
			...(roster || []).map((member) => member.github || member.login),
		]);
		return [...names]
			.filter((name) => name !== self && !isAgentAlias(name) && !name.includes("@"))
			.map((name) => ({ name, avatar: avatars[name] }));
	}, [people, user, presence, channel, transcript.items, roster, avatars]);
	const typing = useTyping(transcript.typing).filter((author) => author !== user)
		.map((author) => people[author] || author);
	const results = useMemo(
		() =>
			transcript.items.reduce(
				(sum, item) =>
					item.kind === "reply" ? sum + item.tools.filter((tool) => tool.result).length : sum,
				0,
			),
		[transcript.items],
	);

	// Replay delivers one event at a time; the sidebar reads the transcript once it is complete.
	const items = transcript.live ? transcript.items : undefined;
	useEffect(() => {
		if (beside) return;
		const { info, shared, sharedLive, desktop, desktopLive } = transcript;
		publish(channel.id, { info, items, shared, sharedLive, desktop, desktopLive });
	}, [
		beside,
		channel.id,
		transcript.info,
		items,
		transcript.shared,
		transcript.sharedLive,
		transcript.desktop,
		transcript.desktopLive,
	]);

	useEffect(() => {
		if (transcript.live && !beside) {
			publish(channel.id, {
				plans: { chat: id, list: transcript.plans },
				reviews: { chat: id, newest },
				planComments: { chat: id, list: transcript.planComments, sends: transcript.commentSends },
				builds: { list: transcript.builds, messages: transcript.messages },
			});
		}
	}, [
		beside,
		channel.id,
		id,
		transcript.live,
		transcript.plans,
		newest,
		transcript.planComments,
		transcript.commentSends,
		transcript.builds,
		transcript.messages,
	]);

	useEffect(() => {
		if (transcript.live && !beside) onWork?.();
	}, [transcript.live, transcript.busy, results, onWork, beside]);
	return (
		<>
			<div className="relative min-h-0 flex-1">
				{transcript.live
					? (
						<ReviewActionsProvider value={review}>
							<PlanActionsProvider value={planActions}>
								<BuildActionsProvider value={buildActions}>
									<Timeline
										className="h-full min-h-0 contain-paint scroll-fade [--fade:3rem]"
										events={events}
										working={transcript.busy || undefined}
										currentUser={{ login: user, own: [user] }}
										unread={first}
										summary={channel.summary}
										mentioned={mentioned}
										actions={actions}
										onReact={(uid, emoji) => {
											const entry = byKey.get(uid)!.entry!;
											const remove = !!transcript.reactions[entry]?.some((value) =>
												value.from === user && value.emoji === emoji
											);
											act({ op: "react", emoji, remove }, uid);
										}}
										onCopy={(uid) => {
											const item = byKey.get(uid)!;
											const sent = said.get(item.entry!);
											navigator.clipboard.writeText(sent ? commentWords(sent) : item.text).then(
												() => toast("Copied message"),
												(error) =>
													toast.error("Could not copy the message", { description: error.message }),
											);
										}}
										onDelete={setDeleting}
										editable={editable}
										editing={edited?.key}
										onEdit={setEditing}
										avatars={timelineAvatars}
										mentions={mentions}
										openSender={(sender) => {
											const source = senders.get(sender);
											return source && (() => onOpen(source));
										}}
										intro={{ name: channel.name, createdAt: Math.floor(channel.created / 1000) }}
										// The Diff tab shows the channel's own chat, not an agent's beside it.
										onFileOpen={beside ? undefined : diff}
										onDiffFileOpen={beside ? undefined : diff}
										onReviewChanges={!beside && diff ? () => diff() : undefined}
										onPlanOpen={planned && openPlan ? () => openPlan() : undefined}
										roles={roles}
									/>
								</BuildActionsProvider>
							</PlanActionsProvider>
						</ReviewActionsProvider>
					)
					: offline
					? <OfflineHost name={channel.name} host={channel.host} />
					: (
						<div
							className="grid h-full place-content-center justify-items-center gap-3 px-6 text-center text-sm text-muted-foreground"
							role={failed ? "alert" : "status"}
						>
							<p>
								{transition
									|| failed
									|| notice
									|| (transcript.restarting
										? "Channel is restarting…"
										: channel.state === "dormant"
										? "Starting channel…"
										: "Loading chat…")}
							</p>
							{failed && <Button onClick={transcript.retry}>Try again</Button>}
						</div>
					)}
			</div>
			{deleting && (
				<DeleteMessage
					onDelete={() => {
						act({ op: "delete" }, deleting);
						setDeleting(undefined);
					}}
					onCancel={() => setDeleting(undefined)}
				/>
			)}
			<div className="utils:max-width relative z-20 shrink-0 px-3 pb-3">
				{typing.length > 0 && (
					<ChatStatus className="absolute inset-x-5 bottom-full" typing={typing} disclaimer="" />
				)}
				{transcript.live && (notice || transition || transcript.restarting || retrying) && (
					<p className="pb-2 text-center text-xs text-muted-foreground" role="status">
						{notice || transition || (transcript.restarting ? "Channel is restarting…" : retrying)}
					</p>
				)}
				{transcript.live && question && (
					<Question
						key={question.call}
						channel={channel}
						chat={id}
						call={question}
						user={user}
						mayAnswer={channel.owner === user || transcript.shared !== false}
					/>
				)}
				{transcript.live && approvals.length > 0 && (
					<div className="max-h-[60vh] overflow-y-auto">
						{approvals.map((view) => (
							<Approval
								key={view.request}
								channel={channel.id}
								chat={id}
								user={user}
								view={view}
								mayAnswer={mayAsk}
							/>
						))}
					</div>
				)}
				{transcript.live && <Checks channel={channel} chat={id} user={user} />}
				{transcript.live && (
					<MessageQueue
						messages={transcript.queue}
						said={sends}
						people={people}
						channels={senders}
						agents={agents}
						locked={locked}
					/>
				)}
				{edited && (
					<EditMessage
						key={edited.key}
						channel={channel.id}
						chat={id}
						user={user}
						entry={edited.entry!}
						text={edited.text}
						onDone={() => setEditing(undefined)}
					/>
				)}
				{locked && transcript.live && transcript.busy && (
					<div className="flex justify-end">
						<Button
							size="sm"
							variant="outline"
							disabled={!mayAsk}
							onClick={() =>
								void host.channel(channel.id, { op: "stop", chat: id, author: user }).catch(
									(error: Error) => toast.error("Could not stop the agent", { description: error.message }),
								)}
						>
							Stop
						</Button>
					</div>
				)}
				{/* Hidden rather than unmounted, so its draft and attachments wait out the edit. */}
				{!locked && (
					<div className={edited ? "hidden" : "contents"}>
						<Composer
							channel={channel}
							chat={id}
							chatMode={chat && (chat.mode ?? "ace")}
							user={user}
							current={model}
							currentEffort={chat?.effort}
							pending={chat?.pending}
							automatic={transcript.info?.automatic}
							busy={transcript.busy}
							waiting={waiting}
							shared={transcript.shared}
							ready={transcript.live && !transition && channel.state !== "archived"}
							draft={draft}
							onDraftLoaded={onDraftLoaded}
							returned={transcript.returned}
							failure={failure}
							onProviders={onProviders}
							accessory={chat?.usage && <Usage value={chat.usage} context={chat.context} />}
							members={members}
							builds={transcript.builds}
							plan={planned}
						/>
					</div>
				)}
			</div>
		</>
	);
}
