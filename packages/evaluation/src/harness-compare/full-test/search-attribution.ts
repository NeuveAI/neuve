/**
 * FT17's search attribution, built as scaffolding: the rule is pre-registered and tested here, and
 * the measure reads "not measured" until a source of search exposures exists. The harness's search
 * tools are changing (another lane is adding Graph's semantic query and E0 as search tools), so where
 * the results each agent saw are read from (run logs, turn transcripts or a new telemetry record) is
 * left to a `SearchExposureSource`, supplied once those tools land.
 *
 * The rule (FT17, option A). A ledger entry counts as found through search when a search result
 * shown earlier to the same agent covered its lines (any line), or when its `followedFrom` chain
 * reaches an entry found that way or recorded from a search; both attributions are reported. An
 * entry covered by both a preloaded lead and an earlier search result is credited to the lead,
 * since the agent held it before searching, and such entries are also counted apart.
 *
 * The pre-registered trigger for FT17's option C: in A and A′ alike, at least 15% of the ledger
 * entries that touch a gold necessary or useful target are credited to search alone (under either
 * attribution), on at least half of the 15 families.
 */

export interface Region {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** One search result an agent was shown: its agent (an Investigate partition), turn and region. */
export interface SearchExposure extends Region {
  readonly agent: string;
  readonly turn: number;
}

/** Where a run's search exposures come from; null while no source exists (the measure is not taken). */
export type SearchExposureSource = (run: {
  readonly runLogs?: ReadonlyArray<{
    readonly file?: string;
    readonly text: string;
  }>;
}) => ReadonlyArray<SearchExposure> | null;

/** No source yet: FT17's search tools are pending, so nothing is attributed. */
export const PENDING_SOURCE: SearchExposureSource = () => null;

export interface AttributableEntry extends Region {
  readonly id: string;
  readonly agent: string;
  readonly turn: number;
  readonly lookup: string;
  readonly followedFrom: string | null;
  /** Whether the entry touches a gold necessary or useful target (any line). */
  readonly touchesGold: boolean;
}

export type Credit = "lead" | "search" | "other";

const overlaps = (a: Region, b: Region) =>
  a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;

/**
 * Each entry's credit under both attributions: `byExposure` (a search result shown earlier to the
 * same agent covered it) and `byChain` (its `followedFrom` chain reaches a search entry or a lookup
 * named search). `bothLeadAndSearch` marks entries a preloaded lead and an earlier search covered.
 */
export const attributeEntries = (
  entries: ReadonlyArray<AttributableEntry>,
  exposures: ReadonlyArray<SearchExposure>,
  leads: ReadonlyArray<Region & { readonly agent: string }>,
) => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const searchedBefore = (entry: AttributableEntry) =>
    exposures.some(
      (shown) =>
        shown.agent === entry.agent &&
        shown.turn < entry.turn &&
        overlaps(shown, entry),
    );
  const leadCovers = (entry: AttributableEntry) =>
    entry.lookup === "preloaded-lead" ||
    leads.some((lead) => lead.agent === entry.agent && overlaps(lead, entry));
  const chainReachesSearch = (entry: AttributableEntry) => {
    const seen = new Set<string>();
    let at: AttributableEntry | undefined = entry;
    while (at !== undefined && !seen.has(at.id)) {
      seen.add(at.id);
      if (at.lookup === "search" || searchedBefore(at)) return true;
      at = at.followedFrom === null ? undefined : byId.get(at.followedFrom);
    }
    return false;
  };
  return entries.map((entry) => {
    const lead = leadCovers(entry);
    const exposure = searchedBefore(entry);
    const chain = chainReachesSearch(entry);
    const credit = (searched: boolean): Credit =>
      lead ? "lead" : searched ? "search" : "other";
    return {
      id: entry.id,
      agent: entry.agent,
      touchesGold: entry.touchesGold,
      byExposure: credit(exposure),
      byChain: credit(chain),
      bothLeadAndSearch: lead && (exposure || chain),
    };
  });
};

/**
 * The trigger for option C over one phase's attributed entries by family: the families where at
 * least 15% of gold-touching entries are credited to search alone under either attribution.
 */
export const searchShareByFamily = (
  attributed: ReadonlyArray<
    ReturnType<typeof attributeEntries>[number] & { readonly family: string }
  >,
) => {
  const families = new Map<string, { touching: number; search: number }>();
  for (const entry of attributed) {
    if (!entry.touchesGold) continue;
    const held = families.get(entry.family) ?? { touching: 0, search: 0 };
    held.touching++;
    if (entry.byExposure === "search" || entry.byChain === "search")
      held.search++;
    families.set(entry.family, held);
  }
  return [...families.entries()].map(([family, counts]) => ({
    family,
    ...counts,
    share: counts.touching === 0 ? 0 : counts.search / counts.touching,
  }));
};

export const SEARCH_SHARE = 0.15;
export const FAMILIES = 15;

/** Option C's trigger: the share holds on at least half of the families, in A and A′ alike. */
export const ft17Trigger = (
  a: ReturnType<typeof searchShareByFamily>,
  a2: ReturnType<typeof searchShareByFamily>,
) => {
  const hits = (rows: ReturnType<typeof searchShareByFamily>) =>
    rows.filter((row) => row.share >= SEARCH_SHARE).length;
  const needed = Math.ceil(FAMILIES / 2);
  return {
    familiesA: hits(a),
    familiesA2: hits(a2),
    needed,
    fires: hits(a) >= needed && hits(a2) >= needed,
  };
};
