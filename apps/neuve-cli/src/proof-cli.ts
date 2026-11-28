import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { ProofInput } from "@neuve/records-schema";
import {
  Blobs,
  Proofs,
  PublishedPackets,
  ReviewStats,
} from "@neuve/records-core";
import { ProofTools } from "@neuve/harness";
import {
  execute,
  unknownCommandRefusal,
  withStore,
  write,
} from "./records-cli.ts";

export const PROOF_HELP = `Usage:
  neuve proof record <base>..<head> --kind <kind> --claim <text> --requirement <text>
    (--file <path> | --text <text> | --stdin) [--revision <commit>] [--scope-item <id>]
    [--media-type <type>] [--path <owned path>]... [--session <harness>:<session id>[/<subagent id>]]
    [--json] [--repo <path>]
              Record observed proof for the range you are working on (11.3). Kinds:
              static-analysis (a declared analyser's output, such as the type checker),
              test-run, telemetry, log, screenshot, video. --revision is the commit the
              artefact observed (default: the range's head; it must be in the head's history).
              The artefact is a file (a screenshot the Chrome DevTools MCP saved, test output),
              text, or standard input; it is kept 30 days unless a published review cites it.
              A file must be inside the working tree (not git-ignored, not under .git, not a .env
              file) or a temp folder, after following links. Credential shapes and email addresses
              in text, the claim and the requirement are masked. The record says whether tracked
              files (the --path files, when given) had uncommitted changes.
              The call is tied to its agent session as neuve vent is; exits 1 when none is.
  neuve proof list <base>..<head> [--path <owned path>]... [--json] [--repo <path>]
              List the range's proof records with kind, revision, recorder, requirement, claim
              and artefact. With --path, each record's currency for a unit owning those paths:
              current only if none of them changed after its commit (11.10); stale otherwise.
  neuve proof reader <base>..<head> [--id <proof id>] [--page <n>] [--path <owned path>]...
    [--repo <path>]
              Print what the harness's proofs pager (or, with --id, its proof reader) returns
              to Assemble and Dispose, within the tool-result cap.
  neuve proof stats <base>..<head> [--path <owned path>]... [--json] [--repo <path>]
              Count the range's records by kind and currency, for a unit owning --path or, until
              units exist, for the whole range; and the store's proof counts from review stats.`;

