import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { SqlClient } from "effect/sql/SqlClient";
import {
  Store,
  mintUlid,
  sha256Hex,
  storeLocationIn,
  type StoreLocation,
} from "../src/index.ts";

const created: Array<string> = [];

/** Each test file passes this to `afterAll`, so the directories its tests created are deleted. */
export const removeTemporaryDirectories = () => {
  for (const directory of created.splice(0))
    rmSync(directory, { recursive: true, force: true });
};

/** A fresh store in a temporary directory standing in for a git common directory. */
export const freshLocation = () => {
  const directory = mkdtempSync(join(tmpdir(), "records-core-"));
  created.push(directory);
  return storeLocationIn(directory);
};

/** Runs a program that needs only the file system. */
export const runFs = <A, E>(program: Effect.Effect<A, E, FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer)));

/** Opens the store at `location` without creating or preparing it, as a reader of an existing store does. */
export const runExisting = <A, E>(
  location: StoreLocation,
  program: Effect.Effect<A, E, SqlClient>,
) =>
  runFs(program.pipe(Effect.provide(Store.layer(location, { create: false }))));

/** Runs `program` against the store at `location`, initializing it the way a first writer does. */
export const runOn = <A, E>(
  location: StoreLocation,
  program: Effect.Effect<A, E, SqlClient | FileSystem>,
) =>
  runFs(
    Effect.andThen(Store.prepareForWrite, program).pipe(
      Effect.provide(Store.layer(location, { create: true })),
    ),
  );

export const actor = sha256Hex("neuve-actor/1\u0000test\u0000session");
export const headOid = "a".repeat(40);
const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };

/** A small cycle: one batch, `units` units, a multi-unit context reference and one disposition. */
export const cycleEvents = (units: number) => {
  let second = 0;
  const event = (
    kind: string,
    idempotencyKey: string,
    attribution: unknown,
    payload: unknown,
  ) => ({
    id: mintUlid(),
    kind,
    idempotencyKey,
    actor,
    occurredAt: new Date(Date.UTC(2026, 9, 17, 9, 0, second++)).toISOString(),
    attribution,
    payload,
  });
  const cycleId = mintUlid();
  const batchId = mintUlid();
  const unitIds = Array.from({ length: units }, () => mintUlid());
  return {
    unitIds,
    events: [
      event("cycle.opened@1", `cycle:${cycleId}`, { cycleId, range }, {}),
      event(
        "batch.recorded@1",
        `batch:${batchId}`,
        { cycleId, batchId },
        { title: "Batch", focus: "Focus" },
      ),
      ...unitIds.map((unitId, index) =>
        event(
          "unit.recorded@1",
          `unit:${unitId}`,
          { cycleId, batchId, unitIds: [unitId] },
          {
            title: `Unit ${index}`,
            ownedRanges: [
              { path: `src/${index}.ts`, startLine: 1, endLine: 9 },
            ],
          },
        ),
      ),
      event(
        "context.referenced@1",
        `context:${cycleId}`,
        { cycleId, unitIds },
        {
          markerKind: "same-batch",
          source: { kind: "range", locator: "b..a" },
          summary: "Shared context",
        },
      ),
      event(
        "disposition.recorded@1",
        `disposition:${unitIds[0]}`,
        { cycleId, unitIds: [unitIds[0]] },
        {
          verdict: "approve",
          reviewedHeadOid: headOid,
        },
      ),
    ],
  };
};

export const commitEvent = (oid: string) => ({
  id: mintUlid(),
  kind: "commit.recorded@1",
  idempotencyKey: `git:commit:${oid}`,
  actor,
  occurredAt: "2026-10-17T09:00:00.000Z",
  payload: {
    oid,
    parents: [],
    tree: "c".repeat(40),
    author: { name: "Owner", email: "owner@example.com" },
    committer: { name: "Owner", email: "owner@example.com" },
    link: "none",
  },
});

const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 17, 10, 0, second)).toISOString();

