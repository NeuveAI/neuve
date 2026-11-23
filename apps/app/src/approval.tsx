import { useState } from "react";

import { Button, Code, Diff, patchFile, RequestCard, RequestCardBody, RequestCardFooter, RequestCardHead } from "@ace/ui";

import type { ApprovalCardView, ApprovalState } from "./approval-card";
import { host } from "./host";

type Decision = "allow" | "deny";

export const NOT_ALLOWED_TO_ANSWER = "Only people who may ask this channel's agents can answer";

/**
 * Sends one answer and resolves to the channel's refusal, if any. The reply is not read: the card
 * changes only when the channel's approval-requests event says so.
 */
export async function answerApproval(
	channel: string,
	chat: number,
	author: string,
	requestId: string,
	decision: Decision,
): Promise<string | undefined> {
	try {
		await host.channel(channel, { op: "approval-answer", chat, author, requestId, decision });
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
}

const TONES: Record<ApprovalState, string> = {
	open: "bg-warning/16 text-warning-strong",
	allowed: "bg-success/14 text-success",
	denied: "bg-destructive/12 text-destructive",
	closed: "bg-muted text-muted-foreground",
};
const LABELS: Record<ApprovalState, string> = {
	open: "Waiting",
	allowed: "Allowed",
	denied: "Denied",
	closed: "Closed",
};

// Every line wraps and nothing is cut off: a person allows what they read, so all of it shows.
const CODE =
	"rounded-md border border-border bg-code px-2.5 py-2 text-xs leading-[18px] [&_pre]:!whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]";

/** A file's diff in the app's diff view, or as diff text when the view would drop any of it. */
function Change({ patch }: { patch: string }) {
	const file = patchFile(patch);
	return file
		? <Diff patch={patch} file={file} hunkSeparators="metadata" overflow="wrap" />
		: <Code className={CODE} source={patch} language="diff" />;
}

/** One request's card. `sending` and `error` belong to this request's own answer. */
export function ApprovalCard({ view, mayAnswer, sending, error, answer }: {
	view: ApprovalCardView;
	mayAnswer: boolean;
	sending?: Decision;
	error?: string;
	answer: (decision: Decision) => void;
}) {
	const open = view.state === "open";
	return (
		<RequestCard aria-label={`${view.title}, ${LABELS[view.state]}`} className="mb-2 overflow-hidden">
			<RequestCardHead
				title={
					<>
						<span className="min-w-0 [overflow-wrap:anywhere]">{view.title}</span>
						<span
							className={`shrink-0 rounded-full px-1.5 text-[10px] leading-4 font-normal transition-colors duration-120 motion-reduce:transition-none ${
								TONES[view.state]
							}`}
						>
							{LABELS[view.state]}
						</span>
					</>
				}
				meta={view.meta}
			/>
			<RequestCardBody className="flex flex-col gap-2">
				{view.notes.map((note) => (
					<p key={note} className="text-xs font-medium text-warning-strong">{note}</p>
				))}
				{view.code && <Code className={CODE} source={view.code.text} language={view.code.language} />}
				{view.changes.map((change, index) => (
					<div key={index} className="flex min-w-0 flex-col gap-1">
						<p className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
							<span className="text-muted-foreground">{change.kind}</span> {change.path}
						</p>
						{change.patch && <Change patch={change.patch} />}
					</div>
				))}
				{view.rows.length > 0 && (
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
						{view.rows.map((row) => (
							<div key={row.key} className="contents">
								<dt className="text-muted-foreground">{row.key}</dt>
								<dd className="min-w-0 font-mono break-all whitespace-pre-wrap text-foreground/90">{row.value}</dd>
							</div>
						))}
					</dl>
				)}
				{view.text && <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{view.text}</p>}
				{open && view.note && <p className="text-xs text-muted-foreground">{view.note}</p>}
				<details className="text-xs" open={view.partial || undefined}>
					<summary className="cursor-pointer text-muted-foreground select-none">Details</summary>
					<Code className={`${CODE} mt-1`} source={view.details} language="json" />
				</details>
			</RequestCardBody>
			{open && (
				<RequestCardFooter className="items-center justify-between gap-3">
					<p role={error ? "alert" : undefined} className="min-w-0 text-xs text-muted-foreground">
						{error || (mayAnswer ? "" : NOT_ALLOWED_TO_ANSWER)}
					</p>
					{mayAnswer && (
						<div className="flex shrink-0 gap-1.5">
							<Button
								size="sm"
								variant="secondary"
								className="aria-disabled:opacity-50"
								aria-disabled={!!sending || undefined}
								onClick={() => !sending && answer("deny")}
							>
								{sending === "deny" ? "Denying…" : "Deny"}
							</Button>
							<Button
								size="sm"
								className="aria-disabled:opacity-50"
								aria-disabled={!!sending || undefined}
								onClick={() => !sending && answer("allow")}
							>
								{sending === "allow" ? "Allowing…" : "Allow"}
							</Button>
						</div>
					)}
				</RequestCardFooter>
			)}
		</RequestCard>
	);
}

/**
 * Answers one request. After a sent answer the buttons stay disabled until the channel's event
 * changes the request; a refusal shows its reason and lets the person answer again.
 */
export function Approval({ channel, chat, user, view, mayAnswer }: {
	channel: string;
	chat: number;
	user: string;
	view: ApprovalCardView;
	mayAnswer: boolean;
}) {
	const [sending, setSending] = useState<Decision>();
	const [error, setError] = useState<string>();
	return (
		<ApprovalCard
			view={view}
			mayAnswer={mayAnswer}
			sending={sending}
			error={error}
			answer={(decision) => {
				setSending(decision);
				setError(undefined);
				void answerApproval(channel, chat, user, view.request, decision).then((refused) => {
					if (refused === undefined) return;
					setError(refused);
					setSending(undefined);
				});
			}}
		/>
	);
}
