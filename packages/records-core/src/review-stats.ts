import { dispositionRows, commentRows } from "./carried-relations.ts";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  AssessedSection,
  safeRead,
  type Range,
  type StoredEvent,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import { liveDisposition } from "./dispositions.ts";
import * as Log from "./log.ts";
import { REVIEW_RUN_KINDS } from "./jobs.ts";
import * as Proofs from "./proofs.ts";
import { standingManifest, standingPacketId } from "./published-packets.ts";
import { assertCompatible } from "./store.ts";

/**
 * The product metrics `neuve review stats` reads (proposal §3.8; 10.32, 10.55, 10.62, 10.63, 10.70),
 * aggregated from the projection tables only, so they are as rebuildable as the projections. These
 * are the one definition of the day-one counts that are facts of a cycle's events; the receipt carries
 * only what the run alone knows (unit counts at 10, 20 and 40 lines). Each aggregate is one grouped
 * query over a projection table, so the cost grows with the rows, never with their product.
 */

export interface LaneCount {
  readonly batchId: string | null;
  readonly lane: string;
  readonly units: number;
}

export interface GapCount {
  readonly kind: string;
  readonly stage: string | null;
  readonly gaps: number;
}

export interface AgentDispositionCount {
  readonly verdict: string;
  readonly lane: string | null;
  readonly dispositions: number;
  /** Version 2 requests for changes that name no comment they rest on (10.69, proposal §9.2). */
  readonly uncited: number;
  /** Version 2 approvals that name no proof record (10.62). */
  readonly withoutProof: number;
  /** Version 1 dispositions, which cannot name comments or proof, so count as neither. */
  readonly version1: number;
}

export interface BatchCost {
  /** Null for stages that belong to the whole run rather than one batch (the stub stages, Precompute). */
  readonly batchId: string | null;
  readonly stages: number;
  readonly wallMs: number;
  readonly modelCalls: number;
  /** Null when the route has no per-token price (10.85). */
  readonly costMicroUsd: number | null;
}

export interface RunSummary {
  readonly runId: string;
  readonly cycleId: string;
  readonly outcome: string;
  readonly endedAt: string;
  readonly wallMs: number;
  readonly queueWaitMs: number;
  readonly modelCalls: number;
  /** Null when the route has no per-token price (10.85). */
  readonly costMicroUsd: number | null;
  /** The run's `stage.completed@1` and `gap.disclosed@1` events. */
  readonly stageCount: number;
  readonly gapCount: number;
  readonly unitCount10: number | null;
  readonly unitCount20: number | null;
  readonly unitCount40: number | null;
}

export interface FindingCount {
  readonly kind: string;
  readonly about: string;
  readonly signal: string | null;
  readonly comments: number;
}

/**
 * Proof records by kind and how many recorders made them (slice H4b), and the coverage levels of
 * the validation requirements in each unit's current assessment (11.1: solid only when the kinds
 * converge). A cycle's records are those recorded in it or for its base.
 */
export interface ProofCounts {
  readonly byKind: ReadonlyArray<{
    readonly kind: string;
    readonly records: number;
  }>;
  readonly recorders: number;
  readonly coverage: ReadonlyArray<{
    readonly coverage: string;
    readonly requirements: number;
  }>;
}

