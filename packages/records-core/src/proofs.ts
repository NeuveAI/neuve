import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { setPriority, tmpdir } from "node:os";
import { Clock, Data, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import {
  PROOF_ARTEFACT_MAX_BYTES,
  PROOF_MEDIA_TYPES,
  ProofPayload,
  mediaTypeFits,
  type BlobRetention,
  type ProofInput,
  type ProofKind,
  type ProofWorktree,
  type Range,
} from "@neuve/records-schema";
import { BlobStore, type PromoteResult } from "./blobs.ts";
import { resolveCaller, type CallerResolution } from "./caller.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { decodeEnvelope } from "./codec.ts";
import { CorruptRecord } from "./errors.ts";
import { baseAlias } from "./identity.ts";
import { mintUlid } from "./ids.ts";
import type { StoreLocation } from "./location.ts";
import * as Log from "./log.ts";
import { readSession, readSubagent } from "./sessions.ts";
import { assertCompatible } from "./store.ts";

/**
 * Proof records (11.3, 11.8; proposal §12, slice H4b). An agent records what it observed (a test
 * run, a type check, a log, telemetry, a screenshot or a video its tools saved) against the range it
 * works on; Records keeps every record as a `proof.recorded@1` event with its artefact as a blob.
 * Recording happens outside the harness: the harness only reads the records and their artefacts,
 * so its tracked-work rule (10.34) is unchanged. Whether a record is current for a unit is decided
 * when it is read, from git objects (11.10): stale proof is disclosed, never treated as forged.
 */

/** A proof was not recorded: the reason is a sentence for the agent or person who asked. */
export class ProofRefused extends Data.TaggedError("ProofRefused")<{
  readonly message: string;
}> {}

/** A git read failed for a reason other than the answer being no. */
export class ProofGitFailed extends Data.TaggedError("ProofGitFailed")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly message: string;
}> {}

/** Longest range a listing walks, in commits; bounds the git output and the lookup it feeds. */
export const RANGE_COMMITS_MAX = 10_000;

/** Most records one listing returns; the harness's pager pages through them. */
export const LIST_MAX = 1_000;

/**
 * Runs git against object IDs only, never the working tree, at nice 10 (6.10). Returns the exit
 * code with the output, so callers read "no" answers (`merge-base --is-ancestor`) as data.
 */
const git = (repository: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn(["git", "-C", repository, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal,
      });
      try {
        setPriority(child.pid, 10);
      } catch {
        // A sandbox may refuse to change priority; the read still runs.
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
    catch: (cause) =>
      new ProofGitFailed({ args, exitCode: -1, message: String(cause) }),
  });

