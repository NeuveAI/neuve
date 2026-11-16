import { z } from "zod";

export const GithubKindSchema = z.enum(["issues", "prs"]);
export const GithubFilterSchema = z.enum(["open", "closed", "all"]);
export const GithubItemSchema = z.object({
	kind: GithubKindSchema,
	number: z.int().positive(),
	title: z.string(),
	url: z.url(),
	state: z.enum(["open", "closed", "merged", "draft"]),
	author: z.string(),
	created: z.string(),
	updated: z.string(),
	labels: z.array(z.object({ name: z.string(), color: z.string() })),
	head: z.string().optional(),
	fork: z.boolean().optional(),
});
export const GithubListSchema = z.object({
	items: z.array(GithubItemSchema),
	more: z.boolean(),
});
export const GithubCheckSchema = z.object({
	name: z.string(),
	url: z.string().optional(),
	state: z.enum(["pending", "passed", "failed", "skipped"]),
});
export const GithubPullSchema = GithubItemSchema.extend({
	checks: z.array(GithubCheckSchema),
	sha: z.string().optional(),
	review: z.enum(["approved", "changes", "required"]).optional(),
});
export const GithubCommentSchema = z.object({
	id: z.string(),
	url: z.string(),
	author: z.string(),
	body: z.string(),
	created: z.string(),
	review: z
		.enum(["approved", "changes_requested", "commented", "dismissed"])
		.optional(),
});
export const GithubDetailSchema = GithubItemSchema.extend({
	body: z.string(),
	comments: z.array(GithubCommentSchema),
	pull: z
		.object({
			base: z.string(),
			head: z.string(),
			adds: z.number(),
			dels: z.number(),
			files: z.number(),
			review: z.string(),
		})
		.optional(),
	completeness: z
		.object({
			kind: z.enum(["complete", "partial", "unknown"]),
			reason: z.string().optional(),
		})
		.optional(),
});
export const GithubFileSchema = z.object({
	file: z.string(),
	from: z.string().optional(),
	adds: z.number(),
	dels: z.number(),
	signature: z.string(),
	patch: z.string().optional(),
	error: z.string().optional(),
});
export type GithubKind = z.infer<typeof GithubKindSchema>;
export type GithubFilter = z.infer<typeof GithubFilterSchema>;
export type GithubItem = z.infer<typeof GithubItemSchema>;
export type GithubList = z.infer<typeof GithubListSchema>;
export type GithubCheck = z.infer<typeof GithubCheckSchema>;
export type GithubPull = z.infer<typeof GithubPullSchema>;
export type GithubComment = z.infer<typeof GithubCommentSchema>;
export type GithubDetail = z.infer<typeof GithubDetailSchema>;
export type GithubFile = z.infer<typeof GithubFileSchema>;

export const GithubPullDescriptorSchema = z.object({
  state: z.enum(["open", "closed"]).optional(),
	repo: z.string().regex(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i),
	number: z.int().positive(),
	url: z.url(),
	baseRepo: z.string(),
	headRepo: z.string(),
	baseRef: z.string(),
	headRef: z.string(),
	baseOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
	headOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
	title: z.string(),
	body: z.string(),
	updatedAt: z.string(),
	fetchedAt: z.iso.datetime(),
	files: z.int().nonnegative(),
});
export type GithubPullDescriptor = z.infer<typeof GithubPullDescriptorSchema>;

/** Persisted queries are validated together with their cached GitHub response. */
export const GithubCacheRequestSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("project-repo"),
		project: z.string(),
		host: z.string().optional(),
	}),
	z.object({
		op: z.literal("github-list"),
		repo: z.string(),
		kind: GithubKindSchema,
		state: GithubFilterSchema,
		search: z.string().max(4096),
		limit: z.int().min(1).max(1000),
	}),
]);
export type GithubCacheRequest = z.infer<typeof GithubCacheRequestSchema>;
