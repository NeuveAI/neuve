import { writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Cause, Data, Effect, Exit, Layer, Logger, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import { z } from "zod";
import { ProofInput, VENT_TEXT_MAX, VentInput } from "@neuve/records-schema";
import { Blobs, Proofs, Vents } from "@neuve/records-core";
import { ProofTools } from "@neuve/harness";
import { parseQueryInvocation } from "./boundary.ts";
import type { PublicQueryEvent } from "./domain.ts";
import { collectPublicQueryResult, runQueryGraph } from "./graph-query.ts";
import { describeFailure, withStore } from "./records-cli.ts";

export const MCP_HELP = `Usage:
  neuve mcp [--repo <path>]
              Serve Neuve's MCP tools over stdio for the agent session that starts it: a
              harness launches it as a subprocess, and it exits when the harness closes its
              input. Tools: vent, record_proof, query. Calls are tied to the session through process
              ancestry, or the session ID the harness sets when ancestry cannot be read, in the
              repository at --repo or the server's working directory.`;

/**
 * The tool's description is the whole prompt an agent sees (2.15): short, says venting is optional,
 * and shows good and bad vents rather than rules.
 */
const VENT_DESCRIPTION = `Optional. If something is making this session difficult, say what, in your own words, drawing on the turns you remember. One vent per session (or per review cycle, when your harness gave you a reconciliation ID); a second keeps the first. It never changes your task or any review.

Good vents:
- "The tests need a Postgres the sandbox can't start, so I keep guessing whether my change works."
- "The plan says to call parseRange, but it was renamed in the last commit; I lost three turns finding that."

Bad vents:
- "Error." (says nothing about what happened)
- "Done with step 2." (a progress report, not a difficulty)`;

/**
 * Agent tools take their schema from zod (8.11): a dynamic tool given the JSON Schema zod produces,
 * whose handler parses its input with the same zod schema.
 */
const { $schema: _dialect, ...ventParameters } = z.toJSONSchema(VentInput);

// It only appends one record about the caller's own session: not destructive, no outside world.
// Failures are any value: the server returns a failure's own message as an `isError` result.
const VentTool = Tool.dynamic("vent", {
  description: VENT_DESCRIPTION,
  parameters: ventParameters,
  failure: Schema.Unknown,
})
  .annotate(Tool.Title, "Vent")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

/**
 * What an agent sees for `record_proof` (11.3): what counts as proof, and that browser work records
 * what the Chrome DevTools MCP captured, saved by the agent, because Neuve does not proxy DevTools.
 */
const RECORD_PROOF_DESCRIPTION = `Record observed proof that your change works, for the range you are working on, so reviewers judge it from Records. One record is one artefact: a test run's output, a declared analyser's output such as the type checker (static-analysis), a log, telemetry, a screenshot or a video. For browser work, save what the Chrome DevTools MCP captured (a screenshot, console or network log) to a file inside the repository's working tree (not a git-ignored folder) or a temp folder, and pass its absolute path. Name the unit's owned paths when you know them. Name the commit it observed (default: the range's head) and the validation requirement it serves, and say in the claim only what the artefact shows. Proof converges: each kind is one part, so record each that applies. A custom verify script's output is not proof. Recording the same proof twice keeps the first.`;

const { $schema: _proofDialect, ...proofParameters } =
  z.toJSONSchema(ProofInput);

// Appends one record about the caller's own work: not destructive, local, and idempotent, because
// the same proof from the same session is kept once.
const RecordProofTool = Tool.dynamic("record_proof", {
  description: RECORD_PROOF_DESCRIPTION,
  parameters: proofParameters,
  failure: Schema.Unknown,
})
  .annotate(Tool.Title, "Record proof")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const QueryInput = z.strictObject({
  revision: z.string().describe("A hexadecimal Git object name."),
  question: z.string(),
  scope: z.array(z.string()).optional().describe("Local scope file paths."),
  branch: z
    .string()
    .optional()
    .describe("The local branch for the review cycle."),
});
const { $schema: _queryDialect, ...queryParameters } =
  z.toJSONSchema(QueryInput);

const QueryTool = Tool.dynamic("query", {
  description:
    "Read code and scope at a Git revision. The same read as neuve query.",
  parameters: queryParameters,
  failure: Schema.Unknown,
})
  .annotate(Tool.Title, "Query")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const NeuveTools = Toolkit.make(VentTool, RecordProofTool, QueryTool);

export interface VentReply {
  readonly status: Vents.CallerVentResult["status"] | "invalid";
  readonly message: string;
}

/** The store could not take the vent; the server answers with `isError` and this message. */
class VentNotRecorded extends Data.TaggedError("VentNotRecorded")<{
  readonly message: string;
}> {}

/**
 * The `vent` handler: the same library call as `neuve vent`, resolved per call, so a session that
 * ends and another that starts under the same harness process each get their own vent. Recorded,
 * kept-earlier, unlinked and invalid are ordinary replies: a vent is never required, so there is
 * nothing for the agent to retry. A store or unexpected failure is an `isError` result.
 */
const ventHandler = (repository: string) => (input: unknown) =>
  Effect.gen(function* () {
    // Checked exactly as the advertised schema says; the text is trimmed only when stored.
    const parsed = VentInput.safeParse(input);
    if (!parsed.success)
      return {
        status: "invalid",
        message: `Not recorded: a vent takes one \`text\` of 1 to ${VENT_TEXT_MAX.toLocaleString("en")} characters, not blank, and optionally a \`reconciliationId\` of at most 256 characters.`,
      } satisfies VentReply;
    const outcome = yield* Effect.result(
      withStore(repository, "write", (location) =>
        Vents.ventAsCaller(location, {
          text: parsed.data.text,
          reconciliationId: parsed.data.reconciliationId,
        }).pipe(Effect.provide(Blobs.layer(location))),
      ),
    );
    if (outcome._tag === "Failure") {
      const message = describeFailure(outcome.failure);
      yield* Effect.logWarning(`vent not recorded: ${message}`);
      return yield* new VentNotRecorded({
        message: `Not recorded: ${message}`,
      });
    }
    const result = outcome.success;
    yield* Effect.logInfo(
      `vent ${result.status}${result.status === "unlinked" ? ` (${result.caller._tag})` : ` for ${result.caller.harness} session ${result.caller.sessionId}`}`,
    );
    return {
      status: result.status,
      message: Vents.describe(result),
    } satisfies VentReply;
  });

export interface ProofReply {
  readonly status: Proofs.CallerRecordResult["status"] | "invalid" | "refused";
  readonly message: string;
  readonly id?: string | undefined;
}

/** The store could not take the proof; the server answers with `isError` and this message. */
class ProofNotRecorded extends Data.TaggedError("ProofNotRecorded")<{
  readonly message: string;
}> {}

/**
 * The `record_proof` handler: the same library call as `neuve proof record`, resolved per call.
 * Invalid input and refusals (a revision outside the range, a media type the kind does not take) are
 * ordinary replies the agent can correct; a store or unexpected failure is an `isError` result.
 */
const recordProofHandler = (repository: string) => (input: unknown) =>
  Effect.gen(function* () {
    const parsed = ProofInput.safeParse(input);
    if (!parsed.success)
      return {
        status: "invalid",
        message: `Not recorded: ${parsed.error.issues
          .map((issue) =>
            issue.code === "unrecognized_keys"
              ? `Proof input takes only these fields: ${Object.keys(ProofInput.shape).join(", ")}.`
              : `${issue.message}${issue.path.length === 0 ? "" : ` (${issue.path.join(".")})`}`,
          )
          .join("\n")}`,
      } satisfies ProofReply;
    const outcome = yield* Effect.result(
      withStore(repository, "write", (location) =>
        Proofs.recordAsCaller(location, {
          repository,
          input: parsed.data,
          mask: ProofTools.maskText,
        }).pipe(Effect.provide(Blobs.layer(location))),
      ),
    );
    if (outcome._tag === "Failure") {
      const failure = outcome.failure;
      if (
        typeof failure === "object" &&
        failure !== null &&
        "_tag" in failure &&
        failure._tag === "ProofRefused"
      )
        return {
          status: "refused",
          message: `Not recorded: ${(failure as Proofs.ProofRefused).message}`,
        } satisfies ProofReply;
      const message = describeFailure(failure);
      yield* Effect.logWarning(`proof not recorded: ${message}`);
      return yield* new ProofNotRecorded({
        message: `Not recorded: ${message}`,
      });
    }
    const result = outcome.success;
    yield* Effect.logInfo(
      `proof ${result.status}${result.status === "unlinked" ? ` (${result.caller._tag})` : ` ${result.id} ${result.kind} for ${result.caller.harness} session ${result.caller.sessionId}`}`,
    );
    return {
      status: result.status,
      message: Proofs.describeRecord(result),
      ...(result.status === "unlinked" ? {} : { id: result.id }),
    } satisfies ProofReply;
  });

const queryHandler = (repository: string) => (input: unknown) =>
  Effect.gen(function* () {
    const parsed = QueryInput.safeParse(input);
    if (!parsed.success)
      return { status: "invalid", message: z.prettifyError(parsed.error) };
    const { revision, question, scope = [], branch } = parsed.data;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const { request, assumedOptions } = parseQueryInvocation([
          "--repo",
          repository,
          "--revision",
          revision,
          "--question",
          question,
          ...scope.flatMap((path) => ["--scope", path]),
          ...(branch === undefined ? [] : ["--branch", branch]),
        ]);
        const events: PublicQueryEvent[] = [];
        await runQueryGraph(request, {
          trustWorkingTree: false,
          signal,
          emit: async (event) => {
            events.push(event);
          },
        });
        return {
          ...collectPublicQueryResult(events),
          ...(assumedOptions === undefined
            ? {}
            : { assumed_options: assumedOptions }),
        };
      },
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });
  });

