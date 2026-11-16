import { createHash } from "node:crypto";
import { z } from "zod";
import {
	PlanningRequestSchema,
	PlanningResultSchema,
	type Planning,
	type PlanningResult,
	type SourcePin,
} from "@ace/channel/planning";

export type PlanningMapping = {
	search: {
		tool: string;
		queryArgument: string;
		cursorArgument?: string | undefined;
		fixedArguments?: Record<string, string | boolean | number> | undefined;
	};
	issue: {
		tool: string;
		idArgument: string;
		fixedArguments?: Record<string, string | boolean | number> | undefined;
	};
	dependencies: {
		tool: string;
		idArgument: string;
		cursorArgument?: string | undefined;
		fixedArguments?: Record<string, string | boolean | number> | undefined;
	};
};
export type PlanningClient = {
	connection(
		server: string,
		signal?: AbortSignal,
	): Promise<{
		tools: ReadonlyArray<{
			name: string;
			input: z.ZodType;
			readOnlyHint: boolean | undefined;
			definitionHash?: string;
		}>;
	}>;
	call(
		server: string,
		tool: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<{ text: string; structured: unknown; isError: boolean }>;
};
export type PlanningCall = {
	operation: string;
	connection: string;
	tool: string | null;
	catalogCoverage: "unknown-upstream";
	definitions: ReadonlyArray<{ name: string; sha256: string | null }>;
	startedAt: string;
	ms: number;
	outcome: PlanningResult;
};
const providerIssue = z.object({
	id: z.string().min(1).max(256),
	uuid: z.string().min(1).max(256).optional(),
	identifier: z.string().min(1).max(256).optional(),
	title: z.string().max(1048576),
	description: z.string().max(1048576).nullable().optional(),
	url: z.url({ protocol: /^https$/ }).max(4096),
	updatedAt: z.string().max(256).nullable().optional(),
	workspaceId: z.string().max(256).nullable().optional(),
});
const page = z.object({
	hasNextPage: z.boolean().optional(),
	cursor: z.string().nullable().optional(),
});
const issues = page.extend({ issues: z.array(providerIssue).max(100) });
const relationSummary = z.object({ id: z.string().min(1).max(256), title: z.string() });
const relations = z.object({
	relations: z.object({
		blocks: z.array(relationSummary).max(100).optional(),
		blockedBy: z.array(relationSummary).max(100).optional(),
		relatedTo: z.array(relationSummary).max(100).optional(),
		duplicateOf: relationSummary.nullable().optional(),
	}),
	parentId: z.string().nullable().optional(),
	hasNextPage: z.boolean().optional(),
	cursor: z.string().nullable().optional(),
});
const safeText = (text: string) =>
	text
		.replace(
			/\b(?:lin_(?:api|oauth)_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[^\s"<>]+)/gi,
			"<masked>",
		)
		.replace(/https?:\/\/[^\s"<>]+/g, (value) => {
			try {
				const url = new URL(value);
				url.username = "";
				url.password = "";
				if (/authorize|oauth|callback/i.test(url.pathname)) return "<authorization-url>";
				for (const key of url.searchParams.keys())
					if (
						/^(?:access_token|refresh_token|id_token|token|code|client_secret|password|api_key|state)$/i.test(
							key,
						)
					)
						url.searchParams.set(key, "<masked>");
				url.hash = "";
				return url.href;
			} catch {
				return "<url>";
			}
		});
function sameIssue(value: z.infer<typeof providerIssue>, requested: string): boolean {
	return [value.id, value.uuid, value.identifier, value.url].some(
		(id) =>
			id === requested ||
			(id !== undefined &&
				/^[A-Z][A-Z0-9]*-[0-9]+$/i.test(id) &&
				id.toUpperCase() === requested.toUpperCase()),
	);
}
function pin(
	value: z.infer<typeof providerIssue>,
	connection: string,
	fetchedAt: string,
): SourcePin {
	const excerpt = safeText(value.description || "").slice(0, 32000);
	return {
		connection,
		workspace: value.workspaceId ? safeText(value.workspaceId) : null,
		issue: safeText(value.uuid || value.id),
		key: safeText(value.identifier || value.id),
		url: safeText(value.url),
		title: safeText(value.title).slice(0, 1000),
		excerpt,
		providerVersion: value.updatedAt ? safeText(value.updatedAt) : null,
		fetchedAt,
		sha256: createHash("sha256").update(excerpt).digest("hex"),
	};
}
function completeness(value: z.infer<typeof page>) {
	if (value.hasNextPage === false) return { kind: "complete" as const };
	if (value.hasNextPage === true)
		return {
			kind: "partial" as const,
			cursor: value.cursor || null,
			reason: value.cursor
				? "More results are available."
				: "The provider reported more results without a continuation cursor.",
		};
	return { kind: "unknown" as const, reason: "The provider did not report result completeness." };
}
const failure = (
	reason: Extract<PlanningResult, { kind: "failure" }>["reason"],
	message: string,
): PlanningResult => ({ kind: "failure", reason, message });

/** Tool names come only from trusted user configuration; model requests choose domain operations. */
export function createPlanning(options: {
	client: PlanningClient;
	mappings: Readonly<Record<string, PlanningMapping>>;
	capture?(call: PlanningCall): void;
}): Planning {
	return async (input, context) => {
		const request = PlanningRequestSchema.parse(input);
		const immediate = (outcome: PlanningResult) => {
			options.capture?.({
				operation: request.op,
				connection: request.connection,
				tool: null,
				catalogCoverage: "unknown-upstream",
				definitions: [],
				startedAt: new Date().toISOString(),
				ms: 0,
				outcome,
			});
			return outcome;
		};
		if (context.abortSignal?.aborted)
			return immediate(failure("cancelled", "The Linear read was cancelled."));
		const mapping = options.mappings[request.connection];
		if (!mapping)
			return immediate(
				failure("unavailable", "This connection has no configured Linear read operations."),
			);
		const operation = mapping[request.op];
		const started = Date.now();
		const timeout = AbortSignal.timeout(30000);
		const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timeout]) : timeout;
		let definitions: PlanningCall["definitions"] = [];
		let outcome: PlanningResult;
		try {
			const connection = await options.client.connection(request.connection, signal);
			const required = Object.values(mapping);
			if (
				required.some(
					({ tool }) =>
						!connection.tools.some((entry) => entry.name === tool && entry.readOnlyHint !== false),
				)
			) {
				outcome = failure(
					"unavailable",
					"The bridge did not provide every configured read operation with a valid read-only schema.",
				);
			} else {
				definitions = connection.tools
					.filter(({ name }) => required.some(({ tool }) => tool === name))
					.map(({ name, definitionHash }) => ({ name, sha256: definitionHash || null }));
				const argument =
					request.op === "search"
						? mapping.search.queryArgument
						: request.op === "issue"
							? mapping.issue.idArgument
							: mapping.dependencies.idArgument;
				const cursorArgument =
					request.op === "search"
						? mapping.search.cursorArgument
						: request.op === "dependencies"
							? mapping.dependencies.cursorArgument
							: undefined;
				if ("cursor" in request && request.cursor && !cursorArgument)
					return immediate(
						failure("unavailable", "This read operation has no configured continuation argument."),
					);
				const args = {
					...operation.fixedArguments,
					[argument]: request.op === "search" ? request.query : request.issue,
					...("cursor" in request && request.cursor && cursorArgument
						? { [cursorArgument]: request.cursor }
						: {}),
				};
				const tool = connection.tools.find(({ name }) => name === operation.tool)!;
				if (!tool.input.safeParse(args).success)
					outcome = failure(
						"unavailable",
						"The configured operation arguments do not match the bridge schema.",
					);
				else {
					const result = await options.client.call(
						request.connection,
						operation.tool,
						args,
						signal,
					);
					let raw: unknown = result.structured;
					if (raw === undefined) {
						try {
							raw = JSON.parse(result.text);
						} catch {
							raw = null;
						}
					}
					const providerFailure = z
						.object({
							error: z.enum(["unauthorized", "forbidden", "not_found", "rate_limited", "timeout"]),
							retryAfterMs: z.number().optional(),
						})
						.safeParse(raw);
					if (providerFailure.success) {
						const error = providerFailure.data.error;
						outcome = failure(
							error === "unauthorized"
								? "reconnect-required"
								: error === "forbidden"
									? "denied"
									: error === "not_found"
										? "inaccessible"
										: error === "rate_limited"
											? "rate-limited"
											: "timeout",
							"The provider could not complete this read.",
						);
						if (
							outcome.kind === "failure" &&
							error === "rate_limited" &&
							providerFailure.data.retryAfterMs !== undefined
						)
							outcome.retryAfterMs = Math.min(
								300000,
								Math.max(0, Math.round(providerFailure.data.retryAfterMs)),
							);
					} else if (result.isError)
						outcome = failure(
							"unavailable",
							"The Linear bridge refused this read. Reconnect explicitly if authorization is required.",
						);
					else {
						const fetchedAt = new Date().toISOString();
						if (request.op === "issue") {
							const parsed = providerIssue.safeParse(raw);
							outcome =
								parsed.success && sameIssue(parsed.data, request.issue)
									? { kind: "issue", issue: pin(parsed.data, request.connection, fetchedAt) }
									: failure("invalid", "The provider returned an unsupported issue shape.");
						} else if (request.op === "search") {
							const parsed = issues.safeParse(raw);
							outcome = parsed.success
								? {
										kind: "issues",
										items: parsed.data.issues.map((issue) =>
											pin(issue, request.connection, fetchedAt),
										),
										completeness: completeness(parsed.data),
									}
								: failure("invalid", "The provider returned an unsupported search page.");
						} else {
							const parsed = relations.safeParse(raw);
							if (!parsed.success)
								outcome = failure(
									"invalid",
									"The provider did not return supported issue relations. Their completeness is unknown.",
								);
							else {
								const summaries = [
									...(parsed.data.relations.blocks || []).map((issue) => ({
										relation: "blocks" as const,
										issue,
									})),
									...(parsed.data.relations.blockedBy || []).map((issue) => ({
										relation: "blocked-by" as const,
										issue,
									})),
									...(parsed.data.relations.relatedTo || []).map((issue) => ({
										relation: "related" as const,
										issue,
									})),
									...(parsed.data.relations.duplicateOf
										? [{ relation: "related" as const, issue: parsed.data.relations.duplicateOf }]
										: []),
									...(parsed.data.parentId
										? [
												{
													relation: "parent" as const,
													issue: { id: parsed.data.parentId, title: "" },
												},
											]
										: []),
								];
								const items: Extract<PlanningResult, { kind: "dependencies" }>["items"] = [];
								let incomplete = summaries.length > 25;
								for (const summary of summaries.slice(0, 25)) {
									if (context.abortSignal?.aborted) throw new Error("cancelled");
									if (signal.aborted) {
										incomplete = true;
										break;
									}
									let fetched: Awaited<ReturnType<PlanningClient["call"]>>;
									try {
										fetched = await options.client.call(
											request.connection,
											mapping.issue.tool,
											{
												...mapping.issue.fixedArguments,
												[mapping.issue.idArgument]: summary.issue.id,
											},
											signal,
										);
									} catch {
										incomplete = true;
										break;
									}
									let related: unknown = fetched.structured;
									if (related === undefined) {
										try {
											related = JSON.parse(fetched.text);
										} catch {
											related = null;
										}
									}
									const issue = providerIssue.safeParse(related);
									if (
										fetched.isError ||
										!issue.success ||
										!sameIssue(issue.data, summary.issue.id)
									) {
										incomplete = true;
										continue;
									}
									items.push({
										relation: summary.relation,
										issue: pin(issue.data, request.connection, new Date().toISOString()),
									});
								}
								outcome = {
									kind: "dependencies",
									items,
									completeness: incomplete
										? {
												kind: "partial",
												cursor: parsed.data.cursor || null,
												reason:
													"Some returned dependencies could not be read within the bounded dependency fetch.",
											}
										: completeness(parsed.data),
								};
							}
						}
					}
				}
			}
		} catch (error) {
			const known =
				error instanceof Error
					? /planning:(timeout|reconnect-required|denied|rate-limited)/.exec(error.message)?.[1]
					: undefined;
			const reason = z
				.enum(["timeout", "reconnect-required", "denied", "rate-limited"])
				.safeParse(known);
			outcome = context.abortSignal?.aborted
				? failure("cancelled", "The Linear read was cancelled.")
				: timeout.aborted
					? failure("timeout", "The Linear read reached its time bound.")
					: reason.success
						? failure(reason.data, "The Linear bridge could not complete this read.")
						: failure(
								"disconnected",
								"The Linear bridge is unavailable. Reconnect explicitly if authorization is required.",
							);
		}
		if (context.abortSignal?.aborted)
			outcome = failure("cancelled", "The Linear read was cancelled.");
		const normalized = PlanningResultSchema.safeParse(outcome);
		outcome = normalized.success
			? normalized.data
			: failure("invalid", "The provider returned unsupported scope data.");
		options.capture?.({
			operation: request.op,
			connection: request.connection,
			tool: operation.tool,
			catalogCoverage: "unknown-upstream",
			definitions,
			startedAt: new Date(started).toISOString(),
			ms: Date.now() - started,
			outcome,
		});
		return outcome;
	};
}
