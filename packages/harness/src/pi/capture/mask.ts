import {
  artifactRepresentation,
  encodeArtifactText,
} from "./representation.ts";
import { maskText } from "../../masking.ts";
import type {
  CallRecord,
  RunDump,
  SessionDump,
  StoredDocument,
} from "./dump.ts";
import type { Json } from "./types.ts";
import {
  foldJson,
  isJsonObject as isObject,
  jsonObjectFrom as fromEntries,
  rebuildJson,
} from "./json-walk.ts";

/**
 * What leaves the run for a capture or a dataset. A restricted capture masks clear identifiers over
 * parsed JSON (10.148) and credential fields by their key, and keeps opaque provider continuation
 * and returned reasoning summaries exactly, for replay and evals; it is never printed. A portable
 * copy also withholds that continuation and reasoning. Masking reaches only content: what a person,
 * a source, a tool or the model wrote. The dump's own fields and the protocol of the records it
 * carries (identities, discriminators, enum tokens, tool schemas) are never masked, so a declared
 * identifier that happens to equal one leaves the dump readable. Every function here returns a new
 * value and never mutates its input, so what the model saw and what the provider is sent stay
 * untouched.
 */

/** Keys whose value is a credential wherever it appears, compared without case, `-` or `_`. */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "xapikey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "bearertoken",
  "token",
  "clientsecret",
  "password",
  "secret",
]);

const isCredentialKey = (key: string) =>
  CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));

const REASONING_EVENT = /^response\.reasoning_(summary_)?(text|part)\./;

/**
 * Which reasoning a field carries, from its key and the object's `type` (or, for a captured stream
 * event, its `name`). `continuation` is opaque provider state a stateless replay needs exactly:
 * OpenAI's `encrypted_content`, pi's `thinkingSignature`, Anthropic's thinking `signature`,
 * `redacted_thinking` `data` and `signature_delta`. `summary` is readable reasoning the provider
 * returned: OpenAI's reasoning item `summary` and `content`, its reasoning summary and text stream
 * events (a `delta` is a plain string there), and the `thinking` of pi's and Anthropic's thinking
 * blocks and `thinking_delta`s. A restricted capture keeps both byte for byte and masks nothing
 * inside them; a portable copy withholds both.
 */
const reasoningField = (
  object: { readonly [key: string]: Json },
  key: string,
): "continuation" | "summary" | undefined => {
  if (key === "encrypted_content" || key === "thinkingSignature")
    return "continuation";
  const type = object["type"];
  const name = object["name"];
  if (typeof name === "string" && REASONING_EVENT.test(name) && key === "data")
    return "summary";
  if (typeof type !== "string") return undefined;
  if (type === "thinking" || type === "redacted_thinking")
    return key === "signature" || key === "data"
      ? "continuation"
      : key === "thinking"
        ? "summary"
        : undefined;
  if (type === "signature_delta")
    return key === "signature" ? "continuation" : undefined;
  if (type === "thinking_delta")
    return key === "thinking" ? "summary" : undefined;
  if (type === "reasoning")
    return key === "summary" || key === "content" ? "summary" : undefined;
  if (type === "summary_text" || type === "reasoning_text")
    return key === "text" ? "summary" : undefined;
  return REASONING_EVENT.test(type) &&
    (key === "text" || key === "delta" || key === "part")
    ? "summary"
    : undefined;
};

/**
 * Keys whose string values are protocol rather than narrative wherever a record's own structure
 * holds them: the discriminators, identities and enum tokens of pi's records (an entry's `kind`, a
 * message's `role`, a block's `type`, `stopReason`, a tool's `name`, a diagnostic's `code`) and of
 * the providers' wire (`type`, `status`, `include`, `tool_choice`). A key naming an identity (`id`,
 * `…Id`, `…_id`) is one too.
 */
