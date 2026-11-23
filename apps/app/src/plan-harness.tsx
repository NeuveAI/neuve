// Dev-only page (plan.html, served by `vite` but not built): the plan's card in Ace's real timeline
// and the Plan tab's view, from fixtures, in every state. `?scene=cards`, `?scene=tab`, `?scene=live`
// (approving moves the card and the tab to Approved), `?scene=layout` (the channel's real tab
// layout, where writing a plan opens its tab), `?scene=comments` (each state of a comment on the
// plan) or `?scene=commenting` (select, comment, reply, send and a revision, against a stand-in for
// the channel; a comment with "stale" in it is refused; `&text=rich` comments on every kind of
// block); `?theme=dark` for the dark theme.
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";

import type { Plan, PlanComment } from "@ace/channel/protocol";
import { fileLines, fileLinesSection, placeFileLinesAnchor } from "@neuve/review-rules/file-lines-anchor";
import { Main, PlanActionsProvider, PlanView, type PlanViewProps, Layout as Shell, Timeline, TooltipProvider } from "@ace/ui";

import "./styles.css";

import { CHAT, Layout } from "./layout/layout";
import { planCards, planView } from "./plan-card";
import { planCommentViews } from "./plan-comments";
import { withCards } from "./review-card";
import { toEvents } from "./timeline";
import type { Item } from "./transcript";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);

const USER = "vinicius@example.com";
const T = Date.UTC(2026, 10, 23, 14, 2, 0);
const TEXT = `# Retry failed exports

## Goal

A failed export is retried on its own, up to three times, and the person sees why it failed.

## In scope

- Retry with backoff in the export worker
- The failure reason on the export row

## Out of scope

- The queue's public interface
- Exports that failed before this change

## Done when

- A failed export retries three times, then stops
- Each attempt is logged with its reason
- The row shows the last reason
- A retried export keeps its \`id\`
`;

const plan = (patch: Partial<Plan> = {}): Plan => ({
	id: "p1",
	hash: "9e1c04a7b3f25d18c6e04a9b7d21f3c58e60b4a1d9c7e2f30a5b8c1d4e7f9a2b",
	call: "write-1",
	title: "Retry failed exports",
	state: "draft",
	written: T,
	...patch,
});

const APPROVED = { by: USER, at: T + 3 * 60_000 };

const RICH = `# Move exports to the new queue

## Steps

1. Add the queue client
2. Move the worker, keeping:
   - its retry count
   - its log lines

| Export | Owner | Done when |
| --- | --- | --- |
| Invoices | billing | sent twice a day |
| Reports | data | sent nightly |

> The old queue stays readable until the last export moves.

\`\`\`ts
await queue.send(job);
\`\`\`

See [the queue's notes](https://example.com/queue) and [a local file](file:///etc/hosts).

---

Done when nothing reads the old queue.
`;

function items(plans: Plan[], ask = "plan retries for failed exports"): Item[] {
	return [
		{ kind: "message", key: "e1", entry: 1, at: T - 60_000, author: USER, text: ask, invoked: true },
		...plans.map((value, index): Item => ({
			kind: "reply",
			key: `e${index + 2}`,
			entry: index + 2,
			at: T + index * 60_000,
			model: "",
			mode: "plan",
			text: "Two things I chose that you may want to change: retries stop after three attempts, and a failed export keeps its original id.",
			tools: [{ call: value.call, name: "plan_write", args: {}, result: { error: false, text: "Written." } }],
		})),
	];
}

