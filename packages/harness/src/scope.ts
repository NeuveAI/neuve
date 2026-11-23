import { PAGE_BODY_BYTES } from "./budget.ts";
import { createHash } from "node:crypto";
import {
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { Clock, Context, Data, Duration, Effect, Option, Tracer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  Blobs,
  Computations,
  Log,
  STORE_DIRECTORY_MODE,
  STORE_FILE_MODE,
  Worker,
  canonicalJson,
  type StoreLocation,
} from "@neuve/records-core";
import {
  GitHubExternalRefSchema,
  GitOid,
  MAX_SCOPE_DOCUMENTS,
  safeRead,
  type CycleLocalScopeSelected,
  type CycleOpenedV2,
  type Range,
} from "@neuve/records-schema";
import { dataBlock } from "./data-block.ts";
import { git, resolveCommit } from "./git.ts";
import {
  commitTexts,
  type CommitText,
  lsTree,
  mergeBase,
  readBlobs,
  type TreeEntry,
} from "./git-objects.ts";
import {
  fetchingServers,
  readIntegrations,
  type IntegrationServer,
  type Integrations,
} from "./integrations.ts";
import {
  McpClients,
  mcpClientsLayer,
  type McpConnection,
} from "./mcp-client.ts";
import {
  openRunLog,
  runLogTracer,
  withTelemetry,
  type RunLog,
} from "./run-log.ts";
import { readSettings, telemetryMode } from "./settings.ts";
import {
  keepExternalFetched,
  keepFetched,
  keepScopeText,
  readScopeBytes,
  scopeFolder,
  ScopeNotKept,
} from "./scope-storage.ts";

import { blobText, jsonComputation, storedOutput } from "./search-index.ts";
import { READ_ONLY, defineTool, type ToolSpec } from "./toolkit.ts";

export { keepExternalFetched, keepFetched, scopeFolder, ScopeNotKept };

/**
 * A read-opened cycle fixes its external sources and base documents at the first fetch. A
 * review adds Git sources from its range. A review-opened cycle still gathers its sources
 * together so it can fetch tickets named by commits.
 *
 * External text is kept in the cycle's scope folder and in a masked raw capture. Snapshots
 * hold section indexes, hashes and references to the text.
 */

export const Stratum = z.enum([
  "plan-or-ticket-at-base",
  "plan-inside-range",
  "commit-or-pr-text",
  "nothing",
]);
export type Stratum = z.infer<typeof Stratum>;

const STRATUM_ORDER: ReadonlyArray<Stratum> = Stratum.options;

const Section = z.strictObject({
  id: z.string(),
  title: z.string(),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  bytes: z.int().min(0),
  sha256: z.string(),
});

export const ScopeSource = z.strictObject({
  id: z.string(),
  kind: z.enum([
    "ticket",
    "pull-request",
    "repository-document",
    "working-file",
    "commit-text",
    "addition",
  ]),
  stratum: Stratum,
  fetchedAt: z.string(),
  ms: z.int().min(0),
  status: z.enum(["fetched", "gap"]),
  complete: z.boolean().optional(),
  contextOnly: z.literal(true).optional(),
  /** Where it came from: the server, tool and item; the path and blob at a revision; the commits. */
  ref: z.strictObject({
    server: z.string().optional(),
    tool: z.string().optional(),
    item: z.string().optional(),
    path: z.string().optional(),
    blob: z.string().optional(),
    revision: z.string().optional(),
    commits: z.array(z.string()).optional(),
    /** How the source was found. */
    found: z.string(),
    external: GitHubExternalRefSchema.optional(),
  }),
  title: z.string(),
  sections: z.array(Section),
  /**
   * The pin of fetched external text (11.17): the SHA-256 of the text read and the provider's
   * version or update time when its answer gives one. Absent in snapshots fetched before pins.
   */
  sha256: z.string().optional(),
  version: z.string().nullable().optional(),
  /** The masked raw capture of fetched external text (10.8), with what it masked. */
  capture: z
    .strictObject({ blob: z.string(), masked: z.record(z.string(), z.int()) })
    .nullable(),
  gap: z.string().nullable(),
});
export type ScopeSource = z.infer<typeof ScopeSource>;

export const scopeStratum = (source: ScopeSource) =>
  source.contextOnly ? "context only" : source.stratum;

export const ScopeSnapshot = z.strictObject({
  cycleId: z.string(),
  branchTipOid: GitOid.optional(),
  fetchedAt: z.string(),
  ms: z.int().min(0),
  range: z.strictObject({
    baseOid: z.string(),
    headOid: z.string(),
    mergeBase: z.string(),
  }),
  integrations: z.strictObject({
    file: z.enum(["absent", "invalid", "configured"]),
    detail: z.string().nullable(),
    servers: z.array(
      z.strictObject({
        name: z.string(),
        status: z.enum(["connected", "unavailable", "unused"]),
        detail: z.string().nullable(),
        tools: z.array(z.string()),
        refused: z.array(
          z.strictObject({ tool: z.string(), reason: z.string() }),
        ),
      }),
    ),
  }),
  /** Ticket keys named in the branch or commit texts: candidates by the generic key shape. */
  named: z.array(
    z.strictObject({
      key: z.string(),
      where: z.string(),
      status: z.string(),
    }),
  ),
  sources: z.array(ScopeSource),
  strata: z.strictObject({ strongest: Stratum, present: z.array(Stratum) }),
  gaps: z.array(z.string()),
  /** Gaps' technical causes, for the disclosing run's log only; absent in older snapshots. */
  causes: z
    .array(z.strictObject({ gap: z.string(), cause: z.string() }))
    .optional(),
});
export type ScopeSnapshot = z.infer<typeof ScopeSnapshot>;

const CycleScope = ScopeSnapshot.omit({ range: true, strata: true });
type CycleScope = z.infer<typeof CycleScope>;

const RangeScope = ScopeSnapshot.pick({
  fetchedAt: true,
  ms: true,
  range: true,
  sources: true,
  gaps: true,
  causes: true,
}).extend({
  named: z.array(ScopeSnapshot.shape.named.element.omit({ status: true })),
});
type RangeScope = z.infer<typeof RangeScope>;

export const SCOPE_RECIPE = "neuve-scope-v1";

/** The one scope source no cycle has: Neuve reads no code host yet (9.13). */
export const NO_PR_TEXT =
  "The pull request's description wasn't read: Neuve doesn't read code hosts yet.";

/**
 * Scope gaps as a reader sees them. A cycle's snapshot is never fetched again (3.12), so a
 * snapshot stored before its gaps were written for readers keeps the old wording; it is
 * translated where the gap is disclosed, as is Precompute's line for a snapshot it could not fetch,
 * whose error stays in the run log as the cause.
 */
export const scopeGapForReader = (gap: string) =>
  gap === "no PR text: Neuve reads no code host in M3"
    ? NO_PR_TEXT
    : gap.startsWith("scope snapshot not fetched")
      ? "The change's scope (tickets, documents and commit messages) couldn't be gathered, so the review has no stated intent to check against."
      : gap;

const describeError = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message).slice(0, 300)
    : String(error).slice(0, 300);

/** Connecting and fetching tickets share one deadline. Unfetched sources become gaps. */
export const SCOPE_FETCH_BOUND_MS = 60_000;

const MAX_TICKETS = 20;
const MAX_DOCUMENT_BYTES = 262_144;
export const MAX_ADDITIONS_PER_RUN = 10;
/** A proxied tool's page shown to an agent, in bytes: the result cap less its frame (10.18). */
const RESULT_BYTES = PAGE_BODY_BYTES;

const sha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");

/** The SHA-256 of fetched text, as a source's pin holds it (11.17). */
export const textHash = sha256;

/**
 * Fields a provider's answer may name its item's last update or version by, in order: an update
 * time first, since the freshness check can trust one as a validator (11.18), then a version.
 */
const VERSION_FIELDS = [
  "updatedAt",
  "updated_at",
  "updated",
  "lastModified",
  "last_modified",
  "modifiedAt",
  "modified_at",
  "version",
] as const;

/**
 * The provider's version or update time of an item, when its answer gives one (11.17): the first of
 * `VERSION_FIELDS` holding a short string or a number, on the item itself: at the answer's top level,
 * or inside the one object an answer wraps the item in (`{ "issue": { ... } }`). A field of a related
 * object (an assignee, a project) is never the item's, so nothing deeper is read. Null when none is.
 */
export const versionOf = (response: unknown): string | null => {
  const at = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    for (const field of VERSION_FIELDS) {
      const found = (value as Record<string, unknown>)[field];
      const text =
        typeof found === "number" && Number.isFinite(found)
          ? String(found)
          : typeof found === "string"
            ? found.trim()
            : undefined;
      if (text !== undefined && /^[\x20-\x7e]{1,64}$/.test(text)) return text;
    }
    return undefined;
  };
  const top = at(response);
  if (top !== undefined) return top;
  const entries =
    typeof response === "object" &&
    response !== null &&
    !Array.isArray(response)
      ? Object.values(response as Record<string, unknown>)
      : [];
  return entries.length === 1 ? (at(entries[0]) ?? null) : null;
};

/** Heading sections (levels 1 to 3) of fetched text, or one section. */
export const sectionsOf = (sourceId: string, text: string) => {
  const lines = text.split("\n");
  const starts: Array<{ line: number; title: string }> = [
    { line: 1, title: "" },
  ];
  lines.forEach((line, index) => {
    const heading = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) return;
    if (index === 0) starts[0] = { line: 1, title: heading };
    else starts.push({ line: index + 1, title: heading });
  });
  return starts.flatMap((start, index) => {
    const end = (starts[index + 1]?.line ?? lines.length + 1) - 1;
    if (end < start.line) return [];
    const body = lines.slice(start.line - 1, end).join("\n");
    if (body.trim() === "") return [];
    return [
      {
        id: `${sourceId}.${index + 1}`,
        title: start.title,
        startLine: start.line,
        endLine: end,
        bytes: Buffer.byteLength(body),
        sha256: sha256(body),
      },
    ];
  });
};

