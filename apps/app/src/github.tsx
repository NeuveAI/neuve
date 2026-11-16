import { useEffect, useId, useState, useSyncExternalStore } from "react";

import type { GithubFilter, GithubItem, GithubKind, GithubList } from "@ace/channel/protocol";
import type { GitHubExternalRef, ReviewReceipt } from "@ace/host/extension-protocol";
import { checkoutId, type Listing } from "@ace/host/protocol";
import {
	Alert,
	AlertDescription,
	Button,
	buttonVariants,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Input,
	ProjectSidebar,
	reviewPath,
	type SessionSidebarRepo,
	useLayoutLeft,
	useLocalStorage,
	toast,
	useMedia,
} from "@ace/ui";
import {
	IconCircleCheck,
	IconExternal,
	IconHash,
	IconIssue,
	IconListTree,
	IconLoader,
	IconMerge,
	IconPullRequest,
	IconPullRequestClosed,
	IconRotate,
	IconSearch,
	IconSidebar,
	IconX,
} from "@ace/ui/icons";

import { AGENT_ALIAS } from "./agent-mention";
import { type Query, useGithub } from "./github-cache";
import { host } from "./host";
import { githubReturnList, githubReturnQuery, type GithubReturnTarget } from "./github-return";
import type { AppProject } from "./projects";
import { openReviewWhenShown, reviewChannel } from "./review-destination";
import { byBranch } from "./work";

const NAMES = { issues: "Issues", prs: "Pull requests" };
const DATE = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

type Filter = { state: GithubFilter; search: string; limit: number };
const DEFAULT_FILTER: Filter = { state: "open", search: "", limit: 50 };

const ICONS = {
	issues: { open: IconIssue, closed: IconCircleCheck, merged: IconMerge, draft: IconIssue },
	prs: {
		open: IconPullRequest,
		closed: IconPullRequestClosed,
		merged: IconMerge,
		draft: IconPullRequest,
	},
};
const COLORS = {
	issues: {
		open: "text-accent",
		closed: "text-merged",
		merged: "text-merged",
		draft: "text-muted-foreground",
	},
	prs: {
		open: "text-accent",
		closed: "text-destructive",
		merged: "text-merged",
		draft: "text-muted-foreground",
	},
};

function useGithubFilter(kind: GithubKind, project: AppProject) {
	return useLocalStorage<Filter>(
		`ace:github-filter:${host.url}:${checkoutId(project.host, project.path)}:${kind}`,
		DEFAULT_FILTER,
	);
}

export function GithubSidebar(
	{ kind, project, repos, connected, onProject, onRemove, onOpen, onClone, onClearTarget }: {
		kind: GithubKind;
		project: AppProject;
		repos: SessionSidebarRepo[];
		connected: boolean;
		onProject: (id: string) => void;
		onRemove: (repo: SessionSidebarRepo) => void;
		onOpen: () => void;
		onClone: () => void;
		onClearTarget?: () => void;
	},
) {
	const [filter, setFilter] = useGithubFilter(kind, project);
	const left = useLayoutLeft();
	const phone = useMedia("(width < 40rem)");
	return (
		<ProjectSidebar
			className="min-h-0 w-full min-w-0 flex-1 bg-transparent"
			projectName={project.label}
			repos={repos}
			selectedRepoId={project.id}
			onRepoChange={(repo) => onProject(repo.id)}
			onRepoRemove={onRemove}
			onAddRepo={connected ? onOpen : undefined}
			onCloneRepo={connected ? onClone : undefined}
		>
			<h2 className="px-3 pt-2 pb-1.5 text-xs font-medium text-muted-foreground">{NAMES[kind]}</h2>
			<nav className="flex flex-col gap-0.5 px-1.5" aria-label={`${NAMES[kind]} state`}>
				{(["open", "closed", "all"] as const).map((state) => {
					const Icon = state === "all" ? IconListTree : ICONS[kind][state];
					return (
						<Button
							key={state}
							variant="ghost"
							size="sm"
							className="h-7.5 justify-start gap-2 rounded-lg border border-transparent px-2 text-muted-foreground aria-pressed:selected-surface aria-pressed:bg-popover/35 aria-pressed:text-accent-text aria-pressed:hover:text-accent-text dark:aria-pressed:bg-black/32"
							aria-pressed={filter.state === state}
							onClick={() => {
								setFilter({ ...filter, state, limit: 50 });
								onClearTarget?.();
								if (phone) left.setOpen(false);
							}}
						>
							<Icon className="size-4" aria-hidden />
							{state[0]!.toUpperCase() + state.slice(1)}
						</Button>
					);
				})}
			</nav>
		</ProjectSidebar>
	);
}

