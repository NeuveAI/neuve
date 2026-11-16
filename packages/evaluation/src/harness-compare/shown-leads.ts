/**
 * A hunk's served leads in a stored run (`neuve review show --json`, as the runner keeps it). Since
 * NEU-148 they are the range's leads computation, `leads.hunks`, stored when the run's leads task
 * ends, so a run caught mid-way may have none yet (null). A run from before keeps them inline on
 * each manifest hunk, and archived runs are never rewritten, so both are read, the newer first.
 */
export const shownLeads = <L>(shown: {
  readonly manifest?: {
    readonly hunks?: ReadonlyArray<{
      readonly hunkId: string;
      readonly leads?: L | null;
    }>;
  } | null;
  readonly leads?: {
    readonly hunks: ReadonlyArray<{
      readonly hunkId: string;
      readonly leads: L | null;
    }>;
  } | null;
}): ((hunkId: string) => L | null) => {
  const ranked = shown.leads?.hunks;
  if (ranked !== undefined) {
    const byHunk = new Map(ranked.map((entry) => [entry.hunkId, entry.leads]));
    return (hunkId) => byHunk.get(hunkId) ?? null;
  }
  const inline = new Map(
    (shown.manifest?.hunks ?? []).map((hunk) => [hunk.hunkId, hunk.leads]),
  );
  return (hunkId) => inline.get(hunkId) ?? null;
};
