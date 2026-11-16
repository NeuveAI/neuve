import {
  GitReadNonBlobEntry,
  GitReadRefusal,
  gitReadText,
  preflightLocalGitRead,
  qualifyLocalGitRead,
  readQualifiedGitBlob,
  recheckLocalGitRead,
  runQualifiedGit,
} from "@neuve/graph-client";
import type { GitReadObservation, QualifiedGitRead } from "@neuve/graph-client";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PublicQueryResult, PublicRange } from "./domain.ts";
import type { QuerySourceContext } from "./graph-query.ts";

export type SourceEvidence = Readonly<{
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  blob_oid: string;
  revision: string;
}>;
export type SourceEvidenceLimitation = Omit<
  SourceEvidence,
  "text" | "blob_oid" | "revision"
> &
  Readonly<{
    reason:
      | "invalid-source-location"
      | "file-too-large"
      | "blob-unavailable"
      | "non-utf8-source"
      | "range-unavailable"
      | "source-budget-exhausted";
  }>;

const maximumBlobBytes = 1024 * 1024;
const cleanRefusal = (cause: GitReadRefusal) =>
  cause.cause === undefined &&
  cause.observerFailures.length === 0 &&
  cause.cleanupFailures.length === 0;
const copyObservation = (value: GitReadObservation): GitReadObservation =>
  Object.freeze({
    ...value,
    argv: Object.freeze([...value.argv]),
    termination: Object.freeze({ ...value.termination }),
    stdout: value.stdout === null ? null : Object.freeze({ ...value.stdout }),
    stderr: value.stderr === null ? null : Object.freeze({ ...value.stderr }),
  });
const observedOversize = (
  cause: GitReadRefusal,
  observations: readonly GitReadObservation[],
  signal: AbortSignal,
) => {
  const bodies = observations.filter((value) => value.command === "blob-body");
  if (
    signal.aborted ||
    !cleanRefusal(cause) ||
    cause.reason !== "command" ||
    cause.detail !== "output-bound" ||
    observations.length !== 3 ||
    observations[0]?.command !== "exact-commit" ||
    observations[1]?.command !== "source-entry" ||
    bodies.length !== 1
  )
    return false;
  for (const prior of observations.slice(0, 2))
    if (
      prior.refusal !== null ||
      prior.termination.kind !== "exit" ||
      prior.termination.code !== 0 ||
      prior.stdout === null ||
      prior.stderr === null ||
      !prior.stdout.complete ||
      !prior.stderr.complete
    )
      return false;
  const body = bodies[0];
  if (
    body === undefined ||
    body.refusal !== "output-bound" ||
    body.pid === null ||
    !Number.isSafeInteger(body.pid) ||
    body.pid <= 0 ||
    !(
      (body.termination.kind === "exit" && body.termination.code === 0) ||
      (body.termination.kind === "signal" &&
        body.termination.signal === "SIGKILL")
    )
  )
    return false;
  const stdout = body.stdout,
    stderr = body.stderr;
  return (
    stdout !== null &&
    stderr !== null &&
    Number.isSafeInteger(stdout.byteLength) &&
    stdout.byteLength > maximumBlobBytes &&
    Number.isSafeInteger(stdout.retainedByteLength) &&
    stdout.retainedByteLength >= 0 &&
    stdout.retainedByteLength <= maximumBlobBytes &&
    stdout.retainedByteLength <= stdout.byteLength &&
    Number.isSafeInteger(stderr.byteLength) &&
    stderr.byteLength >= 0 &&
    stderr.byteLength <= maximumBlobBytes &&
    Number.isSafeInteger(stderr.retainedByteLength) &&
    stderr.retainedByteLength >= 0 &&
    stderr.retainedByteLength <= stderr.byteLength
  );
};
const validRange = (range: PublicRange) =>
  !isAbsolute(range.path) &&
  !range.path.includes("\0") &&
  range.path.length > 0 &&
  !range.path.split(/[\\/]/).includes("..") &&
  !range.path.split("/").some((part) => part === "" || part === ".") &&
  Number.isSafeInteger(range.start_line) &&
  range.start_line > 0 &&
  Number.isSafeInteger(range.end_line) &&
  range.end_line >= range.start_line;