const PROTOCOL_KEYS: ReadonlySet<string> = new Set([
  "type",
  "role",
  "kind",
  "name",
  "status",
  "code",
  "action",
  "api",
  "provider",
  "model",
  "responseModel",
  "namespace",
  "stopReason",
  "stop_reason",
  "mimeType",
  "media_type",
  "toolName",
  "thinkingLevel",
  "providerThinkingLevel",
  "object",
  "include",
  "tool_choice",
  "effort",
  "phase",
  "replay",
  "severity",
]);

const isProtocolKey = (key: string) =>
  PROTOCOL_KEYS.has(key) ||
  key === "id" ||
  key.endsWith("Id") ||
  key.endsWith("_id");

/** Values the model or a tool wrote whole (a call's arguments, a result's details, prompt sections): every string in them is content, whatever its key. */
const PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "arguments",
  "detail",
  "details",
  "metadata",
  "body",
  "headers",
  "sections",
]);

/** A tool's JSON Schema keeps its keywords, types and property names; annotations carry content. */
const SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "parameters",
  "input_schema",
]);
const SCHEMA_PROSE: ReadonlySet<string> = new Set(["description", "title"]);
const SCHEMA_CONTENT: ReadonlySet<string> = new Set([
  "default",
  "examples",
  "example",
]);
const SCHEMA_MAPS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/**
 * Where a value sits. `record`: a pi or provider record's own structure, whose protocol keys are
 * kept. `payload`: content whole. `schema`: a tool's parameters.
 */
type Region = "record" | "payload" | "schema" | "schema-map";

const regionOf = (region: Region, key: string, item: Json): Region => {
  if (region === "schema-map") return "schema";
  if (region === "schema") {
    if (SCHEMA_CONTENT.has(key)) return "payload";
    if (SCHEMA_MAPS.has(key)) return "schema-map";
  }
  if (region !== "record") return region;
  if (PAYLOAD_KEYS.has(key)) return "payload";
  return SCHEMA_KEYS.has(key) && isObject(item) ? "schema" : "record";
};

/**
 * One content string masked. A string that holds a JSON object or array (a provider's raw function
 * arguments, a tool's JSON output) is masked over its parsed values and written back as JSON, so an
 * email after an escape (`\nann@x.dev`) cannot take the escape with it and leave the inner JSON
 * unreadable. With nothing to mask it comes back byte for byte; masked, it is the sanitized form,
 * and the raw journal or native backup keeps the original.
 */