function Chat(
	{ plans, mayApprove = true, onApprove, onOpen, ask }: {
		plans: Plan[];
		mayApprove?: boolean;
		onApprove?: (plan: string) => void;
		onOpen?: (plan?: string) => void;
		ask?: string;
	},
) {
	let list = items(plans, ask);
	let name = (author: string) => author === USER ? "you" : author;
	let events = withCards(
		toEvents(list, "harness", false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {}),
		list,
		{},
		planCards(plans, name),
		"harness",
		false,
		true,
	);
	return (
		<PlanActionsProvider
			value={{
				mayApprove,
				open: (id) => onOpen?.(id),
				approve: async (id) => {
					await new Promise((resolve) => setTimeout(resolve, 600));
					onApprove?.(id);
				},
			}}
		>
			<Timeline
				className="h-full min-h-0"
				events={events}
				currentUser={{ login: USER, own: [USER] }}
				onPlanOpen={onOpen && plans.length ? () => onOpen() : undefined}
			/>
		</PlanActionsProvider>
	);
}

function Frame({ label, children, height = 420 }: { label: string; children: React.ReactNode; height?: number }) {
	return (
		<figure className="flex min-w-0 flex-col gap-2">
			<figcaption className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</figcaption>
			<div className="overflow-hidden rounded-xl border border-border bg-background" style={{ inlineSize: 600, blockSize: height }}>
				{children}
			</div>
		</figure>
	);
}

const view = (value: Plan) => planView(value, (author) => author === USER ? "you" : author);

const TABS: { label: string; props: PlanViewProps }[] = [
	{ label: "Draft", props: { plan: view(plan()), text: TEXT, approve: { onApprove: () => {}, approving: false } } },
	{ label: "Approving", props: { plan: view(plan()), text: TEXT, approve: { onApprove: () => {}, approving: true } } },
	{
		label: "Approval refused",
		props: {
			plan: view(plan()),
			text: TEXT,
			approve: { onApprove: () => {}, approving: false, error: "The plan has changed. Read the current version before approving it." },
		},
	},
	{
		label: "May not approve",
		props: {
			plan: view(plan()),
			text: TEXT,
			approve: { onApprove: () => {}, approving: false, blocked: "Only people who may ask this channel's agents can approve a plan" },
		},
	},
	{ label: "Approved", props: { plan: view(plan({ state: "approved", approved: APPROVED })), text: TEXT } },
	{ label: "Replaced", props: { plan: view(plan({ state: "replaced", approved: APPROVED })), text: TEXT } },
	{ label: "Loading", props: { plan: view(plan()), approve: { onApprove: () => {}, approving: false, blocked: "The plan is loading" } } },
	{ label: "Could not read", props: { plan: view(plan()), error: "No plan p1 in chat 1." } },
	{
		label: "Every kind of block",
		props: { plan: view(plan({ title: "Move exports to the new queue" })), text: RICH },
	},
	{
		label: "A long title, then none",
		props: {
			plan: view(plan({ title: "Retry failed exports with backoff, keep their ids, and show the last reason on every row" })),
			text: "No heading in this plan.",
		},
	},
];

const CHATS: { label: string; plans: Plan[]; mayApprove?: boolean }[] = [
	{ label: "Draft", plans: [plan()] },
	{ label: "Draft, may not approve", plans: [plan()], mayApprove: false },
	{ label: "Approved", plans: [plan({ state: "approved", approved: APPROVED })] },
	{
		label: "A long title, then none",
		plans: [
			plan({ title: "Retry failed exports with backoff, keep their ids, and show the last reason on every row" }),
			plan({ id: "p2", call: "write-2", title: "" }),
		],
	},
	{
		label: "Replaced by an approved revision",
		plans: [
			plan({ state: "replaced", approved: APPROVED }),
			plan({ id: "p2", call: "write-2", hash: "4b7e19d0".padEnd(64, "0"), title: "Retry failed exports, keeping ids", state: "approved", approved: { by: USER, at: T + 9 * 60_000 } }),
		],
	},
];

