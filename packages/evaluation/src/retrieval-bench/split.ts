/**
 * The benchmark's two splits, the one authority for how they are spelled (7.11): the `--split`
 * flag value, which is also the manifest's split name, and the folder or file infix the split's
 * frozen inputs and results use (`queries.<folder>.json`, `pools/<folder>/`, `arms.<folder>.json`,
 * `labelling/<folder>/`). Held-out is written `heldout` in paths.
 */

export const SPLIT_NAMES = ["dev", "held-out"] as const;
export type SplitName = (typeof SPLIT_NAMES)[number];

export interface BenchSplit {
  /** The flag value and the manifest's split name. */
  readonly name: SplitName;
  /** The folder name under `pools/` and `labelling/`, and the infix of the split's files. */
  readonly folder: "dev" | "heldout";
}

export const SPLITS: Readonly<Record<SplitName, BenchSplit>> = {
  dev: { name: "dev", folder: "dev" },
  "held-out": { name: "held-out", folder: "heldout" },
};

/** The split a `--split` value names; dev when the flag is absent. */
export const parseSplit = (value: string | undefined): BenchSplit => {
  const name = value ?? "dev";
  if (!Object.hasOwn(SPLITS, name))
    throw new Error(`--split must be dev or held-out, not ${value}`);
  return SPLITS[name as SplitName];
};

/** The split's entries (manifest cases), in their given order. */
export const splitCases = <T extends { readonly split: string }>(
  cases: ReadonlyArray<T>,
  split: BenchSplit,
): Array<T> => cases.filter((entry) => entry.split === split.name);
