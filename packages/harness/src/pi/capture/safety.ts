import { closeCeiling, type CloseInventory } from "./watchdog.ts";
import { withRetainedSdk, RetainedSdkUnavailable } from "./retained-sdk.ts";
import { RetainedContextUnavailable } from "./retained-context.ts";
import { sdkFailure, type SdkDiagnostic } from "./sdk-diagnostic.ts";
import { callsOf } from "./call-lifecycle.ts";
import {
  ARTIFACT_TEXT_POLICY,
  artifactRepresentation,
  type ArtifactSource,
} from "./representation.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { SourceOwnership } from "../source-ownership.ts";
import {
  CredentialJson,
  type CredentialSource,
  CredentialDetectors,
  InspectionBudget,
  DEFAULT_INSPECTION_LIMITS,
  type InspectionResult,
} from "./credential-detectors.ts";
import {
  createPrivateInspection,
  openPrivateInspection,
  type PrivateInspection,
} from "./private-inspection.ts";
import { readCaptureLosses, readCaptureJournal } from "./journal.ts";
import {
  CREDENTIAL_INSPECTION_POLICY,
  RETAINED_SDK_ASSEMBLY_POLICY,
  RETAINED_SDK_PIN,
  Json,
} from "./types.ts";
import { tmpdir } from "node:os";
import type { NativeSnapshot } from "./sources.ts";
import { openAsItStands, openPrivateCopy } from "@neuve/records-core/read-only";
import { z } from "zod";
import type {
  Capture,
  CaptureLoss,
  CredentialCertificate,
  JournalLine,
  ModelCapture,
} from "./types.ts";

const CredentialGuard = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("observed") }),
  z.strictObject({
    status: z.literal("checked"),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.union([z.literal(2), z.literal(3)]),
    sourceHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
    administrationHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
]);
type Inspector = CredentialDetectors;
type Inspectors = Map<string, Inspector>;
const owners = new WeakMap<ModelCapture | Capture, Inspectors>();
const runs = new Map<string, WeakRef<Inspectors>>();

/** Standalone captures retain only volatile keyed detectors and make no restart promise. */
export const rememberEphemeralCredentials = async (
  capture: ModelCapture | Capture,
  runId: string,
  callId: string,
  headers: Headers,
) => {
  const inspectors = runs.get(runId)?.deref() ?? new Map<string, Inspector>();
  const engine = CredentialDetectors.empty(randomBytes(32));
  const { CredentialEpochId } = await import("./credential-detectors.ts");
  const registration = await engine.register({
    epoch: CredentialEpochId.parse(callId),
    headers,
    budget: new InspectionBudget(),
  });
  if (registration.status !== "registered")
    throw new Error("Ephemeral credential registration is unavailable");
  inspectors.set(callId, engine);
  owners.set(capture, inspectors);
  runs.set(runId, new WeakRef(inspectors));
  for (const [id, held] of runs)
    if (held.deref() === undefined) runs.delete(id);
};

const interruptedCredentialCalls = (
  lines: ReadonlyArray<JournalLine>,
): ReadonlySet<string> => {
  const sessions: Array<{ closed: boolean; calls: string[] }> = [];
  const ended = new Set<string>();
  for (const { event } of lines) {
    if (event.type === "journal.open")
      sessions.push({ closed: false, calls: [] });
    const current = sessions.at(-1);
    if (event.type === "journal.close" && current) current.closed = true;
    if (
      event.type === "model.request" &&
      event.credentialCoverage === "required"
    )
      current?.calls.push(event.callId);
    if (event.type === "model.end") ended.add(event.callId);
  }
  return new Set(
    sessions
      .slice(0, -1)
      .filter((session) => !session.closed)
      .flatMap((session) => session.calls)
      .filter((call) => !ended.has(call)),
  );
};

