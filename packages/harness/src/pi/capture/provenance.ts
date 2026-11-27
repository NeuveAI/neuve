import { z } from "zod";
import {
  DumpRejected,
  SourceValidation,
  SOURCE_VALIDATION_FILE,
} from "./archive.ts";
import { RunDump, SessionDump, CallRecord } from "./dump.ts";
import { deriveCapture } from "./canonical.ts";
import {
  NativeSnapshot,
  readBackup,
  type ProjectionRecipe,
  retainedDeclarations,
} from "./sources.ts";
import { isDeepStrictEqual } from "node:util";
import {
  credentialGuards,
  credentialLossEpochs,
  credentialRefusal,
  credentialSources,
  credentialAdministrationHash,
  administrativeFrame,
} from "./safety.ts";
import {
  inspectionFailure,
  type CredentialJson,
  type InspectionBudget,
} from "./credential-detectors.ts";
import type { CaptureScope, JournalLine } from "./types.ts";
import { Json } from "./types.ts";
import { providerOutputAvailable } from "./provider-output.ts";
import { sha256Of } from "./journal.ts";

const PiId = z.int().nonnegative();
const EntryIdentity = z.object({
  id: PiId,
  conversationId: PiId,
  kind: z.string(),
  byTaskId: PiId.optional(),
  head: PiId.optional(),
  edits: z.array(z.object({ target: PiId })).optional(),
  model: z.array(Json).optional(),
});
const TaskIdentity = z.object({
  id: PiId,
  conversationId: PiId,
  owner: PiId.optional(),
});
/** Cross-file identities are checked after each file's schema and checksum, before any read returns. */
export const validateProvenance = (
  source: string,
  run: RunDump,
  sessions: ReadonlyArray<SessionDump>,
  unjoined: ReadonlyArray<CallRecord>,
  journal: ReadonlyArray<JournalLine> = [],
) => {
  const reject = (reason: string): never => {
    throw new DumpRejected({ source, reason });
  };
  const bySession = new Map<number, SessionDump>();
  const entries = new Map<number, z.infer<typeof EntryIdentity>>();
  const tasks = new Map<number, z.infer<typeof TaskIdentity>>();
  const missingEdgesDisclosed =
    !run.complete &&
    run.gaps.some(
      (gap) =>
        gap.code === "edge-missing" && gap.kind === "capture" && gap.count > 0,
    );
  for (const [index, session] of sessions.entries()) {
    if (session.conversationId !== run.sessions[index]?.conversationId)
      reject("session identity disagrees with run.json");
    if (bySession.has(session.conversationId))
      reject("duplicate session identity");
    bySession.set(session.conversationId, session);
    for (const value of session.entries) {
      const parsed = EntryIdentity.safeParse(value);
      if (!parsed.success) reject("native entry has no valid identity");
      else {
        const entry = parsed.data;
        if (
          entry.conversationId !== session.conversationId ||
          entries.has(entry.id)
        )
          reject("native entry identity disagrees with its session");
        entries.set(entry.id, entry);
      }
    }
    for (const value of session.tasks) {
      const parsed = TaskIdentity.safeParse(value);
      if (!parsed.success) reject("native task has no valid identity");
      else {
        const task = parsed.data;
        if (
          task.conversationId !== session.conversationId ||
          tasks.has(task.id)
        )
          reject("native task identity disagrees with its session");
        tasks.set(task.id, task);
      }
    }
  }
  for (const session of sessions) {
    if (
      session.binding?.taskId !== undefined &&
      !tasks.has(session.binding.taskId)
    )
      reject("session binding names no task");
    if (
      session.binding?.inheritedFrom !== undefined &&
      !bySession.has(session.binding.inheritedFrom)
    )
      reject("session binding names no inherited session");
    if (session.owner !== undefined) {
      const owner = session.owner;
      const task = tasks.get(owner.taskId);
      if (
        !bySession.has(owner.conversationId) || task === undefined
          ? !missingEdgesDisclosed
          : task.conversationId !== owner.conversationId
      )
        reject("session owner belongs to no task in its owning session");
    }
    if (session.parent !== undefined) {
      const parent = session.parent;
      if (
        !bySession.has(parent.conversationId) ||
        !visibleEntry(parent.conversationId, parent.at)
      )
        reject(
          "session parent belongs to no visible entry in its parent session",
        );
    }
    for (const edge of ["owner", "parent"] as const) {
      const seen = new Set<number>([session.conversationId]);
      let next = session[edge]?.conversationId;
      while (next !== undefined) {
        if (seen.has(next)) reject(`cyclic session ${edge}`);
        seen.add(next);
        next = bySession.get(next)?.[edge]?.conversationId;
      }
    }
  }
  for (const task of tasks.values()) {
    const seen = new Set<number>([task.id]);
    let owner = task.owner;
    while (owner !== undefined) {
      const parent = tasks.get(owner);
      if (parent === undefined) {
        if (!missingEdgesDisclosed) reject("native task owner is missing");
        break;
      }
      if (parent.conversationId !== task.conversationId || seen.has(owner))
        reject("native task owner is missing, cyclic or in another session");
      seen.add(owner);
      owner = parent.owner;
    }
  }
  for (const entry of entries.values()) {
    if (
      entry.byTaskId !== undefined &&
      tasks.get(entry.byTaskId)?.conversationId !== entry.conversationId
    )
      reject("native entry task belongs to no task in its session");
    for (const id of [
      entry.head,
      ...(entry.edits ?? []).map((edit) => edit.target),
    ])
      if (
        id !== undefined &&
        (id > entry.id || !visibleEntry(entry.conversationId, id))
      )
        reject("native entry references no earlier visible entry");
  }

  function visibleEntry(conversationId: number, entryId: number): boolean {
    const seen = new Set<number>();
    let current = bySession.get(conversationId);
    let at = entryId;
    while (current !== undefined && !seen.has(current.conversationId)) {
      seen.add(current.conversationId);
      if (entries.get(entryId)?.conversationId === current.conversationId)
        return entryId <= at;
      if (current.parent === undefined) return false;
      at = Math.min(at, current.parent.at);
      current = bySession.get(current.parent.conversationId);
    }
    return false;
  }
  const scopeOf = (scope: CaptureScope, conversationId?: number) => {
    if (
      scope.runId !== run.runId ||
      (conversationId !== undefined &&
        scope.conversationId !== undefined &&
        scope.conversationId !== conversationId)
    )
      reject("capture scope disagrees with its run or session");
    if (
      scope.conversationId !== undefined &&
      !bySession.has(scope.conversationId)
    )
      reject("capture scope names no session");
    if (scope.entryId !== undefined && !entries.has(scope.entryId))
      reject("capture scope names no entry");
    if (scope.taskId !== undefined && !tasks.has(scope.taskId))
      reject("capture scope names no task");
    const entry =
      scope.entryId === undefined ? undefined : entries.get(scope.entryId);
    const task =
      scope.taskId === undefined ? undefined : tasks.get(scope.taskId);
    if (
      entry !== undefined &&
      task !== undefined &&
      (entry.conversationId !== task.conversationId ||
        entry.byTaskId !== task.id)
    )
      reject("capture scope's entry disagrees with its task");
    for (const record of [entry, task])
      if (
        record !== undefined &&
        record.conversationId !==
          (scope.conversationId ?? conversationId ?? record.conversationId)
      )
        reject("capture scope's entry or task belongs to another session");
  };
  const callIds = new Set<string>();
  const checkCall = (call: CallRecord, conversationId?: number) => {
    if (callIds.has(call.callId)) reject("duplicate call identity");
    callIds.add(call.callId);
    scopeOf(call.scope, conversationId);
    for (const fact of [call.response, ...call.events, call.end])
      if (fact?.scope !== undefined) scopeOf(fact.scope, conversationId);
    if (
      call.response?.responseId !== undefined &&
      call.end?.responseId !== undefined &&
      call.response.responseId !== call.end.responseId
    )
      reject("call response identities disagree");
  };
  for (const session of sessions)
    for (const call of session.calls) checkCall(call, session.conversationId);
  for (const call of unjoined) checkCall(call);
  for (const artifact of run.artifacts) scopeOf(artifact.scope);
};

