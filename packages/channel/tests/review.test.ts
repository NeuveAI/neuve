import { afterEach, expect, test } from "bun:test";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
	JsonObject,
	ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Fixture, MODEL, OWNER } from "./helpers";
import {
	ReviewBranchInputSchema,
	ReviewPullRequestInputSchema,
	ReviewLaneInputSchema,
	ReviewLookupInputSchema,
	RefusalReasonSchema,
	reviewRefusal,
	reviewRefusals,
	refuseReview,
	ReviewRefusalError,
	type Review,
	type RefusalReason,
	type ReviewTarget,
	REVIEW_CLOSING,
	REVIEW_NO_SUBSTITUTE,
} from "../src/review";
import { ReviewCardsDoc, type ReviewCard } from "../src/review-cards";

let fixture: Fixture | undefined;
let toolErrors: unknown[] = [];
async function createFixture(
	options: Parameters<typeof Fixture.create>[0] = {},
) {
	return Fixture.create({
		...options,
		tool: (tool) => {
			const wrapped = options.tool?.(tool) ?? tool;
			return {
				...wrapped,
				async execute(args, api, context) {
					try {
						return await wrapped.execute(args, api, context);
					} catch (error) {
						if (!context.abortSignal?.aborted) toolErrors.push(error);
						throw error;
					}
				},
			};
		},
	});
}
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
	const errors = toolErrors;
	toolErrors = [];
	expect(errors).toEqual([]);
});
const id = "01JB0000000000000000000000";
const other = "01JB0000000000000000000001";
const range = {
	branch: "one/work",
	base: "a".repeat(40),
	head: "b".repeat(40),
	commits: 2,
};
const call = (name: string, args: JsonObject = {}) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const text = (value: ToolExecutionResult) =>
	value.content
		?.flatMap((item) => (item.type === "text" ? [item.text] : []))
		.join("\n") || "";
const modelValue = (value: ToolExecutionResult) =>
	JSON.parse(text(value).split("\n")[0] ?? "null");
function adapter(overrides: Partial<Review> = {}): Review {
	return {
		async prepare(target) {
			return { requestId: id, target, handoff: {}, config: {} };
		},
		async submit(prepared) {
			return {
				outcome: "admitted",
				review: prepared.requestId,
				recovered: false,
				range,
				notify: prepared.notify,
			};
		},
		async status(query) {
			return {
				review: query.review ?? id,
				state: "queued",
				new_commits: false,
			};
		},
		async outcome() {
			return { outcome: "not_finished", state: "queued" };
		},
		...overrides,
	};
}
async function ask() {
	const value = await fixture!.request<{ submission: number }>({
		op: "ask",
		author: OWNER,
		text: "Review this branch",
		model: MODEL,
	});
	expect(
		await fixture!.request<string>({
			op: "wait",
			submission: value.submission,
		}),
	).toBe("done");
}

test("the five inputs reject unknown fields and malformed comparison bases, PRs and handles", () => {
	expect(
		ReviewBranchInputSchema.parse({ notify: true, against: "main" }),
	).toEqual({ notify: true, against: "main" });
	expect(
		ReviewPullRequestInputSchema.parse({
			repo: "neuveai/neuve",
			number: 482,
			expected_head: range.head,
		}),
	).toEqual({ repo: "neuveai/neuve", number: 482, expected_head: range.head });
	expect(ReviewLaneInputSchema.parse({})).toEqual({});
	expect(ReviewLookupInputSchema.parse({ review: id })).toEqual({ review: id });
	for (const value of [
		{ against: "" },
		{ against: "a".repeat(1001) },
		{ notify: "true" },
		{ target: { kind: "lane" } },
	])
		expect(ReviewBranchInputSchema.safeParse(value).success).toBe(false);
	for (const value of [
		{ repo: "bad", number: 1 },
		{ repo: "a/b", number: 0 },
		{ repo: "a/b", number: 1.5 },
		{ repo: "a/b", number: 1, expected_head: "abc" },
		{ repo: "a/b", number: 1, expectedHead: range.head },
	])
		expect(ReviewPullRequestInputSchema.safeParse(value).success).toBe(false);
	expect(ReviewLaneInputSchema.safeParse({ against: "main" }).success).toBe(
		false,
	);
	for (const value of [
		{ review: "missing" },
		{ request: id, reference: id, job: 1, run: id },
	])
		expect(ReviewLookupInputSchema.safeParse(value).success).toBe(false);
});