function Live() {
	let [plans, setPlans] = useState([plan()]);
	let approve = () => setPlans((list) => list.map((value) => ({ ...value, state: "approved" as const, approved: APPROVED })));
	let [approving, setApproving] = useState(false);
	let current = plans[0]!;
	return (
		<div className="flex flex-wrap gap-6">
			<Frame label="Chat">
				<Chat plans={plans} onApprove={approve} />
			</Frame>
			<Frame label="Plan tab" height={540}>
				<PlanView
					plan={view(current)}
					text={TEXT}
					approve={current.state === "draft"
						? {
							approving,
							onApprove: () => {
								setApproving(true);
								setTimeout(() => {
									setApproving(false);
									approve();
								}, 600);
							},
						}
						: undefined}
				/>
			</Frame>
		</div>
	);
}


// Comments on the plan. A stand-in for the channel keeps them as the contract says: anchored to the
// version they were made on and placed on the current one by the shared rule.

const REVISED = TEXT
	.replace("up to three times", "up to five times")
	.replace("- The failure reason on the export row", "- The failure reason on the export row and in its log")
	.replace("retries three times", "retries five times");
const VERSIONS: Record<string, string> = { [plan().hash]: TEXT, ["5d".repeat(32)]: REVISED };
const VIVIENNE = "vivienne@example.com";
const PEOPLE: Record<string, string> = { [USER]: "Vinicius", [VIVIENNE]: "Vivienne" };

let ids = 0;
function comment(
	text: string,
	first: number,
	last: number,
	quote: string,
	patch: Partial<PlanComment> = {},
): PlanComment {
	let hash = plan().hash;
	let anchor = { hash, lines: fileLines(TEXT).slice(first - 1, last), quote, section: fileLinesSection(TEXT, first) };
	return {
		id: `c${++ids}`,
		plan: "p1",
		author: USER,
		at: T,
		text,
		anchor,
		placement: { kind: "stays", hash, lines: anchor.lines },
		replies: [],
		...patch,
	};
}

/** Places each comment on the version `hash`, as the channel does when the plan changes. */
function revise(comments: PlanComment[], hash: string): PlanComment[] {
	return comments.map((value) => ({
		...value,
		placement: placeFileLinesAnchor(value.anchor, VERSIONS[value.anchor.hash]!, { hash, text: VERSIONS[hash]! }),
	}));
}

const SENT = { at: T + 60_000, submission: 3, entry: 7 };
const ADMITTED = { at: T + 60_000, submission: 3 };
const ANSWER = (text: string) => ({ kind: "agent" as const, id: `a${++ids}`, model: "claude", at: T + 120_000, text });
const GOAL = (patch: Partial<PlanComment> = {}) =>
	comment("Five. Three is too few for the nightly batch.", 5, 5, "up to three times", patch);
const SCOPE = (patch: Partial<PlanComment> = {}) =>
	comment("Why not? Last week's are still failing.", 15, 15, "Exports that failed before this change", patch);
const ROW = (patch: Partial<PlanComment> = {}) =>
	comment("Should the reason show on the export row only?", 10, 10, "export row", patch);

const COMMENT_STATES: { label: string; comments: PlanComment[]; state?: Plan["state"]; hash?: string }[] = [
	{ label: "Kept, not sent", comments: [GOAL(), SCOPE()] },
	{ label: "Queued", comments: [GOAL({ sent: ADMITTED, state: "queued" })] },
	{ label: "Sent", comments: [GOAL({ sent: SENT, state: "sent" })] },
	{ label: "Picked up", comments: [GOAL({ sent: SENT, state: "picked-up" })] },
	{
		label: "Answered, with a reply kept",
		comments: [
			SCOPE({
				sent: SENT,
				state: "replied",
				replies: [
					ANSWER("They failed on a schema that no longer exists; a retry would fail the same way. I left this out and noted why."),
					{ kind: "person", id: "r1", author: USER, at: T + 180_000, text: "Then say so in the plan." },
				],
			}),
		],
	},
	{ label: "Not delivered", comments: [GOAL({ state: "failed", failure: "Stopped before the agent read it" })] },
	{ label: "Someone else's comment", comments: [SCOPE({ author: VIVIENNE })] },
	{
		label: "Changed, stays and ambiguous after a revision",
		hash: "5d".repeat(32),
		comments: revise([GOAL({ sent: SENT, state: "replied", replies: [ANSWER("Five it is; the plan says so now.")] }), SCOPE({ sent: SENT, state: "picked-up" }), ROW({ sent: SENT, state: "picked-up" })], "5d".repeat(32)),
	},
	{ label: "On an approved plan", state: "approved", comments: [SCOPE({ sent: SENT, state: "sent" })] },
];

