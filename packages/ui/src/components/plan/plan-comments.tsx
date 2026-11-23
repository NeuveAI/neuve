import { type CommentThreadState, deliveryLine } from "@neuve/review-rules/comment-thread";
import { type FileLine, fileLines, type FileLinesPlacement, matchesFileLines, plainText } from "@neuve/review-rules/file-lines-anchor";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { IconMessage } from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { motion } from "../../ui/popup";

/* ─────────────────────────────────────────────────────────
 * MOTION, all of it the app's own
 *
 *    0ms   a finished selection: the Comment chip, the popover's opening
 *    0ms   the chip pressed: the composer opens under the passage as a
 *          popover does (220ms, emphasized decelerate, a short drop)
 *    0ms   a comment kept or a reply arrives: its card rises as a
 *          message does (260ms)
 *          underline, tint of what a revision put in: drawn at once, the
 *          highlight API has no transition
 * Reduced motion: the app's own rules for popovers and arriving messages.
 * ───────────────────────────────────────────────────────── */

/** One message under a comment, the comment itself first. */
export type PlanCommentMessageView = {
	id: string;
	agent: boolean;
	name: string;
	/** The person's initial; the agent shows its avatar. */
	initial: string;
	text: string;
	/** Kept with the plan and not sent yet. */
	kept: boolean;
	/** Written by the person looking, who may then edit or remove it while it is kept. */
	mine: boolean;
};

/** A comment on the plan as the Plan tab shows it. */
export type PlanCommentView = {
	id: string;
	placement: FileLinesPlacement;
	quote: string;
	section: string;
	/** Where the latest send that carried it is; absent before one. */
	state?: CommentThreadState;
	failure?: string;
	messages: PlanCommentMessageView[];
};

/** A passage the person selected: whole lines of the plan's file, and the words inside them. */
export type PlanSelection = { lines: FileLine[]; quote: string };

/** What the Plan tab's comments do; the app sends each to the channel and reports a refusal. */
export type PlanCommentActions = {
	list: PlanCommentView[];
	/** The agent the plan's chat runs, as its replies name it. */
	agent: string;
	agentAvatar?: string;
	/** Absent when this person may not comment. */
	keep?: (selection: PlanSelection, text: string) => Promise<void>;
	reply?: (comment: string, text: string) => Promise<void>;
	edit?: (comment: string, reply: string | undefined, text: string) => Promise<void>;
	remove?: (comment: string, reply: string | undefined) => Promise<void>;
};

/** The person's words, kept and not sent yet, that one send would carry. */
export function keptCount(list: PlanCommentView[]) {
	return list.reduce((count, comment) => count + comment.messages.filter((message) => message.kept && message.mine).length, 0);
}

const LINES = /^(\d+)-(\d+)$/;