/**
 * Ticket-key candidates: an uppercase prefix, a hyphen and digits, standing alone. It is the one
 * generic shape, with no per-system pattern; it also matches words like `UTF-8`, so these are
 * candidates that an integration's declared prefixes or Understand confirm, never facts.
 */
export const keyCandidates = (text: string) =>
  [
    ...text.matchAll(
      /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9}-[0-9]{1,7})(?![A-Za-z0-9-])/g,
    ),
  ].map((match) => match[1] ?? "");

/** Repository-relative paths a text names that resolve to a blob in a listing. */
const namedPaths = (text: string, blobs: ReadonlyMap<string, TreeEntry>) =>
  [
    ...new Set(
      (text.match(/[A-Za-z0-9_.\-/]+/g) ?? []).map((token) =>
        token.replace(/^\.\//, "").replace(/[.,:;]+$/, ""),
      ),
    ),
  ].filter(
    (token) => (token.includes(".") || token.includes("/")) && blobs.has(token),
  );

export const linkedPaths = (
  from: string,
  text: string,
  onFailure: (target: string, cause: string) => void,
) => {
  const paths = new Set<string>();
  for (const match of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
    let decoded: string;
    try {
      decoded = decodeURI(target);
    } catch (error) {
      onFailure(target, String(error));
      continue;
    }
    const path = posix.normalize(posix.join(posix.dirname(from), decoded));
    if (path !== ".." && !path.startsWith("../")) paths.add(path);
  }
  return [...paths];
};

/**
 * The repository's agent guide, read by a declared reader: the `AGENTS.md` open format at the root
 * of the base revision, the file a repository writes so coding agents find its working truth.
 * Neuve reads it as a declaration of where the repository's plans and decisions live, and follows
 * its relative links one hop.
 */
export const AGENT_GUIDE = {
  reader: "agents-md-root-v1",
  path: "AGENTS.md",
} as const;

/** A tool result as text and as JSON where the server gave one or the text parses. */
export const responseOf = (outcome: {
  readonly text: string;
  readonly structured: unknown;
}) => {
  if (outcome.structured !== undefined) return outcome.structured;
  try {
    return JSON.parse(outcome.text) as unknown;
  } catch {
    return undefined;
  }
};

export const titleOf = (response: unknown, fallback: string) => {
  if (typeof response === "object" && response !== null) {
    const title = (response as Record<string, unknown>)["title"];
    if (typeof title === "string" && title.trim() !== "")
      return title.slice(0, 200);
  }
  return fallback;
};

export interface SnapshotContext {
  readonly repository: string;
  readonly location: StoreLocation;
  readonly cycleId: string;
  readonly range: Pick<Range, "baseOid" | "headOid">;
  readonly integrations: Integrations;
}

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
  new Date(ms).toISOString(),
);

type NoteGap = (text: string, cause?: string) => void;
type ScopeRange = SnapshotContext["range"];
const snapshotRange = (
  { baseOid, headOid }: ScopeRange,
  mergeBase: string,
) => ({
  baseOid,
  headOid,
  mergeBase,
});
type ReadScopeOpening = z.infer<typeof CycleOpenedV2.shape.payload>;
type ScopeInput =
  | ({ readonly part: "cycle" } & ReadScopeOpening)
  | { readonly part: "review"; readonly range: ScopeRange };

const commitKeys = (commits: ReadonlyArray<CommitText>) => {
  const named = new Map<string, string>();
  for (const commit of commits)
    for (const key of keyCandidates(`${commit.subject}\n${commit.body}`))
      if (!named.has(key)) named.set(key, `commit ${commit.oid.slice(0, 12)}`);
  return named;
};

const rangeCommits = (
  repository: string,
  merge: string,
  head: string,
  gap: NoteGap,
) =>
  commitTexts(repository, merge, head).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        gap(
          "The commit messages couldn't be read, so they weren't used as scope.",
          describeError(error),
        );
        return [] as ReadonlyArray<CommitText>;
      }),
    ),
  );

type LocalSelection = CycleLocalScopeSelected["payload"];
type LocalPin = LocalSelection["sources"][number];

const scopePath = (root: string, path: string) => {
  const within = relative(root, path);
  return within === ".." || within.startsWith("../") || isAbsolute(within)
    ? path
    : within || ".";
};

const fileOverBound = `The file exceeds ${MAX_DOCUMENT_BYTES} bytes.`;
type WorkingFailure =
  { kind: "missing" } | { kind: "gap"; reason: string; cause?: string };
type WorkingRead =
  WorkingFailure | { kind: "file"; bytes: Uint8Array; fetchedAt: string };

const workingFailure = (error: unknown): WorkingFailure =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR")
    ? { kind: "missing" }
    : {
        kind: "gap",
        reason: "The file could not be read.",
        cause: String(error),
      };

const resolveWorkingPath = async (requested: string) => {
  try {
    return { kind: "resolved" as const, path: await realpath(requested) };
  } catch (error) {
    return { ...workingFailure(error), path: requested };
  }
};

const readWorkingFile = async (path: string): Promise<WorkingRead> => {
  try {
    await using file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const stat = await file.stat();
    if (!stat.isFile())
      return { kind: "gap", reason: "The path is not a regular file." };
    if (stat.size > MAX_DOCUMENT_BYTES)
      return { kind: "gap", reason: fileOverBound };
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        size,
        bytes.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    return size > MAX_DOCUMENT_BYTES
      ? { kind: "gap", reason: fileOverBound }
      : {
          kind: "file",
          bytes: bytes.subarray(0, size),
          fetchedAt: new Date().toISOString(),
        };
  } catch (error) {
    return workingFailure(error);
  }
};

const readNamedFiles = (root: string, paths: readonly string[]) =>
  Effect.gen(function* () {
    const resolved = yield* Effect.forEach(
      paths,
      (requested) =>
        Effect.promise(async () => ({
          requested,
          target: await resolveWorkingPath(resolve(root, requested)),
        })),
      { concurrency: MAX_SCOPE_DOCUMENTS },
    );
    const unique = new Map<
      string,
      {
        target: Awaited<ReturnType<typeof resolveWorkingPath>>;
        namedAs: string[];
      }
    >();
    for (const { requested, target } of resolved) {
      const path = scopePath(root, target.path);
      const first = unique.get(path);
      if (first === undefined)
        unique.set(path, { target, namedAs: [requested] });
      else first.namedAs.push(requested);
    }
    const selected = [...unique].slice(0, MAX_SCOPE_DOCUMENTS);
    const files = yield* Effect.forEach(
      selected,
      ([path, { target, namedAs }]) =>
        Effect.promise(async () => ({
          path,
          read:
            target.kind === "resolved"
              ? await readWorkingFile(target.path)
              : target,
          namedAs,
        })),
      { concurrency: MAX_SCOPE_DOCUMENTS },
    );
    return { files, omitted: unique.size - selected.length };
  });

const blobsOf = (listing: ReadonlyArray<TreeEntry>) =>
  new Map(
    listing
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry]),
  );

const localTree = (repository: string, base: string) =>
  Effect.map(lsTree(repository, base), blobsOf);

const documentBlobs = (
  repository: string,
  entries: ReadonlyArray<TreeEntry | undefined>,
  known?: ReadonlyMap<string, Uint8Array>,
) =>
  Effect.map(
    readBlobs(repository, [
      ...new Set(
        entries.flatMap((entry) =>
          entry === undefined ||
          (entry.size ?? 0) > MAX_DOCUMENT_BYTES ||
          known?.has(entry.oid)
            ? []
            : [entry.oid],
        ),
      ),
    ]),
    (fresh) => (known === undefined ? fresh : new Map([...known, ...fresh])),
  );

const namedScope = (
  sourceId: string,
  path: string,
  read: WorkingRead,
  entry: TreeEntry | undefined,
  blob: Uint8Array | undefined,
  onFailure: (cause: string) => void,
) => {
  if (read.kind === "gap")
    return { kind: "gap" as const, path, reason: read.reason };
  if (
    entry !== undefined &&
    (read.kind === "missing" ||
      (blob !== undefined && Buffer.compare(read.bytes, blob) === 0))
  )
    return { kind: "repository-document" as const, path, blob: entry.oid };
  if (read.kind === "missing")
    return {
      kind: "gap" as const,
      path,
      reason: isAbsolute(path)
        ? "The file was not found."
        : "The path was absent from the working tree and the base revision.",
    };
  if (blobText(read.bytes, onFailure) === undefined)
    return {
      kind: "gap" as const,
      path,
      reason: "The file is not readable as text.",
    };
  return {
    kind: "working-file" as const,
    sourceId,
    path,
    bytes: read.bytes,
    fetchedAt: read.fetchedAt,
    sha256: sha256(read.bytes),
  };
};

