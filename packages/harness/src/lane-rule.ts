import type { AssembledUnit } from "@neuve/records-schema";

/**
 * The lane rule, apart from Assemble so the lanes evals can recompute a published unit's lane from
 * its recorded assessment alone (10.137): it reads only the assessment, never the pipeline.
 */

/** A lane, from least to most cautious (`LANE_ORDER`). */
type LaneName = AssembledUnit["assessment"]["lane"];

/** An axis of the matrix, as the records name it. */
export type Axis = "complexity" | "ease-of-validation";

/**
 * A move on the matrix (decision 14.28): one signal that raises one axis one step toward a person,
 * with the IDs it cites. On two levels one step is the top level, so a move makes complexity high
 * or validation hard, and never lowers either. Two signals: a finder's finding that Verify kept,
 * placed on the section (`kept-finding`, cited by the finding's comment ID, `movesOf`), and a
 * request for changes resting on Verify-confirmed claims (`confirmed-request-changes`, 14.34, cited
 * by those claims' IDs, `confirmedMoveOf`), on both axes. The blast radius is
 * recorded and moves nothing until it is measured (14.22).
 */
export interface Move {
  readonly signal: MoveSignal;
  readonly axis: Axis;
  readonly direction: "toward-human";
  readonly cites: ReadonlyArray<string>;
}

/** The signals a move may carry (`Move.signal`). */
export type MoveSignal = "kept-finding" | "confirmed-request-changes";

/** A finding's kind and what it is about, as Find stores them (`FindingKind`, `FindingAbout`). */
export type FindingKindName = "defect" | "risk" | "question" | "pattern-note";
export type FindingAboutName = "code" | "tests" | "proof";

/**
 * The axis each kept finding moves, by kind and what it is about (14.28). A finding about code
 * claims something about what the change does or reaches: complexity. One about tests or proof
 * claims the proof does not establish correctness (10.63, 11.10): ease of validation. A pattern
 * note moves nothing (9.10: it may deserve a comment without requiring action).
 */
export const FINDING_MOVES: Readonly<
  Record<FindingKindName, Readonly<Record<FindingAboutName, Axis | null>>>
> = {
  defect: {
    code: "complexity",
    tests: "ease-of-validation",
    proof: "ease-of-validation",
  },
  risk: {
    code: "complexity",
    tests: "ease-of-validation",
    proof: "ease-of-validation",
  },
  question: {
    code: "complexity",
    tests: "ease-of-validation",
    proof: "ease-of-validation",
  },
  "pattern-note": { code: null, tests: null, proof: null },
};

/** The moves a section's kept findings give, one per finding that moves an axis, in the order given. */
export const movesOf = (
  findings: ReadonlyArray<{
    /** The finding's comment ID (`findingCommentId`). */
    readonly id: string;
    readonly kind: FindingKindName;
    readonly about: FindingAboutName;
  }>,
): Array<Move> =>
  findings.flatMap((finding) => {
    const axis = FINDING_MOVES[finding.kind][finding.about];
    return axis === null
      ? []
      : [
          {
            signal: "kept-finding" as const,
            axis,
            direction: "toward-human" as const,
            cites: [finding.id],
          },
        ];
  });

/**
 * The axes a confirmed request for changes moves, one move each (decision 14.34, both axes): it
 * raises complexity to high and makes validation hard, so such a section is high and hard,
 * human-required, at any level Assess gave ("lands in 'needs a person' every time"). Matrix moves,
 * not a floor: each cites the confirmed claims, cited evidence on its axis for 10.9. The one list
 * `confirmedMoveOf` gives, `readMove` accepts and `laneOf`'s note reads.
 */
export const CONFIRMED_AXES: ReadonlyArray<Axis> = [
  "complexity",
  "ease-of-validation",
];

/**
 * The moves a section's standing verdict gives (decision 14.34, lane rule 5): a request for changes
 * that rests on at least one Verify-confirmed claim (a kept finder defect, or a Lane review defect
 * claim Verify confirmed: the verdict's `restsOn`) raises the section's complexity and makes it hard
 * to validate (`CONFIRMED_AXES`), since once a defect is confirmed its fix must be validated again.
 * Each move is cited by those claims' IDs, which count as cited evidence for 10.9 as any move's do,
 * so a gap cannot lower the section. They are moves besides the kept findings' own, which still move
 * their axis as before. An approval, no verdict, or a request resting on no confirmed claim gives
 * none; the caller gives none to an undecided section (14.4), which is human-required whatever it
 * holds.
 */
