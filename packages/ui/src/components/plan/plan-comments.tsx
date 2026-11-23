import type { CommentThreadState } from "@neuve/review-rules/comment-thread";
import { type FileLine, fileLines, type FileLinesPlacement, matchesFileLines, plainLines } from "@neuve/review-rules/file-lines-anchor";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { IconMessage } from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";

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

/** The composer's `scroll-my-3.5`, kept clear above and below it in the pane. */
const SCROLL_MARGIN = 14;

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
export function selectionIn(root: HTMLElement, text: string): (PlanSelection & { first: DOMRect; last: DOMRect }) | undefined {
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
	let whole = range.getBoundingClientRect();
	return { lines, quote, first: rects[0] ?? whole, last: rects[rects.length - 1] ?? whole };
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
	// The plan's own lines are apart: list items and paragraphs inside one block are joined by a space.
	let line: Element | null | undefined;
	let apart = () => {
		if (text && !text.endsWith(" ")) {
			text += " ";
			chars.push(chars.at(-1)!);
		}
	};
	for (let block of blocks) {
		let walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) =>
				node.parentElement?.closest("[aria-hidden], [data-plan-comment]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
		});
		for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
			let inner = node.parentElement?.closest("[data-lines]");
			if (inner !== line) apart();
			line = inner;
			for (let offset = 0; offset < node.data.length; offset++) {
				let char = /\s/.test(node.data[offset]!) ? " " : node.data[offset]!;
				if (char === " " && text.endsWith(" ")) continue;
				text += char;
				chars.push({ node, offset });
			}
		}
		apart();
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

const words = (lines: FileLine[]) => plainLines(lines);
const inWord = (text: string, index: number) => /\S/.test(text[index - 1] ?? " ") && /\S/.test(text[index] ?? " ");

/**
 * What a revision did to a passage, word by word: the words taken out, and where the words put in
 * their place sit in the added lines' words.
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
	// Spaces at the edges of what was put in belong to the words around it.
	let from = start;
	let to = after.length - end;
	while (from < to && after[from] === " ") from++;
	while (to > from && after[to - 1] === " ") to--;
	return { out: before.slice(start, before.length - end).trim(), at: [from, to] as [number, number] };
}

/**
 * What to tint of the lines a revision put in a passage's place: each run of consecutive lines on
 * its own, since lines between them that the revision kept would break a search for them all. A
 * single run is tinted word by word.
 */
export function addedMarks(removed: FileLine[], added: FileLine[]) {
	let runs: FileLine[][] = [];
	for (let line of added) {
		let run = runs.at(-1);
		if (run && run.at(-1)!.line + 1 === line.line) run.push(line);
		else runs.push([line]);
	}
	return runs
		.filter((lines) => words(lines))
		.map((lines) => ({ lines, at: runs.length === 1 ? changeOf(removed, lines).at : undefined }));
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
			} else if (placement.kind === "changed") {
				for (let { lines, at } of addedMarks(placement.removed, placement.added)) {
					mark("added", lines[0]!.line, lines.at(-1)!.line, words(lines), at);
				}
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

/**
 * The popover's enter and exit, timed by the `popover-content` slot's tokens, and none under reduced
 * motion. Written here rather than taken from `ui/popup`, whose classes the stylesheet never scans.
 */
const MOTION =
	"motion-safe:data-open:animate-in motion-safe:data-open:fade-in-0 motion-safe:data-closed:animate-out motion-safe:data-closed:fade-out-0 motion-safe:data-closed:fill-mode-forwards";

/** Calls `gone` once `element`'s exit animation has played, at once when it has none. */
function afterExit(element: Element | null, gone: () => void) {
	let running = element?.getAnimations() ?? [];
	if (!running.length) return gone();
	void Promise.allSettled(running.map((animation) => animation.finished)).then(gone);
}

/** The chip at a selection that opens the composer under its passage; `closing` plays its exit, then `onGone`. */
export function CommentChip(
	{ top, left, side, closing, onComment, onGone }: {
		top: number;
		left: number;
		side: "top" | "bottom";
		closing?: boolean;
		onComment: () => void;
		onGone: () => void;
	},
) {
	let root = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (closing) afterExit(root.current, onGone);
	}, [closing]);
	return (
		<div
			ref={root}
			data-plan-comment=""
			data-slot="popover-content"
			data-open={closing ? undefined : ""}
			data-closed={closing ? "" : undefined}
			data-side={side}
			className={cn("absolute z-10 flex", MOTION)}
			style={{ top, left }}
		>
			<Button
				variant="ghost"
				size="sm"
				className="bg-popover shadow-popover hover:bg-popover"
				// Keeps the selection: a press would otherwise collapse it before the click.
				onPointerDown={(event) => event.preventDefault()}
				onClick={onComment}
			>
				<IconMessage className="size-3.5" />
				Comment
			</Button>
		</div>
	);
}

