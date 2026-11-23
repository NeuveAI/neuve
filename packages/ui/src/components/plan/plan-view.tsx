import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { plainText } from "@neuve/review-rules/file-lines-anchor";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { PlanCardView } from "../../types";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { PlanBadge } from "../requests/plan";
import {
	AfterBlock,
	CommentChip,
	CommentComposer,
	keptCount,
	type PlanCommentActions,
	PlanCommentCard,
	type PlanSelection,
	selectionIn,
	usePlanHighlights,
} from "./plan-comments";

const md = new MarkdownIt({ html: false, linkify: false });

type Node = { token: Token; children: Node[] };

/** Nests markdown-it's flat open and close tokens into a tree. */
function tree(tokens: Token[]): Node[] {
	let root: Node[] = [];
	let stack: Node[][] = [root];
	for (let token of tokens) {
		if (token.nesting === -1) {
			stack.pop();
			continue;
		}
		let node: Node = { token, children: token.children ? tree(token.children) : [] };
		stack.at(-1)!.push(node);
		if (token.nesting === 1) stack.push(node.children);
	}
	return root;
}

function safe(href: string | null) {
	return href && /^https?:\/\//i.test(href) ? href : undefined;
}

function inline(nodes: Node[]): ReactNode[] {
	return nodes.map(({ token, children }, index) => {
		switch (token.type) {
			case "text":
				return token.content;
			case "code_inline":
				return <code key={index} className="rounded-sm bg-muted px-1 font-mono text-[0.9em]">{token.content}</code>;
			case "strong_open":
				return <strong key={index} className="font-semibold">{inline(children)}</strong>;
			case "em_open":
				return <em key={index}>{inline(children)}</em>;
			case "s_open":
				return <s key={index}>{inline(children)}</s>;
			case "link_open": {
				let href = safe(token.attrGet("href"));
				return href
					? <a key={index} href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{inline(children)}</a>
					: <span key={index}>{inline(children)}</span>;
			}
			case "softbreak":
				return " ";
			case "hardbreak":
				return <br key={index} />;
			default:
				return token.content;
		}
	});
}

/** Each block keeps the plan file's lines it came from, for later comments anchored to them. */
function lines(token: Token) {
	return token.map ? `${token.map[0] + 1}-${token.map[1]}` : undefined;
}

/** What to show after a block: comments placed at it, keyed by the block's node. */
type After = ReadonlyMap<Node, ReactNode[]>;

/** The innermost block holding `line`; a table and a list item's words are each one block. */
function blockAt(nodes: Node[], line: number): Node | undefined {
	for (let node of nodes) {
		let map = node.token.map;
		if (!map || node.token.type === "inline" || line <= map[0] || line > map[1]) continue;
		let inner = node.token.type === "table_open" ? undefined : blockAt(node.children, line);
		// A list item's own words are its paragraph; what follows them goes under the item.
		return node.token.type === "list_item_open" && inner?.token.type === "paragraph_open" ? node : inner ?? node;
	}
}

/** The section heading whose words are `section`, as the anchor rule names a section. */
function headingFor(nodes: Node[], section: string): Node | undefined {
	for (let node of nodes) {
		if (node.token.type === "heading_open" && plainText(node.children[0]?.token.content ?? "") === section) return node;
		let found = headingFor(node.children, section);
		if (found) return found;
	}
}

/** Where something goes after the plan's blocks: at the block of a line, or under a section. */
export type PlanSlot = { key: string; at: { line: number } | { section: string }; node: ReactNode };

function place(nodes: Node[], slots: PlanSlot[]) {
	let after = new Map<Node, ReactNode[]>();
	let top: ReactNode[] = [];
	for (let slot of slots) {
		let node = "line" in slot.at ? blockAt(nodes, slot.at.line) : headingFor(nodes, slot.at.section);
		let item = <Fragment key={slot.key}>{slot.node}</Fragment>;
		if (node) after.set(node, [...after.get(node) ?? [], item]);
		else top.push(item);
	}
	return { after, top };
}

/** `start` numbers an ordered list's items from the plan's own first number. */
function blocks(nodes: Node[], after: After, start?: number): ReactNode[] {
	return nodes.map((node, index) => {
		let element = block(node, index, after, start);
		let placed = after.get(node);
		return placed && node.token.type !== "list_item_open"
			? <Fragment key={index}>{element}<AfterBlock>{placed}</AfterBlock></Fragment>
			: element;
	});
}