/** The plan file's lines a rendered block came from, as the plan view marks them. */
export function blockLines(element: Element): [number, number] | undefined {
	let match = LINES.exec(element.getAttribute("data-lines") ?? "");
	return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/**
 * The quote of a selection: its text without what is drawn but not the plan's (list markers,
 * comments), with each block on its own line.
 */
function quoteOf(range: Range) {
	let fragment = range.cloneContents();
	for (let hidden of fragment.querySelectorAll("[aria-hidden], [data-plan-comment]")) hidden.remove();
	for (let block of fragment.querySelectorAll("[data-lines]")) block.append("\n");
	return fragment.textContent ?? "";
}

/** The selection inside `root` as whole plan lines and a quote that matches them, or nothing. */
export function selectionIn(root: HTMLElement, text: string): (PlanSelection & { rect: DOMRect }) | undefined {
	let selection = getSelection();
	if (!selection || selection.isCollapsed || !selection.rangeCount) return;
	let range = selection.getRangeAt(0);
	let block = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest("[data-lines]");
	let start = block(range.startContainer);
	let end = block(range.endContainer);
	if (!start || !end || !root.contains(start) || !root.contains(end)) return;
	if (start.closest("[data-plan-comment]") || end.closest("[data-plan-comment]")) return;
	let first = blockLines(start)?.[0];
	let last = blockLines(end)?.[1];
	if (first === undefined || last === undefined || last < first) return;
	let quote = quoteOf(range).trim();
	let lines = fileLines(text).slice(first - 1, last);
	if (!matchesFileLines(text, lines, quote)) return;
	let rects = range.getClientRects();
	let rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
	return { lines, quote, rect };
}

/** The outermost rendered blocks in `root` that hold any of lines `first` to `last`, or the innermost. */
function blocksFor(root: HTMLElement, first: number, last: number, innermost = false) {
	let found = [...root.querySelectorAll("[data-lines]")].filter((element) => {
		let lines = blockLines(element);
		return !element.closest("[data-plan-comment]") && lines && lines[0] <= last && lines[1] >= first;
	});
	return found.filter((element) =>
		!found.some((other) => other !== element && (innermost ? element.contains(other) : other.contains(element)))
	);
}

/**
 * A range over `passage` in the blocks' text, compared with each whitespace run as one space; over
 * only its characters `from` to `to` when given.
 */
function rangeOf(blocks: Element[], passage: string, [from, to] = [0, Infinity]): Range | undefined {
	let target = passage.replace(/\s+/g, " ").trim();
	if (!target || from >= Math.min(to, target.length)) return;
	let chars: { node: Text; offset: number }[] = [];
	let text = "";
	for (let block of blocks) {
		let walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) =>
				node.parentElement?.closest("[aria-hidden], [data-plan-comment]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
		});
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			for (let offset = 0; offset < node.data.length; offset++) {
				let char = /\s/.test(node.data[offset]!) ? " " : node.data[offset]!;
				if (char === " " && text.endsWith(" ")) continue;
				text += char;
				chars.push({ node, offset });
			}
		}
		if (!text.endsWith(" ")) {
			text += " ";
			chars.push(chars.at(-1)!);
		}
	}
	let index = text.indexOf(target);
	if (index < 0) return;
	let first = chars[index + from]!;
	let last = chars[index + Math.min(to, target.length) - 1]!;
	let range = document.createRange();
	range.setStart(first.node, first.offset);
	range.setEnd(last.node, last.offset + 1);
	return range;
}

const words = (lines: FileLine[]) => plainText(lines.map((line) => line.text).join("\n"));
const inWord = (text: string, index: number) => /\S/.test(text[index - 1] ?? " ") && /\S/.test(text[index] ?? " ");

/**
 * What a revision did to a passage, word by word: the words both versions share before and after,
 * the words taken out, and the words put in their place.
 */
export function changeOf(removed: FileLine[], added: FileLine[]) {
	let before = words(removed);
	let after = words(added);
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = 0;
	while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
	// The shared parts end and begin between words, so a changed word shows whole.
	while (start > 0 && inWord(after, start)) start--;
	while (end > 0 && inWord(after, after.length - end)) end--;
	let out = before.slice(start, before.length - end).trim();
	// Spaces at the edges of what was put in belong to the words around it.
	let from = start;
	let to = after.length - end;
	while (from < to && after[from] === " ") from++;
	while (to > from && after[to - 1] === " ") to--;
	return {
		lead: after.slice(0, from),
		out,
		in: after.slice(from, to),
		tail: after.slice(to),
		/** Where the words put in sit in the added lines' words. */
		at: [from, to] as [number, number],
	};
}

const HIGHLIGHTS = { kept: "plan-comment", added: "plan-added", selected: "plan-selected" } as const;

/**
 * Marks passages in the plan with the CSS highlight API, so the plan's own markup stays as it is:
 * each comment's passage underlined, what a revision put in its place tinted, the passage being
 * commented tinted while the composer is open.
 */