const gitOk = (repository: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(git(repository, args), (result) =>
    result.exitCode === 0
      ? Effect.succeed(result.stdout)
      : Effect.fail(
          new ProofGitFailed({
            args,
            exitCode: result.exitCode,
            message: result.stderr.trim().slice(0, 500),
          }),
        ),
  );

/** The commit a revision names, or none when git knows no such commit. */
const commitOf = (repository: string, revision: string) =>
  Effect.map(
    git(repository, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${revision}^{commit}`,
    ]),
    (result) =>
      result.exitCode === 0
        ? Option.some(result.stdout.trim())
        : Option.none<string>(),
  );

/** Whether `ancestor` is `descendant` or in its history. */
const isAncestor = (repository: string, ancestor: string, descendant: string) =>
  Effect.flatMap(
    git(repository, ["merge-base", "--is-ancestor", ancestor, descendant]),
    (result) =>
      result.exitCode === 0
        ? Effect.succeed(true)
        : result.exitCode === 1
          ? Effect.succeed(false)
          : Effect.fail(
              new ProofGitFailed({
                args: ["merge-base", "--is-ancestor"],
                exitCode: result.exitCode,
                message: result.stderr.trim().slice(0, 500),
              }),
            ),
  );

/** `<base>..<head>` resolved to commits; `baseRef` keeps the base as it was named. */
export const resolveRange = (repository: string, text: string) =>
  Effect.gen(function* () {
    const at = text.indexOf("..");
    const base = at > 0 ? text.slice(0, at) : "";
    const head = at > 0 ? text.slice(at + 2) : "";
    if (base === "" || head === "" || head.startsWith("."))
      return yield* new ProofRefused({
        message: `Expected a range as <base>..<head>, not ${text}.`,
      });
    const baseOid = yield* commitOf(repository, base);
    const headOid = yield* commitOf(repository, head);
    if (Option.isNone(baseOid) || Option.isNone(headOid))
      return yield* new ProofRefused({
        message: `${Option.isNone(baseOid) ? base : head} names no commit in this repository.`,
      });
    return {
      baseRef: base,
      baseOid: baseOid.value,
      headOid: headOid.value,
    } satisfies Range;
  });

// ---------------------------------------------------------------------------------------------
// The currency rule (11.10)
// ---------------------------------------------------------------------------------------------

/**
 * Whether a record counts for a unit (11.10, proposal §8.4). `current`: it observed a commit in the
 * head's history after which none of the unit's owned files changed up to the head. Anything else is
 * `stale`, which counts at most toward shallow coverage and is disclosed as stale, never as forged:
 * `changed-after` names the owned files that changed since (at most 20, with the count);
 * `not-in-history` is a commit the head does not descend from, such as one amended or rebased away;
 * `unknown-revision` is a commit this repository does not have.
 */
export type Currency =
  | { readonly status: "current" }
  | {
      readonly status: "stale";
      readonly reason: "changed-after";
      readonly changed: ReadonlyArray<string>;
      readonly changedCount: number;
    }
  | {
      readonly status: "stale";
      readonly reason: "not-in-history" | "unknown-revision";
    };

const CHANGED_SHOWN = 20;

/**
 * What git answered for a commit against a head, kept for the process: commits are immutable, so
 * the files changed between two known commits, and whether one is in the other's history, never
 * change. Keyed by the repository and both full OIDs only; an unknown commit is not kept, since a
 * fetch can bring it in. Bounded, oldest first out: every packet read and every run's check of the
 * same head asks git once per commit (11.18 checks on every run; the desk reads on every load).
 */
const KNOWN_MAX = 256;
const KNOWN_PATHS_MAX = 20_000;
const knownAnswers = new Map<string, ReadonlySet<string> | Currency>();
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const knownKey = (
  options: { readonly repository: string; readonly headOid: string },
  revision: string,
) =>
  FULL_OID.test(revision) && FULL_OID.test(options.headOid)
    ? `${options.repository}\u0000${options.headOid}\u0000${revision}`
    : undefined;
const known = (
  options: { readonly repository: string; readonly headOid: string },
  revision: string,
) => {
  const key = knownKey(options, revision);
  return key === undefined ? undefined : knownAnswers.get(key);
};
const remember = (
  options: { readonly repository: string; readonly headOid: string },
  revision: string,
  answer: ReadonlySet<string> | Currency,
) => {
  const key = knownKey(options, revision);
  if (
    key === undefined ||
    // A diff past this many paths is not kept: the memo stays small in a long-lived process.
    (answer instanceof Set && answer.size > KNOWN_PATHS_MAX) ||
    (!(answer instanceof Set) &&
      (answer as Currency).status === "stale" &&
      (answer as { reason?: string }).reason === "unknown-revision")
  )
    return;
  knownAnswers.delete(key);
  knownAnswers.set(key, answer);
  if (knownAnswers.size > KNOWN_MAX)
    knownAnswers.delete(knownAnswers.keys().next().value!);
};

/**
 * The currency check for one unit, as a function the harness calls per unit. `ownedPaths` are the
 * paths the unit owns on either side (H7's units will supply them). It reads commit and tree objects
 * only: the files changed between the revision and the head, from `git diff --name-only` between the
 * two OIDs, intersected with the owned paths. Renames count as a change to both paths. A checker
 * caches the diff per revision, so one unit's records cost one diff per distinct revision.
 */
export const currencyChecker = (options: {
  readonly repository: string;
  readonly headOid: string;
}) => {
  const changedSince = new Map<string, ReadonlySet<string> | Currency>();
  const changedFrom = (revision: string) =>
    Effect.gen(function* () {
      const cached = changedSince.get(revision) ?? known(options, revision);
      if (cached !== undefined) return cached;
      let result: ReadonlySet<string> | Currency;
      if (Option.isNone(yield* commitOf(options.repository, revision)))
        result = { status: "stale", reason: "unknown-revision" };
      else if (
        !(yield* isAncestor(options.repository, revision, options.headOid))
      )
        result = { status: "stale", reason: "not-in-history" };
      else {
        const out = yield* gitOk(options.repository, [
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          revision,
          options.headOid,
        ]);
        result = new Set(out.split("\0").filter((path) => path !== ""));
      }
      changedSince.set(revision, result);
      remember(options, revision, result);
      return result;
    });
  return (
    revision: string,
    ownedPaths: ReadonlyArray<string>,
  ): Effect.Effect<Currency, ProofGitFailed | ProofRefused> =>
    Effect.gen(function* () {
      if (ownedPaths.length === 0)
        return yield* new ProofRefused({
          message: "A unit owns at least one path; none was given.",
        });
      const changed = yield* changedFrom(revision);
      if (!(changed instanceof Set)) return changed as Currency;
      const hit = [...new Set(ownedPaths)].filter((path) => changed.has(path));
      if (hit.length === 0) return { status: "current" } satisfies Currency;
      hit.sort();
      return {
        status: "stale",
        reason: "changed-after",
        changed: hit.slice(0, CHANGED_SHOWN),
        changedCount: hit.length,
      } satisfies Currency;
    });
};

/**
 * The paths a range changes, from the diff between its two OIDs: the owned paths of the whole range
 * taken as one unit, for counts made before units exist (H7).
 */
export const changedPaths = (repository: string, range: Range) =>
  Effect.map(
    gitOk(repository, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      range.baseOid,
      range.headOid,
    ]),
    (out): ReadonlyArray<string> =>
      out.split("\0").filter((path) => path !== ""),
  );

/** One currency check, for a single record and unit. */
export const currency = (options: {
  readonly repository: string;
  readonly headOid: string;
  readonly revision: string;
  readonly ownedPaths: ReadonlyArray<string>;
}) => currencyChecker(options)(options.revision, options.ownedPaths);

/** A currency as a few words, for listings and the harness's readers. */
export const describeCurrency = (currency: Currency) => {
  if (currency.status === "current") return "current";
  switch (currency.reason) {
    case "changed-after":
      return `stale: ${currency.changedCount} owned file(s) changed after it (${currency.changed.join(", ")}${currency.changedCount > currency.changed.length ? ", ..." : ""})`;
    case "not-in-history":
      return "stale: its commit is not in the head's history";
    case "unknown-revision":
      return "stale: its commit is not in this repository";
  }
};

/**
 * A currency back from `describeCurrency`'s words, as stored outputs keep it (the units stage's proof
 * index): the status and reason, without the changed files' names. Words it does not know, or none,
 * are an unchecked currency.
 */
export const currencyFromDescription = (
  text: string | undefined,
): Currency | { readonly status: "unchecked" } => {
  if (text === "current") return { status: "current" };
  if (text === "stale: its commit is not in the head's history")
    return { status: "stale", reason: "not-in-history" };
  if (text === "stale: its commit is not in this repository")
    return { status: "stale", reason: "unknown-revision" };
  const changed = /^stale: (\d+) owned file\(s\) changed after it/.exec(
    text ?? "",
  );
  if (changed !== null)
    return {
      status: "stale",
      reason: "changed-after",
      changed: [],
      changedCount: Number(changed[1]),
    };
  return { status: "unchecked" };
};

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  webm: "video/webm",
  mp4: "video/mp4",
  json: "application/json",
  ndjson: "application/x-ndjson",
  jsonl: "application/x-ndjson",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  out: "text/plain; charset=utf-8",
};

const TEXT_TYPE = "text/plain; charset=utf-8";

const mediaTypeOf = (input: ProofInput) => {
  if (input.mediaType !== undefined) return input.mediaType;
  if (input.text !== undefined) return TEXT_TYPE;
  const extension = /\.([A-Za-z0-9]+)$/.exec(input.file ?? "")?.[1];
  return extension === undefined
    ? undefined
    : EXTENSION_TYPES[extension.toLowerCase()];
};

export interface RecordRequest {
  readonly repository: string;
  /**
   * Masks credential shapes and clear identifiers in what the record stores as text: the claim, the
   * requirement and a `text` artefact (10.5, 10.8). Callers pass the harness's `maskText`, the one
   * set of patterns, which Records cannot import.
   */
  readonly mask: (text: string) => string;
  /** The recorder: the agent session (or subagent) that observed the proof, and its session. */
  readonly actorId: string;
  readonly sessionId: string;
  readonly turnKey?: string | undefined;
  readonly cycleId?: string | undefined;
  readonly input: ProofInput;
}

export type RecordResult = {
  /** `existing`: this recorder already recorded the same proof; nothing new was written. */
  readonly status: "recorded" | "existing";
  readonly id: string;
  readonly seq: number;
  readonly range: Range;
  readonly revision: string;
  readonly kind: ProofKind;
  readonly worktree: ProofWorktree;
  readonly artefact: {
    readonly hash: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly retention: BlobRetention;
  };
};

const refuse = (message: string) => new ProofRefused({ message });

/** Whether `path` is strictly inside `root`; both are real paths. */
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
};

/** The system temp folders, as real paths: the OS temp dir, `$TMPDIR` and `/private/tmp`. */
const tempRoots = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const roots = new Set<string>();
  for (const candidate of [
    tmpdir(),
    process.env["TMPDIR"],
    "/private/tmp",
    "/tmp",
  ]) {
    if (candidate === undefined || candidate === "") continue;
    const real = yield* Effect.result(fs.realPath(candidate));
    if (real._tag === "Success") roots.add(real.success);
  }
  return [...roots];
});

/** The repository's working tree, as a real path; none for a bare repository. */
const worktreeRoot = (repository: string) =>
  Effect.gen(function* () {
    const result = yield* git(repository, ["rev-parse", "--show-toplevel"]);
    if (result.exitCode !== 0) return Option.none<string>();
    const real = yield* Effect.result(
      (yield* FileSystem).realPath(result.stdout.trim()),
    );
    return real._tag === "Success"
      ? Option.some(real.success)
      : Option.none<string>();
  });

/**
 * Which files an artefact may be read from, so the recording surfaces never act as a confused deputy
 * that reads past the agent's own sandbox or puts credentials into Records (10.5). The path is
 * resolved through every symbolic link first, and the real path must be inside the repository's
 * working tree, tracked or untracked but never git-ignored (which covers `.env.local`), or inside a
 * system temp folder. Anything under a `.git` folder and any `.env` file is refused wherever it is.
 * Returns the real path.
 */
const admitArtefactPath = (repository: string, path: string) =>
  Effect.gen(function* () {
    if (!isAbsolute(path))
      return yield* refuse(`The artefact path must be absolute: ${path}.`);
    const fs = yield* FileSystem;
    const resolved = yield* Effect.result(fs.realPath(path));
    if (resolved._tag === "Failure")
      return yield* refuse(`${path} is not a readable file.`);
    const real = resolved.success;
    const shown =
      real === resolve(path) ? path : `${path} (resolves to ${real})`;
    if (real.split(sep).includes(".git"))
      return yield* refuse(
        `${shown} is inside a .git folder; artefacts never come from git's own files.`,
      );
    if (/^\.env(?:\..*)?$/.test(basename(real)))
      return yield* refuse(
        `${shown} is an environment file, which may hold credentials; it is never recorded.`,
      );
    const tree = yield* worktreeRoot(repository);
    if (Option.isSome(tree) && inside(tree.value, real)) {
      const ignored = yield* git(tree.value, [
        "check-ignore",
        "--quiet",
        "--",
        relative(tree.value, real),
      ]);
      if (ignored.exitCode === 0)
        return yield* refuse(
          `${shown} is git-ignored; artefacts inside the working tree must not be ignored files, which can hold local secrets. Save it elsewhere in the tree or in a temp folder.`,
        );
      if (ignored.exitCode !== 1)
        return yield* new ProofGitFailed({
          args: ["check-ignore"],
          exitCode: ignored.exitCode,
          message: ignored.stderr.trim().slice(0, 500),
        });
      return real;
    }
    if ((yield* tempRoots).some((root) => inside(root, real))) return real;
    return yield* refuse(
      `${shown} is outside the repository's working tree and the temp folders; save the artefact in one of them.`,
    );
  });