export function StateIcon({ item }: { item: Pick<GithubItem, "kind" | "state"> }) {
	const Icon = ICONS[item.kind][item.state];
	const color = COLORS[item.kind][item.state];
	return <Icon className={`size-4 shrink-0 ${color}`} aria-hidden />;
}

function Notice({ error, loading, empty, onRetry }: {
	error?: string;
	loading?: boolean;
	empty: string;
	onRetry: () => void;
}) {
	return (
		<div
			className="flex flex-col items-center justify-center gap-3 px-5 py-16 text-center text-sm text-muted-foreground"
			role={error ? "alert" : "status"}
		>
			{loading && !error && <IconLoader className="size-5 animate-spin" aria-hidden />}
			<p>{error || (loading ? "Loading from GitHub…" : empty)}</p>
			{error && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
		</div>
	);
}

function Refresh({ loading, onClick }: { loading: boolean; onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Refresh from GitHub"
			disabled={loading}
			onClick={onClick}
		>
			<IconRotate className={loading ? "animate-spin" : ""} aria-hidden />
		</Button>
	);
}

function Labels({ labels }: Pick<GithubItem, "labels">) {
	return labels.map((label) => (
		<span
			key={label.name}
			className="inline-flex max-w-48 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
		>
			<span
				className="size-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: `#${label.color}` }}
			/>
			<span className="truncate">{label.name}</span>
		</span>
	));
}

const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const WHEN = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Records' references are ULIDs, so each one carries the moment Records accepted the review. */
function accepted(reference: string): string | undefined {
	if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(reference)) return;
	let time = 0;
	for (const char of reference.slice(0, 10)) time = time * 32 + ULID.indexOf(char);
	return WHEN.format(time);
}

/** A few rows read at once, so a long list neither floods the host nor waits on one slow read. */
const READERS = 4;
let readers = 0;
const waiting: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>): Promise<T> {
	if (readers >= READERS) await new Promise<void>((resolve) => waiting.push(resolve));
	readers++;
	try {
		return await run();
	} finally {
		readers--;
		waiting.shift()?.();
	}
}

/** One row's Records reviews, newest first. */
function useItemReviews(project: string, item: GitHubExternalRef) {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const [receipts, setReceipts] = useState<ReviewReceipt[]>();
	const [error, setError] = useState<string>();
	const [version, setVersion] = useState(0);
	const key = `${project}:${item.repo}:${item.kind}:${item.number}`;
	useEffect(() => {
		if (status !== "open") return;
		let active = true;
		void slot(async () => {
			if (!active) return;
			try {
				const value = await host.request<ReviewReceipt[]>({ op: "reviews", project, item });
				if (!active) return;
				setReceipts([...value].sort((a, b) => b.reference.localeCompare(a.reference)));
				setError(undefined);
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			}
		});
		return () => {
			active = false;
		};
	}, [key, status, version]);
	return { receipts, error, refresh: () => setVersion((value) => value + 1) };
}

function short(commit: string | undefined) {
	return commit?.slice(0, 7);
}

