import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../../scripts/pi-storage.ts";
import {
  missingOutput,
  outputSyscalls,
  removeOutputEntry,
  withOutputDirectory,
} from "./output-filesystem.ts";

/**
 * The pull-request replay dataset (10.125–10.128): closed changes of open repositories with good
 * review, replayed through `neuve review` at their first revision and compared with how they
 * evolved. Everything it writes lives on the research volume (10.126); this module names where.
 */
/**
 * The research volume's folder, read on every call so tests can point it at a scratch folder. Without
 * `NEUVE_RESEARCH_ROOT` it is the owner's, on the drive of the owner's storage profile.
 */
export const researchRoot = () =>
  process.env["NEUVE_RESEARCH_ROOT"] ??
  join(
    PI_TRANSITION_STORAGE_PROFILE.volume.mountPoint,
    "code",
    "neuve-research",
  );

export const indexDirectory = () => join(researchRoot(), "index");

/**
 * A fresh candidate's run (NEU-58): a changed build's scored review of the replay's cases, kept in a
 * treatment folder outside the research volume, never on it. The research volume is only read.
 */
export const CANDIDATE_RUN = /^candidate-[1-9][0-9]*$/;
/** A reading run (the harness study's, with reasoning summaries): read for Neuve's record, never scored. */
export const READING_RUN = /^reading-[0-9]+$/;

/** A path with its links resolved, through its nearest existing ancestor for a path not made yet. */
const real = (path: string): string => {
  const absolute = resolve(path);
  if (lstatSync(absolute, { throwIfNoEntry: false }) !== undefined)
    return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : join(real(parent), basename(absolute));
};
const within = (path: string, root: string) =>
  path === root || path.startsWith(`${root}${sep}`);

/**
 * The treatment folder, from NEUVE_TREATMENT_ROOT and read on every call, as the research root is:
 * refused unset, as a link, or overlapping the research volume either way.
 */
export const treatmentRoot = () => {
  const given = process.env["NEUVE_TREATMENT_ROOT"];
  if (given === undefined || given === "")
    throw new Error(
      "a candidate run needs NEUVE_TREATMENT_ROOT: its treatment folder outside the research volume",
    );
  if (lstatSync(given, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`NEUVE_TREATMENT_ROOT ${given} is a link`);
  const root = real(given);
  const research = real(researchRoot());
  if (within(root, research) || within(research, root))
    throw new Error(
      `NEUVE_TREATMENT_ROOT ${root} overlaps the research volume ${research}: a treatment stands outside it`,
    );
  return root;
};

/** Whether a treatment folder is set: then labels and operational logs are written under it alone (treatmentWrite, writeRoot). */
export const treating = () =>
  (process.env["NEUVE_TREATMENT_ROOT"] ?? "") !== "";

/**
 * Where operational logs and caches are written (the labeller's events, failures and environment,
 * merit's anchor errors): the treatment folder while one is set, else the research volume.
 */
export const writeRoot = () => (treating() ? treatmentRoot() : researchRoot());

/**
 * A case's run folder: `run/<run>/` in the case's folder, or, for a candidate, the same place under the
 * treatment folder (`<treatment>/cases/<source>/<number>/run/<run>/`). The case's own labels stay in its
 * folder on the research volume.
 */
export const runFolder = (caseDir: string, run: string) => {
  if (/[\0\r\n\\/]/.test(run) || run === "." || run === "..")
    throw new Error("a run name is one path component without traversal");
  if (run.startsWith("candidate-") && !CANDIDATE_RUN.test(run))
    throw new Error(
      "a candidate run takes a positive integer without leading zeros",
    );
  return CANDIDATE_RUN.test(run)
    ? join(
        treatmentRoot(),
        "cases",
        basename(dirname(caseDir)),
        basename(caseDir),
        "run",
        run,
      )
    : join(caseDir, "run", run);
};

/** Refuses a reading run where a run is scored or labelled: it is read for Neuve's record, never scored. */
export const scoredRun = <Run extends string | undefined>(run: Run) => {
  if (run !== undefined && READING_RUN.test(run))
    throw new Error(
      `${run} is a reading run: read for Neuve's record, never scored`,
    );
  return run;
};

/** Admits each concrete candidate destination, including existing or dangling aliases. */
export const treatmentWrite = (path: string) => {
  if (treating()) {
    if (path.includes("\0") || path.split(/[\\/]/).includes(".."))
      throw new Error("an output path has no NUL or parent traversal");
    const root = treatmentRoot();
    const destination = real(path);
    if (!within(destination, root))
      throw new Error(
        `${path} is ${within(destination, real(researchRoot())) ? "on the research volume" : "outside the treatment folder"}: with NEUVE_TREATMENT_ROOT set, labels are written under the treatment only`,
      );
  }
  return path;
};

/** Checks the whole known write plan before labelling; writers still recheck at each write. */
export const admitOutputPlan = (plan: {
  readonly directories: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}) => {
  if (!treating()) return;
  for (const [paths, directory] of [
    [plan.directories, true],
    [plan.files, false],
  ] as const)
    for (const path of paths) {
      const destination = real(treatmentWrite(path));
      const stat = lstatSync(destination, { throwIfNoEntry: false });
      if (
        stat !== undefined &&
        (directory ? !stat.isDirectory() : !stat.isFile())
      )
        throw new Error(
          `${path}: a candidate output must be a ${directory ? "directory" : "regular file"}`,
        );
    }
};

/** The deterministic files left by one model pass, before any result is known. */
export const admitPassOutputs = (runDir: string, log: string) =>
  admitOutputPlan({
    directories: [runDir],
    files: [join(runDir, "schema.json"), join(runDir, "output.json"), log],
  });

export const admitAppendOutput = (path: string) => {
  treatmentWrite(path);
  if (!treating()) return;
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat !== undefined && (!stat.isFile() || stat.nlink !== 1))
    throw new Error(
      `${path}: a candidate log must be a regular file with one link`,
    );
};

