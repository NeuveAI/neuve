import {
  lstatSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import settings from "./paths.json";

export const benchmarkRoot = resolve(import.meta.dir, settings.benchmark);
export const parseChunker = (value = "graph"): "graph" => {
  if (value !== "graph") throw new Error("--chunker must be graph");
  return value;
};

// Resolve existing ancestors too: a new child of a symlink must not bypass the write boundary.
const canonical = (path: string, links = new Set<string>()): string => {
  const full = resolve(path);
  const parent = dirname(full);
  if (parent === full) return full;
  const target = join(canonical(parent, links), relative(parent, full));
  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return target;
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    try {
      return realpathSync(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return target;
      throw error;
    }
  }
  if (links.has(target)) throw new Error(`Symlink cycle in output: ${path}`);
  const next = new Set(links).add(target);
  return canonical(resolve(dirname(target), readlinkSync(target)), next);
};
export const refuseCommittedOutput = (
  path: string,
  committedRoot: string = benchmarkRoot,
) => {
  const target = canonical(path);
  const committed = canonical(committedRoot);
  if (
    target === sep ||
    target === committed ||
    target.startsWith(committed + sep) ||
    committed.startsWith(target + sep)
  )
    throw new Error(
      `Refusing output in or above committed benchmark files: ${path}`,
    );
};

// Library writes beneath work/store must obey the same boundary as direct output files.
const refuseLinkedDescendants = (paths: readonly string[]) => {
  const seen = new Set<string>();
  const visit = (path: string, target = canonical(path)) => {
    if (seen.has(target)) return;
    seen.add(target);
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        refuseCommittedOutput(child);
        try {
          if (statSync(child).isDirectory()) visit(child);
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
        }
      } else if (entry.isDirectory()) visit(child, join(target, entry.name));
    }
  };
  for (const path of paths) visit(path);
};

export const checkBenchmarkWrites = (paths: readonly string[]) => {
  for (const path of paths) refuseCommittedOutput(path);
  refuseLinkedDescendants(paths);
};

export const stagePaths = (options: {
  outputRoot?: string | undefined;
  chunker: "graph";
  splitFolder: string;
  work?: string | undefined;
  store?: string | undefined;
  log?: string | undefined;
}) => {
  if (options.outputRoot === undefined) return undefined;
  const root = resolve(options.outputRoot);
  const output = join(root, "graph");
  const work = resolve(options.work ?? join(root, "work"));
  const store = resolve(options.store ?? join(root, "store"));
  const log = resolve(options.log ?? join(output, "logs", options.splitFolder));
  checkBenchmarkWrites([root, output, work, store, log]);
  const volume = process.env.NEUVE_BENCH_OUTPUT_VOLUME;
  if (!volume)
    throw new Error("--output-root requires NEUVE_BENCH_OUTPUT_VOLUME");
  const within = relative(canonical(volume), canonical(root));
  if (
    !within ||
    within === ".." ||
    within.startsWith(".." + sep) ||
    isAbsolute(within)
  )
    throw new Error("--output-root must be beneath the configured volume");
  return { root, output, work, store, log };
};
