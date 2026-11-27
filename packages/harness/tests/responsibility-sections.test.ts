// Why: responsibility sections (10.109) are one switch, `review.responsibilitySections`, on by
// default; the readings' off switch (`review.sectionReadings: "off"`) gives the review before the
// readings, where it was off unless true. Off, a review must have exactly the configuration, run
// key, stage keys and published units it had before the switch existed; on, a run must never share a key with one without, and the fill must
// cut units at the file's own functions while each changed line keeps exactly the owner the review
// rules give it; and a Graph that cannot be read, or a structure read that fails, must leave the
// review to complete with one section per hunk and the gap counted. Each test states its reason.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  Log,
  Proofs,
  canonicalJson,
  mintUlid,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { AssembledBatch, type BatchInputs } from "../src/compose.ts";
import {
  PipelineConfig,
  defaultConfig,
  runKeyFor,
  runSpec,
  sectionsConfig,
  type SectionsConfig,
} from "../src/config.ts";
import {
  captureOutlineSource,
  outlineExecutable,
} from "../src/graph-outline.ts";
import {
  codeFilledBatch,
  fill,
  fillGroups,
  link,
  linkChangeMap,
} from "../src/link.ts";
import {
  RangeManifest,
  defaultManifestSettings,
  rangeManifest,
} from "../src/manifest.ts";
import {
  RunContext,
  storedBytes,
  storedOutput,
  withRecords,
} from "../src/pipeline.ts";
import { ReviewMap } from "../src/review-map.ts";
import { openRunLog, type RunLogRecord } from "../src/run-log.ts";
import { BLOB_STRUCTURE_RECIPE, SECTIONS_RECIPE } from "../src/sections.ts";
import { frame, mapOf } from "./fixtures/link.ts";

const root = mkdtempSync(join(tmpdir(), "responsibility-sections-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

/** Every property name anywhere in `value`, at any depth. */
const keysDeep = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.flatMap(keysDeep)
    : typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => [
          key,
          ...keysDeep(inner),
        ])
      : [];

/**
 * `prepareReviewConfig` with the sections and the readings read from a settings file, in a child
 * process with a home of its own: the settings path is built from the home directory, which a
 * process reads once.
 */
const prepared = (
  settings: unknown,
  extra: { readonly sections?: SectionsConfig | undefined } = {},
): PipelineConfig => {
  const home = mkdtempSync(join(root, "home-"));
  if (settings !== undefined) {
    const directory =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Neuve")
        : join(home, ".config", "neuve");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
  }
  const script = join(home, "prepare.ts");
  writeFileSync(
    script,
    `import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))};
import { storeLocationIn } from ${JSON.stringify(Bun.resolveSync("@neuve/records-core", import.meta.dir))};
import { prepareReviewConfig } from ${JSON.stringify(join(import.meta.dir, "../src/request.ts"))};
const extra = ${JSON.stringify("sections" in extra ? { sections: extra.sections ?? null } : {})};
const config = Effect.runSync(
  prepareReviewConfig({
    location: storeLocationIn(${JSON.stringify(join(home, "store"))}),
    // Explicit, so only the sections and the readings come from the settings file.
    search: {},
    stack: undefined,
    deadline: undefined,
    ...("sections" in extra ? { sections: extra.sections ?? undefined } : {}),
  }),
);
process.stdout.write(JSON.stringify(config));
`,
  );
  const child = Bun.spawnSync([process.execPath, script], {
    cwd: import.meta.dir,
    env: { ...process.env, HOME: home },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return PipelineConfig.parse(JSON.parse(child.stdout.toString()));
};

test("with the setting on, the block holds the recipes, parses, and the run key is its own", () => {
  // Reason: a run with sections must never share a key with one without, nor with one cut by
  // another recipe.
  const config = prepared({
    version: 1,
    review: { responsibilitySections: true },
  });
  expect(config.sections).toEqual({
    units: true,
    sections: SECTIONS_RECIPE,
    structure: BLOB_STRUCTURE_RECIPE,
  });
  expect(PipelineConfig.parse(JSON.parse(JSON.stringify(config)))).toEqual(
    config,
  );
  // The block is what the run key hashes, so the check above would see a leak.
  expect(keysDeep(runSpec(range, config))).toContain("sections");
  const on = runKeyFor(range, config);
  expect(on).not.toBe(runKeyFor(range, defaultConfig()));
  expect(
    runKeyFor(range, {
      ...config,
      sections: { ...config.sections!, sections: "other" },
    }),
  ).not.toBe(on);
  expect(
    runKeyFor(range, {
      ...config,
      sections: { ...config.sections!, structure: "other" },
    }),
  ).not.toBe(on);
  // Given explicitly over settings that are off, it is the same run.
  expect(
    runKeyFor(
      range,
      prepared(
        { version: 1, review: { responsibilitySections: false } },
        { sections: sectionsConfig(true) },
      ),
    ),
  ).toBe(on);
});

test("old section reading settings freeze the current review without changing its key", () => {
  const current = prepared(undefined);
  const legacy = prepared({
    version: 1,
    review: {
      sectionReadings: "off",
      sectionReadingsScopeAndTests: false,
      stepEffort: { find: "high" },
    },
  });
  expect(legacy).toEqual(current);
  expect(runKeyFor(range, legacy)).toBe(runKeyFor(range, current));
  expect(current.sections).toEqual(sectionsConfig(true));
  expect(current.readings?.scopeAndTests).toBe(true);
  expect(current.budgets.turnLimits.find).toBeUndefined();
  expect(current.route.stepEffort).toBeUndefined();
  const noSections = prepared({
    version: 1,
    review: { responsibilitySections: false },
  });
  expect(noSections.readings).toEqual(current.readings);
  expect(noSections.sections).toBeUndefined();
  expect(runKeyFor(range, noSections)).not.toBe(runKeyFor(range, current));
});

const layerOf = (location: ReturnType<typeof storeLocationIn>) =>
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(Store.layer(location, { create: true })),
    Layer.provideMerge(BunFileSystem.layer),
  );
type SqlLayer = Layer.Success<ReturnType<typeof layerOf>>;

/** A store of its own, and the names and attributes of the spans the program opened. */
const runStore = async <A, E>(
  name: string,
  program: (
    location: ReturnType<typeof storeLocationIn>,
  ) => Effect.Effect<A, E, SqlLayer>,
) => {
  const location = storeLocationIn(join(root, "stores", name));
  const layer = layerOf(location);
  const spans: Array<{ name: string; attributes: Map<string, unknown> }> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      const attributes = new Map<string, unknown>();
      spans.push({ name: options.name, attributes });
      const attribute = span.attribute.bind(span);
      span.attribute = (key, value) => {
        attributes.set(key, value);
        attribute(key, value);
      };
      return span;
    },
  });
  const value = await Effect.runPromise(
    Effect.andThen(Store.prepareForWrite, program(location)).pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provide(layer),
      Effect.provideService(Tracer.Tracer, tracer),
    ),
  );
  return { value, spans };
};

