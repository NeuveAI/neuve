import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanDocument } from "../src/components/plan/plan-view";

const numbers = (text: string) =>
	[...renderToStaticMarkup(<PlanDocument text={text} title="" />).matchAll(/aria-hidden="true"[^>]*>(\d+)\.</g)]
		.map((match) => Number(match[1]));

// Why: the Plan tab is the text the person approves. If it renumbered the plan's steps, the
// person would approve "step 1" while the agent builds from the file's "step 3".
test("an ordered list keeps the plan's own numbers", () => {
	expect(numbers("3. three\n4. four\n")).toEqual([3, 4]);
	expect(numbers("1. one\n2. two\n\n```\ncode\n```\n\n3. three\n")).toEqual([1, 2, 3]);
	expect(numbers("1. one\n2. two\n")).toEqual([1, 2]);
});
