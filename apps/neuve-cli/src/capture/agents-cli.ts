import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Cause, Effect, Exit, Option } from "effect";
import {
  Actors,
  Caller,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { refusalFrom, refusalSentence } from "../version-skew.ts";

export const AGENTS_HELP = `Usage:
  neuve agents [--json] [--repo <path>]
              List actors with alias, harness, model, session, turns and commits, read from
              Records projections. Captured events appear once the worker ingests the spool.
  neuve agents current [--session <harness>:<session id>[/<subagent id>]] [--repo <path>]
              Show which agent session this call belongs to: process ancestry, the override, or
              the session ID the harness declared in the environment when ancestry cannot be read.`;

const fail = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  const value = Option.isSome(error) ? error.value : undefined;
  const refusal = refusalFrom(value);
  if (refusal !== undefined) return new Error(refusalSentence(refusal));
  return new Error(
    typeof value === "object" && value !== null && "_tag" in value
      ? `${String((value as { _tag: unknown })._tag)}: ${String((value as { message?: unknown }).message ?? "")}`
      : Cause.pretty(cause),
  );
};

const run = async <A>(effect: Effect.Effect<A, unknown>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) throw fail(exit.cause);
  return exit.value;
};

const short = (value: string | null, length = 8) =>
  value === null ? "-" : value.length > length ? value.slice(0, length) : value;

const table = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

export const runAgentsCli = async (
  args: readonly string[],
): Promise<number> => {
  const current = args[0] === "current";
  const { values } = parseArgs({
    args: current ? [...args.slice(1)] : [...args],
    strict: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      session: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    await Bun.write(Bun.stdout, `${AGENTS_HELP}\n`);
    return 0;
  }
  const location = await run(
    resolveStoreLocation(resolve(values.repo ?? process.cwd())),
  );

  if (current) {
    const resolution = await run(
      Caller.resolveCaller(location, { override: values.session }).pipe(
        Effect.provide(BunFileSystem.layer),
      ),
    );
    const text =
      resolution._tag === "Linked"
        ? `${resolution.harness} session ${resolution.sessionId}${resolution.subagentId === undefined ? "" : ` subagent ${resolution.subagentId}`} (by ${resolution.method === "declared" ? `declared ${resolution.source}, used because the process table cannot be read here` : resolution.method}); actor ${resolution.actorId}`
        : resolution._tag === "Ambiguous"
          ? `Ambiguous: the nearest agent process owns sessions ${resolution.sessionIds.join(", ")}; pass --session`
          : resolution._tag === "Unavailable"
            ? "No session: the process table cannot be read here (agent sandboxes may forbid it), and no harness session ID in the environment names a live session here; pass --session"
            : "No session: no live agent session owns this process";
    await Bun.write(
      Bun.stdout,
      `${values.json === true ? JSON.stringify(resolution) : text}\n`,
    );
    return resolution._tag === "Linked" ? 0 : 1;
  }

  const { actors, unresolved } = await run(
    Effect.gen(function* () {
      yield* Store.prepareForRead;
      return {
        actors: yield* Actors.list,
        unresolved: yield* Actors.unresolvedCommits,
      };
    }).pipe(
      Effect.provide(Store.layer(location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  if (values.json === true) {
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({ actors, unresolvedCommits: unresolved }, null, 2)}\n`,
    );
    return 0;
  }
  const unknown =
    unresolved.length === 0
      ? ""
      : `Commits with no known actor: ${unresolved
          .map(({ link, commits }) => `${commits} (${link})`)
          .join(", ")}\n`;
  if (actors.length === 0) {
    await Bun.write(Bun.stdout, `No actors recorded.\n${unknown}`);
    return 0;
  }
  const rows = [
    [
      "ALIAS",
      "KIND",
      "HARNESS",
      "MODEL",
      "SESSION",
      "PARENT",
      "TURNS",
      "COMMITS",
    ],
    ...actors.map((actor) => [
      // Humans keep their git name; agents are known by alias.
      actor.actorKind === "human"
        ? (actor.displayName ?? actor.alias)
        : actor.alias,
      actor.actorKind === "human"
        ? "human"
        : actor.subagentId === null
          ? "agent"
          : `subagent${actor.agentType === null ? "" : ` (${actor.agentType})`}`,
      actor.harness,
      actor.activity.model ?? "-",
      actor.actorKind === "human"
        ? (actor.email ?? "-")
        : short(actor.sessionId),
      actor.parentAlias ?? "-",
      String(actor.activity.turns),
      // Commits linked only by a declared session ID are trusted less than ancestry (8.13).
      actor.activity.commitsDeclared === 0
        ? String(actor.activity.commits)
        : `${actor.activity.commits} (${actor.activity.commitsDeclared} declared)`,
    ]),
  ];
  await Bun.write(Bun.stdout, `${table(rows)}\n${unknown}`);
  return 0;
};
