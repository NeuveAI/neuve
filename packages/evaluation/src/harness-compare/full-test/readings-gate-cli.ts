import { writeFileSync } from "node:fs";
import { readSets } from "./finders-gate.ts";
import {
  NAMING_NOT_MEASURABLE,
  BRIEFING_GATE,
  briefingOfFolder,
  type BriefingTotals,
  type BriefingUsefulness,
  compareProbeRuns,
  type IdentityCount,
  laneRuleLine,
  packageLaneRule,
  probeFolder,
  probeSummaryOf,
  type ProbeFolder,
  scoreProbeRun,
  type ProbeRunScore,
  type ReadingsSummary,
  useLaneRuleFile,
} from "./readings-gate.ts";

/**
 * bun packages/evaluation/src/harness-compare/full-test/readings-gate-cli.ts <command>
 *
 *   score   --root <out> --run <name> --set <index.json> [--set …] [--out <file>]
 *   table   --root <out> --run <a> --run <b> [--run …] --set … [--label <run>=<label> …] [--out <file>]
 *   compare --root <out> --baseline <run> --baseline-again <run> --candidate <run> --set … [--out <file>]
 *   probe   --folder <run folder> [--out <file>]
 *   briefing --folder <run folder> [--folder …] [--out <file>]
 *
 * Each command also takes `--lane-rule <lane-rule.ts>`: that file's `recordedLane` and `floorsOf`
 * go in the seams before anything is read. Without it the seams are what the package's own
 * `@neuve/harness/lane-rule` import gives, which in a checkout whose `node_modules` belongs to
 * another worktree is that worktree's harness. Every output says in one line where the rule came
 * from and what it exports.
 *
 * `<out>` is the local runner's output root (research/pr-bench/replay/local/run_cases.py), each run of a
 * probe build (`--setting review.sectionReadings="probe"`); `probe` reads one plain run folder with no
 * plants (`readings.jsonl`, `show.json`, `export.json`); `briefing` reads each folder's `show.json`
 * packet for the briefing usefulness measure (the readers' briefing rubric, 3.8) and takes no lane
 * rule. The readings' rows are read from
 * `readings.jsonl` beside a run's `export.json`, else from the run log of its kept store. Every output
 * is counts, keys and lanes only: the rows hold no model text.
 */

const args = Bun.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const flags = (name: string) =>
  args.flatMap((a, i) =>
    a === name && args[i + 1] !== undefined ? [args[i + 1]!] : [],
  );
const need = (name: string) => {
  const value = flag(name);
  if (value === undefined) throw new Error(`${args[0]} needs ${name}`);
  return value;
};
const write = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const sets = () => {
  const given = flags("--set");
  if (given.length === 0)
    throw new Error(`${args[0]} needs --set <index.json>`);
  return readSets(given);
};

const num = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : String(v);
const counts = (r: Readonly<Record<string, number>>) =>
  Object.entries(r)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "none";