const refusalFixes = {
	not_connected: "Start the Neuve workspace on this host",
	uncommitted_changes: "Commit or remove them, then ask again",
	nothing_to_review: "Commit work first, or name another comparison base",
	no_comparison_base: "Name the comparison base",
	no_lane: "Ask for a branch review instead",
	scope_mismatch: "Select this lane's scope",
	pull_request_changed: "Refresh the pull request and ask again",
	pull_request_unavailable: "Open the pull request's project on this host",
	source_moved: "Ask again; the new head will be pinned",
	too_many_references: "Remove some linked items",
	records_mismatch: "Report this to the owner; do not retry",
	not_found: "Check the review handle",
} satisfies Record<RefusalReason, string>;

const refusalCases: [RefusalReason, string[]][] = [
	[
		"not_connected",
		[
			"Neuve review host is unavailable",
			"Neuve review host disconnected",
			"Neuve review host connection timed out",
			"Neuve review host closed",
			"Neuve review is not connected on this host",
			"Native Neuve review status is unavailable on this host",
			"ENOENT: no such file or directory, open '/tmp/neuve/host.port'",
			"ENOENT: host.port",
			"Disconnected from the host",
			"Not connected to the host",
			"Malformed frame from the host (42 bytes)",
			"Native Neuve review is unavailable on this host",
			"The channel is hosted or moving",
		],
	],
	[
		"uncommitted_changes",
		[
			"The review source has 3 uncommitted or untracked paths; commit or remove them before review",
			"The review source has uncommitted or untracked paths",
		],
	],
	[
		"nothing_to_review",
		[
			"The selected range has no commits to review",
			"Lane work has no commits to review",
			"The pinned review range is unavailable or empty",
		],
	],
	[
		"no_comparison_base",
		[
			"Detached project HEAD requires an explicit against comparison base",
			"No local default comparison base is available. Supply target.against explicitly",
			"The requested comparison commit is unavailable",
			"The comparison base and HEAD have no available merge base",
		],
	],
	[
		"no_lane",
		[
			"This chat has no lane to review",
			"A lane review requires its bound lane",
		],
	],
	["scope_mismatch", ["The selected Linear scope belongs to another lane"]],
	[
		"pull_request_changed",
		[
			"This pull request changed since it was shown. Refresh it before starting review.",
		],
	],
	[
		"pull_request_unavailable",
		[
			"Open the pull request's project on this host first.",
			"The selected project does not match this pull request's base or head repository.",
			"The pull request is missing its immutable source identity.",
			"Could not acquire the pull request commit abc",
			"The exact pull request commit abc is unavailable.",
			"The pull request's immutable base and head do not have an available merge base.",
		],
	],
	[
		"source_moved",
		[
			"The review source moved after preparation; request a fresh review",
			"Lane work moved while its review was prepared; try again",
		],
	],
	[
		"too_many_references",
		["A review can reference at most 16 external items."],
	],
	[
		"records_mismatch",
		[
			"The prepared review belongs to another project or channel",
			"The review provenance does not match its caller",
			"The lane path does not belong to this channel",
			"The prepared source path does not match its target",
			"The job and run do not belong to this request",
			"Records does not hold the admitted run for this request",
			"The run receipt belongs to a different job",
			"Records admitted a job without its run identity",
			"External review context requires an explicit origin",
			"External review context must belong to an explicitly selected item",
			"This range already belongs to a cycle with different scope. Its selected scope cannot be replaced.",
			"This range already belongs to a cycle with different external context. Its pinned source cannot be replaced.",
		],
	],
	[
		"not_found",
		["Records does not hold this review request in the connected project"],
	],
];
test("every refusal reason has a tested host-path mapping and the contract's fixed fix", () => {
	expect(refusalCases.map(([reason]) => reason).sort()).toEqual(
		[...RefusalReasonSchema.options].sort(),
	);
	for (const reason of RefusalReasonSchema.options)
		expect(reviewRefusals[reason].fix).toBe(refusalFixes[reason]);
});
for (const [reason, messages] of refusalCases) {
	test(`host refusal paths map to ${reason} with its fixed fix`, () => {
		for (const target of [
			{ kind: "project-branch" },
			{ kind: "pull-request", repo: "a/b", number: 1 },
		] satisfies ReviewTarget[]) {
			const expected =
				target.kind === "pull-request" && reason === "no_comparison_base"
					? "pull_request_unavailable"
					: reason;
			for (const message of messages)
				expect(reviewRefusal(new Error(message), target)).toEqual({
					outcome: "refused",
					reason: expected,
					detail: message,
					fix: refusalFixes[expected],
				});
		}
		expect(reviewRefusal(new ReviewRefusalError(reason, "typed"))).toEqual(
			refuseReview(reason, "typed"),
		);
		expect(
			reviewRefusal({
				outcome: "refused",
				reason,
				detail: "typed",
				fix: "wrong",
			}).fix,
		).toBe(refusalFixes[reason]);
	});
}

