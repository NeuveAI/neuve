import { expect, test } from "bun:test";

import { schema } from "../src/components/rich-text/schema";
import { fallback } from "../src/components/blocks/parse";
import { parse, serialize } from "../src/lib/markdown";

const line = (...nodes: Parameters<typeof schema.nodes.paragraph.create>[1][]) =>
	serialize(schema.node("doc", null, [schema.nodes.paragraph.create(null, nodes.flat())]));
const words = (value: string) => schema.text(value);
const agent = schema.nodes.mention.create({ name: "reviewer", id: "3" });
const person = schema.nodes.mention.create({ name: "vivienne" });

// Why: the channel and the timeline read a mention only after a space or a line's start. Text typed
// right before a chip was sent glued to it ("ask@reviewer"), so the posted message showed no mention.
test("a mention after text is sent apart from it, an agent's and a person's alike", () => {
	expect(line(words("ask"), agent, words(" to hold it"))).toBe("ask @reviewer to hold it");
	expect(line(words("thanks"), person)).toBe("thanks @vivienne");
	expect(line(agent, person)).toBe("@reviewer @vivienne");
});

// Why: the space goes before a bold mention's markers. Inside them, "ask** @vivienne**" is no
// bold text in markdown, so the person saw the asterisks.
test("a space before a formatted mention goes outside its formatting", () => {
	const bold = [schema.marks.strong.create()];
	expect(line(words("ask"), person.mark(bold), words(" now"))).toBe("ask **@vivienne** now");
	expect(line(schema.text("ask", bold), person.mark(bold))).toBe("**ask @vivienne**");
});

test("a mention already apart from the text before it is sent as written", () => {
	expect(line(agent, words(" hold it"))).toBe("@reviewer hold it");
	expect(line(words("ask "), agent)).toBe("ask @reviewer");
});

const draft = (text: string) => {
	const names: string[] = [];
	parse(text, [
		{ name: "reviewer", id: "3", agent: { chat: 3, role: "reviewer", name: "Reviewer", state: "running" } },
		{ name: "vivienne" },
	]).descendants((node) => {
		if (node.type === schema.nodes.mention) names.push(node.attrs.name);
	});
	return names;
};

// Why: text alone never mentions an agent. A queued message Stop returns to the composer comes back
// as text, so rebuilding chips from it would turn a typed "@reviewer" into a mention that reaches the
// agent when the person sends it again.
test("a draft rebuilt from text gets back people's mentions and none of an agent's", () => {
	expect(draft("@reviewer hold it, @vivienne")).toEqual(["vivienne"]);
});

// The parser measures words to lay them out; any width does for which nodes it makes.
Object.assign(globalThis, {
	OffscreenCanvas: class {
		getContext() {
			return { font: "", measureText: (text: string) => ({ width: text.length }) };
		}
	},
});

const drawn = (named?: string[]) =>
	fallback("@reviewer hold it, @vivienne", undefined, undefined, false, named).flatMap((block) =>
		block.kind === "paragraph"
			? block.lines.flatMap((line) => line.nodes.flatMap((node) => node.kind === "mention" ? [node.name] : []))
			: []
	);

// Why: a message's parts say who it reached. Without them every "@name" is drawn as a mention,
// so an agent the message never reached would look mentioned.
test("a text with mention parts draws only those names as mentions", () => {
	expect(drawn()).toEqual(["reviewer", "vivienne"]);
	expect(drawn(["vivienne"])).toEqual(["vivienne"]);
});