/** An envelope with a fresh ULID; ULIDs minted in call order give the events their causal order. */
export const envelope = (
  kind: string,
  idempotencyKey: string,
  actorId: string,
  attribution: unknown,
  payload: unknown,
  causation?: unknown,
) => ({
  id: mintUlid(),
  kind,
  idempotencyKey,
  actor: actorId,
  occurredAt: at(0),
  ...(attribution === undefined ? {} : { attribution }),
  ...(causation === undefined ? {} : { causation }),
  payload,
});

export const human = sha256Hex(
  "neuve-actor/1\u0000human\u0000owner@example.com",
);
export const agent = actor;

/** Two actors whose fingerprints share their first 44 bits, so their three-word aliases collide. */
export const collidingActors = [
  `00000000000${"a".repeat(53)}`,
  `00000000000${"b".repeat(53)}`,
] as const;

/**
 * A cycle with one unit whose lane is reassessed from agentic to human-required, actors including an
 * alias collision, two turns reporting different models, a human disposition replaced by a later one,
 * and an agent disposition its author retracts. Minted in causal order.
 */
export const workflowEvents = () => {
  const cycleId = mintUlid();
  const batchId = mintUlid();
  const unitId = mintUlid();
  const unit = { cycleId, unitIds: [unitId] };
  const register = (actorId: string, actorKind: "agent" | "human") =>
    envelope(
      "actor.registered@1",
      `actor:${actorId}`,
      actorId,
      undefined,
      actorKind === "human"
        ? {
            actorKind,
            harness: "git",
            email: "owner@example.com",
            displayName: "Owner",
          }
        : { actorKind, harness: "test", sessionId: actorId.slice(0, 8) },
    );
  const registrations = {
    human: register(human, "human"),
    agent: register(agent, "agent"),
    first: register(collidingActors[0], "agent"),
    second: register(collidingActors[1], "agent"),
  };
  const structure = {
    cycle: envelope(
      "cycle.opened@1",
      `cycle:${cycleId}`,
      agent,
      { cycleId, range },
      {},
    ),
    batch: envelope(
      "batch.recorded@1",
      `batch:${batchId}`,
      agent,
      { cycleId, batchId },
      { title: "Batch", focus: "Focus" },
    ),
    unit: envelope(
      "unit.recorded@1",
      `unit:${unitId}`,
      agent,
      { cycleId, batchId, unitIds: [unitId] },
      {
        title: "Unit",
        ownedRanges: [{ path: "src/a.ts", startLine: 1, endLine: 2 }],
      },
    ),
    agentic: envelope(
      "assessment.recorded@1",
      `assessment:${unitId}:1`,
      agent,
      unit,
      {
        lane: "agentic",
        complexity: "low",
        easeOfValidation: "easy",
        rationale: "First pass",
      },
    ),
    humanRequired: envelope(
      "assessment.recorded@1",
      `assessment:${unitId}:2`,
      agent,
      unit,
      {
        lane: "human-required",
        complexity: "high",
        easeOfValidation: "hard",
        rationale: "Second pass",
      },
    ),
  };
  const turn = (n: number, model: string) =>
    envelope(
      "turn.started@1",
      `test:turn:${n}`,
      agent,
      { sessionId: "s", turnKey: `t${n}` },
      { harness: "test", model },
    );
  const turns = { older: turn(1, "model-old"), newer: turn(2, "model-new") };
  const humanApproval = envelope(
    "disposition.recorded@1",
    `disposition:h1`,
    human,
    unit,
    {
      verdict: "approve",
      reviewedHeadOid: headOid,
    },
  );
  const humanChange = envelope(
    "disposition.recorded@1",
    `disposition:h2`,
    human,
    unit,
    {
      verdict: "request-changes",
      reviewedHeadOid: headOid,
    },
    { supersedes: humanApproval.id },
  );
  const agentChange = envelope(
    "disposition.recorded@1",
    `disposition:a1`,
    agent,
    unit,
    {
      verdict: "request-changes",
      reviewedHeadOid: headOid,
    },
  );
  const agentRetraction = envelope(
    "disposition.retracted@1",
    `retraction:a1`,
    agent,
    unit,
    {},
    {
      supersedes: agentChange.id,
    },
  );
  return {
    unitId,
    cycleId,
    batchId,
    registrations,
    structure,
    turns,
    dispositions: { humanApproval, humanChange, agentChange, agentRetraction },
  };
};
