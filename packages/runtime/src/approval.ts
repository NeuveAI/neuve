import { z } from "zod";

/** What a runtime with tools of its own did by itself. Neuve's own tools are never one of these. */
export const WorkKind = z.enum([
  "command",
  "file-change",
  "web-search",
  "tool",
]);
export type WorkKind = z.infer<typeof WorkKind>;

const approvalReason = { reason: z.exactOptional(z.string()) };
const approvalChange = { path: z.string(), diff: z.string() };
const approvalTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), path: z.string() }),
  z.strictObject({ kind: z.literal("glob"), pattern: z.string() }),
  z.strictObject({ kind: z.enum(["root", "minimal", "tmpdir", "slash-tmp"]) }),
  z.strictObject({
    kind: z.literal("project-roots"),
    subpath: z.exactOptional(z.string()),
  }),
]);

/** What a person is being asked to allow, in terms the chat can show. */
export const ApprovalAsked = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    command: z.string(),
    folder: z.string(),
    network: z.exactOptional(
      z.strictObject({
        host: z.string(),
        protocol: z.enum(["http", "https", "socks5-tcp", "socks5-udp"]),
      }),
    ),
    ...approvalReason,
  }),
  z.strictObject({
    kind: z.literal("file-change"),
    changes: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            ...approvalChange,
            kind: z.enum(["add", "delete"]),
          }),
          z.strictObject({
            ...approvalChange,
            kind: z.literal("update"),
            newPath: z.exactOptional(z.string()),
          }),
        ]),
      )
      .min(1)
      .nullable(),
    ...approvalReason,
  }),
  z.strictObject({
    kind: z.literal("wider-access"),
    paths: z.array(
      z.strictObject({
        target: approvalTarget,
        access: z.enum(["read", "write", "deny"]),
      }),
    ),
    network: z.boolean().nullable(),
    folder: z.exactOptional(z.string()),
    globDepthLimit: z.exactOptional(z.int().nonnegative()),
    ...approvalReason,
  }),
  z.strictObject({
    kind: z.literal("server-prompt"),
    server: z.string(),
    message: z.string(),
    url: z.exactOptional(z.string()),
    ...approvalReason,
  }),
  z.strictObject({ kind: z.literal("unrecognised"), ...approvalReason }),
]);
export type ApprovalAsked = z.infer<typeof ApprovalAsked>;