/** Terminal escape sequences and controls: agents write claims, which must not drive the terminal. */
const UNSAFE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]?|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])?|[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const printable = (text: string) => text.replace(UNSAFE, "");

const readStdin = async () => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const recordCommand = async (args: ReadonlyArray<string>) => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      kind: { type: "string" },
      claim: { type: "string" },
      requirement: { type: "string" },
      file: { type: "string" },
      text: { type: "string" },
      stdin: { type: "boolean" },
      revision: { type: "string" },
      "scope-item": { type: "string" },
      "media-type": { type: "string" },
      path: { type: "string", multiple: true },
      session: { type: "string" },
      json: { type: "boolean" },
      repo: { type: "string" },
    },
  });
  const repository = resolve(values.repo ?? process.cwd());
  const text = values.stdin === true ? await readStdin() : values.text;
  const parsed = ProofInput.safeParse({
    kind: values.kind,
    range: positionals[0],
    ...(values.revision === undefined ? {} : { revision: values.revision }),
    claim: values.claim,
    requirement: values.requirement,
    ...(values["scope-item"] === undefined
      ? {}
      : { scopeItem: values["scope-item"] }),
    ...(values.file === undefined ? {} : { file: resolve(values.file) }),
    ...(text === undefined ? {} : { text }),
    ...(values["media-type"] === undefined
      ? {}
      : { mediaType: values["media-type"] }),
    ...(values.path === undefined ? {} : { ownedPaths: values.path }),
  });
  if (!parsed.success) {
    await write(
      `Not recorded: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}\n\n${PROOF_HELP}`,
    );
    return 2;
  }
  const override = values.session ?? process.env["NEUVE_SESSION"];
  const result = await execute(
    withStore(repository, "write", (location) =>
      Proofs.recordAsCaller(location, {
        repository,
        input: parsed.data,
        mask: ProofTools.maskText,
        override: override === "" ? undefined : override,
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );
  const message =
    Proofs.describeRecord(result) +
    (result.status === "unlinked" && result.caller._tag === "Unavailable"
      ? " Use the `record_proof` tool if available."
      : "");
  if (values.json === true)
    await write(JSON.stringify({ ...result, message }, null, 2));
  else await write(message);
  return result.status === "unlinked" ? 1 : 0;
};

const formatList = (proofs: Proofs.RangeProofs) => {
  const lines = [
    `${proofs.range.baseRef}..${proofs.range.headOid.slice(0, 12)} (base ${proofs.range.baseOid.slice(0, 12)}): ${proofs.records.length} proof record(s)${proofs.truncated ? `, the newest ${Proofs.LIST_MAX} shown` : ""}`,
  ];
  const counts = Proofs.currencyCounts(proofs);
  if (counts !== null)
    lines.push(
      `for a unit owning ${proofs.ownedPaths!.join(", ")}: ${counts.current} current, ${counts.stale} stale`,
    );
  for (const record of proofs.records)
    lines.push("", printable(ProofTools.describeListed(record)));
  return lines.join("\n");
};

const listOptions = {
  path: { type: "string", multiple: true },
  json: { type: "boolean" },
  repo: { type: "string" },
} as const;

const listCommand = async (args: ReadonlyArray<string>) => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: listOptions,
  });
  const repository = resolve(values.repo ?? process.cwd());
  const proofs = await execute(
    withStore(repository, "read", (location) =>
      Effect.gen(function* () {
        const range = yield* Proofs.resolveRange(
          repository,
          positionals[0] ?? "",
        );
        return yield* Proofs.list({
          repository,
          range,
          ownedPaths: values.path,
        });
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );
  await write(
    values.json === true ? JSON.stringify(proofs, null, 2) : formatList(proofs),
  );
  return 0;
};

const readerCommand = async (args: ReadonlyArray<string>) => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      id: { type: "string" },
      page: { type: "string" },
      path: { type: "string", multiple: true },
      repo: { type: "string" },
    },
  });
  const repository = resolve(values.repo ?? process.cwd());
  const page = values.page === undefined ? undefined : Number(values.page);
  const text = await execute(
    withStore(repository, "read", (location) =>
      Effect.gen(function* () {
        const range = yield* Proofs.resolveRange(
          repository,
          positionals[0] ?? "",
        );
        const services = yield* Effect.context<SqlClient | Blobs.BlobStore>();
        const options = {
          repository,
          range,
          ownedPaths: values.path,
          services,
        };
        const outcome =
          values.id === undefined
            ? yield* ProofTools.proofsTool(options).handle(
                page === undefined ? {} : { page },
              )
            : yield* ProofTools.proofTool(options).handle({
                id: values.id,
                ...(page === undefined ? {} : { page }),
              });
        return outcome.text;
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );
  await write(printable(text));
  return 0;
};

const statsCommand = async (args: ReadonlyArray<string>) => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: listOptions,
  });
  const repository = resolve(values.repo ?? process.cwd());
  const stats = await execute(
    withStore(repository, "read", (location) =>
      Effect.gen(function* () {
        const range = yield* Proofs.resolveRange(
          repository,
          positionals[0] ?? "",
        );
        const forRange = yield* ReviewStats.rangeProofStats({
          repository,
          range,
          ownedPaths: values.path,
        });
        // Coverage over every cycle's packet of record only (H8), as `neuve review stats` counts.
        const store = yield* ReviewStats.reviewStats({
          units: yield* PublishedPackets.recordUnits(),
        });
        return { range: forRange, store: store.proofs };
      }).pipe(Effect.provide(Blobs.layer(location))),
    ),
  );
  if (values.json === true) {
    await write(JSON.stringify(stats, null, 2));
    return 0;
  }
  const { range, store } = stats;
  const currency = range.currency;
  await write(
    [
      `${range.range.baseRef}..${range.range.headOid.slice(0, 12)}: ${range.records} record(s), ${range.byKind.map((row) => `${row.kind} ${row.records}`).join(", ") || "none"}`,
      currency === null
        ? "currency: not checked (the range changes no files)"
        : `currency, ${range.unit === "whole-range" ? "for the whole range as one unit (no units yet)" : "for the given paths"}: ${currency.current} current, ${currency.stale} stale (${currency.changedAfter} changed after, ${currency.notInHistory} not in the head's history, ${currency.unknownRevision} unknown commit)`,
      `store: ${store.byKind.map((row) => `${row.kind} ${row.records}`).join(", ") || "no records"}; ${store.recorders} recorder(s); requirement coverage in current assessments: ${store.coverage.map((row) => `${row.coverage} ${row.requirements}`).join(", ") || "none assessed"}`,
    ].join("\n"),
  );
  return 0;
};

export const runProofCli = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args;
  switch (command) {
    case "record":
      return recordCommand(rest);
    case "list":
      return listCommand(rest);
    case "reader":
      return readerCommand(rest);
    case "stats":
      return statsCommand(rest);
    case "--help":
    case "help":
    case undefined:
      await write(PROOF_HELP);
      return command === undefined ? 2 : 0;
    default:
      await write(unknownCommandRefusal(command, "neuve proof"));
      return 2;
  }
};