export const credentialLossEpochs = (
  losses: readonly CaptureLoss[],
  registrations: ReadonlyMap<string, string>,
) =>
  new Map(
    losses.flatMap(({ callId, event, credentialCoverage, epochId }) =>
      event === "credential.registration" || credentialCoverage === "required"
        ? [[callId, registrations.get(callId) ?? epochId ?? callId] as const]
        : [],
    ),
  );

type LossEvidence = {
  readonly epochs: ReadonlyMap<string, string>;
  readonly certificates?: readonly CredentialCertificate[];
};

export const CREDENTIAL_REGISTRATION_REFUSED =
  "historical calls lack durable registration; export refused";

export const credentialGuards = (
  lines: ReadonlyArray<JournalLine>,
  mode:
    | "certificates-only"
    | "inspect-retained-prefix"
    | {
        readonly portableRetainedPrefixes: ReadonlySet<string>;
      } = "certificates-only",
  loss?: LossEvidence,
) => {
  const retainedPrefixCalls: string[] = [];
  const interrupted = interruptedCredentialCalls(lines);
  const events = [
    ...lines.map(({ event }) => event),
    ...(loss?.certificates ?? []),
  ];
  const certifiedRetained = new Set(
    events.flatMap((event) =>
      event.type === "credential.inspection" && event.version === 3
        ? event.retainedPrefixCalls
        : [],
    ),
  );
  const guards = new Map<string, z.infer<typeof CredentialGuard>>();
  const certifiedLosses = new Set(
    loss?.certificates?.flatMap((certificate) => certificate.calls),
  );
  const registrations = new Map<string, string>();
  const required = new Set(loss?.epochs.keys());
  const pending = new Set<string>();
  const observed = new Set<string>();
  const ended = new Set<string>();
  let registrationUnaccountedFor = false;
  for (const event of events) {
    if (event.type === "journal.close") registrationUnaccountedFor = false;
    if (event.type !== "journal.open") continue;
    if (registrationUnaccountedFor) break;
    registrationUnaccountedFor = event.allowCredentialLoss === true;
  }
  if (registrationUnaccountedFor)
    return {
      refusal: CREDENTIAL_REGISTRATION_REFUSED,
      guards,
      retainedPrefixCalls,
      requiresInspection: true,
    };
  for (const event of events) {
    if (event.type === "model.end") ended.add(event.callId);
    if (event.type === "model.request") {
      const authenticated = event.headerNames.some((name) =>
        /authorization|api[-_]?key|cookie/i.test(name),
      );
      if (
        event.credentialCoverage === undefined ||
        (authenticated && event.credentialCoverage !== "required")
      )
        return {
          refusal:
            "credential coverage declaration is missing or contradicts the request; source retained privately, export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: required.size > 0,
        };
      if (event.credentialCoverage === "required") required.add(event.callId);
    }
    if (event.type === "artifact") {
      const count = /^count-tokens\/([^/]+)\//.exec(event.name);
      if (count?.[1] !== undefined) required.add(count[1]);
    }
    if (event.type === "credential.inspection")
      for (const callId of event.version === 3 ? event.calls : [event.callId])
        required.add(callId);
    if (event.type === "credential.registration") {
      const previous = registrations.get(event.callId);
      if (previous !== undefined && previous !== event.epochId)
        return {
          refusal:
            "conflicting historical credential registration; export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: true,
        };
      registrations.set(event.callId, event.epochId);
      required.add(event.callId);
    }
    if (event.type === "credential.guard") {
      required.add(event.callId);
      if (event.status === "pending") pending.add(event.callId);
      if (event.status === "observed") observed.add(event.callId);
    }
    if (event.type === "model.event" && event.name === "credential_guard") {
      required.add(event.callId);
      const guard = CredentialGuard.safeParse(event.data);
      if (guard.success && guard.data.status === "pending")
        pending.add(event.callId);
      if (guard.success && guard.data.status === "observed")
        observed.add(event.callId);
    }
  }
  for (const event of events) {
    if (event.type === "credential.inspection") {
      if (
        event.version === 3 &&
        event.calls.some((call) => {
          const epoch = registrations.get(call) ?? loss?.epochs.get(call);
          return epoch !== undefined && epoch !== event.epochId;
        })
      )
        return {
          refusal:
            "credential epoch certificate contradicts registration; export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: true,
        };
      if (!event.safe)
        return {
          refusal:
            "credential exposure in native source or artifact; source retained privately, export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: required.size > 0,
        };
      for (const callId of event.version === 3 ? event.calls : [event.callId])
        guards.set(callId, {
          status: "checked",
          version: event.version,
          sourceHash: event.sourceHash,
          sourceHashes: event.sourceHashes,
          ...(event.version === 2
            ? {}
            : { administrationHash: event.administrationHash }),
        });
      continue;
    }
    if (event.type === "credential.guard") {
      if (event.status === "exposed")
        return {
          refusal:
            "credential exposure was observed; exact native source retained privately, export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: required.size > 0,
        };
      guards.set(event.callId, { status: event.status });
      continue;
    }
    if (event.type !== "model.event") continue;
    if (event.name === "credential_redactions")
      return {
        refusal:
          "credential exposure was observed; exact native source retained privately, export refused",
        guards,
        retainedPrefixCalls,
        requiresInspection: required.size > 0,
      };
    if (event.name === "credential_guard") {
      const guard = CredentialGuard.safeParse(event.data);
      if (!guard.success)
        return {
          refusal: "invalid credential inspection fact; export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: required.size > 0,
        };
      guards.set(event.callId, guard.data);
    }
  }
  for (const callId of required) {
    if (loss?.epochs.has(callId)) {
      if (mode !== "inspect-retained-prefix" && !certifiedLosses.has(callId))
        return {
          refusal: "lost call lacks a credential certificate; export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: true,
        };
      if (!ended.has(callId)) continue;
    }
    if (!pending.has(callId))
      return {
        refusal:
          "credential coverage is unfinished or required guard facts are missing; source retained privately, export refused",
        guards,
        retainedPrefixCalls,
        requiresInspection: true,
      };
    if (!observed.has(callId)) {
      if (
        typeof mode === "object"
          ? !mode.portableRetainedPrefixes.has(callId)
          : !registrations.has(callId) ||
            !interrupted.has(callId) ||
            (mode === "certificates-only" && !certifiedRetained.has(callId))
      )
        return {
          refusal:
            "credential coverage is unfinished or required guard facts are missing; source retained privately, export refused",
          guards,
          retainedPrefixCalls,
          requiresInspection: true,
        };
      retainedPrefixCalls.push(callId);
    }
  }
  return {
    refusal: null,
    guards,
    retainedPrefixCalls,
    requiresInspection: required.size > 0,
  };
};

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