/** A run's context over `repository`, with `config`, logging to `records`. */
const contextOf = (
  location: ReturnType<typeof storeLocationIn>,
  repository: string,
  config: PipelineConfig,
  /** The run log's records in memory, or `"run-log"` for the run's real run log. */
  records: Array<RunLogRecord> | "run-log",
  range = { baseOid: "1".repeat(40), headOid: "2".repeat(40) },
  run = {
    runId: "01J00000000000000000000000",
    cycleId: "01J00000000000000000000001",
  },
) =>
  Effect.gen(function* () {
    return {
      location,
      repository,
      runId: run.runId,
      runKey: "c".repeat(64),
      cycleId: run.cycleId,
      range: { baseRef: "main", ...range },
      config,
      log:
        records === "run-log"
          ? openRunLog(location, run.runId)
          : {
              path: "",
              write: (record: RunLogRecord) => {
                records.push(
                  JSON.parse(JSON.stringify(record)) as RunLogRecord,
                );
              },
              read: () => records,
            },
      startedAt: Date.now(),
      reconciliationId: "01J00000000000000000000002",
      records: yield* Effect.context<SqlLayer>(),
    } satisfies RunContext["Service"];
  });

/** Stored under a key of its content alone, so the fill's input keys are the same on every run. */
const putFixed = (op: string, value: unknown) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const result = yield* store.run(
      { op, opVersion: 1, inputs: { value: sha256Hex(canonicalJson(value)) } },
      Effect.succeed({
        bytes: new TextEncoder().encode(JSON.stringify(value)),
        mediaType: "application/json",
      }),
    );
    return result.computation.key;
  });

const setup = {
  precompute: "unused",
  scopeKey: null,
  refreshKey: null,
  pins: [],
  disclosures: [],
};

/**
 * A repository of two commits whose structures need no Graph: one hunk in a Markdown file spanning
 * two headings (one section off, two on), a second Markdown file, and a lockfile.
 */
