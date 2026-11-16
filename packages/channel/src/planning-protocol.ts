import { z } from "zod";

const identity = z.string().min(1).max(256);
export const SourcePinSchema = z.strictObject({
	connection: identity,
	workspace: identity.nullable(),
	issue: identity,
	key: identity,
	url: z.url({ protocol: /^https$/ }).max(4096),
	title: z.string().max(1000),
	excerpt: z.string().max(32000),
	providerVersion: z.string().max(256).nullable(),
	fetchedAt: z.iso.datetime(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SourcePin = z.infer<typeof SourcePinSchema>;
export const CompletenessSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("complete") }),
	z.strictObject({
		kind: z.literal("partial"),
		cursor: identity.nullable(),
		reason: z.string().min(1).max(300),
	}),
	z.strictObject({ kind: z.literal("unknown"), reason: z.string().min(1).max(300) }),
]);
export const PlanningRequestSchema = z.discriminatedUnion("op", [
	z.strictObject({
		op: z.literal("search"),
		connection: identity,
		query: z.string().min(1).max(1000),
		cursor: identity.optional(),
	}),
	z.strictObject({ op: z.literal("issue"), connection: identity, issue: identity }),
	z.strictObject({
		op: z.literal("dependencies"),
		connection: identity,
		issue: identity,
		cursor: identity.optional(),
	}),
]);
export type PlanningRequest = z.infer<typeof PlanningRequestSchema>;
export const PlanningFailureSchema = z.strictObject({
	kind: z.literal("failure"),
	reason: z.enum([
		"unavailable",
		"disconnected",
		"reconnect-required",
		"denied",
		"inaccessible",
		"rate-limited",
		"timeout",
		"cancelled",
		"invalid",
	]),
	message: z.string().max(300),
	retryAfterMs: z.int().min(0).max(300000).optional(),
});
export const PlanningResultSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("issues"),
		items: z.array(SourcePinSchema).max(100),
		completeness: CompletenessSchema,
	}),
	z.strictObject({ kind: z.literal("issue"), issue: SourcePinSchema }),
	z.strictObject({
		kind: z.literal("dependencies"),
		items: z
			.array(
				z.strictObject({
					relation: z.enum(["blocks", "blocked-by", "related", "parent", "child"]),
					issue: SourcePinSchema,
				}),
			)
			.max(100),
		completeness: CompletenessSchema,
	}),
	PlanningFailureSchema,
]);
export type PlanningResult = z.infer<typeof PlanningResultSchema>;
export const PlanningConnectionsSchema = z.strictObject({
	connections: z.array(z.strictObject({ id: identity, label: z.string().min(1).max(256) })),
	status: z.enum(["configured", "unavailable"]),
	message: z.string().max(300).nullable(),
});
export type PlanningConnections = z.infer<typeof PlanningConnectionsSchema>;
export const ReviewAssociationSchema = z.strictObject({
	reference: identity,
	base: z.string().regex(/^[a-f0-9]{40,64}$/),
	head: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export type ReviewAssociation = z.infer<typeof ReviewAssociationSchema>;
export const PlanningStateSchema = z.strictObject({
	selection: z.strictObject({ source: SourcePinSchema, lane: identity }).nullable(),
	review: ReviewAssociationSchema.nullable(),
});
export type PlanningState = z.infer<typeof PlanningStateSchema>;