test("every closed refusal creates an error card and prohibits a chat substitute", async () => {
	let next: RefusalReason = "not_connected";
	let executed = 0;
	fixture = await createFixture({
		review: adapter({
			async prepare() {
				throw new ReviewRefusalError(next, `Refused ${next}`);
			},
		}),
		tool: (tool) => ({
			...tool,
			async execute(args, api, context) {
				const value = await tool.execute(args, api, context);
				if (tool.name === "neuve_review_branch") {
					executed++;
					expect(value.isError).toBe(true);
					expect(modelValue(value)).toEqual(
						refuseReview(next, `Refused ${next}`),
					);
					expect(text(value)).toContain(REVIEW_NO_SUBSTITUTE);
					const card = (
						await api.snapshot(ReviewCardsDoc, api.conversationId, context)
					)?.cards[api.callId];
					expect(card).toEqual({
						kind: "refused",
						reason: next,
						...reviewRefusals[next],
						detail: `Refused ${next}`,
					});
					expect(value.details).toEqual(card);
				}
				return value;
			},
		}),
	});
	for (const reason of RefusalReasonSchema.options) {
		next = reason;
		fixture.script(
			call("neuve_review_branch"),
			fauxAssistantMessage("See refusal card"),
		);
		await ask();
	}
	expect(executed).toBe(RefusalReasonSchema.options.length);
});

