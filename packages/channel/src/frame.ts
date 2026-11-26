import { TurnRetryStatusSchema } from "@neuve/records-schema/turn-recovery";
import { ApprovalAsked, WorkKind } from "@neuve/runtime/approval";
import { z } from "zod";

import { RefusalReasonSchema, ReviewRangeSchema, ReviewStatusSchema } from "./review-protocol";
import type { ReviewCard } from "./review-cards";

import { EffortSchema } from "./effort";
import { ApprovalAnswerSchema, ChatModeSchema, ModelRefSchema } from "./parse";
import type { AgentFailure, ApprovalRequest, Build, Event, Frame, Plan, PlanComment, WorkMessage } from "./protocol";

export { ApprovalAsked as ApprovalAskedSchema };

const id = z.int().nonnegative();
const text = z.string();
const images = z.array(z.object({ mimeType: text, data: text })).optional();
const files = z.array(z.object({ name: text, text })).optional();
const system = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("neuve:review:terminal"), review: text }),
	z.object({ kind: z.literal("neuve:build:brief"), build: text }),
]).optional();
const queued = z.object({
	submission: id,
	author: text,
	text,
	images,
	files,
	invoked: z.boolean(),
	system,
});
const base = { chat: id };
const message = { ...base, entry: id, at: z.number(), text };

const approvalRequest = {
	requestId: ApprovalAnswerSchema.shape.requestId,
	callId: z.string().min(1),
	input: z.json(),
	asked: ApprovalAsked,
	openedAt: z.number(),
	state: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("open") }),
		z.strictObject({
			kind: z.literal("answered"),
			by: text,
			at: z.number(),
			decision: ApprovalAnswerSchema.shape.decision,
		}),
		z.discriminatedUnion("reason", [
			z.strictObject({
				kind: z.literal("closed"),
				reason: z.enum(["turn-ended", "runtime-resolved", "stopped", "restarted"]),
			}),
			z.strictObject({ kind: z.literal("closed"), reason: z.literal("message"), by: text }),
		]),
	]),
};

export const ApprovalRequestSchema = z.union([
	z.strictObject({ ...approvalRequest, toolName: z.string().min(1) }),
	z.strictObject({ ...approvalRequest, work: WorkKind }),
]) satisfies z.ZodType<ApprovalRequest>;

export const ReviewCardSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("refused"), reason: RefusalReasonSchema, title: text, detail: text, fix: text }),
	z.object({ kind: z.literal("review"), review: text, source: z.enum(["branch", "pull_request", "lane"]), label: text,
		range: ReviewRangeSchema, recovered: z.boolean(), notify: z.boolean(),
		phase: z.enum(["queued", "running", "finished", "stopped", "connection_lost"]),
		stage: ReviewStatusSchema.shape.stage.unwrap().nullable(), stages: z.array(text),
		finished: z.object({ units: id, byReviewLane: z.object({ humanRequired: id, humanSuggested: id, agentic: id, static: id }),
			needJudgment: id, complete: z.boolean(), gaps: id, undecoded: id }).nullable(),
		stopped: z.object({ reason: text }).nullable(), newCommits: z.object({ head: text }).nullable(),
		links: z.object({ batch: text, desk: text }).nullable(), updatedAt: z.number(),
	}),
]) satisfies z.ZodType<ReviewCard>;

export const PlanSchema = z.object({
	id: text,
	hash: text,
	call: text,
	title: text,
	state: z.enum(["draft", "approved", "replaced"]),
	written: z.number(),
	approved: z.object({ by: text, at: z.number() }).optional(),
}) satisfies z.ZodType<Plan>;

// Comments on a plan.
const fileLine = z.object({ line: id, text });
const send = z.object({ at: z.number(), submission: id, entry: id.optional() });
export const PlanCommentSchema = z.object({
	id: text,
	plan: text,
	author: text,
	at: z.number(),
	text,
	sent: send.optional(),
	anchor: z.object({ hash: text, lines: z.array(fileLine), quote: text, section: text }),
	placement: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("stays"), hash: text, lines: z.array(fileLine) }),
		z.object({ kind: z.literal("changed"), hash: text, removed: z.array(fileLine), added: z.array(fileLine) }),
		z.object({ kind: z.literal("ambiguous"), hash: text, section: text }),
	]),
	state: z.enum(["queued", "sent", "picked-up", "working", "replied", "failed"]).optional(),
	failure: text.optional(),
	replies: z.array(z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("person"), id: text, author: text, at: z.number(), text, sent: send.optional() }),
		z.object({ kind: z.literal("agent"), id: text, model: text, at: z.number(), text }),
	])),
}) satisfies z.ZodType<PlanComment>;
// End of comments on a plan.

const AgentFailureSchema = z.object({
	role: z.enum(["implementer", "reviewer"]),
	part: text.optional(),
	turn: text,
	at: z.number(),
	reason: text,
	attempts: z.int().positive(),
}) satisfies z.ZodType<AgentFailure>;

