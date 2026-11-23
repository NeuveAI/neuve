// Dev-only page (mentions.html, served by `vite` but not built): a thread whose composer offers the
// plan's agents. The host is a stand-in that logs each request and posts it back with its list of
// agents, as the channel will. `?refuse` refuses every mention as a paused loop's; `&mode=plan`,
// `&theme=dark`.
import { createRoot } from "react-dom/client";
import { useState } from "react";

import type { Build, BuildAgent, Request } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";
import { Timeline, Toaster, TooltipProvider } from "@ace/ui";

import "./styles.css";

import { agentAuthor, agentAuthors } from "./build-card";
import { Composer } from "./composer";
import { host } from "./host";
import { toEvents } from "./timeline";
import type { Item } from "./transcript";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const USER = "vinicius@example.com";
const T = Date.UTC(2026, 10, 23, 14, 2, 0);
const HASH = "9e1c04a7b3f25d18c6e04a9b7d21f3c58e60b4a1d9c7e2f30a5b8c1d4e7f9a2b";
const PAUSED = "The plan's agents are paused while other people may ask them.";

const agent = (chat: number, patch: Partial<BuildAgent>): BuildAgent => ({
	chat,
	role: "implementer",
	started: T,
	state: "running",
	...patch,
});

const build = (chat: number, title: string, patch: Partial<Build>): Build => ({
	id: `${chat}:${HASH}`,
	chat,
	plan: { id: `p${chat}`, hash: HASH, title, call: `write-${chat}` },
	approved: { by: USER, at: T },
	state: { kind: "started" },
	agents: [],
	...patch,
});

const BUILDS: Build[] = [
	build(1, "Retry failed exports", {
		agents: [
			agent(2, { caption: "Reading the export worker" }),
			agent(3, { role: "reviewer", state: "waiting", caption: "Asking which id to keep" }),
			agent(4, { part: "scheduler", state: "done", caption: "Moved the timer change" }),
		],
	}),
	build(7, "Document the retry policy", {
		state: { kind: "stopped", by: USER, at: T + 60_000 },
		agents: [agent(8, { part: "docs", state: "stopped", caption: "Rewriting the retry section" })],
	}),
];
const AGENTS = agentAuthors(BUILDS);
const ROLES = Object.fromEntries([...AGENTS].map(([author, value]) => [author, value.role]));

const THREAD: Item[] = [
	{ kind: "message", key: "e1", entry: 1, at: T + 2 * 60_000, author: USER, text: "@reviewer is on it already", invoked: false },
	{
		kind: "message",
		key: "e2",
		entry: 2,
		at: T + 3 * 60_000,
		author: USER,
		text: "@reviewer hold the final review until I am back",
		invoked: false,
		agents: [3],
	},
	{
		kind: "message",
		key: "e3",
		entry: 3,
		at: T + 9 * 60_000,
		author: agentAuthor(3),
		text: "Holding the final review until you are back.",
		invoked: false,
	},
];

const channel = { id: "mentions", name: "exports", owner: USER, host: "mac", state: "running", created: T, project: "/p" } as Listing;

localStorage.setItem("ace:mode:/channels/mentions/1", JSON.stringify(params.get("mode") ?? "chat"));

let post: (request: Extract<Request, { op: "say" | "ask" }>) => void = () => {};
host.close();
Object.defineProperty(host, "status", { get: () => "open", set() {} });
host.channel = (async (_: string, request: Request) => {
	console.log("request", JSON.stringify(request));
	if (request.op !== "say" && request.op !== "ask") return;
	if (params.has("refuse") && request.agents) throw new Error(PAUSED);
	post(request);
}) as typeof host.channel;

function Thread() {
	let [items, setItems] = useState(THREAD);
	post = (request) =>
		setItems((list) => [
			...list,
			{
				kind: "message",
				key: `e${list.length + 1}`,
				entry: list.length + 1,
				at: T + (list.length + 10) * 60_000,
				author: USER,
				text: request.text,
				invoked: request.op === "ask",
				...(request.agents ? { agents: request.agents } : {}),
			},
		]);
	let events = toEvents(items, "mentions", false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {}, new Map(), AGENTS);
	return (
		<div className="flex h-full flex-col">
			<Timeline className="min-h-0 flex-1" events={events} currentUser={{ login: USER, own: [USER] }} roles={ROLES} />
			<div className="p-3">
				<Composer
					channel={channel}
					chat={1}
					user={USER}
					busy={false}
					waiting="Sending"
					shared={false}
					ready
					onDraftLoaded={() => {}}
					returned={[]}
					members={[{ name: "vivienne" }]}
					builds={BUILDS}
				/>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<TooltipProvider>
		<main className="flex h-dvh justify-center bg-background p-6 text-foreground">
			<div className="flex w-[600px] flex-col overflow-hidden rounded-xl border border-border">
				<Thread />
			</div>
		</main>
		<Toaster />
	</TooltipProvider>,
);
