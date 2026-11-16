import { z } from "zod";

/**
 * The replay dataset's records (design §1–§6, 10.128). A case's `case.json` holds what the harness
 * may see (the first revision) beside what only the evaluator may see (later revisions and the
 * outcome); the harness never reads it, since its runs read only git objects of the case clone.
 */

export const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const CapturedFile = z.strictObject({
  name: z.string().min(1),
  bytes: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The revision the first review saw: the replay's whole input boundary. */
export const FirstRevision = z.strictObject({
  head: Sha,
  base: Sha,
  /** When a reviewer could first see it: patchset 1's upload, or the first review's time. */
  at: z.iso.datetime({ offset: true }),
  how: z.enum([
    "gerrit-patchset-1",
    "first-review-commit",
    "pull-request-head-at-open",
  ]),
  /** How the base was found. */
  baseFrom: z.enum([
    "gerrit-parent",
    "ghstack-parent",
    "merge-base",
    "stacked-parent",
  ]),
});

/** Evaluator-only: what came after the first revision. None of it may exist in the case clone. */
export const Later = z.strictObject({
  finalHead: Sha.nullable(),
  merged: Sha.nullable(),
  /** Every later revision's commit: Gerrit patchsets after 1, pull-request commits not in the first. */
  revisions: z.array(Sha),
});

export const LeakageChecks = z.strictObject({
  passed: z.boolean(),
  headIsFirstRevision: z.boolean(),
  worktreeClean: z.boolean(),
  onlyReplayRef: z.boolean(),
  noRemote: z.boolean(),
  baseIsAncestor: z.boolean(),
  noStore: z.boolean(),
  /** Later commits found in the clone: must be empty. */
  laterPresent: z.array(Sha),
  laterChecked: z.int().min(0),
  /** Objects in the clone that HEAD does not reach (dangling, fetched or planted): must be 0. */
  unreachableObjects: z.int().min(0),
  /** Reflog entries under `.git/logs`, which can keep later commits alive: must be 0. */
  reflogEntries: z.int().min(0),
  /** FETCH_HEAD, ORIG_HEAD and the like, which can name later commits: must be empty. */
  transientHeads: z.array(z.string()),
  /**
   * The clone's own config holds only the keys a fresh clone writes (`CLONE_CONFIG_KEYS`): no remote
   * or branch that could fetch the future, and nothing that runs a command, such as core.fsmonitor,
   * core.hooksPath, core.sshCommand, core.editor, core.pager, a filter or an include.
   */
  configOnlyCloneKeys: z.boolean(),
  /** Entries in `.git` beyond a fresh clone's (a nested repository, worktrees, shallow): must be empty. */
  unexpectedGitEntries: z.array(z.string()),
  /** Symlinks anywhere in the clone, `.git` included, that resolve outside it: must be empty. */
  escapingSymlinks: z.array(z.string()),
  /** The newest committer date over every commit HEAD reaches. */
  newestCommitAt: z.iso.datetime({ offset: true }),
  newestCommitNotAfterFirstRevision: z.boolean(),
  checkedAt: z.iso.datetime({ offset: true }),
});

export const CaseRecord = z.strictObject({
  version: z.literal(1),
  caseId: z.string().min(1),
  source: z.string().min(1),
  provider: z.enum(["gerrit", "github"]),
  number: z.int().min(1),
  title: z.string(),
  url: z.url(),
  author: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  outcome: z.enum(["merged", "abandoned", "closed"]),
  /** Stacks and relands share a family, which never straddles the held-out split. */
  family: z.string().min(1),
  split: z.enum(["development", "held-out", "pilot"]),
  era: z.enum(["pre-2022", "2024-2025", "2026"]),
  control: z.enum(["quiet", "abandoned", "reverted", "mechanical"]).nullable(),
  selection: z.strictObject({
    score: z.number(),
    reasons: z.array(z.string()),
  }),
  firstRevision: FirstRevision.nullable(),
  later: Later.nullable(),
  size: z
    .strictObject({
      files: z.int().min(0),
      insertions: z.int().min(0),
      deletions: z.int().min(0),
    })
    .nullable(),
  capture: z.strictObject({
    at: z.iso.datetime({ offset: true }),
    files: z.array(CapturedFile),
  }),
  clone: z
    .strictObject({ path: z.string().min(1), preparedAt: z.string() })
    .nullable(),
  checks: LeakageChecks.nullable(),
  /** Why a case was dropped before its run, when it was. */
  unavailable: z.string().nullable(),
});
export type CaseRecord = z.infer<typeof CaseRecord>;