export function usePlanHighlights(
	root: RefObject<HTMLElement | null>,
	list: PlanCommentView[],
	selected: PlanSelection | undefined,
	text: string | undefined,
) {
	// Marks are drawn again only when what they mark changes, not on every render of the tab.
	let key = JSON.stringify([list.map((comment) => [comment.placement, comment.quote]), selected, text]);
	useLayoutEffect(() => {
		let element = root.current;
		if (!element) return;
		// WebKit has the highlight API, underline included, from Safari 17.2. Without it the
		// passage's whole block is marked instead, so no comment's passage goes unmarked.
		let precise = typeof CSS !== "undefined" && "highlights" in CSS;
		let ranges = { kept: [] as Range[], added: [] as Range[], selected: [] as Range[] };
		let marked: [Element, string][] = [];
		let mark = (kind: keyof typeof ranges, first: number, last: number, text: string, at?: [number, number]) => {
			if (!precise) {
				for (let block of blocksFor(element, first, last, true)) marked.push([block, HIGHLIGHTS[kind]]);
				return;
			}
			let range = rangeOf(blocksFor(element, first, last), text, at);
			if (range) ranges[kind].push(range);
		};
		for (let comment of list) {
			let { placement } = comment;
			if (placement.kind === "stays") {
				mark("kept", placement.lines[0]!.line, placement.lines.at(-1)!.line, comment.quote);
			} else if (placement.kind === "changed" && placement.added.length) {
				let { added } = placement;
				mark("added", added[0]!.line, added.at(-1)!.line, words(added), changeOf(placement.removed, added).at);
			}
		}
		if (selected) mark("selected", selected.lines[0]!.line, selected.lines.at(-1)!.line, selected.quote);
		if (!precise) {
			for (let [block, name] of marked) block.setAttribute("data-plan-mark", `${block.getAttribute("data-plan-mark") ?? ""} ${name}`.trim());
			return () => {
				for (let [block] of marked) block.removeAttribute("data-plan-mark");
			};
		}
		// Every open Plan tab adds its own ranges to the one highlight of each kind, and takes them back.
		let added = (Object.keys(ranges) as (keyof typeof ranges)[]).flatMap((kind) => {
			let name = HIGHLIGHTS[kind];
			let highlight = CSS.highlights.get(name) ?? new Highlight();
			CSS.highlights.set(name, highlight);
			for (let range of ranges[kind]) highlight.add(range);
			return ranges[kind].map((range) => [highlight, range] as const);
		});
		return () => {
			for (let [highlight, range] of added) highlight.delete(range);
		};
	}, [root, key]);
}

/** The chip at a selection that opens the composer under its passage. */
export function CommentChip({ top, left, onComment }: { top: number; left: number; onComment: () => void }) {
	return (
		<Button
			variant="ghost"
			size="sm"
			data-plan-comment=""
			className={cn("absolute z-10 bg-popover shadow-popover hover:bg-popover", motion)}
			data-open=""
			data-side="bottom"
			style={{ top, left }}
			// Keeps the selection: a press would otherwise collapse it before the click.
			onPointerDown={(event) => event.preventDefault()}
			onClick={onComment}
		>
			<IconMessage className="size-3.5" />
			Comment
		</Button>
	);
}

/** A text box with its two actions, as the comment composer and a reply or edit in a card. */
export function CommentComposer(
	{ action, initial = "", onCancel, onSubmit, popover }: {
		action: string;
		initial?: string;
		onCancel: () => void;
		onSubmit: (text: string) => Promise<void>;
		/** Drawn as its own surface under a passage, rather than inside a card. */
		popover?: boolean;
	},
) {
	let [text, setText] = useState(initial);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let field = useRef<HTMLTextAreaElement>(null);
	useEffect(() => field.current?.focus(), []);
	let empty = !text.trim();
	async function submit() {
		if (empty || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await onSubmit(text.trim());
		} catch (cause) {
			setError((cause as Error).message);
			setBusy(false);
		}
	}
	return (
		<div
			data-plan-comment=""
			data-slot={popover ? "popover-content" : undefined}
			data-open={popover ? "" : undefined}
			data-side={popover ? "bottom" : undefined}
			className={cn(
				"flex flex-col",
				popover && ["w-[420px] max-w-full rounded-(--r-popover) squircle bg-popover p-2 text-popover-foreground shadow-popover", motion],
			)}
		>
			<textarea
				ref={field}
				value={text}
				rows={2}
				aria-label={action}
				placeholder={popover ? "Comment on this passage" : undefined}
				className="min-h-10 w-full resize-none bg-transparent px-1 pt-0.5 pb-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") onCancel();
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
				}}
			/>
			{error && <p role="alert" className="px-1 pb-1.5 text-xs leading-4 text-destructive">{error}</p>}
			<div className="flex items-center justify-end gap-1.5">
				<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onCancel}>Cancel</Button>
				<Button size="sm" aria-disabled={empty || busy || undefined} className="aria-disabled:opacity-50" onClick={() => void submit()}>
					{action}
				</Button>
			</div>
		</div>
	);
}

function Avatar({ message, agentAvatar }: { message: PlanCommentMessageView; agentAvatar?: string }) {
	if (message.agent && agentAvatar) return <img src={agentAvatar} alt="" className="size-5 shrink-0 rounded-full" />;
	return (
		<span
			aria-hidden
			className={cn(
				"grid size-5 shrink-0 place-items-center rounded-full text-[9px] leading-5 font-semibold",
				message.agent ? "bg-foreground text-background" : "bg-muted text-(--nv-ink-2)",
			)}
		>
			{message.initial}
		</span>
	);
}