export const confirmedMoveOf = (
  verdict: "approve" | "request-changes" | null,
  restsOn: ReadonlyArray<string>,
): Array<Move> =>
  verdict === "request-changes" && restsOn.length > 0
    ? CONFIRMED_AXES.map((axis) => ({
        signal: "confirmed-request-changes" as const,
        axis,
        direction: "toward-human" as const,
        cites: [...restsOn],
      }))
    : [];

/**
 * The matrix (4.2, 10.82, 10.55, 10.9, 4.4), quadrant to lane, as the one table `laneOf` reads:
 * - low and easy: static automation when every validation requirement is solid, else agentic
 *   (10.82, which supersedes 10.4): `by-proof`;
 * - low and hard: human-suggested;
 * - high and easy: agentic only when the reading did not ask for a person and no move raised the
 *   section, else human-suggested: `by-lean`;
 * - high and hard: human-required.
 */
export const MATRIX = {
  "low-easy": "by-proof",
  "low-hard": "human-suggested",
  "high-easy": "by-lean",
  "high-hard": "human-required",
} as const satisfies Record<
  `${"low" | "high"}-${"easy" | "hard"}`,
  LaneName | "by-proof" | "by-lean"
>;

/** A stored move as the lane rule reads it; anything else is an error, never a guess. */
const readMove = (value: unknown): Move => {
  const move = value as Partial<Move> | null;
  if (
    move === null ||
    typeof move !== "object" ||
    (move.signal !== "kept-finding" &&
      move.signal !== "confirmed-request-changes") ||
    (move.axis !== "complexity" && move.axis !== "ease-of-validation") ||
    // A confirmed request for changes moves only the axes 14.34 gives it (`CONFIRMED_AXES`).
    (move.signal === "confirmed-request-changes" &&
      !CONFIRMED_AXES.includes(move.axis)) ||
    move.direction !== "toward-human" ||
    !Array.isArray(move.cites) ||
    !move.cites.every((cite) => typeof cite === "string")
  )
    throw new Error(
      `A stored move is not one the lane rule reads: ${JSON.stringify(value)}`,
    );
  return move as Move;
};

/**
 * Quadrant to lane through `MATRIX`, with the gap rules (4.4, 10.9, 10.55). Each axis is the
 * reading's level, raised by the moves (`movement`): complexity is high when the reading says so or
 * any move is on it, validation hard likewise. A move's cites count as cited evidence on its axis
 * (10.9). High and easy follows the lean, and any move voids an agentic answer there: the reading
 * never saw the finding. A gap sends the section to human-suggested, except that one cited on both
 * axes as high and hard stays human-required (10.9). With no moves this is lane rule 3's `laneOf`.
 */
