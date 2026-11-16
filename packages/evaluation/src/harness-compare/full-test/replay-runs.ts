import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CaseRecord } from "../../pr-replay/schema.ts";
import { researchRoot } from "../../pr-replay/sources.ts";
import { loadEvalSet } from "./lanes-eval.ts";
import { readShownFile } from "./packets.ts";

/**
 * The replay runs the title and digest checks read (10.139): the same split as the lanes evals, so
 * baselines and candidates read development cases and held-out cases are read once, at the end.
 * From a frozen eval set when there is one (its files checked against their hashes), else from each
 * case's own record. A run's whole `review show` output is returned, since the checks read its
 * assembled units, change map and digests.
 */
export interface ReplayRun {
  readonly caseId: string;
  readonly source: string;
  readonly split: "development" | "held-out" | "pilot";
  readonly shown: Record<string, unknown>;
}

export const replayRuns = (options: {
  /** A frozen eval set's file; when given, the set decides the cases and split. */
  readonly set?: string | undefined;
  /** The research volume's `cases` folder, read when no set is given. */
  readonly cases?: string | undefined;
  /** Read held-out cases too: only at a round's end. */
  readonly heldOut?: boolean | undefined;
  /**
   * Read each case's `run/<run>/show.json` (a recompose's output, saved there) instead of its
   * replay's own run; a case without one is refused, so both arms of a comparison read the same cases.
   */
  readonly run?: string | undefined;
  /** Cases left out by name, as a comparison states them (a run that could not be recomposed). */
  readonly leaveOut?: ReadonlySet<string> | undefined;
}): Array<ReplayRun> => {
  // A run folder as the local runner names it, as `cli.ts` `runFolderName` reads it.
  if (
    options.run !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.run)
  )
    throw new Error(
      "--run names a folder: letters, digits, dots, dashes and underscores, starting with a letter or digit",
    );
  const runFile = (caseDirectory: string) => {
    if (options.run === undefined)
      return join(caseDirectory, "run", "show.json");
    const path = join(caseDirectory, "run", options.run, "show.json");
    if (!existsSync(path))
      throw new Error(`${path} is missing: every case needs the run`);
    return path;
  };
  // Each run through the eval's guard (packets.ts `readableRun`), named by its case and file.
  const shownAt = (file: string, caseId: string) =>
    readShownFile<Record<string, unknown>>(file, `case ${caseId} (${file})`);
  const wanted = (split: string) =>
    split === "development" ||
    (split === "held-out" && options.heldOut === true);
  if (options.set !== undefined)
    return loadEvalSet(options.set, { heldOut: options.heldOut })
      .cases.filter(
        (entry) =>
          wanted(entry.meta.split) &&
          options.leaveOut?.has(entry.meta.caseId) !== true,
      )
      .map((entry) => ({
        caseId: entry.meta.caseId,
        source: entry.meta.source,
        split: entry.meta.split,
        // loadEvalSet checked the replay's own file's hash; a recompose's output is read as it is.
        shown: shownAt(
          options.run === undefined
            ? entry.meta.packet.path
            : runFile(dirname(dirname(entry.meta.packet.path))),
          entry.meta.caseId,
        ),
      }));
  const root = options.cases ?? join(researchRoot(), "cases");
  // Folders only: a stray file on the volume (.DS_Store) is no source or case.
  const folders = (directory: string) =>
    readdirSync(directory)
      .filter((name) => statSync(join(directory, name)).isDirectory())
      .sort();
  return folders(root).flatMap((source) =>
    folders(join(root, source)).flatMap((number) => {
      const directory = join(root, source, number);
      const record = join(directory, "case.json");
      const own = join(directory, "run", "show.json");
      if (!existsSync(record) || !existsSync(own)) return [];
      const parsed = CaseRecord.parse(JSON.parse(readFileSync(record, "utf8")));
      if (
        !wanted(parsed.split) ||
        options.leaveOut?.has(parsed.caseId) === true
      )
        return [];
      const packet = runFile(directory);
      return [
        {
          caseId: parsed.caseId,
          source,
          split: parsed.split,
          shown: shownAt(packet, parsed.caseId),
        },
      ];
    }),
  );
};
