// Why: a card that says an agent waits on the person must take them to that agent's question,
// which only that agent's view on the work log holds; the agents' conversation holds none.
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
// The card is reached only through the timeline, so it is imported from its own module.
const { BuildActionsProvider, BuildCard } = await import("../../../packages/ui/src/components/requests/build");
import type { BuildCardView } from "@ace/ui";

const view = (states: BuildCardView["agents"][number]["state"][]): BuildCardView => ({
	build: "b",
	agents: states.map((state, index) => ({ chat: index + 2, role: "implementer", name: `Agent ${index}`, state })),
	stoppable: true,
});

async function opened(card: BuildCardView) {
	const asked: (number | undefined)[] = [];
	const element = document.body.appendChild(document.createElement("div"));
	const root = createRoot(element);
	await act(async () =>
		root.render(
			<BuildActionsProvider value={{ open: (chat) => void asked.push(chat), stop: async () => {}, mayStop: true }}>
				<BuildCard view={card} width={440} />
			</BuildActionsProvider>,
		)
	);
	const button = [...element.querySelectorAll("button")].find((value) => value.textContent === "Open work log")!;
	await act(async () => button.click());
	await act(async () => root.unmount());
	element.remove();
	return asked;
}

test("Open work log goes to the waiting agent's view, and to the agents' conversation otherwise", async () => {
	expect(await opened(view(["running", "waiting", "done"]))).toEqual([3]);
	expect(await opened(view(["running", "done"]))).toEqual([undefined]);
});
