// Dev-only page (build.html, served by `vite` but not built), from fixtures: `?scene=cards`, `log`,
// `agent`, `layout` (the real tabs), `sidebar` (the details) or `rows` (sidebar rows); `&card=<n>` for
// one card, `&width=narrow` for a phone's width, `&theme=dark`.
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";

import type { Build, BuildAgent, BuildReview, GithubPull, Plan, WorkMessage } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";
import {
	BuildActionsProvider,
	Main,
	SessionDetailsView,
	SessionSidebar,
	type SidebarRow,
	PlanActionsProvider,
	Layout as Shell,
	Timeline,
	TooltipProvider,
} from "@ace/ui";

import "./styles.css";

import { useAgentAvatar } from "./agent-avatar";
import { ApprovalCard } from "./approval";
import { approvalView } from "./approval-card";
import { fixture, KINDS } from "./approval.fixtures";
import { agentAuthor, agentAuthors, agentName, buildCards, planDetails } from "./build-card";
import { Question } from "./question";
import { publish } from "./details";
import { CHAT, Layout } from "./layout/layout";
import { WorkLog } from "./panels/work-log";
import { planCards } from "./plan-card";
import { withCards } from "./review-card";
import { AGENT, toEvents } from "./timeline";
import type { Item, Tool } from "./transcript";

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

const BRANCH = "exports/build-p1";
const SHA = "8b41d07e3c9a2f15d6b0e4a7c1f3d5b8e9a0c2d4";
const DESK = `/review/${"a3".repeat(32)}/cycles/01JD3Q5V8X2K7M9N4P6R1S0T3W/desk`;

const pull = (patch: Partial<GithubPull> = {}): GithubPull => ({
	kind: "prs",
	number: 128,
	title: "Retry failed exports",
	url: "https://github.com/neuve/exports/pull/128",
	state: "open",
	author: "vinicius",
	created: "2026-11-23T14:10:00Z",
	updated: "2026-11-23T15:02:00Z",
	labels: [],
	head: BRANCH,
	sha: SHA,
	checks: [
		{ name: "test", state: "passed" },
		{ name: "typecheck", state: "passed" },
		{ name: "lint", state: "passed" },
	],
	merge: "ready",
	...patch,
});

const review = (patch: Partial<BuildReview> = {}): BuildReview => ({
	chat: 3,
	review: "01JD3Q5V8X2K7M9N4P6R1S0T3W",
	phase: "finished",
	head: SHA,
	humanRequired: 0,
	desk: DESK,
	...patch,
});

const DONE = [{ ...IMPLEMENTER, state: "done" as const }, { ...REVIEWER, state: "done" as const, caption: "Approved the retry counter" }];

const QUESTION: Tool = {
	call: "q-1",
	name: "question",
	args: {
		questions: [{
			header: "Export id",
			question: "A retried export can keep its original id or take a new one. Which should it keep?",
			options: [
				{ label: "Original id", description: "Links people already shared keep working" },
				{ label: "New id", description: "Each attempt is its own export in the history" },
			],
			multiple: false,
		}],
	},
};