export interface ReviewStats {
  readonly cycleId: string | null;
  readonly lanes: ReadonlyArray<LaneCount>;
  readonly gaps: ReadonlyArray<GapCount>;
  readonly agentDispositions: ReadonlyArray<AgentDispositionCount>;
  readonly batchCosts: ReadonlyArray<BatchCost>;
  readonly runs: ReadonlyArray<RunSummary>;
  readonly findings: ReadonlyArray<FindingCount>;
  /** 10.63's and 11.10's signs on findings about tests or proof, each counted apart. */
  readonly signals: {
    readonly forged: number;
    readonly testBloat: number;
    readonly untested: number;
    readonly staleProof: number;
  };
  /**
   * Units assessed high complexity with a gap on ease of validation, in human-suggested (10.55).
   * For a unit assessed at version 4, its sections that are so, read from its judgements.
   */
  readonly highComplexityValidationGapHumanSuggested: number;
  /** Coverage includes the requirements of version 4 assessments' sections, from their judgements. */
  readonly proofs: ProofCounts;
  /** Units by the unchanged-line gap their grouping used, and the agent's merges and splits (10.70). */
  readonly grouping: {
    readonly byGapLines: ReadonlyArray<{
      readonly gapLines: number;
      readonly units: number;
    }>;
    readonly merges: number;
    readonly splits: number;
  };
  /**
   * What is still being judged, summed over the counted cycles whose packet of record is a
   * `packet.published@2` (its `counts.pending`). Absent when none is.
   */
  readonly pending?: { readonly batches: number; readonly sections: number };
  /**
   * The sections no agent decided, by cause, summed over the same packets (`counts.undecided`).
   * Absent when no counted cycle's packet of record is a `packet.published@2`.
   */
  readonly undecided?: Readonly<Record<string, number>>;
  /**
   * The counted units' version 4 sections by what produced their judgement, read from the entries
   * the stats already place for 10.55 and coverage: by the stored `origin.assess` and
   * `origin.review` words, by the name of each code rule an entry rests on (a section counts once
   * per rule it names), and the sections that carry another section's judgement as members of its
   * pattern. An entry that names no origin is counted in neither origin tally. Absent when no
   * placed entry holds an origin, a rule or a pattern it is a member of.
   */
  readonly judgedBy?: {
    readonly assess: Readonly<Record<string, number>>;
    readonly review: Readonly<Record<string, number>>;
    readonly rules: Readonly<Record<string, number>>;
    readonly familyMembers: number;
  };
  /**
   * What these counts could not read or place, so they leave it out: version 2 packets' manifests
   * (their cycle then counts no gaps) and version 4 assessments' judgements (their sections count
   * in neither 10.55 nor coverage), as when no blob store is at hand. Absent when everything read
   * and every judgement was placed on a section of its unit.
   */
  readonly unread?: {
    readonly manifests: number;
    readonly judgements: number;
    /**
     * Entries of judgement bodies that were read but do not decode, such as one with a lane a
     * newer build writes: each one, left out as the packet read leaves it out. Absent when none.
     */
    readonly entries?: number;
    /**
     * Units whose judgements were read but whose sections blob was not, so none of their entries
     * can be placed on a section and all are left out, as the packet read gives them no
     * checkpoint. Absent when none.
     */
    readonly sections?: number;
    /**
     * Entries that decode but name no section of their unit, or repeat an earlier entry's key:
     * left out, as the packet read leaves them out of the unit's checkpoints. Absent when none.
     */
    readonly stray?: number;
  };
}

/** A version 4 assessment's judgements, read loosely around their entries as the read model does. */
const JudgementsEnvelope = z.looseObject({
  rule: z.number(),
  sections: z.array(z.unknown()),
});

/**
 * A computation's output JSON through the computations table and the blob store, when one is at
 * hand: stats need no computation store of their own. Undefined when it cannot be read.
 */
const outputJson = (key: string) =>
  Effect.gen(function* () {
    const blobs = yield* Effect.serviceOption(BlobStore);
    if (Option.isNone(blobs)) return undefined;
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      outputHash: string | null;
    }>`SELECT output_hash FROM computations WHERE key = ${key}`;
    if (row?.outputHash === null || row?.outputHash === undefined)
      return undefined;
    const read = yield* blobs.value
      .get(row.outputHash)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (read === undefined || read._tag !== "Present") return undefined;
    try {
      const value = JSON.parse(new TextDecoder().decode(read.bytes)) as unknown;
      // As the read model unwraps a stored stage output.
      return value !== null &&
        typeof value === "object" &&
        "output" in value &&
        !("citations" in value)
        ? (value as { output: unknown }).output
        : value;
    } catch {
      return undefined;
    }
  });

/**
 * The version 2 packets of record among the counted cycles: their pending and undecided counts,
 * and the gap IDs their manifests name, which are a cycle's gaps instead of its run's.
 */
