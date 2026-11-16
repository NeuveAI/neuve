import { CaptureMarked } from "@neuve/harness/session-dump";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";

/**
 * A fresh candidate's session dump (NEU-54's capture), read only through the capture lane's public
 * reader: the one place the evaluation touches the dump format. The reader checks every file's size
 * and hash and its schema; this adapter then checks what scoring relies on, the format and version it
 * supports, the run kind and the run, and refuses anything else by name. A reading or coding run is
 * never scored. Unpacking a dump proves only its transfer. The reader's `complete` means no gap of
 * kind capture. An execution gap is work an open run still owes; once its run.end is captured the same
 * codes count as capture gaps (the capture lane's EXECUTION_GAPS). So a case is scored only when the
 * capture is complete, the run and every stage completed, and no execution gap is left
 * (captureBlockers).
 */

/** The public export the reader comes from; until it is exported, every capture is unreadable. */
export const SESSION_DUMP_EXPORT = "@neuve/harness/session-dump";
/** The dump format this adapter reads; any other format or version is refused, never guessed. */
export const SUPPORTED_DUMP = {
  format: "neuve.session-dump",
  version: 1,
} as const;
/** The capture lane's redaction modes; the dataset folder's first level. */
export const REDACTIONS = ["restricted", "portable"] as const;

const count = z.number().int().nonnegative();
export const DumpTokens = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  reasoning: count.optional(),
  totalTokens: count,
});
export type DumpTokens = z.infer<typeof DumpTokens>;

/** The parts of the reader's restored dump that scoring reads; the rest stays the reader's. */
const ScanMark = z.object({
  policy: z.literal("capture-scan-v1"),
  rawCapture: z.string().regex(/^[a-f0-9]{64}$/),
});
const RestoredView = z.object({
  manifest: z.object({
    format: z.string(),
    version: z.number(),
    runId: z.string(),
    runKind: z.string().nullable(),
    redaction: z.enum(REDACTIONS),
    scan: ScanMark.optional(),
  }),
  run: z.object({
    runId: z.string(),
    runKind: z.string().nullable(),
    status: z.string(),
    stages: z.array(
      z.object({
        stage: z.string(),
        status: z.string(),
        reason: z.string().optional(),
        totals: z.object({ tokens: DumpTokens }),
      }),
    ),
    totals: z.object({ tokens: DumpTokens }),
    gaps: z.array(
      z.object({
        code: z.string(),
        count: count,
        kind: z.enum(["capture", "execution"]),
      }),
    ),
    complete: z.boolean(),
  }),
  /** The dataset folder's export record (readSessionDump's `record`): its redaction as filed. */
  record: z.object({
    redaction: z.object({ mode: z.enum(REDACTIONS) }),
    snapshotId: z.string().optional(),
    captureMark: CaptureMarked.optional(),
  }),
});

export const CaptureRead = z.discriminatedUnion("status", [
  z.object({
    /** The reader's observational completeness: no gap of kind capture. */
    status: z.enum(["complete", "incomplete"]),
    runId: z.string(),
    redaction: z.enum(REDACTIONS),
    runStatus: z.string(),
    stages: z.array(
      z.object({
        stage: z.string(),
        status: z.string(),
        reason: z.string().optional(),
      }),
    ),
    gaps: z.array(
      z.object({
        code: z.string(),
        count: count,
        kind: z.enum(["capture", "execution"]),
      }),
    ),
    tokens: DumpTokens,
    scan: ScanMark.optional(),
    mark: CaptureMarked.optional(),
  }),
  /** Not a dump this adapter may score: another format, version, kind or run. */
  z.object({ status: z.literal("refused"), why: z.string() }),
  /** No dump the reader accepts: none exported, none transferred, or the reader rejected it. */
  z.object({
    status: z.enum(["missing", "unreadable"]),
    why: z.string(),
  }),
]);
export type CaptureRead = z.infer<typeof CaptureRead>;

/** The public reader: a dump folder in, the restored dump (or a rejection) out. */
export type SessionDumpReader = (directory: string) => Promise<unknown>;

const DumpRejection = z.object({
  _tag: z.literal("DumpRejected"),
  reason: z.string(),
});

const messageOf = (error: unknown) => {
  const rejected = DumpRejection.safeParse(error);
  return rejected.success
    ? rejected.data.reason
    : error instanceof Error
      ? error.message
      : String(error);
};

/**
 * The capture lane's reader, from its public export, or why there is none. The specifier is held as a
 * plain string so this package typechecks before the export exists; the module's shape is checked here.
 */
export const loadSessionDumpReader = async (
  specifier: string = SESSION_DUMP_EXPORT,
): Promise<SessionDumpReader | string> => {
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    return `capture reader unavailable: ${specifier} is not exported (${messageOf(error).slice(0, 200)})`;
  }
  const read = (loaded as { readSessionDump?: unknown }).readSessionDump;
  if (typeof read !== "function")
    return `capture reader unavailable: ${specifier} has no readSessionDump`;
  return (directory) =>
    Effect.runPromise(
      (read as (directory: string) => Effect.Effect<unknown, unknown>)(
        directory,
      ),
    );
};