/** The passage as the revision left it: shared words, then what it took out and put in. */
function Change({ removed, added }: { removed: FileLine[]; added: FileLine[] }) {
	let change = changeOf(removed, added);
	return (
		<p className="text-[13px] leading-5">
			{change.lead}
			{change.out && <s className="text-muted-foreground">{change.out}</s>}
			{change.out && change.in && " "}
			{change.in && <span className="rounded-[3px] bg-success/16">{change.in}</span>}
			{change.tail}
		</p>
	);
}

/** What the card says under its messages: kept, on its way, or failed. */
export function commentStatus(comment: PlanCommentView, agent: string) {
	if (comment.state === "failed") return comment.failure ? `Not delivered: ${comment.failure}` : "Not delivered";
	if (comment.messages.some((message) => message.kept)) return "Not sent yet";
	return comment.state ? deliveryLine(comment.state, agent) : undefined;
}

/**
 * A comment on the plan and the replies under it: the core of the review desk's thread, drawn as
 * Ace draws a surface. A changed passage shows what was removed and what replaced it; an ambiguous
 * one, sitting at its section, shows its quote with a dashed rule.
 */
export function PlanCommentCard({ comment, actions }: { comment: PlanCommentView; actions: PlanCommentActions }) {
	let [open, setOpen] = useState<{ kind: "reply" } | { kind: "edit"; message: string }>();
	let { placement } = comment;
	let line = commentStatus(comment, actions.agent);
	let first = comment.messages[0]!.id;
	return (
		<article
			data-plan-comment=""
			aria-label={`Comment on “${comment.quote}”`}
			className="timeline-stream-in flex w-[440px] max-w-full flex-col gap-1.5 overflow-hidden rounded-lg bg-popover px-2.5 py-2 text-popover-foreground shadow-surface"
		>
			{placement.kind === "changed" && <Change removed={placement.removed} added={placement.added} />}
			{placement.kind === "ambiguous" && (
				<p className="border-l-2 border-dashed border-border pl-2 text-[13px] leading-5 text-muted-foreground">{comment.quote}</p>
			)}
			{comment.messages.map((message) =>
				open?.kind === "edit" && open.message === message.id
					? (
						<CommentComposer
							key={message.id}
							action="Save"
							initial={message.text}
							onCancel={() => setOpen(undefined)}
							onSubmit={async (text) => {
								await actions.edit?.(comment.id, message.id === first ? undefined : message.id, text);
								setOpen(undefined);
							}}
						/>
					)
					: (
						<div key={message.id} className="group/message flex items-start gap-2">
							<Avatar message={message} agentAvatar={actions.agentAvatar} />
							<p className="min-w-0 flex-1 text-[13px] leading-5 whitespace-pre-wrap">{message.text}</p>
							{message.kept && message.mine && (actions.edit || actions.remove) && (
								<span className="flex shrink-0 gap-1 opacity-0 transition-opacity duration-120 group-hover/message:opacity-100 group-focus-within/message:opacity-100 motion-reduce:transition-none">
									{actions.edit && (
										<Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setOpen({ kind: "edit", message: message.id })}>
											Edit
										</Button>
									)}
									{actions.remove && (
										<Button
											variant="ghost"
											size="xs"
											className="text-muted-foreground"
											onClick={() => void actions.remove?.(comment.id, message.id === first ? undefined : message.id)}
										>
											Remove
										</Button>
									)}
								</span>
							)}
						</div>
					)
			)}
			{open?.kind === "reply" && (
				<CommentComposer
					action="Reply"
					onCancel={() => setOpen(undefined)}
					onSubmit={async (text) => {
						await actions.reply?.(comment.id, text);
						setOpen(undefined);
					}}
				/>
			)}
			{(line || (actions.reply && !open)) && (
				<div className="flex items-center gap-2 pl-7">
					{line && (
						<p role={comment.state === "failed" ? "alert" : undefined} className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground">
							{line}
						</p>
					)}
					{actions.reply && !open && (
						<Button variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => setOpen({ kind: "reply" })}>
							Reply
						</Button>
					)}
				</div>
			)}
		</article>
	);
}

/** Cards and anything else placed after a block of the plan, set apart from its text. */
export function AfterBlock({ children, className }: { children: ReactNode; className?: string }) {
	return <div data-plan-comment="" className={cn("flex flex-col gap-2 pt-2 pb-1", className)}>{children}</div>;
}
