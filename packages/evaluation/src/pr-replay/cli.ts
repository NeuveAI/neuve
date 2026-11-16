import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { gerritCandidates, qualifyGerrit } from "./gerrit.ts";
import { githubCandidates, qualifyGithub } from "./github.ts";
import {
  captureCase,
  cloneCase,
  leakageChecks,
  readCase,
  writeCase,
} from "./prepare.ts";
import {
  CANARY_PROMPTS,
  cloudFactsNow,
  labelCodexHome,
  labelRunner,
  pinCatalog,
  pinnedCatalogPath,
  runToolless,
} from "./codex.ts";
import { judgeAfterMerge, tiebreakAfterMerge } from "./aftermerge.ts";
import {
  AuditItem,
  auditCase,
  auditDirectory,
  auditOverrideOf,
  auditPool,
  auditReport,
  strataOf,
  stratifiedSample,
} from "./audit.ts";
import { CONTROL_KINDS, controlCandidates } from "./controls.ts";
import {
  CATEGORIES,
  labelConcerns,
  redecideDesign,
  tiebreakConcerns,
  type Category,
} from "./concerns.ts";
import { recordAuditOverride, writeLineEvidence } from "./evidence.ts";
import { judgeRubric } from "./rubric-judge.ts";
import { buildConfirm, settleConfirm } from "./confirm.ts";
import { buildStudy } from "./harness-study.ts";
import { buildRecategorize, settleRecategorize } from "./recategorize.ts";
import {
  buildMatchCheck,
  buildMissCause,
  reportMatchCheck,
  reportMissCause,
} from "./parity.ts";
import { matchCase, tiebreakMatching } from "./matching.ts";
import { judgeMerit, regradeMerit } from "./merit.ts";
import { writeReworkMap } from "./rework.ts";
import {
  CANDIDATE_RUN,
  SOURCES,
  caseDirectory,
  indexDirectory,
  researchRoot,
  treating,
  treatmentWrite,
  type SourceName,
} from "./sources.ts";

