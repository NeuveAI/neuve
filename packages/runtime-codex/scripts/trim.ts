/**
 * Turns a redacted recording into a fixture by allow-list, so a fixture describes Codex and never
 * the person whose machine recorded it. At every level only named fields survive, each with a
 * value of a known-safe shape: a boolean, a whole number, one of Codex's own words, or a label.
 * The person's own servers, plugins, apps, skills, hooks and tools become numbered placeholders,
 * each list cut to a few entries; anything else, an unknown field or a value of another shape, is
 * dropped. Applied to a fixture it changes nothing, which the fixture guard checks.
 *
 * Outgoing lines are kept as written: they are the client's own requests, built by
 * `scripts/steps.ts` from constants and the working folder, which redaction labels.
 *
 *   bun scripts/trim.ts <recording> <new fixture file>
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Recorded, Recording } from "../src/recorder.ts";

type Json = Record<string, unknown>;
/** What a rule returns for a value it does not keep. */
const DROP = Symbol("drop");
type Rule = (value: unknown) => unknown;

/** How many of the person's own entries of each kind a fixture keeps. */
const KEEP = 2;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const bool: Rule = (value) => (typeof value === "boolean" ? value : DROP);
const whole: Rule = (value) => (Number.isSafeInteger(value) ? value : DROP);
/** A string of the given shape, such as one of Codex's own identifiers. */
const shaped =
  (pattern: RegExp): Rule =>
  (value) =>
    typeof value === "string" && pattern.test(value) ? value : DROP;