/**
 * Reads an admitted file through one open handle, checking that the opened file is still the one
 * the path names, so a link swapped in after the check is refused rather than followed.
 */
const readAdmitted = (real: string, shown: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const handle = yield* fs.open(real, { flag: "r" });
      const opened = yield* handle.stat;
      if (opened.type !== "File")
        return yield* refuse(`${shown} is not a regular file.`);
      if (Number(opened.size) > PROOF_ARTEFACT_MAX_BYTES)
        return yield* refuse(
          `${shown} has ${String(opened.size)} bytes; a proof artefact holds at most ${PROOF_ARTEFACT_MAX_BYTES}.`,
        );
      const again = yield* fs.stat(real);
      if (
        (yield* fs.realPath(real)) !== real ||
        Option.getOrUndefined(again.ino) !==
          Option.getOrUndefined(opened.ino) ||
        again.dev !== opened.dev
      )
        return yield* refuse(`${shown} changed while it was being read.`);
      const chunks: Array<Uint8Array> = [];
      let total = 0;
      for (;;) {
        const chunk = yield* handle.readAlloc(1_048_576);
        if (Option.isNone(chunk) || chunk.value.byteLength === 0) break;
        total += chunk.value.byteLength;
        if (total > PROOF_ARTEFACT_MAX_BYTES)
          return yield* refuse(
            `${shown} grew past ${PROOF_ARTEFACT_MAX_BYTES} bytes while it was being read.`,
          );
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks) as Uint8Array;
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(refuse(`${shown} could not be read: ${cause.message}.`)),
    ),
  );