export const laneOf = (assessment: {
  readonly complexity: {
    readonly level: "low" | "high";
    readonly factors: ReadonlyArray<{ readonly cites: ReadonlyArray<string> }>;
  };
  readonly validation: {
    readonly level: "easy" | "hard";
    readonly requirements: ReadonlyArray<{
      readonly cites: ReadonlyArray<string>;
      readonly coverage: AssembledUnit["assessment"]["validation"]["requirements"][number]["coverage"];
      readonly requirement: string;
    }>;
  };
  readonly lean: {
    readonly lane: "agentic" | "human-suggested";
    readonly reason: string;
  } | null;
  readonly gaps: ReadonlyArray<{
    readonly axis: "complexity" | "ease-of-validation";
  }>;
  /** The moves on the section; absent, none (lane rules 1 to 3). */
  readonly movement?: ReadonlyArray<Move> | undefined;
}) => {
  const moves = assessment.movement ?? [];
  const on = (axis: Axis) => moves.filter((move) => move.axis === axis);
  const complexity =
    on("complexity").length > 0 ? "high" : assessment.complexity.level;
  const validation =
    on("ease-of-validation").length > 0 ? "hard" : assessment.validation.level;
  const quadrant = `${complexity}-${validation}` as const;
  const citedComplexity =
    assessment.complexity.factors.some((factor) => factor.cites.length > 0) ||
    on("complexity").some((move) => move.cites.length > 0);
  const citedValidation =
    assessment.validation.requirements.some(
      (requirement) => requirement.cites.length > 0,
    ) || on("ease-of-validation").some((move) => move.cites.length > 0);
  const validationGap = assessment.gaps.some(
    (gap) => gap.axis === "ease-of-validation",
  );
  let lane: LaneName;
  let note: string;
  const cell = MATRIX[quadrant];
  if (cell === "by-proof") {
    const open = assessment.validation.requirements.filter(
      (r) => r.coverage !== "solid",
    );
    if (assessment.validation.requirements.length > 0 && open.length === 0) {
      lane = "static-automation";
      note =
        "low and easy, every validation requirement solid (two or more current kinds agree): static automation (10.82)";
    } else {
      lane = "agentic";
      note = `low and easy: agentic; static automation needs every validation requirement solid, and ${open.length === 0 ? "no requirement is stated" : open.map((r) => `"${r.requirement.slice(0, 80)}" is ${r.coverage}`).join("; ")} (10.82)`;
    }
  } else if (cell === "by-lean") {
    lane =
      assessment.lean?.lane === "human-suggested" || moves.length > 0
        ? "human-suggested"
        : "agentic";
    note =
      assessment.lean?.lane === "human-suggested"
        ? `high complexity, easy to validate: human-suggested, as the lean asks (${assessment.lean.reason})`
        : lane === "human-suggested"
          ? "high complexity, easy to validate: human-suggested, since the reading never saw the kept finding (14.28)"
          : "high complexity, easy to validate: agentic";
  } else {
    lane = cell;
    note =
      cell === "human-suggested"
        ? "low complexity, hard to validate: human-suggested"
        : "high complexity, hard to validate: human-required";
  }
  const kept = moves.filter((move) => move.signal === "kept-finding");
  if (kept.length > 0)
    note += `; ${[...new Set(kept.map((move) => move.axis))].map((axis) => (axis === "complexity" ? "a kept finding about the code raises its complexity" : "a kept finding about its tests or proof makes it hard to validate")).join(", and ")} (14.28)`;
  const verdictAxes = new Set(
    moves
      .filter((move) => move.signal === "confirmed-request-changes")
      .map((move) => move.axis),
  );
  if (verdictAxes.size > 0)
    note += `; a confirmed defect ${[...(verdictAxes.has("complexity") ? ["raises its complexity"] : []), ...(verdictAxes.has("ease-of-validation") ? ["makes it hard to validate"] : [])].join(" and ")}, since its fix must be validated again (14.34)`;
  if (assessment.gaps.length > 0) {
    if (quadrant === "high-hard" && citedComplexity && citedValidation) {
      note +=
        "; its gaps cannot lower it, since cited evidence places it high and hard (10.9)";
    } else {
      lane = "human-suggested";
      note += `; a gap on ${[...new Set(assessment.gaps.map((gap) => gap.axis))].join(" and ")} sends it to human-suggested (4.4)`;
    }
  }
  const highComplexityValidationGap =
    lane === "human-suggested" &&
    complexity === "high" &&
    citedComplexity &&
    validationGap;
  if (highComplexityValidationGap)
    note += "; evidence of high complexity with a validation gap (10.55)";
  return { quadrant, lane, note, highComplexityValidationGap };
};