const commentViews = (comments: PlanComment[]) =>
	planCommentViews(comments, "p1", USER, (author) => PEOPLE[author] ?? author);

const noop = async () => {};

function commentActions(comments: PlanComment[]) {
	return { list: commentViews(comments), agent: "Neuve", keep: noop, reply: noop, edit: noop, remove: noop };
}

function CommentStates() {
	return (
		<div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(600px, 1fr))" }}>
			{COMMENT_STATES.map((item) => {
				let state = item.state ?? "draft";
				return (
					<Frame key={item.label} label={item.label} height={620}>
						<PlanView
							plan={view(plan({ state, ...(state === "approved" ? { approved: APPROVED } : {}) }))}
							text={item.hash ? VERSIONS[item.hash] : TEXT}
							approve={state === "draft" ? { onApprove: () => {}, approving: false } : undefined}
							comments={commentActions(item.comments)}
							send={{ onSend: () => {}, sending: false }}
						/>
					</Frame>
				);
			})}
		</div>
	);
}

/** Comments against a stand-in channel: keep, reply, edit, remove, send, then a revision. */
function Commenting() {
	let rich = new URLSearchParams(location.search).get("text") === "rich";
	let [hash, setHash] = useState(plan().hash);
	let [comments, setComments] = useState<PlanComment[]>([]);
	let [sending, setSending] = useState(false);
	let change = (id: string, patch: (value: PlanComment) => PlanComment) =>
		setComments((list) => list.map((value) => value.id === id ? patch(value) : value));
	let send = () => {
		setSending(true);
		let carried = comments.filter((value) => !value.sent || value.replies.some((reply) => reply.kind === "person" && !reply.sent)).map((value) => value.id);
		setTimeout(() => {
			setSending(false);
			setComments((list) =>
				list.map((value) =>
					carried.includes(value.id)
						? {
							...value,
							sent: value.sent ?? ADMITTED,
							state: "queued",
							replies: value.replies.map((reply) => reply.kind === "person" ? { ...reply, sent: reply.sent ?? ADMITTED } : reply),
						}
						: value
				)
			);
		}, 400);
		// The chat was busy: the message waits as a submission, then is placed and taken up.
		setTimeout(() => setComments((list) => list.map((value) => carried.includes(value.id) ? { ...value, sent: SENT, state: "sent" } : value)), 1000);
		setTimeout(() => setComments((list) => list.map((value) => carried.includes(value.id) ? { ...value, state: "picked-up" } : value)), 1800);
		setTimeout(() =>
			setComments((list) =>
				list.map((value, index) =>
					carried.includes(value.id) && index === 0
						? { ...value, state: "replied", replies: [...value.replies, ANSWER("Noted. I'll change the plan to say so.")] }
						: value
				)
			), 3000);
	};
	return (
		<div className="flex flex-col gap-3">
			<div className="flex gap-2">
				<button
					type="button"
					data-testid="revise"
					className="rounded-md border border-border px-2 py-1 text-xs"
					onClick={() => {
						let next = "5d".repeat(32);
						setHash(next);
						setComments((list) => revise(list, next));
					}}
				>
					Agent revises the plan
				</button>
			</div>
			<Frame label="Plan tab" height={640}>
				<PlanView
					plan={view(plan({ hash }))}
					text={rich ? RICH : VERSIONS[hash]}
					approve={{ onApprove: () => {}, approving: false }}
					comments={{
						list: commentViews(comments),
						agent: "Neuve",
						keep: hash === plan().hash
							? async (selection, text) => {
								await new Promise((resolve) => setTimeout(resolve, 150));
								// Stands in for a refusal from the channel.
								if (text.includes("stale")) throw new Error("The plan has changed. Read the current version before commenting.");
								let { lines, quote } = selection;
								setComments((list) => [...list, comment(text, lines[0]!.line, lines.at(-1)!.line, quote)]);
							}
							: undefined,
						reply: async (id, text) =>
							change(id, (value) => ({ ...value, replies: [...value.replies, { kind: "person", id: `r${++ids}`, author: USER, at: Date.now(), text }] })),
						edit: async (id, reply, text) =>
							change(id, (value) => reply
								? { ...value, replies: value.replies.map((item) => item.id === reply ? { ...item, text } : item) }
								: { ...value, text }),
						remove: async (id, reply) =>
							reply
								? change(id, (value) => ({ ...value, replies: value.replies.filter((item) => item.id !== reply) }))
								: setComments((list) => list.filter((value) => value.id !== id)),
					}}
					send={{ onSend: send, sending }}
				/>
			</Frame>
		</div>
	);
}