/**
 * The replay dataset's preparation commands (design §1, §2, §6). Each reads public providers
 * read-only and writes only under the research volume.
 *
 * - `candidates <source> [--limit <n>] [--per-quarter <n>]`: lists merged changes in the source's
 *   window, at most `--per-quarter` per quarter before filtering (default 100 on Gerrit, 200 on
 *   GitHub), qualifies n of them at their first revision and writes
 *   `index/candidates/<source>.json`, qualified cases first by score.
 * - `controls <source> [--per-quarter <n>]`: lists the source's control candidates by kind (quiet,
 *   abandoned, revert, mechanical; `controls.ts`), none of them an interaction candidate, and writes
 *   `index/controls/<source>.json`. Run after `candidates`.
 * - `pick <source> <count> [--split pilot]`: the top qualified candidates, one per author.
 * - `prepare <source> <number> [--split pilot] [--control <kind>]`: captures the case, finds its first revision, builds
 *   its clone and records the leakage checks in `cases/<source>/<number>/case.json`.
 * - `aftermerge <source> <number>`: two Codex passes (Sol, medium, no tools) judge each commit that
 *   changed the case's lines within 90 days of landing; writes `labels/aftermerge.json`. Heavy.
 * - `match <source> <number>`: two Codex passes (Sol, medium, no tools) match Neuve's review with the
 *   case's agreed concerns; writes `labels/matching.json`. Heavy; needs the review and the concerns.
 * - `evidence <source> <number>`: builds `labels/line-evidence.json` from the case's labels (code only).
 * - `merit <source> <number>`: the merit validation (10.134) of a matched case's unmatched Neuve
 *   items: outside reviewers judge each on the language's and framework's practice; writes
 *   `labels/merit.json` with the split matched, legitimate, nit-pick, minor, noise and unjudged.
 * - `regrade <source> <number>`: a case judged before the code-quality scale (10.138) has its
 *   best-practice items graded again as code quality, nit-pick or minor; writes
 *   `labels/merit-regrade.json`.
 * - `match`, `tiebreak` (its matching only), `merit` and `regrade` take `--run <folder>` (parity, 10.141): another run of the case, a
 *   repeat (cloud-2), the first run again (cloud), a baseline or a candidate, read from
 *   `run/<folder>/show.json` and written to `run/<folder>/labels/`, against the case's own concern
 *   labels; a run's merit takes the first run's decoys when they are current.
 * - `rubric <items.json> <folder>`: a blind rubric (the title rubric of 10.139, or the lead-line or
 *   digest rubric) judged on the labellers, two passes per chunk and a third on ties; writes the
 *   folder's decided.json once every chunk is done. `title-rubric` is the same command.
 * - `match-check <folder> [seed]`: parity (10.141 (b)): every matched case's concerns by standing in the
 *   blind matching (matched, split, missed), a stratified sample of each, as items for `rubric`, and
 *   the key. `match-check-report <folder>` reads the decided answers: scoring gaps, precision, and the
 *   catch rate they imply.
 * - `confirm <folder> <seed> [--run <folder>]`: parity's pair confirmation (10.141): every concern the
 *   matcher left unmatched in the run's matched cases, with Neuve's candidate items and a decoy, as
 *   items for `rubric`. `confirm-settle <folder>` reads the decided answers: the report (catches by
 *   comment and by any item, disagreements, the decoys' false-confirmation rate) and, once every
 *   concern is decided, each case's `confirmation.json` beside its matching.
 * - `harness-study <items.json> <folder>`: the lanes thread's harness study (analysis, 27 October): its
 *   items, each a concern and the baseline run's record of it stage by stage, as items for `rubric`
 *   (chunks of three), where the reading finds the first stage that stops carrying the problem.
 * - `recategorize <folder> <seed> [category]`: a category relabel (10.142): the matched cases' threads
 *   labelled in one category (performance by default) as items for `rubric`, judged again on the
 *   categories' definitions. `recategorize-settle <folder>` reports what moved and, once every
 *   thread is decided, writes each case's `labels/category-relabel.json` beside its labelling.
 * - `miss-cause <folder>`: parity (10.141 (c)): every concern neither matched nor confirmed, with the
 *   run's record of its lines, as items for `rubric`; `miss-cause-report <folder>` sorts them by cause,
 *   per concern.
 * - `audit-override <name> <source>/<number> <item id>`: a label every auditor of audit <name> found
 *   wrong, corrected in the case's evidence (labels/audit-overrides.json) without labelling it again.
 * - `audit <name> <source>/<number> ...`: the label audit of a batch (10.136): a stratified sample
 *   kept in `audits/<name>/sample.json`, three outside auditors per item, majority; writes the report.
 * - `redecide <source> <number>`: the design-decision field again on a labelled case, from fresh
 *   passes with the tightened definition (an adopted nit is no design decision), then its evidence.
 * - `tiebreak <source> <number>`: for a case labelled before 10.135, a third pass on each step's ties
 *   (concerns, after-merge, matching), keeping the two stored passes, then its evidence again.
 * - `canary`: before labelling runs anywhere new (the cloud's Sandbox), a schema round-trip and a
 *   prompt that asks for a shell command, both through the gate: each must end with no tool event.
 *   In the cloud it then lists the Codex home's file names. Prints only pass or fail per run.
 * - `pin-catalog`: pins labelling runs to a local copy of the model's catalog entry (no experimental
 *   tools), from the catalog Codex downloaded, if that passes its checks.
 * - `reclone <source> <number>`: rebuilds a prepared case's clone and checks it again.
 * - `check <source> <number>`: recomputes the leakage checks of a prepared clone.
 * - `rework <source> <number>`: writes the case's rework map, `labels/rework.json` (evaluator-only).
 * - With NEUVE_TREATMENT_ROOT set (a fresh candidate's labelling, NEU-58), only `match`, `tiebreak`,
 *   `merit` and `regrade` with `--run candidate-<k>`, `confirm` with it, and `rubric` and
 *   `confirm-settle` into a folder under the treatment run; every other command is refused, since the
 *   research volume is then only read.
 * - `concerns <source> <number>`: two Codex passes (Sol, medium) judge the case's review threads;
 *   writes `labels/concerns.jsonl` and `labels/concerns-summary.json`. Heavy beyond one case: run
 *   batches only in a granted slot. Needs NEUVE_LABEL_CODEX_HOME and TMPDIR on the volume.
 */

