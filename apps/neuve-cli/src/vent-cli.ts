import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Effect } from "effect";
import { Blobs, Vents } from "@neuve/records-core";
import { execute, withStore, write } from "./records-cli.ts";

export const VENT_HELP = `Usage:
  neuve vent <text> [--reconciliation-id <id>] [--session <harness>:<session id>[/<subagent id>]]
    [--json] [--repo <path>]
              Say what is making this agent session difficult, in your own words (optional, up
              to 2,000 characters). One vent per session: a second is answered, and the first is
              kept. A harness that gives each review cycle its own session ID passes it as
              --reconciliation-id; the limit is then one vent per review cycle. The call is tied
              to its session through process ancestry; where ancestry is unavailable, through
              the session ID the harness sets in its shells, or --session (or NEUVE_SESSION).
              Exits 1 when no session is linked, so nothing was recorded. The text is kept for
              30 days.
  neuve vents [--since <7d|12h|30m|ISO time>] [--agent <alias>] [--run <id>] [--json]
    [--repo <path>]
              List vents in the order they were recorded, with agent alias, session, review
              cycle, turn and run; a vent older than 30 days shows that its text was pruned.
              Agents' text is printed with control characters and escape sequences removed.`;

const SINCE = /^(?<count>\d+)(?<unit>[dhm])$/;
const UNIT_MILLIS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/** `7d`, `12h`, `30m`, or an ISO instant, as the earliest recording time to show. */
const sinceInstant = (value: string, nowMillis: number) => {
  const relative = SINCE.exec(value)?.groups;
  if (relative !== undefined)
    return new Date(
      nowMillis -
        Number(relative["count"]) *
          UNIT_MILLIS[relative["unit"] as keyof typeof UNIT_MILLIS],
    ).toISOString();
  const parsed = z.iso.datetime({ offset: true }).safeParse(value);
  if (!parsed.success)
    throw new Error(
      `--since: expected a span such as 7d, 12h or 30m, or an ISO time; got ${value}`,
    );
  return new Date(parsed.data).toISOString();
};

export const runVentCli = async (args: readonly string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      repo: { type: "string" },
      session: { type: "string" },
      "reconciliation-id": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true || positionals.length === 0) {
    await write(VENT_HELP);
    return values.help === true ? 0 : 2;
  }
  const repository = resolve(values.repo ?? process.cwd());
  const override = values.session ?? process.env["NEUVE_SESSION"];
  const result = await execute(
    withStore(repository, "write", (location) =>
      Vents.ventAsCaller(location, {
        text: positionals.join(" "),
        override: override === "" ? undefined : override,
        reconciliationId: values["reconciliation-id"],
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );
  const message = Vents.describe(result);
  if (values.json === true)
    await write(JSON.stringify({ ...result, message }, null, 2));
  else
    await write(
      result.status === "unlinked"
        ? `${message} Pass --session <harness>:<session id>, or set NEUVE_SESSION.`
        : message,
    );
  return result.status === "unlinked" ? 1 : 0;
};

/** Terminal escape sequences: CSI, OSC (ended by BEL or ST, or unterminated) and two-byte escapes. */
const ESCAPES =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]?|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])?/g;
/** C0 and C1 controls other than newline and tab, and bidirectional overrides and isolates. */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Agents write vents and name their sessions: nothing they wrote may drive the terminal. */
const printable = (text: string | null) =>
  text === null ? null : text.replace(ESCAPES, "").replace(CONTROLS, "");

const formatVents = (vents: ReadonlyArray<Vents.VentView>) => {
  if (vents.length === 0) return "No vents.";
  return vents
    .map((vent) => {
      const agentType = printable(vent.agentType);
      const turn = printable(vent.turnKey);
      const run = printable(vent.runId);
      const stage = printable(vent.stage);
      const cycle = printable(vent.reconciliationId);
      const text =
        vent.text === null
          ? `(text pruned on ${vent.textPrunedAt ?? "an unknown date"}; vents are kept 30 days)`
          : (printable(vent.text) ?? "");
      return [
        `${vent.recordedAt}  ${printable(vent.alias)}${vent.subagent ? ` (subagent${agentType === null ? "" : ` ${agentType}`})` : ""}  ${printable(vent.harness) ?? "unregistered"} session ${printable(vent.sessionId)}${cycle === null ? "" : `  review cycle ${cycle}`}${turn === null ? "" : `  turn ${turn}`}${run === null ? "" : `  run ${run}`}${stage === null ? "" : `  stage ${stage}`}`,
        ...text.split("\n").map((line) => `  ${line}`),
      ].join("\n");
    })
    .join("\n\n");
};

export const runVentsCli = async (args: readonly string[]): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      repo: { type: "string" },
      since: { type: "string" },
      agent: { type: "string" },
      run: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    await write(VENT_HELP);
    return 0;
  }
  const repository = resolve(values.repo ?? process.cwd());
  const since =
    values.since === undefined
      ? undefined
      : sinceInstant(values.since, Date.now());
  const vents = await execute(
    withStore(repository, "read", (location) =>
      Vents.list({ since, alias: values.agent, runId: values.run }).pipe(
        Effect.provide(Blobs.layer(location)),
      ),
    ),
  );
  await write(
    values.json === true ? JSON.stringify(vents, null, 2) : formatVents(vents),
  );
  return 0;
};