export const readLocalScope = (
  repository: string,
  revision: string,
  names: readonly string[],
) =>
  Effect.gen(function* () {
    const [base, top, directory] = yield* Effect.all(
      [
        resolveCommit(repository, revision),
        git(repository, ["rev-parse", "--show-toplevel"]),
        Effect.tryPromise(() => realpath(repository)),
      ],
      { concurrency: "unbounded" },
    );
    const root = top.replace(/\n$/, "");
    const paths = [
      ...new Set(
        names.map((name) => {
          const fromRepo = scopePath(repository, resolve(repository, name));
          return scopePath(root, resolve(directory, fromRepo));
        }),
      ),
    ];
    const [entries, { files, omitted }] = yield* Effect.all(
      [localTree(repository, base), readNamedFiles(root, paths)],
      { concurrency: 2 },
    );
    const resolved = files.map((file) => {
      const entry = entries.get(file.path);
      return {
        ...file,
        entry: entry?.mode === "120000" ? undefined : entry,
      };
    });
    const contents = yield* documentBlobs(repository, [
      entries.get(AGENT_GUIDE.path),
      ...resolved.flatMap(({ read, entry }) =>
        read.kind === "gap" ? [] : [entry],
      ),
    ]);
    const readFailures = files.flatMap(({ read, path }) =>
      read.kind === "gap" && read.cause !== undefined
        ? [{ path, cause: read.cause }]
        : [],
    );
    const sources = resolved.map(({ read, path, entry, namedAs }, index) => ({
      ...namedScope(
        localSourceId(index),
        path,
        read,
        entry,
        entry && contents.get(entry.oid),
        (cause) => readFailures.push({ path, cause }),
      ),
      namedAs,
    }));
    return {
      base,
      root,
      entries,
      contents,
      sources,
      readFailures,
      omitted,
    };
  }).pipe(Effect.timeout(SCOPE_FETCH_BOUND_MS));

export type LocalScopeRead = Effect.Success<ReturnType<typeof readLocalScope>>;
type ScopeCopy = { location: StoreLocation; cycleId: string };

const localSourceId = (index: number) => `S${index + 1}`;

export const keepLocalScope = (
  copy: ScopeCopy,
  read: LocalScopeRead,
  onWriteFailure: (path: string, cause: string) => void,
) =>
  Effect.gen(function* () {
    if (read.sources.length === 0) return undefined;
    const sources = yield* Effect.forEach(read.sources, (source) => {
      if (source.kind !== "working-file")
        return Effect.succeed<LocalPin>(source);
      const { bytes, ...pin } = source;
      return keepScopeText(
        copy.location,
        copy.cycleId,
        pin.sourceId,
        bytes,
      ).pipe(
        Effect.as<LocalPin>(pin),
        Effect.catchTag("ScopeNotKept", (error) => {
          onWriteFailure(pin.path, error.message);
          return Effect.succeed({
            kind: "gap" as const,
            path: pin.path,
            namedAs: pin.namedAs,
            reason: "The file was read but its copy could not be kept.",
          });
        }),
      );
    });
    return {
      root: read.root,
      sources,
      omitted: read.omitted,
    } satisfies LocalSelection;
  });

type ScopeTextRead =
  | { text: string; gap?: never; cause?: never }
  | { text?: never; gap: string; cause?: string | undefined };

const decodeScopeText = (bytes: Uint8Array, gap: string): ScopeTextRead => {
  let cause: string | undefined;
  const text = blobText(bytes, (error) => {
    cause = error;
  });
  return text === undefined ? { gap, cause } : { text };
};

export const heldLocalText = (
  copy: ScopeCopy,
  id: string,
  hash: string | undefined,
): ScopeTextRead => {
  const { bytes, cause } = readScopeBytes(copy.location, copy.cycleId, id);
  if (bytes === undefined)
    return { gap: "The held copy could not be read.", cause };
  if (sha256(bytes) !== hash)
    return { gap: "The held copy's SHA-256 differs from its citation." };
  return decodeScopeText(bytes, "The held copy is not readable as text.");
};

const LocalScope = z.strictObject({
  sources: z.array(ScopeSource),
  gaps: z.array(z.string()),
  causes: ScopeSnapshot.shape.causes,
  guideMissing: z.boolean(),
});
type LocalScope = z.infer<typeof LocalScope>;

const gitDocumentText = (
  entry: TreeEntry | undefined,
  bytes: Uint8Array | undefined,
): ScopeTextRead => {
  if (entry?.mode === "120000")
    return { gap: "The Git path is a symbolic link." };
  if (
    (entry?.size ?? 0) > MAX_DOCUMENT_BYTES ||
    (bytes?.byteLength ?? 0) > MAX_DOCUMENT_BYTES
  )
    return { gap: fileOverBound };
  if (bytes === undefined)
    return {
      gap: "The document's Git blob could not be read.",
      cause:
        entry === undefined
          ? "Git has no tree entry for the citation."
          : `Git returned no bytes for blob ${entry.oid}.`,
    };
  return decodeScopeText(
    bytes,
    "The document's Git blob is not readable as text.",
  );
};

const localScopeSources = (
  repository: string,
  base: string,
  pins: LocalSelection,
  tree: Pick<LocalScopeRead, "entries"> &
    Partial<Pick<LocalScopeRead, "contents">>,
  local: ScopeCopy | ReadonlyArray<readonly [string, string]>,
) =>
  Effect.gen(function* () {
    const { entries } = tree;
    const copy = "cycleId" in local ? local : undefined;
    const sources: ScopeSource[] = [];
    const { gaps, causes, gap: noteGap } = gapsOf();
    const disclose = (path: string, reason: string, cause?: string) =>
      noteGap(`${path}: ${reason}`, cause);
    const at = yield* nowIso;
    const named = new Map("cycleId" in local ? [] : local);
    const found = new Map<string, string>();
    const pinned = new Set(pins.sources.map((pin) => pin.path));
    const find = (path: string, reason: string) => {
      if (entries.has(path) && !pinned.has(path) && !found.has(path))
        found.set(path, reason);
    };
    const add = (
      source: Pick<
        ScopeSource,
        "id" | "kind" | "ref" | "fetchedAt" | "sha256" | "contextOnly"
      >,
      read: ScopeTextRead,
    ) => {
      const { text, gap } = read;
      const path = source.ref.path!;
      if (gap !== undefined) disclose(path, gap, read.cause);
      sources.push({
        ...source,
        stratum: "plan-or-ticket-at-base",
        ms: 0,
        status: text === undefined ? "gap" : "fetched",
        title: path,
        sections: text === undefined ? [] : sectionsOf(source.id, text),
        capture: null,
        gap: gap ?? null,
      });
    };
    const document = (
      id: string,
      path: string,
      blob: string,
      reason: string,
      contents: ReadonlyMap<string, Uint8Array>,
      contextOnly?: true,
    ) => {
      const read = gitDocumentText(entries.get(path), contents.get(blob));
      add(
        {
          id,
          kind: "repository-document",
          fetchedAt: at,
          ref: { path, blob, revision: base, found: reason },
          ...(contextOnly ? { contextOnly } : {}),
        },
        read,
      );
      return read.text;
    };
    const links = (path: string, text: string) => {
      const paths = linkedPaths(path, text, (target, cause) =>
        disclose(
          path,
          `A link could not be decoded (${JSON.stringify(target.slice(0, 200))}).`,
          cause,
        ),
      );
      for (const target of paths)
        find(
          isAbsolute(target) ? scopePath(pins.root, target) : target,
          `linked from ${path}`,
        );
    };

    const guide = entries.get(AGENT_GUIDE.path);
    const contents = yield* documentBlobs(
      repository,
      [
        ...pins.sources.flatMap((pin) =>
          pin.kind === "repository-document" ? [entries.get(pin.path)] : [],
        ),
        guide,
      ],
      tree.contents,
    );
    for (const [index, pin] of pins.sources.entries()) {
      const id =
        pin.kind === "working-file" ? pin.sourceId : localSourceId(index);
      if (pin.kind === "gap") {
        disclose(pin.path, pin.reason);
        continue;
      }
      let text: string | undefined;
      const found = pin.namedAs
        .map((path, index) => {
          const name = index === 0 ? "named by the request" : "also named";
          if (path !== pin.path) return `${name} through a link at ${path}`;
          return index === 0 ? name : `${name} directly`;
        })
        .join(" and ");
      if (pin.kind === "repository-document") {
        text = document(id, pin.path, pin.blob, found, contents);
      } else if (copy !== undefined) {
        const read = heldLocalText(copy, id, pin.sha256);
        add(
          {
            id,
            kind: pin.kind,
            fetchedAt: pin.fetchedAt,
            sha256: pin.sha256,
            ref: { path: pin.path, found },
          },
          read,
        );
        text = read.text;
      }
      if (text !== undefined) named.set(pin.path, text);
    }
    if (guide !== undefined) {
      find(guide.path, `agent guide (${AGENT_GUIDE.reader})`);
      const text = gitDocumentText(guide, contents.get(guide.oid)).text;
      if (text !== undefined && text !== named.get(guide.path))
        links(guide.path, text);
    }
    for (const [path, text] of named) {
      links(path, text);
      for (const target of namedPaths(text, entries))
        find(target, `named in ${path}`);
    }
    const room = MAX_SCOPE_DOCUMENTS - pins.sources.length;
    const omitted = pins.omitted + Math.max(0, found.size - room);
    if (omitted > 0)
      gaps.push(
        `${omitted} more document(s) exceeded the ${MAX_SCOPE_DOCUMENTS}-document limit.`,
      );
    const documents = [...found].slice(0, room);
    const foundContents = yield* documentBlobs(
      repository,
      documents.map(([path]) => entries.get(path)),
      contents,
    );
    for (const [index, [path, reason]] of documents.entries()) {
      const entry = entries.get(path)!;
      document(
        localSourceId(pins.sources.length + index),
        path,
        entry.oid,
        reason,
        foundContents,
        true,
      );
    }
    return {
      sources,
      gaps,
      ...(causes.length === 0 ? {} : { causes }),
      guideMissing: guide === undefined,
    } satisfies LocalScope;
  });

