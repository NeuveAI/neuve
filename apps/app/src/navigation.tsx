import { useEffect, useEffectEvent } from "react";

import {
	Nav,
	NavList,
	NavListLink,
	useLayoutLeft,
	useLayoutNav,
	useMedia,
	UserMenu,
} from "@ace/ui";
import { IconHash, IconHome, IconIssue, IconPullRequest } from "@ace/ui/icons";

import { desktop } from "./desktop";
import { share } from "./window-storage";

export type Page = "dashboard" | "channels" | "issues" | "prs";
export type PageNavigationOrigin = "startup" | "user";

export function Navigation({ page, user, github, repo, onPage, onSettings }: {
	page: Page;
	user: string;
	/** Shows the owner's GitHub avatar; initials without one. */
	github?: string;
	/** Whether the current project has a GitHub repository for Issues and Pull requests. */
	repo: boolean;
	onPage: (page: Page) => void;
	onSettings: () => void;
}) {
	return (
		<Nav
			// Until the host names its user, any initials would be a placeholder's, so Neuve's mark holds the place.
			footer={user
				? <UserMenu name={user} handle={github} side="right" onSettings={onSettings} />
				: (
					<span role="img" aria-label="Neuve" className="grid size-7.75 place-items-center">
						<span
							className="size-5 bg-muted-foreground"
							style={{ mask: "url(/favicon.svg) center / contain no-repeat" }}
						/>
					</span>
				)}
		>
			<NavList>
				<NavListLink
					href="#dashboard"
					icon={<IconHome />}
					active={page === "dashboard"}
					shortcut="⌘1"
					onClick={(event) => {
						event.preventDefault();
						onPage("dashboard");
					}}
				>
					Dashboard
				</NavListLink>
				<NavListLink
					href="#channels"
					icon={<IconHash />}
					active={page === "channels"}
					shortcut="⌘2"
					onClick={(event) => {
						event.preventDefault();
						onPage("channels");
					}}
				>
					Channels
				</NavListLink>
				{repo && (
					<>
						<NavListLink
							href="#issues"
							icon={<IconIssue className="size-4" />}
							active={page === "issues"}
							shortcut="⌘3"
							onClick={(event) => {
								event.preventDefault();
								onPage("issues");
							}}
						>
							Issues
						</NavListLink>
						<NavListLink
							href="#prs"
							icon={<IconPullRequest className="size-4" />}
							active={page === "prs"}
							shortcut="⌘4"
							onClick={(event) => {
								event.preventDefault();
								onPage("prs");
							}}
						>
							PRs
						</NavListLink>
					</>
				)}
			</NavList>
		</Nav>
	);
}

const ACTIONS = [
	"new-window",
	"project-open",
	"project-clone",
	"settings",
	"dashboard",
	"channels",
	"issues",
	"prs",
	"nav-toggle",
	"channels-toggle",
];

export function WindowControls({ onOpen, onClone, onSettings, onPage, connected }: {
	onOpen: () => void;
	onClone: () => void;
	onSettings: () => void;
	onPage: (page: Page, origin: PageNavigationOrigin) => void;
	connected: boolean;
}) {
	const nav = useLayoutNav();
	const left = useLayoutLeft();
	const wide = useMedia("(width >= 48rem)");
	const run = useEffectEvent((action: string, origin: PageNavigationOrigin = "user") => {
		switch (action) {
			case "new-window":
				share();
				return void desktop?.window();
			case "project-open":
				return onOpen();
			case "project-clone":
				return onClone();
			case "settings":
				return onSettings();
			case "dashboard":
				return onPage("dashboard", origin);
			case "channels":
				return onPage("channels", origin);
			case "issues":
				return onPage("issues", origin);
			case "prs":
				return onPage("prs", origin);
			case "nav-toggle":
				return nav.setOpen((value) => !value);
			case "channels-toggle":
				return left.setOpen((value) => !value);
		}
	});

	useEffect(() => {
		void desktop?.lights(nav.open && wide);
	}, [nav.open, wide]);

	useEffect(() => {
		const receive = (event: Event) => run(event.type.slice("ace:".length));
		for (const action of ACTIONS) window.addEventListener(`ace:${action}`, receive);
		return () => {
			for (const action of ACTIONS) window.removeEventListener(`ace:${action}`, receive);
		};
	}, []);

	useEffect(() => {
		if (desktop) return;
		function key(event: KeyboardEvent) {
			if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.defaultPrevented) return;
			const action = event.key.toLowerCase() === "b"
				? event.shiftKey ? "channels-toggle" : "nav-toggle"
				: ({
					o: "project-open",
					",": "settings",
					"1": "dashboard",
					"2": "channels",
					"3": "issues",
					"4": "prs",
				})[event.key];
			if (!action) return;
			event.preventDefault();
			run(action);
		}
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, []);

	useEffect(() => {
		if (!connected) return;
		const action = location.hash.slice(1);
		if (!ACTIONS.includes(action)) return;
		history.replaceState(null, "", location.pathname + location.search);
		run(action, "startup");
	}, [connected]);
	return null;
}
