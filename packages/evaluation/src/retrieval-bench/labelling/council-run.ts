import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { PageItem, PageSide } from "./adjudicator.ts";
import {
  auditShared,
  Blind,
  blindPrompt,
  CouncilStepFailed,
  Investigation,
  investigationPrompt,
  majority,
  MAX_ROUNDS,
  namesIn,
  requireStep,
  Reveal,
  revealPrompt,
  Round,
  roundPrompt,
  tieSummary,
  type Member,
  type Position,
} from "./council.ts";
import { isLimitFailure } from "./credentials.ts";
import { codexThreadId, readJson, runClaude, runCodex } from "./routes.ts";
import type { RunReceipt } from "./schema.ts";

/**
 * The adjudication council's loop for one item (decision 9.52, 9.53), and the bounded runner over a
 * page of items. A member step that yields no valid answer raises CouncilStepFailed: the item stops,
 * its receipts and trails are kept in an incomplete marker, and it is retried in a later run. It is
 * never turned into an "unsure" vote. Sibling member steps are always awaited before the item stops,
 * so no model process outlives its bound (6.10).
 */

export type CouncilItem = PageItem & {
  A: PageSide;
  B: PageSide;
  caseId: string;
  hunkId: string;
};

export type CouncilReceipt = RunReceipt & { member: string; step: string };

export interface MemberState {
  readonly member: Member;
  readonly dir: string;
  readonly session: string;
  thread: string | null;
  steps: number;
  readonly trail: Array<unknown>;
}

export interface StepRequest {
  readonly state: MemberState;
  readonly name: string;
  readonly prompt: string;
  /** A JSON schema file in the member's folder (the council's are `SCHEMAS`). */
  readonly schemaFile: string;
  /** The base snapshot when the step may read it, otherwise null. */
  readonly snapshot: string | null;
  readonly log: string;
  readonly meta: Pick<RunReceipt, "caseId" | "hunkId" | "role">;
}

/** Runs one member step; the answer, if any, is in `<state.dir>/output.json`. */
export type StepRunner = (request: StepRequest) => Promise<RunReceipt>;

/** The real models: headless Opus (Claude Code) and Sol (Codex), each resuming its own session. */
export const modelStepRunner: StepRunner = async (request) => {
  const { state } = request;
  const receipt =
    state.member.family === "opus"
      ? await runClaude(
          {
            effort: state.member.effort,
            runDir: state.dir,
            snapshot: request.snapshot ?? state.dir,
            prompt: request.prompt,
            schemaFile: request.schemaFile,
            log: request.log,
            session: { id: state.session, resume: state.steps > 0 },
          },
          request.meta,
        )
      : await runCodex(
          {
            runDir: state.dir,
            prompt: request.prompt,
            schemaFile: request.schemaFile,
            log: request.log,
            allowed: request.snapshot === null ? [] : [request.snapshot],
            ...(state.member.effort === null
              ? {}
              : { effort: state.member.effort }),
            session: { resume: state.thread },
          },
          request.meta,
        );
  if (
    state.member.family === "codex" &&
    state.thread === null &&
    existsSync(request.log)
  )
    state.thread = codexThreadId(readFileSync(request.log, "utf8")) ?? null;
  return receipt;
};

/** Awaits every promise; then rethrows the first failure, so no sibling is left running. */
export const settleAll = async <T>(
  promises: ReadonlyArray<Promise<T>>,
): Promise<Array<T>> => {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
};

/** An item that stopped part-way: the failed step, and everything already run. */
export class CouncilItemIncomplete extends Error {
  constructor(
    readonly failure: unknown,
    readonly receipts: ReadonlyArray<CouncilReceipt>,
    readonly trails: Readonly<Record<string, ReadonlyArray<unknown>>>,
  ) {
    super(String(failure instanceof Error ? failure.message : failure));
  }
  get limit() {
    return (
      (this.failure instanceof CouncilStepFailed && this.failure.limit) ||
      /credential routes exhausted/.test(this.message)
    );
  }
}

export interface CouncilContext {
  readonly members: ReadonlyArray<Member>;
  readonly snapshot: string;
  /** The hunk's labelling packet (its `range/` and `head/` are copied in for investigation). */
  readonly packet: string;
  /** Private folder for this item's step logs. */
  readonly logs: string;
  /** The runs root, stripped from anything shared between members. */
  readonly runsRoot: string;
  /** A fresh, empty, private run folder for one member. */
  readonly memberDir: (memberId: string) => string;
  readonly runStep?: StepRunner;
}

/**
 * One step for one member, retried once unless it hit a limit; never returns without a value. Its
 * receipts and trail are kept on the caller's records, and a failure raises CouncilStepFailed.
 */