export const BuildSchema = z.object({
	id: text,
	chat: id,
	plan: z.object({ id: text, hash: text, title: text, call: text }),
	approved: z.object({ by: text, at: z.number() }),
	state: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("starting") }),
		z.object({ kind: z.literal("started") }),
		z.object({ kind: z.literal("delivered"), to: text }),
		z.object({ kind: z.literal("unavailable"), reason: z.enum(["shared", "hosted"]) }),
		z.object({ kind: z.literal("paused"), reason: z.literal("shared") }),
		z.object({ kind: z.literal("stopped"), by: text, at: z.number() }),
		z.object({ kind: z.literal("failed"), detail: text }),
	]),
	agents: z.array(z.object({
		role: z.enum(["implementer", "reviewer"]),
		part: text.optional(),
		chat: id,
		by: id.optional(),
		started: z.number(),
		state: z.enum(["running", "waiting", "done", "failed", "stopped"]),
		caption: text.optional(),
		failure: AgentFailureSchema.optional(),
	})),
}) satisfies z.ZodType<Build>;

const workMessage = z.object({ build: text, from: id, to: id, at: z.number(), text });
export const WorkMessageSchema = z.union([
	workMessage.extend({
		kind: z.literal("agent-failure"),
		failure: AgentFailureSchema,
		deliveries: z.array(z.object({ to: id, status: z.enum(["pending", "failed", "sent"]) })),
	}),
	workMessage.extend({ kind: z.never().optional() }),
]) satisfies z.ZodType<WorkMessage>;

export const EventSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("review-cards"), ...base, cards: z.record(text, ReviewCardSchema) }),
	z.object({ kind: z.literal("plans"), ...base, plans: z.array(PlanSchema) }),
	z.object({ kind: z.literal("plan-comments"), ...base, comments: z.array(PlanCommentSchema) }),
	z.object({ kind: z.literal("builds"), ...base, builds: z.array(BuildSchema), messages: z.array(WorkMessageSchema) }),
	z.object({ kind: z.literal("neuve:review:new-commits"), ...base, entry: id, at: z.number(), review: text, branch: text, reviewedHead: text, head: text, label: text }),
	z.object({
		kind: z.literal("queue"),
		...base,
		messages: z.array(queued),
		withdrawn: z.array(queued).optional(),
	}),
	z.object({
		kind: z.literal("message"),
		...message,
		author: text,
		images,
		files,
		invoked: z.boolean(),
		system,
		agents: z.array(id).optional(),
		deleted: z.boolean().optional(),
		edited: z.number().optional(),
	}),
	z.object({ kind: z.literal("deleted"), ...base, entry: id }),
	z.object({ kind: z.literal("edited"), ...message }),
	z.object({
		kind: z.literal("reactions"),
		...base,
		reactions: z.record(z.string(), z.array(z.object({ from: text, emoji: text }))),
	}),
	z.object({
		kind: z.literal("reply"),
		...message,
		model: text,
		mode: ChatModeSchema.optional(),
		error: text.optional(),
		stopped: z.boolean().optional(),
	}),
	z.object({ kind: z.literal("delta"), ...base, text }),
	z.object({
		kind: z.literal("tool"),
		...base,
		at: z.number(),
		model: text,
		call: text,
		name: text,
		args: z.unknown(),
		unrun: z.literal(true).optional(),
	}),
	z.object({
		kind: z.literal("progress"),
		...base,
		call: text,
		text,
		truncated: z.boolean().optional(),
	}),
	z.object({
		kind: z.literal("result"),
		...base,
		call: text,
		text,
		error: z.boolean(),
		images,
		stopped: z.boolean().optional(),
		interrupted: z.boolean().optional(),
		handoff: z.boolean().optional(),
	}),
	z.object({ kind: z.literal("caption"), ...base, calls: z.array(text), text }),
	z.object({ kind: z.literal("recap"), ...base, calls: z.array(text), text }),
	z.object({ kind: z.literal("run"), ...base, state: z.enum(["start", "end"]) }),
	z.object({ kind: z.literal("stopped"), ...base, at: z.number(), author: text }),
	z.object({
		kind: z.literal("agent"),
		...base,
		model: ModelRefSchema,
		effort: EffortSchema,
		mode: ChatModeSchema.optional(),
	}),
	z.object({
		kind: z.literal("metadata"),
		...base,
		shared: z.boolean().optional(),
		desktop: z.boolean().optional(),
		name: text,
		summary: text,
		revision: id,
	}),
	z.object({ kind: z.literal("live"), ...base }),
	z.object({ kind: z.literal("typing"), ...base, author: text }),
	z.object({ kind: z.literal("approval-requests"), ...base, requests: z.array(ApprovalRequestSchema) }),
	z.object({ kind: z.literal("turn-retry-status"), ...base, status: TurnRetryStatusSchema.optional() }),
]) satisfies z.ZodType<Event>;

export const FrameSchema = z.union([
	z.object({ id, ok: z.literal(true), value: z.unknown() }),
	z.object({ id, ok: z.literal(false), error: text }),
	z.object({ id, event: EventSchema }),
]) satisfies z.ZodType<Frame>;

// Schema inputs must accept every value the native wire contract can publish.
true satisfies [Event] extends [z.output<typeof EventSchema>] ? true : never;
true satisfies [Frame] extends [z.output<typeof FrameSchema>] ? true : never;

export function parseFrame(text: string): Frame { return FrameSchema.parse(JSON.parse(text)); }
