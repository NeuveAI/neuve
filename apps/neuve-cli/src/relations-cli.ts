import { captureOutlineSource } from "../../../packages/harness/src/graph-outline.ts";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { Blobs, Computations, resolveStoreLocation } from "@neuve/records-core";
import {
  Relations as HarnessRelations,
  Request as HarnessRequest,
} from "@neuve/harness";
import { describeFailure, execute, withStore, write } from "./records-cli.ts";

export const RELATIONS_HELP = `Usage:
  neuve relations prepare <base>..<head> [--json] [--timeout <seconds>] [--repo <path>]
              Store the Graph relations of the range's two sides before a review: the head, then
              the merge base of base and head (the base a review of the range reads). A side
              another command is already reading is joined; a side stored is only read back.
              One line per side: the commit, read | already-stored | joined | failed <tag>, the
              wall time and the stored index's bytes; --json prints the same as one object.
              Waits for both sides, at most --timeout seconds when given (default: no bound).
              Ctrl-C stops waiting; a read no other caller waits on stops with it.
              Exit 0 when both sides are stored, 1 when a side failed, 2 for a usage error
              (a bad range, no repository, no Graph engine).`;

type Side = HarnessRelations.PreparedSide;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One side as a line: never the failure's text, only its tag. */
const sideLine = (side: Side) =>
  [
    side.side,
    side.commit,
    side.outcome === "failed" ? `failed ${side.tag ?? "failed"}` : side.outcome,
    seconds(side.wallMs),
    side.bytes === null ? "-" : `${side.bytes} bytes`,
  ].join("  ");

const sideJson = (side: Side) => ({
  commit: side.commit,
  outcome: side.outcome,
  tag: side.tag,
  wallMs: side.wallMs,
  bytes: side.bytes,
});

/** `neuve relations prepare <base>..<head>`: both sides of a range stored before a review. */
export const runRelationsCli = async (
  args: ReadonlyArray<string>,
): Promise<number> => {
  const [command, ...rest] = args;
  if (command !== "prepare") {
    await write(RELATIONS_HELP);
    return command === undefined || command === "--help" ? 0 : 2;
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    strict: true,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      timeout: { type: "string" },
      repo: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    await write(RELATIONS_HELP);
    return 0;
  }
  const [rangeText, ...extra] = positionals;
  if (rangeText === undefined || extra.length > 0 || !rangeText.includes(".."))
    throw new Error(
      "neuve relations prepare needs one range <base>..<head>. Run neuve relations --help.",
    );
  const timeoutMs =
    values.timeout === undefined ? undefined : Number(values.timeout) * 1000;
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  )
    throw new Error("--timeout takes a positive number of seconds.");
  const repository = resolve(values.repo ?? process.cwd());
  // A folder outside Git is refused with the store's own sentence, before anything else.
  await execute(resolveStoreLocation(repository));
  const { base, head } = HarnessRequest.parseRange(rangeText);
  const range = await execute(
    HarnessRelations.resolveRelationsRange({ repository, base, head }),
  );
  const source = captureOutlineSource();
  if (!("sha256" in source.key))
    throw new Error(`No Graph engine at ${source.executable}.`);

  const controller = new AbortController();
  let interrupted: Readonly<{ name: string; exitCode: number }> | undefined;
  const interrupt = (name: string, exitCode: number) => {
    interrupted ??= { name, exitCode };
    controller.abort();
  };
  const onInterrupt = () => interrupt("SIGINT", 130);
  const onTerminate = () => interrupt("SIGTERM", 143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let exit: Exit.Exit<HarnessRelations.PreparedRange, unknown>;
  try {
    exit = await Effect.runPromiseExit(
      withStore(repository, "create", (location) =>
        HarnessRelations.prepareRangeRelations({
          repository,
          graphDirectory: HarnessRelations.relationsGraphDirectory(location),
          range,
          source,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          // Each side's line as it ends, so a stopped command still shows what it stored.
          ...(values.json
            ? {}
            : {
                onSide: (side: Side) =>
                  Effect.promise(() => write(sideLine(side))),
              }),
        }).pipe(
          Effect.provide(
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
        ),
      ),
      { signal: controller.signal },
    );
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  if (Exit.isFailure(exit)) {
    if (interrupted !== undefined && Cause.hasInterruptsOnly(exit.cause)) {
      await Bun.write(
        Bun.stderr,
        `neuve: interrupted by ${interrupted.name}\n`,
      );
      return interrupted.exitCode;
    }
    const failure = Cause.findErrorOption(exit.cause);
    throw new Error(
      Option.isSome(failure)
        ? failure.value instanceof HarnessRelations.RelationsPrepareRefused
          ? failure.value.message
          : describeFailure(failure.value)
        : Cause.pretty(exit.cause),
    );
  }
  const { sides } = exit.value;
  const stored =
    HarnessRelations.preparedStored(sides.head) &&
    HarnessRelations.preparedStored(sides.base);
  if (values.json)
    await write(
      JSON.stringify({
        range: exit.value.range,
        head: sideJson(sides.head),
        base: sideJson(sides.base),
        stored,
      }),
    );
  if (stored) return 0;
  // An engine that lacks the capability is no engine for this command.
  return [sides.head, sides.base].some(
    (side) => side.tag === "graph-unavailable",
  )
    ? 2
    : 1;
};
