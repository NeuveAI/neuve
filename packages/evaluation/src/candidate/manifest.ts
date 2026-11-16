import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_LIMITS } from "@neuve/harness/session-dump";
import { labelOf, type ConcernRow } from "../pr-replay/evidence.ts";
import { CANDIDATE_RUN, runFolder, scoredRun } from "../pr-replay/sources.ts";
import {
  parityEntries,
  type ParityEntry,
} from "../harness-compare/full-test/parity.ts";
import {
  CaptureRead,
  captureBlockers,
  loadSessionDumpReader,
  readCandidateCapture,
  type SessionDumpReader,
} from "./capture.ts";

/**
 * A pinned manifest of the runs a comparison scores (NEU-58): each case's identity, each run's
 * receipt-derived execution, build, route, labels and rubric revisions, and the sha256 of every file
 * read, so the baseline's immutability and the candidate's identity can be checked again later. It is
 * written once, outside the research volume, and reads the research volume only.
 *
 * A run's execution comes from its receipt, never from an exit code: completed only when the outcome
 * is completed, the packet is complete with a batch, and every stage was computed or reused. A file
 * being present is not a completed review; the counts keep the two apart. A candidate is scorable only
 * when its execution completed, its build differs from its replay run only where declared and its
 * run policy not at all except for an explicitly named effort comparison. Its session dump, read by
 * the capture lane's reader, must be complete and show every stage completed (captureBlockers).
 */

export const MANIFEST_KIND = "neuve.validation-manifest";
export const MANIFEST_VERSION = 3;
export const EffortComparison = z.enum(["low", "medium"]);
export type EffortComparison = z.infer<typeof EffortComparison>;

const count = z.number().int().nonnegative();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const Usage = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite5m: count.optional(),
  cacheWrite1h: count.optional(),
  thinking: count.optional(),
});
export type Usage = z.infer<typeof Usage>;

/** The parts of a receipt (`neuve review show --json`, RunReceipt) execution and tokens are read from. */
const ReceiptView = z.object({
  type: z.literal("receipt"),
  runId: z.string().regex(RUN_ID),
  route: z.object({ model: z.string(), effort: z.string() }),
  outcome: z.enum(["completed", "timed-out"]),
  timeout: z.object({ lifetimeMs: count, reached: z.boolean() }),
  stages: z.array(
    z.object({ stage: z.string(), agent: z.string(), status: z.string() }),
  ),
  totals: z.object({ modelCalls: count, usage: Usage }),
  packet: z
    .object({ complete: z.boolean(), batches: z.array(z.unknown()) })
    .nullable()
    .optional(),
});

/** A stage that produced its output; any other status leaves the review partial. */
const DONE_STAGES: ReadonlySet<string> = new Set(["computed", "reused"]);

export const Execution = z.discriminatedUnion("state", [
  z.object({ state: z.literal("completed") }),
  z.object({
    state: z.enum(["timed-out", "partial", "missing", "malformed"]),
    why: z.string(),
  }),
]);
export type Execution = z.infer<typeof Execution>;