export const memberStep =
  (options: {
    readonly state: ReadonlyMap<string, MemberState>;
    readonly receipts: Array<CouncilReceipt>;
    /** Private folder for the step logs. */
    readonly logs: string;
    readonly meta: StepRequest["meta"];
    readonly runStep: StepRunner;
    /** The snapshot a step with `withSnapshot` may read. */
    readonly snapshot: string | null;
  }) =>
  async <T>(
    memberId: string,
    name: string,
    prompt: string,
    schemaFile: string,
    parse: (value: unknown) => T,
    withSnapshot: boolean,
  ): Promise<T> => {
    const s = options.state.get(memberId)!;
    const notes: Array<string> = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const log = join(options.logs, `${memberId}.${name}.${attempt}.jsonl`);
      rmSync(join(s.dir, "output.json"), { force: true });
      const receipt = await options.runStep({
        state: s,
        name,
        prompt,
        schemaFile,
        snapshot: withSnapshot ? options.snapshot : null,
        log,
        meta: options.meta,
      });
      s.steps++;
      options.receipts.push({ ...receipt, member: memberId, step: name });
      try {
        const value = parse(readJson(join(s.dir, "output.json")));
        s.trail.push({
          step: name,
          attempt,
          output: value,
          outsideReads: receipt.outsideReads,
        });
        return value;
      } catch (error) {
        s.trail.push({
          step: name,
          attempt,
          error: String(error).slice(0, 300),
          note: receipt.note,
        });
        notes.push(receipt.note ?? String(error).slice(0, 200));
        // A limit failure will not clear on an immediate retry.
        if (receipt.note !== null && isLimitFailure(receipt.note)) break;
      }
    }
    return requireStep<T>(null, memberId, name, notes, isLimitFailure);
  };

/** The council's full deliberation on one item; throws CouncilItemIncomplete if any step fails. */
export const runCouncilItem = async (
  item: CouncilItem,
  context: CouncilContext,
) => {
  const runStep = context.runStep ?? modelStepRunner;
  const allowed = namesIn(JSON.stringify(item));
  // Paths in shared text are made relative: no member sees another's folder or the runs root.
  const rootPattern = context.runsRoot
    .replace(/^\/private/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const neutral = (text: string) =>
    text.replace(
      new RegExp(`(/private)?${rootPattern}/[0-9a-f-]{36}/?`, "g"),
      "",
    );
  mkdirSync(context.logs, { recursive: true });
  const meta = {
    caseId: item.caseId,
    hunkId: item.hunkId,
    role: "adjudicator" as const,
  };
  const receipts: Array<CouncilReceipt> = [];
  const state = new Map<string, MemberState>(
    context.members.map((member) => [
      member.id,
      {
        member,
        dir: context.memberDir(member.id),
        session: randomUUID(),
        thread: null,
        steps: 0,
        trail: [],
      },
    ]),
  );
  const step = memberStep({
    state,
    receipts,
    logs: context.logs,
    meta,
    runStep,
    snapshot: context.snapshot,
  });
  const members = context.members.map((member) => member.id);
  try {
    const blind = new Map<string, z.infer<typeof Blind>>();
    await settleAll(
      members.map(async (id) => {
        const s = state.get(id)!;
        const value = await step(
          id,
          "blind",
          blindPrompt(s.dir, item),
          "blind.schema.json",
          (v) => Blind.parse(v),
          false,
        );
        blind.set(id, value);
        writeFileSync(join(s.dir, "blind.json"), `${JSON.stringify(value)}\n`);
        await step(
          id,
          "reveal",
          revealPrompt(s.dir, item.id, item.A, item.B),
          "reveal.schema.json",
          (v) => Reveal.parse(v),
          false,
        );
      }),
    );
    const positions = new Map<string, Position>();
    await settleAll(
      members.map(async (id) => {
        const s = state.get(id)!;
        const value = await step(
          id,
          "investigation",
          investigationPrompt(s.dir, context.packet, context.snapshot),
          "investigation.schema.json",
          (v) => Investigation.parse(v),
          true,
        );
        positions.set(id, {
          member: id,
          grade: value.grade,
          reason: neutral(value.reasons),
          evidence: value.evidence.map((e) => ({
            ...e,
            path: neutral(e.path),
            note: neutral(e.note),
          })),
          critique: null,
        });
      }),
    );
    const grades = () => members.map((id) => positions.get(id)!.grade);
    const votes: Array<{ round: number; votes: Record<string, string> }> = [
      {
        round: 0,
        votes: Object.fromEntries(
          members.map((id) => [id, positions.get(id)!.grade]),
        ),
      },
    ];
    let decided = majority(grades(), members.length - 1);
    let round = 0;
    let scrubbed = 0;
    while (decided === null && round < MAX_ROUNDS) {
      round++;
      const table = members.map((id) => positions.get(id)!);
      const updates = await settleAll(
        members.map(async (id) => {
          const s = state.get(id)!;
          const prompt = roundPrompt(s.dir, item.id, id, round, table, allowed);
          scrubbed += prompt.scrubbed;
          const value = await step(
            id,
            `round-${round}`,
            prompt.prompt,
            "round.schema.json",
            (v) => Round.parse(v),
            true,
          );
          return [id, value] as const;
        }),
      );
      for (const [id, value] of updates)
        positions.set(id, {
          ...positions.get(id)!,
          grade: value.grade,
          reason: neutral(value.reason),
          critique: neutral(value.critique),
        });
      votes.push({
        round,
        votes: Object.fromEntries(
          members.map((id) => [id, positions.get(id)!.grade]),
        ),
      });
      decided = majority(grades(), members.length - 1);
    }
    const auditHits = members.reduce(
      (total, id) =>
        total +
        auditShared(
          state.get(id)!.dir,
          Array.from({ length: round }, (_, index) => `round-${index + 1}.md`),
          allowed,
        ),
      0,
    );
    return {
      itemId: item.id,
      councilGrade: decided,
      roundReached: round,
      toOwner: decided === null,
      tie:
        decided === null
          ? tieSummary(
              members.map((id) => positions.get(id)!),
              allowed,
            )
          : null,
      votes,
      blind: Object.fromEntries(
        members.map((id) => [id, blind.get(id)?.grade ?? null]),
      ),
      members: Object.fromEntries(
        members.map((id) => [
          id,
          { trail: state.get(id)!.trail, final: positions.get(id) },
        ]),
      ),
      anonymity: { scrubbedNames: scrubbed, namesInSharedFiles: auditHits },
      outsideReads: receipts.flatMap((r) =>
        r.outsideReads.map((path) => `${r.member}/${r.step}: ${path}`),
      ),
      receipts,
    };
  } catch (error) {
    throw new CouncilItemIncomplete(
      error,
      receipts,
      Object.fromEntries(members.map((id) => [id, state.get(id)!.trail])),
    );
  }
};

/** Bounded concurrency (6.10): at most `limit` jobs at once, in order. */
export const bounded = async <T>(
  jobs: ReadonlyArray<() => Promise<T>>,
  limit: number,
) => {
  const results: Array<T> = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await jobs[index]!();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, worker),
  );
  return results;
};

