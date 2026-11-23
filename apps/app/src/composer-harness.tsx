// Dev-only page (composer.html, served by `vite` but not built): the chat's real composer against a
// stand-in host. `?scene=unoffered` stores a model the channel no longer offers, `?scene=offered`
// one it offers; each ask is logged to the console; `?theme=dark` for the dark theme.
import { createRoot } from "react-dom/client";

import type { ModelOption, ModelRef } from "@ace/channel/protocol";
import type { Listing } from "@ace/host/protocol";
import { Toaster, TooltipProvider } from "@ace/ui";

import "./styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const USER = "vinicius@example.com";
const MODELS: ModelOption[] = [
	{ provider: "anthropic", modelId: "claude-opus-5-5", efforts: ["off", "low", "medium", "high"] },
	{ provider: "openai", modelId: "gpt-6-astra", efforts: ["off", "low", "medium", "high"] },
];
const STORED: ModelRef = params.get("scene") === "offered"
	? { provider: "openai", modelId: "gpt-6-astra" }
	: { provider: "retired", modelId: "gpt-5-legacy" };

// Answers the composer's requests as the host would, so the real gateway client carries them.
class StandInSocket extends EventTarget {
	readyState = 1;
	constructor() {
		super();
		setTimeout(() => this.dispatchEvent(new Event("open")));
	}
	send(data: string) {
		const { id, op, request } = JSON.parse(data);
		// The request as the host would receive it, for DevTools to read.
		if (request?.op === "ask") console.info("ask", JSON.stringify(request));
		const value = op !== "channel" ? [] : request.op === "models" ? MODELS : request.op === "select"
			? { model: request.model ?? MODELS[0], effort: request.effort ?? "off" }
			: {};
		setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, ok: true, value }) })));
	}
	close() {}
}
window.WebSocket = StandInSocket as unknown as typeof WebSocket;

const { Composer } = await import("./composer");
const channel = { id: "c1", name: "exports", owner: USER, state: "open" } as unknown as Listing;

createRoot(document.getElementById("root")!).render(
	<TooltipProvider>
		<main className="mx-auto flex min-h-screen max-w-[48rem] flex-col justify-end bg-background p-6 pb-32">
			<Composer
				channel={channel}
				chat={1}
				chatMode="ace"
				user={USER}
				current={STORED}
				automatic={MODELS[0]}
				busy={false}
				waiting="Send"
				shared
				ready
				onDraftLoaded={() => {}}
				returned={[]}
				members={[]}
			/>
		</main>
		<Toaster />
	</TooltipProvider>,
);
