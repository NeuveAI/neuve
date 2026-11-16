import { AccountStatus } from "@neuve/runtime/status";
import {z} from "zod";
import {FrameSchema} from "@ace/channel/frame";
import {ModelRefSchema} from "@ace/channel/parse";
const runEnd = z.object({ chat: z.int().nonnegative(), at: z.number(), outcome: z.enum(["done", "failed", "stopped", "question", "answered"]), author: z.string(), system: z.object({ kind: z.literal("neuve:review:terminal"), review: z.string() }).optional() });
const listing = z.object({
	id: z.string(), host: z.string(), name: z.string(), prefix: z.string().optional(), owner: z.string(), project: z.string(), created: z.number(),
	state: z.enum(["running", "dormant", "archived", "offline"]), root: z.string().optional(), repo: z.string().optional(), hosted: z.string().optional(), compute: z.literal(true).optional(), computing: z.enum(["starting", "stopping"]).optional(), stopped: z.literal(true).optional(), moving: z.string().optional(), stalled: z.boolean().optional(), summary: z.string().optional(), revision: z.int().optional(), model: ModelRefSchema.optional(),
	active: z.number().optional(), busy: z.boolean().optional(), ran: runEnd.optional(),
	said: z.object({ at: z.number(), author: z.string() }).optional(),
	mentions: z.record(z.string(), z.number()).optional(),
});

const HostFrameSchema = z.union([
	z.object({ accounts: z.array(AccountStatus) }),
	FrameSchema,
	z.object({ hello: z.object({ user: z.string(), host: z.string(), github: z.string().optional(), team: z.string().optional(), directory: z.string().optional() }) }),
	z.object({ people: z.record(z.string(), z.string()) }),
	z.object({ presence: z.record(z.string(), z.array(z.object({ login: z.string(), host: z.string(), channels: z.array(z.string()), away: z.boolean() }))) }),
	z.object({ settings: z.literal(true) }),
	z.object({ asks: z.array(z.object({ id: z.string(), login: z.string(), host: z.string(), github: z.string().optional(), expires: z.number() })) }),
	z.object({ rename: z.object({ call: z.string(), channel: z.string(), tab: z.string(), name: z.string(), expires: z.number(), live: z.number().optional() }) }),
	z.object({ id: z.int().nonnegative(), waiting: z.string().nullable() }),
	z.object({ projects: z.array(z.object({ path: z.string(), name: z.string(), git: z.literal(false).optional(), repo: z.string().optional(), empty: z.literal(true).optional(), ignored: z.literal(true).optional() })) }),
	z.object({ channels: z.array(listing) }),
	z.object({ terminal: z.string(), data: z.string(), replay: z.literal(true).optional() }),
	z.object({ terminal: z.string(), exit: z.number() }),
]) satisfies z.ZodType<import("./extension-protocol").HostFrame>;

export function parseHostFrame(text: string): import("./extension-protocol").HostFrame {
	return HostFrameSchema.parse(JSON.parse(text));
}

true satisfies [import("./extension-protocol").HostFrame] extends [z.output<typeof HostFrameSchema>] ? true : never;
