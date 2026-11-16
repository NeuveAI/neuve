import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { RecordEvent } from "@neuve/records-schema";
import { UNRESOLVED_ACTOR, assignAliases, baseAlias } from "./identity.ts";

/**
 * Projectors: deterministic functions of (projection state, event). They read no clock and no other
 * source, and they never depend on `seq`, which is not causal across capture paths (D18): spooled
 * events get theirs at ingestion while interactive commands append at once. Where one event replaces
 * another, the newer ULID wins, or the earlier one where the first holder counts; a `supersedes` link
 * wins over both. Counters only add. So any append order of the same events projects the same rows,
 * which is what rebuild relies on (D7). They run inside the append transaction and again on rebuild.
 */
export const project = (event: RecordEvent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    // These claims are read from the log. Projecting them into the shared tables would make an
    // older reader's rebuild checksum disagree with the store (8.19), and an impact finding's kind
    // would read as a corrupt comments row to an older build's read model. A carried disposition's
    // `supersedes` is read from the log (`liveDisposition`); comment version 3 and lineage refuse
    // one, so returning before the supersession insert loses no link they could hold.
    if (
      event.kind === "disposition.carried@1" ||
      event.kind === "comment.carried@1" ||
      event.kind === "comment.recorded@3" ||
      event.kind === "lineage.recorded@1" ||
      event.kind === "judgement.preparation.requested@1" ||
      event.kind === "judgement.counted@1" ||
      event.kind === "judgement.shadow-checked@1"
    )
      return;
    const supersedes = event.causation?.supersedes;
    if (supersedes !== undefined) {
      // Kept even when the target has not arrived yet, so the target is superseded whenever it does.
      yield* sql`INSERT INTO projection_supersessions ${sql.insert({ target_id: supersedes, by_event_id: event.id })}`;
    }
    switch (event.kind) {
      case "actor.registered@1": {
        const p = event.payload;
        const aliasBase = baseAlias(event.actor);
        const labelled =
          p.displayName !== undefined || p.agentType !== undefined;
        yield* sql`INSERT INTO projection_actors ${sql.insert({
          actor_id: event.actor,
          actor_kind: p.actorKind,
          harness: p.harness,
          session_id: p.sessionId ?? null,
          subagent_id: p.subagentId ?? null,
          parent_actor: p.parentActor ?? null,
          agent_type: p.agentType ?? null,
          display_name: p.displayName ?? null,
          email: p.email ?? null,
          alias_base: aliasBase,
          alias: aliasBase,
          registered_event_id: event.id,
          label_event_id: labelled ? event.id : null,
          event_id: event.id,
        })} ON CONFLICT (actor_id) DO UPDATE SET
          actor_kind = ${sql.literal(earliest("actor_kind"))}, harness = ${sql.literal(earliest("harness"))},
          session_id = ${sql.literal(earliest("session_id"))}, subagent_id = ${sql.literal(earliest("subagent_id"))},
          parent_actor = ${sql.literal(earliest("parent_actor"))}, email = ${sql.literal(earliest("email"))},
          registered_event_id = min(registered_event_id, excluded.registered_event_id),
          event_id = max(event_id, excluded.event_id)`;
        // The display name and agent type come from the newest registration that carries either.
        if (labelled) {
          yield* sql`UPDATE projection_actors SET display_name = ${p.displayName ?? null},
            agent_type = ${p.agentType ?? null}, label_event_id = ${event.id}
            WHERE actor_id = ${event.actor} AND (label_event_id IS NULL OR label_event_id < ${event.id})`;
        }
        yield* reassignAliases(aliasBase);
        return;
      }
      case "session.started@1": {
        yield* bumpActivity(event.actor, "sessions_started");
        yield* recordModel(event.actor, event.payload.model, event.id);
        return;
      }
      case "session.ended@1":
        return yield* bumpActivity(event.actor, "sessions_ended");
      case "turn.started@1": {
        yield* bumpActivity(event.actor, "turns");
        yield* recordModel(event.actor, event.payload.model, event.id);
        return;
      }
      case "turn.ended@1":
        return yield* recordModel(event.actor, event.payload.model, event.id);
      case "turn.summarized@1": {
        const p = event.payload;
        yield* sql`INSERT INTO projection_actor_activity ${sql.insert({
          actor_id: event.actor,
          summaries: 1,
          tokens_input: p.tokens.input,
          tokens_cache_creation: p.tokens.cacheCreation,
          tokens_cache_read: p.tokens.cacheRead,
          tokens_output: p.tokens.output,
          api_calls: p.apiCalls,
          tool_calls: p.toolCalls,
        })} ON CONFLICT (actor_id) DO UPDATE SET summaries = summaries + 1,
          tokens_input = tokens_input + excluded.tokens_input,
          tokens_cache_creation = tokens_cache_creation + excluded.tokens_cache_creation,
          tokens_cache_read = tokens_cache_read + excluded.tokens_cache_read,
          tokens_output = tokens_output + excluded.tokens_output,
          api_calls = api_calls + excluded.api_calls, tool_calls = tool_calls + excluded.tool_calls`;
        return yield* recordModel(event.actor, p.model, event.id);
      }
      case "cycle.scope-selected@1":
      case "cycle.external-context-selected@1":
        return;
      case "review.origin-recorded@1": {
        const origin = event.payload.origin;
        yield* sql`INSERT INTO projection_review_origins ${sql.insert({
          event_id: event.id,
          identity: event.payload.identity,
          cycle_id: event.attribution.cycleId,
          host: origin.host,
          channel: origin.kind === "channel" ? origin.channel : null,
          chat: origin.kind === "channel" ? origin.chat : null,
          lane: origin.kind === "channel" ? (origin.lane ?? null) : null,
          origin_json: JSON.stringify(origin),
          base_oid: event.attribution.range.baseOid,
          head_oid: event.attribution.range.headOid,
          occurred_at: event.occurredAt,
        })}`;
        return;
      }
      case "cycle.opened@1": {
        const { cycleId, range } = event.attribution;
        yield* sql`INSERT INTO projection_cycles ${sql.insert({
          cycle_id: cycleId,
          base_ref: range.baseRef,
          base_oid: range.baseOid,
          head_oid: range.headOid,
          event_id: event.id,
        })} ON CONFLICT (cycle_id) DO UPDATE SET base_ref = excluded.base_ref, base_oid = excluded.base_oid,
          head_oid = excluded.head_oid, event_id = excluded.event_id
          WHERE excluded.event_id < projection_cycles.event_id`;
        return;
      }
      case "batch.recorded@1": {
        const { cycleId, batchId } = event.attribution;
        yield* sql`INSERT INTO projection_batches ${sql.insert({
          batch_id: batchId,
          cycle_id: cycleId,
          title: event.payload.title,
          event_id: event.id,
        })} ON CONFLICT (batch_id) DO UPDATE SET cycle_id = excluded.cycle_id, title = excluded.title,
          event_id = excluded.event_id WHERE excluded.event_id > projection_batches.event_id`;
        return;
      }
      case "unit.recorded@1":
      case "unit.recorded@2":
      case "unit.recorded@3": {
        const { cycleId, batchId, unitIds } = event.attribution;
        const grouping =
          event.kind === "unit.recorded@2" ? event.payload.grouping : undefined;
        // Every recorded column comes from the newest recording by ULID, whatever its version, so
        // a version 1 event that wins clears what an older version 2 set (any order, same row).
        // Version 3 holds its ranges in its sections blob and counts them in its payload; it has
        // no grouping.
        const row = {
          unit_id: unitIds[0],
          cycle_id: cycleId,
          batch_id: batchId,
          title: event.payload.title,
          owned_range_count:
            event.kind === "unit.recorded@3"
              ? event.payload.ranges.count
              : event.payload.ownedRanges.length,
          recorded_event_id: event.id,
          grouping_gap_lines: grouping?.gapLines ?? null,
          grouping_adjustment: grouping?.adjustment?.kind ?? null,
        };
        yield* sql`INSERT INTO projection_units ${sql.insert(row)} ON CONFLICT (unit_id) DO UPDATE SET
          cycle_id = excluded.cycle_id, batch_id = excluded.batch_id, title = excluded.title,
          owned_range_count = excluded.owned_range_count, recorded_event_id = excluded.recorded_event_id,
          grouping_gap_lines = excluded.grouping_gap_lines, grouping_adjustment = excluded.grouping_adjustment
          WHERE projection_units.recorded_event_id IS NULL OR excluded.recorded_event_id > projection_units.recorded_event_id`;
        return;
      }
      case "assessment.recorded@1":
      case "assessment.recorded@2":
      case "assessment.recorded@3":
      case "assessment.recorded@4": {
        // Version 3 adds the checkpoints' anchors and kinds (11.17); its row is version 2's.
        // Version 4 records the lane only: its axes are per section, in its judgements, so the
        // quadrant, complexity and validation-gap columns stay null, as for version 1.
        const v2 =
          event.kind === "assessment.recorded@1" ||
          event.kind === "assessment.recorded@4"
            ? undefined
            : event.payload;
        const row = {
          unit_id: event.attribution.unitIds[0],
          lane: event.payload.lane,
          assessment_event_id: event.id,
          quadrant: v2?.quadrant ?? null,
          complexity: v2?.complexity.level ?? null,
          validation_gap:
            v2 === undefined
              ? null
              : v2.gaps.some((gap) => gap.axis === "ease-of-validation")
                ? 1
                : 0,
        };
        yield* sql`INSERT INTO projection_units ${sql.insert(row)} ON CONFLICT (unit_id) DO UPDATE SET
          lane = excluded.lane, assessment_event_id = excluded.assessment_event_id,
          quadrant = excluded.quadrant, complexity = excluded.complexity, validation_gap = excluded.validation_gap
          WHERE projection_units.assessment_event_id IS NULL OR excluded.assessment_event_id > projection_units.assessment_event_id`;
        return;
      }
      case "context.referenced@1":
      case "context.referenced@2": {
        const { cycleId, unitIds } = event.attribution;
        const v2 =
          event.kind === "context.referenced@2" ? event.payload : undefined;
        yield* sql`INSERT INTO projection_context_references ${sql.insert({
          event_id: event.id,
          cycle_id: cycleId,
          marker_kind: event.payload.markerKind,
          source_kind: event.payload.source.kind,
          unit_count: unitIds.length,
          stance: v2?.stance ?? null,
          origin: v2?.origin ?? null,
        })}`;
        yield* sql`INSERT INTO projection_units ${sql.insert(unitIds.map((unit_id) => ({ unit_id, context_reference_count: 1 })))}
          ON CONFLICT (unit_id) DO UPDATE SET context_reference_count = context_reference_count + 1`;
        return;
      }
      case "comment.recorded@1":
      case "comment.recorded@2": {
        const { cycleId, unitIds } = event.attribution;
        const finding =
          event.kind === "comment.recorded@2"
            ? event.payload.finding
            : undefined;
        yield* sql`INSERT INTO projection_comments ${sql.insert({
          event_id: event.id,
          cycle_id: cycleId,
          actor_id: event.actor,
          anchor_path: event.payload.anchor?.path ?? null,
          unit_count: unitIds.length,
          finding_kind: finding?.kind ?? null,
          finding_about: finding?.about ?? null,
          finding_signal: finding?.signal ?? null,
        })}`;
        yield* sql`INSERT INTO projection_units ${sql.insert(unitIds.map((unit_id) => ({ unit_id, comment_count: 1 })))}
          ON CONFLICT (unit_id) DO UPDATE SET comment_count = comment_count + 1`;
        return;
      }
      case "disposition.recorded@1":
      case "disposition.recorded@2": {
        // Every disposition is kept; the current one is read through `Dispositions.current`.
        const v2 =
          event.kind === "disposition.recorded@2" ? event.payload : undefined;
        yield* sql`INSERT INTO projection_dispositions ${sql.insert({
          event_id: event.id,
          unit_id: event.attribution.unitIds[0],
          cycle_id: event.attribution.cycleId,
          actor_id: event.actor,
          verdict: event.payload.verdict,
          reviewed_head_oid: event.payload.reviewedHeadOid,
          // Version 1 cannot name comments or proof, so it is neither cited nor uncited.
          rests_on_count: v2?.restsOn.length ?? null,
          proof_count: v2?.proof.length ?? null,
        })}`;
        return;
      }
      case "delivery.recorded@1": {
        yield* sql`INSERT INTO projection_deliveries ${sql.insert({
          event_id: event.id,
          cycle_id: event.attribution.cycleId,
          batch_id: event.attribution.batchId,
          unit_id: event.attribution.unitIds?.[0] ?? null,
          content: event.payload.content,
          verdict_words: event.payload.verdictWords ?? null,
        })}`;
        return;
      }
      case "packet.published@2":
        // Read from the log, never projected into the packets table: an older build counts that
        // table's entities by `packet.published@1` only, so a row here would read to it as a state
        // copy, and its newest-packet reader would pick a cycle whose review it cannot show over an
        // older one it can. Its supersession is recorded above, so it still sets older packets aside.
        return;
      case "packet.published@1": {
        yield* sql`INSERT INTO projection_packets ${sql.insert({
          event_id: event.id,
          cycle_id: event.attribution.cycleId,
          run_id: event.attribution.runId,
          complete: event.payload.complete ? 1 : 0,
          units: event.payload.counts.units,
          gaps: event.payload.counts.gaps,
        })}`;
        return;
      }
      case "gap.disclosed@1": {
        yield* sql`INSERT INTO projection_gaps ${sql.insert({
          event_id: event.id,
          run_id: event.attribution.runId,
          cycle_id: event.attribution.cycleId,
          stage: event.attribution.stage ?? null,
          kind: event.payload.kind,
          unit_count: event.attribution.unitIds?.length ?? 0,
        })}`;
        return;
      }
      case "stage.completed@1": {
        const p = event.payload;
        yield* sql`INSERT INTO projection_stages ${sql.insert({
          event_id: event.id,
          run_id: event.attribution.runId,
          cycle_id: event.attribution.cycleId,
          stage: p.stage,
          agent: p.agent,
          batch_id: event.attribution.batchId ?? null,
          status: p.status,
          wall_ms: p.wallMs,
          expected_ms: p.expectedMs ?? null,
          model_calls: p.modelCalls,
          tokens_input: p.usage.input,
          tokens_cache_write: p.usage.cacheWrite5m + p.usage.cacheWrite1h,
          tokens_cache_read: p.usage.cacheRead,
          tokens_output: p.usage.output,
          cost_micro_usd: microUsd(p.costUsd),
          turns_used: p.turns?.turnsUsed ?? null,
          turn_limit: p.turns?.turnLimit ?? null,
          final_generation:
            p.turns === undefined ? null : p.turns.finalGeneration ? 1 : 0,
          ended_by: p.turns?.endedBy ?? null,
        })}`;
        return;
      }
      case "run.completed@1": {
        const p = event.payload;
        const units = p.unitCounts;
        // A run has one receipt; should a second arrive, the earliest by ULID stands in any order.
        yield* sql`INSERT INTO projection_runs ${sql.insert({
          run_id: event.attribution.runId,
          cycle_id: event.attribution.cycleId,
          event_id: event.id,
          outcome: p.outcome,
          ended_at: p.timing.endedAt,
          wall_ms: p.timing.wallMs,
          queue_wait_ms: p.timing.queueWaitMs,
          model_calls: p.totals.modelCalls,
          retries: p.totals.retries,
          cost_micro_usd: microUsd(p.totals.costUsd),
          tokens_input: p.totals.usage.input,
          tokens_output: p.totals.usage.output,
          unit_count_10: units?.at10 ?? null,
          unit_count_20: units?.at20 ?? null,
          unit_count_40: units?.at40 ?? null,
        })} ON CONFLICT (run_id) DO UPDATE SET ${sql.literal(
          RUN_COLUMNS.map((column) => `${column} = excluded.${column}`).join(
            ", ",
          ),
        )} WHERE excluded.event_id < projection_runs.event_id`;
        return;
      }
      case "proof.recorded@1": {
        // Every record is kept: one row per event, never replaced (11.3).
        const { range, cycleId, sessionId } = event.attribution;
        yield* sql`INSERT INTO projection_proofs ${sql.insert({
          event_id: event.id,
          kind: event.payload.kind,
          revision: event.payload.revision,
          base_oid: range.baseOid,
          head_oid: range.headOid,
          cycle_id: cycleId ?? null,
          actor_id: event.actor,
          session_id: sessionId,
          artefact_hash: event.refs[0].ref.slice("blob:".length),
          media_type: event.payload.artefact.mediaType,
          bytes: event.payload.artefact.bytes,
          scope_item: event.payload.requirement.scopeItem ?? null,
          worktree_head: event.payload.worktree.head,
          worktree_scope: event.payload.worktree.scope,
          worktree_dirty: event.payload.worktree.dirty ? 1 : 0,
        })}`;
        return;
      }
      case "vent.recorded@1":
      case "vent.recorded@2":
        // Vents are read from the log by `neuve vents` and have no projection, so nothing that
        // assembles review context from projections can pick one up (2.15).
        return;
      case "disposition.retracted@1":
        // Its only effect is the supersession recorded above.
        return;
      case "feedback.recorded@1":
      case "feedback.recorded@2": {
        // One row per answer, never replaced; a correction's link is the supersession above. Nothing
        // here touches a unit, a disposition or a cycle: feedback changes nothing in the review (FB3).
        yield* sql`INSERT INTO projection_feedback ${sql.insert({
          event_id: event.id,
          cycle_id: event.attribution.cycleId,
          actor_id: event.actor,
          target_kind: event.payload.on,
          target_event_id: event.payload.target,
          harness_call_visible: event.payload.harnessCallVisible ? 1 : 0,
          supersedes_event_id: supersedes ?? null,
        })}`;
        return;
      }
      case "review.requested@1":
        // Its effect is the `review.run` job enqueued with it; a run projects from its receipt.
        return;
      case "commit.recorded@1": {
        yield* sql`INSERT INTO projection_commits ${sql.insert({
          oid: event.payload.oid,
          tree: event.payload.tree,
          actor_id: event.actor,
          session_id: event.attribution?.sessionId ?? null,
          link: event.payload.link,
          link_source: event.payload.linkSource ?? null,
          event_id: event.id,
        })} ON CONFLICT (oid) DO UPDATE SET tree = excluded.tree, actor_id = excluded.actor_id,
          session_id = excluded.session_id, link = excluded.link, link_source = excluded.link_source,
          event_id = excluded.event_id
          WHERE excluded.event_id < projection_commits.event_id`;
        // An unresolved actor is not an actor; its commits are counted from the log by link status.
        if (event.actor !== UNRESOLVED_ACTOR) {
          yield* bumpActivity(event.actor, "commits");
          // A declared link is trusted less than ancestry (8.13), so readers can tell those apart.
          if (event.payload.link === "declared")
            yield* bumpActivity(event.actor, "commits_declared");
        }
        return;
      }
      case "commit.rewritten@1": {
        yield* sql`INSERT INTO projection_commit_rewrites ${sql.insert(
          event.payload.mappings.map(({ from, to }) => ({
            from_oid: from,
            to_oid: to,
            event_id: event.id,
          })),
        )} ON CONFLICT (from_oid, to_oid) DO UPDATE SET event_id = min(event_id, excluded.event_id)`;
        return;
      }
      case "model.calls-counted@2":
      case "stage.started@1":
      case "capture.filed@1":
      case "capture.sealed@1":
      case "capture.marked@1":
        return;
      default:
        // Every kind has a case, so a new kind without a projector fails to typecheck.
        return event satisfies never;
    }
  });