const standingV2 = (cycle: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    // Every counted cycle holding a version 2 packet, through the kind index alone (its rows have
    // no projection), whether or not that packet stands.
    const cycles = (yield* sql<{
      cycleId: string;
    }>`SELECT DISTINCT json_extract(envelope, '$.attribution.cycleId') AS cycle_id
      FROM events WHERE kind = 'packet.published@2'
      ORDER BY cycle_id`)
      .map((row) => row.cycleId)
      .filter((id) => cycle === null || id === cycle);
    const blobs = yield* Effect.serviceOption(BlobStore);
    const found = {
      /** Counted cycles holding any version 2 packet. */
      holding: cycles,
      cycles: [] as Array<string>,
      gaps: [] as Array<string>,
      pending: { batches: 0, sections: 0 },
      // A cause is a stored string: tallied in a Map, so a cause named like an object's own
      // property (`constructor`) starts at nothing.
      undecided: new Map<string, number>(),
      manifestsUnread: 0,
    };
    for (const cycleId of cycles) {
      const id = yield* standingPacketId(cycleId);
      if (id === undefined) continue;
      const held = yield* Log.get(id);
      if (Option.isNone(held) || held.value.event.kind !== "packet.published@2")
        continue;
      const counts = held.value.event.payload.counts;
      found.cycles.push(cycleId);
      found.pending.batches += counts.pending.batches;
      found.pending.sections += counts.pending.sections;
      for (const [cause, n] of Object.entries(counts.undecided))
        found.undecided.set(cause, (found.undecided.get(cause) ?? 0) + n);
      const manifest = Option.isNone(blobs)
        ? undefined
        : (yield* standingManifest(cycleId).pipe(
            Effect.provideService(BlobStore, blobs.value),
          ))?.manifest;
      if (manifest === undefined) {
        found.manifestsUnread += 1;
        continue;
      }
      found.gaps.push(
        ...(manifest.gaps ?? []).map((gap) => gap.id),
        ...manifest.batches.flatMap((batch) =>
          (batch.gaps ?? []).map((gap) => gap.id),
        ),
      );
    }
    return found;
  });

/**
 * A `unit.recorded@3`'s sections blob read for its section keys only: the stats place judgements on
 * sections and need nothing else, so the ranges, which a large unit holds by the thousand, are
 * neither decoded nor checked.
 */
const SectionKeys = z.looseObject({
  sections: z.array(z.looseObject({ key: z.string() })).min(1),
});

/**
 * The keys of the sections a unit's recording holds, from its sections blob; undefined when the
 * recording is not a version 3 or its blob cannot be read (missing, corrupt, pruned, not JSON, or
 * without its sections' keys). A blob whose keys read is, for the stats, a blob that read, whatever
 * else in it is wrong: a section with no title or parts, an empty or invalid owned range (such as
 * one ending before it starts), or a range kind this build does not know. Its unit's judgements
 * count. The packet read refuses such a blob whole and discloses why, so there the unit shows no
 * lines and no checkpoints. This is the one place the two differ: the stats count judgements placed
 * on a section key, not lines, and never decode a section beyond its key. Only a blob the strict
 * write schema refuses, or a newer build's, reaches it.
 */
const sectionKeysOf = (recordedEventId: string | null) =>
  Effect.gen(function* () {
    const blobs = yield* Effect.serviceOption(BlobStore);
    if (recordedEventId === null || Option.isNone(blobs)) return undefined;
    const held = yield* Log.get(recordedEventId);
    if (Option.isNone(held)) return undefined;
    const event = held.value.event;
    if (event.kind !== "unit.recorded@3") return undefined;
    const read = yield* blobs.value
      .get(event.refs[0].ref.slice("blob:".length))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (read === undefined || read._tag !== "Present") return undefined;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      return undefined;
    }
    const keys = safeRead(SectionKeys, json, { notice: false });
    return keys.success
      ? new Set(keys.data.sections.map((section) => section.key))
      : undefined;
  });

/**
 * The counted units' version 4 judgements, for 10.55 and coverage: sections assessed high
 * complexity with a gap on ease of validation whose applied lane is human-suggested, and their
 * requirements' coverage. Only entries placed on a section of the unit's blob count, as the packet
 * read builds checkpoints only from those; every entry left out is counted in `unread`.
 */