// Changing interpretation policy invalidates certificates from the UTF-8-only inspector.
const sourceIdentity = (kind: string, value: string | Uint8Array) =>
  hash(
    `credential-representations-v2:${kind}:${hash(typeof value === "string" ? Buffer.from(value, "utf16le") : value)}`,
  );

const POLICY = `${ARTIFACT_TEXT_POLICY}:${CREDENTIAL_INSPECTION_POLICY}:${RETAINED_SDK_ASSEMBLY_POLICY}:${RETAINED_SDK_PIN}`;
const POLICY_SOURCE = sourceIdentity("policy", POLICY);
const EVENT_FRAME = "event-frame";

export const credentialFrameIdentity = (text: string) =>
  sourceIdentity(EVENT_FRAME, text);

export const credentialSourceHash = (sources: ReadonlyArray<string>) =>
  hash(JSON.stringify([...new Set(sources)].toSorted()));

export type { CredentialSource } from "./credential-detectors.ts";
export const credentialSourceText = (source: CredentialSource): string =>
  source.kind === "text"
    ? source.text
    : source.kind === "json"
      ? source.json.contents()
      : new TextDecoder().decode(source.bytes);
export const administrativeFrame = (line: JournalLine): boolean =>
  [
    "journal.open",
    "journal.close",
    "credential.inspection",
    "credential.guard",
  ].includes(line.event.type) ||
  (line.event.type === "model.event" && line.event.name === "credential_guard");