const outputTarget = (path: string) => {
  treatmentWrite(path);
  const target = join(real(dirname(path)), basename(path));
  treatmentWrite(target);
  return target;
};

/** Candidate files replace an inode; neither linked outputs nor temporary leaves are truncated. */
export const writeOutput = (
  path: string,
  text: string,
  options?: { mode?: number },
) => {
  if (!treating()) return writeFileSync(path, text, options);
  const target = outputTarget(path);
  withOutputDirectory(dirname(target), false, (parent) => {
    const partial = `.neuve-output-${randomUUID()}`;
    const fd = outputSyscalls.open(
      parent,
      partial,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      options?.mode,
    );
    try {
      try {
        writeFileSync(fd, text);
      } finally {
        closeSync(fd);
      }
      outputSyscalls.rename(parent, partial, basename(target));
    } finally {
      try {
        outputSyscalls.unlink(parent, partial);
      } catch (error) {
        if (!missingOutput(error)) throw error;
      }
    }
  });
};

/** Appends stay bounded in memory and refuse symlinks and shared inodes before the first byte. */
export const appendOutput = (path: string, text: string) => {
  if (!treating()) return appendFileSync(path, text);
  const target = outputTarget(path);
  withOutputDirectory(dirname(target), false, (parent) => {
    const fd = outputSyscalls.open(
      parent,
      basename(target),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error(
          `${path}: a candidate log must be a regular file with one link`,
        );
      appendFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
  });
};

export const makeOutputDirectory = (
  path: string,
  options?: { recursive?: boolean },
) => {
  if (!treating()) return mkdirSync(path, options);
  const target = real(treatmentWrite(path));
  treatmentWrite(target);
  if (options?.recursive)
    return withOutputDirectory(target, true, () => undefined);
  return withOutputDirectory(dirname(target), false, (parent) =>
    outputSyscalls.mkdir(parent, basename(target)),
  );
};

export const removeOutput = (
  path: string,
  options?: { recursive?: boolean; force?: boolean },
) => {
  if (!treating()) return rmSync(path, options);
  const target = outputTarget(path);
  try {
    withOutputDirectory(dirname(target), false, (parent) =>
      removeOutputEntry(
        parent,
        basename(target),
        target,
        options?.recursive ?? false,
      ),
    );
  } catch (error) {
    if (!(options?.force && missingOutput(error))) throw error;
  }
};

export type SourceName =
  | "devtools-frontend"
  | "go"
  | "react-compiler"
  | "react-core"
  | "entire-cli"
  | "t3code";

interface SourceBase {
  readonly name: SourceName;
  /** Where the mirror is cloned from. */
  readonly git: string;
  /** Changes created in [from, to), ISO dates (10.128's windows). */
  readonly window: readonly [string, string];
  /** Whose review the source is chosen for: people only, or bots beside people. */
  readonly review: "people" | "bots-and-people";
}

export interface GerritSource extends SourceBase {
  readonly provider: "gerrit";
  readonly host: string;
  readonly project: string;
}

export interface GitHubSource extends SourceBase {
  readonly provider: "github";
  readonly repo: string;
  /** Extra search qualifiers, such as the compiler's title prefix. */
  readonly query: string;
  /** Keep only pull requests whose files all sit under (or, negated, outside) this prefix. */
  readonly paths?: { readonly prefix: string; readonly inside: boolean };
}

export type Source = GerritSource | GitHubSource;

export const SOURCES: Readonly<Record<SourceName, Source>> = {
  "devtools-frontend": {
    name: "devtools-frontend",
    provider: "gerrit",
    host: "chromium-review.googlesource.com",
    project: "devtools/devtools-frontend",
    git: "https://chromium.googlesource.com/devtools/devtools-frontend",
    window: ["2019-10-01", "2022-01-01"],
    review: "people",
  },
  go: {
    name: "go",
    provider: "gerrit",
    host: "go-review.googlesource.com",
    project: "go",
    git: "https://go.googlesource.com/go",
    window: ["2019-01-01", "2022-01-01"],
    review: "people",
  },
  "react-compiler": {
    name: "react-compiler",
    provider: "github",
    repo: "react/react",
    git: "https://github.com/react/react.git",
    // The compiler has no public review before it was open-sourced in May 2024 (10.128).
    window: ["2024-05-01", "2025-07-01"],
    query: "[compiler] in:title",
    paths: { prefix: "compiler/", inside: true },
    review: "people",
  },
  "react-core": {
    name: "react-core",
    provider: "github",
    repo: "react/react",
    git: "https://github.com/react/react.git",
    window: ["2019-01-01", "2022-01-01"],
    query: "",
    review: "people",
  },
  "entire-cli": {
    name: "entire-cli",
    provider: "github",
    repo: "entireio/cli",
    git: "https://github.com/entireio/cli.git",
    window: ["2026-01-01", "2026-10-01"],
    query: "",
    review: "bots-and-people",
  },
  t3code: {
    name: "t3code",
    provider: "github",
    repo: "pingdotgg/t3code",
    git: "https://github.com/pingdotgg/t3code.git",
    window: ["2026-03-01", "2026-10-01"],
    query: "",
    review: "bots-and-people",
  },
};

/** Changes a person did not author: dependency bots, autorollers and review bots. */
export const isAutomatedAccount = (login: string) =>
  /\[bot\]$|^(copilot|copilot-pull-request-reviewer|dependabot|renovate)$|autoroll|-bot$|^gopherbot$/i.test(
    login,
  );

/** The size a first revision must have to be a case (design §1). */
export const SIZE = {
  minLines: 20,
  maxLines: 600,
  maxFiles: 30,
} as const;

/** Files that never make a case on their own: generated, vendored, lockfiles, translations. */
export const isIncidentalPath = (path: string) =>
  /(^|\/)(third_party|vendor|node_modules|__generated__|generated)\//.test(
    path,
  ) ||
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|DEPS)$/.test(
    path,
  ) ||
  /\.(snap|min\.js|map)$/.test(path) ||
  /(^|\/)(locales?|i18n)\/.*\.(json|xtb|grd)$/.test(path);