/** Reads the artefact a file or text names, refusing what a record cannot keep. */
const artefactBytes = (
  repository: string,
  input: ProofInput,
  mask: (text: string) => string,
) =>
  Effect.gen(function* () {
    if (input.text !== undefined)
      return new TextEncoder().encode(mask(input.text));
    const real = yield* admitArtefactPath(repository, input.file!);
    return yield* readAdmitted(real, input.file!);
  });

/**
 * The recorder's working tree now: the commit checked out and whether tracked files differ from it,
 * among `ownedPaths` when given, else anywhere in the tracked tree. Read with `git status`, which
 * takes no optional locks, so recording never writes the index.
 */
export const worktreeState = (
  repository: string,
  ownedPaths: ReadonlyArray<string> | undefined,
) =>
  Effect.gen(function* () {
    const head = (yield* gitOk(repository, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])).trim();
    const out = yield* gitOk(repository, [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
    ]);
    const changed = new Set<string>();
    const tokens = out.split("\0");
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.length < 4) continue;
      changed.add(token.slice(3));
      // A rename or copy is followed by its original path.
      if (token[0] === "R" || token[0] === "C") {
        index += 1;
        const original = tokens[index];
        if (original !== undefined && original !== "") changed.add(original);
      }
    }
    return {
      head,
      scope: ownedPaths === undefined ? "tracked-tree" : "owned-paths",
      dirty:
        ownedPaths === undefined
          ? changed.size > 0
          : ownedPaths.some((path) => changed.has(path)),
    } satisfies ProofWorktree;
  });

