import "./fixtures/memory-secrets";
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { z } from "zod";
import { createPlanning, type PlanningCall, type PlanningClient } from "../src/planning";

const mappings = {
	linear: {
		search: { tool: "read_search", queryArgument: "query", cursorArgument: "cursor" },
		issue: { tool: "read_issue", idArgument: "id" },
		dependencies: { tool: "read_dependencies", idArgument: "id", cursorArgument: "cursor" },
	},
};
const issue = {
	id: "NEU-59",
	uuid: "uuid",
	title: "Planning",
	description: "Scope",
	url: "https://linear.app/neuve/issue/NEU-59",
	updatedAt: "v1",
};
function client(
	answer: unknown,
	options: { write?: boolean; missing?: boolean; malformed?: boolean; throws?: boolean } = {},
): PlanningClient {
	return {
		connection: async () => ({
			tools: Object.values(mappings.linear)
				.slice(0, options.missing ? 2 : 3)
				.map(({ tool }) => ({
					name: tool,
					input: options.malformed ? z.never() : z.object({}).loose(),
					readOnlyHint: options.write ? false : true,
					definitionHash: "a".repeat(64),
				})),
		}),
		call: async () => {
			if (options.throws)
				throw new Error(
					"Bearer fixture-secret-value https://auth.test/?code=canary https://docs.test/?filter=required",
				);
			return { structured: answer, text: "", isError: false };
		},
	};
}
test("search preserves paging and unknown workspace with safe captured provenance", async () => {
	const calls: PlanningCall[] = [];
	const read = createPlanning({
		client: client({
			issues: [
				{
					...issue,
					description:
						"Bearer fixture-secret-value https://auth.test/?code=canary https://docs.test/?filter=required",
				},
			],
			hasNextPage: true,
			cursor: "page2",
		}),
		mappings,
		capture: (call) => calls.push(call),
	});
	const result = await read(
		{ op: "search", connection: "linear", query: "planning" },
		BACKGROUND_CONTEXT,
	);
	expect(result).toMatchObject({
		kind: "issues",
		items: [{ workspace: null, key: "NEU-59" }],
		completeness: { kind: "partial", cursor: "page2" },
	});
	expect(JSON.stringify(calls)).not.toContain("fixture-secret-value");
	expect(JSON.stringify(calls)).not.toContain("code=canary");
	expect(JSON.stringify(calls)).toContain("filter=required");
	expect(calls[0]?.definitions).toHaveLength(3);
});
test("dependency completeness cannot become empty complete when provider omits it", async () => {
	const read = createPlanning({
		client: client({ relations: { blocks: [], blockedBy: [], relatedTo: [], duplicateOf: null } }),
		mappings,
	});
	expect(
		await read({ op: "dependencies", connection: "linear", issue: "NEU-59" }, BACKGROUND_CONTEXT),
	).toMatchObject({ kind: "dependencies", completeness: { kind: "unknown" } });
});
test("all required definitions must exist, be read-only and accept configured input", async () => {
	for (const options of [{ write: true }, { missing: true }, { malformed: true }]) {
		const read = createPlanning({ client: client(issue, options), mappings });
		expect(
			await read({ op: "issue", connection: "linear", issue: "NEU-59" }, BACKGROUND_CONTEXT),
		).toMatchObject({ kind: "failure", reason: "unavailable" });
	}
});
test("authorization, bounded rate hints, invalid pages, cancellation and safe errors stay explicit", async () => {
	for (const [answer, expected] of [
		[{ error: "unauthorized" }, "reconnect-required"],
		[{ error: "forbidden" }, "denied"],
		[{ error: "not_found" }, "inaccessible"],
		[{ error: "rate_limited", retryAfterMs: 9999999 }, "rate-limited"],
		[{ error: "timeout" }, "timeout"],
		[{ unrelated: true }, "invalid"],
	] as const) {
		const result = await createPlanning({ client: client(answer), mappings })(
			{ op: "issue", connection: "linear", issue: "NEU-59" },
			BACKGROUND_CONTEXT,
		);
		expect(result).toMatchObject({ kind: "failure", reason: expected });
		if (expected === "rate-limited") expect(result).toMatchObject({ retryAfterMs: 300000 });
	}
	const abort = new AbortController();
	abort.abort();
	expect(
		await createPlanning({ client: client(issue), mappings })(
			{ op: "issue", connection: "linear", issue: "NEU-59" },
			withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
		),
	).toMatchObject({ reason: "cancelled" });
	const failed = await createPlanning({ client: client(null, { throws: true }), mappings })(
		{ op: "issue", connection: "linear", issue: "NEU-59" },
		BACKGROUND_CONTEXT,
	);
	expect(JSON.stringify(failed)).not.toContain("fixture-secret-value");
});

