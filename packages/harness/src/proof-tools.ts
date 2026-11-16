import { Effect, Option, type Context } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import type { Range } from "@neuve/records-schema";
import { Blobs, Proofs } from "@neuve/records-core";
import { TOOL_RESULT_TOKENS } from "./budget.ts";
import { dataBlock } from "./data-block.ts";
import { READ_ONLY, defineTool, type ToolSpec } from "./toolkit.ts";

/** The one set of masking patterns, for the recording surfaces in the CLI and MCP server (10.5). */
export { maskText } from "./masking.ts";

/**
 * The proof readers for Assemble and Dispose (proposal §8.4, §9.2; slice H4b): a `proofs` pager over
 * the range's proof records and a `proof(id)` reader of one record and its text artefact. Both read
 * Records only, never the working tree (10.34), and stay within the 3,000-token tool-result cap by
 * paging at about 4 bytes per token, as the other tools do. Each record shows its recorder, so the
 * implementer's own proof can be weighed with 10.63's skepticism, and, when the unit's owned paths
 * are given, whether it is current for the unit (11.10): a stale record is disclosed, never forged.
 */

const PAGE_BYTES = TOOL_RESULT_TOKENS * 4 - 400;

/**
 * A page of artefact text beside the record's own lines, which take at most about 3,000 bytes (a
 * 500-character claim and a 300-character requirement at 3 bytes a character, and the rest), so a
 * page boundary never depends on the record's other text.
 */
const ARTEFACT_PAGE_BYTES = PAGE_BYTES - 3_200;

export interface ProofToolsOptions {
  readonly repository: string;
  readonly range: Range;
  /** The unit's owned paths, for the currency check; without them no currency is shown. */
  readonly ownedPaths?: ReadonlyArray<string> | undefined;
  /** Whose owned paths the currency is for, as the tools' descriptions say: "this unit" by default. */
  readonly currencyScope?: string | undefined;
  /** The Records services the readers run with, taken from the caller's context. */
  readonly services: Context.Context<SqlClient | Blobs.BlobStore>;
}

const utf8 = new TextEncoder();

/**
 * Wraps recorded text as data, never instructions: in a block whose tag carries the SHA-256 of its
 * content (data-block.ts), as the other tools wrap repository data, with `tag` as its kind. Agents
 * write claims and artefacts, and a fixed tag name with escaping could not hold against zero-width,
 * format and homoglyph characters, so nothing inside can end the block early.
 */
export const fence = (tag: string, text: string) => dataBlock(tag, {}, text);

const worktreeLine = (record: Proofs.ProofRecordView) =>
  Proofs.describeWorktree(record.worktree, record.revision);

const recorderLine = (record: Proofs.ProofRecordView) =>
  `${record.recorder.alias} (${record.recorder.harness ?? "unregistered"}${record.recorder.subagent ? ` subagent${record.recorder.agentType === null ? "" : ` ${record.recorder.agentType}`}` : ""} session ${record.recorder.sessionId})`;

const artefactLine = (record: Proofs.ProofRecordView) =>
  `${record.artefact.mediaType}, ${record.artefact.bytes} bytes, ${record.artefact.prunedAt === null ? (record.artefact.retention ?? "unknown retention") : `pruned ${record.artefact.prunedAt}`}`;

const positionOf = (record: Proofs.ListedProof) =>
  record.atHead
    ? "at the head"
    : record.inRange
      ? "before the head"
      : "outside the range's commits";

/** One record as the pager lists it. */
export const describeListed = (record: Proofs.ListedProof) =>
  [
    `${record.id}  ${record.kind}  at ${record.revision.slice(0, 12)} (${positionOf(record)})${record.currency === null ? "" : `  ${Proofs.describeCurrency(record.currency)}`}`,
    `  recorded by ${recorderLine(record)} at ${record.recordedAt}`,
    `  requirement: ${record.requirement.text}${record.requirement.scopeItem === null ? "" : ` [${record.requirement.scopeItem}]`}`,
    `  claim: ${record.claim}`,
    `  artefact: ${artefactLine(record)}`,
    `  ${worktreeLine(record)}`,
  ].join("\n");

/** Packs entries greedily into pages of at most `PAGE_BYTES`. */
const pagesOf = (entries: ReadonlyArray<string>) => {
  const pages: Array<Array<string>> = [];
  let current: Array<string> = [];
  let size = 0;
  for (const entry of entries) {
    const bytes = utf8.encode(entry).byteLength + 2;
    if (current.length > 0 && size + bytes > PAGE_BYTES) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += bytes;
  }
  if (current.length > 0) pages.push(current);
  return pages;
};

/** A page of bytes cut on UTF-8 character boundaries, clamped to the last page. */
const bytePage = (bytes: Uint8Array, requested: number) => {
  const pages = Math.max(1, Math.ceil(bytes.byteLength / ARTEFACT_PAGE_BYTES));
  const page = Math.min(requested, pages);
  const boundary = (at: number) => {
    let index = Math.min(at, bytes.byteLength);
    while (index < bytes.byteLength && (bytes[index]! & 0xc0) === 0x80)
      index += 1;
    return index;
  };
  const start = boundary((page - 1) * ARTEFACT_PAGE_BYTES);
  const end = boundary(page * ARTEFACT_PAGE_BYTES);
  return {
    text: new TextDecoder().decode(bytes.subarray(start, end)),
    page,
    pages,
  };
};