test("real pi admits each start tool, writes its first card and passes notify at the host boundary", async () => {
	const names: string[] = [];
	const targets: unknown[] = [];
	const cards: ReviewCard[] = [];
	let offered: TranscriptContext | undefined;
	fixture = await createFixture({
		review: adapter({
			async prepare(target, snapshot) {
				targets.push(target);
				expect(snapshot.lane?.name).toBe("work");
				// A host request must remain outside the channel's storage transaction.
				await fixture!.request({ op: "info" });
				return { requestId: id, target, handoff: {}, config: {} };
			},
		}),
		tool: (tool) => {
			names.push(tool.name);
			return {
				...tool,
				async execute(args, api, context) {
					const value = await tool.execute(args, api, context);
					if (
						[
							"neuve_review_branch",
							"neuve_review_pull_request",
							"neuve_review_lane",
						].includes(tool.name)
					) {
						expect(value.isError).toBe(false);
						const admission = modelValue(value);
						expect(admission).toEqual({
							outcome: "admitted",
							review: id,
							recovered: false,
							range,
							notify: tool.name === "neuve_review_lane",
						});
						const card = (
							await api.snapshot(ReviewCardsDoc, api.conversationId, context)
						)?.cards[api.callId];
						expect(card?.kind).toBe("review");
						if (card?.kind !== "review")
							throw new Error("Missing admitted card");
						expect(card).toEqual({
							kind: "review",
							review: id,
							source:
								tool.name === "neuve_review_branch"
									? "branch"
									: tool.name === "neuve_review_pull_request"
										? "pull_request"
										: "lane",
							label:
								tool.name === "neuve_review_pull_request"
									? "neuveai/neuve#482"
									: tool.name === "neuve_review_branch"
										? "one/work against main"
										: "one/work against aaaaaaa",
							range,
							recovered: false,
							notify: tool.name === "neuve_review_lane",
							phase: "queued",
							stage: null,
							stages: [],
							finished: null,
							stopped: null,
							newCommits: null,
							links: null,
							updatedAt: expect.any(Number),
						});
						expect(value.details).toEqual(card);
						cards.push(card);
					}
					return value;
				},
			};
		},
	});
	fixture.script((context) => {
		offered = context;
		return call("neuve_review_branch", { against: "main" });
	}, fauxAssistantMessage("See card"));
	await ask();
	fixture.script(
		call("neuve_review_pull_request", {
			repo: "neuveai/neuve",
			number: 482,
			expected_head: range.head,
		}),
		fauxAssistantMessage("See card"),
	);
	await ask();
	fixture.script(
		call("neuve_review_lane", { notify: true }),
		fauxAssistantMessage("See card"),
	);
	await ask();
	expect(targets).toEqual([
		{ kind: "project-branch", against: "main" },
		{
			kind: "pull-request",
			repo: "neuveai/neuve",
			number: 482,
			expectedHead: range.head,
		},
		{ kind: "lane" },
	]);
	expect(cards).toHaveLength(3);
	expect(names.filter((name) => name.startsWith("neuve_review"))).toEqual([
		"neuve_review_branch",
		"neuve_review_pull_request",
		"neuve_review_lane",
		"neuve_review_status",
		"neuve_review_outcome",
	]);
	expect(JSON.stringify(offered)).toContain("MUST use the Neuve review tools");
	expect(JSON.stringify(offered)).toContain("Never substitute a chat review");
});

test("status and outcome resolve only a handle plus chat, preserve stopped as normal and end with the closing sentence", async () => {
	const queries: unknown[] = [];
	const outputs: ToolExecutionResult[] = [];
	let finished = false;
	fixture = await createFixture({
		review: adapter({
			async status(query) {
				queries.push(query);
				return query.review === other
					? refuseReview("not_found", "No such review")
					: {
							review: id,
							state: "stopped",
							stage: { done: 2, of: 5, name: "Investigate" },
							new_commits: true,
						};
			},
			async outcome(query) {
				queries.push(query);
				return finished
					? { review: id, complete: false, units: 3, gaps: 2, undecoded: 1 }
					: { outcome: "not_finished", state: "stopped" };
			},
		}),
		tool: (tool) => ({
			...tool,
			async execute(args, api, context) {
				const value = await tool.execute(args, api, context);
				if (
					["neuve_review_status", "neuve_review_outcome"].includes(tool.name)
				) {
					outputs.push(value);
					expect(text(value).endsWith(REVIEW_CLOSING)).toBe(true);
					expect(value.details).toBeUndefined();
					expect(
						await api.snapshot(ReviewCardsDoc, api.conversationId, context),
					).toBeUndefined();
				}
				return value;
			},
		}),
	});
	for (const [name, args] of [
		["neuve_review_status", {}],
		["neuve_review_status", { review: other }],
		["neuve_review_outcome", { review: id }],
	] satisfies [string, JsonObject][]) {
		fixture.script(call(name, args), fauxAssistantMessage("See card"));
		await ask();
	}
	finished = true;
	fixture.script(
		call("neuve_review_outcome"),
		fauxAssistantMessage("See card"),
	);
	await ask();
	expect(queries).toEqual([
		{ chat: 1 },
		{ review: other, chat: 1 },
		{ review: id, chat: 1 },
		{ chat: 1 },
	]);
	expect(outputs.map((value) => value.isError)).toEqual([
		false,
		true,
		false,
		false,
	]);
	expect(outputs.map(modelValue)).toEqual([
		{
			review: id,
			state: "stopped",
			stage: { done: 2, of: 5, name: "Investigate" },
			new_commits: true,
		},
		refuseReview("not_found", "No such review"),
		{ outcome: "not_finished", state: "stopped" },
		{ review: id, complete: false, units: 3, gaps: 2, undecoded: 1 },
	]);
});