const markdownRepository = (name: string) => {
  const repository = join(root, name);
  const git = (...args: Array<string>) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(repository, path), text);
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-q",
      "-m",
      "change",
    );
    return git("rev-parse", "HEAD");
  };
  mkdirSync(repository, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repository]);
  const baseOid = commit({
    "notes.md": "# Alpha\nalpha\n\n# Beta\nbeta\n",
    "other.md": "# Gamma\ngamma\n",
    "bun.lock": "{}\n",
  });
  const headOid = commit({
    "notes.md": "# Alpha\nalpha two\n\n# Beta\nbeta two\n",
    "other.md": "# Gamma\ngamma two\n",
    "bun.lock": '{ "lockfileVersion": 1 }\n',
  });
  return { repository, range: { baseOid, headOid } };
};

test("with the block absent, fill reads no structure and stores exactly the batches built with no structures", async () => {
  // Reason: off must cost nothing and change nothing. Proved as a property, with no key constant:
  // a key computed on one commit does not survive other lanes' changes to what the fill stores.
  // First no structure read (no span, no gap), so a leak of the read fails here on any branch.
  // Then the stored batches, byte for byte, against the batches built in the test from the same
  // inputs with `structures` left out: `batchInputs` is private, so the test builds its inputs the
  // way `fill` does, from the exported `fillGroups` and `linkChangeMap`, passes them to the
  // exported `codeFilledBatch`, and applies the proof listing as `fill` applies it. Last the stage
  // key: the same in a second new store, another with the switch on, since there the Markdown
  // hunk is cut at its two headings. The repository is Markdown, so none of this needs Graph.
  const { repository, range } = markdownRepository("repo-off");
  const inputsIn =
    (config: PipelineConfig, records: Array<RunLogRecord>) =>
    (location: ReturnType<typeof storeLocationIn>) =>
      Effect.gen(function* () {
        const ctx = yield* contextOf(
          location,
          repository,
          config,
          records,
          range,
        );
        const inputs = yield* reviewInputs(repository, range);
        const map = yield* storedOutput(ctx, inputs.mapKey, ReviewMap);
        return {
          ctx,
          inputs,
          map,
          filled: yield* fill(ctx, { ...inputs, setup }),
        };
      });
  const records: Array<RunLogRecord> = [];
  const { value, spans } = await runStore("off", (location) =>
    Effect.gen(function* () {
      const { ctx, inputs, map, filled } = yield* inputsIn(
        defaultConfig(),
        records,
      )(location);
      const stored = yield* Effect.forEach(filled.groups, (group) =>
        Effect.map(storedBytes(ctx, group.assembledKey), (bytes) =>
          new TextDecoder().decode(bytes),
        ),
      );
      const listed = yield* withRecords(
        ctx,
        Effect.result(
          Proofs.list({ repository: ctx.repository, range: ctx.range }),
        ),
      );
      const built = fillGroups(map).map((group) => {
        const changeMap = linkChangeMap(frame, map);
        const behaviour = changeMap.behaviours.find(
          (entry) => entry.id === group.id,
        );
        if (behaviour === undefined) throw new Error(`No group ${group.id}`);
        const batch: BatchInputs = {
          behaviour,
          changeMap,
          manifest: inputs.manifest,
          hunks: new Map(
            inputs.manifest.hunks.map((hunk) => [hunk.hunkId, hunk]),
          ),
          snapshot: undefined,
          pins: setup.pins,
          keys: {
            manifest: inputs.manifestKey,
            changeMap: inputs.mapKey,
            scope: setup.scopeKey,
          },
        };
        const output = codeFilledBatch(batch);
        if (listed._tag === "Failure") {
          output.complete = false;
          output.gaps.push(
            "The range's proof records could not be read; verification has no proof credit.",
          );
        } else if (listed.success.records.length > 0)
          throw new Error("A new store holds no proof records");
        return JSON.stringify(output);
      });
      return {
        key: filled.record.key,
        groups: filled.groups.map((group) => group.group),
        stored,
        built,
      };
    }),
  );
  expect(
    spans.filter((span) => span.name.includes("structure")).map((s) => s.name),
  ).toEqual([]);
  expect(records.filter((record) => record.type === "gap")).toEqual([]);
  expect(value.groups).toEqual(["g1", "g2", "generated"]);
  expect(value.stored).toEqual(value.built);
  const keyIn = (name: string, config: PipelineConfig) =>
    runStore(name, (location) =>
      Effect.map(
        inputsIn(config, [])(location),
        ({ filled }) => filled.record.key,
      ),
    ).then((run) => run.value);
  expect(value.key).toBeDefined();
  expect(await keyIn("off-again", defaultConfig())).toBe(value.key);
  expect(
    await keyIn(
      "off-on",
      defaultConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sectionsConfig(true),
      ),
    ),
  ).not.toBe(value.key);
}, 120_000);