const RunBuild = z.object({
  commit: z.string().nullable(),
  productCommit: z.string().nullable(),
  graph: z.string().nullable(),
  imageId: z.string().nullable(),
  deadlineS: z.number().nullable(),
  settings: z.unknown(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  lifetimeMs: z.number().nullable(),
  reading: z.boolean(),
  /** A candidate's: what it declared, what differs, and its control's receipt digest. */
  declared: z.array(z.string()).nullable(),
  differences: z.array(z.string()).nullable(),
  undeclared: z.array(z.string()).nullable(),
  policy: z.array(z.string()).nullable(),
  candidate: z.string().nullable(),
  controlShowSha256: z.string().nullable(),
});

const ManifestRun = z.object({
  run: z.string(),
  folder: z.string(),
  runId: z.string().nullable(),
  execution: Execution,
  /** Each receipt stage status, counted. */
  stages: z.record(z.string(), count),
  route: z
    .object({ model: z.string(), effort: z.string(), lifetimeMs: count })
    .nullable(),
  tokens: Usage.nullable(),
  modelCalls: count.nullable(),
  build: RunBuild.nullable(),
  labels: z.object({
    matched: z.boolean(),
    confirmation: z
      .object({ version: z.unknown(), promptDigest: z.unknown() })
      .nullable(),
    merit: z
      .object({
        version: z.unknown(),
        revision: z.unknown(),
        incomplete: z.boolean(),
      })
      .nullable(),
  }),
  machine: z
    .object({
      exit: z.number().nullable(),
      attempts: count,
      resumed: z.boolean(),
      receipt: z.string().nullable(),
    })
    .nullable(),
  capture: CaptureRead.nullable(),
  notes: z.array(z.string()),
  /** Why this run may not be scored; empty when it may. */
  blockers: z.array(z.string()),
});
export type ManifestRun = z.infer<typeof ManifestRun>;

const ManifestCase = z.object({
  caseId: z.string(),
  source: z.string(),
  directory: z.string(),
  split: z.string(),
  control: z.boolean(),
  unavailable: z.string().nullable(),
  /** The reviewers' threads: labelled by a majority, unlabelled (no majority: unavailable, never a miss), substantive concerns. */
  threads: z.object({
    rows: count,
    labelled: count,
    unlabelled: count,
    substantive: count,
  }),
  runs: z.array(ManifestRun),
});
export type ManifestCase = z.infer<typeof ManifestCase>;

const FileId = z.object({ path: z.string(), sha256, bytes: count });

export const Manifest = z.object({
  kind: z.literal(MANIFEST_KIND),
  version: z.literal(MANIFEST_VERSION),
  role: z.enum(["baseline", "candidate"]),
  effortComparison: EffortComparison.optional(),
  createdAt: z.string(),
  researchRoot: z.string(),
  treatmentRoot: z.string().nullable(),
  sample: z
    .object({ path: z.string(), sha256, seed: z.string(), cases: count })
    .nullable(),
  runs: z.array(z.string()),
  floor: z.array(z.string()).nullable(),
  floorUniverse: z.array(ManifestCase).nullable(),
  counts: z.record(z.string(), z.unknown()),
  cases: z.array(ManifestCase),
  files: z.array(FileId),
  absent: z.array(z.string()),
});
export type Manifest = z.infer<typeof Manifest>;

export const fileId = (path: string) => {
  const data = readFileSync(path);
  return {
    path,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  };
};

/** Every file a manifest read, by sha256, and every path it found absent: both checked again later. */
class Tracker {
  readonly files = new Map<string, z.infer<typeof FileId>>();
  readonly absent = new Set<string>();
  track(path: string, limit = Number.POSITIVE_INFINITY) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info === undefined) {
      this.absent.add(path);
      return null;
    }
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > limit)
      throw new Error(`${path} exceeds its public capture size limit`);
    const id = this.files.get(path) ?? fileId(path);
    this.files.set(path, id);
    return id;
  }
}

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

/** A run's execution from its receipt: what the receipt says ended, never the machine's exit. */
export const executionOf = (
  receipt: z.infer<typeof ReceiptView>,
): Execution => {
  if (receipt.outcome === "timed-out")
    return { state: "timed-out", why: "the run timed-out" };
  const packet = receipt.packet ?? null;
  if (packet === null) return { state: "partial", why: "it holds no packet" };
  if (!packet.complete)
    return { state: "partial", why: "its packet is partial" };
  if (packet.batches.length === 0)
    return { state: "partial", why: "its packet holds no batch" };
  const unfinished = receipt.stages.filter(
    (stage) => !DONE_STAGES.has(stage.status),
  );
  if (unfinished.length > 0)
    return {
      state: "partial",
      why: `stages not done: ${unfinished.map((stage) => `${stage.agent} ${stage.status}`).join(", ")}`,
    };
  return { state: "completed" };
};

const stringOr = (value: unknown) => (typeof value === "string" ? value : null);
const numberOr = (value: unknown) => (typeof value === "number" ? value : null);
const stringsOr = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as Array<string>)
    : null;

const buildOf = (raw: Record<string, unknown>): z.infer<typeof RunBuild> => {
  const candidate = raw["candidate"] as { name?: unknown } | undefined;
  const control = raw["control"] as { showSha256?: unknown } | undefined;
  return {
    commit: stringOr(raw["commit"]),
    productCommit: stringOr(raw["productCommit"]),
    graph: stringOr(raw["graph"]),
    imageId: stringOr(raw["imageId"]),
    deadlineS: numberOr(raw["deadlineS"]),
    settings: raw["settings"] ?? null,
    model: stringOr(raw["model"]),
    effort: stringOr(raw["effort"]),
    lifetimeMs: numberOr(raw["lifetimeMs"]),
    reading: raw["reading"] === true,
    declared: stringsOr(raw["declared"]),
    differences: stringsOr(raw["differences"]),
    undeclared: stringsOr(raw["undeclared"]),
    policy: stringsOr(raw["policy"]),
    candidate: stringOr(candidate?.name),
    controlShowSha256: stringOr(control?.showSha256),
  };
};

