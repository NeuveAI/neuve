/**
 * Decoders for the fields the runtime reads from Codex's answers and notifications, in place of
 * the client's cast to the generated types. Each keeps only what is read and lets the rest pass,
 * so a field a later Codex adds changes nothing, and one it renames or drops is a decode failure
 * the runtime handles, never a missing value read as if it were there.
 */
import { z } from "zod";

const loose = z.looseObject;
const text = z.string();
const nullable = <T extends z.ZodType>(schema: T) => schema.nullish();

export const Initialize = loose({ userAgent: text });

export const ThreadAnswer = loose({
  thread: loose({
    id: text.min(1),
    /** Filled only when the resume or fork asked for its turns. */
    turns: z.array(loose({ id: text.min(1), status: text })).optional(),
  }),
});

export const TurnAnswer = loose({ turn: loose({ id: text.min(1) }) });

export const AccountAnswer = loose({
  account: nullable(loose({ type: text, email: nullable(text) })),
  requiresOpenaiAuth: z.boolean(),
});

/** The names of the person's own settings, from their effective configuration. */
export const ConfigAnswer = loose({
  config: loose({
    mcp_servers: nullable(
      z.record(text, loose({ enabled: z.boolean().optional() })),
    ),
    plugins: nullable(z.record(text, z.unknown())),
    apps: nullable(z.record(text, z.unknown())),
    features: nullable(z.record(text, z.unknown())),
    web_search: z.unknown().optional(),
    shell_environment_policy: nullable(
      loose({ exclude: nullable(z.array(text)) }),
    ),
  }),
});

export const HooksAnswer = loose({
  data: z.array(loose({ hooks: z.array(z.unknown()) })),
});

export const ServerStatusAnswer = loose({
  data: z.array(
    loose({
      name: text,
      tools: nullable(z.record(text, z.unknown())),
      runtimeStatus: z.unknown().optional(),
    }),
  ),
  nextCursor: nullable(text),
});

export const SkillsAnswer = loose({
  data: z.array(
    loose({
      skills: z.array(loose({ name: text, path: text, enabled: z.boolean() })),
    }),
  ),
});

const TurnError = loose({
  message: text,
  /** A name such as `usageLimitExceeded`, or an object keyed by one. */
  codexErrorInfo: nullable(z.union([text, z.record(text, z.unknown())])),
});

export const TurnCompleted = loose({
  threadId: text,
  turn: loose({
    id: text.min(1),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
    error: nullable(TurnError),
  }),
});

export const ErrorNotice = loose({
  error: TurnError,
  willRetry: z.boolean(),
  turnId: text,
});

export const Delta = loose({ turnId: text, itemId: text, delta: text });

const Item = z.discriminatedUnion("type", [
  loose({
    type: z.literal("agentMessage"),
    id: text,
    text,
    phase: nullable(text),
  }),
  loose({
    type: z.literal("commandExecution"),
    id: text,
    command: text,
    cwd: text,
    status: text,
    aggregatedOutput: nullable(text),
    exitCode: nullable(z.number()),
    durationMs: nullable(z.number()),
  }),
  loose({
    type: z.literal("fileChange"),
    id: text,
    status: text,
    changes: z.array(
      loose({ path: text, kind: loose({ type: text }), diff: text }),
    ),
  }),
  loose({
    type: z.literal("webSearch"),
    id: text,
    query: text,
    action: z.json().nullish(),
  }),
  loose({
    type: z.literal("mcpToolCall"),
    id: text,
    server: text,
    tool: text,
    status: text,
    arguments: z.json().nullish(),
    result: nullable(loose({ content: z.array(z.unknown()) })),
    error: nullable(loose({ message: text })),
    durationMs: nullable(z.number()),
  }),
]);
/** Items the runtime reports; any other type is read as nothing at all. */
export const ItemCompleted = loose({
  turnId: text,
  item: loose({ type: text }),
});
export const KnownItem = Item;
export type KnownItem = z.infer<typeof Item>;

const Breakdown = loose({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});
export type Breakdown = z.infer<typeof Breakdown>;
export const TokenUsage = loose({
  turnId: text,
  tokenUsage: loose({
    total: Breakdown,
    last: Breakdown,
    modelContextWindow: nullable(z.number()),
  }),
});

const Window = loose({
  usedPercent: z.number(),
  windowDurationMins: nullable(z.number()),
  resetsAt: nullable(z.number()),
});
export const RateLimits = loose({
  rateLimits: loose({
    primary: nullable(Window),
    secondary: nullable(Window),
    rateLimitReachedType: nullable(z.unknown()),
  }),
});
export type RateLimits = z.infer<typeof RateLimits>["rateLimits"];

export const Resolved = loose({ requestId: z.union([text, z.number()]) });

/** What an approval request names, for the contract's event. */
export const ApprovalAsk = loose({
  turnId: nullable(text),
  itemId: text,
  command: nullable(text),
  cwd: nullable(text),
  reason: nullable(text),
});
export const Elicitation = loose({
  turnId: nullable(text),
  serverName: text,
  mode: text,
  message: text,
});
