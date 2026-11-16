import type { ReviewsData } from "@workspace/ui/neuve/types"

/*
 * The Neuve repository's own reviews as Records held them on 25 October 2026,
 * read through the Reviews page's BFF load (apps/web/src/server/reviews.server.ts):
 * the first page of every review, the second page, and the "Waiting on you"
 * filter. Stories pin "now" and the time zone so the day groups read the same
 * everywhere.
 */

/** The moment the fixtures were read, for the day groups. */
export const REVIEWS_NOW = new Date("2026-10-25T15:00:00.000Z")
export const REVIEWS_TIME_ZONE = "Europe/Stockholm"

export const realReviews: ReviewsData = {
  repo: "neuve",
  reviews: [
    {
      id: "01M5R6M78BP7E31R4MQVP10MCS",
      title: "Normalize store usage and validate cache declaration receipts",
      range: "cc3c570..5526c03",
      at: "2026-10-25T12:37:10.955Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 3,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 9,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "changes-requested",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SGVM5D0009VK6S90E4YD50",
          title:
            "Normalize store usage and validate cache declaration receipts",
          unitCount: 6,
          needYou: 0,
        },
        {
          id: "01M5SGVM5D000FFJ6WC2RBY29V",
          title: "Execute cache declarations through the Graph boundary",
          unitCount: 3,
          needYou: 0,
        },
        {
          id: "01M5SGVM5D000737H7Y2Z5S2BJ",
          title:
            "Keep validated engine copies active without defeating identity reuse",
          unitCount: 4,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5QECBY5ZG57126W5VA5JFS1",
      title: "Shared preparation executable and validated service receipts",
      range: "d000a78..7ea8031",
      at: "2026-10-25T12:33:44.003Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 8,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SGNG2J0002TG6J29F5H8DC",
          title: "Shared preparation executable and validated service receipts",
          unitCount: 8,
          needYou: 1,
        },
        {
          id: "01M5SGNG2J0007C4D4EMC7J75Z",
          title: "Preparation CPU selection and once-only search attribution",
          unitCount: 3,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5S0F6J51FN2M81ERXMNP81P",
      title:
        "Web integration tests run independently of the owner's home and configuration",
      range: "a3a7bd3..08443d4",
      at: "2026-10-25T12:30:29.800Z",
      state: "completed",
      lanes: [
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 4,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SGFTGN000E8CRD5XEFEQK8",
          title:
            "Web integration tests run independently of the owner's home and configuration",
          unitCount: 6,
          needYou: 2,
        },
      ],
    },
    {
      id: "01M5S01N7EP7Q5MQEQ0WC49JC5",
      title:
        "Checkpoint pins show once per section and briefing rows reach visible pins",
      range: "4657f6a..ff872ff",
      at: "2026-10-25T12:27:18.478Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 2,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 7,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SG5JZ4000CAVD6SAMRD229",
          title:
            "Checkpoint pins show once per section and briefing rows reach visible pins",
          unitCount: 10,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5RZN1TR35C90MX8N29DWXAM",
      title:
        "Hybrid model calls survive idle gaps and failed or interrupted processes",
      range: "53956e6..db59b68",
      at: "2026-10-25T12:21:39.729Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 3,
        },
        {
          lane: "agentic-review",
          count: 5,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SG066J0003NRYP013W7FP9",
          title:
            "Hybrid model calls survive idle gaps and failed or interrupted processes",
          unitCount: 3,
          needYou: 0,
        },
        {
          id: "01M5SG066J0001VX8GM2M5ZQVK",
          title: "Limit Apple GPU encoder requests and match parity batching",
          unitCount: 3,
          needYou: 1,
        },
        {
          id: "01M5SG066J0004QWB005MM2T35",
          title: "Release Apple GPU worker caches and update encoder identity",
          unitCount: 3,
          needYou: 2,
        },
      ],
    },
    {
      id: "01M5R46N2743K9CFRTN7Y030YC",
      title: "Stage hybrid encoding and safely manage model residency",
      range: "3a71658..f446ab0",
      at: "2026-10-24T23:52:17.210Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 3,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 11,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5R4S80Y000ATWP1C5KZRXYR",
          title: "Stage hybrid encoding and safely manage model residency",
          unitCount: 10,
          needYou: 3,
        },
        {
          id: "01M5R4S80Y0006V31P1182H30P",
          title:
            "Pause hybrid preparation under resource pressure and preserve completed work",
          unitCount: 5,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5NQKZ2N396648FNQ5G4BEBC",
      title: "Bounded callers use Graph's queue and disclose deadline fallback",
      range: "ab20edd..9ddc491",
      at: "2026-10-24T01:23:55.088Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 8,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 23,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5NQKZ8V000AF4KA9CP5JRQ2",
          title:
            "Bounded callers use Graph's queue and disclose deadline fallback",
          unitCount: 25,
          needYou: 2,
        },
        {
          id: "01M5NQKZ8V0008HP9A173FT8Z5",
          title: "Concurrent Graph reads expose validated service receipts",
          unitCount: 6,
          needYou: 0,
        },
        {
          id: "01M5NQKZ8V0002JC4CYKETC4E0",
          title: "Harness spans identify shared CPU estimates",
          unitCount: 1,
          needYou: 0,
        },
        {
          id: "01M5NQKZ8V000AE6BC799WCGGJ",
          title: "Engine-copy path test respects resolved repository roots",
          unitCount: 1,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5NKPJ169VCJFYYPXC911B24",
      title:
        "Share the store's Graph cache while keeping mutable clones separate",
      range: "66f8836..ab20edd",
      at: "2026-10-24T00:16:35.875Z",
      state: "timed-out",
      lanes: [
        {
          lane: "human-suggested",
          count: 71,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5NKPJ810006TRPC1FFC5E6B",
          title:
            "Share the store's Graph cache while keeping mutable clones separate",
          unitCount: 19,
          needYou: 19,
        },
        {
          id: "01M5NKPJ8100058WEP3HWY0PXS",
          title:
            "Engine calls converge on one safe build identity, path and environment",
          unitCount: 21,
          needYou: 21,
        },
        {
          id: "01M5NKPJ81000A2R7SGSBF7ZZW",
          title:
            "Validate bounded-store receipts and preserve their usage measurements",
          unitCount: 20,
          needYou: 20,
        },
        {
          id: "01M5NKPJ810000FPM5FH3K4XFX",
          title: "The worker declares the full set of Graph bases still needed",
          unitCount: 9,
          needYou: 9,
        },
        {
          id: "01M5NKPJ81000DTVYHTJ7RTBFT",
          title: "Parser formatting only",
          unitCount: 2,
          needYou: 2,
        },
      ],
    },
    {
      id: "01M5NCCKRC6XHFP246BVQW7B6N",
      title: "Ticket-change activities identify both compared texts",
      range: "a6228f4..ca26d01",
      at: "2026-10-23T22:28:03.338Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 2,
        },
        {
          lane: "human-suggested",
          count: 4,
        },
        {
          lane: "agentic-review",
          count: 20,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5NCCNN4000DWS6FGJNB27NN",
          title: "Ticket-change activities identify both compared texts",
          unitCount: 1,
          needYou: 0,
        },
        {
          id: "01M5NCCNN4000B70VYKFRQ7S9Q",
          title:
            "Ticket-change judgements receive safe title and heading context",
          unitCount: 3,
          needYou: 1,
        },
        {
          id: "01M5NCCNN4000888K30N6QW2N5",
          title: "Kept refreshes retain their originally stored source",
          unitCount: 6,
          needYou: 3,
        },
        {
          id: "01M5NCCNN4000DWN847BXCQFCG",
          title: "Every untied ticket item survives as a Missing checkpoint",
          unitCount: 5,
          needYou: 1,
        },
        {
          id: "01M5NCCNN40003HY63P3YWEWYH",
          title: "Test-run exemptions require an explicit no with a reason",
          unitCount: 11,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5NB1XJB4CBYZZGKP9F5H5TT",
      title:
        "Graph measures survive attempt completion without losing active-attempt exports",
      range: "b870e01..3fefda1",
      at: "2026-10-23T21:41:35.896Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 4,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 7,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5NB1Y1M0004DQ8E0RNH33YX",
          title:
            "Graph measures survive attempt completion without losing active-attempt exports",
          unitCount: 10,
          needYou: 4,
        },
        {
          id: "01M5NB1Y1M000AJ7K22E9BC55J",
          title: "Unfinished base preparations keep the worker alive",
          unitCount: 3,
          needYou: 2,
        },
      ],
    },
  ],
  filter: "all",
  page: 1,
  pageSize: 10,
  total: 16,
  counts: {
    all: 16,
    waiting: 14,
  },
  waiting: {
    units: 235,
    reviews: 14,
    nextUnitId: "01M5SGVM5D00070PB0VTPGXJF6",
  },
  newestHead: "5526c035c1e8476d8a005088543c45247ca07980",
}