const selectedLocalScope = (cycleId: string) =>
  Effect.map(
    Log.history({ kind: "cycle.local-scope-selected@1", cycleId, limit: 1 }),
    ([entry]) =>
      entry?.event.kind === "cycle.local-scope-selected@1"
        ? entry.event.payload
        : undefined,
  );

const retrySharedAttempt = Effect.retry({
  times: 1,
  while: (error: unknown) => error instanceof Computations.SharedAttemptFailed,
});

const fetchCycleLocalScope = (
  repository: string,
  copy: ScopeCopy,
  base: string,
  pins: LocalSelection | undefined,
  read?: LocalScopeRead,
) => {
  const run = jsonComputation(
    {
      op: "harness.cycle-local-scope",
      opVersion: 2,
      inputs: { cycle: `cycle:${copy.cycleId}` },
    },
    LocalScope,
    Effect.gen(function* () {
      return yield* localScopeSources(
        repository,
        base,
        pins ?? { root: repository, sources: [], omitted: 0 },
        read ?? { entries: yield* localTree(repository, base) },
        copy,
      );
    }),
  );
  return run.pipe(
    retrySharedAttempt,
    Effect.map(({ value }) => value),
  );
};

type LocalScopeSource = ScopeSource & { text?: string };

const sourceWithGap = (source: ScopeSource, gap: string): ScopeSource => ({
  ...source,
  status: "gap",
  gap,
});

const validateHeldScope = <
  T extends Pick<LocalScope, "sources" | "gaps" | "causes">,
>(
  copy: ScopeCopy,
  scope: T,
): T => {
  const { gaps, causes, gap: disclose } = gapsOf(scope);
  const sources = scope.sources.map((source) => {
    if (source.kind !== "working-file" || source.status !== "fetched")
      return source;
    const { gap, cause } = heldLocalText(copy, source.id, source.sha256);
    if (gap === undefined) return source;
    disclose(`${source.title}: ${gap}`, cause);
    return sourceWithGap(source, gap);
  });
  return {
    ...scope,
    sources,
    gaps,
    ...(causes.length === 0 ? {} : { causes }),
  };
};

const localScopeAnswer = (
  repository: string,
  read: LocalScopeRead,
  scope: LocalScope,
  copy?: ScopeCopy,
) =>
  Effect.gen(function* () {
    const { gaps, causes, gap: disclose } = gapsOf(scope);
    const documents = yield* documentBlobs(
      repository,
      scope.sources.flatMap((source) =>
        source.kind === "repository-document" && source.status === "fetched"
          ? [read.entries.get(source.title)]
          : [],
      ),
      read.contents,
    );
    const sources: LocalScopeSource[] = scope.sources.map((source) => {
      if (source.status === "gap") return source;
      const text =
        source.kind === "working-file" && copy !== undefined
          ? heldLocalText(copy, source.id, source.sha256)
          : gitDocumentText(
              read.entries.get(source.title),
              documents.get(source.ref.blob ?? ""),
            );
      if (text.gap !== undefined) {
        disclose(`${source.title}: ${text.gap}`, text.cause);
        return sourceWithGap(source, text.gap);
      }
      return { ...source, text: text.text };
    });
    return { sources, gaps, causes };
  });

const firstQueryScope =
  "Only the first query can add files to a review cycle's scope.";

export const queryLocalScope = (
  repository: string,
  read: LocalScopeRead,
  copy: ScopeCopy,
) =>
  Effect.gen(function* () {
    const pins = yield* selectedLocalScope(copy.cycleId);
    const held = new Set(
      pins?.sources.flatMap((pin) => [pin.path, ...pin.namedAs]),
    );
    const gaps = read.sources
      .filter(({ path }) => !held.has(path))
      .map(({ path }) => `${path}: ${firstQueryScope}`);
    if (read.omitted > (pins?.omitted ?? 0))
      gaps.push(
        `The request named more than ${MAX_SCOPE_DOCUMENTS} documents.`,
      );
    if (pins === undefined && !read.entries.has(AGENT_GUIDE.path))
      return { sources: [], gaps, causes: [] };
    const scope = yield* fetchCycleLocalScope(
      repository,
      copy,
      read.base,
      pins,
      read,
    );
    const answer = yield* localScopeAnswer(repository, read, scope, copy);
    return { ...answer, gaps: [...answer.gaps, ...gaps] };
  });

export const queryUnheldLocalScope = (
  repository: string,
  read: LocalScopeRead,
  reason: string,
) =>
  Effect.gen(function* () {
    const scope = yield* localScopeSources(
      repository,
      read.base,
      {
        root: read.root,
        omitted: read.omitted,
        sources: read.sources.map((source) =>
          source.kind !== "working-file"
            ? source
            : {
                kind: "gap" as const,
                path: source.path,
                namedAs: source.namedAs,
                reason: `Neuve read the file without keeping a copy for review because ${reason}. ${firstQueryScope}`,
              },
        ),
      },
      read,
      read.sources.flatMap((source) => {
        const text =
          source.kind === "working-file" ? blobText(source.bytes) : undefined;
        return text === undefined ? [] : [[source.path, text] as const];
      }),
    );
    return yield* localScopeAnswer(repository, read, scope);
  });

const documentSources = (options: {
  repository: string;
  base: string;
  head: string;
  commits: ReadonlyArray<CommitText>;
  part: "review" | "range";
  sourceId: () => string;
  gap: NoteGap;
}) =>
  Effect.gen(function* () {
    const { repository, base, head, commits, part, sourceId, gap } = options;
    const sources: Array<ScopeSource> = [];
    yield* Effect.gen(function* () {
      const baseListing = yield* lsTree(repository, base);
      const headListing =
        head === base ? baseListing : yield* lsTree(repository, head);
      const atBase = blobsOf(baseListing);
      const atHead = blobsOf(headListing);
      const wanted = new Map<string, string>();
      if (part !== "range") {
        const guide = atBase.get(AGENT_GUIDE.path);
        if (guide !== undefined) {
          wanted.set(guide.path, `agent guide (${AGENT_GUIDE.reader})`);
          const bytes = (yield* readBlobs(repository, [guide.oid])).get(
            guide.oid,
          );
          const text = bytes === undefined ? undefined : blobText(bytes);
          const links =
            text === undefined
              ? []
              : linkedPaths(guide.path, text, (target, cause) =>
                  gap(
                    `A link in ${guide.path} couldn't be followed because it isn't a valid path: "${target.slice(0, 200)}".`,
                    cause,
                  ),
                );
          for (const path of links)
            if ((atBase.has(path) || atHead.has(path)) && !wanted.has(path))
              wanted.set(path, `linked from ${guide.path}`);
        } else
          gap(
            `The repository has no ${AGENT_GUIDE.path} at the base, so its own conventions weren't read as scope.`,
          );
      }
      const available = new Map([...atHead, ...atBase]);
      for (const commit of commits)
        for (const path of namedPaths(
          `${commit.subject}\n${commit.body}`,
          available,
        ))
          if (!wanted.has(path))
            wanted.set(path, `named in commit ${commit.oid.slice(0, 12)}`);
      const entryOf = (path: string) =>
        part === "range"
          ? (atHead.get(path) ?? atBase.get(path))
          : (atBase.get(path) ?? atHead.get(path));
      const documents = [...wanted].slice(0, MAX_SCOPE_DOCUMENTS);
      if (wanted.size > MAX_SCOPE_DOCUMENTS)
        gap(
          `${wanted.size - MAX_SCOPE_DOCUMENTS} more repository document(s) weren't read: a review reads at most ${MAX_SCOPE_DOCUMENTS}.`,
        );
      const entries = documents.map(([path]) => entryOf(path));
      const contents = yield* documentBlobs(repository, entries);
      for (const [path, found] of documents) {
        const entry = entryOf(path);
        if (entry === undefined) continue;
        const id = sourceId();
        const at = yield* nowIso;
        const read = gitDocumentText(entry, contents.get(entry.oid));
        const { text } = read;
        if (read.cause !== undefined && read.gap !== undefined)
          gap(`${path}: ${read.gap}`, read.cause);
        const atBaseRevision =
          part === "range"
            ? !atHead.has(path) || atBase.get(path)?.oid === entry.oid
            : atBase.has(path);
        const stratum = atBaseRevision
          ? "plan-or-ticket-at-base"
          : "plan-inside-range";
        sources.push({
          id,
          kind: "repository-document",
          stratum,
          fetchedAt: at,
          ms: 0,
          status: text === undefined ? "gap" : "fetched",
          ref: {
            path,
            blob: entry.oid,
            revision: atBaseRevision ? base : head,
            found,
          },
          title: path,
          sections: text === undefined ? [] : sectionsOf(id, text),
          capture: null,
          gap: read.gap ?? null,
        });
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          options.gap(
            "The repository's documents couldn't be read, so they weren't used as scope.",
            describeError(error),
          ),
        ),
      ),
    );
    return sources;
  });

const commitScope = (
  commits: ReadonlyArray<CommitText>,
  merge: string,
  head: string,
  sourceId: () => string,
) =>
  Effect.gen(function* () {
    if (commits.length === 0) return undefined;
    const id = sourceId();
    const text = commits
      .map((commit) => `# ${commit.subject}\n\n${commit.body}`)
      .join("\n\n");
    return {
      id,
      kind: "commit-text",
      stratum: "commit-or-pr-text",
      fetchedAt: yield* nowIso,
      ms: 0,
      status: "fetched",
      ref: {
        commits: commits.map((commit) => commit.oid),
        found: `commits of ${merge.slice(0, 12)}..${head.slice(0, 12)}`,
      },
      title: `${commits.length} commit message(s)`,
      sections: sectionsOf(id, text),
      capture: null,
      gap: null,
    } satisfies ScopeSource;
  });