test("an interrupted admitted call recovers its durable result without submitting again or resetting host progress", async () => {
	let submissions = 0;
	let seen = "";
	let interrupt = true;
	const reached = Promise.withResolvers<void>();
	const recovered: ToolExecutionResult[] = [];
	fixture = await createFixture({
		review: adapter({
			async prepare(target) {
				return {
					requestId: id,
					target,
					handoff: { against: "main" },
					config: {},
				};
			},
			async submit(prepared) {
				submissions++;
				return {
					outcome: "admitted",
					review: id,
					recovered: false,
					range,
					notify: prepared.notify,
				};
			},
		}),
		tool: (tool) => ({
			...tool,
			async execute(args, api, context) {
				const value = await tool.execute(args, api, context);
				if (tool.name === "neuve_review_branch") {
					if (interrupt) {
						interrupt = false;
						await api.commit(async (tx) => {
							const card = (await tx.doc(ReviewCardsDoc, api.conversationId))
								.cards[api.callId];
							if (card?.kind === "review") {
								card.phase = "running";
								card.stage = { done: 1, of: 5, name: "Understand" };
							}
						}, context);
						reached.resolve();
						await new Promise<void>((_resolve, reject) => {
							const signal = context.abortSignal!;
							if (signal.aborted) reject(signal.reason);
							else
								signal.addEventListener("abort", () => reject(signal.reason), {
									once: true,
								});
						});
					} else {
						recovered.push(value);
						const card = (
							await api.snapshot(ReviewCardsDoc, api.conversationId, context)
						)?.cards[api.callId];
						expect(card?.kind === "review" && card.phase).toBe("running");
						expect(card?.kind === "review" && card.recovered).toBe(true);
						expect(card?.kind === "review" && card.label).toBe(
							"one/work against main",
						);
					}
				}
				return value;
			},
		}),
	});
	fixture.script(call("neuve_review_branch", { notify: true }), (context) => {
		seen = JSON.stringify(context.messages);
		return fauxAssistantMessage("Recovered, see card");
	});
	const asked = await fixture.request<{ submission: number }>({
		op: "ask",
		author: OWNER,
		text: "Review and tell me",
		model: MODEL,
	});
	await reached.promise;
	await fixture.restart();
	expect(
		await fixture.request<string>({ op: "wait", submission: asked.submission }),
	).toBe("done");
	expect(seen).toContain('\\"recovered\\":true');
	expect(submissions).toBe(1);
	expect(recovered).toHaveLength(1);
	expect(modelValue(recovered[0]!)).toEqual({
		outcome: "admitted",
		review: id,
		recovered: true,
		range,
		notify: true,
	});
}, 15000);

test("without a host all tools remain offered and start writes a refused card", async () => {
	const installed: string[] = [];
	const outputs: ToolExecutionResult[] = [];
	fixture = await createFixture({
		tool: (tool) => {
			installed.push(tool.name);
			return {
				...tool,
				async execute(args, api, context) {
					const value = await tool.execute(args, api, context);
					if (tool.name.startsWith("neuve_review_")) outputs.push(value);
					return value;
				},
			};
		},
	});
	for (const name of [
		"neuve_review_branch",
		"neuve_review_status",
		"neuve_review_outcome",
	]) {
		fixture.script(call(name), fauxAssistantMessage("Neuve unavailable"));
		await ask();
	}
	expect(
		installed.filter((name) => name.startsWith("neuve_review_")),
	).toHaveLength(5);
	for (const value of outputs) {
		expect(value.isError).toBe(true);
		expect(modelValue(value).reason).toBe("not_connected");
		expect(text(value)).toContain(REVIEW_NO_SUBSTITUTE);
	}
});

test("child chats retain the five review tools and the mandatory instructions", async () => {
	fixture = await createFixture();
	let childContext = "";
	fixture.script(
		call("subagent", { task: "Review this branch using Neuve" }),
		(context) => {
			childContext = JSON.stringify(context);
			return call("neuve_review_branch");
		},
		fauxAssistantMessage("Neuve unavailable"),
		fauxAssistantMessage("Child reported unavailable"),
	);
	await ask();
	expect(childContext).toContain("MUST use the Neuve review tools");
	expect(childContext).toContain("neuve_review_outcome");
});

