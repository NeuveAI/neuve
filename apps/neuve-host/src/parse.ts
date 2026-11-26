import { ReviewLookupSchema } from "@ace/channel/review-protocol";
import {NativeSourceRequestSchema} from "./native-source-protocol";
import { GitHubExternalRefSchema } from "@neuve/records-schema";
import { ReviewSubmissionSchema, ReviewFeedQuerySchema, ReviewTargetSchema, ReviewSnapshotSchema, ReviewStatusQuerySchema } from "./review-protocol";
import { z } from "zod";

import { FrameSchema } from "@ace/channel/frame";
import { ModelRefSchema, RequestSchema, stamp } from "@ace/channel/parse";
import { ExtensionRequestSchema } from "@ace/channel/operations-protocol";


import { GithubKindSchema, GithubFilterSchema } from "@ace/channel/github";
import type { HostEnvelope, HostRequest, WorkerRequest } from "./extension-protocol";
import { PluginPreferences } from "./plugin-manifest";

const channel = z.string();
const terminal = z.string();
/** Terminal dimensions a PTY accepts. */
const size = z.int().min(1).max(1000);
const chat = z.int().nonnegative().optional();

const reviewHistoryRequest = z.strictObject({
	op: z.literal("reviews"),
	channel: z.string().min(1).optional(),
	chat,
	project: z.string().min(1).optional(),
	item: GitHubExternalRefSchema.optional(),
}).transform((request, context) => {
	if (request.channel !== undefined && request.project === undefined && request.item === undefined) {
		return { op: request.op, channel: request.channel, ...(request.chat === undefined ? {} : { chat: request.chat }) };
	}
	if (request.project !== undefined && request.item !== undefined && request.channel === undefined && request.chat === undefined) {
		return { op: request.op, project: request.project, item: request.item };
	}
	context.issues.push({ code: "custom", message: "Review history requires either a channel and optional chat, or a project and GitHub item, never both.", input: request });
	return z.NEVER;
});

const WindowStateSchema = z.strictObject({
	channel: z.strictObject({id: z.string(), name: z.string()}),
	tabs: z.array(z.strictObject({id: z.string(), name: z.string(), type: z.enum(["blank", "chat", "plan", "work", "diff", "terminal", "live", "review"]), active: z.boolean()})),
	focused: z.boolean().optional(),
});