type Qualified = {
  number: number;
  title: string;
  author: string;
  qualifies: boolean;
  score: number;
  reasons: Array<string>;
};

const candidatesFile = (name: SourceName) =>
  join(indexDirectory(), "candidates", `${name}.json`);

/** A seed given on the command line: a whole number, never a word read as zero. */
const seedArg = (text: string | undefined, usage: string) => {
  const seed = Number(text);
  if (
    text === undefined ||
    !/^[0-9]+$/.test(text) ||
    !Number.isSafeInteger(seed)
  )
    throw new Error(`${usage}: the seed is a whole number`);
  return seed;
};

/** `--run <folder>`: match or judge another run of the case (run/<folder>/), not its first. */
const runOption = (rest: ReadonlyArray<string>) => {
  const at = rest.indexOf("--run");
  if (at === -1) return undefined;
  const run = rest[at + 1];
  if (run === undefined)
    throw new Error("--run needs a run folder, such as cloud-2");
  return run;
};

const sourceArg = (text: string | undefined): SourceName => {
  if (text === undefined || !(text in SOURCES))
    throw new Error(`name a source: ${Object.keys(SOURCES).join(", ")}`);
  return text as SourceName;
};

const numberArg = (text: string | undefined) => {
  if (text === undefined || !/^[1-9]\d{0,9}$/.test(text))
    throw new Error(
      `name a change or pull request number, not ${JSON.stringify(text)}`,
    );
  return Number(text);
};

const flag = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

/** The commands a candidate's labelling runs, by whether each must name the candidate's run. */
const TREATMENT_COMMANDS: Readonly<Record<string, "run" | "folder">> = {
  match: "run",
  tiebreak: "run",
  merit: "run",
  regrade: "run",
  confirm: "run",
  rubric: "folder",
  "title-rubric": "folder",
  "confirm-settle": "folder",
};

/** Refuses, while a treatment folder is set, any command that would write to the research volume. */
const refuseOutsideTreatment = (
  command: string | undefined,
  rest: ReadonlyArray<string>,
) => {
  if (!treating()) return;
  const needs = command === undefined ? undefined : TREATMENT_COMMANDS[command];
  if (needs === undefined)
    throw new Error(
      `${command}: with NEUVE_TREATMENT_ROOT set only a candidate's labelling runs (${Object.keys(TREATMENT_COMMANDS).join(", ")})`,
    );
  const run = runOption(rest);
  if (needs === "run" && (run === undefined || !CANDIDATE_RUN.test(run)))
    throw new Error(
      `${command}: with NEUVE_TREATMENT_ROOT set, name the candidate's run with --run candidate-<k>, where k is positive without leading zeros`,
    );
  const folder =
    command === "rubric" || command === "title-rubric"
      ? rest[1]
      : command === "confirm" || command === "confirm-settle"
        ? rest[0]
        : undefined;
  if (folder !== undefined) treatmentWrite(resolve(folder));
};

