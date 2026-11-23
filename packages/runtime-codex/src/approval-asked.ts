import type { ApprovalAsked } from "@neuve/runtime";
import { z } from "zod";
import type { ServerRequest } from "./client.ts";
import type { FileUpdateChange } from "./generated/v2/FileUpdateChange";

const text = z.string();
const Reason = z.object({ reason: text.nullish() });
const Command = z.object({
  kind: z.literal("command").optional(),
  command: text,
  cwd: text,
  networkApprovalContext: z
    .strictObject({
      host: text,
      protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
    })
    .nullish(),
});
const SpecialPath = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["root", "minimal", "tmpdir", "slash_tmp"]) }),
  z.strictObject({ kind: z.literal("project_roots"), subpath: text.nullish() }),
]);
const Path = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("path"), path: text }),
  z.strictObject({ type: z.literal("glob_pattern"), pattern: text }),
  z.strictObject({ type: z.literal("special"), value: SpecialPath }),
]);
// Allow forwards both permission sections with their fields intact. One unknown field makes the
// whole profile unrecognised, so the card uses the raw request instead of showing a partial grant.
const Permissions = z.object({
  cwd: text.nullish(),
  permissions: z.strictObject({
    network: z.strictObject({ enabled: z.boolean().nullable() }).nullish(),
    fileSystem: z
      .strictObject({
        read: z.array(text).nullish(),
        write: z.array(text).nullish(),
        entries: z
          .array(
            z.strictObject({
              path: Path,
              access: z.enum(["read", "write", "deny"]),
            }),
          )
          .optional(),
        globScanMaxDepth: z.int().nonnegative().optional(),
      })
      .nullish(),
  }),
});
const FileChange = z.object({ grantRoot: z.null().optional() });
const Prompt = z.discriminatedUnion("mode", [
  z.object({
    mode: z.enum(["form", "openai/form", "openaiForm"]),
    serverName: text,
    message: text,
  }),
  z.object({
    mode: z.literal("url"),
    serverName: text,
    message: text,
    url: text,
  }),
]);

type AccessTarget = Extract<
  ApprovalAsked,
  { kind: "wider-access" }
>["paths"][number]["target"];
function target(path: z.infer<typeof Path>): AccessTarget {
  if (path.type === "path") return { kind: "path", path: path.path };
  if (path.type === "glob_pattern")
    return { kind: "glob", pattern: path.pattern };
  const { value } = path;
  if (value.kind === "project_roots")
    return {
      kind: "project-roots",
      ...(value.subpath == null ? {} : { subpath: value.subpath }),
    };
  return { kind: value.kind === "slash_tmp" ? "slash-tmp" : value.kind };
}

export function describeApproval(
  request: { method: ServerRequest["method"]; params: unknown },
  changes?: readonly FileUpdateChange[],
): ApprovalAsked {
  const reason = Reason.safeParse(request.params).data?.reason;
  const why = reason == null ? {} : { reason };
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const parsed = Command.safeParse(request.params);
      if (!parsed.success) break;
      const { command, cwd, networkApprovalContext: network } = parsed.data;
      const protocols = {
        http: "http",
        https: "https",
        socks5Tcp: "socks5-tcp",
        socks5Udp: "socks5-udp",
      } as const;
      return {
        kind: "command",
        command,
        folder: cwd,
        ...why,
        ...(network == null
          ? {}
          : {
              network: {
                host: network.host,
                protocol: protocols[network.protocol],
              },
            }),
      };
    }
    case "item/fileChange/requestApproval": {
      if (!FileChange.safeParse(request.params).success) break;
      return {
        kind: "file-change",
        ...why,
        changes: changes?.length
          ? changes.map(({ path, diff, kind }) => ({
              path,
              diff,
              kind: kind.type,
              ...(kind.type === "update" && kind.move_path !== null
                ? { newPath: kind.move_path }
                : {}),
            }))
          : null,
      };
    }
    case "item/permissions/requestApproval": {
      const parsed = Permissions.safeParse(request.params);
      if (!parsed.success) break;
      const {
        cwd,
        permissions: { fileSystem: files, network },
      } = parsed.data;
      const paths: Extract<ApprovalAsked, { kind: "wider-access" }>["paths"] =
        [];
      for (const access of ["read", "write"] as const) {
        for (const path of files?.[access] ?? [])
          paths.push({ access, target: { kind: "path", path } });
      }
      for (const entry of files?.entries ?? [])
        paths.push({ access: entry.access, target: target(entry.path) });
      return {
        kind: "wider-access",
        paths,
        network: network?.enabled ?? null,
        ...why,
        ...(cwd == null ? {} : { folder: cwd }),
        ...(files?.globScanMaxDepth === undefined
          ? {}
          : { globDepthLimit: files.globScanMaxDepth }),
      };
    }
    case "mcpServer/elicitation/request": {
      const parsed = Prompt.safeParse(request.params);
      if (!parsed.success) break;
      const prompt = parsed.data;
      return {
        kind: "server-prompt",
        server: prompt.serverName,
        message: prompt.message,
        ...why,
        ...(prompt.mode === "url" ? { url: prompt.url } : {}),
      };
    }
  }
  return { kind: "unrecognised", ...why };
}