/**
 * Records one proof. The range and revision are resolved to commits, and the revision must be the
 * head or in its history, so a record always names a commit its range can reach. The artefact is
 * stored first as a raw capture (8.10), then the event is appended; a second identical record from
 * the same recorder is answered `existing`. An append that fails after the store leaves an artefact
 * no record names, which retention prunes after 30 days.
 */
export const record = (request: RecordRequest) =>
  Effect.gen(function* () {
    const { input } = request;
    const range = yield* resolveRange(request.repository, input.range);
    let revision = range.headOid;
    if (input.revision !== undefined) {
      const named = yield* commitOf(request.repository, input.revision);
      if (Option.isNone(named))
        return yield* new ProofRefused({
          message: `${input.revision} names no commit in this repository.`,
        });
      revision = named.value;
    }
    if (!(yield* isAncestor(request.repository, revision, range.headOid)))
      return yield* new ProofRefused({
        message: `${revision.slice(0, 12)} is not the range's head or in its history, so this range cannot use it.`,
      });
    const mediaType = mediaTypeOf(input);
    if (mediaType === undefined || !mediaTypeFits(input.kind, mediaType))
      return yield* new ProofRefused({
        message: `A ${input.kind} artefact is one of ${PROOF_MEDIA_TYPES[input.kind].join(", ")}${mediaType === undefined ? "; give mediaType, since the file's extension does not say it" : `, not ${mediaType}`}.`,
      });
    const bytes = yield* artefactBytes(request.repository, input, request.mask);
    const worktree = yield* worktreeState(request.repository, input.ownedPaths);
    if (bytes.byteLength === 0)
      return yield* new ProofRefused({ message: "The artefact is empty." });
    const payload = ProofPayload.safeParse({
      kind: input.kind,
      revision,
      claim: request.mask(input.claim),
      requirement: {
        text: request.mask(input.requirement),
        ...(input.scopeItem === undefined
          ? {}
          : { scopeItem: input.scopeItem }),
      },
      artefact: { mediaType, bytes: bytes.byteLength },
      worktree,
    });
    if (!payload.success)
      return yield* new ProofRefused({
        message: `Not recorded: ${payload.error.issues.map((issue) => issue.message).join("; ")}.`,
      });
    const blobs = yield* BlobStore;
    const stored = yield* blobs.put({
      bytes,
      mediaType,
      retention: "raw-capture",
    });
    const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const identity = sha256Hex(
      canonicalJson({
        payload: payload.data,
        range,
        artefact: stored.blob.hash,
      }),
    );
    const [appended] = yield* Log.append([
      {
        id: mintUlid(),
        kind: "proof.recorded@1",
        idempotencyKey: `proof:${request.actorId}:${identity}`,
        actor: request.actorId,
        occurredAt,
        attribution: {
          range,
          sessionId: request.sessionId,
          ...(request.turnKey === undefined
            ? {}
            : { turnKey: request.turnKey }),
          ...(request.cycleId === undefined
            ? {}
            : { cycleId: request.cycleId }),
        },
        refs: [{ ref: `blob:${stored.blob.hash}`, role: "artefact" }],
        payload: payload.data,
      },
    ]);
    if (appended === undefined)
      return yield* new CorruptRecord({
        message: "the proof's append returned nothing",
      });
    return {
      status: appended.status === "appended" ? "recorded" : "existing",
      id: appended.id,
      seq: appended.seq,
      range,
      revision,
      kind: input.kind,
      worktree,
      artefact: {
        hash: stored.blob.hash,
        mediaType,
        bytes: bytes.byteLength,
        retention: stored.blob.retention,
      },
    } satisfies RecordResult;
  });

