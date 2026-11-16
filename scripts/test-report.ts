// After the whole test pool drains, rerun each failed test file once, alone, and report every failure by name.
// Ruling (13 November): the run stays non-zero whenever anything failed in the pool, whatever the reruns say.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { runTestProcess, singleFileArgs } from "./test-process.ts";

export const RUN_DIRECTORY_ENV = "NEUVE_TEST_RUN_DIRECTORY";
export const RERUN_FILE_ENV = "NEUVE_TEST_RERUN_FILE";
export const REPORT_ENV = "NEUVE_TEST_REPORT";
export const PASSED_ALONE = "FAILED UNDER LOAD, PASSED ALONE";
export const FAILED_AGAIN = "FAILED AGAIN ALONE";
export const MAX_RERUN_FILES = 10;
/** Nested runs (tests that start launchers or pools) must not write into, or report for, the outer run. */
export const outerRunEnv = {
  [RUN_DIRECTORY_ENV]: undefined,
  [RERUN_FILE_ENV]: undefined,
  [REPORT_ENV]: undefined,
};
const guard = join(import.meta.dir, "test-guard.ts");

const failLine = z.object({
  at: z.number(),
  load1: z.number(),
  line: z.string(),
});
const shardRecord = z.object({
  shard: z.string().nullable(),
  junit: z.string().nullable(),
  code: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  fails: z.array(failLine),
  errors: z.number(),
});
const launchRecord = z.object({
  kind: z.literal("launcher"),
  package: z.string().nullable(),
  cwd: z.string(),
  shards: z.array(shardRecord),
});
const packageRecord = z.object({
  name: z.string(),
  cwd: z.string(),
  mode: z.enum(["launcher", "bun-test", "other"]),
  args: z.array(z.string()).nullable(),
  code: z.number(),
  startedAt: z.number(),
  endedAt: z.number(),
  junit: z.string().nullable(),
  fails: z.array(failLine),
  errors: z.number(),
});
const poolRecord = z.object({
  kind: z.literal("pool"),
  stopped: z.number(),
  packages: z.array(packageRecord),
});
type FailLine = z.infer<typeof failLine>;
type ShardRecord = z.infer<typeof shardRecord>;
type LaunchRecord = z.infer<typeof launchRecord>;
export type PackageRecord = z.infer<typeof packageRecord>;

const writeJson = (path: string, value: unknown) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  // Rename keeps a reader from seeing half a record.
  renameSync(temporary, path);
};

/** A `(fail)` line, timed and loaded the moment it arrives; the text only joins it to a JUnit name. */
export const failLineOf = (line: string): FailLine | undefined => {
  const plain = Bun.stripANSI(line).trim();
  if (!/^\(fail\) /.test(plain)) return undefined;
  return { at: Date.now(), load1: loadavg()[0] ?? 0, line: plain };
};

/**
 * Bun's closing "N error" count: errors outside any test, such as a file that fails to load. JUnit leaves those
 * files out entirely, so this count is the only sign of them.
 */
export const errorCountOf = (line: string) => {
  const match = Bun.stripANSI(line).match(/^\s*(\d+) errors?$/);
  return match ? Number(match[1]) : undefined;
};