const nativeProjection = (run: RunDump, sessions: ReadonlyArray<SessionDump>) =>
  NativeSnapshot.parse({
    conversations: sessions.map((session) => ({
      id: session.conversationId,
      record: {
        id: session.conversationId,
        ...(session.parent === undefined ? {} : { parent: session.parent }),
        ...(session.owner === undefined ? {} : { owner: session.owner }),
      },
      entries: session.entries,
      tasks: session.tasks,
      documents: session.documents,
      taskDocuments: session.taskDocuments,
    })),
    session: run.sessionDocuments,
  });

/** These synthetic facts are only the portable inspection contract. They do not stand in for absent raw bytes. */
const portableFacts = (
  run: RunDump,
  sessions: ReadonlyArray<SessionDump>,
  unjoined: ReadonlyArray<CallRecord>,
): Array<JournalLine> => {
  const lines: Array<JournalLine> = [];
  const push = (event: JournalLine["event"], at = 0, seq = lines.length + 1) =>
    lines.push({ v: 1, seq, at, event });
  const scope = { runId: run.runId };
  if (
    run.runKind !== null &&
    run.sourceRevision !== null &&
    run.route !== null &&
    run.pricing !== null
  )
    push({
      type: "run.start",
      scope,
      runKind: run.runKind,
      sourceRevision: run.sourceRevision,
      route: run.route,
      pricing: run.pricing,
      ...(run.harnessRevision === undefined
        ? {}
        : { harnessRevision: run.harnessRevision }),
    });
  for (const session of sessions) {
    const binding = session.binding;
    if (binding !== null && binding.inheritedFrom === undefined)
      push({
        type: "session.bind",
        scope: {
          ...scope,
          conversationId: session.conversationId,
          ...(binding.stage === undefined ? {} : { stage: binding.stage }),
          ...(binding.agent === undefined ? {} : { agent: binding.agent }),
          ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
        },
        ...(binding.computationId === undefined
          ? {}
          : { computationId: binding.computationId }),
      });
  }
  for (const stage of run.stages)
    if (stage.status !== "unknown")
      push({
        type: "stage.end",
        scope: { ...scope, stage: stage.stage },
        status: stage.status,
        ...(stage.reason === undefined ? {} : { reason: stage.reason }),
      });
  if (run.execution === "ended" && run.status !== "unknown")
    push({
      type: "run.end",
      scope,
      status: run.status,
      ...(run.publicationId === undefined
        ? {}
        : { publicationId: run.publicationId }),
    });
  push({
    type: "findings.returned",
    scope: { ...scope, stage: "find" },
    findingIds: run.leads.ledger.map((lead) => lead.leadId),
  });
  for (const { leadId, fate } of run.leads.ledger
    .flatMap((lead) =>
      lead.fates.map((fate) => ({ leadId: lead.leadId, fate })),
    )
    .toSorted((a, b) => a.fate.seq - b.fate.seq)) {
    const { seq, stage, ...history } = fate;
    push(
      { type: "lead.fate", scope: { ...scope, stage }, leadId, ...history },
      0,
      seq,
    );
  }
  for (const call of [
    ...sessions.flatMap((session) => session.calls),
    ...unjoined,
  ]) {
    const { callId, scope: callScope } = call;
    push(
      {
        type: "model.request",
        scope: callScope,
        callId,
        route: call.route,
        provider: call.provider,
        model: call.model,
        headerNames: call.headerNames,
        credentialCoverage: call.credentialCoverage,
        body: call.body,
        ...(call.sdkContext === undefined
          ? {}
          : { sdkContext: call.sdkContext }),
        ...(call.purpose === undefined ? {} : { purpose: call.purpose }),
        ...(call.logicalRoute === undefined
          ? {}
          : { logicalRoute: call.logicalRoute }),
        ...(call.api === undefined ? {} : { api: call.api }),
        ...(call.path === undefined ? {} : { path: call.path }),
      },
      call.requestedAt,
    );
    if (call.response !== null) {
      const { at, scope: observedScope, ...response } = call.response;
      push(
        {
          type: "model.response",
          scope: observedScope ?? callScope,
          callId,
          ...response,
        },
        at,
      );
    }
    for (const { at, name, data, scope: eventScope } of call.events)
      push(
        {
          type: "model.event",
          scope: eventScope ?? callScope,
          callId,
          name,
          data,
        },
        at,
      );
    if (call.end !== null) {
      const { at, scope: observedScope, ...end } = call.end;
      push(
        {
          type: "model.end",
          scope: observedScope ?? callScope,
          callId,
          ...end,
        },
        at,
      );
    }
  }
  return lines;
};