// Query callers need readable evidence. This reads committed Git blobs behind
// normalized candidates, independently of Graph's internal query receipts.
export const collectSourceEvidence = async (
  result: PublicQueryResult,
  budget: number,
  signal: AbortSignal,
  context: QuerySourceContext,
) => {
  const source_evidence: SourceEvidence[] = [];
  const source_evidence_limitations: SourceEvidenceLimitation[] = [];
  let returnedBytes = 0;
  const ranges =
    result.retrieval.status === "ok"
      ? result.retrieval.candidates.map((candidate) => candidate.source)
      : [];
  if (ranges.length > 0 && result.retrieval.status === "ok") {
    signal.throwIfAborted();
    if (
      !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(context.request.revision) ||
      result.source.revision !== context.request.revision.toLowerCase() ||
      result.query !== context.request.question ||
      (await realpath(result.source.repository)) !==
        (await realpath(context.request.repository))
    )
      throw new Error(
        "Source evidence does not match the intended query source.",
      );
    signal.throwIfAborted();
    if (
      context.request.cache === "prepared" &&
      result.retrieval.prepared_read === undefined
    )
      throw new Error(
        "Source evidence requires the selected prepared attribution.",
      );
    if (
      result.retrieval.prepared_read !== undefined &&
      result.retrieval.profile !== (context.request.profile ?? "full")
    )
      throw new Error(
        "Source evidence does not match the intended prepared profile.",
      );
    signal.throwIfAborted();
  }
  let qualifiedGit: QualifiedGitRead | undefined;
  const admittedGit = async () => {
    if (qualifiedGit !== undefined) return qualifiedGit;
    const git = await qualifyLocalGitRead(
      await preflightLocalGitRead({
        repository: result.source.repository,
        signal,
      }),
      { signal },
    );
    const intendedWorkdir = await realpath(context.request.repository);
    const normalizedWorkdir = await realpath(result.source.repository);
    const prefix = gitReadText(
      await runQualifiedGit(
        git,
        { kind: "owner", field: "--show-prefix" },
        { signal },
      ),
    ).replace(/\/$/, "");
    // The revision must name a readable commit tree in the admitted scope.
    gitReadText(
      await runQualifiedGit(
        git,
        { kind: "exact-tree", oid: result.source.revision },
        { signal },
      ),
    );
    signal.throwIfAborted();
    if (
      git.scope.workdir !== intendedWorkdir ||
      git.scope.workdir !== normalizedWorkdir
    )
      throw new Error(
        "Source evidence does not match the admitted Git workdir.",
      );
    const prepared =
      result.retrieval.status === "ok"
        ? result.retrieval.prepared_read
        : undefined;
    if (
      prepared !== undefined &&
      (prepared.source.common_dir !== git.scope.gitCommonDirectory ||
        prepared.source.scope !== prefix)
    )
      throw new Error(
        "Source evidence does not match the admitted prepared Git scope.",
      );
    qualifiedGit = git;
    return git;
  };
  const seen = new Set<string>();
  for (const range of ranges) {
    signal.throwIfAborted();
    const identity = JSON.stringify([
      range.path,
      range.start_line,
      range.end_line,
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const location = {
      path: range.path,
      start_line: range.start_line,
      end_line: range.end_line,
    };
    const omit = (reason: SourceEvidenceLimitation["reason"]) => {
      source_evidence_limitations.push({ ...location, reason });
    };
    if (
      !validRange(range) ||
      !/^[a-fA-F0-9]{7,64}$/.test(result.source.revision)
    ) {
      omit("invalid-source-location");
      continue;
    }
    if (returnedBytes >= budget) {
      omit("source-budget-exhausted");
      continue;
    }
    let blob:
      { oid: string; text: string } | SourceEvidenceLimitation["reason"];
    const source = Object.freeze({
      commit: result.source.revision,
      path: range.path,
    });
    const observations: GitReadObservation[] = [];
    try {
      const git = await admittedGit();
      const acquired = await readQualifiedGitBlob(
        git,
        source,
        {
          signal,
          onObservation: (value) => {
            observations.push(copyObservation(value));
          },
        },
        maximumBlobBytes,
      );
      signal.throwIfAborted();
      try {
        blob = {
          oid: acquired.oid,
          text: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(acquired.bytes),
        };
      } catch {
        blob = "non-utf8-source";
      }
    } catch (cause) {
      if (!(cause instanceof GitReadRefusal)) throw cause;
      if (cleanRefusal(cause) && cause.reason === "cancelled" && signal.aborted)
        signal.throwIfAborted();
      if (signal.aborted) throw cause;
      if (
        cleanRefusal(cause) &&
        cause.reason === "command" &&
        cause.detail === "source-entry-missing"
      )
        blob = "blob-unavailable";
      else if (
        cause instanceof GitReadNonBlobEntry &&
        cleanRefusal(cause) &&
        cause.entry.commit === source.commit &&
        cause.entry.path === source.path
      )
        blob = "blob-unavailable";
      else if (observedOversize(cause, observations, signal))
        blob = "file-too-large";
      else throw cause;
    }
    if (typeof blob === "string") {
      omit(blob);
      continue;
    }
    const lines = blob.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (range.end_line > lines.length) {
      omit("range-unavailable");
      continue;
    }
    const text = lines.slice(range.start_line - 1, range.end_line).join("");
    const bytes = Buffer.byteLength(text);
    if (returnedBytes + bytes > budget) {
      omit("source-budget-exhausted");
      continue;
    }
    source_evidence.push({
      ...location,
      text,
      blob_oid: blob.oid,
      revision: source.commit,
    });
    returnedBytes += bytes;
  }
  if (qualifiedGit !== undefined)
    await recheckLocalGitRead(qualifiedGit, { signal });
  signal.throwIfAborted();
  return {
    source_evidence,
    source_evidence_limitations,
    source_evidence_budget: {
      requested_bytes: budget,
      returned_bytes: returnedBytes,
    },
  };
};
