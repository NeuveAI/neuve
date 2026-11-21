/**
 * Setup's work after its opening, as named steps with a record of those applied, so an upgrade
 * runs what a new version adds and prunes what it drops ([the Codex runtime design](../../../process/proposals/codex-runtime.md#setup-install-and-upgrade)).
 * It is opencode's convention for the same problem: named migrations and a table of those
 * completed, not a "last version" marker.
 *
 * A step is per machine or per repository, says what it does, and says whether it needs the
 * person's answer: a step that writes an agent's configuration or a repository asks, and without a
 * terminal it waits and is reported, never answered for the person. A step is never deleted from
 * the list: a version that drops one keeps it, marked dropped, so a record naming it is understood,
 * and undoes it only when the step says how; otherwise it is reported. A record that names a step
 * this list doesn't hold was written by a newer Neuve, and this one leaves it alone. Which version
 * wrote an entry is kept only to be read: a checkout and a release name their versions differently,
 * so the number decides nothing.
 *
 * What a run of a step comes to, and what the record keeps:
 *
 *   applied      it did its work                                   recorded
 *   checked      it looked without storing anything (the upgrade's  recorded
 *                look at the agent programs)
 *   considered   nothing to do, for a reason it names (no program  recorded, with the reason
 *                found, no skill to offer, --no-skills)
 *   waiting      it needs an answer and there is no terminal       not recorded, reported
 *   skipped      it stopped short and should try again             not recorded
 *
 *   state of a step                     neuve setup                  neuve setup upgrade
 *   never applied                       runs it; one that asks       the same
 *                                       waits for a terminal
 *   never applied, its work there       recorded, not run            the same
 *   applied                             runs again unless it asks    nothing
 *   checked or considered               runs again                   nothing
 *   dropped by this version, recorded   undone if it says how, else  the same
 *                                       reported; taken out of the
 *                                       record, so once
 *   record names a step unknown here    left alone, said so          the same
 *   record damaged                      left alone, said so          the same
 *
 * For a step that asks, applied means asked and answered, yes or no, so a no is not asked again.
 * Any change to the record's format raises its schema number: an older build that rewrites the
 * file keeps only the schema number and the steps, so a field it doesn't know would be lost.
 * The record is written after each step, so a run that stops midway leaves the rest to the next.
 */
import { lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { Settings } from "@neuve/harness";
import type { AgentHarness } from "./capture/agent-hooks.ts";
import { writePrivateEnvironment } from "./private-environment.ts";
import { offerSkillsAfterSetup, type SkillsContext } from "./skills-cli.ts";

export type StepScope = "machine" | "repository";

/** What a run of a step came to; see the table above. */
export type StepResult =
  | "applied"
  | "checked"
  | { readonly considered: string }
  | "waiting"
  | "skipped";

interface StepBase {
  /** Its name in the record; never reused for other work. */
  readonly id: string;
  readonly scope: StepScope;
  /** What it does, as a phrase after "setup". */
  readonly does: string;
  /** It needs the person's answer: it writes an agent's configuration or a repository. */
  readonly asks: boolean;
  /** Left out of this run by the person's own flag, named here: recorded as considered for it. */
  readonly leftOut?: string;
  /** Whether its work is already there, for a machine or repository set up before steps were recorded. */
  readonly done?: () => Promise<boolean>;
  /** Undoes it, removing only what Neuve wrote and still recognises as its own; says what it did and left. */
  readonly undo?: () => Promise<string>;
}

export type SetupStep =
  | (StepBase & {
      readonly dropped?: undefined;
      readonly run: () => Promise<StepResult>;
    })
  | (StepBase & { readonly dropped: true });

/** The repository's record, beside its setup record in the store. */
export const repositoryStepsRecord = (stateDirectory: string) =>
  join(stateDirectory, "setup-steps.json");

/** The machine's record, beside the person's Neuve settings. */
export const machineStepsRecord = (home: string) =>
  join(dirname(Settings.settingsPath(home)), "setup-steps.json");

const SCHEMA_VERSION = 1;

/** Read loosely: a newer version may add fields. */
const recordSchema = z.looseObject({
  schemaVersion: z.number().int(),
  steps: z.record(
    z.string(),
    z.looseObject({
      appliedAt: z.string(),
      by: z.string(),
      /** Absent in records written before outcomes were kept: applied. */
      outcome: z.enum(["applied", "checked", "considered"]).optional(),
      reason: z.string().optional(),
    }),
  ),
});
type Entries = z.infer<typeof recordSchema>["steps"];
type Entry = Entries[string];

type RecordRead =
  | { readonly kind: "read"; readonly steps: Entries }
  | { readonly kind: "newer" | "damaged"; readonly why: string };

const damaged = (path: string): RecordRead => ({
  kind: "damaged",
  why: `${path} is damaged: this Neuve can't read it. Move it away, and neuve setup starts it again`,
});

/** The record as this build can use it, or why it is left alone. */
export const readStepsRecord = async (
  path: string,
  steps: ReadonlyArray<SetupStep>,
): Promise<RecordRead> => {
  let text: string;
  try {
    if (!(await lstat(path)).isFile()) return damaged(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "read", steps: {} };
    return damaged(path);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return damaged(path);
  }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return damaged(path);
  const record = parsed.data;
  if (record.schemaVersion > SCHEMA_VERSION)
    return {
      kind: "newer",
      why: `a newer Neuve wrote ${path}. Use a Neuve at least that new`,
    };
  if (record.schemaVersion !== SCHEMA_VERSION) return damaged(path);
  const known = new Set(steps.map((step) => step.id));
  const unknown = Object.keys(record.steps).find((id) => !known.has(id));
  if (unknown !== undefined)
    return {
      kind: "newer",
      why: `a newer Neuve wrote ${path}: it names a step, ${unknown}, that this one doesn't know. Use a Neuve that knows it`,
    };
  return { kind: "read", steps: record.steps };
};

const outcomeOf = (entry: Entry) => entry.outcome ?? "applied";

export interface StepsRun {
  /** One scope's steps, in the order they run. */
  readonly steps: ReadonlyArray<SetupStep>;
  readonly record: string;
  /** `setup` runs again every step that doesn't ask; `upgrade` runs only what the record lacks. */
  readonly mode: "setup" | "upgrade";
  /** Where, for what is said: "this machine" or the repository. */
  readonly where: string;
  readonly isTerminal: boolean;
  readonly version: string;
  readonly out: (text: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface StepsOutcome {
  /** What was recorded or taken out of the record in this run, by id. */
  readonly changed: ReadonlyArray<string>;
  /** The steps left for a terminal. */
  readonly waiting: ReadonlyArray<SetupStep>;
  /**
   * Every step still to do once the run ends, waiting or not: those the record still lacks. The
   * same as doctor's `pendingSteps`, from the same rule (`stillToDo`).
   */
  readonly toDo: ReadonlyArray<SetupStep>;
  /** Why the record was left alone, when it was. */
  readonly left?: string;
}

/** The steps a record still lacks: what is left to do, for setup's summary and for doctor alike. */
const stillToDo = (steps: ReadonlyArray<SetupStep>, entries: Entries) =>
  steps.filter(
    (step) => step.dropped === undefined && entries[step.id] === undefined,
  );

/** Runs one scope's steps against its record, writing the record after each change. */
export const runSteps = async (run: StepsRun): Promise<StepsOutcome> => {
  const read = await readStepsRecord(run.record, run.steps);
  if (read.kind !== "read") {
    await run.out(
      `Setup's steps for ${run.where} were left as they are: ${read.why}.\n`,
    );
    return { changed: [], waiting: [], toDo: [], left: read.why };
  }
  const entries: Entries = { ...read.steps };
  const changed: string[] = [];
  const save = async (id: string) => {
    changed.push(id);
    await mkdir(dirname(run.record), { recursive: true, mode: 0o700 });
    await writePrivateEnvironment(
      run.record,
      `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, steps: entries }, null, 2)}\n`,
    );
  };
  /** Records what a run came to, unless the record already says the same. */
  const keep = async (
    id: string,
    result: Exclude<StepResult, "waiting" | "skipped">,
  ) => {
    const outcome = typeof result === "string" ? result : "considered";
    const reason = typeof result === "string" ? undefined : result.considered;
    const earlier = entries[id];
    if (
      earlier !== undefined &&
      outcomeOf(earlier) === outcome &&
      earlier.reason === reason
    )
      return;
    entries[id] = {
      appliedAt: (run.now?.() ?? new Date()).toISOString(),
      by: run.version,
      ...(outcome === "applied" ? {} : { outcome }),
      ...(reason === undefined ? {} : { reason }),
    };
    await save(id);
  };
  const waiting: SetupStep[] = [];
  for (const step of run.steps) {
    const earlier = entries[step.id];
    if (step.dropped === true) {
      if (earlier === undefined) continue;
      await run.out(
        `${
          step.undo === undefined
            ? `Setup no longer ${step.does} in ${run.where}. This step has no undo, so what it did there is left as it is.`
            : await step.undo()
        }\n`,
      );
      delete entries[step.id];
      await save(step.id);
      continue;
    }
    // Applied: an upgrade leaves it, and setup asks nothing twice. Checked or considered: only the
    // upgrade leaves it, since setup's full run may now find work to do.
    if (
      earlier !== undefined &&
      (run.mode === "upgrade" ||
        (step.asks && outcomeOf(earlier) === "applied"))
    )
      continue;
    // Work already there counts before the person's flag: a repository offered the skill before
    // steps were recorded has it applied, whatever this run leaves out.
    if (earlier === undefined && (await step.done?.()) === true) {
      await keep(step.id, "applied");
      continue;
    }
    if (step.leftOut !== undefined) {
      await keep(step.id, { considered: step.leftOut });
      continue;
    }
    if (step.asks && !run.isTerminal) {
      waiting.push(step);
      continue;
    }
    const result = await step.run();
    if (result === "waiting") waiting.push(step);
    else if (result !== "skipped") await keep(step.id, result);
  }
  if (waiting.length > 0)
    await run.out(
      `Waiting in ${run.where} for an answer at a terminal: setup ${waiting.map((step) => step.does).join("; ")}. Run neuve setup there at a terminal to be asked.\n`,
    );
  const toDo = stillToDo(run.steps, entries);
  const other = toDo.filter((step) => !waiting.includes(step));
  if (other.length > 0)
    await run.out(
      `Still to do in ${run.where}: setup ${other.map((step) => step.does).join("; ")}. neuve setup there does it.\n`,
    );
  return { changed, waiting, toDo };
};

/**
 * What doctor says, read only: the steps not applied yet, those considered with their reasons, or
 * why the record is left alone.
 */
export const pendingSteps = async (
  steps: ReadonlyArray<SetupStep>,
  record: string,
): Promise<{
  waiting: ReadonlyArray<SetupStep>;
  considered: ReadonlyArray<{ step: SetupStep; reason: string }>;
  left?: string;
}> => {
  const read = await readStepsRecord(record, steps);
  if (read.kind !== "read")
    return { waiting: [], considered: [], left: read.why };
  const waiting: SetupStep[] = [];
  // Work already there, which a run would record before anything else, isn't left to do.
  for (const step of stillToDo(steps, read.steps))
    if ((await step.done?.()) !== true) waiting.push(step);
  const considered: Array<{ step: SetupStep; reason: string }> = [];
  for (const step of steps) {
    const entry = read.steps[step.id];
    if (
      step.dropped === undefined &&
      entry !== undefined &&
      outcomeOf(entry) === "considered"
    )
      considered.push({ step, reason: entry.reason ?? "no reason was kept" });
  }
  return { waiting, considered };
};

/**
 * Setup's steps on this machine. Looking for the agent programs writes only Neuve's settings, and
 * its install offer asks for itself and is remembered per machine, so the step doesn't wait. `look`
 * says what it did: `applied` for setup's full look, which stores the Codex it finds; `checked` for
 * the upgrade's, which asks only what run time would start and stores nothing.
 */
export const machineSteps = (
  look: () => Promise<"applied" | "checked" | "skipped">,
): ReadonlyArray<SetupStep> => [
  {
    id: "agent-programs",
    scope: "machine",
    does: "looks for the agent programs, stores the Codex it finds and offers to install one that is missing",
    asks: false,
    run: look,
  },
];

/**
 * Setup's steps in one repository, whose setup folder is `stateDirectory`. The skill offer writes
 * the person's agent configuration, so it asks. Its own marker, `skills-offered.json`, still says
 * whether it was made, so a repository offered the skill before steps were recorded isn't asked
 * again. An offer that couldn't be made is considered, with the reason, so doctor names it rather
 * than calling it not applied.
 */
/** The reasons setup leaves the skill offer out, as the person's flags say. */
export const SKILL_LEFT_OUT = {
  noSkills: "--no-skills left the skill offer out",
  noAgents: "--agents none named no agent program to offer it to",
} as const;

export const repositorySteps = (
  stateDirectory: string,
  agents: () => Promise<ReadonlyArray<AgentHarness>>,
  /** Why this run leaves the offer out, when it does: recorded as considered for it. */
  leftOut?: string,
  /** `agents` comes from the upgrade's narrow look, so finding none is no reason to record. */
  narrow = false,
  /** For tests: the skill offer's surroundings, in place of the person's terminal and home. */
  context?: SkillsContext,
): ReadonlyArray<SetupStep> => {
  const offered = async () =>
    (await lstat(join(stateDirectory, "skills-offered.json")).catch(
      () => undefined,
    )) !== undefined;
  return [
    {
      id: "skill-offer",
      scope: "repository",
      does: "offers the Neuve skill to the agent programs found",
      asks: true,
      ...(leftOut === undefined ? {} : { leftOut }),
      done: offered,
      run: async () => {
        const found = await agents();
        const result = await offerSkillsAfterSetup({
          stateDirectory,
          agents: found,
          ...(context === undefined ? {} : { context }),
        });
        if (await offered()) return "applied";
        return result.reason === undefined || (narrow && found.length === 0)
          ? "skipped"
          : { considered: result.reason };
      },
    },
  ];
};