/** A line a unit adds, read by code from its hunks: never from labels or history. */
export interface AddedLine {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** The lines a unit's owned new-side ranges add, from the hunks' own text. */
export const addedLines = (
  ranges: ReadonlyArray<{
    readonly kind: string;
    readonly path?: string;
    readonly side?: "old" | "new";
    readonly startLine?: number;
    readonly endLine?: number;
  }>,
  hunks: ReadonlyArray<{
    readonly kind: string;
    readonly path: string;
    readonly newPath: string | null;
    readonly newStart: number;
    readonly text: string;
  }>,
): Array<AddedLine> => {
  const out: Array<AddedLine> = [];
  for (const range of ranges) {
    if (range.kind !== "lines" || range.side !== "new") continue;
    for (const hunk of hunks) {
      if (hunk.kind !== "text" || (hunk.newPath ?? hunk.path) !== range.path)
        continue;
      let line = hunk.newStart;
      for (const row of hunk.text.split("\n").slice(1)) {
        if (row.startsWith("+")) {
          if (line >= range.startLine! && line <= range.endLine!)
            out.push({ path: range.path!, line, text: row.slice(1) });
          line++;
        } else if (row.startsWith(" ")) line++;
      }
    }
  }
  return out;
};

/** Tests, fixtures, stories, mocks and test helpers name nothing a caller outside them uses. */
const TESTS =
  /(^|\/)(test|tests|__tests__|__mocks__|testdata|fixtures?|e2e|spec|test-?utils?)(\/|$)|[._-](test|spec)\.[a-z]+$|\.stories\.[a-z]+$|(^|\/)test-?utils?\.[a-z]+$|_test\.go$/i;
/** Go's internal packages export no name outside their module; their flags and variables still reach users. */
const INTERNAL = /(^|\/)internal(\/|$)/;
const ECMASCRIPT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** A file that holds a configuration surface: its keys are options a user sets. */
const OPTIONS_FILE = /(config|option|setting|environment|flags?)[^/]*$/i;

/** Comments removed, so a commented-out export is no export and a note inside a list is no name. */
const uncommented = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");

/** The names an `export { a, b as c }` list exports: the name after `as`, else the name itself. */
const listedNames = (list: string) =>
  uncommented(list)
    .split(",")
    .map((item) => item.trim().replace(/^type\s+/, ""))
    .filter((item) => item !== "")
    .map((item) =>
      item
        .split(/\s+as\s+/)
        .at(-1)!
        .trim(),
    );

const SURFACE: ReadonlyArray<{
  readonly kind: "export" | "flag" | "environment" | "option";
  readonly applies: (path: string) => boolean;
  readonly pattern: RegExp;
  /** The names an export line declares, from its match. */
  readonly names?: (match: RegExpExecArray) => Array<string>;
}> = [
  {
    kind: "export",
    applies: (path) => ECMASCRIPT.test(path),
    pattern:
      /^\s*export\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
    names: (match) => [match[1] === undefined ? match[2]! : "default"],
  },
  {
    kind: "export",
    applies: (path) => ECMASCRIPT.test(path),
    pattern: /^\s*export\s*(?:type\s*)?\{([^}]*)\}/,
    names: (match) => listedNames(match[1]!),
  },
  {
    kind: "environment",
    applies: (path) => ECMASCRIPT.test(path),
    pattern: /process\.env(?:\.[A-Z][A-Z0-9_]*|\[\s*['"`][A-Z][A-Z0-9_]*)/,
  },
  {
    kind: "flag",
    applies: (path) => ECMASCRIPT.test(path),
    pattern: /\.option\(\s*['"`]-{1,2}[\w-]+/,
  },
  {
    kind: "option",
    applies: (path) => ECMASCRIPT.test(path) && OPTIONS_FILE.test(path),
    pattern: /^\s*[a-z][A-Za-z0-9_]*\s*:\s*z\./,
  },
  // Go: an exported function, a method on an exported type, an exported type, var or const.
  {
    kind: "export",
    applies: (path) => path.endsWith(".go"),
    pattern:
      /^func\s+(?:([A-Z]\w*)\s*[[(]|\(\s*\w*\s*\*?[A-Z]\w*(?:\[[^\]]*\])?\s*\)\s*([A-Z]\w*)\s*\()/,
    names: (match) => [match[1] ?? match[2]!],
  },
  {
    kind: "export",
    applies: (path) => path.endsWith(".go"),
    pattern: /^(?:type|var|const)\s+([A-Z]\w*)\b/,
    names: (match) => [match[1]!],
  },
  // A flag definition on a flag receiver, named whole: the flag package, a FlagSet (fs, flags,
  // flagSet, cmdFlags), Cobra's Flags() and PersistentFlags(), or the go command's Flag. A
  // string-keyed call on anything else, a log or trace attribute such as slog.String("id", …), is
  // not a flag.
  {
    kind: "flag",
    applies: (path) => path.endsWith(".go"),
    pattern:
      /(?:\.Flags\(\)|\.PersistentFlags\(\)|\.Flag|\b(?:fs|FS|\w*[Ff]lags?|\w*[Ff]lag[Ss]et))\.(?:Bool|String|Int|Int64|Uint|Uint64|Float64|Duration|StringSlice|StringArray|IntSlice|Count|Var|Func|TextVar)(?:Var)?P?\(\s*(?:&[\w.]+,\s*)?"[a-z][\w.-]*"/,
  },
  {
    kind: "environment",
    applies: (path) => path.endsWith(".go"),
    pattern:
      /\bos\.(?:Getenv|LookupEnv)\(\s*(?:"[A-Z][A-Z0-9_]*"|[A-Z]\w*\s*\))/,
  },
];

/** One thing a unit adds that people outside it come to rely on, with the names an export declares. */
export interface SurfaceHit extends AddedLine {
  readonly kind: "export" | "flag" | "environment" | "option";
  readonly names: ReadonlyArray<string>;
}

/**
 * What a unit adds that people outside it come to rely on: an exported name, a command-line flag,
 * an environment variable read or a configuration option. Naming such a thing is a choice a
 * reviewer weighs, which an agent's review rarely questions.
 */
export const publicSurface = (
  lines: ReadonlyArray<AddedLine>,
): Array<SurfaceHit> =>
  lines.flatMap((line) =>
    TESTS.test(line.path)
      ? []
      : SURFACE.flatMap((entry) => {
          if (
            !entry.applies(line.path) ||
            (entry.kind === "export" && INTERNAL.test(line.path))
          )
            return [];
          const match = entry.pattern.exec(line.text);
          return match === null
            ? []
            : [
                {
                  kind: entry.kind,
                  names: entry.names?.(match) ?? [],
                  ...line,
                },
              ];
        }),
  );

/** A file's text at the reviewed revision, or null where it has none. Read by the caller, never here. */
export type ReadAtHead = (path: string) => string | null;

const directoryOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** A relative path resolved against a directory, its `.` and `..` segments removed. */
const resolvePath = (directory: string, relative: string) => {
  const parts: Array<string> = directory === "" ? [] : directory.split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
};

const SOURCE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.mjs",
];

/**
 * The source file a module specifier names: as written, with a source extension, as a folder's
 * index, or a `.js` specifier written for a `.ts` file.
 */
const sourceFile = (read: ReadAtHead, path: string) => {
  for (const stem of [path, path.replace(/\.(m|c)?js$/, "")])
    for (const suffix of SOURCE_SUFFIXES)
      if (read(stem + suffix) !== null) return stem + suffix;
  return null;
};

/** An entry target as the package's source: as written, else a built `dist`, `lib`, `build` or `out` target read from `src`. */
const entrySource = (read: ReadAtHead, root: string, target: string) =>
  sourceFile(read, resolvePath(root, target)) ??
  sourceFile(
    read,
    resolvePath(
      root,
      target
        .replace(/^(\.\/)?(dist|lib|build|out)\//, "$1src/")
        .replace(/\.(d\.)?(m|c)?[jt]s$/, ""),
    ),
  );

/** Every string an entry field names: `main`, `module`, `types`, and `exports` at any depth. */
const entryTargets = (manifest: Record<string, unknown>) => {
  const out: Array<string> = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (value !== null && typeof value === "object")
      Object.values(value).forEach(walk);
  };
  for (const field of ["main", "module", "types", "typings", "exports"])
    walk(manifest[field]);
  return out.filter((target) => !target.endsWith("package.json"));
};

const RE_EXPORT =
  /export\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
/** `import d, * as ns from`, `import d, { a as b } from` and their parts, from a relative module. */
const IMPORT =
  /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g;
/** `export { a, b as c }` with no `from`: names the file holds, perhaps imported. */
const LOCAL_EXPORT = /export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g;
const DEFAULT_EXPORT = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/g;

/**
 * Whether a file's exported names cross a package's public entry: for ECMAScript, the files its
 * nearest package.json names as entries (`main`, `module`, `types`, `exports`) and the names those
 * re-export from other files, followed through `export * from` and `export { … } from`; for Go, any
 * package but `main` (internal packages are excluded earlier). An application with no entry exposes
 * nothing this way, so its module exports are not public surface.
 */
export const publicEntry = (read: ReadAtHead) => {
  const packages = new Map<string, Map<string, "all" | Set<string>> | null>();
  /** Packages whose re-exports went past the step bound: their entry was read in part, and says so. */
  const truncated = new Set<string>();
  const packageOf = (path: string) => {
    for (let directory = directoryOf(path); ;) {
      const manifest = read(
        directory === "" ? "package.json" : `${directory}/package.json`,
      );
      if (manifest !== null) return { directory, manifest };
      if (directory === "") return null;
      directory = directoryOf(directory);
    }
  };
  const visibility = (root: string, manifest: string) => {
    if (packages.has(root)) return packages.get(root)!;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(manifest) as Record<string, unknown>;
    } catch {
      packages.set(root, null);
      return null;
    }
    const seen = new Map<string, "all" | Set<string>>();
    const queue: Array<string> = [];
    const widen = (file: string, names: "all" | ReadonlySet<string>) => {
      const held = seen.get(file);
      if (held === "all") return;
      if (names === "all") seen.set(file, "all");
      else {
        const next = new Set([...(held ?? []), ...names]);
        if (held !== undefined && next.size === held.size) return;
        seen.set(file, next);
      }
      queue.push(file);
    };
    for (const target of entryTargets(parsed)) {
      const file = entrySource(read, root, target);
      if (file !== null) widen(file, "all");
    }
    // Bounded: a package re-exports through a handful of files, never hundreds.
    let step = 0;
    for (; queue.length > 0 && step < ENTRY_STEPS; step++) {
      const file = queue.shift()!;
      const exposed = seen.get(file)!;
      const visible = (name: string) => exposed === "all" || exposed.has(name);
      const text = uncommented(read(file) ?? "");
      // A name the file imports and exports again exposes the module it came from.
      const imported = new Map<string, { from: string; name: string }>();
      for (const match of text.matchAll(IMPORT)) {
        const [, defaulted, space, list, from] = match;
        if (defaulted !== undefined)
          imported.set(defaulted, { from: from!, name: "default" });
        if (space !== undefined)
          imported.set(space, { from: from!, name: "*" });
        for (const item of list === undefined ? [] : list.split(",")) {
          const [name = "", local = name] = item
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/);
          if (name.trim() !== "")
            imported.set(local.trim(), { from: from!, name: name.trim() });
        }
      }
      const exportedAgain = (local: string, exported: string) => {
        const source = imported.get(local);
        if (source === undefined || !visible(exported)) return;
        const target = sourceFile(
          read,
          resolvePath(directoryOf(file), source.from),
        );
        if (target === null) return;
        widen(target, source.name === "*" ? "all" : new Set([source.name]));
      };
      for (const match of text.matchAll(LOCAL_EXPORT))
        for (const item of match[1]!.split(",")) {
          const [local = "", exported = local] = item
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/);
          if (local.trim() !== "") exportedAgain(local.trim(), exported.trim());
        }
      for (const match of text.matchAll(DEFAULT_EXPORT))
        exportedAgain(match[1]!, "default");
      for (const match of text.matchAll(RE_EXPORT)) {
        const target = sourceFile(
          read,
          resolvePath(directoryOf(file), match[2]!),
        );
        if (target === null) continue;
        const clause = match[1]!;
        if (clause.startsWith("*")) {
          const space = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
          if (space === undefined) widen(target, exposed);
          else if (visible(space)) widen(target, "all");
        } else {
          const names = clause
            .slice(1, -1)
            .split(",")
            .map((item) => item.trim().replace(/^type\s+/, ""))
            .filter((item) => item !== "")
            .flatMap((item) => {
              const [local = "", exported = local] = item.split(/\s+as\s+/);
              return visible(exported.trim()) ? [local.trim()] : [];
            });
          if (names.length > 0) widen(target, new Set(names));
        }
      }
    }
    if (queue.length > 0) truncated.add(root === "" ? "." : root);
    packages.set(root, seen);
    return seen;
  };
  const isPublic = (path: string, names: ReadonlyArray<string>) => {
    if (path.endsWith(".go"))
      return /^\s*package\s+(\w+)/m.exec(read(path) ?? "")?.[1] !== "main";
    const found = packageOf(path);
    if (found === null) return false;
    const exposed = visibility(found.directory, found.manifest)?.get(path);
    return (
      exposed === "all" ||
      (exposed !== undefined && names.some((name) => exposed.has(name)))
    );
  };
  return Object.assign(isPublic, {
    /** The packages read only in part, for the caller to disclose. */
    truncated: () => [...truncated].sort(),
  });
};

/** How many re-exporting files one package's entry is followed through before it is disclosed as read in part. */
export const ENTRY_STEPS = 500;

/** What a lane candidate reads beside the assessment: code-derived facts about the unit. */
export interface LaneContext {
  readonly added: ReadonlyArray<AddedLine>;
  /** Whether an exported name crosses its package's public entry; absent, no export does. */
  readonly isPublicEntry?:
    ((path: string, names: ReadonlyArray<string>) => boolean) | undefined;
}

const raised = (
  lane: AssembledUnit["assessment"]["lane"],
  hits: ReadonlyArray<SurfaceHit>,
) =>
  (lane === "agentic" || lane === "static-automation") && hits.length > 0
    ? "human-suggested"
    : lane;

/**
 * The lane rule's version, as the eval sets that measure runs record it: 1, `laneOf` alone; 2
 * (10.140), then the public-surface raise; 3, per section: `laneOf`, then the public-surface raise,
 * then the code risk floors (`sectionLane`); 4 (14.28), rule 3 with each section's stored moves read by
 * `laneOf` and no `finding` floor. With no moves, rule 4 gives rule 3's lane. 5 (14.34), rule 4 with
 * a confirmed request for changes also moving both axes, to high complexity and hard validation
 * (`confirmedMoveOf`), stored with the section's other moves. With no confirmed request for changes, rule 5 gives rule 4's lane and
 * note.
 */
export const LANE_RULE_VERSION = 5;

/**
 * The public-surface raise (10.140, kept from the lanes climb's round 1): a unit an agent or
 * automation would take that adds a public name, flag, environment variable or option goes to a
 * person, suggested. It never lowers a lane. The composition applies it to each section after
 * `laneOf`, and the lanes evals with the same function, so what was measured is what runs.
 */
export const withPublicSurface = (
  lane: AssembledUnit["assessment"]["lane"],
  added: ReadonlyArray<AddedLine>,
) => {
  const hits = publicSurface(added);
  return { lane: raised(lane, hits), hits };
};

// ---------------------------------------------------------------------------------------------
// Lane rules 3 to 5: one section at a time, from its recorded values
// ---------------------------------------------------------------------------------------------

/** The lanes from least to most cautious: a later lane sends more of the work to a person. */
export const LANE_ORDER: ReadonlyArray<LaneName> = [
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
];

/** The more cautious of two lanes. */
export const moreCautious = (a: LaneName, b: LaneName): LaneName =>
  LANE_ORDER.indexOf(b) > LANE_ORDER.indexOf(a) ? b : a;

/** A code risk floor as recorded on a section: the rule that set it and the lane it holds at least. */
export interface Floor {
  readonly rule: string;
  readonly to: LaneName;
}

/**
 * The code facts the floors read, as small and structural as the rule needs: whether the section
 * removes a declaration or a public name, and the effects its impact entries name. (Facts stored
 * under rule 3 may also hold `keptFinding`, which rule 4 reads as a move instead.)
 */
export interface FloorFacts {
  readonly removesDeclaration: boolean;
  readonly removesPublicName: boolean;
  readonly effects: ReadonlyArray<
    "removed" | "disabled" | "narrowed" | "changed" | "added"
  >;
}

/** Which floors are on. Each is off until the lanes eval measures it. */
export interface FloorOptions {
  readonly removal?: boolean | undefined;
}

/**
 * The floors that apply to a section, from code facts. One rule, `removal`, off unless
 * `options.removal`: a section that removes a declaration or a public name, or that something it
 * changes is removed, disabled or narrowed, holds at least human-suggested. (Rule 3's `finding`
 * floor is gone: under rule 4 a kept finding is a move on the matrix, read by `laneOf`.)
 */
export const floorsOf = (
  facts: FloorFacts,
  options: FloorOptions,
): Array<{
  readonly rule: "removal";
  readonly to: "human-suggested";
}> =>
  options.removal === true &&
  (facts.removesDeclaration ||
    facts.removesPublicName ||
    facts.effects.some(
      (effect) =>
        effect === "removed" || effect === "disabled" || effect === "narrowed",
    ))
    ? [{ rule: "removal" as const, to: "human-suggested" as const }]
    : [];

/** A recorded floor's reason in a reader's words; a floor an older build recorded keeps its own. */
const FLOOR_WORDS: Readonly<Record<string, string>> = {
  removal:
    "it removes, disables or narrows existing behaviour, so a person is suggested",
  finding: "a finder's finding on this change is kept, so a person looks at it",
};

/**
 * A section's lane under rules 3 to 5, from its recorded assessment (what `laneOf` reads, its moves
 * included), the lines it adds and its recorded floors: `judged` is `laneOf`'s lane, `surfaced` the lane after the
 * public-surface raise, `applied` the most cautious of `surfaced` and every floor. The floors come
 * last, after `laneOf`'s gap rule (which may lower a section to human-suggested), so a floor only
 * ever raises. `floors` holds the floors that raised. Every input is a recorded value, so the lanes
 * eval recomputes a stored lane from the record alone.
 */
export const sectionLane = (input: {
  readonly assessment: Parameters<typeof laneOf>[0];
  readonly added: ReadonlyArray<AddedLine>;
  readonly floors: ReadonlyArray<Floor>;
}) => {
  const judged = laneOf(input.assessment);
  const surfaced = withPublicSurface(judged.lane, input.added);
  const floors = input.floors.filter(
    (floor) => moreCautious(surfaced.lane, floor.to) !== surfaced.lane,
  );
  const applied = floors.reduce<LaneName>(
    (lane, floor) => moreCautious(lane, floor.to),
    surfaced.lane,
  );
  // The reader's note carries no decision numbers; `laneOf`'s own note keeps them for the run log.
  let note = judged.note.replace(/ \(\d+\.\d+\)/g, "");
  if (surfaced.lane !== judged.lane)
    note +=
      "; it adds a public name, flag, environment variable or option, so a person is suggested";
  for (const rule of new Set(floors.map((floor) => floor.rule)))
    note += `; ${FLOOR_WORDS[rule] ?? `what it changes (${rule}) sends it to a person`}`;
  return {
    quadrant: judged.quadrant,
    note,
    highComplexityValidationGap: judged.highComplexityValidationGap,
    judged: judged.lane,
    surfaced: surfaced.lane,
    hits: surfaced.hits,
    floors,
    applied,
  };
};

/**
 * A stored section entry as `recordedLane` reads it, structurally: the assessment in the records'
 * stored form (`easeOfValidation`, `movement`: the moves, each read as a `Move`, none under rule 3),
 * its recorded floors and whether it is undecided.
 */
export interface RecordedEntry {
  readonly assess: {
    readonly complexity: Parameters<typeof laneOf>[0]["complexity"];
    readonly easeOfValidation: Parameters<typeof laneOf>[0]["validation"];
    /** Absent on a `reading.section` row rule 3's `laneEntryOf` wrote, which left it out: none. */
    readonly movement?: ReadonlyArray<unknown> | undefined;
    readonly lean: Parameters<typeof laneOf>[0]["lean"];
    readonly gaps: Parameters<typeof laneOf>[0]["gaps"];
  } | null;
  readonly lane: { readonly floors: ReadonlyArray<Floor> };
  readonly undecided?: { readonly cause: string } | undefined;
  /** A lockfile or declared-generated file: no reading is made, as today's code-only batch has none. */
  readonly excluded?: { readonly reason: string } | undefined;
}

/**
 * A stored section's lane trail, recomputed from the entry alone: `sectionLane` over its own
 * values, its stored moves included, except that an undecided entry is human-required whatever else it holds. `judged` and
 * `surfaced` are still computed where there is an assessment, and null where there is none (no
 * floor raised anything then). An entry with no assessment is undecided (human-required) or an
 * excluded file (human-suggested, as today's review gives a lockfile or a declared-generated file);
 * one that is neither has no lane, and is an error. A stored entry's `lane` always equals this
 * trail's `judged`, `surfaced`, `floors` and `applied`.
 */
export const recordedLane = (
  entry: RecordedEntry,
  added: ReadonlyArray<AddedLine>,
): {
  readonly quadrant: ReturnType<typeof laneOf>["quadrant"] | null;
  readonly note: string | null;
  readonly highComplexityValidationGap: boolean;
  readonly judged: LaneName | null;
  readonly surfaced: LaneName | null;
  readonly hits: ReadonlyArray<SurfaceHit>;
  readonly floors: ReadonlyArray<Floor>;
  readonly applied: LaneName;
} => {
  if (entry.assess === null) {
    if (entry.undecided === undefined && entry.excluded === undefined)
      throw new Error(
        "A section entry with no assessment must be undecided or an excluded file",
      );
    return {
      quadrant: null,
      note: null,
      highComplexityValidationGap: false,
      judged: null,
      surfaced: null,
      hits: [],
      floors: [],
      applied:
        entry.undecided === undefined ? "human-suggested" : "human-required",
    };
  }
  const trail = sectionLane({
    assessment: {
      complexity: entry.assess.complexity,
      validation: entry.assess.easeOfValidation,
      lean: entry.assess.lean,
      gaps: entry.assess.gaps,
      movement: (entry.assess.movement ?? []).map(readMove),
    },
    added,
    floors: entry.lane.floors,
  });
  return entry.undecided === undefined
    ? trail
    : { ...trail, applied: "human-required" };
};

/**
 * Lane candidates for the lanes climb (10.137), measured offline before any is placed in the
 * composition. Each takes the live rule's lane and may raise it, never lower it.
 */
export const LANE_CANDIDATES: Readonly<
  Record<
    string,
    (
      lane: AssembledUnit["assessment"]["lane"],
      context: LaneContext,
    ) => AssembledUnit["assessment"]["lane"]
  >
> = {
  /**
   * The public-surface raise, counting an exported name only where it crosses its package's public
   * entry: a module export inside an application is not user-facing surface. Flags, variables and
   * options count anywhere. Kept for a later round (10.140); measured against the live rule, it can
   * only lower what the live rule raised, so it is read as a narrower variant, never on top.
   */
  "public-surface-entry": (lane, context) =>
    raised(
      lane,
      publicSurface(context.added).filter(
        (hit) =>
          hit.kind !== "export" ||
          (context.isPublicEntry?.(hit.path, hit.names) ?? false),
      ),
    ),
};