/** Splits a package's test script when it is a plain `bun test …` command with no shell syntax. */
export const plainBunTestArgs = (script: string) => {
  const words = script.trim().split(/\s+/);
  if (words[0] !== "bun" || words[1] !== "test") return undefined;
  if (words.some((word) => /["'`$\\|&;<>(){}*?!~]/.test(word)))
    return undefined;
  return words.slice(2);
};
const hasReporter = (args: string[]) =>
  args.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="));
export const junitArgs = (path: string) => [
  "--reporter=junit",
  `--reporter-outfile=${path}`,
];

/** The launcher's side: JUnit per bun test process, its live `(fail)` lines, and one record per launcher. */
export const launchRecorder = (testArgs: string[]) => {
  const directory = process.env[RUN_DIRECTORY_ENV];
  if (!directory) return undefined;
  mkdirSync(join(directory, "junit"), { recursive: true });
  const record: LaunchRecord = {
    kind: "launcher",
    package: process.env.npm_package_name ?? null,
    cwd: process.cwd(),
    shards: [],
  };
  const path = join(directory, `launch-${process.pid}.json`);
  const save = () => writeJson(path, record);
  // A caller's own reporter wins; the report then names that process's failures "not named".
  const junit = !hasReporter(testArgs);
  return {
    run: async (
      shard: string | null,
      command: string[],
      input: Parameters<typeof runTestProcess>[1],
    ) => {
      const entry: ShardRecord = {
        shard,
        junit: junit
          ? join(
              directory,
              "junit",
              `${process.pid}-${shard?.replace("/", "-of-") ?? "all"}.xml`,
            )
          : null,
        code: null,
        startedAt: Date.now(),
        endedAt: null,
        fails: [],
        errors: 0,
      };
      record.shards.push(entry);
      save();
      try {
        entry.code = await runTestProcess(
          entry.junit ? [...command, ...junitArgs(entry.junit)] : command,
          {
            ...input,
            env: { ...input.env, ...outerRunEnv },
            tee: (line) => {
              const fail = failLineOf(line);
              if (fail) entry.fails.push(fail);
              entry.errors = errorCountOf(line) ?? entry.errors;
            },
          },
        );
        return entry.code;
      } finally {
        entry.endedAt = Date.now();
        save();
      }
    },
  };
};

// JUnit (Bun 1.4.4): <testsuites><testsuite name=file file=…><testsuite name=describe>…<testcase name classname time file line>
type Element = {
  name: string;
  attributes: Record<string, string>;
  children: Element[];
};
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) =>
    entity.startsWith("#x") || entity.startsWith("#X")
      ? String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      : entity.startsWith("#")
        ? String.fromCodePoint(Number(entity.slice(1)))
        : (entities[entity] ?? whole),
  );
const parseXml = (xml: string): Element => {
  const root: Element = { name: "#document", attributes: {}, children: [] };
  const stack = [root];
  const tag =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const match of xml.matchAll(tag)) {
    const [, closing, name, attributeText, selfClosing] = match;
    if (name === undefined) continue;
    const parent = stack.at(-1);
    if (!parent) throw new Error("Malformed JUnit report");
    if (closing) {
      if (parent.name !== name || stack.length === 1)
        throw new Error(`Malformed JUnit report: unexpected </${name}>`);
      stack.pop();
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of (attributeText ?? "").matchAll(
      /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    ))
      attributes[attribute[1] ?? ""] = decode(
        attribute[2] ?? attribute[3] ?? "",
      );
    const element = { name, attributes, children: [] };
    parent.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 1) throw new Error("Malformed JUnit report: unclosed");
  return root;
};

