// Dev-only page (build.html, served by `vite` but not built), from fixtures: `?scene=cards`, `log`,
// `agent`, `layout` (the real tabs) or `sidebar`; `&width=narrow` for a phone's width, `&theme=dark`.
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";

import type { Build, BuildAgent, Plan, WorkMessage } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";
import {
	BuildActionsProvider,
	Main,
	SessionDetailsView,
	PlanActionsProvider,
	Layout as Shell,
	Timeline,
	TooltipProvider,
} from "@ace/ui";

import "./styles.css";

import { useAgentAvatar } from "./agent-avatar";
import { agentAuthor, agentAuthors, agentName, buildCards } from "./build-card";
import { publish } from "./details";
import { CHAT, Layout } from "./layout/layout";
import { WorkLog } from "./panels/work-log";
import { planCards } from "./plan-card";
import { withCards } from "./review-card";
import { AGENT, toEvents } from "./timeline";
import type { Item } from "./transcript";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const WIDTH = params.get("width") === "narrow" ? 360 : 600;

const USER = "vinicius@example.com";
const T = Date.UTC(2026, 10, 23, 14, 2, 0);
const HASH = "9e1c04a7b3f25d18c6e04a9b7d21f3c58e60b4a1d9c7e2f30a5b8c1d4e7f9a2b";
// Direction controls, zero-width characters and a string with nowhere to break.
const HOSTILE = "‮esrever‬ ⁦isolated⁩ zero​‌width ⁧rtl";
const UNBROKEN = "a".repeat(240);

const plan: Plan = {
	id: "p1",
	hash: HASH,
	call: "write-1",
	title: "Retry failed exports",
	state: "approved",
	written: T,
	approved: { by: USER, at: T + 60_000 },
};

const agent = (chat: number, patch: Partial<BuildAgent> = {}): BuildAgent => ({
	chat,
	role: "implementer",
	started: T + 2 * 60_000,
	state: "running",
	caption: "Reading the plan and the export worker",
	...patch,
});

const IMPLEMENTER = agent(2);
const REVIEWER = agent(3, { role: "reviewer", by: 2, caption: "Reading the retry counter against the plan" });
const SCHEDULER = agent(4, { part: "scheduler", by: 2, caption: "Moving the timer change" });
const SECOND = agent(5, { role: "reviewer", part: "scheduler", by: 4, state: "done", caption: "Approved the timer change" });

const build = (patch: Partial<Build> = {}): Build => ({
	id: `1:${HASH}`,
	chat: 1,
	plan: { id: plan.id, hash: plan.hash, title: plan.title, call: plan.call },
	approved: plan.approved!,
	state: { kind: "started" },
	agents: [IMPLEMENTER],
	...patch,
});

const CARDS: { label: string; build: Build }[] = [
	{ label: "One agent", build: build() },
	{
		label: "Two agents, one waiting on the person",
		build: build({ agents: [{ ...IMPLEMENTER, state: "waiting", caption: "Asking which id to keep" }, REVIEWER] }),
	},
	{ label: "Four agents", build: build({ agents: [IMPLEMENTER, SCHEDULER, REVIEWER, SECOND] }) },
	{
		label: "All agents ended",
		build: build({ agents: [{ ...IMPLEMENTER, state: "done" }, { ...REVIEWER, state: "failed" }] }),
	},
	{ label: "Shared channel", build: build({ state: { kind: "unavailable", reason: "shared" }, agents: [] }) },
	{ label: "Hosted channel", build: build({ state: { kind: "unavailable", reason: "hosted" }, agents: [] }) },
	{
		label: "Paused, an agent waiting on the person",
		build: build({
			state: { kind: "paused", reason: "shared" },
			agents: [{ ...IMPLEMENTER, state: "waiting", caption: "Asking which id to keep" }, REVIEWER],
		}),
	},
	{
		label: "Stopped",
		build: build({
			state: { kind: "stopped", by: USER, at: T + 20 * 60_000 },
			agents: [{ ...IMPLEMENTER, state: "stopped" }, { ...REVIEWER, state: "stopped" }],
		}),
	},
	{
		label: "Failed",
		build: build({
			state: { kind: "failed", detail: "The project's checkout has uncommitted changes, so no worktree could be made for the implementer." },
			agents: [],
		}),
	},
	{
		label: "Failed, hostile detail",
		build: build({ state: { kind: "failed", detail: `${HOSTILE} ${UNBROKEN}` }, agents: [] }),
	},
	{
		label: "Hostile and long text",
		build: build({
			agents: [{ ...IMPLEMENTER, caption: `${HOSTILE} ${UNBROKEN}` }, { ...SCHEDULER, part: UNBROKEN, caption: HOSTILE }],
		}),
	},
];

const name = (author: string) => author === USER ? "you" : author;

function items(): Item[] {
	return [
		{ kind: "message", key: "e1", entry: 1, at: T - 60_000, author: USER, text: "plan retries for failed exports", invoked: true },
		{
			kind: "reply",
			key: "e2",
			entry: 2,
			at: T,
			model: "",
			mode: "plan",
			text: "Two things I chose that you may want to change: retries stop after three attempts, and a failed export keeps its original id.",
			tools: [{ call: plan.call, name: "plan_write", args: {}, result: { error: false, text: "Written." } }],
		},
	];
}

