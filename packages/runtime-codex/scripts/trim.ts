/**
 * Turns a redacted recording into a fixture by allow-list, so a fixture describes Codex and never
 * the person whose machine recorded it. Kept: the tool-bearing settings and the command-line
 * layer, the features that layer names, the answers' shapes. Every name of the person's own
 * servers, plugins, apps and skills becomes a placeholder, each list is cut to a few entries, and
 * the plan, the operating system and the times are dropped. Applied to a fixture it changes
 * nothing, which the fixture guard checks.
 *
 *   bun scripts/trim.ts <recording> <new fixture file>
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Recorded, Recording } from "../src/recorder.ts";

type Json = Record<string, unknown>;
/** How many of the person's own entries of each kind a fixture keeps. */
const KEEP = 2;
/** The fields kept of each notification a fixture holds; any other notification keeps none. */
const NOTIFICATION_FIELDS: Record<string, ReadonlyArray<string>> = {
  "remoteControl/status/changed": [
    "status",
    "serverName",
    "installationId",
    "environmentId",
  ],
  "account/updated": ["authMode", "reason"],
};

const pick = (value: unknown, keys: ReadonlyArray<string>): Json =>
  Object.fromEntries(
    keys.flatMap((key) =>
      value !== null && typeof value === "object" && key in value
        ? [[key, (value as Json)[key]]]
        : [],
    ),
  );