export const caseDirectory = (source: SourceName, number: number) =>
  join(researchRoot(), "cases", source, String(number));

/**
 * Where a run of a case keeps its matching and merit (parity, 10.141): the case's `labels/` for its first
 * run (`run/show.json`), or `run/<run>/labels/` for another run folder of the case (`run/<run>/show.json`):
 * a repeat (cloud-2), the first run matched again (cloud), a fresh baseline or a candidate (a fresh
 * candidate's folder is its treatment's, runFolder). A reading run is never labelled. The concern
 * labels and the rework map stay in the case's `labels/` (`caseLabels`), shared by every run: each run
 * faces the same reviewer concerns, so each counts the same substantive set.
 */
export const runPaths = (source: SourceName, number: number, run?: string) => {
  const directory = caseDirectory(source, number);
  const caseLabels = join(directory, "labels");
  scoredRun(run);
  if (run === undefined)
    return {
      labels: caseLabels,
      show: join(directory, "run", "show.json"),
      caseLabels,
    };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(run))
    throw new Error(`${run} is not a run folder's name`);
  return {
    labels: join(runFolder(directory, run), "labels"),
    show: join(runFolder(directory, run), "show.json"),
    caseLabels,
  };
};

export const mirrorPath = (source: Source) =>
  join(
    researchRoot(),
    "mirrors",
    `${source.provider === "github" ? source.repo.replace("/", "__") : source.project.replace(/\//g, "__")}.git`,
  );