const gapsOf = (previous?: Pick<LocalScope, "gaps" | "causes">) => {
  const gaps = [...(previous?.gaps ?? [])];
  const causes = [...(previous?.causes ?? [])];
  const gap: NoteGap = (text, cause) => {
    gaps.push(text);
    if (cause !== undefined)
      causes.push({ gap: text, cause: cause.slice(0, 500) });
  };
  return { gaps, causes, gap };
};

const strataOf = (
  sources: ReadonlyArray<ScopeSource>,
): ScopeSnapshot["strata"] => {
  const present = STRATUM_ORDER.filter((stratum) =>
    sources.some(
      (source) =>
        source.status === "fetched" &&
        !source.contextOnly &&
        source.stratum === stratum,
    ),
  );
  return { strongest: present[0] ?? "nothing", present };
};

const fetchSources = (ctx: Omit<SnapshotContext, "range">, input: ScopeInput) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const fetchedAt = new Date(started).toISOString();
    const clients = yield* McpClients;
    const { repository, cycleId } = ctx;
    const merge =
      input.part === "cycle"
        ? input.baseOid
        : yield* mergeBase(
            repository,
            input.range.baseOid,
            input.range.headOid,
          );
    const head = input.part === "cycle" ? input.baseOid : input.range.headOid;
    const sources: Array<ScopeSource> = [];
    const { gaps, causes, gap } = gapsOf();
    const deadline = started + SCOPE_FETCH_BOUND_MS;
    const remaining = Effect.map(
      Clock.currentTimeMillis,
      (now) => deadline - now,
    );
    const branchTipOid =
      input.part === "cycle" ? input.branchTipOid : undefined;
    const commits = yield* rangeCommits(
      repository,
      merge,
      branchTipOid ?? head,
      gap,
    );
    const branches =
      input.part === "cycle"
        ? [input.branch]
        : (yield* git(repository, [
            "for-each-ref",
            "--points-at",
            head,
            "--format=%(refname:short)",
            "refs/heads",
          ]).pipe(Effect.orElseSucceed(() => "")))
            .split("\n")
            .filter(Boolean);
    // Local documents and tickets assign source IDs independently.
    let next = input.part === "cycle" ? MAX_SCOPE_DOCUMENTS + 1 : 1;
    const sourceId = () => `S${next++}`;
    const external = yield* selectedExternalContext(cycleId);
    for (const pin of external?.sources ?? []) {
      const { text: copy, cause } = readScopeText(
        ctx.location,
        cycleId,
        pin.sourceId,
      );
      const blob =
        copy === undefined
          ? yield* (yield* Blobs.BlobStore).get(pin.capture.blob)
          : undefined;
      const text =
        copy ??
        (blob?._tag === "Present"
          ? new TextDecoder().decode(blob.bytes)
          : undefined);
      sources.push({
        id: pin.sourceId,
        kind: pin.item.kind === "issue" ? "ticket" : "pull-request",
        stratum:
          pin.item.kind === "issue"
            ? "plan-or-ticket-at-base"
            : "commit-or-pr-text",
        fetchedAt: pin.fetchedAt,
        ms: 0,
        status: text === undefined ? "gap" : "fetched",
        complete: pin.complete,
        ref: {
          server: "github",
          tool: "github-body-v1",
          item: pin.item.url,
          external: pin.item,
          found: "explicit review origin",
        },
        title: pin.title,
        sections: text === undefined ? [] : sectionsOf(pin.sourceId, text),
        sha256: pin.sha256,
        version: pin.version,
        capture: pin.capture,
        gap:
          text === undefined
            ? "The selected source's retained capture has expired."
            : pin.complete
              ? null
              : "The selected source was only partly read.",
      });
      if (text === undefined)
        gap(
          `The selected ${pin.item.kind === "issue" ? "issue" : "pull request"} description is no longer available.`,
          cause,
        );
      if (!pin.complete)
        gap(
          `The selected ${pin.item.kind === "issue" ? "issue" : "pull request"} description was only partly read.`,
        );
      gap(
        `The discussion of ${pin.item.url} was not pinned as review context.`,
      );
    }

    // Named keys, in order of first mention.
    const named = new Map<string, string>();
    for (const branch of branches)
      for (const key of keyCandidates(branch))
        if (!named.has(key)) named.set(key, `branch ${branch}`);
    for (const [key, where] of commitKeys(commits))
      if (!named.has(key)) named.set(key, where);
    const selectedEvents = yield* Log.history({
      kind: "cycle.scope-selected@1",
      cycleId,
      limit: 2,
    });
    const selected = selectedEvents[0]?.event;
    const explicit =
      selected?.kind === "cycle.scope-selected@1"
        ? selected.payload
        : undefined;
    if (explicit) named.set(explicit.item, "explicit planning selection");
    const namedStatus = new Map<string, string>();

    // 1. Tickets through the configured integrations.
    const servers: Array<ScopeSnapshot["integrations"]["servers"][number]> = [];
    const fetching = fetchingServers(ctx.integrations);
    if (ctx.integrations.status === "configured")
      for (const name of Object.keys(ctx.integrations.file.servers))
        if (!fetching.some(([fetcher]) => fetcher === name))
          servers.push({
            name,
            status: "unused",
            detail: "no fetch declared",
            tools: [],
            refused: [],
          });
    let fetchedTickets = 0;
    for (const [name, server] of fetching) {
      const fetch = server.fetch;
      if (fetch === undefined) continue;
      const keys = [...named.keys()].filter(
        (key) =>
          !namedStatus.has(key) &&
          (explicit?.item !== key || explicit.server === name) &&
          (fetch.keyPrefixes === undefined ||
            fetch.keyPrefixes.some((prefix) => key.startsWith(`${prefix}-`))),
      );
      const before = yield* remaining;
      const connection = yield* Effect.result(
        before <= 0
          ? Effect.fail({
              message: `not connected: the scope fetch reached its ${SCOPE_FETCH_BOUND_MS / 1_000} s bound first`,
            })
          : clients.get(name).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(before),
                orElse: () =>
                  Effect.fail({
                    message: `did not connect within the scope fetch's ${SCOPE_FETCH_BOUND_MS / 1_000} s bound`,
                  }),
              }),
            ),
      );
      if (connection._tag === "Failure") {
        servers.push({
          name,
          status: "unavailable",
          detail: connection.failure.message,
          tools: [],
          refused: [],
        });
        gap(
          `The ${name} integration couldn't be reached, so the tickets it holds weren't read.`,
          connection.failure.message,
        );
        continue;
      }
      const live: McpConnection = connection.success;
      servers.push({
        name,
        status: "connected",
        detail: null,
        tools: live.tools.map((tool) => tool.name),
        refused: [...live.refused],
      });
      for (const key of keys) {
        if (fetchedTickets >= MAX_TICKETS) {
          namedStatus.set(
            key,
            `not fetched: the cycle-start bound of ${MAX_TICKETS} tickets`,
          );
          continue;
        }
        const left = yield* remaining;
        if (left <= 0) {
          namedStatus.set(
            key,
            `not fetched: the scope fetch reached its ${SCOPE_FETCH_BOUND_MS / 1_000} s bound`,
          );
          continue;
        }
        const id = sourceId();
        const at = yield* Clock.currentTimeMillis;
        const outcome = yield* Effect.result(
          live.call(fetch.tool, { [fetch.argument]: key }).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(left),
              orElse: () =>
                Effect.fail({
                  message: `no answer within the scope fetch's ${SCOPE_FETCH_BOUND_MS / 1_000} s bound`,
                }),
            }),
            Effect.withSpan("harness.scope.source", {
              attributes: {
                "harness.scope.kind": "ticket",
                "harness.scope.server": name,
              },
            }),
          ),
        );
        const ms = (yield* Clock.currentTimeMillis) - at;
        const base = {
          id,
          kind: "ticket" as const,
          stratum: "plan-or-ticket-at-base" as const,
          fetchedAt: new Date(at).toISOString(),
          ms,
          ref: {
            server: name,
            tool: fetch.tool,
            item: key,
            found: named.get(key) ?? "",
          },
        };
        if (
          outcome._tag === "Failure" ||
          outcome.success.isError ||
          outcome.success.text.trim() === ""
        ) {
          const reason =
            outcome._tag === "Failure"
              ? outcome.failure.message
              : outcome.success.isError
                ? `the server answered with an error: ${outcome.success.text.slice(0, 200)}`
                : "the server returned no text";
          namedStatus.set(key, `not fetched: ${reason}`);
          sources.push({
            ...base,
            status: "gap",
            title: key,
            sections: [],
            capture: null,
            gap: reason,
          });
          gap(
            `Ticket ${key} is named but couldn't be fetched from ${name}, so its requirements weren't read.`,
            reason,
          );
          continue;
        }
        const response = responseOf(outcome.success);
        const kept = yield* Effect.result(
          keepFetched(
            ctx.location,
            cycleId,
            id,
            outcome.success.text,
            response,
            server,
          ),
        );
        if (kept._tag === "Failure") {
          const reason = `fetched but not kept: ${describeError(kept.failure)}`;
          namedStatus.set(key, `not fetched: ${reason}`);
          sources.push({
            ...base,
            status: "gap",
            title: key,
            sections: [],
            capture: null,
            gap: reason,
          });
          gap(
            `Ticket ${key} was fetched from ${name} but couldn't be kept, so its requirements weren't read.`,
            reason,
          );
          continue;
        }
        fetchedTickets++;
        const capture = kept.success;
        namedStatus.set(key, `fetched through ${name} as ${id}`);
        sources.push({
          ...base,
          status: "fetched",
          title: titleOf(response, key),
          sections: sectionsOf(id, outcome.success.text),
          sha256: sha256(outcome.success.text),
          version: versionOf(response),
          capture,
          gap: null,
        });
      }
    }
    const reason =
      ctx.integrations.status === "absent"
        ? "no integration is configured"
        : ctx.integrations.status === "invalid"
          ? "the integration settings are invalid"
          : "no configured integration handles its key";
    for (const [key, where] of named)
      if (!namedStatus.has(key)) {
        namedStatus.set(key, `named, not fetched: ${reason}`);
        gaps.push(
          `Ticket ${key}, named in ${where.startsWith("branch") ? "the branch name" : "a commit message"}, wasn't fetched because ${reason}, so its requirements weren't read.`,
        );
      }

    const reviewCommits = input.part === "review" ? commits : [];
    if (input.part === "cycle") {
      const pins = yield* selectedLocalScope(cycleId);
      const local = validateHeldScope(
        ctx,
        yield* fetchCycleLocalScope(repository, ctx, merge, pins),
      );
      sources.push(...local.sources);
      gaps.push(...local.gaps);
      causes.push(...(local.causes ?? []));
      if (local.guideMissing)
        gap(
          `The repository has no ${AGENT_GUIDE.path} at the base, so its own conventions weren't read as scope.`,
        );
    } else
      sources.push(
        ...(yield* documentSources({
          repository,
          base: merge,
          head,
          commits: reviewCommits,
          part: input.part,
          sourceId,
          gap,
        })),
      );
    const commitSource = yield* commitScope(
      reviewCommits,
      merge,
      head,
      sourceId,
    );
    if (commitSource !== undefined) sources.push(commitSource);
    if (
      !external?.sources.some((source) => source.item.kind === "pull-request")
    )
      gaps.push(NO_PR_TEXT);

    return {
      merge,
      cycle: {
        cycleId,
        ...(branchTipOid === undefined ? {} : { branchTipOid }),
        fetchedAt,
        ms: (yield* Clock.currentTimeMillis) - started,
        integrations: {
          file: ctx.integrations.status,
          detail:
            ctx.integrations.status === "invalid"
              ? ctx.integrations.reason.slice(0, 500)
              : ctx.integrations.path,
          servers,
        },
        named: [...named].map(([key, where]) => ({
          key,
          where,
          status: namedStatus.get(key) ?? "",
        })),
        sources,
        gaps,
        ...(causes.length === 0 ? {} : { causes }),
      } satisfies CycleScope,
    };
  }).pipe(
    Effect.withSpan("harness.scope.fetch", {
      attributes: { "harness.cycle_id": ctx.cycleId },
    }),
  );

