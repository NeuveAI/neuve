// Dev-only page (approvals.html, served by `vite` but not built): each kind of approval request's
// card in each state, from fixtures. `?scene=live` answers a card through a fake channel that sends
// the event after a delay, and refuses the second card; `?scene=probe` shows the reviewer's
// inputs; `?theme=dark` for the dark theme.
import { createRoot } from "react-dom/client";
import { useState } from "react";

import type { ApprovalRequest } from "@ace/channel/protocol";
import { TooltipProvider } from "@ace/ui";

import "./styles.css";

import { ApprovalCard } from "./approval";
import { approvalView } from "./approval-card";
import { fixture, KINDS, PROBES, T } from "./approval.fixtures";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const USER = "vinicius@example.com";
const name = (author: string) => author === USER ? "you" : author.split("@")[0]!;

const STATES: { label: string; state: ApprovalRequest["state"]; error?: string; mayAnswer?: boolean; sending?: "allow" }[] = [
	{ label: "Waiting", state: { kind: "open" } },
	{ label: "Sending", state: { kind: "open" }, sending: "allow" },
	{ label: "Refused", state: { kind: "open" }, error: "This request closed when its turn ended." },
	{ label: "May not answer", state: { kind: "open" }, mayAnswer: false },
	{ label: "Allowed", state: { kind: "answered", by: USER, at: T + 60_000, decision: "allow" } },
	{ label: "Denied", state: { kind: "answered", by: "alice@example.com", at: T + 60_000, decision: "deny" } },
	{ label: "Turn ended", state: { kind: "closed", reason: "turn-ended" } },
	{ label: "Withdrawn before an answer", state: { kind: "closed", reason: "runtime-resolved" } },
	{ label: "Stopped", state: { kind: "closed", reason: "stopped" } },
	{ label: "Restarted", state: { kind: "closed", reason: "restarted" } },
	{ label: "Message instead", state: { kind: "closed", reason: "message", by: USER } },
];

const request = (kind: number, state: ApprovalRequest["state"], id = `${kind}`) => fixture(KINDS[kind]!, state, id);

function Column({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col gap-2" style={{ inlineSize: 460 }}>
			<h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</h2>
			{children}
		</section>
	);
}

/** Every kind waiting, or with `?kind=<n>` that kind in every state. */
function Grid() {
	const kind = Number(params.get("kind") ?? -1);
	const cells = kind >= 0
		? STATES.map((value) => ({ label: value.label, index: kind, value }))
		: KINDS.map((item, index) => ({ label: item.label, index, value: STATES[0]! }));
	return (
		<div className="flex flex-wrap items-start gap-x-8 gap-y-4">
			{cells.map(({ label, index, value }) => (
				<Column key={label} label={label}>
					<ApprovalCard
						view={approvalView(request(index, value.state), name)}
						mayAnswer={value.mayAnswer ?? true}
						sending={value.sending}
						error={value.error}
						answer={() => {}}
					/>
				</Column>
			))}
		</div>
	);
}

/** The independent reviewer's inputs: what a card must show in full, or say it cannot. */
function Probes() {
	return (
		<div className="flex flex-wrap items-start gap-x-8 gap-y-4">
			{PROBES.map((value) => (
				<Column key={value.label} label={value.label}>
					<ApprovalCard
						view={approvalView(fixture(value), name)}
						mayAnswer
						answer={() => {}}
					/>
				</Column>
			))}
		</div>
	);
}

/** Two requests for one call; the channel sends the first's answer after a delay and refuses the second. */
function Live() {
	const [requests, setRequests] = useState([request(0, { kind: "open" }, "a"), request(3, { kind: "open" }, "b")]);
	const [sending, setSending] = useState<Record<string, "allow" | "deny" | undefined>>({});
	const [errors, setErrors] = useState<Record<string, string | undefined>>({});
	const answer = (id: string, decision: "allow" | "deny") => {
		setSending((value) => ({ ...value, [id]: decision }));
		setErrors((value) => ({ ...value, [id]: undefined }));
		setTimeout(() => {
			if (id === "b") {
				setSending((value) => ({ ...value, [id]: undefined }));
				return setErrors((value) => ({ ...value, [id]: "This request closed when its turn ended." }));
			}
			setRequests((list) =>
				list.map((value) => value.requestId === id
						? ({ ...value, state: { kind: "answered", by: USER, at: Date.now(), decision } }) as ApprovalRequest
						: value)
			);
		}, 900);
	};
	return (
		<Column label="Live">
			{requests.map((value) => (
				<ApprovalCard
					key={value.requestId}
					view={approvalView(value, name)}
					mayAnswer
					sending={value.state.kind === "open" ? sending[value.requestId] : undefined}
					error={errors[value.requestId]}
					answer={(decision) => answer(value.requestId, decision)}
				/>
			))}
			<textarea aria-label="Composer stand-in" className="rounded-xl border border-border bg-background p-3 text-sm" rows={2} />
		</Column>
	);
}

createRoot(document.getElementById("root")!).render(
	<TooltipProvider>
		<main className="min-h-screen bg-background p-8 text-foreground">
			{params.get("scene") === "live" ? <Live /> : params.get("scene") === "probe" ? <Probes /> : <Grid />}
		</main>
	</TooltipProvider>,
);