function Chat({ builds, onOpen = () => {} }: { builds: Build[]; onOpen?: () => void }) {
	let list = items();
	let events = withCards(
		toEvents(list, "harness", false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {}),
		list,
		{},
		planCards([plan], name),
		"harness",
		false,
		true,
		buildCards(builds, 1, name),
	);
	return (
		<PlanActionsProvider value={{ mayApprove: true, open: () => {}, approve: async () => {} }}>
			<BuildActionsProvider
				value={{ mayStop: true, open: onOpen, stop: () => new Promise((resolve) => setTimeout(resolve, 600)) }}
			>
				<Timeline className="h-full min-h-0" events={events} currentUser={{ login: USER, own: [USER] }} />
			</BuildActionsProvider>
		</PlanActionsProvider>
	);
}

function Frame({ label, children, height = 420 }: { label: string; children: React.ReactNode; height?: number }) {
	return (
		<figure className="flex min-w-0 flex-col gap-2">
			<figcaption className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</figcaption>
			<div
				className="flex flex-col overflow-hidden rounded-xl border border-border bg-background"
				style={{ inlineSize: WIDTH, blockSize: height }}
			>
				{children}
			</div>
		</figure>
	);
}

const message = (from: number, to: number, minutes: number, text: string): WorkMessage => ({
	build: `1:${HASH}`,
	from,
	to,
	at: T + minutes * 60_000,
	text,
});

const EXCHANGE: WorkMessage[] = [
	message(2, 3, 17, "I'd like an independent review. The work is at `3f2a1c9`."),
	message(3, 2, 29, "Two things before I can approve.\n\n1. The fourth attempt still runs: the counter is read before it is written.\n2. No test fails when I remove the backoff. Add one that does."),
	message(2, 3, 42, "Both fixed in `8b41d07`. I split the counter change out; it touched the scheduler too."),
	message(4, 2, 44, "The timer change is on `exports/scheduler`, ready when you are."),
	message(2, 4, 45, "Thanks. I'll rebase onto it once the reviewer is done."),
	message(5, 4, 51, "Approved the timer change."),
	message(3, 2, 58, "Approved. Requesting the final review."),
];

const LOGS: { label: string; id: string; builds: Build[]; messages: WorkMessage[] }[] = [
	{ label: "No messages yet", id: "log-empty", builds: [build()], messages: [] },
	{
		label: "A long exchange, four agents, the reviewer waiting on the person",
		id: "log-long",
		builds: [build({ agents: [IMPLEMENTER, { ...REVIEWER, state: "waiting" }, SCHEDULER, SECOND] })],
		messages: EXCHANGE,
	},
	{
		label: "One agent writing to two others in a row",
		id: "log-recipients",
		builds: [build({ agents: [IMPLEMENTER, REVIEWER, SCHEDULER] })],
		messages: [message(2, 3, 17, "Ready for review at `3f2a1c9`."), message(2, 4, 18, "Rebase onto it when you can.")],
	},
	{
		label: "Hostile text",
		id: "log-hostile",
		builds: [build({ agents: [{ ...IMPLEMENTER, caption: `${HOSTILE} ${UNBROKEN}` }, { ...REVIEWER, part: UNBROKEN }] })],
		messages: [message(2, 3, 17, `${HOSTILE} ${UNBROKEN}`), message(3, 2, 18, HOSTILE)],
	},
];

const listing = (id: string) => ({ id, name: "exports", owner: USER }) as Listing;

function Log({ id, builds, messages }: { id: string; builds: Build[]; messages: WorkMessage[] }) {
	let [chat, setChat] = useState<number>();
	useEffect(() => publish(id, { builds: { list: builds, messages } }), [id, builds, messages]);
	return <WorkLog channel={listing(id)} channels={[]} user={USER} chat={chat} onChat={setChat} onOpen={() => {}} />;
}

