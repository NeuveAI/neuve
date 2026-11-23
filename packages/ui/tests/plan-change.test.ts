import { expect, test } from "bun:test";

import { addedMarks, changeOf } from "../src/components/plan/plan-comments";

const line = (text: string, number = 5) => [{ line: number, text }];

// Why: when a revision rewrites a commented passage, the card and the plan show the person what was
// taken out and what replaced it. Showing whole lines hides a one-word change; cutting inside a word
// shows "thr|ee" against "fi|ve", which reads as noise.
test("a changed word shows whole, between the words both versions share", () => {
	let change = changeOf(
		line("A failed export is retried on its own, **up to three times**, and the person sees why."),
		line("A failed export is retried on its own, **up to five times**, and the person sees why."),
	);
	expect(change.out).toBe("three");
	expect("A failed export is retried on its own, up to five times, and the person sees why.".slice(...change.at)).toBe("five");
});

test("a removed passage with nothing in its place shows only what was taken out", () => {
	let change = changeOf(line("- Exports that failed before this change", 15), []);
	expect(change).toEqual({ out: "Exports that failed before this change", at: [0, 0] });
});

test("words added at the end of a line show as added, the rest as shared", () => {
	let change = changeOf(line("- The failure reason on the export row"), line("- The failure reason on the export row and in its log"));
	expect(change.out).toBe("");
	expect("The failure reason on the export row and in its log".slice(...change.at)).toBe("and in its log");
});

// Why: a revision can rewrite two lines with an unchanged line between them. Searched for together,
// the new lines are never found in the plan, so the plan showed no tint at all for the change.
test("lines a revision put in apart from each other are tinted run by run", () => {
	let marks = addedMarks(
		[{ line: 5, text: "- three tries" }, { line: 7, text: "- logged once" }],
		[{ line: 5, text: "- five tries" }, { line: 7, text: "- logged each time" }],
	);
	expect(marks.map(({ lines, at }) => [lines.map((line) => line.line), at])).toEqual([[[5], undefined], [[7], undefined]]);
	let one = addedMarks([{ line: 5, text: "up to three times" }], [{ line: 5, text: "up to five times" }]);
	expect(one).toEqual([{ lines: [{ line: 5, text: "up to five times" }], at: [6, 10] }]);
});
