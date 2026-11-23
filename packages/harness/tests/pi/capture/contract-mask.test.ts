// Verify restricted captures mask content and preserve readable runtime state.
import { expect, test } from "bun:test";
import { TurnOutcome } from "@neuve/runtime";
import { z } from "zod";
import { readData } from "@neuve/records-core";
import storedToolState from "./fixtures/tool-state-60599135.json";
import { ToolState } from "../../../src/pi/stages/docs.ts";
import { ContractState } from "../../../src/pi/stages/contract-schema.ts";
import { ContractContextCapture } from "../../../src/pi/capture/contract-types.ts";
import { deriveCapture } from "../../../src/pi/capture/canonical.ts";
import { NativeSnapshot } from "../../../src/pi/capture/sources.ts";
import { Json } from "../../../src/pi/capture/types.ts";
import { withholdReasoning } from "../../../src/pi/capture/mask.ts";
import { contractContexts } from "../../../src/pi/capture/contract-context.ts";

// Read as a stored context is (`readData`): the stored tool state predates the finding's group
// moving off the submission, which the compatible read strips.
const state = () =>
  readData(
    ContractState,
    {
      contextKey: "run:1:find",
      agent: "find",
      stage: "find",
      kind: "find",
      account: "fake-claude",
      continuation: { runtime: "claude-code", key: "key" },
      startedAt: 0,
      system: "",
      outputSchema: {},
      declarations: [],
      model: { id: "fake", effort: "low" },
      native: null,
      rounds: [],
      events: [],
      calls: {},
      toolState: storedToolState,
      reminder: false,
      endedMessages: [],
    },
    { source: "neuve.contract-context" },
  );

const native = (data: ContractState) =>
  NativeSnapshot.parse({
    conversations: [
      {
        id: 1,
        record: { id: 1 },
        entries: [],
        tasks: [],
        documents: [],
        taskDocuments: [
          {
            taskId: 1,
            documents: [
              {
                kind: "neuve.contract-context",
                version: 1,
                value: { data },
              },
            ],
          },
        ],
      },
    ],
    session: [
      {
        kind: "neuve.contract-partials",
        version: 1,
        value: { contexts: { "1": data } },
      },
    ],
  });

const project = (data: ContractState, declared: string[] = []) =>
  deriveCapture(
    "run",
    {
      native: native(data),
      lines: [],
      tornLines: 0,
      artifacts: [],
      backup: { status: "unavailable", reason: "fixture" },
      journal: { status: "unavailable", reason: "fixture" },
    },
    {
      version: 1,
      maskVersion: 1,
      declared,
      tornLines: 0,
      close: "ended",
      rate: null,
    },
  );

test("a saved command start masks the same input as its finish", async () => {
  const secret = "sk-012345678901234567890123";
  const command = {
    turnId: "turn",
    at: "2026-11-21T12:00:00Z",
    workId: "command",
    kind: "command",
    input: { command: `echo ${secret}`, cwd: "/work" },
  } as const;
  const { run, sessions } = await project({
    ...state(),
    events: [
      { ...command, type: "work.started" },
      {
        ...command,
        type: "work.finished",
        output: secret,
        errored: false,
      },
    ],
  });
  expect(run.contractContexts?.[0]?.state.events).toEqual([
    {
      ...command,
      type: "work.started",
      input: { command: "echo sk-<masked>", cwd: "/work" },
    },
    {
      ...command,
      type: "work.finished",
      input: { command: "echo sk-<masked>", cwd: "/work" },
      output: "sk-<masked>",
      errored: false,
    },
  ]);
  expect(JSON.stringify({ run, sessions })).not.toContain(secret);
});

// Why: pi must continue to read stored state emitted by the pre-extraction validators.
test("tool state stored at 60599135 still parses through docs", () => {
  // A finding's group is set by code at dedupe now, not submitted, so the compatible read drops
  // only that key from the stored findings and keeps everything else.
  const { findings, ...rest } = storedToolState;
  const expected = {
    ...rest,
    findings: {
      ...findings,
      findings: findings.findings.map(
        ({ group: _group, ...finding }) => finding,
      ),
    },
  };
  expect(
    Json.parse(
      readData(ToolState, storedToolState, { source: "neuve.tool-state" }),
    ),
  ).toEqual(expected);
});