test("observed Linear id/uuid relation summaries hydrate through configured exact reads", async () => {
	const calls: Array<{ tool: string; input: unknown }> = [];
	const transport = client(null);
	transport.call = async (_connection, tool, input) => {
		calls.push({ tool, input });
		return {
			text: "",
			isError: false,
			structured:
				tool === "read_dependencies"
					? {
							id: "NEU-59",
							relations: {
								blocks: [],
								blockedBy: [{ id: "NEU-58", title: "Regression" }],
								relatedTo: [],
								duplicateOf: null,
							},
						}
					: {
							...issue,
							id: "NEU-58",
							uuid: "related-uuid",
							url: "https://linear.app/neuve/issue/NEU-58",
						},
		};
	};
	const configured = {
		linear: {
			...mappings.linear,
			dependencies: { ...mappings.linear.dependencies, fixedArguments: { includeRelations: true } },
		},
	};
	const result = await createPlanning({ client: transport, mappings: configured })(
		{ op: "dependencies", connection: "linear", issue: "NEU-59" },
		BACKGROUND_CONTEXT,
	);
	expect(result).toMatchObject({
		kind: "dependencies",
		items: [{ relation: "blocked-by", issue: { key: "NEU-58", issue: "related-uuid" } }],
		completeness: { kind: "unknown" },
	});
	expect(calls).toEqual([
		{ tool: "read_dependencies", input: { includeRelations: true, id: "NEU-59" } },
		{ tool: "read_issue", input: { id: "NEU-58" } },
	]);
});

const retainedProviderFixture = process.env["NEUVE_PLANNING_PROVIDER_FIXTURE"];
test.skipIf(!retainedProviderFixture)(
	"retained current plugin responses normalize without assuming the separate app endpoint",
	async () => {
		if (!retainedProviderFixture) return;
		const { readFile } = await import("node:fs/promises");
		const envelope = z.object({
			content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
		});
		const load = async (path: string): Promise<unknown> => {
			const value = envelope.parse(JSON.parse(await readFile(path, "utf8")));
			const block = value.content.find((item) => item.type === "text");
			if (!block?.text) throw new Error("The retained response has no text payload");
			return JSON.parse(block.text);
		};
		const actualIssue = await load(retainedProviderFixture);
		const actualList = await load(
			retainedProviderFixture.replace("-shape.json", "-list-shape.json"),
		);
		const transport = client(null);
		transport.call = async (_connection, tool, input) => {
			const id = z.object({ id: z.string().optional() }).parse(input).id;
			if (tool === "read_issue" && id !== "NEU-59")
				return { text: "", isError: true, structured: { error: "not_found" } };
			return {
				text: "",
				isError: false,
				structured: tool === "read_search" ? actualList : actualIssue,
			};
		};
		const read = createPlanning({ client: transport, mappings });
		expect(
			await read({ op: "issue", connection: "linear", issue: "NEU-59" }, BACKGROUND_CONTEXT),
		).toMatchObject({ kind: "issue", issue: { key: "NEU-59", workspace: null } });
		expect(
			await read({ op: "search", connection: "linear", query: "planning" }, BACKGROUND_CONTEXT),
		).toMatchObject({ kind: "issues", completeness: { kind: "complete" } });
		expect(
			await read({ op: "dependencies", connection: "linear", issue: "NEU-59" }, BACKGROUND_CONTEXT),
		).toMatchObject({ kind: "dependencies", completeness: { kind: "partial" } });
	},
);
