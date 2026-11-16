import { closeSync, constants, writeFileSync } from "node:fs";
import {
  outputSyscalls,
  withOutputDirectory,
} from "../pr-replay/output-filesystem.ts";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  parityEntries,
  type ParityEntry,
} from "../harness-compare/full-test/parity.ts";
import {
  CANDIDATE_RUN,
  researchRoot,
  treating,
  treatmentRoot,
} from "../pr-replay/sources.ts";
import { loadSessionDumpReader, type SessionDumpReader } from "./capture.ts";
import { compareCandidate, reportMarkdown } from "./compare.ts";
import {
  collectManifest,
  EffortComparison,
  fileId,
  Manifest,
  MANIFEST_VERSION,
  verifyManifest,
} from "./manifest.ts";

/**
 * The fresh candidate's local collector and comparison (NEU-58). It reads the research volume and the
 * treatment folder, writes only the files it is told to, once, outside the research volume, and calls
 * no model.
 *
 * - `manifest baseline --sample <file> --floor <run>:<run>[,…] --out <file>`: the sample's cases with
 *   their first run, plus the full development floor universe and its runs, every scoring input pinned.
 * - `manifest inventory --out <file> [--runs first,cloud,…]`: every case with a replay run (run/cloud),
 *   the same records, for the corpus's counts.
 * - `manifest candidate --sample <file> --run candidate-<k> --out <file>`: the candidate's runs of the
 *   sample's cases, from NEUVE_TREATMENT_ROOT, with their builds, policy and session dumps.
 * - `verify <manifest>`: every file hashed again; any change, loss or new file fails.
 * - `compare --baseline <manifest> --candidate <manifest> --out <folder>`: both verified, then the
 *   existing parity comparison and the candidate's report, written to a fresh folder.
 */

const ParitySample = z.object({
  seed: z.string(),
  concerns: z.array(z.string()),
  controls: z.array(z.string()),
});

const flag = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const required = (args: ReadonlyArray<string>, name: string, usage: string) => {
  const value = flag(args, name);
  if (value === undefined) throw new Error(`${usage}: ${name} is required`);
  return value;
};

const outputPath = (path: string): string => {
  const absolute = resolve(path);
  if (lstatSync(absolute, { throwIfNoEntry: false }) !== undefined)
    return realpathSync(absolute);
  return join(outputPath(dirname(absolute)), basename(absolute));
};

/** A path this collector may write: outside the research volume, and new. */
const freshOutput = (path: string) => {
  const target = outputPath(path);
  const research = outputPath(researchRoot());
  if (target === research || target.startsWith(`${research}${sep}`))
    throw new Error(
      `${target} is inside the research volume, which is only read`,
    );
  if (existsSync(target))
    throw new Error(`${target} exists: a manifest or report is written once`);
  return target;
};

const writeOnce = (path: string, text: string) => {
  const target = freshOutput(path);
  withOutputDirectory(dirname(target), true, (parent) => {
    const fd = outputSyscalls.open(
      parent,
      basename(target),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
    );
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
  });
};

const casesOf = () => {
  const all = parityEntries(join(researchRoot(), "cases"));
  return {
    all,
    byId: new Map(all.map((entry) => [entry.record.caseId, entry])),
  };
};

const sampleOf = (path: string) => {
  const sample = ParitySample.parse(JSON.parse(readFileSync(path, "utf8")));
  const { byId } = casesOf();
  const entries = [...sample.concerns, ...sample.controls].map((id) => {
    const entry = byId.get(id);
    if (entry === undefined) throw new Error(`${id} is no case on the volume`);
    return entry;
  });
  return { sample, entries, controls: new Set(sample.controls) };
};