// Why: capture reads additive strict fields, but exports must drop everything this build cannot mask.
test("live and retained contract capture reads newer fields and excludes them from masked exports", async () => {
  const original = state();
  const future = {
    ...original,
    futureRoot: "unmasked-future-secret",
    continuation: {
      ...original.continuation,
      futureContinuation: "unmasked-future-secret",
    },
    toolState: { ...original.toolState, futureTool: "unmasked-future-secret" },
    events: [
      {
        type: "usage" as const,
        turnId: "turn",
        at: "2026-11-11T00:00:00Z",
        scope: "turn" as const,
        costUsd: null,
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        },
        futureEvent: "unmasked-future-secret",
      },
    ],
  };
  const source = native(future);
  const retained = contractContexts({ ...source, conversations: [] });
  const live = contractContexts({ ...source, session: [] });
  expect(retained[0]?.state.events).toHaveLength(1);
  expect(live[0]?.state.events).toHaveLength(1);
  const { run, sessions } = await project(future);
  expect(JSON.stringify({ run, sessions })).not.toContain(
    "unmasked-future-secret",
  );
  expect(run.contractContexts?.[0]?.state.events).toHaveLength(1);
  expect(JSON.stringify(source)).toContain("unmasked-future-secret");
});

// Why: masking a declared revision used to make a valid capture fail parsing.
test("tool-state masking preserves protocol and identities and bounds narrative replacements", async () => {
  const original = state();
  const before = structuredClone(original);
  const { run, sessions } = await project(original, [
    "head",
    "new",
    "defect",
    "proof",
    "forged",
    "met",
    "lookup",
    "query",
    "blob",
    "commit",
    "parent",
    "path",
  ]);
  const masked = run.contractContexts?.[0]?.state.toolState;
  if (masked == null) throw new Error("No captured tool state");
  expect(masked?.handles?.handles[0]?.[1].base).toEqual({
    rev: "head",
    path: "path",
    blob: "blob",
    commit: "commit",
    startLine: 1,
    endLine: 2,
  });
  expect(masked?.handles?.handles[0]?.[1].sightings).toEqual([
    {
      turn: 1,
      lookup: "lookup",
      args: { kind: "<masked>", nested: ["<email>"] },
      parent: "parent",
      retrieval: {
        retriever: "query",
        querySha256: "blob",
        rank: 1,
        score: 0.5,
      },
    },
  ]);
  expect(masked?.handles?.seen[0]?.[1]).toEqual(
    masked?.handles?.handles[0]?.[1].sightings,
  );
  expect(masked?.findings).toEqual({
    findings: [
      {
        claim: "<masked>".repeat(37) + "<mas",
        kind: "defect",
        about: "proof",
        signal: "forged",
        critical: true,
        anchors: [{ path: "path", side: "new", startLine: 1, endLine: 2 }],
        doneWhen: "D1",
        evidence: ["<masked>".repeat(20)],
      },
    ],
    notes: ["<masked>".repeat(37) + "<mas"],
    conditions: [
      {
        doneWhen: "D1",
        verdict: "met",
        anchors: [{ path: "path", side: "new", startLine: 1, endLine: 2 }],
        note: "<masked>".repeat(37) + "<mas",
      },
    ],
  });
  expect(masked?.reading).toEqual({ used: 17 });
  expect(masked?.headReads).toEqual([
    { path: "path", startLine: 1, endLine: 2 },
  ]);
  const retained = ContractState.parse(
    z
      .object({ contexts: z.record(z.string(), ContractState) })
      .parse(run.sessionDocuments[0]?.value).contexts["1"],
  );
  expect(retained.toolState).toEqual(masked);
  const live = sessions[0]?.taskDocuments[0]?.documents[0]?.value;
  expect(live).toEqual(Json.parse({ data: { ...retained } }));
  expect(original).toEqual(before);
});