export const trim = (recording: Recording): Recording => {
  const names = new Map<string, Map<string, string>>();
  /** A placeholder per name and kind, stable across the recording; a placeholder stays itself. */
  const rename = (kind: string, name: string) => {
    if (new RegExp(`^${kind}-\\d+$`).test(name)) return name;
    const known = names.get(kind) ?? new Map<string, string>();
    names.set(kind, known);
    if (!known.has(name)) known.set(name, `${kind}-${known.size + 1}`);
    return known.get(name)!;
  };
  const kept = (placeholder: string) =>
    Number(placeholder.replace(/^\D+-/, "")) <= KEEP;
  const own = (kind: string, value: unknown) =>
    Object.fromEntries(
      Object.entries((value ?? {}) as Record<string, Json | null>).flatMap(
        ([name, entry]) => {
          const placeholder = name === "_default" ? name : rename(kind, name);
          return placeholder === "_default" || kept(placeholder)
            ? [[placeholder, pick(entry, ["enabled"])]]
            : [];
        },
      ),
    );
  let flagFeatures = new Set<string>();
  const settings = (config: Json): Json => {
    const skills = (config.skills ?? null) as Json | null;
    const features = (config.features ?? {}) as Json;
    return {
      features: Object.fromEntries(
        Object.entries(features).filter(([name]) => flagFeatures.has(name)),
      ),
      ...pick(config, [
        "web_search",
        "tools",
        "hooks",
        "notify",
        "approval_policy",
        "sandbox_mode",
        "project_doc_max_bytes",
      ]),
      memories: pick(config.memories, ["use_memories", "generate_memories"]),
      agents: pick(config.agents, ["enabled"]),
      history: pick(config.history, ["persistence"]),
      shell_environment_policy: pick(config.shell_environment_policy, [
        "inherit",
      ]),
      skills:
        skills === null
          ? null
          : {
              ...pick(skills, ["bundled", "include_instructions"]),
              ...(Array.isArray(skills.config)
                ? {
                    config: (skills.config as Array<Json>)
                      .map((rule) => ({
                        name: rename("skill", String(rule.name)),
                        enabled: rule.enabled,
                      }))
                      .filter((rule) => kept(rule.name)),
                  }
                : {}),
            },
      mcp_servers: own("server", config.mcp_servers),
      plugins: own("plugin", config.plugins),
      apps: own("app", config.apps),
    };
  };

  const methods = new Map<unknown, string>();
  const result = (method: string | undefined, value: Json): unknown => {
    switch (method) {
      case "initialize":
        return {
          ...value,
          userAgent: String(value.userAgent).replace(/\([^)]*\)/, "(<os>)"),
        };
      case "configRequirements/read":
      case "hooks/list":
      case "app/list":
        return value;
      case "account/read":
        return {
          ...value,
          account: pick(value.account, ["type", "email", "workspaceName"]),
        };
      case "config/read": {
        const flags = (value.layers as Array<Json>).find(
          (layer) => (layer.name as Json).type === "sessionFlags",
        );
        flagFeatures = new Set(
          Object.keys(((flags?.config as Json)?.features ?? {}) as Json),
        );
        return {
          config: settings(value.config as Json),
          origins: {},
          layers: (value.layers as Array<Json>).map((layer) => ({
            name: pick(layer.name, ["type"]),
            version: "<version>",
            config:
              (layer.name as Json).type === "sessionFlags"
                ? settings(layer.config as Json)
                : {},
            disabledReason: layer.disabledReason,
          })),
        };
      }
      case "experimentalFeature/list":
        return {
          nextCursor: value.nextCursor,
          data: (value.data as Array<Json>)
            .filter((feature) => flagFeatures.has(String(feature.name)))
            .map((feature) => ({
              ...pick(feature, ["name", "stage", "enabled", "defaultEnabled"]),
              displayName: null,
              description: null,
              announcement: null,
            })),
        };
      case "model/list": {
        const models = value.data as Array<Json>;
        return {
          nextCursor: value.nextCursor,
          data: [
            ...models.filter((model) => model.isDefault === true),
            ...models.filter((model) => model.isDefault !== true),
          ]
            .slice(0, KEEP + 1)
            .map((model) =>
              pick(model, [
                "id",
                "model",
                "displayName",
                "hidden",
                "isDefault",
                "defaultReasoningEffort",
                "supportedReasoningEfforts",
                "inputModalities",
                "supportsPersonality",
                "upgrade",
              ]),
            ),
        };
      }
      case "skills/list":
        return {
          data: (value.data as Array<Json>).map((entry) => ({
            cwd: entry.cwd,
            skills: (entry.skills as Array<Json>)
              .map((item) => ({
                name: rename("skill", String(item.name)),
                description: "",
                path: "<path>",
                scope: item.scope,
                enabled: item.enabled,
                pluginId: null,
              }))
              .filter((item) => kept(item.name)),
            errors: [],
          })),
        };
      case "mcpServerStatus/list":
        return {
          nextCursor: value.nextCursor,
          data: (value.data as Array<Json>)
            .map((server) => ({
              ...pick(server, ["runtimeStatus", "tools", "authStatus"]),
              name: rename("server", String(server.name)),
            }))
            .filter((server) => kept(server.name)),
        };
      default:
        throw new Error(`no allow-list for ${method}`);
    }
  };
  const notification = (item: Json): Json => {
    const params = (item.params ?? {}) as Json;
    return {
      method: item.method,
      params: pick(params, NOTIFICATION_FIELDS[String(item.method)] ?? []),
      ...("emittedAtMs" in item ? { emittedAtMs: 0 } : {}),
    };
  };
  const entries: Array<Recorded> = recording.entries.map(
    ({ direction, message }) => {
      const item = message as Json;
      if (direction === "out") {
        if (item.method !== undefined)
          methods.set(item.id, String(item.method));
        return { direction, message };
      }
      if (item.method !== undefined)
        return { direction, message: notification(item) };
      return {
        direction,
        message: {
          id: item.id,
          result: result(methods.get(item.id), item.result as Json),
        },
      };
    },
  );
  return { ...recording, entries };
};

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (from === undefined || to === undefined)
    throw new Error("usage: bun scripts/trim.ts <recording> <fixture>");
  const recording = JSON.parse(readFileSync(from, "utf8")) as Recording;
  writeFileSync(to, `${JSON.stringify(trim(recording), null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
