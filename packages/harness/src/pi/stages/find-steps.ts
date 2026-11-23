import { Proofs, sha256Hex } from "@neuve/records-core";
import { Effect } from "effect";
import { turnLimitFor } from "../../config.ts";
import { recordingHeadReads } from "../../find.ts";
import {
  Finding,
  FindOutput,
  findSystem,
  findChecks,
  FIND_READING_CHARS,
  repairFind,
  readingBudget,
  primaryHunk,
  FindSubmission,
  unreviewedPaths,
  type Lens,
} from "../../find.ts";
import {
  OPENING_CHARS,
  renderOpening,
  type Opening,
  type OpeningSection,
} from "../../initial-context.ts";
import { startLogSpan } from "../../log-span.ts";
import type { Frame } from "../../frame.ts";
import {
  readTool,
  readManyTool,
  hunkTool,
  hunksTool,
  searchTool,
  usesTool,
  defsTool,
  outlineTool,
  symbolAtTool,
  treeTool,
  commitTool,
  logTool,
  scopeSectionTool,
  graphSearchTool,
  semanticSearchTool,
  scopeOf,
  findSection,
  sectionBody,
  type HandleRegistry,
  type LookupContext,
} from "../../lookups.ts";
import {
  lookupContext,
  sectionIds,
  type RangeView,
  type RunContext,
} from "../../pipeline.ts";
import { proofReaders } from "../../proof-tools.ts";
import { e0CoverageOf } from "../../retrievers.ts";
import type { ManifestHunk } from "../../manifest.ts";
import { defineTool, RECORDS, type ChildRequest } from "../../toolkit.ts";
import {
  claimKeyOf,
  verifyAgentOf,
  verifySystem,
  verifyTask,
  VerifyStored,
  VerifySubmission,
  type Claim,
} from "../../verify.ts";
import type { AgentStep } from "./agent.ts";
import { toolState } from "./tool-state.ts";

/** One opening per range view and Frame: the four lenses share it, byte for byte. */
const openings = new WeakMap<RangeView, Map<string, Opening>>();

/** The scope sections the Frame's done-when rows cite, once each, in row order. */
const citedSections = (lookups: LookupContext, frame: Frame) =>
  Effect.forEach(
    [
      ...new Set(
        frame.doneWhen.flatMap((d) =>
          d.sectionId === null ? [] : [d.sectionId],
        ),
      ),
    ],
    (id) =>
      Effect.gen(function* () {
        const found = findSection(lookups.snapshot, id);
        if (found === undefined) return { id } satisfies OpeningSection;
        const { source, section } = found;
        const read = yield* sectionBody(lookups, source, section).pipe(
          Effect.catch(() =>
            Effect.succeed({
              text: undefined,
              disclosure: "the section could not be read",
            }),
          ),
        );
        return {
          id,
          header: `${section.id} "${section.title}" of ${source.id} (${source.kind}, ${source.stratum})`,
          text: read.text,
          disclosure: read.disclosure,
        } satisfies OpeningSection;
      }),
  );

