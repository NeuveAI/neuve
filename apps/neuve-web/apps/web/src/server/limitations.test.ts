// Why (the owner, 23 October 2026): the harness now writes every reader-facing limitation without
// internal codes (packages/harness/src/reader-text.ts), but the BFF added lines of its own to the
// batch's "Recorded limitations": "Records holds no lane for b1.u3, so it is in no lane here" and
// "review of b1.u3 could not be read: its citations do not decode (citations.b1.r3: Invalid
// input)". They name the storage layer, a unit by its local ID, and decoder text a reader can't act
// on. Nothing else catches it: every check passes and the line reads fine to whoever wrote it. This
// builds an overview from a packet holding what records-core discloses when stored content does
// not read (shaped as its read model writes it), plus a unit Records holds no lane for, and fails on
// any internal ID, decoder text or storage name in the limitations. The patterns are the harness
// guard's (packages/harness/tests/reader-text.test.ts) and the desk's `LOCAL_ID`.
import { expect, test } from "bun:test"
import type { PublishedPackets } from "@neuve/records-core"

import { overviewData } from "./projection"
import type { PacketContext } from "./projection"

/** Internal IDs a reader can't interpret, by what they are (the harness guard's patterns). */
const INTERNAL_IDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["milestone code", /\bM\d+\b/g],
  [
    "decision number",
    /\((?:[^()]*[,;]\s*)?\d+\.\d+[a-z]?(?:\s*[,;][^()]*)?\)/g,
  ],
  ["entry handle", /\b[a-z]\d+\.[a-z]?\d+\b/g],
  ["ledger entry", /\be\d+\b/g],
  ["hunk handle", /\bh(?:[0-9a-f]{7,}|\d+)\b/g],
  ["scope handle", /\bscope:S\d|\bS\d+\.\d+\b/g],
  ["record ID", /\b[0-9A-HJKMNP-TV-Z]{26}\b/g],
  // What the decoder and the store say, which belongs in the server log.
  ["storage name", /\bRecords\b|\bcomputation:|\bblob\b|\bmanifest\b/g],
  ["decoder text", /\bdecode|Invalid input|\bschema\b/gi],
]

const internalIdsIn = (text: string) =>
  INTERNAL_IDS.flatMap(([what, pattern]) =>
    [...text.matchAll(pattern)].map((match) => `${what}: ${match[0]}`)
  )

const CITATIONS = { cited: [], resolved: 0, unresolved: 0 }

const judgement = (unitId: string, lane: string | null) => ({
  unitId,
  cycleId: null,
  lane,
  assessmentEventId: null,
  assessed: lane !== null,
  needs: "a-disposition",
  closed: false,
  closing: [],
  context: [],
  standing: null,
})

const unit = (
  local: string,
  title: string | undefined,
  lane: string | null
) => ({
  local,
  unitId: `01JZ00000000000000000000${local.slice(-2).toUpperCase()}`,
  recorded:
    title === undefined
      ? undefined
      : { payload: { title, ownedRanges: [] }, attribution: {} },
  assessment: undefined,
  content: {},
  references: [],
  referenceDetails: {},
  comments: [],
  disposition: undefined,
  judgement: judgement(local, lane),
  citations: CITATIONS,
  // Records gives every unit its checkpoints (11.16).
  checkpoints: [],
  proofCurrency: {},
})

/** What records-core's read model discloses, as it words `what` and `issue`. */
const UNDECODED: ReadonlyArray<PublishedPackets.Undecoded> = [
  {
    what: "manifest",
    ref: "blob:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    issue: "the manifest blob is corrupt (sha256 mismatch)",
    part: "manifest",
  },
  {
    what: "assembled batch of b1",
    ref: "computation:assemble.batch:01JZ0000000000000000000A01",
    issue:
      "does not decode as today's assembled batch (units.0.owned: Invalid input); its citations and references are read loosely",
    part: "assembled-batch",
    batch: "b1",
  },
  {
    what: "batch digest of b1",
    ref: "computation:assemble.digest:01JZ0000000000000000000A02",
    issue: "its output was pruned",
    part: "batch-digest",
    batch: "b1",
  },
  {
    what: "review of b1.u3",
    ref: "computation:dispose:01JZ0000000000000000000A03",
    issue: "its citations do not decode (citations.b1.r3: Invalid input)",
    part: "dispose",
    batch: "b1",
    unit: "b1.u3",
  },
  {
    what: "guided of b1.u2",
    ref: "computation:dispose.guided:01JZ0000000000000000000A04",
    issue: "its output blob is missing from this store",
    part: "guided",
    batch: "b1",
    unit: "b1.u2",
  },
  // Another batch's content: not this batch's limitation.
  {
    what: "facts of b2.u1",
    ref: "computation:dispose.facts:01JZ0000000000000000000A05",
    issue: "its output blob is corrupt (sha256 mismatch)",
    part: "facts",
    batch: "b2",
    unit: "b2.u1",
  },
]

const limitationsOf = (
  undecoded: ReadonlyArray<PublishedPackets.Undecoded>
) => {
  const batch = {
    local: "b1",
    batchId: "01JZ0000000000000000000B01",
    recorded: undefined,
    // The limitations show with the batch digest's briefing.
    digest: {
      digest: "The batch moves the revocation check ahead of the cache.",
      limitations: [],
      uncertainty: [],
    },
    digestCitations: CITATIONS,
    assembled: undefined,
    units: [
      unit("b1.u1", "The revocation check", "agentic"),
      unit("b1.u2", "Token refresh", "human-required"),
      // A unit Records holds no record of, so no title and no lane.
      unit("b1.u3", undefined, null),
    ],
  } as unknown as PacketContext["batch"]
  const data = overviewData({
    repo: "repo",
    range: {
      baseRef: "refs/heads/main",
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
    },
    packet: { batches: [batch], gaps: [], undecoded },
    batch,
  } as unknown as PacketContext)
  return data.contextualBriefing?.limitations ?? []
}

test("the guard sees the lines the BFF used to write", () => {
  expect(
    internalIdsIn("Records holds no lane for b1.u3, so it is in no lane here")
  ).not.toEqual([])
  expect(
    internalIdsIn(
      "review of b1.u3 could not be read: its citations do not decode (citations.b1.r3: Invalid input)"
    )
  ).not.toEqual([])
})

test("the batch's added limitations name units by title, with no internal IDs or decoder text", () => {
  const limitations = limitationsOf(UNDECODED)
  expect(
    limitations.flatMap((text) => {
      const found = internalIdsIn(text)
      return found.length === 0 ? [] : [{ text, found }]
    })
  ).toEqual([])
  for (const item of UNDECODED)
    for (const line of limitations) {
      expect(line).not.toContain(item.what)
      expect(line).not.toContain(item.issue)
    }
  expect(limitations).toEqual([
    "A unit hasn't been placed in a review lane yet, so it isn't counted in any review lane.",
    "Part of this batch couldn't be read, so some of it may not be shown.",
    "Some of this batch's context couldn't be read, so some of its links and context references may not be shown.",
    "The batch digest couldn't be read, so it isn't shown.",
    "The agent's review of a unit couldn't be read in full, so some of its links may not be shown.",
    "The Guided stop for Token refresh couldn't be read, so it isn't shown.",
  ])
})

test("a batch whose content all reads adds only the unlaned unit", () => {
  expect(limitationsOf([])).toEqual([
    "A unit hasn't been placed in a review lane yet, so it isn't counted in any review lane.",
  ])
})
