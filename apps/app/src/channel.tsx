import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import type { Build, Change, Changes } from "@ace/channel/protocol";
import type { ChannelInfo, Listing, TerminalShell } from "@ace/host/protocol";
import {
	AgentModelProvider,
	Badge,
	type DetailsChanges,
	type DetailsFact,
	type DetailsLink,
	type DetailsSubagent,
	ReviewLinkProvider,
	reviewPath,
	SessionDetailsView,
	Sidebar,
	useLayoutRight,
} from "@ace/ui";
import { IconCloud, IconGlobe, IconHash } from "@ace/ui/icons";

import { AgentModel } from "./agent-model";
import { agentName, buildBranches, planDetails } from "./build-card";
import { ChannelAccess } from "./channel-access";
import { Conversation } from "./conversation";
import { forget, publish, useDetails, useNewestPlan, useNewestReview } from "./details";
import { useAsked, useGit } from "./git";
import { host, onOpen as onHostOpen } from "./host";
import { CHAT, Layout } from "./layout/layout";
import { EFFORTS, useModels } from "./model-choice";
import { Diff, GROUPS } from "./panels/diff";
import { Live } from "./panels/live";
import { Plan } from "./panels/plan";
import { Review } from "./panels/review";
import { Terminal } from "./panels/terminal";
import { WorkLog } from "./panels/work-log";
import { placement } from "./placement";
import { usePull, usePulls } from "./pull";
import { openReview } from "./review-destination";
import type { Item } from "./transcript";

export type ChannelDraft = { channel: string; text: string };

type Props = {
	chat?: number;
	channel: Listing;
	channels: Listing[];
	user: string;
	remote: boolean;
	/** When this person last saw the channel, before opening it now. */
	seen?: number;
	draft?: ChannelDraft;
	onDraftLoaded: () => void;
	onProviders?: () => void;
	onOpen: (channel: Listing) => void;
};