const floorRuns = (pairs: string) => {
  const runs = pairs.split(",").flatMap((pair) => {
    const [a, b] = pair.split(":");
    if (a === undefined || b === undefined || a === b)
      throw new Error(`--floor takes <run>:<run> pairs, got ${pair}`);
    return [a, b];
  });
  return [...new Set(runs)];
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const readManifest = (path: string) => {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const version = z.object({ version: z.number() }).parse(raw).version;
  if (version !== MANIFEST_VERSION)
    throw new Error(
      `${path}: manifest version ${version} does not pin public capture revalidation; re-collect with the same sample and floor`,
    );
  return Manifest.parse(raw);
};

export const candidateMain = async (
  args: ReadonlyArray<string>,
  deps: {
    readonly now?: () => string;
    /** The capture lane's public reader; tests hand it a literal dump. */
    readonly reader?: () => Promise<SessionDumpReader | string>;
  } = {},
) => {
  const now = deps.now ?? (() => new Date().toISOString());
  const reader = deps.reader ?? loadSessionDumpReader;
  const [command, kind] = args;
  const effortComparison = args.includes("--effort-comparison")
    ? EffortComparison.parse(
        required(args, "--effort-comparison", "--effort-comparison low|medium"),
      )
    : undefined;
  if (
    effortComparison !== undefined &&
    command !== "compare" &&
    !(command === "manifest" && kind === "candidate")
  )
    throw new Error("--effort-comparison is for manifest candidate or compare");
  if (command === "manifest") {
    const usage = `manifest ${kind}`;
    const out = freshOutput(required(args, "--out", usage));
    let input: {
      entries: ReadonlyArray<ParityEntry>;
      controls: ReadonlySet<string>;
      runs: ReadonlyArray<string>;
      floor: ReadonlyArray<string> | null;
      sample: { path: string; seed: string } | null;
    };
    if (kind === "baseline" || kind === "candidate") {
      const samplePath = resolve(required(args, "--sample", usage));
      const { sample, entries, controls } = sampleOf(samplePath);
      if (kind === "baseline") {
        const floor = required(args, "--floor", usage).split(",");
        input = {
          entries,
          controls,
          runs: [
            "first",
            ...floorRuns(floor.join(",")).filter((r) => r !== "first"),
          ],
          floor,
          sample: { path: samplePath, seed: sample.seed },
        };
      } else {
        const run = required(args, "--run", usage);
        if (!CANDIDATE_RUN.test(run))
          throw new Error(
            `--run takes candidate-<k> with a positive integer and no leading zeros, not ${run}`,
          );
        treatmentRoot();
        input = {
          entries,
          controls,
          runs: [run],
          floor: null,
          sample: { path: samplePath, seed: sample.seed },
        };
      }
    } else if (kind === "inventory") {
      const { all } = casesOf();
      const entries = all.filter((entry) =>
        existsSync(join(entry.directory, "run", "cloud")),
      );
      input = {
        entries,
        controls: new Set(
          entries
            .filter((entry) => entry.record.control !== null)
            .map((entry) => entry.record.caseId),
        ),
        runs: (flag(args, "--runs") ?? "first,cloud").split(","),
        floor: null,
        sample: null,
      };
    } else throw new Error("manifest takes baseline, candidate or inventory");
    const manifest = await collectManifest({
      role: kind === "candidate" ? "candidate" : "baseline",
      ...(effortComparison === undefined ? {} : { effortComparison }),
      researchRoot: resolve(researchRoot()),
      treatmentRoot: kind === "candidate" ? treatmentRoot() : null,
      ...input,
      reader:
        kind === "candidate"
          ? await reader()
          : "no capture is read for a baseline",
      now: now(),
    });
    writeOnce(out, json(manifest));
    const effort =
      effortComparison === undefined
        ? ""
        : ` (${effortComparison} effort comparison)`;
    return `${kind} manifest${effort}: ${manifest.cases.length} case(s), ${manifest.files.length} file(s) hashed, ${manifest.absent.length} absent, to ${out}\n${json(manifest.counts)}`;
  }
  if (command === "verify") {
    const path = args[1];
    if (path === undefined) throw new Error("verify <manifest>");
    const changed = await verifyManifest(readManifest(path), await reader());
    if (changed.length > 0)
      throw new Error(
        `${changed.length} file(s) differ from ${path}:\n${changed.join("\n")}`,
      );
    return `${path}: every file as recorded`;
  }
  if (command === "compare") {
    const usage = "compare";
    const baselinePath = resolve(required(args, "--baseline", usage));
    const candidatePath = resolve(required(args, "--candidate", usage));
    const baseline = readManifest(baselinePath);
    const candidate = readManifest(candidatePath);
    const out = freshOutput(required(args, "--out", usage));
    if (!treating())
      throw new Error(
        "compare needs NEUVE_TREATMENT_ROOT: the candidate manifest's treatment folder",
      );
    const report = await compareCandidate(
      baseline,
      candidate,
      casesOf().all,
      {
        baseline: { path: baselinePath, sha256: fileId(baselinePath).sha256 },
        candidate: {
          path: candidatePath,
          sha256: fileId(candidatePath).sha256,
        },
      },
      await reader(),
      effortComparison,
    );
    writeOnce(join(out, "compare.json"), json(report));
    writeOnce(join(out, "compare.md"), reportMarkdown(report));
    const effort =
      effortComparison === undefined
        ? ""
        : ` (${effortComparison} effort comparison)`;
    return `compared ${report.cases} case(s) to ${out}${effort}`;
  }
  throw new Error("candidate takes manifest, verify or compare");
};

if (import.meta.main)
  candidateMain(process.argv.slice(2)).then(
    (text) => console.log(text),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