/** A failure toast's description: what went wrong as a sentence, then the next step. */
function failed(cause: unknown, next: string): string {
	const reason = (cause instanceof Error ? cause.message : String(cause)).trim();
	return `${reason}${/[.!?]$/.test(reason) ? "" : "."} ${next}`;
}

/** The review state in a row's meta line. A review never approves the change, so the title says so. */
function ReviewMeta({ receipts }: { receipts?: ReviewReceipt[] }) {
	const latest = receipts?.[0];
	if (!latest) return null;
	const commit = short(latest.head);
	const what = receipts.length === 1 ? "Neuve review" : `${receipts.length} Neuve reviews, latest`;
	const when = commit ? `at ${commit}` : accepted(latest.reference);
	return (
		<span title={`Recorded by Neuve${commit ? ` at commit ${commit}` : ""}. A review never approves the change.`}>
			· {what}{when ? ` ${when}` : ""}
		</span>
	);
}

/** Opens a past review of an item; it throws when it can't. */
type Past = (item: GithubItem, receipt: ReviewReceipt) => void;

function ReviewActions({ item, reviews, described, disabled, onReview, onPast }: {
	item: GitHubExternalRef;
	reviews: ReturnType<typeof useItemReviews>;
	described: string;
	disabled: boolean;
	onReview?: () => void;
	/** Opens a past review in this item's channel's Review tab; it throws when it can't. */
	onPast: (receipt: ReviewReceipt) => void;
}) {
	const { receipts, error, refresh } = reviews;
	const pull = item.kind === "pull-request";

	function open(receipt: ReviewReceipt) {
		try {
			onPast(receipt);
		} catch (cause) {
			toast.error("Could not open the review", {
				description: failed(cause, "Try again, or open it from the pull request's channel."),
				action: { label: "Try again", onClick: () => open(receipt) },
			});
		}
	}

	// Issues keep the history only once a review links to them; pull requests also keep it to show a failed read.
	const history = !!receipts?.length || (pull && !!error);
	return (
		<>
			{pull && onReview && (
				<Button
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
					aria-label="Review with Neuve"
					aria-describedby={described}
					disabled={disabled}
					onClick={onReview}
				>
					{/* A phone's row keeps the room for the title, as the other actions do with their icons. */}
					<span className="sm:hidden">Review</span>
					<span className="hidden sm:inline">Review with Neuve</span>
				</Button>
			)}
			{history && (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								className="text-muted-foreground"
								aria-label="Neuve review history"
								aria-describedby={described}
							/>
						}
					>
						<IconListTree aria-hidden />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="inline-auto min-inline-60">
						{error
							? <DropdownMenuItem onClick={refresh}>Couldn't read review history. Try again</DropdownMenuItem>
							: receipts?.map((receipt) => (
								<DropdownMenuItem key={receipt.reference} onClick={() => open(receipt)}>
									<span className="flex min-w-0 flex-1 justify-between gap-4">
										<span className="truncate">
											{short(receipt.head) ? `Commit ${short(receipt.head)}` : `Review ${receipt.reference.slice(-6)}`}
										</span>
										<span className="shrink-0 text-muted-foreground tabular-nums">{accepted(receipt.reference)}</span>
									</span>
								</DropdownMenuItem>
							))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</>
	);
}

function Item({ item, busy, onChannel, onPast, project, id }: {
	project: string;
	item: GithubItem;
	busy: boolean;
	onChannel?: (item: GithubItem, text?: string) => void;
	onPast: Past;
	id: string;
}) {
	const ref = itemRef(item);
	const reviews = useItemReviews(project, ref);
	const described = `${id}-${item.number}`;
	return (
		<li className="group/row flex items-start gap-3 px-4 py-4 hover:bg-muted/40 has-focus-visible:bg-muted/40 sm:px-6">
			<span className="pt-0.5">
				<StateIcon item={item} />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-1.5">
				<a
					id={described}
					href={item.url}
					target="_blank"
					rel="noopener noreferrer"
					className="self-start rounded-sm text-sm font-medium text-pretty outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/30"
				>
					{item.title}
				</a>
				<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					<span>#{item.number}</span>
					<span className="capitalize">{item.state}</span>
					<span>by {item.author}</span>
					<span>· Updated {DATE.format(new Date(item.updated))}</span>
					<ReviewMeta receipts={reviews.receipts} />
				</span>
				{item.labels.length > 0 && (
					<span className="flex flex-wrap gap-1">
						<Labels labels={item.labels} />
					</span>
				)}
			</span>
			{/* Opacity keeps the actions in the tab order; devices without hover always show them. */}
			<span className="-my-0.5 flex shrink-0 items-center gap-0.5 transition-opacity duration-150 motion-reduce:transition-none notouch:opacity-0 notouch:group-hover/row:opacity-100 notouch:group-focus-within/row:opacity-100">
				<ReviewActions
					item={ref}
					reviews={reviews}
					described={described}
					disabled={busy}
					onReview={onChannel && (() => onChannel(item, review(item)))}
					onPast={(receipt) => onPast(item, receipt)}
				/>
				{onChannel && (
					<Button
						variant="ghost"
						size="sm"
						className="text-muted-foreground"
						aria-label="Open in a channel"
						aria-describedby={described}
						disabled={busy}
						onClick={() => onChannel(item)}
					>
						<IconHash aria-hidden />
						<span className="hidden sm:inline">Open in a channel</span>
					</Button>
				)}
				<a
					href={item.url}
					target="_blank"
					rel="noopener noreferrer"
					className={buttonVariants({
						variant: "ghost",
						size: "sm",
						className: "text-muted-foreground",
					})}
					aria-label="Open on GitHub"
					// WebKit skips links on Tab unless macOS keyboard navigation is on.
					tabIndex={0}
					aria-describedby={described}
				>
					<IconExternal aria-hidden />
					<span className="hidden sm:inline">Open on GitHub</span>
				</a>
			</span>
		</li>
	);
}

function Items({ items, busy, onChannel, onPast, project }: {
	project: string;
	items: GithubItem[];
	busy: boolean;
	onChannel?: (item: GithubItem, text?: string) => void;
	onPast: Past;
}) {
	const id = useId();
	return (
		<ul className="divide-y divide-border">
			{items.map((item) => (
				<Item
					key={item.number}
					item={item}
					busy={busy}
					onChannel={onChannel}
					onPast={onPast}
					project={project}
					id={id}
				/>
			))}
		</ul>
	);
}

/** A return link that can't be followed says why above the list, with the way back to the whole list. */
function ReturnNotice({ kind, error, onClear }: { kind: GithubKind; error: string; onClear?: () => void }) {
	return (
		<Alert variant="destructive" className="m-4 flex w-auto flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:mx-6">
			<AlertDescription className="min-w-0 text-destructive/90">{error}</AlertDescription>
			{onClear && (
				<Button variant="outline" size="sm" className="shrink-0 border text-foreground" onClick={onClear}>
					Show all {NAMES[kind].toLowerCase()}
				</Button>
			)}
		</Alert>
	);
}

/** The return link's item as a filter beside the search, cleared back to the whole list. */
function ReturnChip({ kind, number, onClear }: { kind: GithubKind; number: number; onClear?: () => void }) {
	return (
		<span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-muted/40 pr-0.5 pl-2.5 text-xs">
			<span className="tabular-nums">Showing #{number}</span>
			{onClear && (
				<button
					type="button"
					aria-label={`Clear the filter and show all ${NAMES[kind].toLowerCase()}`}
					className="grid size-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none motion-reduce:transition-none"
					onClick={onClear}
				>
					<IconX className="size-3" aria-hidden />
				</button>
			)}
		</span>
	);
}

function Results({ kind, repo, data, filter, busy, onFilter, onRetry, onChannel, onPast, project }: {
	project: string;
	onPast: Past;
	kind: GithubKind;
	repo: Query<string | null>;
	data: Query<GithubList>;
	filter: Filter;
	busy: boolean;
	onFilter: (filter: Filter) => void;
	onRetry: () => void;
	onChannel?: (item: GithubItem, text?: string) => void;
}) {
	const error = repo.error || data.error;
	const loading = repo.loading || data.loading;
	if (!repo.value) {
		return (
			<Notice
				error={error}
				loading={repo.value === undefined && loading}
				empty="This project has no GitHub remote."
				onRetry={onRetry}
			/>
		);
	}
	if (!data.value?.items.length) {
		const state = filter.state === "all" ? "" : `${filter.state} `;
		const scope = filter.search ? " match your search" : " in this project";
		return (
			<Notice
				error={error}
				loading={data.value === undefined && loading}
				empty={`No ${state}${NAMES[kind].toLowerCase()}${scope}.`}
				onRetry={onRetry}
			/>
		);
	}
	return (
		<>
			{error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
			<Items items={data.value.items} busy={busy} onChannel={onChannel} onPast={onPast} project={project} />
			{data.value.more && filter.limit < 1000 && (
				<div className="flex justify-center border-t p-4">
					<Button
						variant="outline"
						disabled={loading}
						onClick={() => onFilter({ ...filter, limit: Math.min(1000, filter.limit + 50) })}
					>
						Load more
					</Button>
				</div>
			)}
			{data.value.items.length === 1000 && (
				<p className="p-4 text-center text-xs text-muted-foreground">
					Showing the first 1,000 results. Search to narrow the list.
				</p>
			)}
		</>
	);
}

export function itemRef(item: GithubItem): GitHubExternalRef {
	return { provider: "github", repo: new URL(item.url).pathname.split("/").slice(1, 3).join("/"), kind: item.kind === "prs" ? "pull-request" : "issue", number: item.number, url: item.url };
}

export function prompt(item: GithubItem): string {
	const work = item.kind === "prs"
		? "Continue this pull request on its existing branch: make the needed changes, validate them, and push them to it instead of opening a new pull request."
		: "Make the needed changes, validate them, and open or update a pull request.";
	return `Let's work on ${item.title} (${item.url}). Read the item and its discussion and inspect the project. ${work}`;
}

/**
 * The person's request that starts a review from the chat (decision 12.20): the agent answers it
 * with its pull-request review tool, and the review card appears in that chat.
 */
export function review(item: GithubItem): string {
	const ref = itemRef(item);
	return `@${AGENT_ALIAS.name} review ${ref.repo}#${ref.number}`;
}

export function Github(
	{ kind, project, localHost, user, connected, onCreate, onOpenChannel, target, onClearTarget }: {
	kind: GithubKind;
	project: AppProject;
	localHost: string;
	/** The viewer, whose own channel wins when two hosts' channels share a branch prefix. */
	user: string;
	connected: boolean;
	/** Starts a channel for the items; `onCreated` runs once it exists, just before it is shown. */
	onCreate?: (text: string, items: GitHubExternalRef[], onCreated?: () => void) => Promise<void>;
	/** Shows a channel this host already has. */
	onOpenChannel?: (channel: Listing) => void;
	target?: GithubReturnTarget;
	onClearTarget?: () => void;
}) {
	const [filter, setFilter] = useGithubFilter(kind, project);
	const [search, setSearch] = useState(filter.search);
	const [busy, setBusy] = useState(false);
	const left = useLayoutLeft();
	const repo = useGithub<string | null>({
		op: "project-repo",
		project: project.path,
		host: project.host,
	});
	const list = useGithub<GithubList>(
		!target && repo.value ? { op: "github-list", repo: repo.value, kind, ...filter } : undefined,
	);
	const selection = target ? githubReturnQuery(target, project, repo.value, localHost) : undefined;
	const detail = useGithub<unknown>(selection?.request);
	let returned: GithubList | undefined;
	let returnError = selection?.error || detail.error;
	if (selection?.request && detail.value !== undefined && !detail.error) {
		try { returned = githubReturnList(selection.request, detail.value); }
		catch (cause) { returnError = cause instanceof Error ? cause.message : String(cause); }
	}
	const data: Query<GithubList> = target
		? { value: returned, error: returnError, loading: detail.loading, refresh: detail.refresh }
		: list;
	const loading = repo.loading || data.loading;
	function refresh() {
		repo.refresh();
		if (target) detail.refresh();
		else list.refresh();
	}
	async function start(item: GithubItem, text = prompt(item), onCreated?: () => void) {
		if (!onCreate || busy) return;
		setBusy(true);
		try {
			await onCreate(text, [itemRef(item)], onCreated);
		} finally {
			setBusy(false);
		}
	}
	// A past review opens in the channel it was asked from, else the one whose lane pushed the pull
	// request; with neither, the item gets a channel as "Open in a channel" makes one, without
	// asking its agent anything.
	function past(item: GithubItem, receipt: ReviewReceipt) {
		const path = reviewPath(receipt.url);
		if (!path) throw new Error("Records gave no address for this review that Neuve can open here");
		const id = reviewChannel(receipt.url);
		const channels = host.channels.filter((value) => value.state !== "archived");
		const channel = (id ? channels.find((value) => value.id === id) : undefined)
			?? (item.head ? byBranch(channels, user).get(item.head.split("/")[0]!) : undefined);
		if (channel && onOpenChannel) {
			openReviewWhenShown(channel.id, path);
			return onOpenChannel(channel);
		}
		if (!onCreate) throw new Error("A channel for this item can't start here now");
		void start(item, "", () => openReviewWhenShown(undefined, path));
	}
	return (
		<section className="flex h-full min-h-0 flex-col bg-background">
			<header className="flex h-8 shrink-0 items-center gap-3 border-b pr-2 electrobun-webkit-app-region-drag">
				<div className="flex h-full w-8 shrink-0 items-center justify-center border-r electrobun-webkit-app-region-no-drag">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Toggle ${NAMES[kind].toLowerCase()} sidebar`}
						aria-controls="sidebar"
						aria-expanded={left.open}
						onClick={() => left.setOpen((value) => !value)}
					>
						<IconSidebar className="size-4" aria-hidden />
					</Button>
				</div>
				<h1 className="text-sm font-medium">{NAMES[kind]}</h1>
				<div className="ml-auto flex min-w-0 items-center gap-2 electrobun-webkit-app-region-no-drag">
					<span className="hidden truncate text-xs text-muted-foreground sm:block">
						{repo.value}
					</span>
					<Refresh loading={loading} onClick={refresh} />
				</div>
			</header>
			<div className="shrink-0 border-b px-4 py-3 sm:px-6">
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						setFilter({ ...filter, search: search.trim(), limit: 50 });
						onClearTarget?.();
					}}
				>
					{target?.status === "item" && <ReturnChip kind={kind} number={target.number} onClear={onClearTarget} />}
					<Input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={`Search ${NAMES[kind].toLowerCase()}…`}
						aria-label={`Search ${NAMES[kind].toLowerCase()}`}
					/>
					<Button type="submit" variant="outline" size="icon" aria-label="Search GitHub">
						<IconSearch aria-hidden />
					</Button>
				</form>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
				{target && returnError
					? <ReturnNotice kind={kind} error={returnError} onClear={onClearTarget} />
					: (
						<Results
							project={selection?.project ?? project.path}
							kind={kind}
							repo={repo}
							data={data}
							filter={filter}
							busy={busy || !connected}
							onFilter={setFilter}
							onRetry={refresh}
							onChannel={onCreate && ((item, text) => void start(item, text))}
							onPast={past}
						/>
					)}
			</div>
		</section>
	);
}