/** Logs go to stderr: stdout carries only the protocol. */
const stderrLogger = Logger.make((options) => {
  writeSync(
    2,
    `${options.date.toISOString()} neuve-mcp[${process.pid}] ${options.logLevel.toUpperCase().padEnd(7)} ${String(options.message)}\n`,
  );
});

const stdioLayer = <A, E, R>(tools: Layer.Layer<A, E, R>) =>
  tools.pipe(
    Layer.provide(
      McpServer.layerStdio({
        name: "neuve",
        version: "0.1.0",
        protocols: [
          McpProtocol.v2025_11_25,
          McpProtocol.v2025_06_18,
          McpProtocol.v2025_03_26,
          McpProtocol.v2024_11_05,
        ],
      }),
    ),
    Layer.provide(BunStdio.layer),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(Logger.layer([stderrLogger])),
  );

export const serverLayer = (repository: string) =>
  stdioLayer(
    McpServer.toolkit(NeuveTools).pipe(
      Layer.provide(
        NeuveTools.toLayer({
          vent: ventHandler(repository),
          record_proof: recordProofHandler(repository),
          query: queryHandler(repository),
        }),
      ),
    ),
  );

/**
 * Runs the server as this process's main fiber until the harness closes stdin (the stdio protocol
 * then interrupts it) or a signal arrives. No port, no daemon: its lifetime is the agent session's.
 */
export const runMcp = async (args: readonly string[]): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      repo: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    await Bun.write(Bun.stdout, `${MCP_HELP}\n`);
    return 0;
  }
  const repository = resolve(values.repo ?? process.cwd());
  const program = Effect.gen(function* () {
    yield* Effect.logInfo(`serving MCP over stdio for ${repository}`);
    return yield* Layer.launch(serverLayer(repository));
  }).pipe(Effect.provide(Logger.layer([stderrLogger])));
  return new Promise<number>(() => {
    BunRuntime.runMain(program, {
      disableErrorReporting: true,
      teardown: (exit) => {
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
          writeSync(
            2,
            `${new Date().toISOString()} neuve-mcp[${process.pid}] INFO    input closed; exiting\n`,
          );
          process.exit(0);
        }
        writeSync(2, `neuve mcp: ${Cause.pretty(exit.cause)}\n`);
        process.exit(1);
      },
    });
  });
};