const engine = outlineExecutable();
const graph = graphTestPrerequisite({
  available: existsSync(engine),
  message:
    "Graph engine is missing at apps/neuve-graph/entire-graph. Run `bun run build:graph` from the workspace root.",
});

/**
 * A repository of two commits: two changed functions and a deleted one in one source file, and one
 * changed function in a second file.
 */
const repositoryOf = (name: string) => {
  const repository = join(root, name);
  const git = (...args: Array<string>) => {
    const result = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = (message: string) => {
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-q",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  mkdirSync(join(repository, "src"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repository]);
  const file = join(repository, "src", "calc.ts");
  writeFileSync(
    file,
    `export function alpha(input: number): number {
  return input + 1;
}
export const gamma = (input: number): number => input - 3;
export function beta(input: number): number {
  return input * 2;
}
`,
  );
  // A second file, so the map has two groups (`mapOf` places files in groups by their order).
  const other = join(repository, "src", "other.ts");
  writeFileSync(
    other,
    `export function delta(input: number): number {
  return input;
}
`,
  );
  const base = commit("base");
  writeFileSync(
    other,
    `export function delta(input: number): number {
  return input + 4;
}
`,
  );
  writeFileSync(
    file,
    `export function alpha(input: number): number {
  return input + 10;
}
export function beta(input: number): number {
  return input * 20;
}
`,
  );
  const head = commit("change alpha and beta, delete gamma");
  return { repository, range: { baseOid: base, headOid: head } };
};

/** The manifest Precompute computes for the range, stored, and a map of two groups, one per file. */
const reviewInputs = (
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
) =>
  Effect.gen(function* () {
    const manifest = yield* rangeManifest(
      repository,
      range,
      defaultManifestSettings(1_000_000),
      captureOutlineSource(),
    );
    const hunks = manifest.value.hunks;
    const frameKey = yield* putFixed("test.frame", frame);
    const mapKey = yield* putFixed("test.map", {
      ...mapOf([...hunks], 2),
      frame: frameKey,
    });
    return {
      manifest: manifest.value,
      manifestKey: manifest.key,
      mapKey,
      frameKey,
    };
  });

/** Every changed line the stored batches' units own, as `hunk side line`, sorted. */
const ownedLines = (batches: ReadonlyArray<AssembledBatch>) =>
  batches
    .flatMap((batch) => batch.units)
    .flatMap((unit) =>
      unit.ownedRanges.flatMap((range) =>
        range.kind === "lines"
          ? Array.from(
              { length: range.endLine - range.startLine + 1 },
              (_, i) => `${range.hunkId} ${range.side} ${range.startLine + i}`,
            )
          : [`${range.hunkId} whole`],
      ),
    )
    .sort();
/** Every changed line the review rules give the manifest's hunks, in the same form. */
const rulesLines = (manifest: RangeManifest) =>
  manifest.hunks
    .flatMap((hunk) =>
      hunk.ownedRanges
        .filter((range) => range.lineCount > 0 && range.startLine > 0)
        .flatMap((range) =>
          Array.from(
            { length: range.lineCount },
            (_, i) => `${hunk.hunkId} ${range.side} ${range.startLine + i}`,
          ),
        ),
    )
    .sort();

const batchesOf = (
  ctx: RunContext["Service"],
  groups: ReadonlyArray<{ readonly assembledKey: string }>,
) =>
  Effect.forEach(groups, (group) =>
    storedOutput(ctx, group.assembledKey, AssembledBatch),
  );

test.skipIf(graph.skip)(
  "with the block present, fill cuts the change at its functions and every changed line keeps the review rules' owner",
  async () => {
    // Reason: the switch must do what it says.
    graph.require();
    const { repository, range } = repositoryOf("repo-on");
    const { value, spans } = await runStore("on", (location) =>
      Effect.gen(function* () {
        const inputs = yield* reviewInputs(repository, range);
        const off = yield* contextOf(
          location,
          repository,
          defaultConfig(),
          [],
          range,
        );
        const records: Array<RunLogRecord> = [];
        const on = yield* contextOf(
          location,
          repository,
          defaultConfig(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            sectionsConfig(true),
          ),
          records,
          range,
        );
        const without = yield* fill(off, { ...inputs, setup });
        const withSections = yield* fill(on, { ...inputs, setup });
        return {
          groups: withSections.groups.length,
          manifest: inputs.manifest,
          without: {
            key: without.record.key,
            batches: yield* batchesOf(off, without.groups),
          },
          with: {
            key: withSections.record.key,
            batches: yield* batchesOf(on, withSections.groups),
          },
          records,
        };
      }),
    );
    const titles = (batches: ReadonlyArray<AssembledBatch>) =>
      batches
        .flatMap((batch) => batch.units)
        .flatMap((unit) =>
          (unit.sections ?? []).map((section) => section.title),
        );
    // Off: one section per hunk. On: one per function, the deleted one included.
    expect(titles(value.without.batches).length).toBe(
      value.manifest.hunks.length,
    );
    expect(titles(value.with.batches).sort()).toEqual([
      "Changes to alpha in calc.ts",
      "Changes to beta in calc.ts",
      "Changes to delta in other.ts",
      "Changes to gamma in calc.ts",
    ]);
    // Each run stores its own fill.
    expect(value.with.key).not.toBe(value.without.key);
    // Ownership is the review rules', on and off, with no gap.
    for (const run of [value.without, value.with]) {
      expect(ownedLines(run.batches)).toEqual(rulesLines(value.manifest));
      for (const batch of run.batches) {
        expect({ complete: batch.complete, gaps: batch.gaps }).toEqual({
          complete: true,
          gaps: [],
        });
        expect(batch.gaps).toEqual([]);
      }
    }
    // Precompute stored both sides' structures: the fill read them and asked Graph for none, once
    // for its two Map groups.
    expect(value.groups).toBe(2);
    const reads = spans.filter(
      (span) => span.name === "harness.code-fill.structures",
    );
    expect(reads.length).toBe(1);
    expect(Object.fromEntries(reads[0]!.attributes)).toMatchObject({
      "harness.structures.asked": 4,
      "harness.structures.stored": 4,
      "harness.structures.computed": 0,
      "harness.structures.status": "read",
      "harness.structures.unread": 0,
    });
    expect(
      spans.filter(
        (span) =>
          span.name === "harness.code-fill.structures" ||
          span.name === "harness.structure.read",
      ).length,
    ).toBe(2);
    expect(value.records.filter((record) => record.type === "gap")).toEqual([]);
  },
  120_000,
);

test.skipIf(graph.skip)(
  "one blob under two paths whose structures differ is given to the units with none and why, never left out; fill completes with one section per hunk",
  async () => {
    // Reason: a blob read under two paths whose structures differ must reach the units, not be
    // left out: the shared helper gives it a structure with no spans (`conflicting-paths`), so its
    // hunks keep one section each, and the read counts it.
    graph.require();
    const repository = join(root, "repo-two-paths");
    const git = (...args: Array<string>) => {
      const result = Bun.spawnSync(["git", "-C", repository, ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const commit = (message: string) => {
      git("add", "-A");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "-q",
        "-m",
        message,
      );
      return git("rev-parse", "HEAD");
    };
    mkdirSync(repository, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repository]);
    // The same text under a Markdown path (cut at its headings) and a plain-text one (no cut).
    const both = (text: string) => {
      writeFileSync(join(repository, "notes.md"), text);
      writeFileSync(join(repository, "notes.txt"), text);
    };
    both("# Alpha\nalpha\n\n# Beta\nbeta\n");
    const baseOid = commit("base");
    both("# Alpha\nalpha two\n\n# Beta\nbeta\n");
    const headOid = commit("head");
    const range = { baseOid, headOid };
    const { value, spans } = await runStore("two-paths", (location) =>
      Effect.gen(function* () {
        const inputs = yield* reviewInputs(repository, range);
        const on = yield* contextOf(
          location,
          repository,
          defaultConfig(
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            sectionsConfig(true),
          ),
          [],
          range,
        );
        const filled = yield* fill(on, { ...inputs, setup });
        return {
          manifest: inputs.manifest,
          batches: yield* batchesOf(on, filled.groups),
        };
      }),
    );
    const sections = value.batches
      .flatMap((batch) => batch.units)
      .flatMap((unit) => unit.sections ?? []);
    expect(sections.length).toBe(value.manifest.hunks.length);
    expect(ownedLines(value.batches)).toEqual(rulesLines(value.manifest));
    // Both blobs are read under both paths, and both are given to the units, with no cut.
    const reads = spans.filter(
      (span) => span.name === "harness.code-fill.structures",
    );
    expect(Object.fromEntries(reads[0]!.attributes)).toMatchObject({
      "harness.structures.asked": 4,
      "harness.structures.conflicting": 2,
      "harness.structures.blobs": 2,
    });
  },
  120_000,
);

test("with Graph unavailable, or the structure read failing, fill completes with one section per hunk and the gap counted", async () => {
  // Reason: a Graph failure must not fail a review. The engine is named at a path where none is,
  // as an install without it would be; the read failure is a repository whose blobs cannot be read.
  const { repository, range } = repositoryOf("repo-unavailable");
  const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
  process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = join(root, "no-engine");
  try {
    const { value, spans } = await runStore("unavailable", (location) =>
      Effect.gen(function* () {
        const inputs = yield* reviewInputs(repository, range);
        const config = defaultConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          sectionsConfig(true),
        );
        const unavailable: Array<RunLogRecord> = [];
        const ctx = yield* contextOf(
          location,
          repository,
          config,
          unavailable,
          range,
        );
        const filled = yield* fill(ctx, { ...inputs, setup });
        // The same range over a folder that is not a repository, so no blob can be read.
        const notRepository = mkdtempSync(join(root, "not-a-repository-"));
        // A run of its own with its real run log, through the real Link stage, so what Records and
        // the run log hold is what their readers get.
        const failing = yield* contextOf(
          location,
          notRepository,
          config,
          "run-log",
          range,
          { runId: mintUlid(), cycleId: mintUlid() },
        );
        const cold = yield* fill(failing, { ...inputs, setup });
        yield* link(failing, {
          frameKey: inputs.frameKey,
          mapKey: inputs.mapKey,
          manifestKey: inputs.manifestKey,
          fill: cold,

          setup,
        });
        const disclosed = (yield* Log.history({
          cycleId: failing.cycleId,
          limit: 10_000,
        }))
          .map((entry) => entry.event)
          .filter((event) => event.kind === "gap.disclosed@1");
        return {
          manifest: inputs.manifest,
          unavailable: {
            batches: yield* batchesOf(ctx, filled.groups),
            records: unavailable,
          },
          failed: {
            batches: yield* batchesOf(failing, cold.groups),
            records: failing.log.read(),
            disclosed,
          },
        };
      }),
    );
    for (const run of [value.unavailable, value.failed]) {
      const sections = run.batches
        .flatMap((batch) => batch.units)
        .flatMap((unit) => unit.sections ?? []);
      expect(sections.length).toBe(value.manifest.hunks.length);
      expect(ownedLines(run.batches)).toEqual(rulesLines(value.manifest));
    }
    const reads = spans
      .filter((span) => span.name === "harness.code-fill.structures")
      .map((span) => Object.fromEntries(span.attributes));
    expect(reads.length).toBe(2);
    // Graph unavailable: the capture gives an unavailable key and the read succeeds; every blob has
    // no structure, counted by reason.
    expect(reads[0]).toMatchObject({
      "harness.structures.asked": 4,
      "harness.structures.status": "read",
      "harness.structures.unread": 0,
      "harness.structures.none.capability-unavailable": 4,
    });
    expect(value.unavailable.records.filter((r) => r.type === "gap")).toEqual(
      [],
    );
    // The read failed: no structures, the gap counted on the span and kept in the run log with its
    // detail and cause; plumbing a reader cannot act on, so Records discloses nothing for it.
    expect(reads[1]).toMatchObject({
      "harness.structures.asked": 4,
      "harness.structures.status": "failed",
      "harness.structures.unread": 4,
    });
    const gaps = value.failed.records.filter((r) => r.type === "gap");
    expect(gaps).toEqual([
      {
        type: "gap",
        stage: "link",
        agent: "link.fill",
        kind: "structures",
        published: false,
        detail:
          "The changed files' structures couldn't be read, so each hunk is its own section.",
        cause: expect.stringMatching(
          /^GitFailed; 4 blobs without a structure$/,
        ),
        ...(gaps[0]?.at === undefined ? {} : { at: gaps[0].at }),
      },
    ]);
    expect(
      value.failed.disclosed.filter(
        (event) =>
          event.kind === "gap.disclosed@1" &&
          (event.payload.kind === "structures" ||
            event.payload.detail === "no detail recorded"),
      ),
    ).toEqual([]);
  } finally {
    if (previous === undefined)
      delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
  }
}, 120_000);