/**
 * USD as integer micro-USD, so checksums never depend on floating-point formatting. Null (a route
 * with no per-token price) stays null: unknown, never 0.
 */
const microUsd = (usd: number | null) =>
  usd === null ? null : Math.round(usd * 1_000_000);

const RUN_COLUMNS = [
  "cycle_id",
  "event_id",
  "outcome",
  "ended_at",
  "wall_ms",
  "queue_wait_ms",
  "model_calls",
  "retries",
  "cost_micro_usd",
  "tokens_input",
  "tokens_output",
  "unit_count_10",
  "unit_count_20",
  "unit_count_40",
];

/**
 * An identity column of `projection_actors` taken from the earliest registration by ULID, so the row
 * does not depend on which registration was appended first.
 */
const earliest = (column: string) =>
  `CASE WHEN excluded.registered_event_id < projection_actors.registered_event_id THEN excluded.${column} ELSE projection_actors.${column} END`;

type Counter =
  | "sessions_started"
  | "sessions_ended"
  | "turns"
  | "commits"
  | "commits_declared";

const bumpActivity = (actorId: string, counter: Counter) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `INSERT INTO projection_actor_activity (actor_id, ${counter}) VALUES (?, 1)
        ON CONFLICT (actor_id) DO UPDATE SET ${counter} = ${counter} + 1`,
      [actorId],
    );
  });