const judgedCounts = (cycle: string | null, units: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      envelope: string;
      recordedEventId: string | null;
    }>`SELECT e.envelope, u.recorded_event_id
      FROM projection_units u JOIN events e ON e.id = u.assessment_event_id
        AND e.kind = 'assessment.recorded@4'
      WHERE (${cycle} IS NULL OR u.cycle_id = ${cycle})
        AND (${units} IS NULL OR u.unit_id IN (SELECT value FROM json_each(${units ?? "[]"})))
      ORDER BY u.unit_id`;
    let case1055 = 0;
    let unread = 0;
    let entries = 0;
    let sections = 0;
    let stray = 0;
    const coverage = new Map<string, number>();
    // Stored names, tallied in Maps so a name like an object's own property starts at nothing.
    const by = {
      assess: new Map<string, number>(),
      review: new Map<string, number>(),
      rules: new Map<string, number>(),
      familyMembers: 0,
    };
    const tally = (counts: Map<string, number>, name: string) =>
      counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const row of rows) {
      const ref = (JSON.parse(row.envelope) as { refs: [{ ref: string }] })
        .refs[0].ref;
      const body = safeRead(
        JudgementsEnvelope,
        yield* outputJson(ref.slice("computation:".length)),
        { notice: false },
      );
      if (!body.success) {
        unread += 1;
        continue;
      }
      const held = yield* sectionKeysOf(row.recordedEventId);
      if (held === undefined) {
        sections += 1;
        continue;
      }
      const placed = new Set<string>();
      for (const raw of body.data.sections) {
        const entry = safeRead(AssessedSection, raw, { notice: false });
        if (!entry.success) {
          entries += 1;
          continue;
        }
        if (!held.has(entry.data.key) || placed.has(entry.data.key)) {
          stray += 1;
          continue;
        }
        placed.add(entry.data.key);
        const { assess, lane } = entry.data;
        if (
          assess !== null &&
          assess.complexity.level === "high" &&
          assess.gaps.some((gap) => gap.axis === "ease-of-validation") &&
          lane.applied === "human-suggested"
        )
          case1055 += 1;
        for (const requirement of assess?.easeOfValidation.requirements ?? [])
          coverage.set(
            requirement.coverage,
            (coverage.get(requirement.coverage) ?? 0) + 1,
          );
        const { origin, rules, family } = entry.data;
        if (origin !== undefined) {
          tally(by.assess, origin.assess);
          tally(by.review, origin.review);
        }
        for (const name of new Set((rules ?? []).map((rule) => rule.rule)))
          tally(by.rules, name);
        if (family !== undefined && family.representative !== entry.data.key)
          by.familyMembers += 1;
      }
    }
    return { case1055, coverage, unread, entries, sections, stray, by };
  });

/** The newest receipts are listed; older runs still count in every other aggregate. */
const RUNS_LISTED = 20;

/**
 * Every metric over the whole store, or over one cycle's projections when `cycleId` is given. With
 * `units`, the unit-level metrics (lanes, dispositions, findings, 10.55, grouping, coverage) count
 * only those units: the harness passes its packet of record's units, so units a superseded packet
 * recorded stay in the log without being counted twice.
 */
