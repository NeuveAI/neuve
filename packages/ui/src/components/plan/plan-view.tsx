import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { type ReactNode, useMemo } from "react";

import type { PlanCardView } from "../../types";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import { PlanBadge } from "../requests/plan";

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

/** `start` numbers an ordered list's items from the plan's own first number. */
function blocks(nodes: Node[], start?: number): ReactNode[] {
	return nodes.map(({ token, children }, index) => {
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
				return <ul key={index} data-lines={line} className="flex flex-col">{blocks(children)}</ul>;
			case "ordered_list_open": {
				let first = Number(token.attrGet("start") ?? 1);
				return <ol key={index} start={first} data-lines={line} className="flex flex-col">{blocks(children, first)}</ol>;
			}
			case "list_item_open":
				return (
					<li key={index} data-lines={line} className="flex py-0.5 text-sm leading-5">
						<span aria-hidden className="w-[18px] shrink-0 text-muted-foreground">{start === undefined ? "•" : `${start + index}.`}</span>
						<div className="min-w-0 flex-1">{blocks(children)}</div>
					</li>
				);
			case "fence":
			case "code_block":
				return <pre key={index} data-lines={line} className="my-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs leading-5">{token.content}</pre>;
			case "blockquote_open":
				return <blockquote key={index} data-lines={line} className="border-l-2 border-border pl-3 text-muted-foreground">{blocks(children)}</blockquote>;
			case "hr":
				return <hr key={index} className="my-3 border-border" />;
			case "table_open":
				return (
					<div key={index} data-lines={line} className="my-1 overflow-x-auto">
						<table className="text-sm leading-5">{blocks(children)}</table>
					</div>
				);
			case "thead_open":
				return <thead key={index}>{blocks(children)}</thead>;
			case "tbody_open":
				return <tbody key={index}>{blocks(children)}</tbody>;
			case "tr_open":
				return <tr key={index} className="border-b border-border">{blocks(children)}</tr>;
			case "th_open":
			case "td_open": {
				let Cell: "th" | "td" = token.type === "th_open" ? "th" : "td";
				return <Cell key={index} className="px-2 py-1 text-left align-top">{inline(children[0]?.children ?? [])}</Cell>;
			}
			default:
				// Anything else still shows: its children, else its own text, so no part of the plan is hidden.
				return children.length
					? <div key={index} data-lines={line}>{blocks(children)}</div>
					: token.content
					? <p key={index} data-lines={line} className="text-sm leading-5 whitespace-pre-wrap">{token.content}</p>
					: null;
		}
	});
}

/** The plan's Markdown, without a leading level-one heading that repeats the title. */
export function PlanDocument({ text, title }: { text: string; title: string }) {
	let nodes = useMemo(() => {
		let nodes = tree(md.parse(text, {}));
		let first = nodes[0];
		let heading = first?.token.type === "heading_open" && first.token.tag === "h1"
			? first.children[0]?.token.content.trim()
			: undefined;
		return heading !== undefined && heading === title.trim() ? nodes.slice(1) : nodes;
	}, [text, title]);
	return <div className="flex flex-col text-foreground">{blocks(nodes)}</div>;
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
	className?: string;
};

/** The Plan tab: the plan as a document, approved from its footer while it is a draft. */
export function PlanView({ plan, text, error, approve, className }: PlanViewProps) {
	return (
		<section aria-label="Plan" className={cn("flex h-full min-h-0 flex-col bg-background text-foreground", className)}>
			<header className="flex shrink-0 flex-col gap-1 border-b border-border px-5 pt-3.5 pb-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<h1 className="min-w-0 truncate text-base leading-[22px] font-semibold">{plan.title || "Plan"}</h1>
					<PlanBadge state={plan.state} />
				</div>
				<p className="truncate text-xs leading-4 text-muted-foreground">{plan.meta}</p>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3.5 select-text">
				{text !== undefined
					? <PlanDocument text={text} title={plan.title} />
					: <p role={error ? "alert" : "status"} className="pt-3.5 text-sm text-muted-foreground">{error ?? "Loading the plan…"}</p>}
			</div>
			{approve && (
				<footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2.5">
					<p role={approve.error ? "alert" : undefined} className="min-w-0 truncate text-xs text-muted-foreground">
						{approve.error}
					</p>
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
				</footer>
			)}
		</section>
	);
}