const PageInput = z.strictObject({
  page: z.int().min(1).max(1_000).optional().describe("Page number, from 1."),
});

const ProofIdInput = z.strictObject({
  id: z.ulid().describe("A proof record's ID, as `proofs` lists it."),
  page: z
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe("Page of the artefact's text, from 1."),
});

const failed = (error: unknown) => ({
  text: `Proof records could not be read: ${error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? error)}`,
  error: "ProofReadFailed",
});

export const proofsTool = (options: ProofToolsOptions): ToolSpec<unknown> =>
  defineTool({
    name: "proofs",
    description: `List the proof records for this range (test runs, type checks, logs, telemetry, screenshots, video), paged: kind, the commit each observed${options.ownedPaths === undefined ? "" : ` and whether it is current for ${options.currencyScope ?? "this unit"}`}, who recorded it, the requirement it serves, its claim and its artefact. Read one with \`proof\`.`,
    input: PageInput,
    hints: READ_ONLY,
    handle: (input: z.infer<typeof PageInput>) =>
      Effect.gen(function* () {
        const listed = yield* Proofs.list({
          repository: options.repository,
          range: options.range,
          ownedPaths: options.ownedPaths,
        });
        if (listed.records.length === 0)
          return {
            text: "No proof is recorded for this range.",
            empty: true,
          };
        const pages = pagesOf(listed.records.map(describeListed));
        const number = Math.min(input.page ?? 1, pages.length);
        const counts = Proofs.currencyCounts(listed);
        const header = `${listed.records.length} record(s)${listed.truncated ? ` (the newest ${Proofs.LIST_MAX}; older ones exist)` : ""}${counts === null ? "" : `: ${counts.current} current, ${counts.stale} stale`}. Page ${number} of ${pages.length}.`;
        return {
          text: `${header}\n${fence("proofs", pages[number - 1]!.join("\n\n"))}${number < pages.length ? `\n[ask for page ${number + 1} for more]` : ""}`,
          paged: pages.length > 1,
        };
      }).pipe(
        Effect.provide(options.services),
        Effect.catch((error) => Effect.succeed(failed(error))),
      ),
  });

export const proofTool = (options: ProofToolsOptions): ToolSpec<unknown> =>
  defineTool({
    name: "proof",
    description: `Read one proof record by ID: its kind, commit${options.ownedPaths === undefined ? "" : ` and currency for ${options.currencyScope ?? "this unit"}`}, recorder, requirement, claim and artefact, with the artefact's text paged when it is text. Images and video are described, not shown.`,
    input: ProofIdInput,
    hints: READ_ONLY,
    handle: (input: z.infer<typeof ProofIdInput>) =>
      Effect.gen(function* () {
        const held = yield* Proofs.get(input.id);
        if (Option.isNone(held))
          return {
            text: `No proof record has the ID ${input.id}. \`proofs\` lists them.`,
            empty: true,
          };
        const record = held.value;
        const currency =
          options.ownedPaths === undefined
            ? null
            : yield* Proofs.currency({
                repository: options.repository,
                headOid: options.range.headOid,
                revision: record.revision,
                ownedPaths: options.ownedPaths,
              });
        const lines = [
          `${record.id}  ${record.kind}  at ${record.revision.slice(0, 12)}${record.revision === options.range.headOid ? " (the head)" : ""}${currency === null ? "" : `  ${Proofs.describeCurrency(currency)}`}`,
          `recorded by ${recorderLine(record)} at ${record.recordedAt}, for ${record.range.baseRef}..${record.range.headOid.slice(0, 12)}`,
          `requirement: ${record.requirement.text}${record.requirement.scopeItem === null ? "" : ` [${record.requirement.scopeItem}]`}`,
          `claim: ${record.claim}`,
          `artefact: ${artefactLine(record)}, sha256 ${record.artefact.hash}`,
          worktreeLine(record),
        ];
        const media = record.artefact.mediaType;
        if (media.startsWith("image/") || media.startsWith("video/"))
          return {
            text: fence(
              "proof",
              `${lines.join("\n")}\n(${media.startsWith("image/") ? "an image" : "a video"}: judge it from its claim and recorder; its bytes are not text)`,
            ),
          };
        if (record.artefact.prunedAt !== null)
          return {
            text: fence(
              "proof",
              `${lines.join("\n")}\n(the artefact's bytes were pruned after 30 days; the record stays)`,
            ),
          };
        const read = yield* (yield* Blobs.BlobStore).get(record.artefact.hash);
        if (read._tag === "Pruned")
          return {
            text: fence(
              "proof",
              `${lines.join("\n")}\n(the artefact's bytes were pruned after 30 days; the record stays)`,
            ),
          };
        const page = bytePage(read.bytes, input.page ?? 1);
        const number = page.page;
        return {
          text: `${fence("proof", lines.join("\n"))}\n${fence("artefact", page.text)}${page.pages > 1 ? `\n[artefact page ${number} of ${page.pages}${number < page.pages ? `; ask for page ${number + 1} for more` : ""}]` : ""}`,
          paged: page.pages > 1,
        };
      }).pipe(
        Effect.provide(options.services),
        Effect.catch((error) => Effect.succeed(failed(error))),
      ),
  });

/** Both readers, for a stage's toolkit. */
export const proofReaders = (options: ProofToolsOptions) => [
  proofsTool(options),
  proofTool(options),
];