export const reviewStats = (
  filter: {
    readonly cycleId?: string;
    readonly units?: ReadonlyArray<string> | undefined;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const cycle = filter.cycleId ?? null;
    const inCycle = (alias: string) =>
      sql`(${cycle} IS NULL OR ${sql.literal(alias)}.cycle_id = ${cycle})`;
    const units =
      filter.units === undefined ? null : JSON.stringify(filter.units);
    const ofUnits = (column: string) =>
      sql`(${units} IS NULL OR ${sql.literal(column)} IN (SELECT value FROM json_each(${units ?? "[]"})))`;
    const lanes =
      yield* sql<LaneCount>`SELECT u.batch_id, u.lane, count(*) AS units
      FROM projection_units u WHERE u.lane IS NOT NULL AND ${inCycle("u")} AND ${ofUnits("u.unit_id")}
      GROUP BY u.batch_id, u.lane ORDER BY u.batch_id, u.lane`;
    // Gaps of the packet of record only: a cycle's gaps are those of the run whose packet is the
    // cycle's newest that nothing supersedes, so an older packet's gaps (an earlier generation, or
    // another run key in the cycle) are never counted. A cycle with no packet counts all its gaps.
    // A cycle whose packet of record is a `packet.published@2` counts the gaps its manifest names
    // instead: its run's gaps include earlier publications' that a later batch made stale.
    const v2 = yield* standingV2(cycle);
    const v2Cycles = JSON.stringify(v2.cycles);
    const v2Holding = JSON.stringify(v2.holding);
    const v2Gaps = JSON.stringify(v2.gaps);
    const gaps = yield* sql<GapCount>`SELECT g.kind, g.stage, count(*) AS gaps
      FROM projection_gaps g WHERE ${inCycle("g")}
        AND ((g.cycle_id IN (SELECT value FROM json_each(${v2Cycles}))
            AND g.event_id IN (SELECT value FROM json_each(${v2Gaps})))
          OR (g.cycle_id NOT IN (SELECT value FROM json_each(${v2Cycles}))
            AND ((NOT EXISTS (SELECT 1 FROM projection_packets p WHERE p.cycle_id = g.cycle_id)
                AND g.cycle_id NOT IN (SELECT value FROM json_each(${v2Holding})))
              OR g.run_id = (SELECT p.run_id FROM projection_packets p WHERE p.cycle_id = g.cycle_id
                AND NOT EXISTS (SELECT 1 FROM projection_supersessions s WHERE s.target_id = p.event_id)
                ORDER BY p.event_id DESC LIMIT 1))))
      GROUP BY g.kind, g.stage ORDER BY g.kind, g.stage`;
    const agentDispositions =
      yield* sql<AgentDispositionCount>`SELECT d.verdict, u.lane,
        count(*) AS dispositions,
        coalesce(sum(d.verdict = 'request-changes' AND d.rests_on_count = 0), 0) AS uncited,
        coalesce(sum(d.verdict = 'approve' AND d.proof_count = 0), 0) AS without_proof,
        coalesce(sum(d.rests_on_count IS NULL), 0) AS version1
      FROM ${sql.literal(dispositionRows)} d
      JOIN projection_actors a ON a.actor_id = d.actor_id AND a.actor_kind = 'agent'
      LEFT JOIN projection_units u ON u.unit_id = d.unit_id
      WHERE ${sql.literal(liveDisposition("d"))} AND ${inCycle("d")} AND ${ofUnits("d.unit_id")}
      GROUP BY d.verdict, u.lane ORDER BY d.verdict, u.lane`;
    const batchCosts =
      yield* sql<BatchCost>`SELECT s.batch_id, count(*) AS stages,
        sum(s.wall_ms) AS wall_ms, sum(s.model_calls) AS model_calls,
        CASE WHEN count(s.cost_micro_usd) = count(*) THEN sum(s.cost_micro_usd) END AS cost_micro_usd
      FROM projection_stages s WHERE ${inCycle("s")} GROUP BY s.batch_id ORDER BY s.batch_id`;
    const runs =
      yield* sql<RunSummary>`SELECT r.run_id, r.cycle_id, r.outcome, r.ended_at, r.wall_ms,
        r.queue_wait_ms, r.model_calls, r.cost_micro_usd,
        (SELECT count(*) FROM projection_stages s WHERE s.run_id = r.run_id) AS stage_count,
        (SELECT count(*) FROM projection_gaps g WHERE g.run_id = r.run_id) AS gap_count,
        r.unit_count_10, r.unit_count_20, r.unit_count_40
      FROM projection_runs r WHERE ${inCycle("r")} ORDER BY r.run_id DESC LIMIT ${RUNS_LISTED}`;
    const findings = yield* sql<FindingCount>`SELECT c.finding_kind AS kind,
        c.finding_about AS about, c.finding_signal AS signal, count(*) AS comments
      FROM ${sql.literal(commentRows)} c WHERE c.finding_kind IS NOT NULL AND ${inCycle("c")}
        AND (${units} IS NULL OR EXISTS (SELECT 1 FROM events e JOIN event_units eu ON eu.event_seq = e.seq
          WHERE e.id = c.event_id AND eu.unit_id IN (SELECT value FROM json_each(${units ?? "[]"}))))
      GROUP BY c.finding_kind, c.finding_about, c.finding_signal
      ORDER BY c.finding_kind, c.finding_about, c.finding_signal`;
    const [case1055] = yield* sql<{ units: number }>`SELECT count(*) AS units
      FROM projection_units u WHERE u.complexity = 'high' AND u.validation_gap = 1
        AND u.lane = 'human-suggested' AND ${inCycle("u")} AND ${ofUnits("u.unit_id")}`;
    const byGapLines = yield* sql<{
      gapLines: number;
      units: number;
    }>`SELECT u.grouping_gap_lines AS gap_lines, count(*) AS units FROM projection_units u
      WHERE u.grouping_gap_lines IS NOT NULL AND ${inCycle("u")} AND ${ofUnits("u.unit_id")}
      GROUP BY u.grouping_gap_lines ORDER BY u.grouping_gap_lines`;
    const [adjustments] = yield* sql<{
      merges: number | null;
      splits: number | null;
    }>`SELECT sum(u.grouping_adjustment = 'merge') AS merges,
        sum(u.grouping_adjustment = 'split') AS splits
      FROM projection_units u WHERE ${inCycle("u")} AND ${ofUnits("u.unit_id")}`;
    const judged = yield* judgedCounts(cycle, units);
    const counted = yield* proofCounts(cycle, units);
    // Version 4 requirements join the coverage rows, in the same order the query gives them.
    const merged = new Map(
      counted.coverage.map((row) => [row.coverage, row.requirements]),
    );
    for (const [coverage, n] of judged.coverage)
      merged.set(coverage, (merged.get(coverage) ?? 0) + n);
    const proofs: ProofCounts =
      judged.coverage.size === 0
        ? counted
        : {
            ...counted,
            coverage: [...merged]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([coverage, requirements]) => ({ coverage, requirements })),
          };
    const signal = (name: string) =>
      findings
        .filter((f) => f.signal === name)
        .reduce((sum, f) => sum + f.comments, 0);
    const stats: ReviewStats = {
      cycleId: cycle,
      lanes,
      gaps,
      agentDispositions,
      batchCosts,
      runs,
      findings,
      signals: {
        forged: signal("forged"),
        testBloat: signal("test-bloat"),
        untested: signal("untested"),
        staleProof: signal("stale-proof"),
      },
      highComplexityValidationGapHumanSuggested:
        (case1055?.units ?? 0) + judged.case1055,
      proofs,
      grouping: {
        byGapLines,
        merges: adjustments?.merges ?? 0,
        splits: adjustments?.splits ?? 0,
      },
      ...(v2.cycles.length === 0
        ? {}
        : {
            pending: v2.pending,
            // Own properties only, in the order the causes were first counted.
            undecided: Object.fromEntries(v2.undecided),
          }),
      ...(judged.by.assess.size === 0 &&
      judged.by.rules.size === 0 &&
      judged.by.familyMembers === 0
        ? {}
        : {
            judgedBy: {
              // Own properties only, in the order the names were first counted.
              assess: Object.fromEntries(judged.by.assess),
              review: Object.fromEntries(judged.by.review),
              rules: Object.fromEntries(judged.by.rules),
              familyMembers: judged.by.familyMembers,
            },
          }),
      ...(v2.manifestsUnread === 0 &&
      judged.unread === 0 &&
      judged.entries === 0 &&
      judged.sections === 0 &&
      judged.stray === 0
        ? {}
        : {
            unread: {
              manifests: v2.manifestsUnread,
              judgements: judged.unread,
              ...(judged.entries === 0 ? {} : { entries: judged.entries }),
              ...(judged.sections === 0 ? {} : { sections: judged.sections }),
              ...(judged.stray === 0 ? {} : { stray: judged.stray }),
            },
          }),
    };
    return stats;
  });