/** A client's host request, as `HostRequest` defines each operation; unknown fields are refused. */
export const NativeHostRequestSchema = z.discriminatedUnion("op", [
z.strictObject({op: z.literal("window"), value: WindowStateSchema.nullable()}),
z.strictObject({op: z.literal("windows")}),
z.strictObject({op: z.literal("tab-rename"), window: z.string(), channel, tab: z.string(), name: z.string()}),
z.strictObject({op: z.literal("tab-live"), window: z.string(), channel, target: z.int().nonnegative(), name: z.string()}),
z.strictObject({op: z.literal("tab-result"), call: z.string(), result: z.union([z.strictObject({ok: z.literal(true), value: WindowStateSchema}), z.strictObject({ok: z.literal(false), error: z.string()})])}),
z.strictObject({op: z.literal("project-access"), project: z.string()}),
z.strictObject({op: z.literal("project-share"), project: z.string(), person: z.string(), shared: z.boolean()}),
z.strictObject({op: z.literal("shares-changed")}),
z.strictObject({op: z.literal("key-set"), provider: z.enum(["anthropic", "openai"]), value: z.string()}),
z.strictObject({op: z.literal("key-check"), provider: z.enum(["anthropic", "openai"])}),
z.strictObject({op: z.literal("key-remove"), provider: z.enum(["anthropic", "openai"])}),
z.strictObject({op: z.literal("plugin-key-set"), plugin: z.string(), name: z.string(), value: z.string()}),
z.strictObject({op: z.literal("plugin-key-remove"), plugin: z.string(), name: z.string()}),
z.strictObject({op: z.literal("key-store"), name: z.string(), value: z.string()}),
z.strictObject({op: z.literal("key-forget"), name: z.string()}),
z.strictObject({op: z.literal("directory-set"), url: z.string().nullable(), secret: z.string().optional()}),
z.strictObject({op: z.literal("directory-serve"), serve: z.boolean()}),
z.strictObject({op: z.literal("team-deploy")}),
z.strictObject({op: z.literal("team-invite")}),
z.strictObject({op: z.literal("team-peers")}),
z.strictObject({op: z.literal("team-roster")}),
z.strictObject({op: z.literal("team-ask"), host: z.string()}),
z.strictObject({op: z.literal("team-request")}),
z.strictObject({op: z.literal("team-answer"), ask: z.string(), approve: z.boolean()}),
z.strictObject({op: z.literal("update-prepare")}),
z.strictObject({op: z.literal("update-cancel")}),
z.strictObject({op: z.literal("compute-start"), channel}),
z.strictObject({op: z.literal("compute-stop"), channel}),
z.strictObject({op: z.literal("move-targets"), channel}),
z.strictObject({op: z.literal("move"), channel, target: z.string()}),
z.strictObject({ op: z.literal("hello") }),
z.strictObject({ op: z.literal("channels") }),
z.strictObject({ op: z.literal("projects") }),
z.strictObject({ op: z.literal("project-repo"), project: z.string(), host: z.string().optional() }),
z.strictObject({ op: z.literal("project-init"), path: z.string() }),
z.strictObject({ op: z.literal("project-clone"), repo: z.string(), path: z.string() }),
z.strictObject({ op: z.literal("github-list"), repo: z.string(), kind: GithubKindSchema, state: GithubFilterSchema, search: z.string().max(4096), limit: z.int().min(1).max(1000) }),
z.strictObject({ op: z.literal("github-detail"), repo: z.string(), kind: GithubKindSchema, number: z.int().positive() }),
z.strictObject({ op: z.literal("github-files"), repo: z.string(), number: z.int().positive() }),
z.strictObject({ op: z.literal("github-pull"), repo: z.string(), branch: z.string().min(1) }),
z.strictObject({ op: z.literal("settings"), fresh: z.boolean().optional() }),
z.strictObject({ op: z.literal("preferences"), model: ModelRefSchema.nullable().optional(), folder: z.string().optional(), plugins: PluginPreferences.optional(), compute: z.object({ enabled: z.boolean(), url: z.string().nullable() }).optional() }),
z.strictObject({ op: z.literal("folder") }),
z.strictObject({ op: z.literal("compute") }),
z.strictObject({ op: z.literal("diagnostics"), sync: z.boolean().optional() }),
z.strictObject({ op: z.literal("fork"), channel }),
z.strictObject({ op: z.literal("archive-inactive"), project: z.string() }),
z.strictObject({ op: z.literal("models"), host: z.string().optional() }),
z.strictObject({ op: z.literal("project-open"), path: z.string() }),
z.strictObject({ op: z.literal("project-remove"), path: z.string() }),
z.strictObject({
		op: z.literal("create"),
		project: z.string(),
		name: z.string().optional(),
		model: ModelRefSchema.optional(),
		cloud: z.literal(true).optional(),
	}),
z.strictObject({ op: z.literal("archive"), channel, archived: z.boolean() }),
z.strictObject({ op: z.literal("delete"), channel }),
z.strictObject({ op: z.literal("channel"), channel, request: RequestSchema }),
z.strictObject({
		op: z.literal("terminal"),
		channel,
		chat,
		terminal: terminal.optional(),
		cols: size,
		rows: size,
	}),
z.strictObject({ op: z.literal("terminal-input"), terminal, data: z.string() }),
z.strictObject({ op: z.literal("terminal-resize"), terminal, cols: size, rows: size }),
z.strictObject({ op: z.literal("terminal-close"), terminal }),
z.strictObject({ op: z.literal("terminals"), channel }),
z.strictObject({ op: z.literal("release"), channel })
]);

