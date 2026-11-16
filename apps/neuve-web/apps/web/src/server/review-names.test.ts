// Admission names must survive Records reads and frame both review pages. Older cycles have none.
import { afterAll, expect, test } from "bun:test"
import { Log, mintUlid, sha256Hex } from "@neuve/records-core"
import type { PublishedPackets } from "@neuve/records-core"
import { RecordEvent } from "@neuve/records-schema"
import {
  actor,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runExisting,
  runOn,
} from "../../../../../../packages/records-core/tests/support"
import { rangeOf } from "./desk.server"
import { deskBatchContext, overviewData } from "./projection"
import type { PacketContext } from "./projection"

afterAll(removeTemporaryDirectories)
const range = {
  baseRef: "a".repeat(40),
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
}
const display = {
  project: "limits",
  branch: "feature/size-limits",
  base: "main",
}
const batch: PublishedPackets.PacketBatch = {
  local: "b1",
  batchId: mintUlid(),
  recorded: undefined,
  digest: undefined,
  digestCitations: { cited: [], resolved: 0, unresolved: 0 },
  assembled: undefined,
  units: [],
}
const packet: PacketContext["packet"] = {
  eventId: mintUlid(),
  supersedes: null,
  requestedPacket: mintUlid(),
  manifest: "c".repeat(64),
  complete: true,
  counts: {
    batches: 1,
    units: 0,
    contextReferences: 0,
    assessments: 0,
    deliveries: 0,
    dispositions: 0,
    comments: 0,
    gaps: 0,
  },
  batches: [batch],
  gaps: [],
  undecoded: [],
}

test("recorded admission names frame the overview and desk; legacy cycles keep short commit ranges", async () => {
  const at = freshLocation()
  for (const names of [
    undefined,
    display,
    { project: "limits", base: "main" },
    { project: "limits", base: range.baseOid },
    { project: "limits", branch: `feature/${"a".repeat(512)}`, base: "main" },
  ]) {
    const cycleId = mintUlid()
    const events = [
      envelope(
        "cycle.opened@1",
        `cycle:${cycleId}`,
        actor,
        { cycleId, range },
        {}
      ),
    ]
    if (names)
      events.push(
        envelope(
          "review.origin-recorded@1",
          `origin:${cycleId}`,
          actor,
          { cycleId, range },
          {
            identity: sha256Hex(cycleId),
            origin: {
              kind: "channel",
              host: "fixture",
              channel: "fixture",
              chat: 0,
              items: [],
              display: names,
            },
          }
        )
      )
    await runOn(at, Log.append(events.map((value) => RecordEvent.parse(value))))
    const loaded = await runExisting(at, rangeOf(cycleId))
    expect(loaded).toEqual({ ...range, ...(names ? { display: names } : {}) })
    if (!loaded) throw new Error("Missing fixture cycle")
    const context = { repo: "limits-origin", range: loaded, batch, packet }
    const expected = {
      repo: names ? "limits" : "limits-origin",
      branch:
        names && "branch" in names
          ? names.branch
          : names && names.base === "main"
            ? "main..bbbbbbb"
            : "aaaaaaa..bbbbbbb",
      revision: range.headOid,
    }
    expect(deskBatchContext(context)).toMatchObject(expected)
    expect(overviewData(context)).toMatchObject(expected)
  }
})

test("long legacy base refs keep their names", () => {
  const baseRef = `refs/heads/${"a".repeat(80)}`
  expect(
    deskBatchContext({
      repo: "limits",
      range: { ...range, baseRef },
      batch,
      packet,
    }).branch
  ).toBe(`${baseRef}..bbbbbbb`)
})
