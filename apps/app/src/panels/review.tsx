import {
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import type { ReviewReceipt } from "@ace/host/extension-protocol";
import { Button, reviewPagePath, reviewPath, useResolvedTheme } from "@ace/ui";
import { IconListTree, IconLoader } from "@ace/ui/icons";

import { host } from "../host";
import { CHAT, type Content, switcher } from "../layout/layout";

/** Every message between Ace and the embedded review app carries this source. */
const SOURCE = "neuve-review";

type Props = {
	id: string;
	channel: string;
	chat: number;
	path?: string;
	title?: string;
	active: boolean;
	update: (patch: Partial<Content>) => void;
};

function back() {
	switcher.current?.show(CHAT, true);
}

/** A Review tab: Neuve's review app at `path`, or the channel's earlier reviews while it has none. */
export function Review(props: Props) {
	// Saved paths are checked as they are restored; this keeps any other from being framed.
	const path = props.path && reviewPagePath(props.path);
	if (!path) return <Earlier {...props} />;
	return <Frame {...props} path={path} />;
}

/**
 * The review app, framed from this origin. Its own route changes reach the tab as navigate
 * messages, which only save the path; a new path from a review link loads the frame again.
 */
function Frame({ id, path, title, update }: Props & { path: string }) {
	const frame = useRef<HTMLIFrameElement>(null);
	const theme = useResolvedTheme();
	// The route the frame shows, as last loaded or reported, and the load that shows it.
	const shown = useRef(path);
	const [load, setLoad] = useState({ path, key: 0 });
	// Titles name the page the frame shows, which the tab only follows on review pages. The app
	// sends a page's title just before its navigate, so a page the tab refuses has already
	// renamed it: the name before goes back, and titles wait until the frame is on a review page.
	const label = useRef({ current: title, previous: title, since: false, away: false, held: "" });

	useEffect(() => {
		if (path === shown.current) return;
		shown.current = path;
		// A review link drops the tab's title with its path, and the page it loads names the tab
		// again, even with the title it had before.
		label.current = { current: title, previous: title, since: false, away: false, held: "" };
		setLoad((load) => ({ path, key: load.key + 1 }));
	}, [path]);

	const send = useEffectEvent(() => {
		frame.current?.contentWindow?.postMessage({ source: SOURCE, type: "theme", theme }, location.origin);
	});

	useEffect(() => send(), [theme]);

	// Compared with what was last sent, since two messages can arrive before the tab renders again.
	const retitle = (next: string | undefined) => {
		if (next === label.current.current) return;
		label.current.current = next;
		update({ title: next });
	};

	const receive = useEffectEvent((event: MessageEvent) => {
		if (event.source !== frame.current?.contentWindow || event.origin !== location.origin) return;
		const data: unknown = event.data;
		if (typeof data !== "object" || data === null) return;
		const message = data as { source?: unknown; type?: unknown; path?: unknown; title?: unknown };
		if (message.source !== SOURCE) return;
		if (message.type === "escape") return back();
		if (message.type === "navigate" && typeof message.path === "string") {
			const next = reviewPagePath(message.path);
			const state = label.current;
			const titled = state.since;
			state.since = false;
			if (!next) {
				if (titled && !state.away) retitle(state.previous);
				state.away = true;
				return;
			}
			if (state.away) {
				state.away = false;
				if (state.held) retitle(state.held);
			}
			state.held = "";
			if (next === shown.current) return;
			shown.current = next;
			return update({ path: next });
		}
		if (message.type === "title" && typeof message.title === "string") {
			const next = message.title.trim().slice(0, 80) || undefined;
			const state = label.current;
			state.since = true;
			if (state.away) {
				state.held = next ?? "";
				return;
			}
			state.previous = state.current;
			retitle(next);
		}
	});

	useEffect(() => {
		const listen = (event: MessageEvent) => receive(event);
		window.addEventListener("message", listen);
		return () => window.removeEventListener("message", listen);
	}, []);

	return (
		<iframe
			key={load.key}
			ref={frame}
			data-review-frame={id}
			title={title ? `Neuve review: ${title}` : "Neuve review"}
			className="size-full min-h-0 flex-1 border-0 bg-background"
			referrerPolicy="same-origin"
			src={load.path}
			onLoad={send}
		/>
	);
}

type History =
	| { state: "loading" }
	| { state: "offline" }
	| { state: "failed"; message: string }
	| { state: "ready"; reviews: ReviewReceipt[] };

function label(receipt: ReviewReceipt) {
	return `Review ${receipt.reference.slice(-6)}${receipt.head ? ` · ${receipt.head.slice(0, 7)}` : ""}`;
}

/** The channel's earlier reviews, from Records' history for this chat. */
function Earlier({ id, channel, chat, update }: Props) {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const [history, setHistory] = useState<History>({ state: "loading" });
	const [retry, setRetry] = useState(0);

	useEffect(() => {
		if (status !== "open") return setHistory({ state: "offline" });
		let live = true;
		setHistory({ state: "loading" });
		host.request<ReviewReceipt[]>({ op: "reviews", channel, chat }).then(
			(reviews) => {
				if (live) setHistory({ state: "ready", reviews });
			},
			(cause) => {
				if (live) {
					setHistory({
						state: "failed",
						message: cause instanceof Error ? cause.message : String(cause),
					});
				}
			},
		);
		return () => void (live = false);
	}, [channel, chat, status, retry]);

	return (
		<section
			aria-labelledby={`review-history-${channel}`}
			className="flex h-full min-h-0 flex-col items-center overflow-y-auto bg-background px-4 py-10 contain-content"
		>
			<div className="flex w-full max-w-md flex-col gap-3">
				<div className="flex items-center gap-2">
					<span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
						<IconListTree aria-hidden className="size-4" />
					</span>
					<h2 id={`review-history-${channel}`} className="text-sm font-medium">
						Neuve reviews in this channel
					</h2>
				</div>
				{history.state === "loading" && (
					<p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
						<IconLoader aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
						Loading review history…
					</p>
				)}
				{history.state === "offline" && (
					<p role="status" className="text-sm text-muted-foreground">
						Connect to your host to read review history.
					</p>
				)}
				{history.state === "failed" && (
					<div role="alert" className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
						<p>{history.message}</p>
						<Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
							Retry
						</Button>
					</div>
				)}
				{history.state === "ready" && history.reviews.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No Neuve reviews yet. Ask the agent in the chat to review a branch or a pull request.
					</p>
				)}
				{history.state === "ready" && history.reviews.length > 0 && (
					<ul className="flex flex-col gap-0.5">
						{history.reviews.map((receipt) => {
							// Receipts are absolute URLs on this origin; anything else is listed, not opened.
							const path = reviewPath(receipt.url);
							return (
								<li key={receipt.reference}>
									{path
										? (
											<Button
												variant="ghost"
												className="w-full justify-start"
												onClick={() => {
													update({ path });
													requestAnimationFrame(() => {
														document.querySelector<HTMLElement>(
															`[data-review-frame="${CSS.escape(id)}"]`,
														)?.focus();
													});
												}}
											>
												<span className="min-w-0 flex-1 truncate text-left">{label(receipt)}</span>
											</Button>
										)
										: (
											<p className="px-3 py-1.5 text-sm text-muted-foreground">
												{label(receipt)}: Records gave no address this window can open.
											</p>
										)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</section>
	);
}