const lines = (
  r: Readonly<Record<string, { sections: number; lines: number }>>,
) =>
  Object.entries(r)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} ${n.sections} (${n.lines} lines)`)
    .join(", ") || "none";
const per = (part: number | null | undefined, whole: number) =>
  part === null || part === undefined || whole === 0
    ? "-"
    : String(Math.round((part / whole) * 10) / 10);
const tokens = (t: { total: number; unknown: number } | null, over: number) =>
  t === null
    ? "not measured"
    : t.unknown > 0
      ? `${t.total}+? over ${over}`
      : per(t.total, over);

/** The catch levels, the readings' own lines, then identity, for one summary: each row by its name. */
const summaryRows = (s: ReadingsSummary): Array<[string, string]> => [
  ["variants", num(s.variants)],
  ["scored (complete, rows read)", num(s.scored)],
  [
    "failed / unreadable / missing",
    `${s.failed} / ${s.unreadable} / ${s.missing}`,
  ],
  ["caught", num(s.outcomes.caught)],
  ["caught beside", num(s.outcomes["caught-beside"])],
  [
    "undecided (by cause)",
    `${s.outcomes.undecided} (${counts(s.undecidedByCause)})`,
  ],
  ["claimed, not standing", num(s.outcomes["claimed-not-standing"])],
  [
    "claimed from another section",
    num(s.outcomes["claimed-from-another-section"]),
  ],
  [
    "FAMILY CAUGHT THROUGH A CARRIED JUDGEMENT (never a catch; fails acceptance)",
    num(s.outcomes["caught-through-carried"]),
  ],
  [
    "family catch not measured (unmarked section in a marked run; not a data point)",
    num(s.outcomes["catch-not-measured"]),
  ],
  [
    "family claimed on another member (not a catch)",
    num(s.outcomes["claimed-on-another-member"]),
  ],
  ["missed", num(s.outcomes.missed)],
  [
    "NOT REACHED (the review's time ran out before its reading)",
    num(s.outcomes["not-reached"]),
  ],
  ["waiting (other)", num(s.outcomes.waiting)],
  ["unread", num(s.outcomes.unread)],
  ["excluded: no reading reads it", num(s.outcomes.excluded)],
  ["no section owns a planted line", num(s.outcomes["no-section"])],
  ["claims not recorded", num(s.outcomes["claims-not-recorded"])],
  ["caught by a finder only (not the readings)", num(s.caughtByFinderOnly)],
  [
    "PLANTS WHERE NO PERSON LOOKS (static or agentic, no standing request)",
    num(s.plantsWhereNoPersonLooks),
  ],
  ["family deviant read", counts(s.family)],
  [
    "family other copies (carried / own / not measured)",
    `${s.familyMembers.carried} / ${s.familyMembers.own} / ${s.familyMembers.notMeasured}`,
  ],
  [
    `family catches (named and not named cannot be told apart: ${NAMING_NOT_MEASURABLE})`,
    counts(s.familyCatches),
  ],
  [
    "plant sections' lanes (applied → recomputed with code's own gaps left out)",
    counts(s.plantSectionLanes),
  ],
  [
    "family readings claims off the deviating copy (on another copy / elsewhere in the commit)",
    `${s.familyClaims.onOtherMembers} / ${s.familyClaims.offTheFamily}`,
  ],
];
const checked = (c: IdentityCount) => {
  const why = Object.entries(c.why)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([w, n]) => `${w}: ${n}`);
  return `${c.checked} / ${c.notChecked}${why.length === 0 ? "" : ` (not checked: ${why.join("; ")})`}`;
};
const identityRows = (i: {
  readonly recordedLane: IdentityCount;
  readonly floors: IdentityCount;
  readonly floorsRaised: IdentityCount;
  readonly added: string;
}): Array<[string, string]> => [
  ["recordedLane checked / not checked", checked(i.recordedLane)],
  [
    "floors checked / not checked (every stored floor is one the inputs give)",
    checked(i.floors),
  ],
  [
    "floors raised checked / not checked (the floors the inputs give leave exactly the stored ones)",
    checked(i.floorsRaised),
  ],
  ["added (the lines a section adds)", i.added],
];
const costRows = (
  s: Pick<ReadingsSummary, "costs" | "settledWithoutCodeGaps" | "absent">,
): Array<[string, string]> => {
  const c = s.costs;
  return [
    ["sections by state", counts(c.sections)],
    [
      "settled sections by lane (applied: the run's lane)",
      counts(c.settledByLane),
    ],
    [
      "settled sections by lane recomputed with code's own gaps left out (relations-unavailable, structure-unavailable; not the run's lane)",
      counts(s.settledWithoutCodeGaps.lanes),
    ],
    [
      "settled sections not recomputed without code's gaps (by reason)",
      counts(s.settledWithoutCodeGaps.notMeasured),
    ],
    ["undecided sections by cause", lines(c.undecided)],
    ["excluded sections by reason", lines(c.excluded)],
    ...Object.entries(c.calls).flatMap(([kind, k]): Array<[string, string]> => [
      [
        `${kind}: calls (ran, reused, failed)`,
        `${k.calls} (${k.ran}, ${k.reused}, ${k.failed})`,
      ],
      [
        `${kind}: sections per call (calls that say how many)`,
        per(k.sections, k.counted),
      ],
      [
        `${kind}: output tokens per call that ran (from ${k.sources.output.join(", ") || "-"})`,
        tokens(k.output, k.ran),
      ],
      [
        `${kind}: cached input (cache reads) tokens per section covered (from ${k.sources.cached.join(", ") || "-"})`,
        tokens(k.cached, k.ranSections),
      ],
      [
        `${kind}: cache write tokens per section covered (five-minute and one-hour writes; from ${k.sources.cacheWrite.join(", ") || "-"})`,
        tokens(k.cacheWrite, k.ranSections),
      ],
      ...((
        ["output", "input", "cached", "cacheWrite", "reasoning"] as const
      ).some((c) => k.sources[c].includes("reading.call"))
        ? [
            [
              `${kind}: calls cut off or failed, left out of every column from reading.call (those columns cover calls that ran only; a column from model.call counts them)`,
              num(k.leftOut),
            ] as [string, string],
          ]
        : []),
      [
        `${kind}: output tokens per section covered (call tokens / sections covered by calls that ran; from ${k.sources.output.join(", ") || "-"})`,
        tokens(k.output, k.ranSections),
      ],
      [
        `${kind}: reasoning tokens per call that ran (part of output; from ${k.sources.reasoning.join(", ") || "-"})`,
        tokens(k.reasoning, k.ran),
      ],
      [
        `${kind}: input tokens per section covered (ordinary input: cache reads and cache writes are their own rows; call tokens / sections covered by calls that ran; from ${k.sources.input.join(", ") || "-"})`,
        tokens(k.input, k.ranSections),
      ],
      [
        `${kind}: Assess classes (calls reporting)`,
        `${k.classes.total} (${k.classes.calls})`,
      ],
      [
        `${kind}: sections outside the largest class or verdict list (calls reporting)`,
        `${k.outside.total} (${k.outside.calls})`,
      ],
      [
        `${kind}: answer characters per section covered`,
        per(k.characters, k.sections),
      ],
    ]),
    [
      "Verify calls not attributable to a listed claim (calls; output, input tokens; never in verify-claim's cost)",
      `${c.verifyNotAttributable.calls}; ${c.verifyNotAttributable.output === null ? "-" : `${c.verifyNotAttributable.output.total}${c.verifyNotAttributable.output.unknown > 0 ? "+?" : ""}`}, ${c.verifyNotAttributable.input === null ? "-" : `${c.verifyNotAttributable.input.total}${c.verifyNotAttributable.input.unknown > 0 ? "+?" : ""}`}`,
    ],
    ["rows absent (never read as zero)", s.absent.join(", ") || "none"],
  ];
};

const printScore = (score: ProbeRunScore) => {
  console.log(`run ${score.run}`);
  console.log(
    `  builds: ${score.builds.map((b) => b ?? "unknown").join(", ") || "none"}`,
  );
  console.log(`  configurations: ${score.configs.join(" | ") || "none"}`);
  for (const [name, value] of [
    ...summaryRows(score.overall),
    ...identityRows(score.overall.identity).map(
      ([name, value]): [string, string] => [`identity: ${name}`, value],
    ),
    ...costRows(score.overall),
  ])
    console.log(`  ${name}: ${value}`);
  const line = (name: string, s: ReadingsSummary) =>
    console.log(
      `  ${name}: ${s.variants} variants, caught ${s.outcomes.caught}, beside ${s.outcomes["caught-beside"]}, undecided ${s.outcomes.undecided}, missed ${s.outcomes.missed}, finder only ${s.caughtByFinderOnly}, no person looks ${s.plantsWhereNoPersonLooks}`,
    );
  for (const [category, s] of Object.entries(score.byCategory))
    line(category, s);
  for (const [form, s] of Object.entries(score.byForm))
    line(`test-file form ${form}`, s);
};

/** One plain probe folder: its state, its counts as `probeCounts` gives them, and its lanes two ways. */
const printProbe = (p: ProbeFolder) => {
  console.log(`folder ${p.folder}`);
  console.log(`  status: ${p.status}`);
  for (const why of p.notComplete) console.log(`  not complete: ${why}`);
  console.log(`  build: ${p.build ?? "unknown"}`);
  const summary = probeSummaryOf(p);
  if (p.counts === null || summary === null || p.lanes === null) return;
  const c = p.counts;
  const rows: Array<[string, string]> = [
    ...costRows(summary),
    [
      "settled sections' moves, applied → recomputed with code's own gaps left out (a recomputation, not the run's lane)",
      counts(p.lanes.moves),
    ],
    ["gaps by axis / kind", counts(p.gaps ?? {})],
    ...identityRows(p.identity!).map(([name, value]): [string, string] => [
      `identity: ${name}`,
      value,
    ]),
    ["origins", counts(c.origins)],
    [
      "batches (settled / total)",
      c.batches === null
        ? "not recorded"
        : `${c.batches.settled} / ${c.batches.total}`,
    ],
    [
      "seconds to the first settled batch",
      c.secondsToFirstSettledBatchNote ?? num(c.secondsToFirstSettledBatch),
    ],
    ["request time from", c.requestedAtFrom ?? "not recorded"],
    [
      "preparation (status, ms)",
      c.prepare === null
        ? "not recorded"
        : `${c.prepare.status}, ${num(c.prepare.durationMs)}`,
    ],
    ["seconds to the decision", num(c.secondsToDecision)],
    ["readings claims outside their section", num(c.claimsOutsideTheirSection)],
    ["finder claims", num(c.finderClaims)],
    ["finder findings placed", num(c.finderFindingsPlaced)],
  ];
  for (const [name, value] of rows) console.log(`  ${name}: ${value}`);
};

/**
 * One column per run, rows per category and for the costs: a table, which refuses nothing. Every
 * row is keyed by its name over all the runs (a reading kind one run lacks is still a row), and a
 * run with no value for it prints `-`.
 */
export const table = (
  scores: ReadonlyArray<ProbeRunScore>,
  labels: Readonly<Record<string, string>>,
) => {
  const head = scores.map((s) => labels[s.run] ?? s.run);
  const rows: Array<[string, ...string[]]> = [
    [
      "build",
      ...scores.map((s) =>
        s.builds.map((b) => b?.slice(0, 12) ?? "unknown").join(" "),
      ),
    ],
    ["settings", ...scores.map((s) => s.settings.join(" | ") || "none")],
  ];
  const categories = [
    ...new Set(scores.flatMap((s) => Object.keys(s.byCategory))),
  ].sort();
  const block = (
    title: string,
    pick: (s: ProbeRunScore) => ReadingsSummary | undefined,
    of: (s: ReadingsSummary) => Array<[string, string]>,
  ) => {
    const each = scores.map((s) => {
      const x = pick(s);
      return x === undefined ? new Map<string, string>() : new Map(of(x));
    });
    const names: string[] = [];
    for (const m of each)
      for (const name of m.keys()) if (!names.includes(name)) names.push(name);
    for (const name of names)
      rows.push([`${title}: ${name}`, ...each.map((m) => m.get(name) ?? "-")]);
  };
  block("all", (s) => s.overall, summaryRows);
  for (const c of categories) block(c, (s) => s.byCategory[c], summaryRows);
  const forms = [
    ...new Set(scores.flatMap((s) => Object.keys(s.byForm))),
  ].sort();
  for (const f of forms)
    block(`test-file form ${f}`, (s) => s.byForm[f], summaryRows);
  block(
    "identity",
    (s) => s.overall,
    (s) => identityRows(s.identity),
  );
  block("cost", (s) => s.overall, costRows);
  const widths = [
    Math.max(...rows.map((r) => r[0].length), 4),
    ...head.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i + 1] ?? "").length)),
    ),
  ];
  const out = [
    ["", ...head].map((c, i) => c.padEnd(widths[i]!)).join("  "),
    ...rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ")),
  ];
  return { head, rows, text: out.join("\n") };
};

const share = (v: number | null) => (v === null ? "-" : v.toFixed(3));
const totalsLine = (t: BriefingTotals) =>
  `${t.texts} texts, ${t.claims} claims (${t.citedClaims} cited, ${t.writtenClaims} linked, ${t.enumeratingClaims} enumerating), ${t.fileListTexts} file lists, ${t.fileNamePhrases} of ${t.phrases} phrases file names, ${t.rangedPhrases} with a line range, ${t.danglingLinkTexts} with a link left open`;

/** One folder's briefing usefulness: totals by source and by kind, the shares and the gate values. */
const printBriefing = (folder: string, b: BriefingUsefulness) => {
  console.log(`folder ${folder}`);
  for (const [source, t] of Object.entries(b.bySource))
    console.log(`  ${source}: ${totalsLine(t)}`);
  for (const [kind, t] of Object.entries(b.modelByKind))
    console.log(`  model-written ${kind}: ${totalsLine(t)}`);
  console.log(
    `  cite share ${share(b.citeShare)} (at least ${BRIEFING_GATE.citeShareAtLeast}), written share ${share(b.writtenShare)}, file-name phrases ${share(b.fileNamePhraseShare)} (at most ${BRIEFING_GATE.fileNamePhraseShareAtMost}), links with a line range ${share(b.lineRangeShare)}, texts with a link left open ${b.bySource.agent.danglingLinkTexts} (at most ${BRIEFING_GATE.danglingLinkTexts})`,
  );
  console.log(
    `  section titles: ${b.sectionTitles}, ${b.codeLikeSectionTitles} a file name or line count (reported)`,
  );
  const low = b.perUnit.filter(
    (u) => u.citeShare !== null && u.citeShare < BRIEFING_GATE.citeShareAtLeast,
  ).length;
  console.log(
    `  units: ${b.units}, ${b.perUnit.length} with model-written claims, ${low} under the cite share; lead is Facts on ${b.leadIsFacts} (${b.leadIsFactsOnMultiSection} of more than one section with a section read, ${b.leadIsFactsUnread} with none read); links or IDs in Explained ${b.explainedIds}`,
  );
  for (const why of b.fails) console.log(`  FAIL ${why}`);
  console.log(`  briefing gate: ${b.passes ? "passes" : "fails"}`);
};

if (import.meta.main && args[0] === "briefing") {
  const folders = flags("--folder");
  if (folders.length === 0) throw new Error("briefing needs --folder");
  const results = folders.map(briefingOfFolder);
  const out = flag("--out");
  if (out !== undefined) write(out, { version: 1, results });
  for (const r of results)
    if (r.measured) printBriefing(r.folder, r.briefing);
    else console.log(`folder ${r.folder}\n  not measured: ${r.why}`);
} else if (import.meta.main) {
  const command = args[0];
  if (!["score", "table", "compare", "probe"].includes(command ?? ""))
    throw new Error(
      "readings-gate-cli takes score, table, compare, probe or briefing",
    );
  // The lane rule goes in the seams before anything is read.
  const laneRuleFile = flag("--lane-rule");
  const laneRule =
    laneRuleFile === undefined
      ? packageLaneRule()
      : await useLaneRuleFile(laneRuleFile);
  console.log(laneRuleLine(laneRule));
  const root = command === "probe" ? "" : need("--root");
  if (command === "probe") {
    const result = probeFolder(need("--folder"));
    const out = flag("--out");
    if (out !== undefined) write(out, { version: 1, laneRule, ...result });
    printProbe(result);
  } else if (command === "score") {
    const score = scoreProbeRun(root, need("--run"), sets());
    const out = flag("--out");
    if (out !== undefined)
      write(out, {
        version: 1,
        laneRule,
        root,
        sets: flags("--set"),
        ...score,
        variants: score.variants.map(({ rows: _rows, ...v }) => v),
      });
    printScore(score);
  } else if (command === "table") {
    const runs = flags("--run");
    if (runs.length < 2) throw new Error("table needs two or more --run");
    const variants = sets();
    const labels = Object.fromEntries(
      flags("--label").map((l) => {
        const at = l.indexOf("=");
        if (at < 1) throw new Error(`--label takes <run>=<label>, not ${l}`);
        return [l.slice(0, at), l.slice(at + 1)];
      }),
    );
    const scores = runs.map((r) => scoreProbeRun(root, r, variants));
    const t = table(scores, labels);
    const out = flag("--out");
    if (out !== undefined)
      write(out, {
        version: 1,
        laneRule,
        root,
        sets: flags("--set"),
        head: t.head,
        rows: t.rows,
      });
    console.log(t.text);
  } else if (command === "compare") {
    const variants = sets();
    const [b, a, c] = [
      need("--baseline"),
      need("--baseline-again"),
      need("--candidate"),
    ].map((r) => scoreProbeRun(root, r, variants)) as [
      ProbeRunScore,
      ProbeRunScore,
      ProbeRunScore,
    ];
    const result = compareProbeRuns(b, a, c);
    const out = flag("--out");
    if (out !== undefined)
      write(out, {
        version: 1,
        laneRule,
        root,
        sets: flags("--set"),
        ...result,
      });
    console.log(result.rules.dataPoints);
    console.log(
      `data points: ${result.dataPoints}; out in all three runs (no section owns a planted line, or excluded): ${result.outInAllRuns.length}`,
    );
    for (const [category, side] of Object.entries(result.categories)) {
      const k = side.catches;
      console.log(
        `  ${category}: caught ${k.caught.baseline} / ${k.caught.baselineAgain} / ${k.caught.candidate} (flips ${k.flips}, lost ${k.lost}, gained ${k.gained}): ${k.verdict}${k.holds ? "" : ", FEWER than the lower baseline"}${k.thin ? " (thin)" : ""}; loss bound ${k.lossRateUpperBound === null ? "n/a (a catch was lost)" : k.lossRateUpperBound.toFixed(2)}`,
      );
    }
    for (const [form, side] of Object.entries(result.forms)) {
      const k = side.catches;
      console.log(
        `  test-file form ${form}: caught ${k.caught.baseline} / ${k.caught.baselineAgain} / ${k.caught.candidate} (flips ${k.flips}, lost ${k.lost}, gained ${k.gained}): ${k.verdict}${k.holds ? "" : ", FEWER than the lower baseline"}${k.thin ? " (thin)" : ""}`,
      );
    }
    for (const r of result.acceptance.caughtThroughCarried)
      if (r.variants.length > 0)
        console.log(
          `  ${r.run}: family plants caught only through a carried judgement: ${r.variants.join(", ")}`,
        );
    for (const n of result.notCaught)
      console.log(
        `  ${n.run}: not reached (the review's time ran out before its reading) ${n.byOutcome["not-reached"] ?? 0}`,
      );
    for (const n of result.notCaught)
      console.log(
        `  ${n.run}: not caught by outcome ${counts(n.byOutcome)}; undecided by cause ${counts(n.undecidedByCause)}; caught by a finder only ${n.caughtByFinderOnly}`,
      );
    for (const v of result.outOfReachInSomeRuns)
      console.log(
        `  variant ${v.variant} is out of reach in some runs only: ${Object.entries(
          v.outcomes,
        )
          .map(([run, o]) => `${run} ${o}`)
          .join(", ")}`,
      );
    for (const r of result.acceptance.noPerson)
      console.log(
        `  ${r.run}: plant sections where no person looks ${r.sections} (in ${r.plants} plant(s))`,
      );
    for (const i of result.identity)
      console.log(
        `  ${i.run}: identity recordedLane ${checked(i.recordedLane)}; floors ${checked(i.floors)}; floors raised ${checked(i.floorsRaised)}`,
      );
    if (result.acceptance.configuration.length > 0)
      console.log(
        `  configuration: ${result.acceptance.configuration.join("; ")}`,
      );
    if (result.acceptance.notDataPoints.length > 0)
      console.log(
        `  reviews not complete or readable: ${result.acceptance.notDataPoints.length}`,
      );
    console.log(`acceptance: ${result.acceptance.passes ? "passes" : "fails"}`);
  }
}
