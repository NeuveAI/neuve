import { z } from "zod";
import { EffortSchema } from "./effort";
import type { Request } from "./protocol";
import { reservedBuildRequestId, reservedReviewRequestId } from "./protocol";

export { EffortSchema };

/** pi's chat, entry, and submission IDs. */
const id = z.int().nonnegative();
const chat = id.optional();
export const ToolImageRequestSchema = z.strictObject({
	op: z.literal("tool-image"),
	chat: id,
	call: z.string().min(1),
	index: id,
});
export const ToolImageSchema = z.strictObject({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), data: z.string() });
export const ModelRefSchema = z.strictObject({ provider: z.string().min(1), modelId: z.string().min(1) });
export const ChatModeSchema = z.enum(["ace", "plan"]);
const images = z.array(z.strictObject({ mimeType: z.string(), data: z.string() })).optional();
const files = z.array(z.strictObject({ name: z.string(), text: z.string() })).optional();
const requestId = z.string().min(1).max(200).refine(value => !reservedReviewRequestId(value), {
	message: "The neuve.review: request-ID namespace is reserved for the host",
}).refine(value => !reservedBuildRequestId(value), {
	message: "The neuve.build: request-ID namespace is reserved for the host",
}).optional();
const agents = z.array(id).min(1).optional();
/**
 * The author a client claims, which the host replaces with the participant it verified. Defaulted,
 * so every request that carries an author has the field to replace.
 */
const author = z.string().default("");

const answerOp = z.strictObject({
	op: z.literal("answer"),
	chat,
	call: z.string().optional(),
	author,
	answers: z.array(
		z.union([z.strictObject({ choices: z.array(id) }), z.strictObject({ custom: z.string() })]),
	).optional(),
	text: z.string().optional(),
}).transform(({ answers, text, call, ...rest }, context) => {
	// A question call's answers, or one written answer for a call or the chat's newest question.
	if (answers !== undefined && text === undefined && call !== undefined) {
		return { ...rest, call, answers };
	}
	if (text !== undefined && answers === undefined) {
		return { ...rest, ...(call === undefined ? {} : { call }), text };
	}
	context.issues.push({
		code: "custom",
		message: "An answer is either a call's answers or a written text",
		input: { answers, text, call },
	});
	return z.NEVER;
});

// Approval requests.
export const ApprovalAnswerSchema = z.strictObject({
	op: z.literal("approval-answer"),
	chat,
	author: z.string().min(1),
	requestId: z.string().min(1),
	decision: z.enum(["allow", "deny"]),
});

/** A client's channel request, as Ace's `Request` defines each operation; unknown fields are refused. */
export const RequestSchema = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("info") }),
	z.strictObject({ op: z.literal("models") }),
	z.strictObject({ op: z.literal("say"), chat, author, text: z.string(), images, files, agents, requestId }),
	z.strictObject({
		op: z.literal("ask"),
		chat,
		author,
		text: z.string(),
		images,
		files,
		model: ModelRefSchema.optional(),
		automatic: z.boolean().optional(),
		effort: EffortSchema.optional(),
		mode: ChatModeSchema.optional(),
		agents,
		requestId,
		attended: z.boolean().optional(),
	}),
	z.strictObject({
		op: z.literal("select"),
		chat,
		author,
		model: ModelRefSchema.optional(),
		automatic: z.boolean().optional(),
		effort: EffortSchema.optional(),
	}),
	z.strictObject({ op: z.literal("chat"), author, model: ModelRefSchema.optional() }),
	answerOp,
	z.strictObject({ op: z.literal("skip"), chat, call: z.string(), author }),
	ToolImageRequestSchema,
	z.strictObject({ op: z.literal("plan"), chat, plan: z.string().min(1) }),
	z.strictObject({
		op: z.literal("plan-approve"),
		chat,
		author,
		plan: z.string().min(1),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
	}),
	// Comments on a plan.
	z.strictObject({
		op: z.literal("plan-comment"),
		chat,
		author,
		plan: z.string().min(1),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
		lines: z.array(z.strictObject({ line: z.int().positive(), text: z.string() })).min(1),
		quote: z.string().min(1),
		text: z.string(),
	}),
	z.strictObject({ op: z.literal("plan-comment-reply"), chat, author, comment: z.string().min(1), text: z.string() }),
	z.strictObject({
		op: z.literal("plan-comment-edit"),
		chat,
		author,
		comment: z.string().min(1),
		reply: z.string().min(1).optional(),
		text: z.string(),
	}),
	z.strictObject({
		op: z.literal("plan-comment-remove"),
		chat,
		author,
		comment: z.string().min(1),
		reply: z.string().min(1).optional(),
	}),
	z.strictObject({ op: z.literal("plan-comments-send"), chat, author, plan: z.string().min(1), requestId }),
	// End of comments on a plan.
	z.strictObject({
		op: z.literal("react"),
		chat,
		author,
		entry: id,
		emoji: z.string(),
		remove: z.boolean().optional(),
	}),
	z.strictObject({ op: z.literal("delete"), chat, author, entry: id }),
	z.strictObject({ op: z.literal("edit"), chat, author, entry: id, text: z.string() }),
	z.strictObject({ op: z.literal("stop"), chat, author }),
	z.strictObject({ op: z.literal("kill"), author }),
	z.strictObject({ op: z.literal("build-stop"), author, build: z.string().regex(/^\d+:[a-f0-9]{64}$/) }),
	z.strictObject({ op: z.literal("desktop"), author, enabled: z.boolean() }),
	z.strictObject({ op: z.literal("share"), author, shared: z.boolean() }),
	z.strictObject({ op: z.literal("rename"), author, name: z.string() }),
	z.strictObject({ op: z.literal("typing"), chat, author }),
	z.strictObject({ op: z.literal("wait"), submission: id }),
	z.strictObject({ op: z.literal("changes"), chat }),
	z.strictObject({ op: z.literal("fetch"), chat }),
	z.strictObject({
		op: z.literal("patch"),
		chat,
		file: z.string(),
		state: z.enum(["committed", "uncommitted", "untracked"]).optional(),
	}),
	z.strictObject({
		op: z.literal("watch"),
		chat,
		turns: z.int().positive().optional(),
		approvals: z.boolean().optional(),
		queue: z.boolean().optional(),
		captions: z.boolean().optional(),
		progress: z.boolean().optional(),
		actions: z.boolean().optional(),
		typing: z.boolean().optional(),
		agent: z.boolean().optional(),
		stops: z.boolean().optional(),
		plans: z.boolean().optional(),
		planComments: z.boolean().optional(),
		builds: z.boolean().optional(),
	}),
	ApprovalAnswerSchema,
]);

// Every operation of the protocol has a schema; a new one fails here until it gets one.
true satisfies [Exclude<Request["op"], z.output<typeof RequestSchema>["op"]>] extends [never] ? true : never;

/** The verified participant replaces every author a request claims. */
export function stamp(request: z.output<typeof RequestSchema>, verified: string): Request {
	return "author" in request ? { ...request, author: verified } : request;
}

/**
 * Client requests cross a process boundary as JSON. `parseRequest` turns one into a `Request`, or
 * throws naming each field it refuses.
 */
export function parseRequest(value: unknown, verified: string): Request {
	const parsed = RequestSchema.safeParse(value);
	if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
	return stamp(parsed.data, verified);
}
