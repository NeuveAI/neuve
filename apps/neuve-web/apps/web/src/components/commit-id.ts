/** A full commit id (SHA-1 or SHA-256), as the lineage loader requires. */
export const FULL_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

/** What a `/changes/<sha>` not-found carries, for its empty state. */
export interface UnknownCommitData {
  reason: "unknown-commit"
  commit: string
  /** Several known revisions start with it (a longer id would resolve). */
  candidates?: number
}

export function isUnknownCommit(data: unknown): data is UnknownCommitData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { reason?: unknown }).reason === "unknown-commit" &&
    typeof (data as { commit?: unknown }).commit === "string"
  )
}

/**
 * `/changes/$commit` search: a previous revision that isn't a full commit id
 * is dropped. The key is always returned (undefined when invalid), because
 * TanStack Router merges the raw search under the validated one: omitting
 * the key would keep the raw, invalid value.
 */
export function validateChangesSearch(input: Record<string, unknown>): {
  fromRevisionId: string | undefined
} {
  const from = input.fromRevisionId
  return {
    fromRevisionId:
      typeof from === "string" && FULL_COMMIT.test(from) ? from : undefined,
  }
}