/** The places a run keeps its receipt, build, machine record and labels. */
const placesOf = (directory: string, run: string) => {
  if (run === "first") {
    const folder = join(directory, "run");
    return {
      folder,
      show: join(folder, "show.json"),
      build: join(folder, "cloud", "build.json"),
      machine: join(folder, "cloud", "machine.json"),
      labels: join(directory, "labels"),
      extra: [join(folder, "show.from"), join(folder, "cloud", "show.json")],
    };
  }
  const folder = runFolder(directory, scoredRun(run));
  return {
    folder,
    show: join(folder, "show.json"),
    build: join(folder, "build.json"),
    machine: join(folder, "machine.json"),
    labels: join(folder, "labels"),
    extra: [join(folder, "show.damaged.json"), join(folder, "follow.log")],
  };
};

const MachineView = z.object({
  exit: z.number().nullable(),
  attempts: z.array(
    z.object({
      resumed: z.boolean().optional(),
      receipt: z.object({ status: z.string() }).optional(),
    }),
  ),
  capture: z
    .object({ status: z.string(), why: z.string().optional() })
    .optional(),
});

const CaptureFacts = z.object({
  run: z.string().regex(RUN_ID),
  redaction: z.string().regex(/^[a-z]+$/),
  kind: z.string().regex(/^[a-z]+$/),
  snapshot: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  /** The close that recorded the snapshot: held or interrupted is a partial run, its execution open. */
  close: z.object({
    mode: z.enum(["held", "interrupted", "ended"]),
    execution: z.enum(["open", "ended"]),
  }),
});