const LAYOUT = "plan-harness";

/** The real tab layout: writing a plan opens the Plan tab beside the chat, once per plan. */
function Tabs() {
	let [plans, setPlans] = useState<Plan[]>([]);
	let opener = useRef<(plan?: string) => void>(undefined);
	let write = () =>
		setPlans((list) => [
			...list.map((value) => value.state === "draft" ? { ...value, state: "approved" as const, approved: APPROVED } : value),
			plan({ id: `p${list.length + 1}`, call: `write-${list.length + 1}`, title: list.length ? "Retry failed exports, keeping ids" : "Retry failed exports" }),
		]);
	let open = (id?: string) => opener.current?.(id);
	return (
		<div className="flex h-full flex-col gap-3">
			<div className="flex gap-2">
				<button type="button" data-testid="write" className="rounded-md border border-border px-2 py-1 text-xs" onClick={write}>
					Agent writes a plan
				</button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
				<Layout
					id={LAYOUT}
					name="exports"
					chat={1}
					terminals={false}
					plan={plans.at(-1)?.id}
					planOpener={opener}
					render={(data, uid) => {
						if (uid === CHAT) {
							return <Chat plans={plans} onOpen={open} ask="plan retries for failed exports, then check plan.md" />;
						}
						if (data.type !== "plan") return null;
						let shown = data.plan ? plans.find((value) => value.id === data.plan) : plans.at(-1);
						return shown ? <PlanView plan={view(shown)} text={TEXT} /> : null;
					}}
				/>
			</div>
		</div>
	);
}

function Harness() {
	let scene = new URLSearchParams(location.search).get("scene") ?? "cards";
	if (scene === "layout") {
		if (!new URLSearchParams(location.search).has("keep")) {
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
	return (
		<main className="h-full overflow-auto bg-muted/40 p-6 text-foreground">
			{scene === "live"
				? <Live />
				: scene === "comments"
				? <CommentStates />
				: scene === "commenting"
				? <Commenting />
				: scene === "tab"
				? (
					<div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(600px, 1fr))" }}>
						{TABS.map((item) => (
							<Frame key={item.label} label={item.label} height={540}>
								<PlanView {...item.props} />
							</Frame>
						))}
					</div>
				)
				: (
					<div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(600px, 1fr))" }}>
						{CHATS.map((item) => (
							<Frame key={item.label} label={item.label} height={item.plans.length > 1 ? 560 : 360}>
								<Chat plans={item.plans} mayApprove={item.mayApprove} />
							</Frame>
						))}
					</div>
				)}
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<Harness />);