/**
 * What `neuve proof record` and the MCP `record_proof` tool do: tie the call to its agent session
 * (D23, as vents do), then record. With no session, or more than one, nothing is recorded.
 */
export type CallerRecordResult =
  | (RecordResult & {
      readonly caller: Extract<CallerResolution, { _tag: "Linked" }>;
    })
  | {
      readonly status: "unlinked";
      readonly caller: Exclude<CallerResolution, { _tag: "Linked" }>;
    };

export const recordAsCaller = (
  location: StoreLocation,
  options: {
    readonly repository: string;
    readonly input: ProofInput;
    /** See `RecordRequest.mask`. */
    readonly mask: (text: string) => string;
    readonly override?: string | undefined;
    readonly cycleId?: string | undefined;
    readonly environment?:
      Readonly<Record<string, string | undefined>> | undefined;
  },
) =>
  Effect.gen(function* () {
    const caller = yield* resolveCaller(location, {
      override: options.override,
      environment: options.environment,
    });
    if (caller._tag !== "Linked")
      return { status: "unlinked", caller } satisfies CallerRecordResult;
    const open =
      caller.subagentId === undefined
        ? yield* readSession(location, caller.harness, caller.sessionId)
        : yield* readSubagent(
            location,
            caller.harness,
            caller.sessionId,
            caller.subagentId,
          );
    const result = yield* record({
      repository: options.repository,
      actorId: caller.actorId,
      sessionId: caller.sessionId,
      turnKey: open?.turnKey,
      cycleId: options.cycleId,
      input: options.input,
      mask: options.mask,
    });
    return { ...result, caller } satisfies CallerRecordResult;
  });

/** The reply both surfaces give, as one sentence. */
export const describeRecord = (result: CallerRecordResult) => {
  if (result.status === "unlinked")
    switch (result.caller._tag) {
      case "Ambiguous":
        return `Not recorded: this call belongs to more than one live agent session (${result.caller.sessionIds.join(", ")}), and none is chosen.`;
      case "Unavailable":
        return "Not recorded: the process table cannot be read here, and no session ID set by a supported harness names a live session here, so this call is not linked to an agent session.";
      case "None":
        return "Not recorded: no live agent session recorded in this repository owns this process.";
    }
  const what = `${result.kind} proof at ${result.revision.slice(0, 12)} (${result.artefact.mediaType}, ${result.artefact.bytes} bytes; ${describeWorktree(result.worktree, result.revision)})`;
  return result.status === "recorded"
    ? `Proof recorded (${result.id}): ${what} for ${result.caller.harness} session ${result.caller.sessionId}. Its artefact is kept 30 days unless a published review cites it.`
    : `You already recorded this proof (${result.id}); nothing new was written.`;
};