export const credentialAdministrationHash = (
  lines: ReadonlyArray<JournalLine>,
  frames: ReadonlyArray<CredentialJson>,
  losses?: readonly CaptureLoss[],
): string => {
  const values: string[] = [];
  for (const [index, line] of lines.entries())
    if (
      administrativeFrame(line) &&
      line.event.type !== "credential.inspection"
    ) {
      const frame = frames[index];
      if (frame === undefined || frame.contents() !== JSON.stringify(line))
        throw new Error("Noncanonical credential administration");
      values.push(frame.contents());
    }
  if (losses !== undefined) values.push(JSON.stringify(losses));
  return hash(Buffer.from(JSON.stringify(values), "utf16le"));
};
export const credentialFramesAdministrationHash = (
  frames: ReadonlyArray<CredentialJson>,
): string =>
  hash(
    Buffer.from(
      JSON.stringify(frames.map((frame) => frame.contents())),
      "utf16le",
    ),
  );

export class CredentialSourceUnavailable extends Error {
  constructor(
    readonly reason: "retained-stream-prefix" | "retained-argument-escape",
    readonly callIndex: number,
    readonly diagnostic: SdkDiagnostic,
    readonly failureKind?: "worker" | "cancelled",
  ) {
    super("Credential source inspection unavailable");
  }
}

/** The installed SDK owns every generated scalar, including superseded partial state. */
const authenticatedSdkViews = async (
  lines: ReadonlyArray<JournalLine>,
  native: NativeSnapshot,
  keep: (text: string) => Promise<void>,
  budget?: InspectionBudget,
): Promise<void> => {
  const all = callsOf(lines, true, () => {});
  await withRetainedSdk(async (run) => {
    for (const [index, call] of [...all.values()].entries()) {
      if (call.credentialCoverage !== "required") continue;
      const refuse = (error: unknown) => {
        const diagnostic =
          error instanceof RetainedSdkUnavailable
            ? error.diagnostic
            : undefined;
        return new CredentialSourceUnavailable(
          error instanceof RetainedSdkUnavailable &&
            error.message === "retained-argument-escape"
            ? "retained-argument-escape"
            : "retained-stream-prefix",
          index + 1,
          diagnostic ?? {
            reason:
              error instanceof RetainedContextUnavailable
                ? "SDK context unavailable"
                : sdkFailure(error),
            callbacks: 0,
            originalCallbacks: null,
            frameIndex: 0,
            frameType: "other",
            expectedFrameType: "other",
          },
          error instanceof RetainedSdkUnavailable
            ? error.failureKind
            : undefined,
        );
      };
      const responses = call.events.some(({ name }) =>
        name.startsWith("response."),
      );
      const messages = call.events.some(
        ({ name }) =>
          name.startsWith("message_") || name.startsWith("content_block_"),
      );
      const api =
        call.api ??
        call.sdkContext?.model.api ??
        (responses && !messages
          ? "openai-responses"
          : messages && !responses
            ? "anthropic-messages"
            : undefined);
      if (
        (api !== "openai-responses" && api !== "anthropic-messages") ||
        (api === "openai-responses" && messages) ||
        (api === "anthropic-messages" && responses)
      )
        throw refuse(new RetainedSdkUnavailable("SDK API mismatch"));
      try {
        const scalars: string[] = [];
        await run(
          call,
          native,
          (value) => {
            scalars.push(value);
          },
          budget,
          {
            purpose: "scalar-enumeration",
          },
        );
        for (const scalar of scalars) await keep(scalar);
      } catch (error) {
        if (
          error instanceof RetainedContextUnavailable ||
          error instanceof RetainedSdkUnavailable
        )
          throw refuse(error);
        throw error;
      }
    }
  });
};

