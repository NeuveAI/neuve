import { z } from "zod";
import { readData } from "@neuve/records-core";
import { ContractContextCapture } from "./contract-types.ts";
import {
  ContractState,
  contractUsage,
  physicalTurnId,
} from "../stages/contract-schema.ts";
import { addUsage, zeroUsage } from "../../route.ts";
import type { NativeSnapshot } from "./sources.ts";
import { DumpFailed } from "./sources.ts";
import type { GapCode, Totals } from "./dump.ts";

/** Live task documents and retained terminal snapshots are the only sources. */
export function contractContexts(native: NativeSnapshot) {
  const contexts = new Map<number, ContractState>();
  for (const document of native.session) {
    if (document.kind !== "neuve.contract-partials") continue;
    const retained = z
      .object({ contexts: z.record(z.string(), z.json()) })
      .parse(document.value);
    for (const [id, value] of Object.entries(retained.contexts)) {
      const taskId = z.int().nonnegative().parse(Number(id));
      contexts.set(
        taskId,
        readData(ContractState, value, { source: "neuve.contract-partials" }),
      );
    }
  }
  for (const conversation of native.conversations)
    for (const task of conversation.taskDocuments)
      for (const document of task.documents) {
        if (document.kind !== "neuve.contract-context") continue;
        const value = z.object({ data: z.json() }).parse(document.value).data;
        if (value !== null)
          contexts.set(
            task.taskId,
            readData(ContractState, value, {
              source: "neuve.contract-context",
            }),
          );
      }
  const keys = new Set<string>();
  return [...contexts].map(([taskId, state]): ContractContextCapture => {
    if (keys.has(state.contextKey))
      throw new DumpFailed({ reason: "duplicate declared contract context" });
    keys.add(state.contextKey);
    const settlements = { ...state.settlements };
    for (const event of state.events)
      if (event.type === "turn.finished")
        settlements[event.turnId] = event.outcome;
    for (const round of state.rounds)
      if (round.dispatched && round.outcome !== null)
        settlements[physicalTurnId(round)] = round.outcome;
    const messages = state.events.filter(
      (event) => event.type === "message.finished",
    );
    return ContractContextCapture.parse({
      taskId,
      coverage: "no-wire-capture",
      state,
      settlements,
      callDispositions: Object.fromEntries(
        Object.entries(state.calls).map(([id, call]) => {
          const owner = messages.find((message) =>
            message.toolCalls.some((item) => item.callId === id),
          );
          return [
            id,
            call.status === "started"
              ? owner !== undefined && settlements[owner.turnId] !== undefined
                ? "unknown"
                : "pending"
              : call.status === "observed"
                ? owner !== undefined && settlements[owner.turnId] !== undefined
                  ? "cancelled"
                  : "pending"
                : call.status,
          ];
        }),
      ),
      usage: contractUsage(state),
      costUsd: null,
    });
  });
}

export function contractContextGaps(
  contexts: readonly ContractContextCapture[],
  native: NativeSnapshot,
  runId: string,
): Array<readonly [GapCode, number, string]> {
  const found: Array<readonly [GapCode, number, string]> = [];
  const add = (code: GapCode, count: number, key: string, detail: string) => {
    if (count > 0)
      found.push([code, count, `contract context ${key}: ${detail}`]);
  };
  const tasks = new Set(
    native.conversations.flatMap((c) => c.tasks.map((task) => task.id)),
  );
  for (const context of contexts) {
    const { state, taskId, settlements } = context;
    const key = state.contextKey;
    add(
      "edge-missing",
      Number(!tasks.has(taskId)),
      key,
      "owning task is missing",
    );
    add(
      "session-unattributed",
      Number(!state.agent || !key.startsWith(`${runId}:${taskId}:`)),
      key,
      "run/task/agent attribution is missing",
    );
    const started = (id: string) =>
      state.rounds.some((round) => {
        if (!round.dispatched) return false;
        if (id === round.id) return true;
        const prefix = `${round.id}:attempt:`;
        if (!id.startsWith(prefix)) return false;
        const attempt = Number(id.slice(prefix.length));
        return (
          Number.isSafeInteger(attempt) &&
          attempt >= 2 &&
          attempt <= round.attempt &&
          id === physicalTurnId({ ...round, attempt })
        );
      });
    const attempts = state.rounds.reduce(
      (sum, round) => sum + (round.dispatched ? round.attempt : 0),
      0,
    );
    add(
      "calls-unended",
      attempts - Object.keys(settlements).filter(started).length,
      key,
      "started turns have no terminal outcome",
    );
    const messages = state.events.filter(
      (event) => event.type === "message.finished",
    );
    add(
      "edge-missing",
      state.events.filter((event) => !started(event.turnId)).length +
        Object.keys(settlements).filter((id) => !started(id)).length,
      key,
      "events name an unstarted turn",
    );
    const calls = messages.flatMap((message) => message.toolCalls);
    add(
      "edge-missing",
      Number(attempts > 0 && state.native === null),
      key,
      "dispatched context has no native identity",
    );
    add(
      "edge-missing",
      calls.length - new Set(calls.map((call) => call.callId)).size,
      key,
      "duplicate native call identities",
    );
    add(
      "edge-missing",
      messages.length -
        new Set(messages.map((message) => message.messageId)).size,
      key,
      "duplicate native message identities",
    );
    add(
      "tool-definitions-missing",
      calls.filter(
        (call) =>
          !state.declarations.some((tool) => tool.name === call.toolName),
      ).length,
      key,
      "calls have no frozen definition",
    );
    add(
      "tool-results-missing",
      calls.filter(
        (call) =>
          context.callDispositions[call.callId] === undefined ||
          context.callDispositions[call.callId] === "pending",
      ).length,
      key,
      "calls have no explicit disposition",
    );
    add(
      "edge-missing",
      Object.keys(state.calls).filter(
        (id) => !calls.some((call) => call.callId === id),
      ).length,
      key,
      "ledger calls have no message",
    );
    add(
      "usage-mismatch",
      messages.filter((message) => message.usage === undefined).length,
      key,
      "messages have no reported usage",
    );
    const charged = new Set(
      state.events
        .filter((event) => event.type === "usage")
        .map((event) => event.turnId),
    );
    add(
      "ledger-unreconciled",
      [...new Set(messages.map((message) => message.turnId))].filter(
        (id) => !charged.has(id),
      ).length,
      key,
      "message turns have no authoritative usage",
    );
    for (const id of charged) {
      const events = state.events.filter((event) => event.turnId === id);
      const reported = contractUsage({ events });
      const observed = messages
        .filter((message) => message.turnId === id)
        .reduce(
          (sum, message) => addUsage(sum, message.usage ?? zeroUsage),
          zeroUsage,
        );
      add(
        "usage-mismatch",
        Number(
          (
            [
              "input",
              "output",
              "cacheRead",
              "cacheWrite5m",
              "cacheWrite1h",
            ] as const
          ).some((field) => reported[field] < observed[field]),
        ),
        key,
        "authoritative usage is below observed message usage",
      );
    }
  }
  return found;
}

export function contractTotals(context: ContractContextCapture): Totals {
  const usage = context.usage;
  const cacheWrite = usage.cacheWrite5m + usage.cacheWrite1h;
  return {
    tokens: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite,
      ...(usage.thinking === undefined ? {} : { reasoning: usage.thinking }),
      totalTokens: usage.input + usage.output + usage.cacheRead + cacheWrite,
    },
    cost: {
      recorded: {
        status: "unknown",
        reason: "subscription route: no per-token price",
      },
      estimate: null,
    },
  };
}
