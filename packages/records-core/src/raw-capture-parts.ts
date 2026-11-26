import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export const RAW_CAPTURE_DAYS = 30;

export const unprotectedRawBlob = (cutoff: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [table] =
      yield* sql`SELECT name FROM sqlite_schema WHERE name = 'raw_capture_parts'`;
    return table === undefined
      ? undefined
      : sql`NOT EXISTS (
          SELECT 1 FROM raw_capture_parts AS parts JOIN blobs AS capture ON capture.hash = parts.capture_hash
          WHERE parts.part_hash = blobs.hash AND capture.pruned_at IS NULL AND capture.captured_at >= ${cutoff}
        )`;
  });

export const rawCapturePartsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS raw_capture_parts (
    capture_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
    part_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
    PRIMARY KEY (capture_hash, part_hash), CHECK (capture_hash <> part_hash)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX IF NOT EXISTS raw_capture_parts_by_blob ON raw_capture_parts(part_hash, capture_hash)`;
  // Older prune workers select by blob age alone.
  yield* sql.unsafe(`CREATE TRIGGER IF NOT EXISTS raw_capture_parts_guard BEFORE UPDATE OF pruned_at ON blobs
    WHEN OLD.pruned_at IS NULL AND NEW.pruned_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM raw_capture_parts AS parts JOIN blobs AS capture ON capture.hash = parts.capture_hash
      WHERE parts.part_hash = OLD.hash AND capture.pruned_at IS NULL
        AND capture.captured_at >= strftime('%Y-%m-%dT%H:%M:%fZ', NEW.pruned_at, '-${RAW_CAPTURE_DAYS} days')
    ) BEGIN SELECT RAISE(IGNORE); END`);
});