const transformString = (
  text: string,
  transform: (value: Json) => Json,
  plain: (text: string) => string,
): string => {
  if (/^\s*[[{"]/.test(text)) {
    let parsed: Json | undefined;
    try {
      parsed = JSON.parse(text) as Json;
    } catch {}
    if (parsed !== undefined) {
      const transformed = transform(parsed);
      return JSON.stringify(transformed) === JSON.stringify(parsed)
        ? text
        : JSON.stringify(transformed);
    }
  }
  return plain(text);
};

const maskString = (text: string, declared: ReadonlyArray<string>): string =>
  transformString(
    text,
    (value) => walk(value, "payload", undefined, declared),
    (value) => maskText(value, declared),
  );

/**
 * Masking over parsed JSON (10.148): `maskText` runs on each string value, never on the serialized
 * text, where an email after an escape (`\nann@x.dev`) took the escape's letter with it and left an
 * unreadable record. A credential key keeps its name and loses its value. Provider reasoning,
 * opaque or readable, is left exactly as it is. Keys, numbers, booleans and null are kept; an
 * array's items are read under the key that holds it.
 */
const walk = (
  value: Json,
  region: Region,
  key: string | undefined,
  declared: ReadonlyArray<string>,
): Json =>
  foldJson<
    {
      region: Region;
      key: string | undefined;
      replacement: Json | undefined;
    },
    Json
  >(
    value,
    { region, key, replacement: undefined },
    (value, context, children) => {
      if (context.replacement !== undefined) return context.replacement;
      const { region, key } = context;
      if (typeof value === "string") {
        if (region === "schema" || region === "schema-map")
          return key !== undefined && SCHEMA_PROSE.has(key)
            ? maskText(value, declared)
            : value;
        return region === "record" && key !== undefined && isProtocolKey(key)
          ? value
          : maskString(value, declared);
      }
      return rebuildJson(
        value,
        children((field, item) =>
          isObject(value)
            ? {
                region: regionOf(region, field, item),
                key: field,
                replacement:
                  region !== "schema" &&
                  region !== "schema-map" &&
                  item !== null &&
                  isCredentialKey(field)
                    ? "<masked>"
                    : region === "record" &&
                        reasoningField(value, field) !== undefined
                      ? item
                      : undefined,
              }
            : context,
        ),
      );
    },
  );

/** Content whole, every string masked: an artifact, a working copy, a tool's output. */
export const maskJson = (
  value: Json,
  declared: ReadonlyArray<string> = [],
): Json => walk(value, "payload", undefined, declared);

/** A pi or provider record: its content masked, its protocol kept. */
export const maskRecord = (
  value: Json,
  declared: ReadonlyArray<string> = [],
): Json => walk(value, "record", undefined, declared);

export type MaskedText =
  | { readonly _tag: "Masked"; readonly text: string }
  | { readonly _tag: "Malformed"; readonly reason: string };

/**
 * Masks one stored JSON text. Text with nothing to mask comes back byte for byte; text that is not
 * JSON is reported as malformed, never repaired or masked as plain text.
 */
export const maskJsonText = (
  text: string,
  declared: ReadonlyArray<string> = [],
): MaskedText => {
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch (error) {
    return {
      _tag: "Malformed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const masked = maskJson(parsed, declared);
  const serialized = JSON.stringify(masked);
  return {
    _tag: "Masked",
    text: serialized === JSON.stringify(parsed) ? text : serialized,
  };
};

export const isJsonMediaType = (mediaType: string) =>
  /^application\/(?:[\w.-]+\+)?json(?:;.*)?$/i.test(mediaType.trim());

export type MaskedArtifact =
  | { readonly _tag: "Masked"; readonly bytes: Uint8Array }
  | { readonly _tag: "Unmaskable"; readonly bytes: Uint8Array }
  | { readonly _tag: "Malformed"; readonly reason: string };

export const maskArtifact = (
  mediaType: string,
  bytes: Uint8Array,
  declared: ReadonlyArray<string> = [],
): MaskedArtifact => {
  const representation = artifactRepresentation({ mediaType, bytes });
  if (representation._tag === "Malformed") return representation;
  if (representation._tag === "Binary") return { _tag: "Unmaskable", bytes };
  if (!representation.json)
    return {
      _tag: "Masked",
      bytes: encodeArtifactText(
        maskString(representation.text, declared),
        representation,
      ),
    };
  const masked = maskJsonText(representation.text, declared);
  return masked._tag === "Malformed"
    ? masked
    : {
        _tag: "Masked",
        bytes: encodeArtifactText(masked.text, representation),
      };
};

/** What a portable copy withholds; a restricted capture withholds nothing. */
export const PORTABLE_WITHHELD = [
  "encrypted-continuation",
  "reasoning-summaries",
  "native-backup",
  "raw-journal",
  "projection-recipe",
  "original-artifacts",
  "raw-artifacts",
] as const;

const withheldText = (what: string, value: Json) =>
  `<withheld: ${what}, ${typeof value === "string" ? value.length : JSON.stringify(value).length} characters>`;

/**
 * The portable form of a value: opaque continuation and readable reasoning withheld wherever they
 * are carried, each replaced by a marker that names what was withheld. A portable copy is for
 * inspection only; it can never replay a conversation.
 */
export const withholdReasoning = (value: Json): Json =>
  foldJson<
    "normal" | "summary-array" | "summary-part" | "summary" | "continuation",
    Json
  >(value, "normal", (value, context, children) => {
    if (typeof value === "string")
      return context === "summary" || context === "continuation"
        ? withheldText(
            context === "continuation"
              ? "encrypted reasoning"
              : "reasoning summary",
            value,
          )
        : withholdReasoningText(value);
    return rebuildJson(
      value,
      children((key, item) => {
        if (context === "summary-array") return "summary-part";
        if (!isObject(value)) return "normal";
        if (
          context === "summary-part" &&
          key === "text" &&
          typeof item === "string"
        )
          return "summary";
        const field = item === null ? undefined : reasoningField(value, key);
        return field !== undefined && typeof item === "string"
          ? field
          : field === "summary" && Array.isArray(item)
            ? "summary-array"
            : "normal";
      }),
    );
  });

export const withholdReasoningText = (text: string): string =>
  transformString(text, withholdReasoning, (value) => value);

/** Native entry metadata is separate from its application-defined data. */
const maskEntry = (value: Json, declared: ReadonlyArray<string>): Json => {
  if (!isObject(value)) return maskJson(value, declared);
  return fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "model" || key === "edits"
        ? maskRecord(item, declared)
        : key === "data"
          ? value["kind"] === "pi.tool-result"
            ? maskRecord(item, declared)
            : maskJson(item, declared)
          : item,
    ]),
  );
};

const NATIVE_TASKS: ReadonlySet<string> = new Set([
  "pi.generation",
  "pi.tool",
  "pi.compaction",
]);

/** The checkpoint's phase and pi's built-in bookkeeping are protocol; task-owned values are content. */
const maskCheckpoint = (
  value: Json,
  native: boolean,
  declared: ReadonlyArray<string>,
): Json => {
  if (!isObject(value)) return maskJson(value, declared);
  return fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "phase"
        ? item
        : !native || key === "arguments" || key === "overflow"
          ? maskJson(item, declared)
          : key === "streamOptions" && isObject(item)
            ? fromEntries(
                Object.entries(item).map(([field, content]) => [
                  field,
                  field === "headers" || field === "metadata"
                    ? maskJson(content, declared)
                    : content,
                ]),
              )
            : item,
    ]),
  );
};