const SCOPE_SNAPSHOT_OP = "harness.scope-snapshot";

export const snapshotSpec = (
  cycleId: string,
  externalIdentity?: string,
): Computations.ComputationSpec => ({
  op: SCOPE_SNAPSHOT_OP,
  // 2: this build's snapshot reads the cycle's explicit scope selection and has new fields. Builds
  // before 12.24 still fetch version 1 for every cycle they see, the transition's included (their
  // `scope.fetch` job is a kind they take), so the two never share a stored snapshot (12.24).
  opVersion: 2,
  // The one input is the cycle: the snapshot belongs to it alone (see the module comment).
  inputs: { cycle: `cycle:${cycleId}` },
  config: {
    recipe:
      externalIdentity === undefined ? SCOPE_RECIPE : "neuve-scope-github-v1",
    ...(externalIdentity === undefined
      ? {}
      : { externalContext: externalIdentity }),
  },
});

const cycleScopeSpec = (cycleId: string): Computations.ComputationSpec => ({
  ...snapshotSpec(cycleId),
  opVersion: 4,
});

const rangeScopeSpec = (range: ScopeRange): Computations.ComputationSpec => ({
  op: "harness.range-scope",
  opVersion: 1,
  inputs: {
    base: `git-commit:${range.baseOid}`,
    head: `git-commit:${range.headOid}`,
  },
  config: { recipe: SCOPE_RECIPE },
});

export const readScopeOpening = (cycleId: string) =>
  Effect.map(
    Log.history({ cycleId, kind: "cycle.opened@2", limit: 1 }),
    ([entry]) =>
      entry?.event.kind === "cycle.opened@2" ? entry.event.payload : undefined,
  );

const asSnapshot = (
  cycle: CycleScope,
  range: ScopeSnapshot["range"],
): ScopeSnapshot => ({
  ...cycle,
  range,
  strata: strataOf(cycle.sources),
});

const fetchReviewSnapshot = (ctx: SnapshotContext) =>
  Effect.gen(function* () {
    const external = yield* selectedExternalContext(ctx.cycleId);
    const run = jsonComputation(
      snapshotSpec(ctx.cycleId, external?.identity),
      ScopeSnapshot,
      Effect.map(
        fetchSources(ctx, { part: "review", range: ctx.range }),
        ({ cycle, merge }) =>
          asSnapshot(cycle, snapshotRange(ctx.range, merge)),
      ),
    );
    return yield* run.pipe(retrySharedAttempt);
  });

const storedCyclePart = (cycleId: string) =>
  Effect.gen(function* () {
    const spec = cycleScopeSpec(cycleId);
    const split = yield* storedOutput(spec, CycleScope);
    if (Option.isSome(split))
      return { key: Computations.computationKey(spec).key, value: split.value };
    if ((yield* selectedLocalScope(cycleId)) !== undefined) return undefined;
    const legacy = snapshotSpec(cycleId);
    const full = yield* storedOutput(legacy, ScopeSnapshot);
    if (Option.isSome(full))
      return {
        key: Computations.computationKey(legacy).key,
        value: full.value,
      };
  });

export const fetchCyclePart = (
  ctx: Omit<SnapshotContext, "range">,
  opening: ReadScopeOpening,
) =>
  Effect.gen(function* () {
    const held = yield* storedCyclePart(ctx.cycleId);
    if (held !== undefined)
      return {
        ...held,
        value: validateHeldScope(ctx, held.value),
        status: "reused" as const,
      };
    const run = jsonComputation(
      cycleScopeSpec(ctx.cycleId),
      CycleScope,
      Effect.map(
        fetchSources(ctx, { ...opening, part: "cycle" }),
        ({ cycle }) => cycle,
      ),
    );
    return yield* run.pipe(retrySharedAttempt);
  });

const cycleScopeView = (cycle: CycleScope, baseOid: string) =>
  asSnapshot(cycle, { baseOid, headOid: baseOid, mergeBase: baseOid });

const fetchRangeScope = (repository: string, range: ScopeRange) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const { gaps, causes, gap } = gapsOf();
    const merge = yield* mergeBase(repository, range.baseOid, range.headOid);
    const commits = yield* rangeCommits(repository, merge, range.headOid, gap);
    let next = 1;
    const sourceId = () => `S${next++}`;
    const sources = yield* documentSources({
      repository,
      base: merge,
      head: range.headOid,
      commits,
      part: "range",
      sourceId,
      gap,
    });
    const commitSource = yield* commitScope(
      commits,
      merge,
      range.headOid,
      sourceId,
    );
    if (commitSource !== undefined) sources.push(commitSource);
    return {
      fetchedAt: new Date(started).toISOString(),
      ms: (yield* Clock.currentTimeMillis) - started,
      range: snapshotRange(range, merge),
      named: [...commitKeys(commits)].map(([key, where]) => ({ key, where })),
      sources,
      gaps,
      ...(causes.length === 0 ? {} : { causes }),
    } satisfies RangeScope;
  });

const composeSnapshot = (
  cycle: CycleScope,
  range: RangeScope,
): ScopeSnapshot => {
  const knownKeys = new Set(cycle.named.map(({ key }) => key));
  const named = range.named.filter(({ key }) => !knownKeys.has(key));
  const sources = [...cycle.sources];
  const pinnedPaths = new Set(sources.map((source) => source.ref.path));
  const pinnedIds = new Set(sources.map((source) => source.id));
  let next = 1;
  for (const source of range.sources) {
    if (source.ref.path !== undefined && pinnedPaths.has(source.ref.path))
      continue;
    while (pinnedIds.has(`S${next}`)) next++;
    const id = `S${next++}`;
    sources.push({
      ...source,
      id,
      sections: source.sections.map((section) => ({
        ...section,
        id: id + section.id.slice(source.id.length),
      })),
    });
  }
  const causes = [...(cycle.causes ?? []), ...(range.causes ?? [])];
  return {
    ...cycle,
    ms: cycle.ms + range.ms,
    range: range.range,
    named: [
      ...cycle.named,
      ...named.map((item) => ({
        ...item,
        status: "named after cycle scope was read",
      })),
    ],
    sources,
    strata: strataOf(sources),
    gaps: [
      ...cycle.gaps,
      ...range.gaps,
      ...named.map(
        ({ key }) =>
          `Ticket ${key} was named after this cycle's scope was read.`,
      ),
    ],
    ...(causes.length === 0 ? {} : { causes }),
  };
};

const splitKey = (cycleId: string, cycleKey: string, rangeKey: string) =>
  `scope:${cycleId}:${cycleKey}:${rangeKey}`;

export const hasFixedScope = (key: string) => key.startsWith("scope:");

const snapshotOutput = <T>(
  record: Computations.Computation | undefined,
  schema: z.ZodType<T>,
) =>
  Effect.gen(function* () {
    if (record === undefined) return undefined;
    const blob = yield* (yield* Blobs.BlobStore).get(record.outputHash);
    if (blob._tag === "Pruned") return undefined;
    const parsed = safeRead(
      schema,
      JSON.parse(new TextDecoder().decode(blob.bytes)),
    );
    return parsed.success ? parsed.data : undefined;
  });

