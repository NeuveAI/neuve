import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, expect, test } from "bun:test";
import { Fixture, OWNER } from "./helpers";
import type { PlanningState, SourcePin } from "../src/planning";
import { parseRequest } from "../src/parse";

const source: SourcePin = {
	connection: "linear",
	workspace: null,
	issue: "issue-uuid",
	key: "NEU-59",
	url: "https://linear.app/neuve/issue/NEU-59",
	title: "Planning",
	excerpt: "A dated scope.",
	providerVersion: "v1",
	fetchedAt: "2026-10-30T12:00:00.000Z",
	sha256: "a".repeat(64),
};
let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

test("native selection and resulting review survive close and reopen", async () => {
	fixture = await Fixture.create({ planning: async () => ({ kind: "issue", issue: source }) });
	const selected = await fixture.request<PlanningState>({
		op: "planning-select",
		author: OWNER,
		connection: "linear",
		issue: "NEU-59",
	});
	expect(selected).toEqual({ selection: { source, lane: "work" }, review: null });
	await expect(
		fixture.request({
			op: "planning-reviewed",
			chat: ROOT_CONVERSATION_ID,
			source: { ...source, sha256: "d".repeat(64) },
			review: { reference: "wrong-selection", base: "b".repeat(40), head: "c".repeat(40) },
		}),
	).rejects.toThrow("selected scope changed");
	const review = { reference: "records-cycle", base: "b".repeat(40), head: "c".repeat(40) };
	await fixture.request({ op: "planning-reviewed", chat: ROOT_CONVERSATION_ID, source, review });
	await fixture.restart();
	expect(await fixture.request<PlanningState>({ op: "planning-state" })).toEqual({
		selection: { source, lane: "work" },
		review,
	});
	await fixture.request({ op: "planning-clear", author: OWNER });
	expect(await fixture.request<PlanningState>({ op: "planning-state" })).toEqual({
		selection: null,
		review: null,
	});
});

test("unavailable planning is visible and arbitrary operations are refused", async () => {
	const tools: string[] = [];
	fixture = await Fixture.create({
		tool: (tool) => {
			tools.push(tool.name);
			return tool;
		},
	});
	expect(tools.some((name) => name.startsWith("planning_"))).toBe(false);
	expect(
		await fixture.request({
			op: "planning-read",
			request: { op: "search", connection: "linear", query: "scope" },
		}),
	).toMatchObject({ kind: "failure", reason: "unavailable" });
	expect(fixture.log).toContainEqual(
		expect.objectContaining({
			event: "planning.read",
			fields: expect.objectContaining({ reason: "unavailable" }),
		}),
	);
	expect(() =>
		parseRequest(
			{ op: "planning-read", request: { op: "graphql", connection: "linear", query: "mutation" } },
			OWNER,
		),
	).toThrow();
});