test("Records recovery before the local result memo still creates a recovered queued card", async () => {
	let captured: ToolExecutionResult | undefined;
	fixture = await createFixture({
		review: adapter({
			async submit(prepared) {
				return {
					outcome: "admitted",
					review: id,
					range,
					recovered: true,
					notify: prepared.notify,
				};
			},
		}),
		tool: (tool) => ({
			...tool,
			async execute(args, api, context) {
				const value = await tool.execute(args, api, context);
				if (tool.name === "neuve_review_branch") captured = value;
				return value;
			},
		}),
	});
	fixture.script(
		call("neuve_review_branch"),
		fauxAssistantMessage("Recovered, see card"),
	);
	await ask();
	if (!captured) throw new Error("No admission returned");
	expect(modelValue(captured).recovered).toBe(true);
	expect(captured.details).toMatchObject({
		kind: "review",
		recovered: true,
		phase: "queued",
	});
});

test("mismatched admissions and status responses cannot describe another review", async () => {
	const outputs: ToolExecutionResult[] = [];
	let notifyMismatch = false;
	fixture = await createFixture({
		review: adapter({
			async submit(prepared) {
				return {
					outcome: "admitted",
					review: notifyMismatch ? id : other,
					range,
					recovered: false,
					notify: notifyMismatch ? !prepared.notify : prepared.notify,
				};
			},
			async status() {
				return { review: other, state: "finished", new_commits: false };
			},
		}),
		tool: (tool) => ({
			...tool,
			async execute(args, api, context) {
				const value = await tool.execute(args, api, context);
				if (tool.name.startsWith("neuve_review_")) outputs.push(value);
				return value;
			},
		}),
	});
	fixture.script(
		call("neuve_review_branch"),
		fauxAssistantMessage("See refusal"),
	);
	await ask();
	notifyMismatch = true;
	fixture.script(
		call("neuve_review_branch"),
		fauxAssistantMessage("See refusal"),
	);
	await ask();
	fixture.script(
		call("neuve_review_status", { review: id }),
		fauxAssistantMessage("See refusal"),
	);
	await ask();
	expect(outputs).toHaveLength(3);
	for (const value of outputs) {
		expect(value.isError).toBe(true);
		expect(modelValue(value).reason).toBe("records_mismatch");
	}
});

test("invalid model inputs never call the host adapter", async () => {
	let prepared = 0;
	fixture = await createFixture({
		review: adapter({
			async prepare(target) {
				prepared++;
				return { requestId: id, target, handoff: {}, config: {} };
			},
		}),
	});
	for (const [name, args] of [
		["neuve_review_branch", { against: "" }],
		["neuve_review_pull_request", { repo: "a/b", number: 1.5 }],
		["neuve_review_lane", { against: "main" }],
		["neuve_review_status", { request: id, reference: id, job: 1, run: id }],
		["neuve_review_outcome", { review: "bad" }],
	] satisfies [string, JsonObject][]) {
		let response = "";
		fixture.script(call(name, args), (context) => {
			response = JSON.stringify(context.messages);
			return fauxAssistantMessage("Invalid input");
		});
		await ask();
		expect(response).toContain("isError");
		expect(response).toContain('isError":true');
	}
	expect(prepared).toBe(0);
});

test("GitHub and git fetch errors are source failures, not Neuve host disconnections", () => {
	const messages = [
		"fatal: unable to access 'https://github.com/a/b.git/': Connection timed out",
		"fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443: Connection refused",
		"fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
		"fatal: remote error: upload-pack: not our ref bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"GitHub CLI is unavailable on this host.",
		"This host's GitHub CLI is not signed in.",
		"GitHub did not respond. Try again.",
		'Get "https://api.github.com/repos/a/b/pulls/1": dial tcp: lookup api.github.com: i/o timeout',
		"GitHub CLI returned invalid JSON",
		"Connection timed out",
		"connect ECONNREFUSED github.com:443",
		"ENOENT: gh",
	];
	for (const target of [
		{ kind: "project-branch" },
		{ kind: "pull-request", repo: "a/b", number: 1 },
	] satisfies ReviewTarget[]) {
		const reason =
			target.kind === "pull-request"
				? "pull_request_unavailable"
				: "records_mismatch";
		for (const message of messages)
			expect(reviewRefusal(new Error(message), target)).toEqual({
				outcome: "refused",
				reason,
				detail: message,
				fix: refusalFixes[reason],
			});
	}
});