export const findStep = (
  ctx: RunContext["Service"],
  view: RangeView,
  p: {
    lens: Lens;
    frame: Frame;
    keys: { frame: string; manifest: string };
    /**
     * The Verify of a claim `record_finding` accepts, started with the call's answer as a child of
     * the finder (run.ts, `verifyChild`); absent where no finder owns the step.
     */
    verify?: ((claim: Claim) => ChildRequest) | undefined;
  },
) =>
  Effect.gen(function* () {
    // No Map: a finder starts when Frame lands, and its finder assigns groups at dedupe.
    const lookups = lookupContext(ctx, view);
    let shared = openings.get(view);
    if (shared === undefined) {
      shared = new Map();
      openings.set(view, shared);
    }
    let opening = shared.get(p.keys.frame);
    if (opening === undefined) {
      opening = renderOpening({
        frame: p.frame,
        hunks: view.hunks,
        sections: yield* citedSections(lookups, p.frame),
        commits: view.findLog?.commits ?? [...view.commits].reverse(),
        commitFiles: view.findLog?.files,
        mergeFiles: view.findLog?.mergeFiles,
      });
      shared.set(p.keys.frame, opening);
    }
    const headReads = recordingHeadReads(readTool(lookups), lookups.handles);
    // The opening's diff shows new-side lines: they count as read, as `read`'s do, from the start.
    headReads.restore(opening.headReads);
    const proofIds =
      p.lens !== "tests" && p.lens !== "scope-fit"
        ? []
        : yield* Proofs.list({
            repository: ctx.repository,
            range: ctx.range,
          }).pipe(
            Effect.provide(ctx.records),
            Effect.map((list) => list.records.map((r) => r.id)),
            Effect.catch(() => Effect.succeed<string[]>([])),
          );
    const checks = {
      lens: p.lens,
      frame: p.frame,
      hunks: view.hunks,
      unreviewed: unreviewedPaths(view.hunks),
      evidence: new Set([
        ...view.hunks.keys(),
        ...sectionIds(view.snapshot),
        ...proofIds,
      ]),
      headReads: headReads.reads,
    };
    let recorded: RecordedFindings = { findings: [], notes: [] };
    const record = defineTool({
      name: "record_finding",
      description:
        "Record one supported finding immediately. It survives interruption. At most five findings are retained. Submit all findings with submit_find when done.",
      input: Finding,
      hints: RECORDS,
      handle: (finding) =>
        Effect.sync(() => {
          const problems = findChecks(
            { findings: [finding], notes: [] },
            { ...checks, lens: "correctness" },
          );
          if (problems.length > 0)
            return { text: problems.join("\n"), error: "InvalidFinding" };
          if (
            recorded.findings.some(
              (f) => JSON.stringify(f) === JSON.stringify(finding),
            )
          )
            return { text: "Finding already recorded." };
          if (recorded.findings.length >= 5)
            return {
              text: "Five findings already recorded. Submit your findings.",
              error: "FindingLimit",
            };
          recorded.findings.push(finding);
          const text = `Recorded finding ${recorded.findings.length} of 5.`;
          // Its Verify starts now, keyed by the claim; the finder's final list decides whether
          // its verdict counts (finder-task.ts).
          const hunk = primaryHunk(finding, checks);
          return p.verify === undefined || hunk === undefined
            ? { text }
            : {
                text,
                child: p.verify({
                  ...finding,
                  lens: p.lens,
                  hunkId: hunk.hunkId,
                }),
              };
        }),
    });
    const e0 =
      ctx.config.search?.e0 == null
        ? undefined
        : yield* e0CoverageOf(scopeOf(lookups)).pipe(
            Effect.provide(ctx.records),
            Effect.catch(() => Effect.succeed(undefined)),
          );
    const restricted = (tool: ReturnType<typeof readTool>, allowed: boolean) =>
      allowed
        ? tool
        : {
            ...tool,
            available: false as const,
            handle: () =>
              Effect.succeed({
                text: "This lookup is not available for this finder lens.",
                error: "LensToolUnavailable",
              }),
          };
    /** The characters the reading budget has left, before the result being made is counted. */
    const remaining = () => FIND_READING_CHARS - budget.save().used;
    /**
     * A reading tool whose head reads count only when its whole result fits the budget: a result
     * the budget cuts keeps none of them, so a line it cut off never becomes citable.
     */
    const counted = (tool: ReturnType<typeof readTool>) => ({
      ...tool,
      handle: (input: unknown) =>
        Effect.gen(function* () {
          const before = [...headReads.reads()];
          const outcome = yield* tool.handle(input);
          if (outcome.text.length > remaining()) headReads.restore(before);
          return outcome;
        }),
    });
    const budget = readingBudget([
      counted(headReads.tool),
      // Every range through the unwrapped recording `read`, page by page, stopping within the
      // budget left: its head reads are `read`'s own, and the budget counts its result once.
      counted(readManyTool(lookups, { read: headReads.tool, remaining })),
      hunkTool(lookups),
      hunksTool(lookups),
      logTool(lookups),
      searchTool(lookups),
      usesTool(lookups),
      defsTool(lookups),
      outlineTool(lookups),
      symbolAtTool(lookups),
      treeTool(lookups),
      commitTool(lookups),
      restricted(scopeSectionTool(lookups), p.lens === "scope-fit"),
      ...proofReaders({
        repository: ctx.repository,
        range: ctx.range,
        services: ctx.records,
        // The reviewed changed files: those Map's groups hold, by the rule its manifest applies.
        ownedPaths: [...new Set([...view.hunks.values()].map((h) => h.path))]
          .filter((path) => !checks.unreviewed.has(path))
          .sort(),
        currencyScope: "this range",
      }).map((tool) =>
        restricted(tool, p.lens === "scope-fit" || p.lens === "tests"),
      ),
      ...(ctx.config.search?.graph == null
        ? []
        : [graphSearchTool(lookups, ctx.config.search.graph)]),
      ...(ctx.config.search?.e0 == null ||
      e0 === undefined ||
      e0.withVectors === 0
        ? []
        : [semanticSearchTool(lookups, ctx.config.search.e0, e0)]),
    ]);
    // The opening counts against the reading budget: a finder starts with it already spent.
    budget.restore({ used: opening.text.length });
    const state = toolState({
      handles: lookups.handles,
      headReads,
      reading: budget,
    });
    const stored = (
      submission: FindSubmission,
      source: FindOutput["source"],
    ): FindOutput => {
      const counters = findCounters({
        opening,
        hunks: view.hunks,
        handles: lookups.handles,
      });
      startLogSpan(ctx.log, "harness.find.reading", {
        "harness.agent": `find.${p.lens}`,
        ...counters,
      })();
      const repaired = repairFind(
        {
          ...submission,
          findings: [
            ...submission.findings,
            ...recorded.findings.filter(
              (finding) =>
                !submission.findings.some(
                  (submitted) =>
                    JSON.stringify(submitted) === JSON.stringify(finding),
                ),
            ),
          ],
        },
        checks,
      );
      return {
        lens: p.lens,
        source,
        findings: repaired.findings.flatMap((f, i) => {
          const h = primaryHunk(f, checks);
          return h === undefined
            ? []
            : [
                {
                  ...f,
                  id: `${p.lens}.${i + 1}`,
                  lens: p.lens,
                  hunkId: h.hunkId,
                },
              ];
        }),
        ...(repaired.conditions === undefined
          ? {}
          : { conditions: repaired.conditions }),
        notes: repaired.notes,
        reading: { ...budget.save(), limit: FIND_READING_CHARS },
      };
    };
    const backstop = (): FindSubmission => repairFind(recorded, checks);
    /**
     * One `find.opening` row per finder context: what its opening handed over, for the measures that
     * tell lines in the opening from lines a lookup fetched. Written at the context's first call
     * (its tool state is not stored yet), not when the step is prepared, so a step whose output was
     * found in the store, which shows nothing, writes none. Once per process, and never when the run
     * log already holds the row: a resumed context, whose state is stored, does not reach here, and
     * one resumed before any call was stored finds its row. Hunk IDs (the manifest names their
     * paths), section IDs and line numbers only, as every run-log row (run-log.ts). It needs no bound
     * of its own: it lists only hunks the opening shows whole, and each spent at least its ID, its
     * header and a numbered line of the opening's 50,000 characters, about as much as its entry
     * here, so the row stays within about twice the opening's length.
     */
    let openingLogged = false;
    const logOpening = () => {
      if (openingLogged) return;
      openingLogged = true;
      const agent = `find.${p.lens}`;
      const frame = `computation:${p.keys.frame}`;
      if (
        ctx.log
          .read()
          .some(
            (r) =>
              r.type === "find.opening" &&
              r["agent"] === agent &&
              r["frame"] === frame,
          )
      )
        return;
      ctx.log.write({
        type: "find.opening",
        agent,
        frame,
        manifest: `computation:${p.keys.manifest}`,
        limit: OPENING_CHARS,
        length: opening.text.length,
        hunks: opening.handed.hunks,
        sections: opening.handed.sections,
      });
    };
    const step: AgentStep<FindSubmission, FindOutput> = {
      spec: {
        stage: "find",
        agent: `find.${p.lens}`,
        turnLimit: turnLimitFor(ctx.config, "find"),
        system: findSystem(p.lens),
        task: opening.text,
        tools: [...budget.tools, record],
        submit: {
          description:
            "Submit up to five anchored findings and notes. Scope-fit also returns exactly one verdict per done-when.",
          schema: FindSubmission,
        },
        check: (o) => findChecks(o, checks),
        repair: (o) => repairFind(o, checks),
        backstop,
        budgetNote: budget.note,
        state: {
          save: () => ({ ...state.save(), findings: recorded }),
          load: (held, turn) => {
            // The context's first call has no stored state yet: its opening is what was handed over.
            if (held === undefined) logOpening();
            state.load(held, turn);
            recorded = held?.findings ?? { findings: [], notes: [] };
          },
        },
      },
      // 5: the structured opening, and no Map in the step or its key nor a group in a finding.
      op: "harness.find",
      opVersion: 5,
      inputs: {
        lens: p.lens,
        frame: `computation:${p.keys.frame}`,
        manifest: `computation:${p.keys.manifest}`,
        search: ctx.config.search ?? null,
      },
      compose: (r) =>
        stored(
          r.output ?? backstop(),
          r.status === "submitted"
            ? "agent"
            : r.status === "final-generation"
              ? "final-generation"
              : "backstop",
        ),
      partial: () => stored(recorded, "backstop"),
      schema: FindOutput,
      note: (o) =>
        `${o.findings.length} findings; ${o.reading.used} characters read`,
    };
    return step;
  });
