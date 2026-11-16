import { z } from "zod";
import { Instant } from "./envelope.ts";

const identity = z.string().min(1).max(512);
export const GitHubExternalRefSchema = z
  .strictObject({
    provider: z.literal("github"),
    repo: z.string().regex(/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i),
    kind: z.enum(["issue", "pull-request"]),
    number: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    url: z.url({ protocol: /^https$/ }).max(4096),
  })
  .refine((item) => {
    const expected = `https://github.com/${item.repo}/${item.kind === "issue" ? "issues" : "pull"}/${item.number}`;
    return item.url.toLowerCase() === expected.toLowerCase();
  }, "The item URL must name its GitHub repository, kind and number");
export type GitHubExternalRef = z.infer<typeof GitHubExternalRefSchema>;

const items = z.array(GitHubExternalRefSchema).max(16);
/** Names captured at admission for display; commit IDs remain the review identity. */
const display = z
  .strictObject({
    project: z.string().min(1),
    branch: z.string().min(1).optional(),
    base: z.string().min(1).optional(),
  })
  .optional();
export const ReviewOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("channel"),
    host: identity,
    channel: identity,
    chat: z.int().min(0),
    lane: identity.optional(),
    items,
    display,
  }),
  z.strictObject({
    kind: z.literal("external"),
    host: identity,
    items: items.min(1),
    display,
  }),
]);
export type ReviewOrigin = z.infer<typeof ReviewOriginSchema>;

/** Fetched source crosses admission here; its text never enters a permanent event. */
export const ExternalReviewSourceSchema = z.strictObject({
  item: GitHubExternalRefSchema,
  title: z.string().max(1000),
  text: z.string().max(262144),
  version: z.string().max(256).nullable(),
  fetchedAt: Instant,
  complete: z.boolean(),
});
export type ExternalReviewSource = z.infer<typeof ExternalReviewSourceSchema>;

export const ExternalReviewPinSchema = ExternalReviewSourceSchema.omit({
  text: true,
}).extend({
  sourceId: z.string().regex(/^E[1-9][0-9]?$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capture: z.strictObject({
    blob: z.string().regex(/^[a-f0-9]{64}$/),
    masked: z.record(z.string(), z.int().min(0)),
  }),
});
export type ExternalReviewPin = z.infer<typeof ExternalReviewPinSchema>;