/** The recorder's working tree in a few words: dirty or clean, and a head other than the revision. */
export const describeWorktree = (worktree: ProofWorktree, revision: string) =>
  `recorded from a ${worktree.dirty ? "dirty" : "clean"} ${worktree.scope === "owned-paths" ? "set of owned paths" : "tracked tree"}${worktree.head === revision ? "" : ` with ${worktree.head.slice(0, 12)} checked out`}`;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export interface ProofRecordView {
  readonly id: string;
  readonly recordedAt: string;
  readonly kind: ProofKind;
  readonly revision: string;
  readonly range: Range;
  readonly cycleId: string | null;
  readonly claim: string;
  readonly requirement: {
    readonly text: string;
    readonly scopeItem: string | null;
  };
  /** The recorder's working tree when it recorded (dirty tracked files, the commit checked out). */
  readonly worktree: ProofWorktree;
  /** Who recorded it (M2's identity): weigh an implementer's own proof with 10.63's skepticism. */
  readonly recorder: {
    readonly actorId: string;
    readonly alias: string;
    readonly harness: string | null;
    readonly sessionId: string;
    readonly subagent: boolean;
    readonly agentType: string | null;
  };
  readonly artefact: {
    readonly hash: string;
    readonly mediaType: string;
    readonly bytes: number;
    readonly retention: BlobRetention | null;
    /** Set once retention pruned the bytes; the record stays. */
    readonly prunedAt: string | null;
  };
}

interface Row {
  readonly seq: number;
  readonly recordedAt: string;
  readonly envelope: string;
  readonly alias: string | null;
  readonly harness: string | null;
  readonly subagentId: string | null;
  readonly agentType: string | null;
  readonly retention: BlobRetention | null;
  readonly prunedAt: string | null;
}

const viewOf = (row: Row) =>
  Effect.gen(function* () {
    const event = yield* decodeEnvelope(row.envelope, `event seq ${row.seq}`);
    if (event.kind !== "proof.recorded@1")
      return yield* new CorruptRecord({
        message: `event seq ${row.seq} is indexed as a proof but holds ${event.kind}`,
      });
    const p = event.payload;
    return {
      id: event.id,
      recordedAt: row.recordedAt,
      kind: p.kind,
      revision: p.revision,
      range: event.attribution.range,
      cycleId: event.attribution.cycleId ?? null,
      claim: p.claim,
      requirement: {
        text: p.requirement.text,
        scopeItem: p.requirement.scopeItem ?? null,
      },
      worktree: p.worktree,
      recorder: {
        actorId: event.actor,
        alias: row.alias ?? baseAlias(event.actor),
        harness: row.harness,
        sessionId: event.attribution.sessionId,
        subagent: row.subagentId !== null,
        agentType: row.agentType,
      },
      artefact: {
        hash: event.refs[0].ref.slice("blob:".length),
        mediaType: p.artefact.mediaType,
        bytes: p.artefact.bytes,
        retention: row.retention,
        prunedAt: row.prunedAt,
      },
    } satisfies ProofRecordView;
  });

const SELECT = `SELECT e.seq, e.recorded_at, e.envelope, a.alias, a.harness, a.subagent_id,
    a.agent_type, b.retention, b.pruned_at
  FROM projection_proofs p JOIN events e ON e.id = p.event_id
  LEFT JOIN projection_actors a ON a.actor_id = p.actor_id
  LEFT JOIN blobs b ON b.hash = p.artefact_hash`;

/** One proof record by its event ID. */
export const get = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const [row] = yield* sql.unsafe<Row>(`${SELECT} WHERE p.event_id = ?`, [
      id,
    ]);
    return row === undefined
      ? Option.none<ProofRecordView>()
      : Option.some(yield* viewOf(row));
  });

/** A record in a range's listing, with where it sits and, given a unit's paths, its currency. */
export interface ListedProof extends ProofRecordView {
  /** Its commit is the range's head. */
  readonly atHead: boolean;
  /** Its commit is in `base..head`, the range's own commits. */
  readonly inRange: boolean;
  /** Present when owned paths were given (11.10). */
  readonly currency: Currency | null;
}

export interface RangeProofs {
  readonly range: Range;
  readonly ownedPaths: ReadonlyArray<string> | null;
  readonly records: ReadonlyArray<ListedProof>;
  /** True when more than `LIST_MAX` records match; the newest are listed. */
  readonly truncated: boolean;
}

/**
 * The proof records for a range: every record whose commit is in `base..head`, and every record
 * recorded for the same base, which includes records from commits since rewritten away (shown
 * stale, never dropped). Newest first, at most `LIST_MAX`, so a long history never hides the newest. With `ownedPaths`, each record carries
 * its currency for a unit owning those paths.
 */