const readRunRecord = async (
  tracker: Tracker,
  entry: ParityEntry,
  run: string,
  reader: SessionDumpReader | string,
  effortComparison?: EffortComparison,
): Promise<ManifestRun> => {
  const places = placesOf(entry.directory, run);
  const candidate = CANDIDATE_RUN.test(run);
  const notes: Array<string> = [];
  const show = tracker.track(places.show);
  for (const path of places.extra) tracker.track(path);
  for (const name of [
    "matching.json",
    "matching-key.json",
    "confirmation.json",
    "merit.json",
  ])
    tracker.track(join(places.labels, name));
  for (const pass of ["a", "b", "c"])
    tracker.track(
      join(places.labels, "matching", `pass-${pass}`, "output.json"),
    );
  if (run === "first") {
    const cloud = tracker.files.get(join(places.folder, "cloud", "show.json"));
    if (show !== null && cloud !== undefined && cloud.sha256 !== show.sha256)
      notes.push("run/show.json is not byte-identical to run/cloud/show.json");
  }
  let receipt: z.infer<typeof ReceiptView> | null = null;
  let execution: Execution;
  if (show === null)
    execution = existsSync(join(places.folder, "show.damaged.json"))
      ? { state: "malformed", why: "its receipt arrived damaged" }
      : { state: "missing", why: "no receipt" };
  else {
    let parsed: unknown;
    try {
      parsed = readJson(places.show);
    } catch (error) {
      parsed = error;
    }
    const view = ReceiptView.safeParse(parsed);
    if (view.success) {
      receipt = view.data;
      execution = executionOf(receipt);
    } else
      execution = {
        state: "malformed",
        why: `its receipt is not a receipt: ${view.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      };
  }
  const buildFile = tracker.track(places.build);
  const build =
    buildFile === null
      ? null
      : buildOf(readJson(places.build) as Record<string, unknown>);
  const machineFile = tracker.track(places.machine);
  const machineView =
    machineFile === null
      ? null
      : MachineView.safeParse(readJson(places.machine));
  const machine =
    machineView === null || !machineView.success
      ? null
      : {
          exit: machineView.data.exit,
          attempts: machineView.data.attempts.length,
          resumed: machineView.data.attempts.some((a) => a.resumed === true),
          receipt: machineView.data.attempts.at(-1)?.receipt?.status ?? null,
        };
  if (machineView !== null && !machineView.success)
    notes.push("machine.json does not have its record's shape");
  const confirmationPath = join(places.labels, "confirmation.json");
  const confirmation = tracker.files.has(confirmationPath)
    ? (readJson(confirmationPath) as Record<string, unknown>)
    : null;
  const meritPath = join(places.labels, "merit.json");
  const merit = tracker.files.has(meritPath)
    ? (readJson(meritPath) as {
        version?: unknown;
        summary?: { revision?: unknown; incomplete?: unknown };
      })
    : null;
  let capture: CaptureRead | null = null;
  let closedBy: z.infer<typeof CaptureFacts>["close"] | null = null;
  if (candidate) {
    tracker.track(join(places.folder, "capture.tar"));
    const factsFile = tracker.track(join(places.folder, "capture.json"));
    const facts =
      factsFile === null
        ? null
        : CaptureFacts.safeParse(readJson(join(places.folder, "capture.json")));
    if (facts === null)
      capture = {
        status: "missing",
        why:
          machineView?.success === true &&
          machineView.data.capture?.why !== undefined
            ? machineView.data.capture.why
            : "no capture.json: no session dump was transferred",
      };
    else if (!facts.success)
      capture = {
        status: "unreadable",
        why: "capture.json names no snapshot and the close that recorded it",
      };
    else if (receipt === null)
      capture = { status: "unreadable", why: "no receipt names the run" };
    else {
      const { redaction, kind, run: dumped, snapshot } = facts.data;
      closedBy = facts.data.close;
      const directory = join(
        places.folder,
        "capture",
        redaction,
        kind,
        dumped,
        snapshot,
      );
      tracker.track(
        join(directory, "manifest.json"),
        DEFAULT_LIMITS.manifestBytes,
      );
      tracker.track(
        join(directory, "export.json"),
        DEFAULT_LIMITS.manifestBytes,
      );
      capture = existsSync(directory)
        ? await readCandidateCapture(
            directory,
            { runId: receipt.runId, redaction },
            reader,
          )
        : {
            status: "missing",
            why: `${directory} was never unpacked`,
          };
    }
  }
  const blockers: Array<string> = [];
  if (execution.state !== "completed")
    blockers.push(`execution ${execution.state}: ${execution.why}`);
  if (build?.reading === true) blockers.push("a reading run is never scored");
  if (candidate) {
    if (build === null) blockers.push("no build.json");
    else {
      if (build.candidate !== run)
        blockers.push(
          `build.json names ${String(build.candidate)}, not ${run}`,
        );
      if (build.undeclared === null || build.policy === null)
        blockers.push("build.json records no comparison with its replay run");
      if ((build.undeclared ?? []).length > 0)
        blockers.push(
          `undeclared build differences: ${build.undeclared!.join(", ")}`,
        );
      const effortOnly =
        effortComparison !== undefined &&
        build.policy?.length === 1 &&
        build.policy[0] === "effort" &&
        receipt?.route.effort === effortComparison;
      if ((build.policy ?? []).length > 0 && !effortOnly)
        blockers.push(
          `run policy differs from the replay run: ${build.policy!.join(", ")}`,
        );
      const control = tracker.track(
        join(entry.directory, "run", "cloud", "show.json"),
      );
      if (build.controlShowSha256 !== (control?.sha256 ?? null))
        blockers.push(
          "its control's receipt (run/cloud/show.json) is not the one it was compared with",
        );
    }
    if (
      effortComparison !== undefined &&
      receipt !== null &&
      receipt.route.effort !== effortComparison
    )
      blockers.push(
        `receipt effort ${receipt.route.effort} does not match --effort-comparison ${effortComparison}`,
      );
    if (capture !== null) blockers.push(...captureBlockers(capture));
    if (
      closedBy !== null &&
      (closedBy.mode !== "ended" || closedBy.execution !== "ended")
    )
      blockers.push(
        `its snapshot is the ${closedBy.mode} close, execution ${closedBy.execution}: a partial run`,
      );
  }
  const stages: Record<string, number> = {};
  for (const stage of receipt?.stages ?? [])
    stages[stage.status] = (stages[stage.status] ?? 0) + 1;
  return {
    run,
    folder: places.folder,
    runId: receipt?.runId ?? null,
    execution,
    stages,
    route:
      receipt === null
        ? null
        : {
            model: receipt.route.model,
            effort: receipt.route.effort,
            lifetimeMs: receipt.timeout.lifetimeMs,
          },
    tokens: receipt?.totals.usage ?? null,
    modelCalls: receipt?.totals.modelCalls ?? null,
    build,
    labels: {
      matched:
        tracker.files.has(join(places.labels, "matching.json")) &&
        tracker.files.has(join(places.labels, "matching-key.json")),
      confirmation:
        confirmation === null
          ? null
          : {
              version: confirmation["version"] ?? null,
              promptDigest: confirmation["promptDigest"] ?? null,
            },
      merit:
        merit === null
          ? null
          : {
              version: merit.version ?? null,
              revision: merit.summary?.revision ?? null,
              incomplete: merit.summary?.incomplete === true,
            },
    },
    machine,
    capture,
    notes,
    blockers,
  };
};

const threadsOf = (tracker: Tracker, directory: string) => {
  const labels = join(directory, "labels");
  const path = join(labels, "concerns.jsonl");
  for (const name of [
    "concerns-summary.json",
    "category-relabel.json",
    "rework.json",
  ])
    tracker.track(join(labels, name));
  if (tracker.track(path) === null)
    return { rows: 0, labelled: 0, unlabelled: 0, substantive: 0 };
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => labelOf(JSON.parse(line) as ConcernRow));
  return {
    rows: rows.length,
    labelled: rows.filter((label) => label !== null).length,
    unlabelled: rows.filter((label) => label === null).length,
    substantive: rows.filter(
      (label) => label !== null && label.isConcern && label.substantive,
    ).length,
  };
};

const STATES = ["completed", "timed-out", "partial", "missing", "malformed"];

/** Per run: artifacts present (a receipt on disk) apart from executions completed, then each state. */
export const countsOf = (cases: ReadonlyArray<ManifestCase>) => {
  const runs = [...new Set(cases.flatMap((c) => c.runs.map((r) => r.run)))];
  const tally = (rows: ReadonlyArray<ManifestRun>) => ({
    cases: rows.length,
    receiptPresent: rows.filter(
      (r) => r.execution.state !== "missing" || r.runId !== null,
    ).length,
    ...Object.fromEntries(
      STATES.map((state) => [
        state,
        rows.filter((r) => r.execution.state === state).length,
      ]),
    ),
    scorable: rows.filter((r) => r.blockers.length === 0).length,
    matched: rows.filter((r) => r.labels.matched).length,
    confirmed: rows.filter((r) => r.labels.confirmation !== null).length,
    merit: rows.filter(
      (r) => r.labels.merit !== null && !r.labels.merit.incomplete,
    ).length,
  });
  return Object.fromEntries(
    runs.map((run) => {
      const rows = cases.flatMap((c) =>
        c.runs.filter((r) => r.run === run).map((r) => ({ c, r })),
      );
      const sources = [...new Set(rows.map(({ c }) => c.source))].sort();
      return [
        run,
        {
          ...tally(rows.map(({ r }) => r)),
          bySource: Object.fromEntries(
            sources.map((source) => [
              source,
              tally(
                rows.filter(({ c }) => c.source === source).map(({ r }) => r),
              ),
            ]),
          ),
        },
      ];
    }),
  );
};

export interface ManifestInput {
  readonly role: "baseline" | "candidate";
  readonly effortComparison?: EffortComparison;
  readonly researchRoot: string;
  readonly treatmentRoot: string | null;
  readonly entries: ReadonlyArray<ParityEntry>;
  readonly controls: ReadonlySet<string>;
  readonly runs: ReadonlyArray<string>;
  readonly floor: ReadonlyArray<string> | null;
  readonly sample: {
    readonly path: string;
    readonly seed: string;
  } | null;
  readonly reader: SessionDumpReader | string;
  readonly now: string;
}

/** The manifest of the runs given over the cases given, every file read once and hashed. */
export const collectManifest = async (
  input: ManifestInput,
): Promise<Manifest> => {
  const tracker = new Tracker();
  const sample =
    input.sample === null
      ? null
      : {
          path: input.sample.path,
          sha256: tracker.track(input.sample.path)!.sha256,
          seed: input.sample.seed,
          cases: input.entries.length,
        };
  const collectCase = async (
    entry: ParityEntry,
    control: boolean,
  ): Promise<ManifestCase> => {
    tracker.track(join(entry.directory, "case.json"));
    const runs: Array<ManifestRun> = [];
    for (const run of input.runs)
      runs.push(
        await readRunRecord(
          tracker,
          entry,
          run,
          input.reader,
          input.effortComparison,
        ),
      );
    return {
      caseId: entry.record.caseId,
      source: entry.source,
      directory: entry.directory,
      split: entry.record.split,
      control,
      unavailable: entry.record.unavailable,
      threads: threadsOf(tracker, entry.directory),
      runs,
    };
  };
  const cases: Array<ManifestCase> = [];
  for (const entry of input.entries)
    cases.push(
      await collectCase(entry, input.controls.has(entry.record.caseId)),
    );
  const floorUniverse: Array<ManifestCase> | null =
    input.floor === null ? null : [];
  if (floorUniverse !== null)
    for (const entry of parityEntries(join(input.researchRoot, "cases")))
      if (entry.record.split === "development")
        floorUniverse.push(
          await collectCase(entry, entry.record.control !== null),
        );
  return {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    role: input.role,
    ...(input.effortComparison === undefined
      ? {}
      : { effortComparison: input.effortComparison }),
    createdAt: input.now,
    researchRoot: input.researchRoot,
    treatmentRoot: input.treatmentRoot,
    sample,
    runs: [...input.runs],
    floor: input.floor === null ? null : [...input.floor],
    floorUniverse,
    counts: countsOf(cases),
    cases,
    files: [...tracker.files.values()].sort((a, b) =>
      a.path < b.path ? -1 : 1,
    ),
    absent: [...tracker.absent].sort(),
  };
};

/** What changed since a manifest was written: a file's bytes, a file gone, or a file where none was. */
export const verifyManifest = async (
  manifest: Manifest,
  reader?: SessionDumpReader | string,
) => {
  const changed: Array<string> = [];
  for (const file of manifest.files) {
    const info = lstatSync(file.path, { throwIfNoEntry: false });
    if (info === undefined) changed.push(`${file.path}: gone`);
    else if (!info.isFile()) changed.push(`${file.path}: not a regular file`);
    else if (
      info.size !== file.bytes ||
      fileId(file.path).sha256 !== file.sha256
    )
      changed.push(`${file.path}: changed`);
  }
  for (const path of manifest.absent)
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
      changed.push(`${path}: appeared`);
  if (manifest.floor !== null) {
    if (manifest.floorUniverse === null)
      changed.push("floor universe: not pinned");
    else {
      const identity = (entry: {
        caseId: string;
        source: string;
        directory: string;
      }) => JSON.stringify([entry.caseId, entry.source, entry.directory]);
      const pinned = new Set(manifest.floorUniverse.map(identity));
      const current = new Set(
        parityEntries(join(manifest.researchRoot, "cases"))
          .filter((entry) => entry.record.split === "development")
          .map((entry) =>
            identity({
              caseId: entry.record.caseId,
              source: entry.source,
              directory: entry.directory,
            }),
          ),
      );
      for (const key of [...pinned].sort())
        if (!current.has(key)) changed.push(`floor universe: gone ${key}`);
      for (const key of [...current].sort())
        if (!pinned.has(key)) changed.push(`floor universe: appeared ${key}`);
    }
  }
  if (changed.length > 0) return changed;
  const captures = manifest.cases
    .flatMap((entry) => entry.runs)
    .filter((run) => run.capture !== null && run.capture.status !== "missing");
  if (captures.length > 0) {
    const publicReader = reader ?? (await loadSessionDumpReader());
    for (const run of captures) {
      const facts = CaptureFacts.safeParse(
        readJson(join(run.folder, "capture.json")),
      );
      if (!facts.success || run.runId === null) continue;
      const { redaction, kind, run: dumped, snapshot } = facts.data;
      const directory = join(
        run.folder,
        "capture",
        redaction,
        kind,
        dumped,
        snapshot,
      );
      const current = await readCandidateCapture(
        directory,
        { runId: run.runId, redaction },
        publicReader,
      );
      if (JSON.stringify(current) !== JSON.stringify(run.capture))
        changed.push(
          `${directory}: capture facts changed after public revalidation`,
        );
    }
  }
  return changed;
};
