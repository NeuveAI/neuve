import { expect, test } from "bun:test";

import { schema } from "../src/components/rich-text/schema";
import { serialize } from "../src/lib/markdown";

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

test("a mention already apart from the text before it is sent as written", () => {
	expect(line(agent, words(" hold it"))).toBe("@reviewer hold it");
	expect(line(words("ask "), agent)).toBe("ask @reviewer");
});
