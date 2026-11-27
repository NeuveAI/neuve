import { Frame } from "../src/frame.ts";
import { ReviewMap } from "../src/review-map.ts";
import { Finding } from "../src/find-schema.ts";
import type { StoredFinding } from "../src/historical-find.ts";
import {
  ManifestHunk,
  RangeManifest,
  defaultManifestSettings,
  frontSettings,
} from "../src/manifest.ts";
import type { RangeView } from "../src/pipeline.ts";

export const frame = Frame.parse({
  goal: "Reject invalid input",
  stratum: "nothing",
  sourceIds: [],
  doneWhen: [
    {
      id: "D1",
      text: "Invalid input is refused",
      basis: "gathered",
      candidateId: null,
      sectionId: null,
    },
  ],
  source: "fallback",
  gaps: [],
  inputs: {
    sectionsInlined: 0,
    sectionsListed: 0,
    commitsShown: 1,
    commitsTotal: 1,
  },
});
export const hunk = ManifestHunk.parse({
  hunkId: "h1",
  kind: "text",
  path: "new.ts",
  oldPath: "old.ts",
  newPath: "new.ts",
  oldOid: "1".repeat(40),
  newOid: "2".repeat(40),
  status: "renamed",
  oldMode: "100644",
  newMode: "100644",
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 3,
  added: 1,
  deleted: 1,
  text: "@@ -1,3 +1,3 @@\n context\n-old\n+new\n context",
  textSha256: "test",
  enclosing: null,
  query: null,
  ownedRanges: [
    { side: "new", startLine: 2, lineCount: 1 },
    { side: "old", startLine: 2, lineCount: 1 },
  ],
  qualifications: [],
  declared: [],
  countsTowardReviewLines: true,
  allowance: { tokens: 4000, exactShare: 4000, floored: false },
});
export const map = ReviewMap.parse({
  frame: "frame-key",
  source: "fallback",
  groups: [
    {
      id: "g1",
      label: "Input handling",
      why: "Reject invalid input",
      tier: "core",
      doneWhen: ["D1"],
      files: [{ path: "new.ts", placedBy: "map" }],
      hunkIds: ["h1"],
      changedLines: 2,
    },
  ],
  excluded: [],
  rolledUp: [],
  unlinkedDoneWhen: [],
  gaps: [],
});
export const finding = Finding.parse({
  claim: "Invalid input reaches the writer",
  kind: "defect",
  about: "code",
  signal: null,
  critical: false,
  anchors: [{ path: "new.ts", side: "new", startLine: 2, endLine: 2 }],
  doneWhen: "D1",
  evidence: ["h1"],
});
export const storedFinding = (id = "correctness.1"): StoredFinding => ({
  ...finding,
  id,
  lens: "correctness",
  hunkId: "h1",
  group: "g1",
});
export const view = (hunks = [hunk]): RangeView => ({
  manifest: RangeManifest.parse({
    range: {
      baseOid: "1".repeat(40),
      headOid: "2".repeat(40),
      mergeBase: "1".repeat(40),
      baseTree: "1".repeat(40),
      headTree: "2".repeat(40),
    },
    settings: frontSettings(defaultManifestSettings(200_000)),
    files: 1,
    reviewLines: 2,
    hunks,
    facts: [],
    declarations: { readers: [], gaps: [] },
    limitations: [],
  }),
  snapshot: undefined,
  head: {
    label: "head",
    commit: "2".repeat(40),
    tree: "2".repeat(40),
    entries: new Map(),
  },
  base: {
    label: "base",
    commit: "1".repeat(40),
    tree: "1".repeat(40),
    entries: new Map(),
  },
  hunks: new Map(hunks.map((h) => [h.hunkId, h])),
  commits: [],
  byPath: new Map(),
  searchFrequency: new Map(),
});
