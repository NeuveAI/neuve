import { expect, test } from "bun:test";

import { changeOf } from "../src/components/plan/plan-comments";

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
	expect(change.in).toBe("five");
	expect(change.lead + change.in + change.tail).toBe(
		"A failed export is retried on its own, up to five times, and the person sees why.",
	);
	expect(change.lead.length).toBe(change.at[0]);
});

test("a removed passage with nothing in its place shows only what was taken out", () => {
	let change = changeOf(line("- Exports that failed before this change", 15), []);
	expect(change).toMatchObject({ out: "Exports that failed before this change", in: "", lead: "", tail: "" });
});

test("words added at the end of a line show as added, the rest as shared", () => {
	let change = changeOf(line("- The failure reason on the export row"), line("- The failure reason on the export row and in its log"));
	expect(change).toMatchObject({ lead: "The failure reason on the export row ", out: "", in: "and in its log" });
});