function scrollerOf(element: HTMLElement) {
	let parent = element.parentElement;
	while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
	return parent;
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
	let [closing, setClosing] = useState(false);
	let root = useRef<HTMLDivElement>(null);
	let field = useRef<HTMLTextAreaElement>(null);
	useEffect(() => field.current?.focus({ preventScroll: true }), []);
	useLayoutEffect(() => {
		if (closing) afterExit(root.current, onCancel);
	}, [closing]);
	// The box grows with the words up to what leaves its actions in the pane, scrolls past that,
	// and the whole composer stays in view as the words or the pane change.
	let fit = () => {
		let box = field.current!;
		let element = root.current!;
		let pane = scrollerOf(element);
		box.style.height = "auto";
		let room = pane ? pane.clientHeight - (element.offsetHeight - box.offsetHeight) - 2 * SCROLL_MARGIN : Infinity;
		box.style.height = `${Math.min(box.scrollHeight, room)}px`;
		element.scrollIntoView({ block: "nearest" });
	};
	useLayoutEffect(fit, [text]);
	useEffect(() => {
		let pane = scrollerOf(root.current!);
		if (!pane) return;
		let observer = new ResizeObserver(() => fit());
		observer.observe(pane);
		return () => observer.disconnect();
	}, []);
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
			ref={root}
			data-plan-comment=""
			data-slot={popover ? "popover-content" : undefined}
			data-open={popover && !closing ? "" : undefined}
			data-closed={popover && closing ? "" : undefined}
			data-side={popover ? "bottom" : undefined}
			className={cn(
				"flex scroll-my-3.5 flex-col rounded-md has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring/30",
				popover && ["w-[420px] max-w-full rounded-(--r-popover) squircle bg-popover p-2 text-popover-foreground shadow-popover", MOTION],
			)}
		>
			<textarea
				ref={field}
				value={text}
				rows={2}
				aria-label={action}
				className="min-h-10 w-full resize-none bg-transparent px-1 pt-0.5 pb-2 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") setClosing(true);
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
				}}
			/>
			{error && <p role="alert" className="px-1 pb-1.5 text-xs leading-4 text-destructive">{error}</p>}
			<div className="flex items-center justify-end gap-1.5">
				<Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setClosing(true)}>Cancel</Button>
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

/**
 * A comment on the plan and the replies under it: the core of the review desk's thread, drawn as
 * Ace draws a surface. A changed passage shows the words the revision took out; an ambiguous one,
 * sitting at its section, shows its quote with a dashed rule.
 */
export function PlanCommentCard({ comment, actions }: { comment: PlanCommentView; actions: PlanCommentActions }) {
	let [open, setOpen] = useState<{ kind: "reply" } | { kind: "edit"; message: string }>();
	let [refused, setRefused] = useState<string>();
	// The channel keeps a comment once anything under it was delivered, so it is not offered then.
	let removable = (id: string) =>
		id !== comment.messages[0]!.id || comment.messages.slice(1).every((message) => !message.agent && message.kept);
	let { placement } = comment;
	let failed = comment.state === "failed" ? comment.failure ? `Not delivered: ${comment.failure}` : "Not delivered" : undefined;
	let out = placement.kind === "changed" ? changeOf(placement.removed, placement.added).out : "";
	let first = comment.messages[0]!.id;
	let last = comment.messages.at(-1)!;
	// The last message's Edit and Remove share the row with Reply.
	let changes = (message: PlanCommentMessageView, className?: string) =>
		message.kept && message.mine && !open && (actions.edit || actions.remove) && (
			<div className={cn("flex gap-1", className)}>
				{actions.edit && (
					<Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setOpen({ kind: "edit", message: message.id })}>
						Edit
					</Button>
				)}
				{actions.remove && removable(message.id) && (
					<Button
						variant="ghost"
						size="xs"
						className="text-muted-foreground"
						onClick={() => {
							setRefused(undefined);
							actions.remove?.(comment.id, message.id === first ? undefined : message.id)
								.catch((cause: Error) => setRefused(cause.message));
						}}
					>
						Remove
					</Button>
				)}
			</div>
		);
	let lastChanges = changes(last);
	return (
		<article
			data-plan-comment={comment.id}
			aria-label={`Comment on “${comment.quote}”`}
			className="timeline-stream-in flex w-[440px] max-w-full scroll-my-3.5 flex-col gap-1.5 overflow-hidden rounded-lg bg-popover px-2.5 py-2 text-popover-foreground shadow-surface"
		>
			{out && <s className="text-[13px] leading-5 text-muted-foreground">{out}</s>}
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
						<div key={message.id} data-plan-message={message.id} className="flex scroll-my-3.5 flex-col gap-0.5">
							<div className="flex items-start gap-2">
								<Avatar message={message} agentAvatar={actions.agentAvatar} />
								<p className="min-w-0 flex-1 text-[13px] leading-5 whitespace-pre-wrap">{message.text}</p>
							</div>
							{message !== last && changes(message, "pl-5")}
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
			{refused && <p role="alert" className="pl-7 text-xs leading-4 text-destructive">{refused}</p>}
			{(failed || lastChanges || (actions.reply && !open)) && (
				<div className="flex items-center gap-1 pl-5">
					{lastChanges}
					{failed && <p role="alert" className="min-w-0 flex-1 truncate pl-2 text-xs leading-4 text-muted-foreground">{failed}</p>}
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