function block(node: Node, index: number, after: After, start?: number): ReactNode {
	let { token, children } = node;
	let line = lines(token);
	switch (token.type) {
		case "heading_open":
			return token.tag === "h1"
				? <h2 key={index} data-lines={line} className="pt-3.5 pb-1 text-base leading-[22px] font-semibold">{inline(children[0]?.children ?? [])}</h2>
				: <h3 key={index} data-lines={line} className="pt-3.5 pb-1 text-xs leading-5 font-semibold tracking-[0.02em] text-muted-foreground uppercase">{inline(children[0]?.children ?? [])}</h3>;
		case "paragraph_open":
			return <p key={index} data-lines={line} className="text-sm leading-5">{inline(children[0]?.children ?? [])}</p>;
		case "inline":
			return <span key={index}>{inline(children)}</span>;
		case "bullet_list_open":
			return <ul key={index} data-lines={line} className="flex flex-col">{blocks(children, after)}</ul>;
		case "ordered_list_open": {
			let first = Number(token.attrGet("start") ?? 1);
			return <ol key={index} start={first} data-lines={line} className="flex flex-col">{blocks(children, after, first)}</ol>;
		}
		case "list_item_open":
			return (
				<li key={index} data-lines={line} className="flex py-0.5 text-sm leading-5">
					<span aria-hidden className="w-[18px] shrink-0 text-muted-foreground">{start === undefined ? "•" : `${start + index}.`}</span>
					<div className="min-w-0 flex-1">
						{blocks(children, after)}
						{after.has(node) && <AfterBlock className="-ml-[18px]">{after.get(node)}</AfterBlock>}
					</div>
				</li>
			);
		case "fence":
		case "code_block":
			return <pre key={index} data-lines={line} className="my-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-5">{token.content}</pre>;
		case "blockquote_open":
			return <blockquote key={index} data-lines={line} className="border-l-2 border-border pl-3 text-muted-foreground">{blocks(children, after)}</blockquote>;
		case "hr":
			return <hr key={index} className="my-3 border-border" />;
		case "table_open":
			return (
				<div key={index} data-lines={line} className="my-1 overflow-x-auto">
					<table className="text-sm leading-5">{blocks(children, after)}</table>
				</div>
			);
		case "thead_open":
			return <thead key={index}>{blocks(children, after)}</thead>;
		case "tbody_open":
			return <tbody key={index}>{blocks(children, after)}</tbody>;
		case "tr_open":
			return <tr key={index} className="border-b border-border">{blocks(children, after)}</tr>;
		case "th_open":
		case "td_open": {
			let Cell: "th" | "td" = token.type === "th_open" ? "th" : "td";
			return <Cell key={index} className="px-2 py-1 text-left align-top">{inline(children[0]?.children ?? [])}</Cell>;
		}
		default:
			// Anything else still shows: its children, else its own text, so no part of the plan is hidden.
			return children.length
				? <div key={index} data-lines={line}>{blocks(children, after)}</div>
				: token.content
				? <p key={index} data-lines={line} className="text-sm leading-5 whitespace-pre-wrap">{token.content}</p>
				: null;
	}
}

/** The plan's Markdown, without a leading level-one heading that repeats the title. */
export function PlanDocument({ text, title, slots = [] }: { text: string; title: string; slots?: PlanSlot[] }) {
	let nodes = useMemo(() => {
		let nodes = tree(md.parse(text, {}));
		let first = nodes[0];
		let heading = first?.token.type === "heading_open" && first.token.tag === "h1"
			? first.children[0]?.token.content.trim()
			: undefined;
		return heading !== undefined && heading === title.trim() ? nodes.slice(1) : nodes;
	}, [text, title]);
	let { after, top } = place(nodes, slots);
	return (
		<div className="flex flex-col text-foreground">
			{top.length > 0 && <AfterBlock>{top}</AfterBlock>}
			{blocks(nodes, after)}
		</div>
	);
}

/** Each comment's card where its passage sits now, and the composer under the passage selected. */
function commentSlots(comments: PlanCommentActions, composing: (PlanSelection & { key: number }) | undefined, onClose: () => void): PlanSlot[] {
	let slots = comments.list.map((comment): PlanSlot => {
		let { placement } = comment;
		let at = placement.kind === "stays"
			? { line: placement.lines.at(-1)!.line }
			: placement.kind === "changed" && placement.added.length
			? { line: placement.added.at(-1)!.line }
			: { section: comment.section };
		return { key: comment.id, at, node: <PlanCommentCard comment={comment} actions={comments} /> };
	});
	if (composing && comments.keep) {
		let keep = comments.keep;
		slots.push({
			key: `composer-${composing.key}`,
			at: { line: composing.lines.at(-1)!.line },
			node: (
				<CommentComposer
					popover
					action="Comment"
					onCancel={onClose}
					onSubmit={async (text) => {
						await keep(composing, text);
						onClose();
					}}
				/>
			),
		});
	}
	return slots;
}