/** Codex's own words: an enum value, a feature or setting name. */
const word = shaped(/^[A-Za-z][\w-]{0,63}$/);
/** Public text from OpenAI's catalogue, such as a reasoning level's description. */
const prose = shaped(/^[\w ,.'()-]{0,200}$/);
const oneOf =
  (...values: ReadonlyArray<string>): Rule =>
  (value) =>
    typeof value === "string" && values.includes(value) ? value : DROP;
/** A value that is replaced by a label whatever it held, so only its presence is kept. */
const label =
  (text: string): Rule =>
  () =>
    text;
const nullable =
  (rule: Rule): Rule =>
  (value) =>
    value === null ? null : rule(value);
const constant =
  (kept: unknown): Rule =>
  () =>
    kept;
const fields =
  (shape: Record<string, Rule>): Rule =>
  (value) =>
    isObject(value)
      ? Object.fromEntries(
          Object.entries(shape).flatMap(([name, rule]) => {
            if (!(name in value)) return [];
            const kept = rule(value[name]);
            return kept === DROP ? [] : [[name, kept]];
          }),
        )
      : DROP;
const list =
  (rule: Rule, max = Number.POSITIVE_INFINITY): Rule =>
  (value) =>
    Array.isArray(value)
      ? value
          .map(rule)
          .filter((entry) => entry !== DROP)
          .slice(0, max)
      : DROP;
/** An object keyed by names Codex defines, each value of one shape. */
const keyed =
  (rule: Rule, keep: (name: string) => boolean = () => true): Rule =>
  (value) =>
    isObject(value)
      ? Object.fromEntries(
          Object.entries(value).flatMap(([name, entry]) => {
            const kept = rule(entry);
            return word(name) === DROP || !keep(name) || kept === DROP
              ? []
              : [[name, kept]];
          }),
        )
      : DROP;

export const trim = (recording: Recording): Recording => {
  const names = new Map<string, Map<string, string>>();
  /** A placeholder per name and kind, stable across the recording; a placeholder stays itself. */
  const rename = (kind: string, name: unknown) => {
    const text = String(name);
    if (new RegExp(`^${kind}-\\d+$`).test(text)) return text;
    const known = names.get(kind) ?? new Map<string, string>();
    names.set(kind, known);
    if (!known.has(text)) known.set(text, `${kind}-${known.size + 1}`);
    return known.get(text)!;
  };
  const kept = (placeholder: string) =>
    Number(placeholder.replace(/^\D+-/, "")) <= KEEP;
  /** The person's own things, keyed by their names: placeholders, each with `enabled` alone. */
  const own =
    (kind: string): Rule =>
    (value) =>
      isObject(value)
        ? Object.fromEntries(
            Object.entries(value).flatMap(([name, entry]) => {
              const placeholder =
                name === "_default" ? name : rename(kind, name);
              const settings = fields({ enabled: bool })(entry);
              return (placeholder === "_default" || kept(placeholder)) &&
                settings !== DROP
                ? [[placeholder, settings]]
                : [];
            }),
          )
        : DROP;
  /** A list of the person's own things: placeholders, the first few kept. */
  const placeholders =
    (kind: string, shape: Record<string, Rule>, by = "name"): Rule =>
    (value) =>
      Array.isArray(value)
        ? value
            .map((entry) => {
              const safe = fields(shape)(entry);
              return safe === DROP
                ? DROP
                : {
                    ...(safe as Json),
                    [by]: rename(kind, (entry as Json)[by]),
                  };
            })
            .filter(
              (entry) => entry !== DROP && kept(String((entry as Json)[by])),
            )
        : DROP;

  let flagFeatures = new Set<string>();
  const settings: Rule = (config) =>
    fields({
      features: keyed(bool, (name) => flagFeatures.has(name)),
      web_search: word,
      tools: nullable(
        fields({
          update_plan: fields({ enabled: bool }),
          experimental_request_user_input: fields({ enabled: bool }),
          view_image: bool,
        }),
      ),
      // Hooks are the person's commands: only whether any are set is kept.
      hooks: nullable(constant({})),
      notify: list(label("<command>")),
      approval_policy: word,
      sandbox_mode: word,
      project_doc_max_bytes: whole,
      memories: fields({ use_memories: bool, generate_memories: bool }),
      agents: fields({ enabled: bool }),
      history: fields({ persistence: word }),
      shell_environment_policy: fields({ inherit: word }),
      skills: nullable(
        fields({
          bundled: fields({ enabled: bool }),
          include_instructions: bool,
          config: placeholders("skill", { enabled: bool }),
        }),
      ),
      mcp_servers: own("server"),
      plugins: own("plugin"),
      apps: own("app"),
    })(config);

  const cursor = nullable(shaped(/^\d{1,6}$/));
  const results: Record<string, Rule> = {
    initialize: (value) =>
      fields({
        // The operating system and its version are dropped; the release and client names stay.
        userAgent: (agent) =>
          shaped(/^[\w./ ;:<>()-]{1,200}$/)(
            String(agent).replace(/\([^)]*\)/, "(<os>)"),
          ),
        codexHome: label("<codex-home>"),
        platformFamily: word,
        platformOs: word,
      })(value),
    "configRequirements/read": fields({
      supportsIndependentSpeedModes: nullable(bool),
      // An administrator's requirements describe their organisation: only whether any exist.
      requirements: nullable(constant({})),
    }),
    "hooks/list": fields({
      data: list(
        fields({
          cwd: label("<cwd>"),
          hooks: placeholders(
            "hook",
            {
              eventName: word,
              handlerType: word,
              enabled: bool,
              isManaged: bool,
            },
            "key",
          ),
          warnings: list(label("<warning>")),
          errors: list(label("<error>")),
        }),
      ),
    }),
    "app/list": fields({
      data: placeholders("app", { isAccessible: bool, isEnabled: bool }, "id"),
      nextCursor: nullable(label("<cursor>")),
    }),
    "account/read": fields({
      account: nullable(
        fields({
          type: oneOf("apiKey", "chatgpt", "amazonBedrock", "gcp"),
          email: nullable(label("<redacted>")),
          workspaceName: nullable(label("<redacted>")),
        }),
      ),
      userId: nullable(label("<redacted>")),
      requiresOpenaiAuth: bool,
      // Not in the published schema: seen live, with the ChatGPT account id.
      workspaceRouting: nullable(
        fields({
          chatgptAccountId: nullable(label("<redacted>")),
          backendOrigin: oneOf("https://chatgpt.com"),
          accountRoutingOverride: shaped(/^[A-Z_]{1,40}$/),
        }),
      ),
    }),
    "config/read": (value) => {
      if (!isObject(value)) return DROP;
      const flags = (Array.isArray(value.layers) ? value.layers : []).find(
        (layer) =>
          isObject(layer) && (layer.name as Json)?.type === "sessionFlags",
      ) as Json | undefined;
      flagFeatures = new Set(
        Object.keys(((flags?.config as Json)?.features ?? {}) as Json),
      );
      return fields({
        config: settings,
        origins: constant({}),
        layers: list((layer) =>
          fields({
            name: fields({ type: word }),
            version: label("<version>"),
            config: (config) =>
              isObject(layer) && (layer.name as Json)?.type === "sessionFlags"
                ? settings(config)
                : {},
            disabledReason: nullable(label("<reason>")),
          })(layer),
        ),
      })(value);
    },
    "experimentalFeature/list": fields({
      nextCursor: cursor,
      data: (value) =>
        list(
          fields({
            name: word,
            stage: oneOf(
              "beta",
              "underDevelopment",
              "stable",
              "deprecated",
              "removed",
            ),
            enabled: bool,
            defaultEnabled: bool,
            displayName: constant(null),
            description: constant(null),
            announcement: constant(null),
          }),
        )(
          Array.isArray(value)
            ? value.filter(
                (feature) =>
                  isObject(feature) && flagFeatures.has(String(feature.name)),
              )
            : value,
        ),
    }),
    "model/list": fields({
      nextCursor: cursor,
      data: (value) =>
        list(
          fields({
            id: shaped(/^[\w.-]{1,64}$/),
            model: shaped(/^[\w.-]{1,64}$/),
            displayName: shaped(/^[\w .-]{1,64}$/),
            hidden: bool,
            isDefault: bool,
            defaultReasoningEffort: word,
            supportedReasoningEfforts: list(
              fields({ reasoningEffort: word, description: prose }),
            ),
            inputModalities: list(word),
            supportsPersonality: bool,
            upgrade: nullable(shaped(/^[\w.-]{1,64}$/)),
          }),
          KEEP + 1,
        )(
          Array.isArray(value)
            ? [
                ...value.filter((model) => (model as Json)?.isDefault === true),
                ...value.filter((model) => (model as Json)?.isDefault !== true),
              ]
            : value,
        ),
    }),
    "skills/list": fields({
      data: list(
        fields({
          cwd: label("<cwd>"),
          skills: (value) => {
            const skills = placeholders("skill", {
              scope: oneOf("user", "repo", "system", "admin"),
              enabled: bool,
            })(value);
            return skills === DROP
              ? DROP
              : (skills as Array<Json>).map((skill) => ({
                  name: skill.name,
                  description: "",
                  path: "<path>",
                  ...skill,
                  pluginId: null,
                }));
          },
          errors: constant([]),
        }),
      ),
    }),
    "mcpServerStatus/list": fields({
      nextCursor: cursor,
      data: placeholders("server", {
        runtimeStatus: nullable(word),
        // The person's servers' tools: their names become placeholders, and nothing else is kept.
        tools: (value) =>
          isObject(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .map((name) => rename("tool", name))
                  .filter(kept)
                  .map((name) => [name, {}]),
              )
            : DROP,
        authStatus: oneOf(
          "unknown",
          "unsupported",
          "notLoggedIn",
          "bearerToken",
          "oAuth",
        ),
      }),
    }),
  };
  /** The fields kept of each notification a fixture holds; any other notification keeps none. */
  const notifications: Record<string, Rule> = {
    "remoteControl/status/changed": fields({
      status: word,
      serverName: nullable(label("<redacted>")),
      installationId: nullable(label("<redacted>")),
      environmentId: nullable(label("<redacted>")),
    }),
    "account/updated": fields({
      authMode: nullable(word),
      reason: nullable(word),
    }),
  };

  const methods = new Map<unknown, string>();
  const keep = (rule: Rule | undefined, value: unknown) => {
    const safe = rule === undefined ? DROP : rule(value);
    return safe === DROP ? {} : safe;
  };
  const incoming = (item: Json): Json => {
    if (typeof item.method === "string")
      return {
        method: item.method,
        params: keep(notifications[item.method], item.params),
        ...("emittedAtMs" in item ? { emittedAtMs: 0 } : {}),
      };
    if (isObject(item.error))
      return {
        id: item.id,
        error: fields({
          code: whole,
          message: label("<message>"),
          data: fields({ type: word }),
        })(item.error),
      };
    const method = methods.get(item.id);
    const rule = method === undefined ? undefined : results[method];
    if (rule === undefined) throw new Error(`no allow-list for ${method}`);
    return { id: item.id, result: keep(rule, item.result) };
  };
  const entries: Array<Recorded> = recording.entries.map(
    ({ direction, message }) => {
      const item = message as Json;
      if (direction === "out") {
        if (item.method !== undefined)
          methods.set(item.id, String(item.method));
        return { direction, message };
      }
      return { direction, message: incoming(item) };
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