type RecordedFindings = { findings: Finding[]; notes: string[] };

export const verifyStep = (
  ctx: RunContext["Service"],
  view: RangeView,
  p: { finding: Claim; frame: Frame; frameKey: string },
) =>
  Effect.gen(function* () {
    const claimKey = claimKeyOf(p.frameKey, p.finding);
    const task = yield* verifyTask({
      repository: ctx.repository,
      finding: p.finding,
      frame: p.frame,
      view,
    });
    const fallback = (): VerifySubmission => ({
      decision: "drop",
      reason: "The finding was not verified.",
    });
    const stored = (
      o: VerifySubmission,
      source: VerifyStored["source"],
    ): VerifyStored => ({
      ...o,
      finding: claimKey,
      lens: p.finding.lens,
      source,
    });
    const step: AgentStep<VerifySubmission, VerifyStored> = {
      spec: {
        stage: "verify",
        // Stable for the claim, so the step's key (whose config holds the agent) is the claim's.
        agent: verifyAgentOf(p.finding.lens, claimKey),
        turnLimit: turnLimitFor(ctx.config, "verify"),
        system: verifySystem,
        task,
        tools: [],
        submit: {
          description: "Decide whether the cited evidence supports this claim.",
          schema: VerifySubmission,
        },
        backstop: fallback,
      },
      // Keyed by what it reads, which exists once the finding is recorded: its claim against the
      // Frame, and the text built from them. Not by the finished Find or the finding's position.
      op: "harness.verify",
      opVersion: 2,
      inputs: {
        claim: claimKey,
        task: sha256Hex(task),
      },
      compose: (r) =>
        stored(
          r.output ?? fallback(),
          r.status === "submitted"
            ? "agent"
            : r.status === "final-generation"
              ? "final-generation"
              : "backstop",
        ),
      partial: () => stored(fallback(), "backstop"),
      schema: VerifyStored,
      note: (o) => `${o.decision}; source ${o.source}`,
    };
    return step;
  });

