import type {
  UnitHistoryLoader,
  UnitHistoryPage,
  UnitHistoryRecord,
} from "@workspace/ui/neuve/types"

/** Recorded history for one review unit (Records ledger snapshot through 4). */
const RECORDS: Array<UnitHistoryRecord> = [
  {
    id: "rec_01J9Z3K8Q2",
    sequence: 1,
    title: "Review unit prepared",
    actor: "Neuve records",
    origin: "Prepared from commit 7d1e0b4",
    occurredAt: "Oct 2, 09:14",
    recordedAt: "Oct 2, 09:14",
    cycleId: "cyc_7d1e0b4",
    summary: "Unit SHR-212 opened with 3 human-required hunks.",
  },
  {
    id: "rec_01J9Z3M1A7",
    sequence: 2,
    title: "Agent review attached",
    actor: "R1 · reviewer agent",
    origin: "Agentic review a3f9c2e",
    occurredAt: "Oct 2, 09:31",
    recordedAt: "Oct 2, 09:32",
    cycleId: "cyc_7d1e0b4",
    summary: "Flagged the session revoke path for a transaction check.",
  },
  {
    id: "rec_01J9Z4B0C3",
    sequence: 3,
    title: "Changes requested",
    actor: "Maya Chen",
    origin: "Review desk",
    occurredAt: "Oct 2, 10:05",
    recordedAt: "Oct 2, 10:05",
    cycleId: "cyc_7d1e0b4",
    summary: "Both writes should happen in one transaction.",
  },
  {
    id: "rec_01J9Z5D9E1",
    sequence: 4,
    title: "New commit observed",
    actor: "Neuve records",
    origin: "Branch observation",
    occurredAt: "Oct 2, 11:40",
    recordedAt: "Oct 2, 11:40",
    cycleId: null,
    summary: "Commit 9b2c41f landed on the branch after the request.",
  },
]

/** The first page the desk receives: two records, more after record 2. */
export const historyFirstPageFixture: UnitHistoryPage = {
  unitId: "shr-212-revoke-links",
  records: RECORDS.slice(0, 2),
  highWaterMark: 4,
  nextAfter: 2,
}

/** A unit with nothing retained at this snapshot. */
export const historyEmptyPageFixture: UnitHistoryPage = {
  unitId: "shr-212-revoke-links",
  records: [],
  highWaterMark: 0,
  nextAfter: null,
}

const FULL_RECORD = `{
  "id": "rec_01J9Z3K8Q2",
  "kind": "unit.prepared",
  "commit": "7d1e0b4",
  "references": ["SHR-212", "cyc_7d1e0b4"]
}`

/** A promise that never settles: the loader stays in its loading state. */
const pending = <T>() => new Promise<T>(() => undefined)

/**
 * Loader stubs for the history source. Each part either answers from the
 * fixture records, never answers (loading) or fails.
 */
export function historyLoaderFixture({
  page = "answers",
  record = "answers",
}: {
  page?: "answers" | "loading" | "fails"
  /** "fails-once": the first request fails, a retry answers. */
  record?: "answers" | "loading" | "fails" | "fails-once"
} = {}): UnitHistoryLoader {
  let recordRequests = 0
  return {
    page: ({ unitId, after, through }) =>
      page === "loading"
        ? pending()
        : page === "fails"
          ? Promise.reject(new Error("Records unavailable"))
          : Promise.resolve({
              unitId,
              records: RECORDS.filter(
                (entry) => entry.sequence > after && entry.sequence <= through
              ).slice(0, 2),
              highWaterMark: through,
              nextAfter: after + 2 < through ? after + 2 : null,
            }),
    record: () => {
      recordRequests++
      if (record === "loading") return pending()
      if (
        record === "fails" ||
        (record === "fails-once" && recordRequests === 1)
      )
        return Promise.reject(new Error("Record unavailable"))
      return Promise.resolve(FULL_RECORD)
    },
  }
}
