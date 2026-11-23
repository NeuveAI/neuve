// Dev-only page (plan.html, served by `vite` but not built): the plan's card in Ace's real timeline
// and the Plan tab's view, from fixtures, in every state. `?scene=cards`, `?scene=tab`, `?scene=live`
// (approving moves the card and the tab to Approved) or `?scene=layout` (the channel's real tab
// layout, where writing a plan opens its tab); `?theme=dark` for the dark theme.
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";

import type { Plan } from "@ace/channel/protocol";
import { Main, PlanActionsProvider, PlanView, type PlanViewProps, Layout as Shell, Timeline, TooltipProvider } from "@ace/ui";

import "./styles.css";

import { CHAT, Layout } from "./layout/layout";
import { planCards, planView } from "./plan-card";
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
			approve: { onApprove: () => {}, approving: false, error: "The plan changed since you read it." },
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