test("a PR without a comparison base receives an actionable PR fix, including typed host refusals", () => {
	const target = {
		kind: "pull-request",
		repo: "a/b",
		number: 1,
	} satisfies ReviewTarget;
	const detail =
		"The pull request's immutable base and head do not have an available merge base.";
	for (const cause of [
		new Error(detail),
		new ReviewRefusalError("no_comparison_base", detail),
		refuseReview("no_comparison_base", detail),
	])
		expect(reviewRefusal(cause, target)).toEqual({
			outcome: "refused",
			reason: "pull_request_unavailable",
			detail,
			fix: "Open the pull request's project on this host",
		});
});

test("card labels use pinned base names and shorten hash-only bases without changing the admission", async () => {
	const labels: string[] = [];
	let against: string | undefined;
	fixture = await createFixture({
		review: adapter({
			async prepare(target) {
				return {
					requestId: id,
					target,
					handoff: against === undefined ? {} : { against },
					config: {},
				};
			},
		}),
		tool: (tool) => ({
			...tool,
			async execute(args, api, context) {
				const value = await tool.execute(args, api, context);
				if (["neuve_review_branch", "neuve_review_lane"].includes(tool.name)) {
					const card = (
						await api.snapshot(ReviewCardsDoc, api.conversationId, context)
					)?.cards[api.callId];
					if (card?.kind !== "review") throw new Error("Missing review card");
					labels.push(card.label);
					expect(modelValue(value).range).toEqual(range);
				}
				return value;
			},
		}),
	});
	for (const [name, args, base] of [
		["neuve_review_branch", {}, "main"],
		["neuve_review_branch", {}, "refs/remotes/origin/main"],
		["neuve_review_lane", {}, "refs/heads/main"],
		["neuve_review_branch", { against: "release" }, "main"],
		["neuve_review_branch", {}, undefined],
		["neuve_review_branch", {}, range.base],
		["neuve_review_branch", { against: range.base }, range.base],
	] satisfies [string, JsonObject, string | undefined][]) {
		against = base;
		fixture.script(call(name, args), fauxAssistantMessage("See card"));
		await ask();
	}
	expect(labels).toEqual([
		"one/work against main",
		"one/work against origin/main",
		"one/work against main",
		"one/work against release",
		"one/work against aaaaaaa",
		"one/work against aaaaaaa",
		"one/work against aaaaaaa",
	]);
});

test("a typed missing-base PR refusal produces the same actionable model result and card", async () => {
	const detail =
		"The pull request's immutable base and head do not have an available merge base.";
	let captured: ToolExecutionResult | undefined;
	fixture = await createFixture({
		review: adapter({
			async submit() {
				return refuseReview("no_comparison_base", detail);
			},
		}),
		tool: (tool) => ({
			...tool,
			async execute(args, api, context) {
				const value = await tool.execute(args, api, context);
				if (tool.name === "neuve_review_pull_request") captured = value;
				return value;
			},
		}),
	});
	fixture.script(
		call("neuve_review_pull_request", { repo: "a/b", number: 1 }),
		fauxAssistantMessage("See refusal card"),
	);
	await ask();
	if (!captured) throw new Error("Missing refusal");
	expect(captured.isError).toBe(true);
	expect(modelValue(captured)).toEqual({
		outcome: "refused",
		reason: "pull_request_unavailable",
		detail,
		fix: "Open the pull request's project on this host",
	});
	expect(captured.details).toMatchObject({
		kind: "refused",
		reason: "pull_request_unavailable",
		detail,
		fix: "Open the pull request's project on this host",
	});
});
