import { expect, test } from "bun:test";

import { withMention } from "../src/timeline";

// Why: a send of plan comments quotes the plan, and the channel publishes no mention for it. If the
// timeline drew an `@name` in it as a mention, the person would read that someone was called.
test("a plan comments message draws no @name as a mention, other messages still do", () => {
	let sent = { entry: 7, invoked: true, text: "Comments on the plan.\n\n> Ask @vivienne first\n\n@neuve should @vivienne review?" };
	let drawn = withMention(sent, new Set([7]));
	expect(drawn.match(/(^|[\s([{])@[\w-]+/gm)?.map((mention) => mention.trim())).toEqual(["@neuve"]);
	expect(drawn.replaceAll("⁠", "")).toBe(`@neuve ${sent.text}`);
	expect(withMention({ entry: 8, invoked: false, text: "Ask @vivienne" }, new Set([7]))).toBe("Ask @vivienne");
});