export const snapshotByKey = (key: string) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    if (!hasFixedScope(key))
      return yield* snapshotOutput(
        Option.getOrUndefined(yield* store.lookup(key)),
        ScopeSnapshot,
      );
    const [, cycleId, cycleKey, rangeKey] = key.split(":");
    if (
      cycleId === undefined ||
      cycleKey === undefined ||
      rangeKey === undefined
    )
      return undefined;
    const parts = yield* store.lookupMany([cycleKey, rangeKey]);
    const range = yield* snapshotOutput(parts.get(rangeKey), RangeScope);
    if (range === undefined) return undefined;
    const record = parts.get(cycleKey);
    if (record?.op !== SCOPE_SNAPSHOT_OP) return undefined;
    const cycle =
      record.opVersion === 4
        ? yield* snapshotOutput(record, CycleScope)
        : record.opVersion === 2
          ? yield* snapshotOutput(record, ScopeSnapshot)
          : undefined;
    return cycle === undefined || cycle.cycleId !== cycleId
      ? undefined
      : composeSnapshot(cycle, range);
  });

export const reviewSnapshot = (
  ctx: SnapshotContext,
  opening: Effect.Success<ReturnType<typeof readScopeOpening>>,
) =>
  Effect.gen(function* () {
    if (opening === undefined) return yield* fetchReviewSnapshot(ctx);
    const range = jsonComputation(
      rangeScopeSpec(ctx.range),
      RangeScope,
      fetchRangeScope(ctx.repository, ctx.range),
    );
    const [cycleResult, rangeResult] = yield* Effect.all(
      [fetchCyclePart(ctx, opening), range],
      { concurrency: 2 },
    );
    const result = {
      key: splitKey(ctx.cycleId, cycleResult.key, rangeResult.key),
      status:
        rangeResult.status === "reused"
          ? cycleResult.status
          : rangeResult.status,
      value: composeSnapshot(cycleResult.value, rangeResult.value),
    };
    try {
      writeScopeLog(scopeLog(ctx.location, ctx.cycleId), result);
    } catch (error) {
      yield* Effect.logDebug("Could not write the cycle's scope log", error);
    }
    return result;
  });

export const selectedExternalContext = (cycleId: string) =>
  Effect.gen(function* () {
    const event = (yield* Log.history({
      kind: "cycle.external-context-selected@1",
      cycleId,
      limit: 2,
    }))[0]?.event;
    return event?.kind === "cycle.external-context-selected@1"
      ? event.payload
      : undefined;
  });

export const storedSnapshot = (
  cycleId: string,
  range: ScopeRange,
  key?: string,
) =>
  Effect.gen(function* () {
    if (key !== undefined)
      return Option.fromUndefinedOr(yield* snapshotByKey(key));
    const opening = yield* readScopeOpening(cycleId);
    if (opening !== undefined) {
      const cycle = yield* storedCyclePart(cycleId);
      if (cycle === undefined) return Option.none();
      const rangePart = yield* storedOutput(rangeScopeSpec(range), RangeScope);
      return Option.some(
        Option.isSome(rangePart)
          ? composeSnapshot(cycle.value, rangePart.value)
          : cycleScopeView(cycle.value, opening.baseOid),
      );
    }
    const external = yield* selectedExternalContext(cycleId);
    return yield* storedOutput(
      snapshotSpec(cycleId, external?.identity),
      ScopeSnapshot,
    );
  });

/** The unmasked text of a fetched item, while the cycle's folder holds it. */
export const readScopeText = (
  location: StoreLocation,
  cycleId: string,
  sourceId: string,
) => {
  const { bytes, cause } = readScopeBytes(location, cycleId, sourceId);
  return bytes === undefined ? { cause } : { text: bytes.toString("utf8") };
};

/** 10.79's cap: a cycle's unmasked scope copy goes after this long with no run in the cycle. */
export const SCOPE_COPY_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Masked captures have their own 30-day retention. */
export const deleteCycleScope = (location: StoreLocation, cycleId: string) =>
  Effect.sync(() => {
    const folder = scopeFolder(location, cycleId);
    const existed = existsSync(folder);
    rmSync(folder, { recursive: true, force: true });
    return existed;
  });

/**
 * When the cycle last saw a run, from Records: the latest of its opening, its review requests (a
 * run's start) and its stage and run completions (a run's progress and finish). None when Records
 * holds nothing for the cycle.
 */
const lastRunActivity = (cycleId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{
      at: string | null;
    }>`SELECT max(e.recorded_at) AS at
      FROM events e LEFT JOIN event_cycles c ON c.event_seq = e.seq
      WHERE c.cycle_id = ${cycleId} OR json_extract(e.envelope, '$.attribution.cycleId') = ${cycleId}`;
    return row?.at === null || row?.at === undefined
      ? Option.none<number>()
      : Option.some(Date.parse(row.at));
  });

/**
 * The cycles whose unmasked scope copy is due (10.79): no run in the cycle for 7 days, measured
 * from Records; a folder whose cycle Records does not know falls back to its modification time.
 */
const dueScopeCopies = (location: StoreLocation) =>
  Effect.gen(function* () {
    const root = join(location.directory, "scope");
    if (!existsSync(root)) return [];
    const now = yield* Clock.currentTimeMillis;
    const due: Array<{ cycleId: string; reason: string }> = [];
    for (const cycleId of readdirSync(root)) {
      const last = yield* lastRunActivity(cycleId);
      const at = Option.isSome(last)
        ? last.value
        : statSync(join(root, cycleId)).mtimeMs;
      if (now - at >= SCOPE_COPY_IDLE_MS)
        due.push({
          cycleId,
          reason: `no run in the cycle since ${new Date(at).toISOString()} (${Option.isSome(last) ? "from Records" : "folder time; Records holds no run for it"})`,
        });
    }
    return due;
  });

/** The idle sweep of unmasked scope copies, run by the daily `retention.prune` (10.79). */
export const scopeCopySweep = (location: StoreLocation) => ({
  name: "cycle scope copies",
  wanted: Effect.map(dueScopeCopies(location), (due) => due.length > 0),
  sweep: Effect.gen(function* () {
    const lines: Array<string> = [];
    for (const { cycleId, reason } of yield* dueScopeCopies(location))
      if (yield* deleteCycleScope(location, cycleId))
        lines.push(
          `removed ${scopeFolder(location, cycleId)}: unmasked scope copy, ${reason}; masked captures keep their 30-day retention`,
        );
    return lines as ReadonlyArray<string>;
  }),
});

// Understand's additions (10.53).

const additionSpec = (
  cycleId: string,
  server: string,
  tool: string,
  input: unknown,
): Computations.ComputationSpec => ({
  op: "harness.scope-addition",
  opVersion: 1,
  inputs: {
    cycle: `cycle:${cycleId}`,
    server,
    tool,
    input: sha256(canonicalJson(input as never)),
  },
  config: { recipe: SCOPE_RECIPE },
});

const frozenSpec = (cycleId: string): Computations.ComputationSpec => ({
  op: "harness.scope-frozen",
  opVersion: 1,
  inputs: { cycle: `cycle:${cycleId}` },
  config: { recipe: SCOPE_RECIPE },
});

export const Frozen = z.strictObject({
  frozenAt: z.string(),
  additions: z.array(z.string()),
});

/** Whether the cycle's snapshot froze: Understand completed once in this cycle. */
export const isFrozen = (cycleId: string) =>
  Effect.map(storedOutput(frozenSpec(cycleId), Frozen), Option.isSome);

/** Freezes the snapshot when Understand completes (10.53); a second freeze finds the first. */
export const freezeSnapshot = (
  cycleId: string,
  additions: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const frozenAt = yield* nowIso;
    return yield* jsonComputation(
      frozenSpec(cycleId),
      Frozen,
      Effect.succeed({ frozenAt, additions: [...additions] }),
    );
  });

const Addition = z.strictObject({ source: ScopeSource });

/**
 * The first page of an integration item, as untrusted data: in a block whose tag carries the
 * SHA-256 of its content (data-block.ts), so the item's text cannot close it, as `scopeBlock` and
 * `scope_section` show scope text. The rest is read by section, never cut silently.
 */
export const scopeItemPage = (
  source: Pick<ScopeSource, "id" | "fetchedAt">,
  text: string,
  sections: string,
) => {
  let cut = Math.min(text.length, RESULT_BYTES);
  while (
    cut < text.length &&
    Buffer.byteLength(text.slice(0, cut)) > RESULT_BYTES
  )
    cut = Math.floor(cut * 0.9);
  const lastLine = text.lastIndexOf("\n", cut);
  if (cut < text.length && lastLine > 0) cut = lastLine;
  return {
    text: `${dataBlock("scope", { source: source.id, fetched: source.fetchedAt }, text.slice(0, cut))}${cut < text.length ? `\n[first page of ${Buffer.byteLength(text)} bytes; read the rest by section with scope_section: ${sections}]` : ""}`,
    paged: cut < text.length,
  };
};

/**
 * Understand's proxied read tools: each allowed tool of each connected server, as
 * `<server>__<tool>`. A call adds the item to the cycle's snapshot with its own fetch time, at most
 * 10 new additions per run shared by every Understand partition; an item already in the snapshot is
 * served from it, two partitions asking at once share one fetch, and once the snapshot froze no
 * item is added (10.53). Results are untrusted data, capped near the tool-result size.
 */