/**
 * One exported snapshot read through the reader, judged against the run and the redaction mode it must
 * be: the folder `<redaction>/<runKind>/<runId>/<snapshotId>/` the machine named.
 */
export const readCandidateCapture = async (
  directory: string,
  expected: { readonly runId: string; readonly redaction: string },
  reader: SessionDumpReader | string,
): Promise<CaptureRead> => {
  const runId = expected.runId;
  if (typeof reader === "string") return { status: "unreadable", why: reader };
  const manifestPath = join(directory, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      if (
        !z
          .object({ scan: ScanMark })
          .safeParse(JSON.parse(readFileSync(manifestPath, "utf8"))).success
      )
        return {
          status: "refused",
          why: "capture scan has not passed; scoring refused",
        };
    } catch {
      return { status: "unreadable", why: "capture manifest cannot be read" };
    }
  }
  let restored: unknown;
  try {
    restored = await reader(directory);
  } catch (error) {
    return {
      status: "unreadable",
      why: `the reader rejected ${directory}: ${messageOf(error).slice(0, 300)}`,
    };
  }
  const view = RestoredView.safeParse(restored);
  if (!view.success)
    return {
      status: "unreadable",
      why: `the reader's dump lacks what scoring reads: ${view.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    };
  const { manifest, run, record } = view.data;
  if (
    manifest.scan === undefined ||
    record.captureMark?.payload.outcome !== "clean" ||
    record.captureMark.payload.record !== record.snapshotId ||
    record.captureMark.payload.rawCapture !== manifest.scan.rawCapture ||
    record.captureMark.payload.detectorVersion !== manifest.scan.policy
  )
    return {
      status: "refused",
      why: "capture scan has not passed; scoring refused",
    };
  if (
    manifest.redaction !== expected.redaction ||
    record.redaction.mode !== expected.redaction
  )
    return {
      status: "refused",
      why: `the dump is ${manifest.redaction} (filed ${record.redaction.mode}), its folder says ${expected.redaction}`,
    };
  if (
    manifest.format !== SUPPORTED_DUMP.format ||
    manifest.version !== SUPPORTED_DUMP.version
  )
    return {
      status: "refused",
      why: `unsupported dump ${manifest.format} version ${manifest.version}: this adapter reads ${SUPPORTED_DUMP.format} version ${SUPPORTED_DUMP.version}`,
    };
  const kind = run.runKind ?? manifest.runKind;
  if (kind === "reading" || kind === "coding")
    return {
      status: "refused",
      why: `a ${kind} run's capture is never scored as a review`,
    };
  if (kind !== "scored" || run.runKind !== manifest.runKind)
    return {
      status: "refused",
      why: `run kind ${String(run.runKind)} (manifest ${String(manifest.runKind)}) is not scored`,
    };
  if (run.runId !== runId || manifest.runId !== runId)
    return {
      status: "refused",
      why: `the dump is of run ${run.runId}, the receipt's is ${runId}`,
    };
  const captureGaps = run.gaps.filter((gap) => gap.kind === "capture");
  if (run.complete !== (captureGaps.length === 0))
    return {
      status: "refused",
      why: `the dump says complete ${run.complete} with ${captureGaps.length} capture gap(s)`,
    };
  return {
    status: run.complete ? "complete" : "incomplete",
    runId,
    redaction: manifest.redaction,
    runStatus: run.status,
    stages: run.stages.map(({ stage, status, reason }) => ({
      stage,
      status,
      ...(reason === undefined ? {} : { reason }),
    })),
    gaps: run.gaps.map(({ code, count, kind }) => ({ code, count, kind })),
    tokens: run.totals.tokens,
    scan: manifest.scan,
    mark: record.captureMark,
  };
};

/**
 * Why a capture may not be scored: anything but a complete read, a run or stage that did not complete,
 * no stage at all, or an execution gap (the run still open). Empty when it may. Every gap stays in the
 * read and is listed by code with the comparison's capture counts.
 */
export const captureBlockers = (read: CaptureRead): Array<string> => {
  if ("why" in read) return [`capture ${read.status}: ${read.why}`];
  const blockers: Array<string> = [];
  if (read.scan === undefined || read.mark?.payload.outcome !== "clean")
    blockers.push("capture scan has not passed; scoring refused");
  if (read.status === "incomplete")
    blockers.push(
      `capture incomplete: ${read.gaps
        .filter((gap) => gap.kind === "capture")
        .map((gap) => gap.code)
        .join(", ")}`,
    );
  if (read.runStatus !== "completed")
    blockers.push(`the captured run ended ${read.runStatus}`);
  if (read.stages.length === 0) blockers.push("the capture holds no stage");
  const unfinished = read.stages.filter(
    (stage) => stage.status !== "completed",
  );
  if (unfinished.length > 0)
    blockers.push(
      `captured stages not completed: ${unfinished.map((stage) => `${stage.stage} ${stage.status}`).join(", ")}`,
    );
  const open = read.gaps.filter((gap) => gap.kind === "execution");
  if (open.length > 0)
    blockers.push(`execution open: ${open.map((gap) => gap.code).join(", ")}`);
  return blockers;
};