/** An agent's own chat: the host's brief, its work, and what another agent said to it. */
function Agent({ chat }: { chat: BuildAgent }) {
	let avatar = useAgentAvatar();
	let builds = [build({ agents: [IMPLEMENTER, REVIEWER] })];
	let agents = agentAuthors(builds);
	let list: Item[] = [
		{
			kind: "message",
			key: "e1",
			entry: 1,
			at: T + 2 * 60_000,
			author: "unknown",
			text: `[Neuve] Build the approved plan "Retry failed exports" at /Users/vinicius/.neuve/plans/p1.md (hash ${HASH.slice(0, 8)}). Open with scope retrieval naming that path.`,
			invoked: true,
			system: { kind: "neuve:build:brief", build: `1:${HASH}` },
		},
		{
			kind: "reply",
			key: "e2",
			entry: 2,
			at: T + 3 * 60_000,
			model: "gpt-5-codex",
			text: "I'll read the plan and the export worker first.",
			tools: [],
		},
		{
			kind: "message",
			key: "e3",
			entry: 3,
			at: T + 29 * 60_000,
			author: agentAuthor(REVIEWER.chat),
			text: EXCHANGE[1]!.text,
			invoked: true,
		},
		{ kind: "reply", key: "e4", entry: 4, at: T + 42 * 60_000, model: "gpt-5-codex", text: EXCHANGE[2]!.text, tools: [] },
	];
	let events = toEvents(
		list,
		"agent",
		false,
		{ text: "" },
		{},
		new Map(),
		{},
		{},
		{},
		() => undefined,
		{},
		new Set(),
		agents,
		{ author: agentAuthor(chat.chat), agent: chat },
	);
	let roles = Object.fromEntries([...agents].map(([author, value]) => [author, value.role]));
	return (
		<Timeline
			className="h-full min-h-0"
			events={events}
			currentUser={{ login: USER, own: [USER] }}
			avatars={{ [AGENT]: avatar }}
			roles={roles}
		/>
	);
}

const LAYOUT = "build-harness";

/** The real tab layout: the first agent opens the Work log behind the chat; new messages mark it. */
function Tabs() {
	let [builds, setBuilds] = useState<Build[]>([]);
	let [messages, setMessages] = useState<WorkMessage[]>([]);
	let opener = useRef<(chat?: number) => void>(undefined);
	useEffect(() => publish(LAYOUT, { builds: { list: builds, messages } }), [builds, messages]);
	let work = builds.length
		? builds.reduce((sum, value) => sum + value.agents.length, 0) + messages.length
		: undefined;
	return (
		<div className="flex h-full flex-col gap-3">
			<div className="flex gap-2">
				<button
					type="button"
					data-testid="start"
					className="rounded-md border border-border px-2 py-1 text-xs"
					onClick={() => setBuilds([build({ agents: builds.length ? [IMPLEMENTER, REVIEWER] : [IMPLEMENTER] })])}
				>
					Start an agent
				</button>
				<button
					type="button"
					data-testid="say"
					className="rounded-md border border-border px-2 py-1 text-xs"
					onClick={() => setMessages((list) => [...list, EXCHANGE[list.length % EXCHANGE.length]!])}
				>
					An agent says something
				</button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
				<Layout
					id={LAYOUT}
					name="exports"
					chat={1}
					terminals={false}
					work={work}
					workOpener={opener}
					render={(data, uid, _, update) => {
						if (uid === CHAT) {
							return <Chat builds={builds} onOpen={() => opener.current?.()} />;
						}
						if (data.type !== "work") return null;
						return (
							<WorkLog
								channel={listing(LAYOUT)}
								channels={[]}
								user={USER}
								chat={data.chat}
								onChat={(chat) => update({ chat })}
								onOpen={() => {}}
							/>
						);
					}}
				/>
			</div>
		</div>
	);
}

function Harness() {
	let scene = params.get("scene") ?? "cards";
	if (scene === "layout") {
		if (!params.has("keep")) {
			sessionStorage.removeItem(`ace:channel-layout:${LAYOUT}`);
			localStorage.removeItem(`ace:channel-layout:${LAYOUT}`);
		}
		return (
			<TooltipProvider>
				<Shell defaultNavOpen={false} defaultLeftOpen={false}>
					<Main className="overflow-hidden bg-background p-4">
						<Tabs />
					</Main>
				</Shell>
			</TooltipProvider>
		);
	}
	const grid = { gridTemplateColumns: `repeat(auto-fill, minmax(${WIDTH}px, 1fr))` };
	return (
		<TooltipProvider>
			<main className="h-full overflow-auto bg-muted/40 p-6 text-foreground">
				<div className="grid gap-6" style={grid}>
					{scene === "log"
						? LOGS.map((item) => (
							<Frame key={item.id} label={item.label} height={560}>
								<Log id={item.id} builds={item.builds} messages={item.messages} />
							</Frame>
						))
						: scene === "sidebar"
						? (
							<Frame label="Details sidebar" height={420}>
								<div className="w-72 p-3">
									<SessionDetailsView
										subagents={[{ id: "s1", task: "Read the export worker", model: "haiku", state: "done" }]}
										workers={[IMPLEMENTER, { ...REVIEWER, state: "waiting" as const }, SCHEDULER].map((agent) => ({
											id: `build:${agent.chat}`,
											task: agentName(agent),
											state: agent.state,
											open: () => {},
										}))}
										onClose={() => {}}
									/>
								</div>
							</Frame>
						)
						: scene === "agent"
						? [IMPLEMENTER].map((chat) => (
							<Frame key={chat.chat} label={`${chat.role}'s own chat`} height={560}>
								<Agent chat={chat} />
							</Frame>
						))
						: CARDS.map((item) => (
							<Frame key={item.label} label={item.label} height={item.build.agents.length > 2 ? 360 : 300}>
								<Chat builds={[item.build]} />
							</Frame>
						))}
				</div>
			</main>
		</TooltipProvider>
	);
}

createRoot(document.getElementById("root")!).render(<Harness />);