/** Count actual hunk opens separately from hunk-index sightings. Registry state survives resume. */
export const findCounters = (o: {
  opening: Opening;
  hunks: ReadonlyMap<string, ManifestHunk>;
  handles: HandleRegistry;
}) => {
  const state = o.handles.toJSON();
  const opened = state.seen
    .filter(
      ([id, sightings]) =>
        o.hunks.has(id) && sightings.some((s) => s.lookup === "hunk"),
    )
    .map(([id]) => id);
  const counts = o.opening.counts;
  return {
    "harness.find.hunks_opened": opened.length,
    "harness.find.files_read": new Set(
      state.handles
        .filter(([, h]) => h.sightings.some((s) => s.lookup === "read"))
        .map(([, h]) => h.base.path),
    ).size,
    "harness.find.log_calls": state.seen.filter(([id]) =>
      id.startsWith("log-call:"),
    ).length,
    "harness.find.opening_chars": o.opening.text.length,
    "harness.find.opening_over_limit": o.opening.openingOverLimit,
    "harness.find.opening_frame_chars": counts.chars.frame,
    "harness.find.opening_scope_chars": counts.chars.scope,
    "harness.find.opening_index_chars": counts.chars.index,
    "harness.find.opening_diff_chars": counts.chars.diff,
    "harness.find.opening_log_chars": counts.chars.log,
    "harness.find.sections_inlined": counts.sectionsInlined,
    "harness.find.sections_listed": counts.sectionsListed,
    "harness.find.files_total": counts.files,
    "harness.find.files_named": counts.filesNamed,
    "harness.find.files_folded": counts.filesFolded,
    "harness.find.files_diffed": counts.filesDiffed,
    "harness.find.files_cut": counts.filesCut,
    "harness.find.hunks_total": counts.hunks,
    "harness.find.hunks_diffed": counts.hunksDiffed,
    "harness.find.lines_added_shown": counts.linesAdded,
    "harness.find.lines_deleted_shown": counts.linesDeleted,
    "harness.find.lines_context_shown": counts.linesContext,
    "harness.find.owned_added_shown": counts.ownedAddedShown,
    "harness.find.owned_deleted_shown": counts.ownedDeletedShown,
    "harness.find.owned_added_total": counts.ownedAdded,
    "harness.find.owned_deleted_total": counts.ownedDeleted,
    "harness.find.log_lines_shown": counts.logLinesShown,
    "harness.find.log_lines_total": counts.logLinesTotal,
  };
};