const maskTask = (value: Json, declared: ReadonlyArray<string>): Json => {
  if (!isObject(value)) return maskJson(value, declared);
  const native =
    typeof value["kind"] === "string" && NATIVE_TASKS.has(value["kind"]);
  const input = value["input"];
  const maskedInput =
    input !== undefined && native && isObject(input)
      ? fromEntries(
          Object.entries(input).map(([key, item]) => [
            key,
            key === "instructions" ? maskJson(item, declared) : item,
          ]),
        )
      : input === undefined
        ? undefined
        : maskJson(input, declared);
  const state = value["state"];
  const maskedState =
    state !== undefined && isObject(state)
      ? fromEntries(
          Object.entries(state).map(([key, item]) => [
            key,
            key === "checkpoint"
              ? maskCheckpoint(item, native, declared)
              : key === "outcome" && isObject(item)
                ? fromEntries(
                    Object.entries(item).map(([field, content]) => [
                      field,
                      (field === "result" && !native) ||
                      field === "error" ||
                      field === "reason"
                        ? maskJson(content, declared)
                        : content,
                    ]),
                  )
                : item,
          ]),
        )
      : state;
  return fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "input" && maskedInput !== undefined
        ? maskedInput
        : key === "memos"
          ? maskJson(item, declared)
          : key === "state" && maskedState !== undefined
            ? maskedState
            : item,
    ]),
  );
};

const maskLive = (value: Json, declared: ReadonlyArray<string>): Json => {
  if (!isObject(value)) return maskRecord(value, declared);
  return fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "compactions" && Array.isArray(item)
        ? item.map((compaction) =>
            isObject(compaction)
              ? fromEntries(
                  Object.entries(compaction).map(([field, content]) => [
                    field,
                    field === "retry" ? maskJson(content, declared) : content,
                  ]),
                )
              : maskRecord(compaction, declared),
          )
        : maskRecord(item, declared),
    ]),
  );
};