/** Proof counts over the store, or over one cycle (see `ProofCounts`). */
const proofCounts = (cycle: string | null, units: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const ofCycle = sql`(${cycle} IS NULL OR p.cycle_id = ${cycle}
      OR p.base_oid = (SELECT c.base_oid FROM projection_cycles c WHERE c.cycle_id = ${cycle}))`;
    const byKind = yield* sql<{
      kind: string;
      records: number;
    }>`SELECT p.kind, count(*) AS records FROM projection_proofs p WHERE ${ofCycle}
      GROUP BY p.kind ORDER BY p.kind`;
    const [recorders] = yield* sql<{
      recorders: number;
    }>`SELECT count(DISTINCT p.actor_id) AS recorders FROM projection_proofs p WHERE ${ofCycle}`;
    // Read from each unit's current assessment event (versions 2 and 3), one per unit; version 4's
    // requirements are in its judgements, which `judgedCounts` reads.
    const coverage = yield* sql<{
      coverage: string;
      requirements: number;
    }>`SELECT json_extract(r.value, '$.coverage') AS coverage, count(*) AS requirements
      FROM projection_units u JOIN events e ON e.id = u.assessment_event_id
        AND e.kind IN ('assessment.recorded@2', 'assessment.recorded@3'),
        json_each(e.envelope, '$.payload.easeOfValidation.requirements') r
      WHERE (${cycle} IS NULL OR u.cycle_id = ${cycle})
        AND (${units} IS NULL OR u.unit_id IN (SELECT value FROM json_each(${units ?? "[]"})))
      GROUP BY coverage ORDER BY coverage`;
    return {
      byKind,
      recorders: recorders?.recorders ?? 0,
      coverage,
    } satisfies ProofCounts;
  });