const main = async (args: ReadonlyArray<string>) => {
  const [command, ...rest] = args;
  refuseOutsideTreatment(command, rest);
  if (command === "candidates") {
    const name = sourceArg(rest[0]);
    const source = SOURCES[name];
    const limit = Number(flag(rest, "--limit") ?? 40);
    const perQuarterText = flag(rest, "--per-quarter");
    const perQuarter =
      perQuarterText === undefined ? undefined : Number(perQuarterText);
    if (
      perQuarter !== undefined &&
      (!Number.isInteger(perQuarter) || perQuarter < 1 || perQuarter > 1000)
    )
      throw new Error(`--per-quarter is 1 to 1000, not ${perQuarterText}`);
    const listed =
      source.provider === "gerrit"
        ? (await gerritCandidates(source, perQuarter)).map((change) => ({
            number: change._number,
            comments: change.total_comment_count ?? 0,
          }))
        : githubCandidates(source, perQuarter).map((pull) => ({
            number: pull.number,
            comments: pull.threads,
          }));
    // Spread across the window: take every k-th listed change rather than the first n.
    const step = Math.max(1, Math.floor(listed.length / limit));
    const sample = listed.filter((_, i) => i % step === 0).slice(0, limit);
    const qualified: Array<Qualified> = [];
    for (const { number } of sample) {
      try {
        qualified.push(
          source.provider === "gerrit"
            ? await qualifyGerrit(source, number)
            : qualifyGithub(source, number),
        );
      } catch (error) {
        qualified.push({
          number,
          title: "",
          author: "",
          qualifies: false,
          score: 0,
          reasons: [`could not qualify: ${String(error).slice(0, 200)}`],
        });
      }
    }
    qualified.sort(
      (a, b) => Number(b.qualifies) - Number(a.qualifies) || b.score - a.score,
    );
    mkdirSync(join(indexDirectory(), "candidates"), { recursive: true });
    writeFileSync(
      candidatesFile(name),
      `${JSON.stringify({ source: name, listed: listed.length, at: new Date().toISOString(), qualified }, null, 2)}\n`,
    );
    console.log(
      `${name}: ${listed.length} listed, ${sample.length} checked, ${qualified.filter((q) => q.qualifies).length} qualify`,
    );
    return;
  }
  if (command === "controls") {
    const name = sourceArg(rest[0]);
    const perQuarterText = flag(rest, "--per-quarter");
    const perQuarter = Number(perQuarterText ?? 200);
    if (!Number.isInteger(perQuarter) || perQuarter < 1 || perQuarter > 1000)
      throw new Error(`--per-quarter is 1 to 1000, not ${perQuarterText}`);
    const found = await controlCandidates(name, SOURCES[name], perQuarter);
    mkdirSync(join(indexDirectory(), "controls"), { recursive: true });
    writeFileSync(
      join(indexDirectory(), "controls", `${name}.json`),
      `${JSON.stringify({ source: name, at: new Date().toISOString(), controls: found }, null, 2)}\n`,
    );
    console.log(
      `${name}: ${CONTROL_KINDS.map((kind) => `${found.filter((c) => c.kind === kind).length} ${kind}`).join(", ")}`,
    );
    return;
  }
  if (command === "pick") {
    const name = sourceArg(rest[0]);
    const count = Number(rest[1] ?? 3);
    const { qualified } = JSON.parse(
      readFileSync(candidatesFile(name), "utf8"),
    ) as {
      qualified: Array<Qualified>;
    };
    const authors = new Set<string>();
    const picked = qualified.filter((candidate) => {
      if (!candidate.qualifies || authors.has(candidate.author)) return false;
      authors.add(candidate.author);
      return true;
    });
    for (const candidate of picked.slice(0, count))
      console.log(
        `${candidate.number}\t${candidate.score}\t${candidate.author}\t${candidate.title}`,
      );
    return;
  }
  if (command === "prepare") {
    const name = sourceArg(rest[0]);
    const number = numberArg(rest[1]);
    const split = (flag(rest, "--split") ?? "pilot") as
      "pilot" | "development" | "held-out";
    const controlText = flag(rest, "--control");
    if (
      controlText !== undefined &&
      !(CONTROL_KINDS as ReadonlyArray<string>).includes(controlText)
    )
      throw new Error(
        `--control is one of ${CONTROL_KINDS.join(", ")}, not ${controlText}`,
      );
    const { qualified } = JSON.parse(
      readFileSync(candidatesFile(name), "utf8"),
    ) as {
      qualified: Array<Qualified>;
    };
    const candidate = qualified.find((entry) => entry.number === number);
    const record = await captureCase(
      name,
      number,
      { score: candidate?.score ?? 0, reasons: candidate?.reasons ?? [] },
      split,
      // The record's kind for a reverted original is "reverted" (schema.ts); the lister's is "revert".
      controlText === undefined
        ? null
        : controlText === "revert"
          ? "reverted"
          : (controlText as "quiet" | "abandoned" | "mechanical"),
    );
    if (record.unavailable !== null) {
      console.log(`${record.caseId}: unavailable: ${record.unavailable}`);
      return;
    }
    const cloned = cloneCase(record);
    console.log(
      `${cloned.caseId}: ${cloned.firstRevision!.base.slice(0, 8)}..${cloned.firstRevision!.head.slice(0, 8)}, ${cloned.size?.files} files +${cloned.size?.insertions} -${cloned.size?.deletions}, leakage checks ${cloned.checks!.passed ? "pass" : "FAIL"} (${cloned.checks!.laterChecked} later commits checked)`,
    );
    return;
  }
  if (command === "canary") {
    const folder = join(researchRoot(), "tmp", "canary");
    const results: Record<string, string> = {};
    for (const [name, prompt] of Object.entries(CANARY_PROMPTS)) {
      const runDir = join(folder, name);
      rmSync(runDir, { recursive: true, force: true });
      mkdirSync(runDir, { recursive: true });
      const result = await runToolless(
        {
          runDir,
          prompt,
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
          log: join(folder, `${name}.jsonl`),
          effort: "low",
        },
        [],
      );
      // The tool attempt's answer may say anything: neither it nor its log (which holds the
      // model's text) is kept, only whether the run was clean.
      rmSync(join(runDir, "output.json"), { force: true });
      if (name === "toolAttempt")
        rmSync(join(folder, `${name}.jsonl`), { force: true });
      results[name] =
        result.failure === null
          ? `pass (${result.receipt.where}, ${Math.round(result.receipt.wallSeconds)} s, ${result.receipt.eventProblems} event problems)`
          : `FAIL: ${result.failure}`;
    }
    for (const [name, outcome] of Object.entries(results))
      console.log(`${name}: ${outcome}`);
    if (labelRunner() === "cloud") {
      const { homeFiles } = await cloudFactsNow();
      console.log(`cloud Codex home: ${homeFiles.join(", ")}`);
    }
    return;
  }
  if (command === "pin-catalog") {
    // Pins labelling runs to the model's current catalog entry, narrowed to no experimental tools.
    const home = labelCodexHome();
    pinCatalog(home);
    console.log(`pinned ${pinnedCatalogPath()}`);
    return;
  }
  if (command === "reclone") {
    // Rebuilds a prepared case's clone from its recorded first revision, without capturing again.
    const name = sourceArg(rest[0]);
    const record = readCase(name, numberArg(rest[1]));
    // Delete only the case's own clone folder, whatever case.json says its path is.
    const replay = resolve(caseDirectory(name, record.number), "replay");
    if (record.clone !== null && resolve(record.clone.path) !== replay)
      throw new Error(
        `${record.caseId}: refusing to delete ${record.clone.path}, which is not ${replay}`,
      );
    rmSync(replay, { recursive: true, force: true });
    const cloned = cloneCase({ ...record, clone: null, checks: null });
    console.log(
      `${cloned.caseId}: leakage checks ${cloned.checks!.passed ? "pass" : "FAIL"} (${cloned.checks!.unreachableObjects} unreachable objects, ${cloned.checks!.reflogEntries} reflog entries, ${cloned.checks!.transientHeads.length} transient heads, ${cloned.checks!.laterChecked} later commits checked)`,
    );
    return;
  }
  if (command === "check") {
    const record = readCase(sourceArg(rest[0]), numberArg(rest[1]));
    const checked = { ...record, checks: leakageChecks(record) };
    writeCase(checked);
    console.log(JSON.stringify(checked.checks, null, 2));
    return;
  }
  if (command === "rework") {
    const record = readCase(sourceArg(rest[0]), numberArg(rest[1]));
    const map = writeReworkMap(record);
    const entries = Object.values(map.lines);
    console.log(
      `${record.caseId}: ${map.firstLines} added lines; ${entries.filter((e) => e.beforeMerge).length} changed before merge, ${entries.filter((e) => e.afterMerge !== null).length} within ${90} days after (${entries.filter((e) => e.afterMerge?.revert === true).length} by reverts); ${map.untracked} untracked${map.notes.length > 0 ? `; ${map.notes.join("; ")}` : ""}`,
    );
    return;
  }
  if (command === "concerns") {
    const record = readCase(sourceArg(rest[0]), numberArg(rest[1]));
    const summary = await labelConcerns(record);
    console.log(
      JSON.stringify(
        {
          ...summary,
          receipts: summary.receipts,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "aftermerge") {
    const record = readCase(sourceArg(rest[0]), numberArg(rest[1]));
    const { record: judged, receipts } = await judgeAfterMerge(record);
    console.log(
      JSON.stringify(
        {
          commits: judged.commits.map(({ commit, kind, a, b, c }) => ({
            commit: commit.slice(0, 10),
            kind,
            a,
            b,
            c,
          })),
          failures: judged.failures,
          receipts,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "match") {
    const summary = await matchCase(
      readCase(sourceArg(rest[0]), numberArg(rest[1])),
      runOption(rest),
    );
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (command === "redecide") {
    // The design-decision field again on a labelled case (an adopted nit is no design decision),
    // then its evidence.
    const record = readCase(sourceArg(rest[0]), numberArg(rest[1]));
    const result = await redecideDesign(record);
    const labels = join(
      caseDirectory(record.source as SourceName, record.number),
      "labels",
    );
    if (
      !("skipped" in result) &&
      !("incomplete" in result) &&
      existsSync(join(labels, "line-evidence.json"))
    )
      writeLineEvidence(record);
    console.log(`${record.caseId}: ${JSON.stringify(result)}`);
    return;
  }
  if (command === "tiebreak") {
    // A case labelled before 10.135: the third pass on its ties, step by step, and its evidence
    // again. Each step leaves a case it already broke as it is.
    const record = readCase(sourceArg(rest[0]), numberArg(rest[1]));
    const run = runOption(rest);
    if (run !== undefined) {
      // Another run of the case: only its matching has ties of its own; the labels are the case's.
      const matched = await tiebreakMatching(record, undefined, run);
      console.log(
        `${record.caseId} (${run}): ${JSON.stringify("skipped" in matched ? "already broken" : { thirdPass: matched.thirdPass })}`,
      );
      return;
    }
    const labels = join(
      caseDirectory(record.source as SourceName, record.number),
      "labels",
    );
    const concerns = await tiebreakConcerns(record);
    const steps: Record<string, unknown> = {
      concerns:
        "skipped" in concerns
          ? "already broken"
          : (concerns.thirdPass ??
            // No third pass: neither first pass judged anything, or the third failed; say which.
            `no third pass: ${(concerns.problems as Record<string, string | null>)["c"] ?? "failed"}`),
    };
    if (existsSync(join(labels, "aftermerge.json"))) {
      const after = await tiebreakAfterMerge(record);
      steps["aftermerge"] =
        "skipped" in after ? "already broken" : after.record.thirdPass;
    }
    if (existsSync(join(labels, "line-evidence.json"))) {
      const { evidence } = writeLineEvidence(record);
      steps["evidence"] = {
        lines: Object.keys(evidence.lines).length,
        disputed: evidence.disputed,
      };
    }
    if (existsSync(join(labels, "matching.json"))) {
      const matched = await tiebreakMatching(record);
      steps["matching"] =
        "skipped" in matched
          ? "already broken"
          : {
              thirdPass: matched.thirdPass,
              concernsNotInMix: matched.concernsNotInMix,
            };
    }
    console.log(`${record.caseId}: ${JSON.stringify(steps)}`);
    return;
  }
  if (command === "merit") {
    // The merit validation of a matched case's unmatched Neuve items (10.134).
    const summary = await judgeMerit(
      readCase(sourceArg(rest[0]), numberArg(rest[1])),
      runOption(rest),
    );
    if (summary.incomplete) {
      console.log(
        `${summary.caseId}: incomplete, run again (${summary.failed.join("; ")})`,
      );
      return;
    }
    const { receipts: _receipts, byKind, ...totals } = summary;
    console.log(JSON.stringify({ ...totals, byKind }));
    return;
  }
  if (command === "regrade") {
    // The best-practice items of a case judged before 10.138, graded again.
    const summary = await regradeMerit(
      readCase(sourceArg(rest[0]), numberArg(rest[1])),
      runOption(rest),
    );
    if ("skipped" in summary) {
      console.log(`${summary.caseId}: ${summary.skipped}`);
      return;
    }
    if (summary.incomplete) {
      console.log(
        `${summary.caseId}: incomplete, run again (${summary.failed.join("; ")})`,
      );
      return;
    }
    const { receipts: _receipts, byKind, ...totals } = summary;
    console.log(JSON.stringify({ ...totals, byKind }));
    return;
  }
  if (command === "audit") {
    // `audit <name> <source>/<number> ...`: the label audit of one batch (10.136). The sample is
    // drawn once and kept; each case's three auditors run once; the report is written each time.
    const name = rest[0];
    if (name === undefined || !/^[a-z0-9-]+$/.test(name))
      throw new Error(
        "audit <name> <source>/<number> ...: name is lowercase letters, digits and dashes",
      );
    const directory = auditDirectory(name);
    mkdirSync(directory, { recursive: true });
    const samplePath = join(directory, "sample.json");
    const records = new Map(
      rest.slice(1).map((arg) => {
        const [source, number] = arg.split("/");
        const record = readCase(sourceArg(source), numberArg(number));
        return [record.caseId, record] as const;
      }),
    );
    if (!existsSync(samplePath)) {
      // Held-out cases stay unreported, so they are never audited either.
      const pool = [...records.values()]
        .filter((record) => record.split !== "held-out")
        .flatMap((record) => auditPool(record));
      const seed = randomBytes(4).readUInt32BE(0);
      writeFileSync(
        samplePath,
        // Each stratum's pool count goes with the sample: accuracy is weighted back with it.
        `${JSON.stringify({ seed, pool: pool.length, strata: strataOf(pool), items: stratifiedSample(pool, seed) }, null, 2)}\n`,
      );
    }
    const drawn = JSON.parse(readFileSync(samplePath, "utf8")) as {
      items: Array<unknown>;
      strata?: Record<string, number>;
    };
    if (drawn.strata === undefined)
      throw new Error(
        `${samplePath} has no stratum counts (drawn before accuracy was weighted): delete it and draw the sample again`,
      );
    const sample = drawn.items.map((item) => AuditItem.parse(item));
    const decided = [];
    const incomplete: Array<string> = [];
    for (const caseId of [...new Set(sample.map((item) => item.caseId))]) {
      const record = records.get(caseId);
      if (record === undefined)
        throw new Error(
          `${caseId} is in the sample but not among the cases given`,
        );
      const result = await auditCase(
        name,
        record,
        sample.filter((item) => item.caseId === caseId),
      );
      if ("incomplete" in result && result.incomplete) incomplete.push(caseId);
      else decided.push(...result.items);
    }
    const strata = drawn.strata;
    const report = { ...auditReport(decided, strata), incomplete };
    writeFileSync(
      join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    const pct = (rate: number | null) =>
      rate === null ? "-" : `${Math.round(rate * 100)}%`;
    console.log(
      `${name}: ${report.overall.right}/${report.overall.judged} right as sampled, ${pct(report.overall.accuracy)} weighted to the pool, ${report.wrong.length} wrong; flagged: ${report.flagged.join(", ") || "none"}; not shown to meet 85%: ${report.notShown.join(", ") || "none"}; too few: ${report.tooFew.join(", ") || "none"}${incomplete.length > 0 ? `; ${incomplete.length} cases incomplete, run again` : ""}`,
    );
    return;
  }
  if (command === "rubric" || command === "title-rubric") {
    // `rubric <items.json> <folder>`: a blind rubric's judging on the labellers, the rubric read from
    // its items' IDs: two passes per chunk, a third on ties, the majority deciding; decided.json once
    // every chunk is.
    const [items, folder] = rest;
    if (items === undefined || folder === undefined)
      throw new Error("rubric <items.json> <folder>");
    console.log(JSON.stringify(await judgeRubric(items, folder)));
    return;
  }
  if (command === "match-check") {
    const [folder, seed] = rest;
    if (folder === undefined) throw new Error("match-check <folder> [seed]");
    console.log(
      JSON.stringify(
        buildMatchCheck(
          folder,
          seed === undefined ? randomBytes(4).readUInt32BE(0) : Number(seed),
        ),
      ),
    );
    return;
  }
  if (command === "match-check-report") {
    const [folder] = rest;
    if (folder === undefined) throw new Error("match-check-report <folder>");
    console.log(JSON.stringify(reportMatchCheck(folder), null, 1));
    return;
  }
  if (command === "confirm") {
    const [folder, seed] = rest;
    const usage = "confirm <folder> <seed> [--run <folder>]";
    if (folder === undefined) throw new Error(usage);
    console.log(
      JSON.stringify(
        buildConfirm(folder, seedArg(seed, usage), runOption(rest)),
      ),
    );
    return;
  }
  if (command === "confirm-settle") {
    const [folder] = rest;
    if (folder === undefined) throw new Error("confirm-settle <folder>");
    const report = settleConfirm(folder);
    console.log(
      JSON.stringify({
        complete: report.complete,
        decided: report.decided,
        concerns: report.concerns,
        caught: { comment: report.caught.comment, any: report.caught.any },
        disagreements: report.disagreements.length,
        decoys: report.decoys,
        window: report.window,
      }),
    );
    return;
  }
  if (command === "harness-study") {
    const [items, folder] = rest;
    if (items === undefined || folder === undefined)
      throw new Error("harness-study <items.json> <folder>");
    console.log(JSON.stringify(buildStudy(items, folder)));
    return;
  }
  if (command === "recategorize") {
    const [folder, seed, category = "performance"] = rest;
    const usage = "recategorize <folder> <seed> [category]";
    if (
      folder === undefined ||
      !(category in CATEGORIES) ||
      category === "none"
    )
      throw new Error(`${usage}: the category is one the judge can answer`);
    console.log(
      JSON.stringify(
        buildRecategorize(folder, seedArg(seed, usage), category as Category),
      ),
    );
    return;
  }
  if (command === "recategorize-settle") {
    const [folder] = rest;
    if (folder === undefined) throw new Error("recategorize-settle <folder>");
    console.log(JSON.stringify(settleRecategorize(folder)));
    return;
  }
  if (command === "miss-cause") {
    const [folder] = rest;
    if (folder === undefined) throw new Error("miss-cause <folder>");
    console.log(JSON.stringify(buildMissCause(folder)));
    return;
  }
  if (command === "miss-cause-report") {
    const [folder] = rest;
    if (folder === undefined) throw new Error("miss-cause-report <folder>");
    const report = reportMissCause(folder);
    console.log(
      JSON.stringify({ concerns: report.concerns, totals: report.totals }),
    );
    return;
  }
  if (command === "audit-override") {
    // `audit-override <name> <source>/<number> <item id>`: a label every auditor found wrong (10.136),
    // corrected in the case's evidence without labelling it again.
    const [name, caseArg, itemId] = rest;
    if (name === undefined || caseArg === undefined || itemId === undefined)
      throw new Error("audit-override <name> <source>/<number> <item id>");
    const [source, number] = caseArg.split("/");
    const record = readCase(sourceArg(source), numberArg(number));
    const override = auditOverrideOf(name, record, itemId);
    console.log(
      JSON.stringify({
        caseId: record.caseId,
        cite: override.cite,
        was: override.was,
        lines: recordAuditOverride(record, override),
      }),
    );
    return;
  }
  if (command === "evidence") {
    const { evidence, missing } = writeLineEvidence(
      readCase(sourceArg(rest[0]), numberArg(rest[1])),
    );
    const classes: Record<string, number> = {};
    for (const line of Object.values(evidence.lines))
      classes[line.class] = (classes[line.class] ?? 0) + 1;
    console.log(
      `${evidence.caseId}: ${Object.keys(evidence.lines).length} lines with evidence ${JSON.stringify(classes)}, ${evidence.disputed} disputed, ${missing} threads one pass skipped, kappa ${evidence.labelling.kappa}`,
    );
    return;
  }
  throw new Error(
    "commands: candidates, pick, prepare, check, reclone, rework, concerns, aftermerge, tiebreak, redecide, merit, audit, evidence, match, controls, canary, pin-catalog",
  );
};

await main(process.argv.slice(2));