export type PlanViewProps = {
	plan: Pick<PlanCardView, "title" | "state" | "meta">;
	/** The plan's text; absent while it loads. */
	text?: string;
	/** Why the text could not be read. */
	error?: string;
	/** Absent once the plan is no longer a draft. */
	approve?: {
		onApprove: () => void;
		approving: boolean;
		/** Why approving is not possible now; the button then says so on hover. */
		blocked?: string;
		error?: string;
	};
	/** The comments on this plan, and what the person may do with them. */
	comments?: PlanCommentActions;
	/** Sends every comment and reply the person keeps on the plan, together. */
	send?: { onSend: () => void; sending: boolean; error?: string };
	className?: string;
};

/** The Plan tab: the plan as a document, commented on, and approved from its footer while it is a draft. */
export function PlanView({ plan, text, error, approve, comments, send, className }: PlanViewProps) {
	let paper = useRef<HTMLDivElement>(null);
	let [chip, setChip] = useState<PlanSelection & { top: number; left: number }>();
	let [composing, setComposing] = useState<PlanSelection & { key: number }>();
	usePlanHighlights(paper, comments?.list ?? [], composing, text);
	let kept = comments ? keptCount(comments.list) : 0;
	// The chip follows a finished selection of whole plan lines whose words match the file.
	let select = () => {
		let root = paper.current;
		let found = root && text !== undefined && comments?.keep ? selectionIn(root, text) : undefined;
		if (!root || !found) return setChip(undefined);
		// Under the selection's end, so it covers none of the words around the selection.
		let box = root.getBoundingClientRect();
		let left = Math.max(0, Math.min(found.rect.right - box.left - 48, root.clientWidth - 96));
		setChip({ lines: found.lines, quote: found.quote, top: found.rect.bottom - box.top + 4, left });
	};
	// A selection can end outside the plan, or by keyboard, so the document's events decide.
	let latest = useRef(select);
	latest.current = select;
	useEffect(() => {
		let finish = () => requestAnimationFrame(() => latest.current());
		let keys = (event: KeyboardEvent) => event.shiftKey && finish();
		document.addEventListener("pointerup", finish);
		document.addEventListener("keyup", keys);
		return () => {
			document.removeEventListener("pointerup", finish);
			document.removeEventListener("keyup", keys);
		};
	}, []);
	let footer = approve || (send && kept > 0);
	return (
		<section aria-label="Plan" className={cn("flex h-full min-h-0 flex-col bg-background text-foreground", className)}>
			<header className="flex shrink-0 flex-col gap-1 border-b border-border px-5 pt-3.5 pb-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<h1 className="min-w-0 truncate text-base leading-[22px] font-semibold">{plan.title || "Plan"}</h1>
					<PlanBadge state={plan.state} />
				</div>
				<p className="truncate text-xs leading-4 text-muted-foreground">{plan.meta}</p>
			</header>
			{/* Ace makes every element unselectable; the plan's words are selectable, its list markers not. */}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3.5 select-text [&_*]:select-text [&_[aria-hidden]]:select-none">
				<div ref={paper} className="relative">
					{text !== undefined
						? (
							<PlanDocument
								text={text}
								title={plan.title}
								slots={comments ? commentSlots(comments, composing, () => setComposing(undefined)) : []}
							/>
						)
						: <p role={error ? "alert" : "status"} className="pt-3.5 text-sm text-muted-foreground">{error ?? "Loading the plan…"}</p>}
					{chip && (
						<CommentChip
							top={chip.top}
							left={chip.left}
							onComment={() => {
								setComposing({ lines: chip.lines, quote: chip.quote, key: Date.now() });
								setChip(undefined);
								getSelection()?.removeAllRanges();
							}}
						/>
					)}
				</div>
			</div>
			{footer && (
				<footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
					<p role={approve?.error || send?.error ? "alert" : undefined} className="min-w-0 truncate text-xs text-muted-foreground">
						{send?.error ?? approve?.error}
					</p>
					<div className="flex shrink-0 items-center gap-2.5">
						{send && kept > 0 && (
							<Button
								variant="outline"
								className="aria-disabled:opacity-50"
								aria-disabled={send.sending || undefined}
								onClick={() => {
									if (!send.sending) send.onSend();
								}}
							>
								{send.sending ? "Sending…" : `Send ${kept} ${kept === 1 ? "comment" : "comments"}`}
							</Button>
						)}
						{approve && (
							<Button
								className="aria-disabled:opacity-50"
								aria-disabled={!!approve.blocked || approve.approving || undefined}
								title={approve.blocked}
								onClick={() => {
									if (!approve.blocked && !approve.approving) approve.onApprove();
								}}
							>
								{approve.approving ? "Approving…" : "Approve"}
							</Button>
						)}
					</div>
				</footer>
			)}
		</section>
	);
}