export const realReviewsPage2: ReviewsData = {
  repo: "neuve",
  reviews: [
    {
      id: "01M5N06ENZE5CM1MJSZ63YY4YM",
      title: "Prioritize waited-on searches while background leads continue",
      range: "0d11df6..0f51895",
      at: "2026-10-23T18:35:08.127Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 5,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 11,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5N06EWJ0001TJXQRTZVKSRF",
          title:
            "Prioritize waited-on searches while background leads continue",
          unitCount: 14,
          needYou: 5,
        },
        {
          id: "01M5N06EWJ00059ZPC8FJ7KRJE",
          title: "Start the Graph run deadline only after slot acquisition",
          unitCount: 2,
          needYou: 1,
        },
        {
          id: "01M5N06EWJ0006A53A86V6VVKT",
          title: "Reserve commit job time for the final Graph search",
          unitCount: 1,
          needYou: 1,
        },
        {
          id: "01M5N06EWJ000CF5FMH8QGH837",
          title:
            "Manifest identity includes the fallback retriever's configuration",
          unitCount: 1,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5MV6TEG72B3KMD5E32Q85XH",
      title:
        "Commit preparation isolates Graph files and preserves reusable leads",
      range: "6b71a9b..522ea22",
      at: "2026-10-23T17:05:45.411Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 8,
        },
        {
          lane: "agentic-review",
          count: 6,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5MV6TNA000EXR2AFFXD0RZR",
          title:
            "Commit preparation isolates Graph files and preserves reusable leads",
          unitCount: 5,
          needYou: 2,
        },
        {
          id: "01M5MV6TNA0001SN9PVN067HQW",
          title:
            "Commit preparation reserves time for its final search and base preparation",
          unitCount: 1,
          needYou: 1,
        },
        {
          id: "01M5MV6TNA000FW1ZZ3S0S3TE1",
          title:
            "Graph busy time counts overlapping waits and searches only once",
          unitCount: 5,
          needYou: 3,
        },
        {
          id: "01M5MV6TNA0004DF5P1GF4WSJ5",
          title: "Engine startup cannot escape interruption cleanup",
          unitCount: 2,
          needYou: 2,
        },
        {
          id: "01M5MV6TNA00014FZHXAMJQJDV",
          title: "Absent Graph stats remain exactly empty",
          unitCount: 1,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5MRZHHKXN8PXJEH2FCABVJM",
      title: "Overview uses review decisions, not pending assessments",
      range: "6b1b971..e00b80f",
      at: "2026-10-23T16:27:31.081Z",
      state: "completed",
      lanes: [
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 25,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5MRZHJN000218QGQ5JJYDH0",
          title: "Overview uses review decisions, not pending assessments",
          unitCount: 13,
          needYou: 1,
        },
        {
          id: "01M5MRZHJN0009Y0QQ8CYQ31MH",
          title:
            "Judgment rows hide internal metrics and retain conflict signals",
          unitCount: 11,
          needYou: 1,
        },
        {
          id: "01M5MRZHJN00062VPBND65ACG8",
          title: "Overview hero drops advisory scope",
          unitCount: 3,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5M1HBKPF9C0BAHC3QNV1Q1F",
      title:
        "Overview reflects decisions, standing reviews and verification by unit",
      range: "3c879a8..cfdee96",
      at: "2026-10-23T09:41:14.719Z",
      state: "timed-out",
      lanes: [
        {
          lane: "human-suggested",
          count: 121,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5M1KQKA0003FSQEX003VCQY",
          title:
            "Overview reflects decisions, standing reviews and verification by unit",
          unitCount: 43,
          needYou: 43,
        },
        {
          id: "01M5M1KQKA000DMBE8KHQPS8YD",
          title: "Offer another review only for work beyond the reviewed head",
          unitCount: 6,
          needYou: 6,
        },
        {
          id: "01M5M1KQKA00058S761SQ886VN",
          title: "Return from margin cards and threads to their marker group",
          unitCount: 25,
          needYou: 25,
        },
        {
          id: "01M5M1KQKA0004VH8X8K8WM5HA",
          title:
            "Source sheets open in view without moving the underlying page",
          unitCount: 2,
          needYou: 2,
        },
        {
          id: "01M5M1KQKA0007PR814NK3MNCH",
          title: "Gap expansion focuses removed lines at the end of a stretch",
          unitCount: 7,
          needYou: 7,
        },
        {
          id: "01M5M1KQKA0008MR1V3TFSJNAC",
          title: "Unit feedback uses an explicit Give feedback affordance",
          unitCount: 5,
          needYou: 5,
        },
        {
          id: "01M5M1KQKA0003XC1RX04VVDQ5",
          title:
            "Publish only checked context and trim unchecked preloaded leads first",
          unitCount: 32,
          needYou: 32,
        },
        {
          id: "01M5M1KQKA000FH7ENFMVH0SDH",
          title: "Reposition a design-canvas frame",
          unitCount: 1,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5J6XYH3042Q1WXCMB0GKFH5",
      title: "Offer line commenting only within the unit's owned ranges",
      range: "c0c47ce..5fa1ba9",
      at: "2026-10-22T16:34:17.226Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 7,
        },
        {
          lane: "agentic-review",
          count: 15,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "changes-requested",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5J6XYHD000FY31RGWGHFSC5",
          title: "Offer line commenting only within the unit's owned ranges",
          unitCount: 22,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5J0R7915H9X5CP89J924F4J",
      title:
        "Freeze committed-base versus unapproved current-batch validation baseline",
      range: "d7eaae9..ab47511",
      at: "2026-10-22T14:43:08.174Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 3,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5J0R79Y0003BERD4BZ8K0E5",
          title:
            "Freeze committed-base versus unapproved current-batch validation baseline",
          unitCount: 4,
          needYou: 0,
        },
      ],
    },
  ],
  filter: "all",
  page: 2,
  pageSize: 10,
  total: 16,
  counts: {
    all: 16,
    waiting: 14,
  },
  waiting: {
    units: 235,
    reviews: 14,
    nextUnitId: "01M5SGVM5D00070PB0VTPGXJF6",
  },
  newestHead: "5526c035c1e8476d8a005088543c45247ca07980",
}

export const realReviewsWaiting: ReviewsData = {
  repo: "neuve",
  reviews: [
    {
      id: "01M5R6M78BP7E31R4MQVP10MCS",
      title: "Normalize store usage and validate cache declaration receipts",
      range: "cc3c570..5526c03",
      at: "2026-10-25T12:37:10.955Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 3,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 9,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "changes-requested",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SGVM5D0009VK6S90E4YD50",
          title:
            "Normalize store usage and validate cache declaration receipts",
          unitCount: 6,
          needYou: 0,
        },
        {
          id: "01M5SGVM5D000FFJ6WC2RBY29V",
          title: "Execute cache declarations through the Graph boundary",
          unitCount: 3,
          needYou: 0,
        },
        {
          id: "01M5SGVM5D000737H7Y2Z5S2BJ",
          title:
            "Keep validated engine copies active without defeating identity reuse",
          unitCount: 4,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5QECBY5ZG57126W5VA5JFS1",
      title: "Shared preparation executable and validated service receipts",
      range: "d000a78..7ea8031",
      at: "2026-10-25T12:33:44.003Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 8,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SGNG2J0002TG6J29F5H8DC",
          title: "Shared preparation executable and validated service receipts",
          unitCount: 8,
          needYou: 1,
        },
        {
          id: "01M5SGNG2J0007C4D4EMC7J75Z",
          title: "Preparation CPU selection and once-only search attribution",
          unitCount: 3,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5S0F6J51FN2M81ERXMNP81P",
      title:
        "Web integration tests run independently of the owner's home and configuration",
      range: "a3a7bd3..08443d4",
      at: "2026-10-25T12:30:29.800Z",
      state: "completed",
      lanes: [
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 4,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SGFTGN000E8CRD5XEFEQK8",
          title:
            "Web integration tests run independently of the owner's home and configuration",
          unitCount: 6,
          needYou: 2,
        },
      ],
    },
    {
      id: "01M5S01N7EP7Q5MQEQ0WC49JC5",
      title:
        "Checkpoint pins show once per section and briefing rows reach visible pins",
      range: "4657f6a..ff872ff",
      at: "2026-10-25T12:27:18.478Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 2,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 7,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SG5JZ4000CAVD6SAMRD229",
          title:
            "Checkpoint pins show once per section and briefing rows reach visible pins",
          unitCount: 10,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5RZN1TR35C90MX8N29DWXAM",
      title:
        "Hybrid model calls survive idle gaps and failed or interrupted processes",
      range: "53956e6..db59b68",
      at: "2026-10-25T12:21:39.729Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 1,
        },
        {
          lane: "human-suggested",
          count: 3,
        },
        {
          lane: "agentic-review",
          count: 5,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5SG066J0003NRYP013W7FP9",
          title:
            "Hybrid model calls survive idle gaps and failed or interrupted processes",
          unitCount: 3,
          needYou: 0,
        },
        {
          id: "01M5SG066J0001VX8GM2M5ZQVK",
          title: "Limit Apple GPU encoder requests and match parity batching",
          unitCount: 3,
          needYou: 1,
        },
        {
          id: "01M5SG066J0004QWB005MM2T35",
          title: "Release Apple GPU worker caches and update encoder identity",
          unitCount: 3,
          needYou: 2,
        },
      ],
    },
    {
      id: "01M5R46N2743K9CFRTN7Y030YC",
      title: "Stage hybrid encoding and safely manage model residency",
      range: "3a71658..f446ab0",
      at: "2026-10-24T23:52:17.210Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 3,
        },
        {
          lane: "human-suggested",
          count: 1,
        },
        {
          lane: "agentic-review",
          count: 11,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5R4S80Y000ATWP1C5KZRXYR",
          title: "Stage hybrid encoding and safely manage model residency",
          unitCount: 10,
          needYou: 3,
        },
        {
          id: "01M5R4S80Y0006V31P1182H30P",
          title:
            "Pause hybrid preparation under resource pressure and preserve completed work",
          unitCount: 5,
          needYou: 1,
        },
      ],
    },
    {
      id: "01M5NQKZ2N396648FNQ5G4BEBC",
      title: "Bounded callers use Graph's queue and disclose deadline fallback",
      range: "ab20edd..9ddc491",
      at: "2026-10-24T01:23:55.088Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 8,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 23,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "approved",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5NQKZ8V000AF4KA9CP5JRQ2",
          title:
            "Bounded callers use Graph's queue and disclose deadline fallback",
          unitCount: 25,
          needYou: 2,
        },
        {
          id: "01M5NQKZ8V0008HP9A173FT8Z5",
          title: "Concurrent Graph reads expose validated service receipts",
          unitCount: 6,
          needYou: 0,
        },
        {
          id: "01M5NQKZ8V0002JC4CYKETC4E0",
          title: "Harness spans identify shared CPU estimates",
          unitCount: 1,
          needYou: 0,
        },
        {
          id: "01M5NQKZ8V000AE6BC799WCGGJ",
          title: "Engine-copy path test respects resolved repository roots",
          unitCount: 1,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5NKPJ169VCJFYYPXC911B24",
      title:
        "Share the store's Graph cache while keeping mutable clones separate",
      range: "66f8836..ab20edd",
      at: "2026-10-24T00:16:35.875Z",
      state: "timed-out",
      lanes: [
        {
          lane: "human-suggested",
          count: 71,
        },
      ],
      gate: [
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5NKPJ810006TRPC1FFC5E6B",
          title:
            "Share the store's Graph cache while keeping mutable clones separate",
          unitCount: 19,
          needYou: 19,
        },
        {
          id: "01M5NKPJ8100058WEP3HWY0PXS",
          title:
            "Engine calls converge on one safe build identity, path and environment",
          unitCount: 21,
          needYou: 21,
        },
        {
          id: "01M5NKPJ81000A2R7SGSBF7ZZW",
          title:
            "Validate bounded-store receipts and preserve their usage measurements",
          unitCount: 20,
          needYou: 20,
        },
        {
          id: "01M5NKPJ810000FPM5FH3K4XFX",
          title: "The worker declares the full set of Graph bases still needed",
          unitCount: 9,
          needYou: 9,
        },
        {
          id: "01M5NKPJ81000DTVYHTJ7RTBFT",
          title: "Parser formatting only",
          unitCount: 2,
          needYou: 2,
        },
      ],
    },
    {
      id: "01M5NCCKRC6XHFP246BVQW7B6N",
      title: "Ticket-change activities identify both compared texts",
      range: "a6228f4..ca26d01",
      at: "2026-10-23T22:28:03.338Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 2,
        },
        {
          lane: "human-suggested",
          count: 4,
        },
        {
          lane: "agentic-review",
          count: 20,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "changes-requested",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: true,
      batches: [
        {
          id: "01M5NCCNN4000DWS6FGJNB27NN",
          title: "Ticket-change activities identify both compared texts",
          unitCount: 1,
          needYou: 0,
        },
        {
          id: "01M5NCCNN4000B70VYKFRQ7S9Q",
          title:
            "Ticket-change judgements receive safe title and heading context",
          unitCount: 3,
          needYou: 1,
        },
        {
          id: "01M5NCCNN4000888K30N6QW2N5",
          title: "Kept refreshes retain their originally stored source",
          unitCount: 6,
          needYou: 3,
        },
        {
          id: "01M5NCCNN4000DWN847BXCQFCG",
          title: "Every untied ticket item survives as a Missing checkpoint",
          unitCount: 5,
          needYou: 1,
        },
        {
          id: "01M5NCCNN40003HY63P3YWEWYH",
          title: "Test-run exemptions require an explicit no with a reason",
          unitCount: 11,
          needYou: 0,
        },
      ],
    },
    {
      id: "01M5NB1XJB4CBYZZGKP9F5H5TT",
      title:
        "Graph measures survive attempt completion without losing active-attempt exports",
      range: "b870e01..3fefda1",
      at: "2026-10-23T21:41:35.896Z",
      state: "completed",
      lanes: [
        {
          lane: "human-required",
          count: 4,
        },
        {
          lane: "human-suggested",
          count: 2,
        },
        {
          lane: "agentic-review",
          count: 7,
        },
      ],
      gate: [
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-required",
          mark: "waiting",
        },
        {
          lane: "human-suggested",
          mark: "waiting",
        },
      ],
      feedback: false,
      batches: [
        {
          id: "01M5NB1Y1M0004DQ8E0RNH33YX",
          title:
            "Graph measures survive attempt completion without losing active-attempt exports",
          unitCount: 10,
          needYou: 4,
        },
        {
          id: "01M5NB1Y1M000AJ7K22E9BC55J",
          title: "Unfinished base preparations keep the worker alive",
          unitCount: 3,
          needYou: 2,
        },
      ],
    },
  ],
  filter: "waiting",
  page: 1,
  pageSize: 10,
  total: 14,
  counts: {
    all: 16,
    waiting: 14,
  },
  waiting: {
    units: 235,
    reviews: 14,
    nextUnitId: "01M5SGVM5D00070PB0VTPGXJF6",
  },
  newestHead: "5526c035c1e8476d8a005088543c45247ca07980",
}