// Why: every stored outcome can carry an account folder, including retained attempts.
test.each(["SignInRequired", "AccountRejected"] as const)(
  "%s folder content is masked in every outcome and both document forms",
  async (_tag) => {
    const outcome = TurnOutcome.parse({
      status: "failed",
      disposition: "broken",
      failure: {
        _tag,
        account: "fake-claude",
        hint: {
          kind: "command",
          command: "claude auth login",
          environment: {
            CLAUDE_CONFIG_DIR: "/accounts/ann@example.com/config",
          },
        },
      },
    });
    const data = state();
    data.rounds = [
      {
        id: "turn",
        prompt: "",
        final: false,
        attempt: 1,
        dispatched: true,
        recovery: null,
        state: "settled",
        outcome,
        announced: {},
        carrier: false,
        fork: false,
      },
    ];
    data.events = [
      {
        type: "turn.finished",
        turnId: "turn",
        at: "2026-11-10T00:00:00Z",
        outcome,
      },
    ];
    data.settlements = { turn: outcome };
    const expected = TurnOutcome.parse({
      status: "failed",
      disposition: "broken",
      failure: {
        _tag,
        account: "fake-claude",
        hint: {
          kind: "command",
          command: "claude auth login",
          environment: { CLAUDE_CONFIG_DIR: "/accounts/<email>/config" },
        },
      },
    });
    const { run, sessions } = await project(data, [
      _tag,
      "fake-claude",
      "broken",
      "command",
      "claude auth login",
    ]);
    const context = run.contractContexts?.[0];
    expect(context?.state.rounds[0]?.outcome).toEqual(expected);
    expect(context?.state.events[0]).toMatchObject({ outcome: expected });
    expect(context?.state.settlements).toEqual({ turn: expected });
    expect(context?.settlements).toEqual({ turn: expected });
    const portable = withholdReasoning(Json.parse({ run, sessions }));
    expect(JSON.stringify({ run, sessions })).not.toContain("ann@example.com");
    expect(JSON.stringify(portable)).not.toContain("ann@example.com");
    expect(data.rounds[0]?.outcome).toEqual(outcome);
  },
);

// Why: a declaration may replace the whole folder, which still needs to parse as an absolute path.
test("a masked whole sign-in folder keeps its required absolute-path syntax", async () => {
  const data = state();
  data.settlements = {
    turn: TurnOutcome.parse({
      status: "failed",
      disposition: "broken",
      failure: {
        _tag: "SignInRequired",
        account: "fake-claude",
        hint: {
          kind: "command",
          command: "claude auth login",
          environment: { CLAUDE_CONFIG_DIR: "/accounts/synthetic-user/config" },
        },
      },
    }),
  };
  const { run } = await project(data, ["/accounts/synthetic-user/config"]);
  expect(run.contractContexts?.[0]?.state.settlements["turn"]).toEqual(
    TurnOutcome.parse({
      status: "failed",
      disposition: "broken",
      failure: {
        _tag: "SignInRequired",
        account: "fake-claude",
        hint: {
          kind: "command",
          command: "claude auth login",
          environment: { CLAUDE_CONFIG_DIR: "/<masked>" },
        },
      },
    }),
  );
});

// Why: older contract contexts omit accountKind, and a settled failure leaves siblings undispatched.
test("older contexts parse and settled observed calls are cancelled while active calls remain pending", () => {
  const data = state();
  data.toolState = null;
  const outcome = TurnOutcome.parse({
    status: "failed",
    disposition: "broken",
    failure: {
      _tag: "TurnFailed",
      account: "fake-claude",
      reason: "protocol-error",
    },
  });
  data.settlements = { settled: outcome };
  data.events = ["settled", "active"].map((turnId) => ({
    type: "message.finished",
    turnId,
    at: "2026-11-10T00:00:00Z",
    messageId: turnId,
    resumePoint: turnId,
    stopReason: "tool-use",
    toolCalls: ["observed", "started"].map((status) => ({
      callId: `${turnId}-${status}`,
      toolName: "probe",
      input: {},
    })),
  }));
  data.calls = {
    "settled-observed": { status: "observed", eligible: false },
    "settled-started": { status: "started", eligible: true },
    "active-observed": { status: "observed", eligible: false },
    "active-started": { status: "started", eligible: true },
  };
  const [captured] = contractContexts(native(data));
  expect(
    ContractContextCapture.parse(captured).state.accountKind,
  ).toBeUndefined();
  expect(captured?.callDispositions).toEqual({
    "settled-observed": "cancelled",
    "settled-started": "unknown",
    "active-observed": "pending",
    "active-started": "pending",
  });
});