/**
 * Items through a deliberation, bounded: skips items with a record, runs the rest at most
 * `concurrency` at a time, writes `<id>.json` for each finished item and `<id>.incomplete.json`
 * (with its receipts and trails) for each stopped one, and stops starting new items after a limit
 * failure.
 */
export const runItems = async <
  I extends { readonly id: string },
  R extends { readonly receipts: ReadonlyArray<CouncilReceipt> },
>(options: {
  readonly items: ReadonlyArray<I>;
  readonly dir: string;
  readonly concurrency: number;
  readonly run: (item: I) => Promise<R>;
  /** The log line for a finished item. */
  readonly describe: (item: I, result: R) => string;
}) => {
  let stopped: string | null = null;
  let incomplete = 0;
  mkdirSync(options.dir, { recursive: true });
  const jobs = options.items.map((item) => async () => {
    const file = join(options.dir, `${item.id}.json`);
    const marker = join(options.dir, `${item.id}.incomplete.json`);
    if (existsSync(file) || stopped !== null) return;
    try {
      const result = await options.run(item);
      writeFileSync(file, `${JSON.stringify(result, null, 1)}\n`);
      rmSync(marker, { force: true });
      console.log(
        `${new Date().toISOString()} ${item.id}: ${options.describe(item, result)}`,
      );
    } catch (error) {
      const stop =
        error instanceof CouncilItemIncomplete
          ? error
          : new CouncilItemIncomplete(error, [], {});
      const failure = stop.failure;
      incomplete++;
      writeFileSync(
        marker,
        `${JSON.stringify(
          {
            itemId: item.id,
            at: new Date().toISOString(),
            limit: stop.limit,
            member:
              failure instanceof CouncilStepFailed ? failure.member : null,
            step: failure instanceof CouncilStepFailed ? failure.step : null,
            reason: stop.message.slice(0, 400),
            trails: stop.trails,
            receipts: stop.receipts,
          },
          null,
          1,
        )}\n`,
      );
      console.log(
        `${new Date().toISOString()} ${item.id}: INCOMPLETE${stop.limit ? " (limit)" : ""}, retried in a later run: ${stop.message.slice(0, 200)}`,
      );
      if (stop.limit) stopped = stop.message.slice(0, 200);
    }
  });
  await bounded(jobs, options.concurrency);
  return { incomplete, stopped };
};

/** The council over a page of items (`runItems` with the council's deliberation). */
export const runCouncil = (options: {
  readonly items: ReadonlyArray<CouncilItem>;
  readonly councilDir: string;
  readonly concurrency: number;
  readonly contextFor: (item: CouncilItem) => CouncilContext;
}) =>
  runItems({
    items: options.items,
    dir: options.councilDir,
    concurrency: options.concurrency,
    run: (item) => runCouncilItem(item, options.contextFor(item)),
    describe: (_, result) => {
      const cost = result.receipts.reduce(
        (total, r) => total + (r.apiEquivalentUsd ?? 0),
        0,
      );
      return `${result.councilGrade ?? "TIE"} after round ${result.roundReached}; votes ${result.votes.map((v) => Object.values(v.votes).join("/")).join(" → ")}; ${result.receipts.length} steps, Opus ~$${cost.toFixed(2)}${result.outsideReads.length > 0 ? `, OUTSIDE ${result.outsideReads.length}` : ""}${result.anonymity.namesInSharedFiles > 0 ? `, NAMES ${result.anonymity.namesInSharedFiles}` : ""}`;
    },
  });