export const additionTools = (options: {
  readonly location: StoreLocation;
  readonly cycleId: string;
  readonly connections: ReadonlyArray<{
    readonly connection: McpConnection;
    readonly server: IntegrationServer;
  }>;
  readonly frozen: boolean;
  /** Shared by the run's Understand partitions. */
  readonly budget: { left: number; readonly added: Array<string> };
  /** The run's Records services. */
  readonly records: Context.Context<
    Blobs.BlobStore | Computations.ComputationStore
  >;
}): ReadonlyArray<ToolSpec<unknown>> =>
  options.connections.flatMap(({ connection, server }) =>
    connection.tools.map((tool) =>
      defineTool({
        name: `${connection.server}__${tool.name}`.slice(0, 64),
        description: `Reads from the ${connection.server} integration (scope source, untrusted data): ${tool.description}`,
        input: tool.input,
        hints: { ...READ_ONLY, openWorld: true, idempotent: false },
        handle: (input: unknown) =>
          Effect.gen(function* () {
            const spec = additionSpec(
              options.cycleId,
              connection.server,
              tool.name,
              input,
            );
            const held = yield* storedOutput(spec, Addition);
            const respond = (source: ScopeSource) => {
              if (source.status === "gap")
                return { text: `Not added: ${source.gap ?? "no text"}` };
              const { text, cause } = readScopeText(
                options.location,
                options.cycleId,
                source.id,
              );
              if (cause !== undefined)
                logScopeReadFailure(options, source.id, cause);
              const sections = source.sections
                .map((section) => `${section.id} "${section.title}"`)
                .join(", ");
              if (text === undefined)
                return {
                  text: `${source.id} is in the cycle's snapshot (fetched ${source.fetchedAt}), but its unmasked copy is gone (swept after 7 days with no run in the cycle, 10.79, or lost). Read its sections with scope_section, which shows the masked capture: ${sections}`,
                  empty: true,
                };
              return scopeItemPage(source, text, sections);
            };
            if (Option.isSome(held)) return respond(held.value.source);
            if (options.frozen)
              return {
                text: "The scope snapshot is frozen for this cycle; this item is not in it, and no item is added until the next cycle.",
                empty: true,
              };
            if (options.budget.left <= 0)
              return {
                text: `No more additions in this run (at most ${MAX_ADDITIONS_PER_RUN}).`,
                empty: true,
              };
            options.budget.left--;
            const result = yield* jsonComputation(
              spec,
              Addition,
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis;
                const id = `A${sha256(canonicalJson(spec as never)).slice(0, 8)}`;
                const outcome = yield* Effect.result(
                  connection.call(tool.name, input),
                );
                const ms = (yield* Clock.currentTimeMillis) - at;
                const base = {
                  id,
                  kind: "addition" as const,
                  stratum: "plan-or-ticket-at-base" as const,
                  fetchedAt: new Date(at).toISOString(),
                  ms,
                  ref: {
                    server: connection.server,
                    tool: tool.name,
                    found: "added during Understand",
                  },
                };
                if (outcome._tag === "Failure" || outcome.success.isError)
                  return {
                    source: {
                      ...base,
                      status: "gap" as const,
                      title: tool.name,
                      sections: [],
                      capture: null,
                      gap:
                        outcome._tag === "Failure"
                          ? outcome.failure.message
                          : outcome.success.text.slice(0, 300),
                    },
                  };
                const response = responseOf(outcome.success);
                const capture = yield* keepFetched(
                  options.location,
                  options.cycleId,
                  id,
                  outcome.success.text,
                  response,
                  server,
                );
                return {
                  source: {
                    ...base,
                    status: "fetched" as const,
                    title: titleOf(response, tool.name),
                    sections: sectionsOf(id, outcome.success.text),
                    sha256: sha256(outcome.success.text),
                    version: versionOf(response),
                    capture,
                    gap: null,
                  },
                };
              }),
            );
            if (result.status === "computed")
              options.budget.added.push(result.key);
            return respond(result.value.source);
          }).pipe(
            Effect.provide(options.records),
            Effect.catch((error) =>
              Effect.succeed({
                text: `The integration call failed: ${String((error as { message?: unknown }).message ?? error)}`,
                error: "IntegrationFailed",
              }),
            ),
          ),
      }),
    ),
  );

export const scopeLogFields = (snapshot: ScopeSnapshot) => ({
  ...(snapshot.branchTipOid === undefined
    ? {}
    : { branchTipOid: snapshot.branchTipOid }),
  fetchedAt: snapshot.fetchedAt,
  ms: snapshot.ms,
  strongest: snapshot.strata.strongest,
  sources: snapshot.sources.map(
    ({ id, kind, stratum, status, fetchedAt, ms }) => ({
      id,
      kind,
      stratum,
      status,
      fetchedAt,
      ms,
    }),
  ),
  gaps: snapshot.gaps,
  ...(snapshot.causes === undefined ? {} : { causes: snapshot.causes }),
});

/** One line per source and gap, for logs and `neuve review show`. */
export const describeSnapshot = (snapshot: ScopeSnapshot) => [
  `scope snapshot for cycle ${snapshot.cycleId}, fetched ${snapshot.fetchedAt} in ${snapshot.ms} ms; strongest stratum ${snapshot.strata.strongest}`,
  `  integrations: ${snapshot.integrations.file}${snapshot.integrations.servers.map((server) => `; ${server.name} ${server.status}${server.detail === null ? "" : ` (${server.detail})`}${server.tools.length === 0 ? "" : ` tools ${server.tools.join(", ")}`}${server.refused.map((refused) => `; refused ${refused.tool}: ${refused.reason}`).join("")}`).join("")}`,
  ...snapshot.sources.map(
    (source) =>
      `  ${source.id} ${source.kind.padEnd(19)} ${source.stratum.padEnd(22)} ${source.status.padEnd(7)} ${source.fetchedAt} ${source.ms} ms  ${source.ref.item ?? source.ref.path ?? source.title}${source.capture === null ? "" : `  masked capture ${source.capture.blob.slice(0, 12)} ${JSON.stringify(source.capture.masked)}`}${source.gap === null ? "" : `  gap: ${source.gap}`}`,
  ),
  ...snapshot.named.map(
    (named) => `  named ${named.key} (${named.where}): ${named.status}`,
  ),
  ...snapshot.gaps.map((gap) => `  gap: ${gap}`),
];

/** Scope fetches and review snapshots for a cycle, in one log. */
const scopeLog = (location: StoreLocation, cycleId: string): RunLog => {
  const path = join(location.directory, "scope-logs", `${cycleId}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true, mode: STORE_DIRECTORY_MODE });
  return withTelemetry(
    {
      path,
      write: (record) =>
        writeFileSync(
          path,
          `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
          {
            flag: "a",
            mode: STORE_FILE_MODE,
          },
        ),
      read: () =>
        existsSync(path)
          ? readFileSync(path, "utf8")
              .split("\n")
              .filter((line) => line !== "")
              .map((line) => JSON.parse(line) as { type: string })
          : [],
    },
    telemetryMode(readSettings()) !== "off",
  );
};

export const logScopeReadFailure = (
  copy: ScopeCopy & { attempt?: { runId: string } | undefined },
  sourceId: string,
  cause: string,
) => {
  try {
    const log =
      copy.attempt === undefined
        ? scopeLog(copy.location, copy.cycleId)
        : openRunLog(copy.location, copy.attempt.runId, false);
    log.write({
      type: "scope.read-failed",
      sourceId,
      cause,
    });
  } catch {}
};

const writeScopeLog = (
  log: RunLog,
  result: { key: string; status: string; value: ScopeSnapshot },
) =>
  log.write({
    type: "scope.snapshot",
    key: result.key,
    status: result.status,
    range: result.value.range,
    ...scopeLogFields(result.value),
  });

/** A `scope.fetch` job without its cycle's event; no attempt can succeed. */
export class NotACycle extends Data.TaggedError("NotACycle")<{
  readonly message: string;
  readonly retryable: false;
}> {}

/** The worker's `scope.fetch` handler: the cycle's snapshot, with its own connections and log. */
export const scopeFetchHandler =
  (options: {
    readonly repository: string;
    readonly location: StoreLocation;
  }): Worker.JobHandler =>
  (job) =>
    Effect.gen(function* () {
      const stored =
        job.eventId === null ? Option.none() : yield* Log.get(job.eventId);
      const event = Option.getOrUndefined(stored)?.event;
      if (event?.kind !== "cycle.opened@1" && event?.kind !== "cycle.opened@2")
        return yield* new NotACycle({
          message: `job ${job.seq} has no cycle opening event`,
          retryable: false,
        });
      const { cycleId } = event.attribution;
      const log = scopeLog(options.location, cycleId);
      const integrations = readIntegrations();
      log.write({
        type: "scope.fetch.started",
        cycleId,
        jobSeq: job.seq,
        attempt: job.attempts,
        integrations: integrations.status,
      });
      const ctx = { ...options, cycleId, integrations };
      const result = yield* (
        event.kind === "cycle.opened@1"
          ? fetchReviewSnapshot({ ...ctx, range: event.attribution.range })
          : Effect.map(fetchCyclePart(ctx, event.payload), (result) => ({
              ...result,
              value: cycleScopeView(result.value, event.payload.baseOid),
            }))
      ).pipe(
        Effect.provide(mcpClientsLayer(integrations)),
        Effect.provideService(Tracer.Tracer, runLogTracer(log)),
      );
      writeScopeLog(log, result);
      for (const line of describeSnapshot(result.value))
        yield* Effect.logInfo(line);
      yield* Effect.logInfo(
        `scope.fetch cycle ${cycleId}: snapshot ${result.status} (${result.key.slice(0, 12)}); log ${log.path}`,
      );
      return result.status;
    });