const LINK = /https?:\/\/[^\s<>()[\]{}"'`]+/g;
const GITHUB = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?$/;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Links people and agents wrote in the chat, newest mention first; tool output is left out. */
function links(items: Item[], repo?: string): DetailsLink[] {
	const seen = new Map<string, DetailsLink>();
	for (const item of items) {
		for (const match of item.text.matchAll(LINK)) {
			const url = match[0].replace(/[.,;:!?*_]+$/, "");
			if (!URL.canParse(url)) continue;
			seen.delete(url);
			const github = GITHUB.exec(url);
			if (github) {
				const [, path, kind, number] = github;
				const label = `${path === repo ? "" : path}#${number}`;
				seen.set(url, { url, label, kind: kind === "pull" ? "pull" : "issue" });
				continue;
			}
			// Reviews served here open in the Review tab, so they read as the screen they show.
			if (reviewPath(url)) {
				const desk = /\/desk\/?$/.test(new URL(url).pathname);
				seen.set(url, { url, label: desk ? "Review desk" : "Batch overview", kind: "web" });
				continue;
			}
			const { host, pathname, search } = new URL(url);
			seen.set(url, { url, label: `${host}${pathname.replace(/\/$/, "")}${search}`, kind: "web" });
		}
	}
	return [...seen.values()].toReversed();
}

function subagents(items: Item[], busy: boolean): DetailsSubagent[] {
	return items.flatMap((item) =>
		item.kind === "reply"
			? item.tools.filter((tool) => tool.name === "subagent").map((tool) => {
				const args = tool.args as { task?: string; model?: string };
				const state: DetailsSubagent["state"] = tool.result
					? tool.result.error ? "failed" : "done"
					: busy && !item.stopped
					? "running"
					: "stopped";
				const task = args.task?.trim().split("\n")[0] || "Subagent";
				const model = args.model?.split("/").at(-1);
				return { id: tool.call, task, model, state };
			})
			: []
	);
}

/** The builds' agents, each opening its own work on the work log. */
function workers(builds: Build[], open: ((chat?: number) => void) | undefined): DetailsSubagent[] {
	return builds.flatMap((build) =>
		build.agents.map((agent) => ({
			id: `build:${agent.chat}`,
			task: agentName(agent, build.agents),
			state: agent.state,
			...(open ? { open: () => open(agent.chat) } : {}),
		}))
	);
}

function where(channel: Listing): DetailsFact[] {
	const place = placement(channel);
	if (place.kind === "local") return [{ label: "Host", value: place.host }];
	const hosted = { label: "Hosted", value: place.service, title: channel.hosted };
	if (place.kind === "hosted") return [hosted, { label: "Workspace", value: place.workspace }];
	return [hosted, {
		label: "Workspace",
		value: `cloud (${place.service})`,
		title: `A Linux container on ${place.service}`,
	}];
}

function facts(channel: Listing, info: ChannelInfo | undefined, chat: number): DetailsFact[] {
	const root = info?.chats.find((value) => value.id === chat);
	const chosen = root?.model || channel.model;
	// A chat without a model runs what Automatic picks, which a default model change moves.
	const model = chosen || info?.automatic;
	// "off" also stands for an always-thinking provider's default, so it isn't shown as a level.
	const effort = root?.model && root.effort !== "off" ? root.effort : undefined;
	const usage = info?.chats.reduce<{ cost: number | undefined; tokens: number }>(
		(sum, value) => ({
			cost: sum.cost === undefined || (value.usage?.totalTokens && value.usage.cost === undefined)
				? undefined : sum.cost + (value.usage?.cost ?? 0),
			tokens: sum.tokens + (value.usage?.totalTokens || 0),
		}),
		{ cost: 0, tokens: 0 },
	);
	return [
		{
			label: "Project",
			value: channel.repo || channel.project.split("/").at(-1) || channel.project,
			title: channel.project,
		},
		...where(channel),
		{ label: "Owner", value: channel.owner.split("@")[0]!, title: channel.owner },
		...(model
			? [{
				label: "Model",
				value: effort
					? `${model.modelId} · ${EFFORTS[effort]}`
					: chosen
					? model.modelId
					: `${model.modelId} (Automatic)`,
				title: `${model.provider}/${model.modelId}${effort ? `, ${EFFORTS[effort]} effort` : ""}`,
			}]
			: []),
		...(usage?.tokens
			? [
				{ label: "Tokens", value: compact.format(usage.tokens) },
				{ label: "Estimated cost", value: usage.cost === undefined ? "No price for this model" : dollars.format(usage.cost) },
			]
			: []),
		{ label: "Created", value: date.format(channel.created) },
	];
}

/**
 * A hosted channel's chat and model-only runs continue without its workspace; its tools fail
 * until it answers again (#349, #372). Hosted listings never go offline, so only another listing
 * from the workspace can say it is unreachable.
 */
function workspace(channel: Listing, channels: Listing[]): string | undefined {
	const place = placement(channel);
	if (place.kind === "local") return;
	if (place.kind === "cloud") {
		if (place.stopped) {
			return `This channel's cloud workspace on ${place.service} is stopped, so tools fail until Start compute resumes it. Chat and model-only runs continue.`;
		}
		return `Tools run in this channel's cloud container on ${place.service}, without macOS permissions, and fail while it's stopped. Chat and model-only runs continue.`;
	}
	const { workspace } = place;
	const away = channels.some((value) => value.host === workspace && value.state === "offline");
	if (away) {
		return `${workspace} is offline, so tools fail until it's back. Chat and model-only runs continue.`;
	}
	return `Tools run on ${workspace} and fail while it's offline. Chat and model-only runs continue.`;
}

/** The sidebar row's stopped dot, on the Chat tab's cloud icon. */
function StoppedCloud({ className }: { className?: string }) {
	return (
		<Badge
			style={{ "--badge-color": "var(--color-muted-foreground)", "--s": "5px" } as CSSProperties}
		>
			<IconCloud className={className} />
		</Badge>
	);
}

export function ChannelDetails({ channel, user, chat = 1 }: { channel: Listing; user: string; chat?: number }) {
	const right = useLayoutRight();
	const details = useDetails(channel.id);
	const channels = useSyncExternalStore(host.subscribe, () => host.channels);
	const { changes, info, items, builds } = details;
	const busy = !!info?.chats.find((value) => value.id === chat)?.busy;
	const pull = usePull(channel.repo, changes?.branch);
	const list = builds?.list;
	const branches = useMemo(() => buildBranches(list ?? []), [list]);
	const planPulls = usePulls(channel.repo, branches);
	const plans = useMemo(() => planDetails(list ?? [], planPulls), [list, planPulls]);
	const shownLinks = useMemo(() => {
		const known = new Set([pull?.url, ...[...planPulls.values()].map((value) => value?.url)]);
		return items && links(items, channel.repo).filter((link) => !known.has(link.url));
	}, [items, channel.repo, pull?.url, planPulls]);
	useEffect(() => publish(channel.id, { pull }), [channel.id, pull]);
	useAsked(channel.id, busy, pull);
	const git = useGit(channel, chat, user);
	const totals = useMemo(() => {
		if (!changes) return;
		// Totaled per group as the Diff does, so uncommitted and untracked files never inflate the
		// committed work a pull request would show.
		const groups = new Map<string | undefined, DetailsChanges>();
		const add = (group: string | undefined, files: number, file?: Change) => {
			let sum = groups.get(group);
			if (!sum) {
				groups.set(
					group,
					sum = { ...(group ? { group } : {}), adds: 0, dels: 0, files: 0, lines: false },
				);
			}
			sum.files += files;
			// Large untracked directories are only counted, so their group's line totals are unknown.
			if (!file) sum.lines = false;
			else if (!file.binary) {
				sum.adds += file.adds;
				sum.dels += file.dels;
				sum.lines = true;
			}
		};
		for (const file of changes.files) add(file.state && GROUPS[file.state], 1, file);
		// After every file, so no file's lines mark a directory's group known again.
		for (const { files } of changes.dirs || []) add(GROUPS.untracked, files);
		return groups.size ? [...groups.values()] : [{ adds: 0, dels: 0, files: 0, lines: true }];
	}, [changes]);
	const agents = useMemo(() => items && subagents(items, busy), [items, busy]);
	const working = useMemo(() => workers(builds?.list ?? [], details.work), [builds, details.work]);
	const review = useCallback((path: string) => void openReview(channel.id, path), [channel.id]);
	return (
		<Sidebar
			side="right"
			id="channel-details"
			className="-my-2 h-[calc(100%+1rem)]"
			innerClassName="h-full min-h-0"
		>
			<ReviewLinkProvider value={review}>
				<SessionDetailsView
					summary={channel.summary}
					changes={totals}
					branch={changes?.branch}
					pull={pull}
					subagents={agents}
					plans={plans}
					workers={working}
					links={shownLinks}
					facts={facts(channel, info, chat)}
					note={workspace(channel, channels)}
					creatingPr={git.creatingPr}
					onDiff={details.diff}
					onCreatePr={git.createPr}
					onCreateDraftPr={git.createDraftPr}
					actions={git.actions}
					onClose={() => right.setOpen(false)}
				/>
			</ReviewLinkProvider>
		</Sidebar>
	);
}

/** A channel's tabs: its chat, Diff and Terminal views of that chat's lane, and its reviews. */
export function Channel(
	{ channel, channels, user, remote, seen, draft, onDraftLoaded, onProviders, onOpen, chat = 1 }: Props,
) {
	const place = placement(channel);
	// Taken as the channel opens: opening it marks everything seen, and later messages arrive in view.
	const [unread] = useState(() => ({ since: seen, until: channel.said?.at }));
	const [changed, setChanged] = useState<boolean>();
	const check = useRef({ busy: false, again: false });

	// One check at a time; work that lands during a check asks for one more after it.
	const inspect = useCallback(() => {
		const run = check.current;
		if (run.busy) {
			run.again = true;
			return;
		}
		run.busy = true;
		host.channel<Changes>(channel.id, { op: "changes", chat }).then(
			(changes) => {
				setChanged(changes.files.length > 0 || !!changes.dirs);
				publish(channel.id, { changes });
			},
			() => {},
		).finally(() => {
			run.busy = false;
			if (!run.again) return;
			run.again = false;
			inspect();
		});
	}, [channel.id, chat]);

	// Shells live on this host, so only its own channels have them; reconnecting may follow a reload.
	const elsewhere = remote || place.kind !== "local";
	const [shells, setShells] = useState<TerminalShell[]>();
	useEffect(() => {
		if (elsewhere) return;
		let live = true;
		const load = () => {
			host.request<TerminalShell[]>({ op: "terminals", channel: channel.id }).then(
				(value) => {
					if (live) setShells(value.filter((shell) => !shell.attached));
				},
				() => {},
			);
		};
		if (host.status === "open") load();
		const off = onHostOpen(load);
		return () => {
			live = false;
			off();
		};
	}, [channel.id, elsewhere]);

	const opener = useRef<() => void>(undefined);
	const planOpener = useRef<(plan?: string) => void>(undefined);
	const workOpener = useRef<(chat?: number) => void>(undefined);
	useEffect(() => {
		publish(channel.id, {
			diff: (file) => {
				if (file) publish(channel.id, { reveal: { chat, file, key: Date.now() } });
				opener.current?.();
			},
			plan: (plan) => planOpener.current?.(plan),
			work: (chat) => workOpener.current?.(chat),
		});
		return () => forget(channel.id);
	}, [channel.id, chat]);
	const plan = useNewestPlan(channel.id, chat);
	const review = useNewestReview(channel.id, chat);
	const { builds } = useDetails(channel.id);
	// Agents and messages, so a new one marks the Work log tab; none while the channel has no build.
	const work = builds?.list.length
		? builds.list.reduce((sum, build) => sum + build.agents.length, 0) + builds.messages.length
		: undefined;
	const { models } = useModels(channel, true);
	const agentModel = useCallback(
		(chat: number, plain?: boolean) => (
			<AgentModel channel={channel.id} models={models} user={user} chat={chat} plain={plain} />
		),
		[channel.id, models, user],
	);

	const layout = (
		<Layout
			id={channel.id}
			name={place.kind === "cloud"
				? `${channel.name} · ${place.stopped ? "stopped" : "cloud"}`
				: place.kind === "hosted"
				? `${channel.name} · hosted`
				: remote
				? `${channel.name} · ${channel.host}`
				: channel.name}
			icon={place.kind === "cloud"
				? place.stopped ? StoppedCloud : IconCloud
				: place.kind === "hosted"
				? IconGlobe
				: IconHash}
			chat={chat}
			changed={changed}
			opener={opener}
			plan={plan}
			planOpener={planOpener}
			review={review}
			work={work}
			workOpener={workOpener}
			shells={shells}
			terminals={!elsewhere}
			actions={<ChannelAccess channel={channel} user={user} />}
			render={(data, uid, active, update) => {
				if (uid === CHAT) {
					return (
						<Conversation
							channel={channel}
							channels={channels}
							chat={chat}
							user={user}
							unread={unread}
							draft={draft?.channel === channel.id ? draft.text : undefined}
							onDraftLoaded={onDraftLoaded}
							onProviders={!remote && !channel.hosted ? onProviders : undefined}
							onOpen={onOpen}
							onWork={inspect}
						/>
					);
				}
				if (data.type === "plan") {
					return <Plan channel={channel} chat={data.chat} user={user} plan={data.plan} />;
				}
				if (data.type === "work") {
					return (
						<WorkLog
							channel={channel}
							channels={channels}
							user={user}
							chat={data.chat}
							onChat={(chat) => update({ chat })}
							onOpen={onOpen}
						/>
					);
				}
				if (data.type === "diff") {
					return <Diff channel={channel} chat={data.chat} user={user} active={active} />;
				}
				if (data.type === "review") {
					return (
						<Review
							id={uid}
							channel={channel.id}
							chat={chat}
							path={data.path}
							title={data.title}
							active={active}
							update={update}
						/>
					);
				}
				if (data.type === "live") {
					return (
						<Live
							id={uid}
							window={data.window}
							app={data.app}
							active={active}
							update={update}
						/>
					);
				}
				if (data.type !== "terminal") return null;
				// Tabs saved before Terminal was withheld here still open, so they say why they're empty.
				if (elsewhere) {
					return (
						<section className="grid h-full min-h-0 place-items-center bg-background px-4 text-center text-sm text-muted-foreground">
							{place.kind === "cloud"
								? "This cloud channel's shell is in its container, so terminals don't open here."
								: place.kind === "hosted"
								? `This channel runs on ${place.service}, which doesn't open terminals.`
								: `Terminals open on the channel's host, ${channel.host}, and only for its owner.`}
						</section>
					);
				}
				return (
					<Terminal
						channel={channel.id}
						chat={data.chat}
						active={active}
						terminal={data.terminal}
						onTerminal={(terminal) => update({ terminal })}
					/>
				);
			}}
			onTabClose={(_, data) => {
				if (data.type !== "terminal" || !data.terminal) return;
				host.request({ op: "terminal-close", terminal: data.terminal }).catch(() => {});
			}}
		/>
	);
	return <AgentModelProvider value={agentModel}>{layout}</AgentModelProvider>;
}
