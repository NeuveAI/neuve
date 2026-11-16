/** New carried kinds stay out of shared projection tables so older builds can check and rebuild
 * the store. Current readers combine those tables with the attributed claims in the log (8.19).
 * Comment version 3 is read here too: an impact finding's kind is one an older build's comments
 * read model does not know. */
/** The recorded half of `dispositionRows`, for a reader that filters it through its own index. */
export const recordedDispositionRows = `SELECT event_id, unit_id, cycle_id, actor_id, verdict, reviewed_head_oid, rests_on_count, proof_count FROM projection_dispositions`;

/** The carried half of `dispositionRows`, for a reader that filters it through the log's indexes. */
export const carriedDispositionRows = `SELECT id, json_extract(envelope, '$.attribution.unitIds[0]'), json_extract(envelope, '$.attribution.cycleId'), actor_id,
    json_extract(envelope, '$.payload.verdict'), json_extract(envelope, '$.payload.reviewedHeadOid'),
    json_array_length(json_extract(envelope, '$.payload.restsOn')), json_array_length(json_extract(envelope, '$.payload.proof'))
  FROM events WHERE kind = 'disposition.carried@1'`;

export const dispositionRows = `(${recordedDispositionRows}
  UNION ALL ${carriedDispositionRows})`;

export const commentRows = `(SELECT event_id, cycle_id, actor_id, anchor_path, unit_count, finding_kind, finding_about, finding_signal FROM projection_comments
  UNION ALL SELECT id, json_extract(envelope, '$.attribution.cycleId'), actor_id,
    json_extract(envelope, '$.payload.anchor.path'), json_array_length(json_extract(envelope, '$.attribution.unitIds')),
    json_extract(envelope, '$.payload.finding.kind'), json_extract(envelope, '$.payload.finding.about'), json_extract(envelope, '$.payload.finding.signal')
  FROM events WHERE kind IN ('comment.carried@1', 'comment.recorded@3'))`;