const maskInbox = (value: Json, declared: ReadonlyArray<string>): Json => {
  if (!isObject(value) || !Array.isArray(value["items"]))
    return maskJson(value, declared);
  return {
    ...value,
    items: value["items"].map((item) =>
      isObject(item)
        ? fromEntries(
            Object.entries(item).map(([key, content]) => [
              key,
              key === "entry"
                ? maskEntry(content, declared)
                : key === "content"
                  ? maskRecord(content, declared)
                  : content,
            ]),
          )
        : maskJson(item, declared),
    ),
  };
};

const maskDocument = (
  document: StoredDocument,
  declared: ReadonlyArray<string>,
): StoredDocument => ({
  ...document,
  value:
    document.kind === "pi.agent" && isObject(document.value)
      ? fromEntries(
          Object.entries(document.value).map(([key, value]) => [
            key,
            key === "instructions" || key === "cwd"
              ? maskJson(value, declared)
              : value,
          ]),
        )
      : document.kind === "pi.inbox"
        ? maskInbox(document.value, declared)
        : document.kind === "pi.live"
          ? maskLive(document.value, declared)
          : maskJson(document.value, declared),
});

/** A call's restricted form: its body, events and error masked as content; its identities, route, model and outcome kept. */
export const restrictCall = (
  call: CallRecord,
  declared: ReadonlyArray<string>,
): CallRecord => ({
  ...call,
  ...(call.sdkContext === undefined
    ? {}
    : {
        sdkContext: {
          ...call.sdkContext,
          messages: call.sdkContext.messages.map((message) =>
            maskRecord(message, declared),
          ),
        },
      }),
  body:
    call.body.status === "sent"
      ? { status: "sent", json: maskRecord(call.body.json, declared) }
      : { status: "missing", reason: maskString(call.body.reason, declared) },
  events: call.events.map((event) => ({
    ...event,
    data: maskRecord(event.data, declared),
  })),
  end:
    call.end?.error === undefined
      ? call.end
      : {
          ...call.end,
          error: {
            ...call.end.error,
            message: maskString(call.end.error.message, declared),
          },
        },
});

/**
 * A conversation's restricted form: pi's entries, tasks, documents, offered tools and live partial
 * masked as records, each turn's error as content; its identities, binding, status and derived
 * turns kept.
 */
export const restrictSession = (
  session: SessionDump,
  declared: ReadonlyArray<string>,
): SessionDump => ({
  ...session,
  entries: session.entries.map((entry) => maskEntry(entry, declared)),
  tasks: session.tasks.map((task) => maskTask(task, declared)),
  documents: session.documents.map((d) => maskDocument(d, declared)),
  taskDocuments: session.taskDocuments.map((task) => ({
    ...task,
    documents: task.documents.map((d) => maskDocument(d, declared)),
  })),
  offeredTools: session.offeredTools.map((offered) => ({
    ...offered,
    added: offered.added.map((tool) => maskRecord(tool, declared)),
  })),
  turns: session.turns.map((turn) =>
    turn.errorMessage === undefined
      ? turn
      : { ...turn, errorMessage: maskString(turn.errorMessage, declared) },
  ),
  inFlight:
    session.inFlight === null ? null : maskLive(session.inFlight, declared),
  calls: session.calls.map((call) => restrictCall(call, declared)),
});

/**
 * The run's restricted form: pi's session documents masked as records and the reasons stages and
 * lead fates gave as content; its identities, kind, statuses, gaps, files and totals kept.
 */
export const restrictRun = (
  run: RunDump,
  declared: ReadonlyArray<string>,
): RunDump => ({
  ...run,
  stages: run.stages.map((stage) =>
    stage.reason === undefined
      ? stage
      : { ...stage, reason: maskString(stage.reason, declared) },
  ),
  sessionDocuments: run.sessionDocuments.map((d) => maskDocument(d, declared)),
  leads: {
    ...run.leads,
    ledger: run.leads.ledger.map((lead) => ({
      ...lead,
      fates: lead.fates.map((fate) =>
        fate.reason === undefined
          ? fate
          : { ...fate, reason: maskString(fate.reason, declared) },
      ),
    })),
  },
});