/** Whole raw frames and byte objects stay distinct from owner-serialized JSON and exact strings. */
export const visitCredentialSources = async (
  native: NativeSnapshot,
  backup: Uint8Array | undefined,
  lines: ReadonlyArray<JournalLine>,
  artifacts: Iterable<ArtifactSource> | AsyncIterable<ArtifactSource>,
  frames: ReadonlyArray<CredentialJson> | undefined,
  budget: InspectionBudget,
  visit: (identity: string, source: CredentialSource) => Promise<void>,
  objects: readonly CredentialJson[] = [],
): Promise<void> => {
  const sources = new Set<string>();
  const accept = async (identity: string, source: CredentialSource) => {
    if (sources.has(identity)) return;
    sources.add(identity);
    await visit(identity, source);
  };
  const account = (units: number) => budget?.charge("units", units);
  const text = async (kind: string, value: string) => {
    account(value.length);
    return accept(sourceIdentity(kind, value), {
      kind: "text",
      text: value,
    });
  };
  const json = async (kind: string, value: CredentialJson) => {
    account(value.contents().length);
    return accept(sourceIdentity(kind, value.contents()), {
      kind: "json",
      json: value,
    });
  };
  const bytes = async (kind: string, value: Uint8Array, mediaType: string) => {
    account(value.byteLength);
    return accept(sourceIdentity(kind, value), {
      kind: "bytes",
      bytes: value,
      mediaType,
    });
  };
  await text("policy", POLICY);
  await json("native", CredentialJson.serialize(native));
  for (const [index, line] of lines.entries()) {
    if (administrativeFrame(line)) continue;
    const frame = frames?.[index];
    await budget?.checkpoint(4096);
    if (frame) await json(EVENT_FRAME, frame);
    else await json("event", CredentialJson.serialize(line.event));
  }
  for (const object of objects) {
    await budget?.checkpoint(4096);
    await json("journal-object", object);
  }
  await authenticatedSdkViews(
    lines,
    native,
    (value) => text("retained-stream-prefix", value),
    budget,
  );
  for await (const artifact of artifacts) {
    account(artifact.bytes.byteLength);
    budget?.charge("decodeUnits", artifact.bytes.byteLength * 2);
    await budget?.checkpoint(artifact.bytes.byteLength);
    const representation = artifactRepresentation(artifact);
    if (representation._tag === "Malformed")
      throw new Error(representation.reason);
    await bytes(
      `artifact-raw:${artifact.mediaType}`,
      artifact.bytes,
      artifact.mediaType,
    );
    if (representation._tag === "Text")
      await text(
        `artifact-text:${artifact.mediaType}:${representation.encoding}`,
        representation.text,
      );
  }
  if (backup !== undefined) {
    await bytes("backup", backup, "application/octet-stream");
    const staging = await mkdtemp(join(tmpdir(), "neuve-credential-source-"));
    try {
      const path = join(staging, "pi.sqlite");
      await writeFile(path, backup, { mode: 0o600 });
      const database = openPrivateCopy(path);
      try {
        const tables = [
          "sqlite_schema",
          ...database
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
            .all()
            .map((row) => z.string().parse(row["name"])),
        ];
        for (const name of tables)
          for (const row of database
            .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
            .iterate())
            for (const value of Object.values(row)) {
              account(1);
              await budget?.checkpoint(4096);
              if (typeof value === "string") await text("cell", value);
              else if (value instanceof Uint8Array)
                await bytes("cell", value, "application/octet-stream");
            }
      } finally {
        database.close();
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
};

/** Materialized compatibility for readers that need an inventory before checking certificates. */
export const credentialSources = async (
  native: NativeSnapshot,
  backup: Uint8Array | undefined,
  lines: ReadonlyArray<JournalLine>,
  artifacts: Iterable<ArtifactSource> | AsyncIterable<ArtifactSource>,
  frames?: ReadonlyArray<CredentialJson>,
  budget: InspectionBudget = closeInspectionBudget(),
  objects: readonly CredentialJson[] = [],
): Promise<ReadonlyMap<string, CredentialSource>> => {
  const sources = new Map<string, CredentialSource>();
  await visitCredentialSources(
    native,
    backup,
    lines,
    artifacts,
    frames,
    budget,
    async (identity, source) => {
      sources.set(identity, source);
      budget.progress();
    },
    objects,
  );
  return sources;
};

export const inspectCredentialSource = (
  authority: PrivateInspection,
  source: CredentialSource,
  budget: InspectionBudget,
): Promise<InspectionResult> =>
  source.kind === "json"
    ? authority.inspectJson({ json: source.json, budget })
    : source.kind === "text"
      ? authority.inspectText({ text: source.text, budget })
      : authority.inspectArtifact({
          bytes: source.bytes,
          mediaType: source.mediaType,
          budget,
        });
export const closeInspectionBudget = (
  inventory: CloseInventory = { records: 0, bytes: 0, calls: 0, frames: 0 },
  started = performance.now(),
  signal?: AbortSignal,
) =>
  new InspectionBudget(
    {
      ...DEFAULT_INSPECTION_LIMITS,
      units: 32 * 1024 * 1024 * 1024,
      parseUnits: 16 * 1024 * 1024 * 1024,
      decodeUnits: 16 * 1024 * 1024 * 1024,
      fullChecks: 1_000_000,
      fullBytes: 16 * 1024 * 1024 * 1024,
      parseValueUnits: 64 * 1024 * 1024,
      yieldUnits: 65_536,
    },
    signal,
    started + closeCeiling(inventory),
  );

export const openManagedCredentialInspection = (input: {
  readonly ownership: SourceOwnership;
  readonly source: string;
  readonly directory: string;
  readonly journal: string;
  readonly nativeDatabase: string;
  readonly excludedRoots: ReadonlyArray<string>;
}): PrivateInspection => {
  const options = {
    ownership: input.ownership,
    source: input.source,
    directory: input.directory,
    excludedRoots: input.excludedRoots,
  };
  input.ownership.assertSource(input.source);
  if (existsSync(input.directory)) return openPrivateInspection(options);
  const journal = readCaptureJournal(input.journal);
  if (
    journal._tag !== "Read" ||
    readCaptureLosses(input.journal).some(
      ({ credentialCoverage }) => credentialCoverage === "required",
    ) ||
    credentialGuards(journal.lines).requiresInspection ||
    journal.lines.some((line) => line.event.type === "credential.registration")
  )
    throw new Error("Historical credential authority is unavailable");
  if (existsSync(input.nativeDatabase)) {
    // Whether it's empty, as it stands, under this source's ownership. Wholeness is proved only
    // where a capture accepts bytes.
    const { database } = openAsItStands(input.nativeDatabase);
    try {
      if (
        database.prepare("SELECT count(*) AS count FROM entries").get()?.[
          "count"
        ] !== 0 ||
        database.prepare("SELECT count(*) AS count FROM documents").get()?.[
          "count"
        ] !== 0
      )
        throw new Error(
          "Unregistered historical native source cannot acquire a new authority",
        );
    } finally {
      database.close();
    }
  }
  mkdirSync(dirname(input.directory), { recursive: true, mode: 0o700 });
  return createPrivateInspection(options);
};

const certifiedSources = (
  lines: ReadonlyArray<JournalLine>,
  certificates: readonly CredentialCertificate[] = [],
) => {
  const sources = new Map<string, Set<string>>();
  for (const event of [...lines.map(({ event }) => event), ...certificates])
    if (
      event.type === "credential.inspection" &&
      event.safe &&
      event.sourceHashes.includes(POLICY_SOURCE) &&
      event.sourceHash === credentialSourceHash(event.sourceHashes)
    ) {
      for (const callId of event.version === 3 ? event.calls : [event.callId]) {
        const covered = sources.get(callId) ?? new Set<string>();
        for (const source of event.sourceHashes) covered.add(source);
        sources.set(callId, covered);
      }
    }
  return sources;
};

export const credentialBackupCertified = (
  runId: string,
  lines: ReadonlyArray<JournalLine>,
  bytes: Uint8Array,
  administrationHash?: string,
) => {
  const own = lines.filter((line) => line.event.scope.runId === runId);
  return (
    credentialGuards(own).requiresInspection &&
    credentialRefusal(
      own,
      [sourceIdentity("backup", bytes)],
      administrationHash,
    ) === null
  );
};

export const credentialInspection = (
  runId: string,
  lines: ReadonlyArray<JournalLine>,
  sourceHashes: ReadonlyArray<string>,
  administrationHash?: string,
) => {
  const guards = credentialGuards(lines).guards;
  const covered = certifiedSources(lines);
  const unfinished = [...guards]
    .filter(
      ([callId, guard]) =>
        guard.status !== "checked" ||
        !guard.sourceHashes.includes(POLICY_SOURCE) ||
        guard.sourceHash !== credentialSourceHash(guard.sourceHashes) ||
        (guard.version === 3 &&
          guard.administrationHash !== administrationHash) ||
        sourceHashes.some((source) => !covered.get(callId)?.has(source)),
    )
    .map(([callId]) => callId);
  if (unfinished.length === 0) return { status: "certified" as const };
  const inspectors = runs.get(runId)?.deref();
  if (
    unfinished.some((callId) => !inspectors?.has(callId)) ||
    !inspectors?.size
  )
    return { status: "unavailable" as const };
  return {
    status: "inspect" as const,
    calls: unfinished,
    inspect: async (
      source: CredentialSource,
      budget: InspectionBudget,
    ): Promise<InspectionResult> => {
      const matches: import("./credential-detectors.ts").MatchInterval[] = [],
        epochs: import("./credential-detectors.ts").CredentialEpochId[] = [];
      for (const engine of inspectors.values()) {
        const result =
          source.kind === "json"
            ? await engine.inspectJson({ json: source.json, budget })
            : source.kind === "text"
              ? await engine.inspectText({ text: source.text, budget })
              : await engine.inspectArtifact({
                  bytes: source.bytes,
                  mediaType: source.mediaType,
                  budget,
                });
        if (result.status !== "complete") return result;
        matches.push(...result.matches);
        epochs.push(...result.epochs);
      }
      return { status: "complete", matches, epochs };
    },
  };
};

export const credentialRefusal = (
  lines: ReadonlyArray<JournalLine>,
  sourceHashes?: ReadonlyArray<string>,
  administrationHash?: string,
  loss?: LossEvidence,
): string | null => {
  const { refusal, guards, requiresInspection } = credentialGuards(
    lines,
    "certificates-only",
    loss,
  );
  if (refusal !== null) return refusal;
  if (!requiresInspection) return null;
  if (sourceHashes === undefined)
    return "credential source evidence is required; export refused";
  const covered = certifiedSources(lines, loss?.certificates);
  return [...guards].some(
    ([callId, guard]) =>
      guard.status !== "checked" ||
      !guard.sourceHashes.includes(POLICY_SOURCE) ||
      guard.sourceHash !== credentialSourceHash(guard.sourceHashes) ||
      (guard.version === 3 &&
        guard.administrationHash !== administrationHash) ||
      sourceHashes.some((source) => !covered.get(callId)?.has(source)),
  )
    ? "credential inspection is unfinished or its exact source changed; source retained privately, export refused"
    : null;
};

export const privateInspectionDirectory = (
  source: string,
  durableBase: string,
): string => {
  const base = resolve(durableBase),
    temporary = resolve(tmpdir());
  const ownerBase =
    base === temporary || base.startsWith(temporary + sep)
      ? dirname(temporary)
      : base;
  return join(ownerBase, "credential-inspections", hash(resolve(source)));
};