/** The model an actor last reported: the newest event by ULID that names one (D21: model per turn). */
const recordModel = (
  actorId: string,
  model: string | undefined,
  eventId: string,
) =>
  Effect.gen(function* () {
    if (model === undefined) return;
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO projection_actor_activity ${sql.insert({ actor_id: actorId, model, model_event_id: eventId })}
      ON CONFLICT (actor_id) DO UPDATE SET model = excluded.model, model_event_id = excluded.model_event_id
      WHERE projection_actor_activity.model_event_id IS NULL OR excluded.model_event_id > projection_actor_activity.model_event_id`;
  });

/** Re-derives the aliases of every actor sharing one base alias, in registration order (D22). */
const reassignAliases = (aliasBase: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const holders = yield* sql<{
      actorId: string;
      alias: string;
    }>`SELECT actor_id, alias FROM projection_actors
      WHERE alias_base = ${aliasBase} ORDER BY registered_event_id, actor_id`;
    const aliases = assignAliases(holders.map((holder) => holder.actorId));
    for (const holder of holders) {
      const alias = aliases.get(holder.actorId);
      if (alias !== undefined && alias !== holder.alias)
        yield* sql`UPDATE projection_actors SET alias = ${alias} WHERE actor_id = ${holder.actorId}`;
    }
  });
