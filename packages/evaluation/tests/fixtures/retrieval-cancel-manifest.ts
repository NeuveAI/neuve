import { Manifest } from "../../src/retrieval-bench/manifest.ts";
export const cancellationManifest = Manifest.parse({
  schemaVersion: 1,
  benchmark: "neuve-m4-retrieval",
  slice: "B1",
  seed: "fixture",
  corpora: {
    neuve: {
      role: "primary",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rangeTarget: 1,
    },
    neuve_effect: {
      role: "secondary",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rangeTarget: 1,
    },
  },
  rules: {},
  realShare: {
    formula: "fixture",
    workingShare: 1,
    workingShareStatus: "fixture",
    windows: {
      opus: 1,
      sol: 1,
    },
    denominator: "fixture",
    minimum: 1,
    minimumStatus: "fixture",
  },
  leakage: {
    graphTunedFiles: [],
    graphTuningHeads: [],
    phase2Files: [],
    benchmarkPaths: [],
  },
  summary: {
    cases: 1,
    hunks: 1,
    excluded: {
      neuve: {},
      neuve_effect: {},
    },
    families: {
      neuve: {
        dev: 1,
        heldOut: 0,
      },
      neuve_effect: {
        dev: 1,
        heldOut: 0,
      },
    },
    strata: {},
    bySplit: {},
    hubs: {
      neuve: [],
      neuve_effect: [],
    },
    heldOutComparisons: {},
    dataDominated: [],
    quotas: {
      neuve: [],
      neuve_effect: [],
    },
    realShare: {
      opus: {
        min: 1,
        median: 1,
        max: 1,
        raisedToMinimum: 0,
      },
      sol: {
        min: 1,
        median: 1,
        max: 1,
        raisedToMinimum: 0,
      },
    },
  },
  families: [],
  cases: [
    {
      id: "cancel",
      repository: "neuve",
      kind: "direct",
      base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      commits: [],
      subjects: [],
      family: "cancel",
      split: "dev",
      strata: {
        changeType: "fix",
        size: "S",
        scopeSource: "none",
        area: "fixture",
      },
      changedLines: 1,
      reviewLines: 1,
      dataLines: 0,
      period: "2026-Q4",
      codeFiles: 1,
      scopeDocsAtBase: [],
      inRangeDocs: [],
      tunedFiles: [],
      phase2Files: [],
      graphTuningRange: false,
      leakageTags: [],
      hunks: [
        {
          id: "h-000000000001",
          path: "unit.ts",
          oldPath: "unit.ts",
          old: {
            start: 1,
            lines: 1,
          },
          new: {
            start: 1,
            lines: 1,
          },
          added: 1,
          deleted: 1,
          changedLines: 2,
          tunedFile: false,
          computedShare: {
            opus: 1,
            sol: 1,
          },
          realShare: {
            opus: 1,
            sol: 1,
          },
          raisedToMinimum: {
            opus: false,
            sol: false,
          },
        },
      ],
    },
  ],
});