const CARDS: { label: string; build: Build; pull?: GithubPull; asks?: boolean; height?: number }[] = [
	{
		label: "Draft pull request, checks running",
		build: build({ branch: BRANCH, agents: [IMPLEMENTER, REVIEWER] }),
		pull: pull({
			state: "draft",
			merge: "blocked",
			checks: [{ name: "test", state: "pending" }, { name: "typecheck", state: "passed" }, { name: "lint", state: "pending" }],
		}),
	},
	{
		label: "Ready, with Merge",
		build: build({ branch: BRANCH, agents: DONE, review: review() }),
		pull: pull(),
	},
	{
		label: "A review with units needing a person",
		build: build({ branch: BRANCH, agents: DONE, review: review({ humanRequired: 3 }) }),
		pull: pull({ merge: "blocked" }),
	},
	{
		label: "Review running",
		build: build({ branch: BRANCH, agents: [{ ...IMPLEMENTER, state: "done" }, REVIEWER], review: review({ phase: "running", humanRequired: undefined, desk: undefined }) }),
		pull: pull({ state: "draft", merge: "blocked" }),
	},
	{
		label: "Newer commits than the review",
		build: build({ branch: BRANCH, agents: [IMPLEMENTER, { ...REVIEWER, state: "done" }], review: review({ humanRequired: 1 }) }),
		pull: pull({ state: "draft", sha: "c41e9a07b2d3f58e6a1c0b9d7e2f4a3c5b8d0e1f", merge: "blocked", checks: [{ name: "test", state: "failed" }, { name: "lint", state: "passed" }] }),
	},
	{
		label: "Conflicts with its base",
		build: build({ branch: BRANCH, agents: DONE, review: review() }),
		pull: pull({ merge: "conflicts" }),
	},
	{
		label: "An agent waiting on a question",
		build: build({
			branch: BRANCH,
			agents: [{ ...IMPLEMENTER, state: "waiting", caption: "Asking which id to keep" }, REVIEWER],
		}),
		pull: pull({ state: "draft", merge: "blocked" }),
		asks: true,
		height: 1180,
	},
	{
		label: "Merged",
		build: build({ branch: BRANCH, agents: DONE, review: review(), merged: { number: 128, at: T + 74 * 60_000 } }),
		pull: pull({ state: "merged" }),
	},
	{ label: "One agent", build: build() },
	{
		label: "Waiting on the person, running and ended",
		build: build({ agents: [{ ...IMPLEMENTER, state: "waiting", caption: "Asking which id to keep" }, REVIEWER, SECOND] }),
	},
	{ label: "Four agents", build: build({ agents: [IMPLEMENTER, SCHEDULER, REVIEWER, SECOND] }) },
	{
		label: "All agents ended",
		build: build({ agents: [{ ...IMPLEMENTER, state: "done" }, { ...REVIEWER, state: "failed" }] }),
	},
	{
		label: "An agent's retries ran out",
		build: build({
			agents: [
				{
					...IMPLEMENTER,
					state: "failed",
					failure: { role: "implementer", turn: "t1", at: T, reason: "retry-budget-exhausted", attempts: 6 },
				},
				REVIEWER,
			],
		}),
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

function Chat({ builds, pulls, onOpen = () => {} }: {
	builds: Build[];
	pulls?: ReadonlyMap<string, GithubPull | null>;
	onOpen?: (chat?: number) => void;
}) {
	let list = items();
	let events = withCards(
		toEvents(list, "harness", false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {}),
		list,
		{},
		planCards([plan], name),
		"harness",
		false,
		true,
		buildCards(builds, 1, name, pulls),
	);
	return (
		<PlanActionsProvider value={{ mayApprove: true, open: () => {}, approve: async () => {} }}>
			<BuildActionsProvider
				value={{
					mayStop: true,
					open: onOpen,
					stop: () => new Promise((resolve) => setTimeout(resolve, 600)),
					merge: () => new Promise((_, reject) => setTimeout(() => reject(new Error("refused")), 1200)),
				}}
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
		new Map(),
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

/** The dock of the chat that planned a build: what its waiting agent asks, answered there. */
function Asks() {
	return (
		<div className="shrink-0 px-3 pb-3">
			<Question channel={listing("asks")} chat={2} call={QUESTION} user={USER} mayAnswer requester="Implementer" />
			<ApprovalCard
				view={approvalView(fixture(KINDS[0]!), name)}
				mayAnswer
				answer={() => {}}
				requester="Implementer"
			/>
		</div>
	);
}

const ROW = (patch: Partial<SidebarRow>): SidebarRow => ({
	uid: patch.name ?? "row",
	kind: "session",
	name: "exports",
	createdAt: Math.floor(T / 1000),
	lifecycle: "live",
	private: false,
	mine: true,
	member: true,
	connection: "idle",
	agent: "idle",
	unreadCount: 0,
	mentionCount: 0,
	lastActivityAt: Math.floor(T / 1000),
	online: [],
	...patch,
});

/** Sidebar rows marked by their plans, beside an ordinary and an unread row. */
function Rows() {
	const rows = [
		ROW({ name: "retry-exports", plans: { ready: true, humanRequired: 0 } }),
		ROW({ name: "billing-sync", plans: { ready: false, humanRequired: 3 } }),
		ROW({ name: "scheduler", needsAttention: "question" }),
		ROW({ name: "search-index", unreadCount: 1 }),
		ROW({ name: "docs" }),
	];
	return (
		<SessionSidebar
			projectName="exports"
			groups={[{ id: "mine", label: "Channels", rows }]}
			className="h-full w-72"
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
					onClick={() =>
						setBuilds([build({ agents: builds.length ? [IMPLEMENTER, { ...REVIEWER, state: "waiting" }] : [IMPLEMENTER] })])}
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
							return <Chat builds={builds} onOpen={(chat) => opener.current?.(chat)} />;
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
							<Frame label="Details sidebar" height={720}>
								<div className="w-72 p-3">
									<SessionDetailsView
										branch="exports/main-chat"
										pull={null}
										plans={planDetails(
											[
												build({ branch: BRANCH, review: review({ humanRequired: 3 }) }),
												build({
													id: `1:${"b".repeat(64)}`,
													plan: { id: "p2", hash: "b".repeat(64), title: "Move the export timer", call: "write-2" },
													approved: { by: USER, at: T + 90 * 60_000 },
													branch: "exports/build-p2",
												}),
											],
											new Map([[BRANCH, pull({ merge: "blocked" })], ["exports/build-p2", pull({
												number: 131,
												title: "Move the export timer",
												state: "draft",
												head: "exports/build-p2",
												checks: [{ name: "test", state: "pending" }],
											})]]),
										)}
										subagents={[{ id: "s1", task: "Read the export worker", model: "haiku", state: "done" }]}
										workers={[IMPLEMENTER, { ...REVIEWER, state: "waiting" as const }, SECOND].map((agent) => ({
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
						: scene === "rows"
						? (
							<Frame label="Sidebar rows" height={260}>
								<Rows />
							</Frame>
						)
						: CARDS.filter((_, index) => !params.has("card") || params.get("card") === String(index)).map((item) => (
							<Frame
								key={item.label}
								label={item.label}
								height={item.height ?? (item.build.agents.length > 2 || item.pull ? 380 : 300)}
							>
								<div className="flex min-h-0 flex-1 flex-col">
									<Chat builds={[item.build]} pulls={item.pull ? new Map([[BRANCH, item.pull]]) : undefined} />
								</div>
								{item.asks && <Asks />}
							</Frame>
						))}
				</div>
			</main>
		</TooltipProvider>
	);
}

createRoot(document.getElementById("root")!).render(<Harness />);