export const list = (options: {
  readonly repository: string;
  readonly range: Range;
  readonly ownedPaths?: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* assertCompatible;
    const { range } = options;
    const out = yield* gitOk(options.repository, [
      "rev-list",
      `--max-count=${RANGE_COMMITS_MAX + 1}`,
      `${range.baseOid}..${range.headOid}`,
    ]);
    const commits = out.split("\n").filter((line) => line !== "");
    if (commits.length > RANGE_COMMITS_MAX)
      return yield* new ProofRefused({
        message: `The range has more than ${RANGE_COMMITS_MAX} commits; list a shorter one.`,
      });
    const inRange = new Set(commits);
    const ids = new Set<string>();
    const sameBase = yield* sql<{
      eventId: string;
    }>`SELECT event_id FROM projection_proofs WHERE base_oid = ${range.baseOid}`;
    for (const row of sameBase) ids.add(row.eventId);
    for (let index = 0; index < commits.length; index += 500) {
      const page = commits.slice(index, index + 500);
      const rows = yield* sql<{
        eventId: string;
      }>`SELECT event_id FROM projection_proofs WHERE ${sql.in("revision", page)}`;
      for (const row of rows) ids.add(row.eventId);
    }
    // ULIDs sort by time: newest first.
    const ordered = [...ids].sort().reverse();
    const chosen = ordered.slice(0, LIST_MAX);
    const check =
      options.ownedPaths === undefined
        ? undefined
        : currencyChecker({
            repository: options.repository,
            headOid: range.headOid,
          });
    const records: Array<ListedProof> = [];
    for (let index = 0; index < chosen.length; index += 500) {
      const page = chosen.slice(index, index + 500);
      const rows = yield* sql.unsafe<Row>(
        `${SELECT} WHERE p.event_id IN (${page.map(() => "?").join(", ")}) ORDER BY p.event_id DESC`,
        page,
      );
      for (const row of rows) {
        const view = yield* viewOf(row);
        records.push({
          ...view,
          atHead: view.revision === range.headOid,
          inRange: inRange.has(view.revision),
          currency:
            check === undefined
              ? null
              : yield* check(view.revision, options.ownedPaths!),
        });
      }
    }
    return {
      range,
      ownedPaths: options.ownedPaths ?? null,
      records,
      truncated: ordered.length > LIST_MAX,
    } satisfies RangeProofs;
  });

/** How many listed records are current and stale, by reason; null without owned paths. */
export const currencyCounts = (proofs: RangeProofs) => {
  if (proofs.ownedPaths === null) return null;
  const counts = {
    current: 0,
    stale: 0,
    changedAfter: 0,
    notInHistory: 0,
    unknownRevision: 0,
  };
  for (const record of proofs.records) {
    const currency = record.currency;
    if (currency === null || currency.status === "current") {
      counts.current += 1;
      continue;
    }
    counts.stale += 1;
    if (currency.reason === "changed-after") counts.changedAfter += 1;
    else if (currency.reason === "not-in-history") counts.notInHistory += 1;
    else counts.unknownRevision += 1;
  }
  return counts;
};

/**
 * An artefact's text, for kinds whose artefact is text; none for images and video, or once
 * retention pruned the bytes.
 */
export const artefactText = (view: ProofRecordView) =>
  Effect.gen(function* () {
    if (
      view.artefact.mediaType.startsWith("image/") ||
      view.artefact.mediaType.startsWith("video/")
    )
      return Option.none<string>();
    const read = yield* (yield* BlobStore).get(view.artefact.hash);
    return read._tag === "Pruned"
      ? Option.none<string>()
      : Option.some(new TextDecoder().decode(read.bytes));
  });

// ---------------------------------------------------------------------------------------------
// Retention (8.10; proposal §10.2)
// ---------------------------------------------------------------------------------------------

export interface Promotion {
  readonly id: string;
  /** `not-a-proof`: no proof record has this ID. Otherwise what promoting its artefact found. */
  readonly result: PromoteResult | "not-a-proof";
  readonly hash: string | null;
}

/**
 * Promotes the artefacts of the proof records a published packet cites from raw capture to durable,
 * because re-reviews reuse them (4.7, 10.68). Publish calls this (slice H8 wires it). Idempotent:
 * promoting again answers `durable`. An artefact retention already pruned stays pruned and says so;
 * its record stays. Uncited artefacts keep the raw-capture retention.
 */
export const promoteCited = (proofIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const blobs = yield* BlobStore;
    const promotions: Array<Promotion> = [];
    for (const id of new Set(proofIds)) {
      const [row] = yield* sql<{
        artefactHash: string;
      }>`SELECT artefact_hash FROM projection_proofs WHERE event_id = ${id}`;
      if (row === undefined) {
        promotions.push({ id, result: "not-a-proof", hash: null });
        continue;
      }
      promotions.push({
        id,
        result: yield* blobs.promote(row.artefactHash),
        hash: row.artefactHash,
      });
    }
    return promotions as ReadonlyArray<Promotion>;
  });