export const validateProjection = async (input: {
  readonly source: string;
  readonly run: RunDump;
  readonly sessions: ReadonlyArray<SessionDump>;
  readonly unjoined: ReadonlyArray<CallRecord>;
  readonly journal: ReadonlyArray<JournalLine>;
  readonly journalFrames?: ReadonlyArray<CredentialJson>;
  readonly journalObjects?: ReadonlyArray<CredentialJson>;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly portable: boolean;
  readonly snapshotId: string | undefined;
  readonly recipe: ProjectionRecipe | undefined;
  readonly tornLines: number;
  readonly budget?: InspectionBudget | undefined;
}) => {
  const { source, run, sessions, unjoined, files, portable } = input;
  const reject = (reason: string): never => {
    throw new DumpRejected({ source, reason });
  };
  let portableRetainedPrefixes: ReadonlySet<string> = new Set();
  if (portable) {
    const bytes =
      files.get(SOURCE_VALIDATION_FILE) ??
      reject(
        "portable source validation is unavailable; original facts must be revalidated",
      );
    const parsed = SourceValidation.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (!parsed.success)
      reject(
        "portable source validation policy is insufficient for retained SDK assembly and observed response framing validation",
      );
    else {
      if (parsed.data.restrictedSnapshot !== input.snapshotId)
        reject("portable source validation names another restricted snapshot");
      const unavailable = [
        ...sessions.flatMap((session) => session.calls),
        ...unjoined,
      ]
        .filter((call) => !providerOutputAvailable(call))
        .map((call) => call.callId)
        .toSorted();
      if (
        !isDeepStrictEqual(
          parsed.data.unavailableProviderOutputCalls,
          unavailable,
        )
      )
        reject(
          "portable provider output availability declaration disagrees with carried calls",
        );
      const prefixCalls = [
        ...sessions.flatMap((session) => session.calls),
        ...unjoined,
      ]
        .filter(
          (call) =>
            call.credentialCoverage === "required" &&
            call.end === null &&
            call.events.some(
              (event) =>
                event.name === "credential_guard" &&
                typeof event.data === "object" &&
                event.data !== null &&
                !Array.isArray(event.data) &&
                "status" in event.data &&
                event.data.status === "pending",
            ) &&
            !call.events.some(
              (event) =>
                event.name === "credential_guard" &&
                typeof event.data === "object" &&
                event.data !== null &&
                !Array.isArray(event.data) &&
                "status" in event.data &&
                event.data.status === "observed",
            ),
        )
        .map((call) => call.callId)
        .toSorted();
      if (
        !isDeepStrictEqual(parsed.data.retainedPrefixCalls, prefixCalls) ||
        (prefixCalls.length > 0 &&
          !run.gaps.some((gap) => gap.code === "journal-interrupted"))
      )
        reject(
          "portable retained-prefix declaration disagrees with interrupted calls",
        );
      portableRetainedPrefixes = new Set(parsed.data.retainedPrefixCalls);
      const actual = [...files]
        .filter(([name]) => name !== SOURCE_VALIDATION_FILE)
        .map(([name, content]) => ({ name, sha256: sha256Of(content) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (
        !isDeepStrictEqual(
          parsed.data.projections.map(({ name, sha256 }) => ({ name, sha256 })),
          actual,
        )
      )
        reject(
          "portable source validation declaration disagrees with carried projections",
        );
    }
  }
  const normalize = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value));
  const equal = (name: string, actual: unknown, expected: unknown) => {
    const same =
      actual instanceof Uint8Array && expected instanceof Uint8Array
        ? Buffer.from(actual).equals(Buffer.from(expected))
        : isDeepStrictEqual(normalize(actual), normalize(expected));
    if (!same) reject(`${name} disagrees with canonical source reconstruction`);
  };
  const native =
    !portable && run.backup.status === "captured"
      ? await readBackup(
          files.get(run.backup.file) ?? reject("missing native backup"),
        )
      : nativeProjection(run, sessions);
  const recipe = portable
    ? {
        version: 1 as const,
        maskVersion: 1 as const,
        sourceValidationVersion: 6 as const,
        tornLines: input.tornLines,
        ...(run.sourceRevision === null && run.runKind !== null
          ? { captureLossRunKind: run.runKind }
          : {}),
        declared: [],
        close: run.close,
        rate: run.rate,
      }
    : (input.recipe ?? reject("missing projection recipe"));
  const journal = portable
    ? portableFacts(run, sessions, unjoined)
    : input.journal;
  const loss =
    !portable &&
    (run.journal.status === "captured" || run.backup.status === "captured")
      ? {
          epochs: credentialLossEpochs(
            recipe.captureLosses ?? [],
            new Map(
              journal.flatMap(({ event }) =>
                event.type === "credential.registration"
                  ? [[event.callId, event.epochId] as const]
                  : [],
              ),
            ),
          ),
          ...(recipe.captureLossCertificates === undefined
            ? {}
            : { certificates: recipe.captureLossCertificates }),
        }
      : undefined;
  if (
    recipe.captureLossCertificates !== undefined &&
    (!loss?.epochs.size ||
      recipe.captureLossCertificates.some(
        ({ scope }) => scope.runId !== run.runId,
      ))
  )
    reject("capture loss certificates disagree with their source");
  const coverage = credentialGuards(
    journal,
    portable ? { portableRetainedPrefixes } : "certificates-only",
    loss,
  );
  if (coverage.refusal !== null) reject(coverage.refusal);
  const artifacts = portable
    ? []
    : journal
        .flatMap(({ event }) => (event.type === "artifact" ? [event] : []))
        .map((event, index) => {
          const record =
            run.artifacts[index] ??
            reject("journal artifact missing from projection");
          const bytes =
            record.original.file === null
              ? reject("restricted artifact has no original")
              : (files.get(record.original.file) ??
                reject("missing original artifact"));
          return { event, bytes };
        });
  if (!portable) {
    if (
      coverage.requiresInspection &&
      (input.tornLines > 0 || run.backup.status !== "captured")
    )
      reject(
        "credential inspection requires a whole journal and exact native backup; export refused",
      );
    const sources = await credentialSources(
      native,
      run.backup.status === "captured" ? files.get(run.backup.file) : undefined,
      journal,
      artifacts.map((source) => ({
        mediaType: source.event.mediaType,
        bytes: source.bytes,
      })),
      input.journalFrames,
      input.budget,
      input.journalObjects,
    ).catch((error: unknown) => {
      const failure = inspectionFailure(error);
      if (failure.reason === "budget" || failure.reason === "cancelled")
        throw error;
      return reject(
        "invalid or unsupported artifact text representation; export refused",
      );
    });
    const frames = input.journalFrames;
    if (coverage.requiresInspection && frames === undefined)
      reject("credential journal frame witnesses missing");
    const administrationHash =
      frames === undefined
        ? undefined
        : credentialAdministrationHash(
            journal,
            frames,
            loss?.epochs.size ? recipe.captureLosses : undefined,
          );
    const unsafe = credentialRefusal(
      journal,
      [...sources.keys()],
      administrationHash,
      loss,
    );
    if (unsafe !== null) reject(unsafe);
  }
  if (!portable)
    equal(
      "retained masking declarations",
      recipe.declared,
      retainedDeclarations(
        recipe.declared,
        native,
        journal,
        artifacts.map((source) => ({
          mediaType: source.event.mediaType,
          bytes: source.bytes,
        })),
      ),
    );
  const expected = await deriveCapture(
    run.runId,
    {
      native,
      lines: journal,
      tornLines: recipe.tornLines,
      backup: run.backup,
      journal: run.journal,
      artifacts,
    },
    recipe,
    portable ? "portable" : "original",
    input.budget,
  );
  equal("sessions", sessions, expected.sessions);
  equal("unjoined calls", unjoined, expected.unjoined);
  if (!portable) {
    equal("run", run, expected.run);
    for (const content of expected.artifacts)
      equal(content.name, files.get(content.name), content.bytes);
  } else {
    const { artifacts: _a, gaps: _g, complete: _c, ...actualRun } = run;
    const {
      artifacts: _ea,
      gaps: _eg,
      complete: _ec,
      ...expectedRun
    } = expected.run;
    equal("portable run", actualRun, expectedRun);
    const unverifiable = new Set([
      "journal-torn",
      "journal-failed",
      "journal-interrupted",
      "run-start-conflict",
    ]);
    equal(
      "portable source-derived gaps",
      run.gaps.filter((gap) => !unverifiable.has(gap.code)),
      expected.run.gaps.filter((gap) => !unverifiable.has(gap.code)),
    );
  }
};
