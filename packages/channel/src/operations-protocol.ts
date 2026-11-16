import {z} from "zod";
import {ExternalRefSchema} from "./external-ref";
import {PlanningRequestSchema, SourcePinSchema, ReviewAssociationSchema} from "./planning-protocol";

const chat = z.int().nonnegative().optional();
const author = z.string().default("");
export const ExtensionRequestSchema = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("review-origin"), chat }),
	z.strictObject({ op: z.literal("review-origin-set"), chat, items: z.array(ExternalRefSchema).max(16), forkedFrom: z.strictObject({channel: z.string().min(1), chat: z.int().nonnegative()}).optional() }),
	z.strictObject({ op: z.literal("planning-read"), request: PlanningRequestSchema }),
	z.strictObject({ op: z.literal("planning-select"), chat, author, connection: z.string().min(1).max(256), issue: z.string().min(1).max(256) }),
	z.strictObject({ op: z.literal("planning-clear"), chat, author }),
	z.strictObject({ op: z.literal("planning-state"), chat }),
	z.strictObject({ op: z.literal("planning-reviewed"), chat: z.int().nonnegative(), source: SourcePinSchema.nullable(), review: ReviewAssociationSchema }),
]);
export type ExtensionRequest = z.infer<typeof ExtensionRequestSchema>;
