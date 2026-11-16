import type { ArmDescription } from "../retriever.ts";

/**
 * 9.47: leakage exclusions follow the retriever. A comparison drops the hunks a tuned component could
 * have seen whenever either arm contains that component, worked out from the arms' definitions
 * (B2's descriptions, R's candidate arm and each variant's inputs), never from a name pattern:
 * - the tuned adapter (a dense model whose identity carries an adapter, E1) drops
 *   adapter-training-adjacent cases and ranges touching a phase 2 training file (9.33);
 * - the Graph fork (a Graph arm on the fork engine: G-fork, G-fork-syntax) drops Graph-tuning
 *   ranges, graph-tuning-adjacent cases and tuned-file hunks.
 */

export interface LeakageHunk {
  readonly hunkId: string;
  readonly tunedFile: boolean;
  readonly leakageTags: ReadonlyArray<string>;
  readonly graphTuningRange: boolean;
  readonly phase2Range: boolean;
}

export interface Exclusion {
  readonly rule: string;
  /** The arms of the comparison that contain the component, and so bring the rule in. */
  readonly because: ReadonlyArray<string>;
  readonly applies: (hunk: LeakageHunk) => boolean;
}

const RULES = {
  adapter: {
    rule: "tuned adapter: adapter-training-adjacent cases and ranges touching a phase 2 training file",
    applies: (hunk: LeakageHunk) =>
      hunk.phase2Range ||
      hunk.leakageTags.includes("adapter-training-adjacent"),
  },
  fork: {
    rule: "Graph fork: Graph-tuning ranges, graph-tuning-adjacent cases and tuned-file hunks",
    applies: (hunk: LeakageHunk) =>
      hunk.graphTuningRange ||
      hunk.leakageTags.includes("graph-tuning-adjacent") ||
      hunk.tunedFile,
  },
} as const;
type Component = keyof typeof RULES;

const record = (value: unknown) =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

/** What a leaf arm (no inputs of its own) contains, read from its configuration. */
const leafComponents = (description: ArmDescription): Array<Component> => {
  const config = record(description.config);
  if (description.family === "dense")
    return record(config["model"])["adapter"] == null ? [] : ["adapter"];
  if (description.family === "graph")
    return config["engine"] === "fork" ? ["fork"] : [];
  return [];
};

/** An arm's direct inputs from its definition: fusion lists, R's candidates, a variant's inputs. */
const inputsOf = (
  arm: string,
  descriptions: ReadonlyMap<string, ArmDescription>,
  variantInputs: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const variant = variantInputs.get(arm);
  if (variant !== undefined) return variant;
  const description = descriptions.get(arm);
  if (description === undefined)
    throw new Error(`${arm} has no definition to read its components from`);
  const config = record(description.config);
  if (description.family === "fusion")
    return (config["lists"] as ReadonlyArray<string> | undefined) ?? [];
  if (description.family === "rerank")
    return [String(config["candidates"] ?? "")];
  // S-ref is Graph `neighbors` answered by the fork alongside G-fork's pool answer (graph.ts).
  if (description.family === "reference") return ["G-fork"];
  return [];
};

export const componentsOf = (
  arm: string,
  descriptions: ReadonlyMap<string, ArmDescription>,
  variantInputs: ReadonlyMap<string, ReadonlyArray<string>>,
  seen: ReadonlySet<string> = new Set(),
): Set<Component> => {
  if (seen.has(arm)) throw new Error(`${arm} is defined through itself`);
  const inputs = inputsOf(arm, descriptions, variantInputs);
  if (inputs.length === 0) {
    const description = descriptions.get(arm) as ArmDescription;
    return new Set(leafComponents(description));
  }
  const out = new Set<Component>();
  for (const input of inputs)
    for (const component of componentsOf(
      input,
      descriptions,
      variantInputs,
      new Set([...seen, arm]),
    ))
      out.add(component);
  return out;
};

/** The exclusions a comparison of these arms carries, each with the arms that bring it in. */
export const exclusionsFor = (
  arms: ReadonlyArray<string>,
  descriptions: ReadonlyMap<string, ArmDescription>,
  variantInputs: ReadonlyMap<string, ReadonlyArray<string>>,
): Array<Exclusion> =>
  (Object.keys(RULES) as Array<Component>).flatMap((component) => {
    const because = arms.filter((arm) =>
      componentsOf(arm, descriptions, variantInputs).has(component),
    );
    return because.length === 0
      ? []
      : [
          {
            rule: RULES[component].rule,
            because,
            applies: RULES[component].applies,
          },
        ];
  });
