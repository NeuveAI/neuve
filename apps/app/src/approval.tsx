import { useState } from "react";

import { Button, Code, Diff, patchFile, RequestCard, RequestCardBody, RequestCardFooter, RequestCardHead, StatePill } from "@ace/ui";

import type { ApprovalCardView } from "./approval-card";
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

const SETTLED = {
	allowed: ["success", "Allowed"],
	denied: ["destructive", "Denied"],
	closed: ["muted", "Closed"],
} as const;

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
	if (view.state !== "open") {
		const [tone, label] = SETTLED[view.state];
		return (
			<RequestCard aria-label={`${view.title}, ${label}`} className="mb-2 overflow-hidden">
				<RequestCardHead
					title={
						<>
							<span className="min-w-0 [overflow-wrap:anywhere]">{view.title}</span>
							<StatePill tone={tone}>{label}</StatePill>
						</>
					}
					meta={view.meta}
				/>
			</RequestCard>
		);
	}
	const off = !mayAnswer || !!sending;
	return (
		<RequestCard aria-label={view.title} className="mb-2 overflow-hidden">
			<RequestCardHead title={<span className="min-w-0 [overflow-wrap:anywhere]">{view.title}</span>} />
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
						{change.to !== undefined && (
							<p className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
								<span className="text-muted-foreground">Moved to</span> {change.to}
							</p>
						)}
						{change.patch && <Change patch={change.patch} />}
					</div>
				))}
				{view.rows.length > 0 && (
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
						{view.rows.map((row, index) => (
							<div key={index} className="contents">
								<dt className="text-muted-foreground">{row.key}</dt>
								<dd className="min-w-0 font-mono break-all whitespace-pre-wrap text-foreground/90">{row.value}</dd>
							</div>
						))}
					</dl>
				)}
				{view.text !== undefined && <p className="text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{view.text}</p>}
				{view.reason !== undefined && (
					<p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{view.reason}</p>
				)}
				{view.note && <p className="text-xs text-muted-foreground">{view.note}</p>}
				<details className="text-xs" open={view.partial || undefined}>
					<summary className="cursor-pointer text-muted-foreground select-none">Details</summary>
					<Code className={`${CODE} mt-1`} source={view.details} language="json" />
				</details>
			</RequestCardBody>
			<RequestCardFooter className="items-center justify-between gap-3">
				<p role={error ? "alert" : undefined} className="min-w-0 text-xs text-muted-foreground">{error}</p>
				<div className="flex shrink-0 gap-1.5">
					<Button
						size="sm"
						variant="secondary"
						className="aria-disabled:opacity-50"
						aria-disabled={off || undefined}
						title={mayAnswer ? undefined : NOT_ALLOWED_TO_ANSWER}
						onClick={() => !off && answer("deny")}
					>
						{sending === "deny" ? "Denying…" : "Deny"}
					</Button>
					<Button
						size="sm"
						className="aria-disabled:opacity-50"
						aria-disabled={off || undefined}
						title={mayAnswer ? undefined : NOT_ALLOWED_TO_ANSWER}
						onClick={() => !off && answer("allow")}
					>
						{sending === "allow" ? "Allowing…" : "Allow"}
					</Button>
				</div>
			</RequestCardFooter>
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