const ExtensionHostRequestSchema = z.discriminatedUnion("op", [
z.strictObject({ op: z.literal("planning-connections") }),
z.strictObject({ op: z.literal("review-link"), channel, chat }),
reviewHistoryRequest,
z.strictObject({ op: z.literal("review-pull"), project: z.string(), repo: z.string(), number: z.int().positive(), expectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional() }),
z.strictObject({ op: z.literal("github-descriptor"), repo: z.string(), number: z.int().positive() }),
z.strictObject({
		op: z.literal("create"),
		project: z.string(),
		name: z.string().optional(),
		model: ModelRefSchema.optional(),
		cloud: z.literal(true).optional(),
		items: z.array(GitHubExternalRefSchema).max(16).optional(),
		lane: z.strictObject({ name: z.string(), path: z.string(), base: z.string().optional() }).optional(),
	}),
z.strictObject({ op: z.literal("channel"), channel, request: z.union([RequestSchema, ExtensionRequestSchema]) }),
z.strictObject({ op: z.literal("review-prepare"), channel, target: ReviewTargetSchema, snapshot: ReviewSnapshotSchema }),
z.strictObject({ op: z.literal("review-submit"), channel, prepared: ReviewSubmissionSchema }),
z.strictObject({ op: z.literal("review-status"), channel, query: z.union([ReviewStatusQuerySchema, ReviewLookupSchema]) }),
z.strictObject({ op: z.literal("review-outcome"), channel, query: ReviewLookupSchema }),
z.strictObject({ op: z.literal("review-feed"), channel, query: ReviewFeedQuerySchema }),
z.strictObject({ op: z.literal("review-requests"), channel, after: z.int().nonnegative() }),
z.strictObject({ op: z.literal("review"), channel, chat, items: z.array(GitHubExternalRefSchema).max(16).optional() })
]);
export const HostRequestSchema = z.union([ExtensionHostRequestSchema, NativeHostRequestSchema]);

// Every operation of the protocol has a schema; a new one fails here until it gets one.
true satisfies [Exclude<HostRequest["op"], z.output<typeof HostRequestSchema>["op"]>] extends [never]
	? true
	: never;

/** The envelope's own fields, read first so a refused request still gets an answer for its id. */
const EnvelopeSchema = z.looseObject({
	id: z.int().nonnegative(),
	trace: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

export class Refused extends Error {
	constructor(readonly id: number | undefined, message: string) {
		super(message);
	}
}

/**
 * One client frame, parsed into a `HostEnvelope` or refused naming each field. `verified` replaces
 * every author a relayed channel request claims.
 */
export function parseHostEnvelope(text: string, verified: string): HostEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Refused(undefined, "A request must be JSON");
	}
	const envelope = EnvelopeSchema.safeParse(value);
	if (!envelope.success) throw new Refused(undefined, z.prettifyError(envelope.error));
	const { id, trace, ...body } = envelope.data;
	const native = NativeHostRequestSchema.options.some((option) => option.shape.op.value === body.op);
	const extended = (body.op === "create" && ("items" in body || "lane" in body)) || (body.op === "channel" && ExtensionRequestSchema.safeParse(body.request).success);
	const parsed = (native && !extended ? NativeHostRequestSchema : HostRequestSchema).safeParse(body);
	if (!parsed.success) throw new Refused(id, z.prettifyError(parsed.error));
	const request: HostRequest = parsed.data.op === "channel"
		? { ...parsed.data, request: ("author" in parsed.data.request ? {...parsed.data.request, author: verified} : parsed.data.request) }
		: parsed.data;
	return { id, ...(trace === undefined ? {} : { trace }), ...request };
}

/** Worker IPC is private, but still an untrusted JSON boundary. */
export function parseWorkerEnvelope(text: string): { id: number; trace?: string } & (WorkerRequest | import("@ace/channel/protocol").Request | import("@ace/channel/operations-protocol").ExtensionRequest | import("./native-source-protocol").NativeSourceRequest) {
	const envelope = EnvelopeSchema.parse(JSON.parse(text));
	const { id, trace, ...body } = envelope;
	const parsed = z.union([z.strictObject({ op: z.literal("worker") }), z.strictObject({op: z.literal("freeze")}), z.strictObject({op: z.literal("export")}), RequestSchema, ExtensionRequestSchema, NativeSourceRequestSchema]).parse(body);
	return { id, ...(trace === undefined ? {} : { trace }), ...parsed };
}

export {parseHostFrame} from "./host-frame";