/**
 * A range's proof records counted by kind and by currency (11.10): for a unit owning `ownedPaths`,
 * or, before units exist (H7), for the whole range taken as one unit, owning every path it changes,
 * where a record is current only if nothing the range changes changed after its commit.
 */
export const rangeProofStats = (options: {
  readonly repository: string;
  readonly range: Range;
  readonly ownedPaths?: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    const ownedPaths =
      options.ownedPaths ??
      (yield* Proofs.changedPaths(options.repository, options.range));
    const listed = yield* Proofs.list({
      repository: options.repository,
      range: options.range,
      ownedPaths: ownedPaths.length === 0 ? undefined : ownedPaths,
    });
    const byKind = new Map<string, number>();
    for (const record of listed.records)
      byKind.set(record.kind, (byKind.get(record.kind) ?? 0) + 1);
    return {
      range: options.range,
      unit: options.ownedPaths === undefined ? "whole-range" : "owned-paths",
      records: listed.records.length,
      byKind: [...byKind]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, records]) => ({ kind, records })),
      currency: Proofs.currencyCounts(listed),
    };
  });

/** A run's events by kind, read through the kind index and filtered by the run's attribution. */
const RUN_KINDS_SQL = `kind IN ('stage.completed@1', 'gap.disclosed@1', 'run.completed@1', 'packet.published@1', 'packet.published@2')`;

/** The receipt Records holds for a run (`run.completed@1`), the earliest by ULID if a replay added one. */
export const runReceipt = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const [row] = yield* sql<{ id: string }>`SELECT id FROM events
      WHERE kind = 'run.completed@1' AND json_extract(envelope, '$.attribution.runId') = ${runId}
      ORDER BY id LIMIT 1`;
    if (row === undefined) return Option.none<StoredEvent>();
    return yield* Log.get(row.id);
  });

/** How many of each run-telemetry kind Records holds for a run. */
export const runRecordCounts = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    return yield* sql<{
      kind: string;
      events: number;
    }>`SELECT kind, count(*) AS events
      FROM events WHERE ${sql.literal(RUN_KINDS_SQL)}
        AND json_extract(envelope, '$.attribution.runId') = ${runId}
      GROUP BY kind ORDER BY kind`;
  });

/**
 * The newest run, for a range when one is given. A run's ID is the ID of the review request that
 * started it. Every request appends a `review.requested@1`, including one that joins a running job or
 * finds the range already reviewed, so a request counts as a run only when it enqueued the run's job
 * (`jobs.event_id`) or has a receipt (whose job may be gone). A run a newer build queued under its own
 * job kind (`review.run@2`) is left to it until its receipt exists (8.19). Read through the kind index,
 * newest first.
 */
export const latestRun = (range?: {
  readonly baseOid: string;
  readonly headOid: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const [row] = yield* sql<{ id: string }>`SELECT e.id FROM events e
      WHERE e.kind = 'review.requested@1'
        AND (${range?.baseOid ?? null} IS NULL
          OR (json_extract(e.envelope, '$.attribution.range.baseOid') = ${range?.baseOid ?? null}
            AND json_extract(e.envelope, '$.attribution.range.headOid') = ${range?.headOid ?? null}))
        AND (EXISTS (SELECT 1 FROM jobs j WHERE j.event_id = e.id AND ${sql.in("j.kind", REVIEW_RUN_KINDS)})
          OR EXISTS (SELECT 1 FROM projection_runs r WHERE r.run_id = e.id))
      ORDER BY e.seq DESC LIMIT 1`;
    return Option.fromNullishOr(row?.id);
  });