export type JunitCase = {
  file: string;
  /** Describe blocks and the test, joined the way Bun prints them: `outer > inner > test`. */
  name: string;
  leaf: string;
  seconds: number;
  status: "passed" | "failed" | "skipped";
};
/** Every test case in report order, with its file relative to the bun test process's cwd. */
export const parseJunit = (xml: string): JunitCase[] => {
  const cases: JunitCase[] = [];
  // A file is a <testsuite> directly under <testsuites>; each nested <testsuite> is a describe block.
  // Bun's classname lists the describes innermost first, so the name is built from the nesting instead.
  const walk = (element: Element, file: string | undefined, path: string[]) => {
    for (const child of element.children) {
      if (child.name === "testsuites") walk(child, undefined, []);
      else if (child.name === "testsuite")
        walk(
          child,
          file ?? child.attributes.file ?? child.attributes.name,
          file === undefined ? [] : [...path, child.attributes.name ?? ""],
        );
      else if (child.name === "testcase") {
        const leaf = child.attributes.name ?? "";
        const failed = child.children.some(
          (grand) => grand.name === "failure" || grand.name === "error",
        );
        const skipped = child.children.some(
          (grand) => grand.name === "skipped",
        );
        cases.push({
          file: child.attributes.file ?? file ?? "",
          name: [...path, leaf].join(" > "),
          leaf,
          seconds: Number(child.attributes.time ?? 0) || 0,
          status: failed ? "failed" : skipped ? "skipped" : "passed",
        });
      }
    }
  };
  walk(parseXml(xml), undefined, []);
  return cases;
};
const readJunit = (path: string | null) => {
  if (path === null || !existsSync(path)) return undefined;
  try {
    return parseJunit(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

export type Target =
  | { kind: "file"; via: "script"; script: string; cwd: string; file: string }
  | { kind: "file"; via: "bun-test"; args: string[]; cwd: string; file: string }
  | {
      kind: "package";
      script: string;
      cwd: string;
      args: string[] | null;
    }
  | { kind: "none"; reason: string };
export type Failure = {
  package: string;
  cwd: string;
  file: string | null;
  test: string | null;
  note: string | null;
  at: number | null;
  load1: number | null;
  timing: "fail line" | "estimate" | "none";
  /** Seconds of the process's wall time the JUnit durations don't cover: an estimate's error bound. */
  uncertaintySeconds: number | null;
  /**
   * Which of the same-named cases in its file this is, counting every case in the pool's report (passed ones
   * too): test.each rows and repeated test("x") share a name, and the rerun is matched by this position.
   */
  occurrence: { index: number; of: number } | null;
  target: Target;
};
export type Sample = { at: number; load1: number };
const nearest = (samples: Sample[], at: number) =>
  samples.reduce<Sample | undefined>(
    (best, sample) =>
      best === undefined || Math.abs(sample.at - at) < Math.abs(best.at - at)
        ? sample
        : best,
    undefined,
  );
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** `(fail) <name>` then Bun's ` [1.23ms]`: the exact name, so `each 1` never takes `each 10`'s line. */
const isFailLineOf = (fail: FailLine, name: string) =>
  fail.line === `(fail) ${name}` || fail.line.startsWith(`(fail) ${name} [`);

/** Names each failed test of one bun test process and gives it the time and load of its `(fail)` line. */
const processFailures = (input: {
  package: string;
  cwd: string;
  junit: string | null;
  code: number | null;
  startedAt: number;
  endedAt: number | null;
  fails: FailLine[];
  errors: number;
  fileTarget: (file: string) => Target;
  wholeTarget: Target;
  label: string;
  samples: Sample[];
}): Failure[] => {
  const cases = readJunit(input.junit);
  const notNamed = (note: string): Failure => {
    const first = input.fails[0];
    return {
      package: input.package,
      cwd: input.cwd,
      file: null,
      test: null,
      note,
      at: first?.at ?? input.endedAt ?? input.startedAt,
      load1:
        first?.load1 ??
        nearest(input.samples, input.endedAt ?? input.startedAt)?.load1 ??
        null,
      timing: first ? "fail line" : "estimate",
      uncertaintySeconds: null,
      occurrence: null,
      target: input.wholeTarget,
    };
  };
  if (cases === undefined)
    return input.code === 0
      ? []
      : [
          notNamed(
            `${input.label} ended with exit ${input.code ?? "unknown"} and no readable JUnit report${input.fails.length ? ` (${input.fails.length} (fail) lines)` : ""}`,
          ),
        ];
  const accounted = cases.reduce((sum, item) => sum + item.seconds, 0);
  const wall =
    input.endedAt === null ? null : (input.endedAt - input.startedAt) / 1000;
  const uncertainty = wall === null ? null : Math.max(0, wall - accounted);
  const failures: Failure[] = [];
  const caseKey = (item: JunitCase) => `${item.file}\0${item.name}`;
  const named = new Map<string, number>();
  for (const item of cases)
    named.set(caseKey(item), (named.get(caseKey(item)) ?? 0) + 1);
  const seen = new Map<string, number>();
  let elapsed = 0;
  let line = 0;
  for (const item of cases) {
    elapsed += item.seconds;
    const occurrence = {
      index: seen.get(caseKey(item)) ?? 0,
      of: named.get(caseKey(item)) ?? 1,
    };
    seen.set(caseKey(item), occurrence.index + 1);
    if (item.status !== "failed") continue;
    const index = input.fails.findIndex(
      (fail, position) => position >= line && isFailLineOf(fail, item.name),
    );
    const joined = index === -1 ? undefined : input.fails[index];
    if (joined) line = index + 1;
    const at = joined?.at ?? input.startedAt + elapsed * 1000;
    failures.push({
      package: input.package,
      cwd: input.cwd,
      file: item.file,
      test: item.name,
      note: null,
      at,
      load1: joined?.load1 ?? nearest(input.samples, at)?.load1 ?? null,
      timing: joined ? "fail line" : "estimate",
      uncertaintySeconds: joined ? null : uncertainty,
      occurrence,
      target: input.fileTarget(item.file),
    });
  }
  if (input.errors > 0)
    failures.push(
      notNamed(
        `${input.label} reported ${input.errors} error${input.errors === 1 ? "" : "s"} outside any test, which JUnit leaves out (a file that failed to load, or an error between tests)`,
      ),
    );
  else if (failures.length === 0 && input.code !== 0)
    failures.push(
      notNamed(
        `${input.label} ended with exit ${input.code ?? "unknown"} but its JUnit report has no failed test`,
      ),
    );
  return failures;
};

const readRecords = (directory: string) => {
  const launches: LaunchRecord[] = [];
  let pool: z.infer<typeof poolRecord> | undefined;
  if (!existsSync(directory)) return { launches, pool };
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(readFileSync(join(directory, name), "utf8"));
    if (name.startsWith("launch-")) launches.push(launchRecord.parse(value));
    else if (name.startsWith("pool-")) pool = poolRecord.parse(value);
  }
  return { launches, pool };
};
export const writePoolRecord = (
  directory: string,
  stopped: number,
  packages: PackageRecord[],
) =>
  writeJson(join(directory, `pool-${process.pid}.json`), {
    kind: "pool",
    stopped,
    packages,
  });

/** Every failure in a run directory, in the order it happened. */
export const collectFailures = (
  directory: string,
  samples: Sample[],
  runCode: number,
  /** The root runner's own launcher script; a pool owner has none. */
  root?: { cwd: string; script: string },
) => {
  const { launches, pool } = readRecords(directory);
  const failures: Failure[] = [];
  const packageAt = new Map(
    (pool?.packages ?? []).map((pkg) => [real(pkg.cwd), pkg]),
  );
  const launched = new Set<string>();
  for (const launch of launches) {
    const cwd = real(launch.cwd);
    launched.add(cwd);
    const pkg = packageAt.get(cwd);
    const name = pkg?.name ?? launch.package ?? relative(process.cwd(), cwd);
    // Never the launcher's npm_lifecycle_event: under `bun run --sequential` it names the outer script
    // ("test"), and rerunning that would start the whole run again inside itself.
    const script = pkg
      ? "test"
      : root && real(root.cwd) === cwd
        ? root.script
        : null;
    for (const shard of launch.shards)
      failures.push(
        ...processFailures({
          package: name,
          cwd,
          junit: shard.junit,
          code: shard.code,
          startedAt: shard.startedAt,
          endedAt: shard.endedAt,
          fails: shard.fails,
          errors: shard.errors,
          label: shard.shard ? `Shard ${shard.shard}` : "The test process",
          samples,
          fileTarget: (file) =>
            script === null
              ? { kind: "none", reason: "no known script runs this launcher" }
              : { kind: "file", via: "script", script, cwd, file },
          wholeTarget:
            script === null
              ? { kind: "none", reason: "no known script runs this launcher" }
              : { kind: "package", script, cwd, args: null },
        }),
      );
  }
  for (const pkg of pool?.packages ?? []) {
    const cwd = real(pkg.cwd);
    if (pkg.code === 0) continue;
    const named = failures.some((failure) => failure.cwd === cwd);
    if (pkg.mode === "bun-test" && pkg.args) {
      const args = pkg.args;
      failures.push(
        ...processFailures({
          package: pkg.name,
          cwd,
          junit: pkg.junit,
          code: pkg.code,
          startedAt: pkg.startedAt,
          endedAt: pkg.endedAt,
          fails: pkg.fails,
          errors: pkg.errors,
          label: "The package's bun test",
          samples,
          fileTarget: (file) => ({
            kind: "file",
            via: "bun-test",
            args,
            cwd,
            file,
          }),
          wholeTarget: { kind: "package", script: "test", cwd, args },
        }),
      );
    } else if (!named) {
      const first = pkg.fails[0];
      failures.push({
        package: pkg.name,
        cwd,
        file: null,
        test: null,
        note:
          pkg.mode === "other"
            ? `exit ${pkg.code}; the package's test script is neither the launcher nor a plain bun test, so nothing names its tests`
            : `exit ${pkg.code}${launched.has(cwd) ? " with no failed test in its launcher's reports" : "; its launcher left no record"}`,
        at: first?.at ?? pkg.endedAt,
        load1: first?.load1 ?? nearest(samples, pkg.endedAt)?.load1 ?? null,
        timing: first ? "fail line" : "estimate",
        uncertaintySeconds: null,
        occurrence: null,
        target: { kind: "package", script: "test", cwd, args: null },
      });
    }
  }
  if (failures.length === 0 && runCode !== 0)
    failures.push({
      package: "(run)",
      cwd: process.cwd(),
      file: null,
      test: null,
      note: `the run exited ${runCode} and no record names a failing test or package`,
      at: Date.now(),
      load1: loadavg()[0] ?? null,
      timing: "none",
      uncertaintySeconds: null,
      occurrence: null,
      target: {
        kind: "none",
        reason: "no record names what failed",
      },
    });
  failures.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return { failures, interrupted: (pool?.stopped ?? 0) !== 0 };
};

const targetKey = (target: Target) =>
  target.kind === "file"
    ? `file\0${target.cwd}\0${resolve(target.cwd, target.file)}`
    : target.kind === "package"
      ? `package\0${target.cwd}`
      : `none\0${target.reason}`;

export type Rerun = {
  code: number;
  cases: JunitCase[] | undefined;
  startedAt: number;
  endedAt: number;
  loadAtStart: number;
  loadAtEnd: number;
};
export type Outcome = Failure & {
  label: typeof PASSED_ALONE | typeof FAILED_AGAIN | "not rerun";
  reason: string | null;
  rerun: Omit<Rerun, "cases"> | null;
};

/**
 * The label rule: a named test passed alone only if the rerun's report has that same case passing; an unnamed
 * unit only on exit 0. Same-named cases are matched by position among all of them, passed ones included; when
 * the pool and the rerun have different numbers of them the match is not guessed.
 */
export const labelFailure = (
  failure: Failure,
  rerun: Rerun,
): Pick<Outcome, "label" | "reason"> => {
  if (failure.test === null)
    return rerun.code === 0
      ? { label: PASSED_ALONE, reason: null }
      : { label: FAILED_AGAIN, reason: `rerun exit ${rerun.code}` };
  const file =
    failure.file === null ? null : resolve(failure.cwd, failure.file);
  const same = (rerun.cases ?? []).filter(
    (item) =>
      item.name === failure.test &&
      (file === null || resolve(failure.cwd, item.file) === file),
  );
  const exit = rerun.code === 0 ? null : `rerun exit ${rerun.code}`;
  if (same.length === 0)
    return {
      label: FAILED_AGAIN,
      reason: `not in the rerun's report (rerun exit ${rerun.code})`,
    };
  const occurrence = failure.occurrence ?? { index: 0, of: 1 };
  if (same.length !== occurrence.of) {
    const unmatched = `${occurrence.of} test${occurrence.of === 1 ? "" : "s"} of this name in the pool's report and ${same.length} in the rerun's, so not matched one to one`;
    return same.every((item) => item.status === "passed")
      ? {
          label: PASSED_ALONE,
          reason: [unmatched, exit].filter(Boolean).join("; "),
        }
      : {
          label: FAILED_AGAIN,
          reason: `${unmatched}; ${same.some((item) => item.status === "failed") ? "one failed in the rerun" : "not all passed in the rerun"}`,
        };
  }
  const match = same[occurrence.index];
  if (match?.status === "passed") return { label: PASSED_ALONE, reason: exit };
  return {
    label: FAILED_AGAIN,
    reason: `${match?.status ?? "missing"} in the rerun`,
  };
};

/** Plans and runs the reruns, prints the block and the JSON summary, and returns the run's exit code. */
export const finishRun = async (input: {
  directory: string;
  samples: Sample[];
  runCode: number;
  interrupted: boolean;
  /** Reads this run's stop signal; reruns stop when it is set. */
  stopped: () => number;
  report?: string;
  root?: { cwd: string; script: string };
  rerun?: (target: Target, directory: string, name: string) => Promise<Rerun>;
  print?: (line: string) => void;
}) => {
  const print = input.print ?? ((line: string) => console.log(line));
  const collected = collectFailures(
    input.directory,
    input.samples,
    input.runCode,
    input.root,
  );
  const failures = collected.failures;
  const interrupted = input.interrupted || collected.interrupted;
  const units: { key: string; target: Target; failures: Failure[] }[] = [];
  for (const failure of failures) {
    const key = targetKey(failure.target);
    const unit = units.find((candidate) => candidate.key === key);
    if (unit) unit.failures.push(failure);
    else units.push({ key, target: failure.target, failures: [failure] });
  }
  const rerunnable = units.filter((unit) => unit.target.kind !== "none");
  const tooMany = rerunnable.length > MAX_RERUN_FILES;
  const outcomes: Outcome[] = [];
  const notRerun = (failure: Failure, reason: string) =>
    outcomes.push({ ...failure, label: "not rerun", reason, rerun: null });
  if (failures.length > 0 && !interrupted && rerunnable.length > 0)
    print(
      `\n[test-report] Rerunning ${Math.min(rerunnable.length, MAX_RERUN_FILES)} failed test file${rerunnable.length === 1 ? "" : "s"} alone, one at a time, after the pool`,
    );
  let rerunIndex = 0;
  let stoppedDuringReruns = 0;
  for (const unit of units) {
    if (unit.target.kind === "none") {
      for (const failure of unit.failures)
        notRerun(failure, unit.target.reason);
      continue;
    }
    if (interrupted) {
      for (const failure of unit.failures)
        notRerun(failure, "the pool was interrupted");
      continue;
    }
    if (rerunIndex >= MAX_RERUN_FILES) {
      for (const failure of unit.failures)
        notRerun(
          failure,
          `more than ${MAX_RERUN_FILES} files failed; that many failing files is not load`,
        );
      continue;
    }
    if (stoppedDuringReruns || input.stopped()) {
      stoppedDuringReruns ||= input.stopped();
      for (const failure of unit.failures)
        notRerun(failure, "interrupted during the reruns");
      continue;
    }
    rerunIndex++;
    const rerunDirectory = join(input.directory, `rerun-${rerunIndex}`);
    mkdirSync(rerunDirectory, { recursive: true });
    const result = await (input.rerun ?? rerunAlone)(
      unit.target,
      rerunDirectory,
      unit.failures[0]?.package ?? "",
    );
    if (input.stopped()) {
      stoppedDuringReruns = input.stopped();
      for (const failure of unit.failures)
        notRerun(failure, "interrupted during its rerun");
      continue;
    }
    for (const failure of unit.failures) {
      const { cases: _cases, ...rerun } = result;
      outcomes.push({
        ...failure,
        ...labelFailure(failure, result),
        rerun,
      });
    }
  }
  outcomes.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const clock = (at: number | null) =>
    at === null ? "unknown time" : new Date(at).toTimeString().slice(0, 8);
  const load = (value: number | null | undefined) =>
    value === null || value === undefined ? "unknown" : value.toFixed(2);
  const fileCount = new Set(
    failures.map((failure) =>
      failure.file === null
        ? `${failure.cwd}\0(whole)`
        : resolve(failure.cwd, failure.file),
    ),
  ).size;
  const count = (label: Outcome["label"]) =>
    outcomes.filter((outcome) => outcome.label === label).length;
  const exitCode =
    stoppedDuringReruns ||
    (input.runCode !== 0 ? input.runCode : failures.length > 0 ? 1 : 0);
  print("");
  if (failures.length === 0)
    print("[test-report] No test failed in the pool; nothing to rerun.");
  else {
    print(
      "[test-report] Failed in the pool (label | package | file | test | pool 1-minute load | rerun 1-minute load):",
    );
    for (const outcome of outcomes) {
      const where = outcome.file ?? "(whole package)";
      const what = outcome.test ?? `(not named: ${outcome.note})`;
      const pool = `pool load ${load(outcome.load1)} at ${clock(outcome.at)}${outcome.timing === "estimate" && outcome.uncertaintySeconds !== null ? ` (time estimated, up to ${outcome.uncertaintySeconds.toFixed(0)} s late)` : ""}`;
      print(
        outcome.label === "not rerun"
          ? `not rerun | ${outcome.package} | ${where} | ${what} | ${pool} | ${outcome.reason}`
          : `${outcome.label} | ${outcome.package} | ${where} | ${what} | ${pool} | rerun load ${load(outcome.rerun?.loadAtEnd)}${outcome.reason ? ` (${outcome.reason})` : ""}`,
      );
    }
    if (tooMany && !interrupted)
      print(
        `[test-report] ${rerunnable.length} files failed: more than ${MAX_RERUN_FILES} failing files is not load, so only the first ${MAX_RERUN_FILES} ran again.`,
      );
    print(
      `[test-report] ${failures.length} failed in the pool across ${fileCount} file${fileCount === 1 ? "" : "s"}: ${count(PASSED_ALONE)} failed under load, passed alone; ${count(FAILED_AGAIN)} failed again alone; ${count("not rerun")} not rerun.`,
    );
  }
  const report =
    input.report ??
    join(
      tmpdir(),
      `neuve-test-report-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`,
    );
  try {
    writeFileSync(
      report,
      JSON.stringify(
        {
          exitCode,
          interrupted: interrupted || stoppedDuringReruns !== 0,
          maxRerunFiles: MAX_RERUN_FILES,
          counts: {
            failed: failures.length,
            files: fileCount,
            passedAlone: count(PASSED_ALONE),
            failedAgainAlone: count(FAILED_AGAIN),
            notRerun: count("not rerun"),
          },
          failures: outcomes.map(({ target, ...outcome }) => ({
            ...outcome,
            rerunUnit:
              target.kind === "file"
                ? resolve(target.cwd, target.file)
                : target.kind === "package"
                  ? `${target.cwd} (whole package)`
                  : null,
          })),
          samples: input.samples,
        },
        null,
        2,
      ),
    );
    print(`[test-report] Summary: ${report}`);
  } catch (error) {
    print(
      `[test-report] Could not write the summary to ${report}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (failures.length > 0)
    print(
      `[test-report] Exit ${exitCode}: tests failed in the pool, so the run fails whatever the reruns showed.`,
    );
  return exitCode;
};

/** Reruns one unit the way the pool first ran it: same cwd, environment and launcher options, shards off. */
export const rerunAlone = async (
  target: Target,
  directory: string,
  name: string,
): Promise<Rerun> => {
  const startedAt = Date.now();
  const loadAtStart = loadavg()[0] ?? 0;
  const budget = join(directory, "budget");
  mkdirSync(budget, { recursive: true });
  const junit = join(directory, "junit.xml");
  let command: string[];
  let env: Record<string, string | undefined> = {
    ...outerRunEnv,
    [RUN_DIRECTORY_ENV]: directory,
  };
  let label: string;
  if (target.kind === "file" && target.via === "script") {
    command = [process.execPath, "run", target.script];
    env[RERUN_FILE_ENV] = resolve(target.cwd, target.file);
    label = target.file;
  } else if (target.kind === "file") {
    // A package without the launcher (graph-client's --parallel coordinator): its own bun test, that file alone.
    command = [
      process.execPath,
      "test",
      ...singleFileArgs(target.args, resolve(target.cwd, target.file)),
      ...junitArgs(junit),
    ];
    env = { ...outerRunEnv };
    label = target.file;
  } else if (target.kind === "package") {
    command = [
      process.execPath,
      "run",
      target.script,
      ...(target.args && !hasReporter(target.args) ? junitArgs(junit) : []),
    ];
    if (target.args) env = { ...outerRunEnv };
    label = "(whole package)";
  } else throw new Error(target.reason);
  const cwd = target.cwd;
  console.log(`[test-report] Rerun alone: ${name} ${label}`);
  let code = 1;
  try {
    code = await runTestProcess([process.execPath, guard, ...command], {
      directory: budget,
      cwd,
      stopGraceMs: 5000,
      env,
      onLine: (line) => console.log(`rerun ${name} | ${line}`),
    });
  } catch (error) {
    console.error(
      `rerun ${name} | ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { launches } = readRecords(directory);
  const cases = [
    ...(readJunit(junit) ?? []),
    ...launches.flatMap((launch) =>
      launch.shards.flatMap((shard) =>
        (readJunit(shard.junit) ?? []).map((item) => ({
          ...item,
          file: isAbsolute(item.file)
            ? item.file
            : resolve(launch.cwd, item.file),
        })),
      ),
    ),
  ].map((item) => ({ ...item, file: resolve(cwd, item.file) }));
  return {
    code,
    cases: cases.length > 0 ? cases : undefined,
    startedAt,
    endedAt: Date.now(),
    loadAtStart,
    loadAtEnd: loadavg()[0] ?? 0,
  };
};

/** Samples the 1-minute load every 5 s for the whole run, reruns included. */
export const loadSampler = () => {
  const samples: Sample[] = [];
  const sample = () =>
    samples.push({ at: Date.now(), load1: loadavg()[0] ?? 0 });
  sample();
  const timer = setInterval(sample, 5000);
  timer.unref();
  return {
    samples,
    stop: () => {
      clearInterval(timer);
      sample();
    },
  };
};
