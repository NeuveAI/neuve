import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { captureGerrit, gerritRevisions, gerritTime } from "./gerrit.ts";
import { captureGithub, firstReviewedCommit, namedCommits } from "./github.ts";
import { git, github, run } from "./providers.ts";
import {
  CaseRecord,
  LeakageChecks,
  type CaseRecord as Case,
} from "./schema.ts";
import {
  SIZE,
  SOURCES,
  caseDirectory,
  mirrorPath,
  type Source,
  type SourceName,
} from "./sources.ts";

/**
 * Preparing a case (design §2, §6): capture the provider record, find the first revision, fetch
 * what it needs into the source's bare mirror, and build the case clone that holds nothing after
 * it. The clone is `git clone --no-local --single-branch` from a ref at the first head, so only that
 * head's ancestors are copied; the leakage checks then prove it before any review runs.
 */

/** The source's bare mirror, cloned once; later fetches add only the refs a case needs. */
export const ensureMirror = (source: Source) => {
  const path = mirrorPath(source);
  if (!existsSync(path)) {
    mkdirSync(join(path, ".."), { recursive: true });
    run(["git", "clone", "--bare", "--quiet", source.git, path]);
  }
  return path;
};

const present = (repository: string, sha: string) =>
  git(repository, ["cat-file", "-e", `${sha}^{commit}`], true).code === 0;

const isAncestor = (repository: string, ancestor: string, of: string) =>
  git(repository, ["merge-base", "--is-ancestor", ancestor, of], true).code ===
  0;

/** Fetches commits by SHA into the mirror; GitHub serves any commit of the repository's network. */
const fetchShas = (mirror: string, shas: ReadonlyArray<string>) => {
  const missing = shas.filter((sha) => !present(mirror, sha));
  for (let at = 0; at < missing.length; at += 50) {
    const batch = missing.slice(at, at + 50);
    // One unfetchable SHA fails its whole batch, so a failed batch is fetched one SHA at a time.
    if (git(mirror, ["fetch", "--quiet", "origin", ...batch], true).code !== 0)
      for (const sha of batch)
        git(mirror, ["fetch", "--quiet", "origin", sha], true);
  }
  return shas.filter((sha) => !present(mirror, sha));
};

/**
 * A ghstack pull request's base at one of its head commits. ghstack appends an "Update" commit per
 * revision; when the stack below moved, that commit's second parent is the new base commit. So the
 * base a reviewer saw at a head is the second parent of the latest two-parent commit up to it, or
 * the first commit's parent when the base never moved. The base branch itself is deleted on landing.
 */
export const ghstackBase = (
  commits: ReadonlyArray<{
    readonly sha: string;
    readonly parents: ReadonlyArray<{ readonly sha: string }>;
  }>,
  head: string,
) => {
  const upTo = commits.findIndex((commit) => commit.sha === head);
  if (upTo === -1) return null;
  for (let at = upTo; at > 0; at--)
    if (commits[at]!.parents.length === 2) return commits[at]!.parents[1]!.sha;
  return commits[0]!.parents[0]?.sha ?? null;
};

/**
 * Where the pull request forked from its target: the merge base with the target as the pull request
 * recorded it, else with the target before the merge. Never the head itself: a head that was merged
 * by a merge commit is an ancestor of today's branch, so a merge base with today's tip is empty.
 */
const forkPoint = (
  mirror: string,
  head: string,
  targets: ReadonlyArray<string>,
) => {
  for (const target of targets) {
    const found = git(mirror, ["merge-base", head, target], true);
    const base = found.stdout.trim();
    if (found.code === 0 && base !== "" && base !== head) return base;
  }
  return null;
};

/**
 * A GitHub pull request's first-revision base, in the mirror only: the fork point with the target
 * the pull request recorded (or the target before its merge), or, when the branch forked later than
 * that (rebased onto a newer target before its first review), the fork point with the target's tip
 * just before the first revision, by committer date along its first-parent history. The later one
 * is taken only when it descends from the recorded one, so a target rewritten since (force-pushed)
 * falls back to the recorded base.
 */
export const githubBase = (
  mirror: string,
  head: string,
  recorded: ReadonlyArray<string>,
  targetRef: string,
  at: string,
) => {
  const base = forkPoint(mirror, head, recorded);
  const tip = git(
    mirror,
    [
      "rev-list",
      "-1",
      "--first-parent",
      `--before=${at}`,
      `refs/heads/${targetRef}`,
    ],
    true,
  ).stdout.trim();
  if (base === null || tip === "") return base;
  const later = forkPoint(mirror, head, [tip]);
  return later !== null && later !== base && isAncestor(mirror, base, later)
    ? later
    : base;
};

/** Each commit's patch-id (`git patch-id --stable`), which survives a rebase that keeps its diff. */
const patchIds = (mirror: string, args: ReadonlyArray<string>) => {
  const log = Bun.spawnSync(
    ["git", "-C", mirror, "log", "-p", "--no-color", ...args],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const ids = Bun.spawnSync(["git", "-C", mirror, "patch-id", "--stable"], {
    stdin: log.stdout,
    stdout: "pipe",
    stderr: "ignore",
  });
  const byCommit = new Map<string, string>();
  for (const line of ids.stdout.toString().split("\n")) {
    const [patch, commit] = line.split(" ");
    if (patch && commit) byCommit.set(commit, patch);
  }
  return byCommit;
};

/**
 * A stacked branch's base. When the first revision sits on commits of another, then-unmerged pull
 * request, the range from the fork holds commits that are not this pull request's. Its own commits
 * are known by SHA or by patch-id against the pull request's final commits (a rebase changes a
 * SHA, not a patch). Walking the range's first-parent chain down from the head, the topmost run of
 * its own commits ends at the first commit that is not recognisably its own. That commit may be
 * another pull request's (stacked) or its own, amended or squashed later (entire-cli 1529's first
 * commit), so the base moves to the parent of the run's bottom only when the provider links that
 * commit to a different pull request (`linkedPulls`); otherwise it stays and the result says it is
 * unverified, for the report, as it does when none of its own commits can be found at all. A range
 * of only its own commits keeps its base. Nothing is guessed. The commits are read in the mirror.
 */
export const stackedBase = (
  mirror: string,
  base: string,
  head: string,
  ownCommits: ReadonlyArray<string>,
  number: number,
  linkedPulls: (sha: string) => ReadonlyArray<number>,
): {
  readonly base: string;
  /** Why the base could not be verified, for the case's record; null when it was. */
  readonly unverified: string | null;
} => {
  const chain = git(mirror, [
    "log",
    "--first-parent",
    "--format=%H %P",
    `${base}..${head}`,
  ])
    .stdout.split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha, parent] = line.split(" ");
      return { sha: sha!, parent: parent! };
    });
  const own = new Set(ownCommits);
  const ownPatches = new Set(
    patchIds(mirror, [
      "--no-walk",
      ...ownCommits.filter((sha) => present(mirror, sha)),
    ]).values(),
  );
  const rangePatches = patchIds(mirror, ["--first-parent", `${base}..${head}`]);
  const isOwn = (sha: string) =>
    own.has(sha) || ownPatches.has(rangePatches.get(sha) ?? "\0");
  if (!chain.some((commit) => isOwn(commit.sha)))
    return {
      base,
      unverified:
        chain.length > 0
          ? "none of the pull request's own commits is in its first-revision range"
          : null,
    };
  let bottom = -1;
  while (bottom + 1 < chain.length && isOwn(chain[bottom + 1]!.sha)) bottom++;
  if (bottom === chain.length - 1) return { base, unverified: null };
  if (bottom === -1)
    return {
      base,
      unverified:
        "the commit under its first revision's head is not recognisably its own",
    };
  const below = linkedPulls(chain[bottom + 1]!.sha);
  return below.some((other) => other !== number)
    ? { base: chain[bottom]!.parent, unverified: null }
    : {
        base,
        unverified:
          "its own commits sit on a commit that is not recognisably its own (amended or squashed later?) and no other pull request claims",
      };
};

const eraOf = (createdAt: string): Case["era"] =>
  createdAt < "2022-01-01"
    ? "pre-2022"
    : createdAt < "2026-01-01"
      ? "2024-2025"
      : "2026";

/** Captures a case and finds its first revision; writes `case.json` without a clone yet. */
export const captureCase = async (
  name: SourceName,
  number: number,
  selection: Case["selection"],
  split: Case["split"],
  control: Case["control"] = null,
): Promise<Case> => {
  const source = SOURCES[name];
  const directory = caseDirectory(name, number);
  const captureDirectory = join(directory, "capture");
  mkdirSync(captureDirectory, { recursive: true });
  const mirror = ensureMirror(source);
  const at = new Date().toISOString();
  let record: Case;

  if (source.provider === "gerrit") {
    const { detail, files } = await captureGerrit(
      source,
      number,
      captureDirectory,
    );
    const revisions = gerritRevisions(detail);
    git(mirror, [
      "fetch",
      "--quiet",
      "origin",
      ...[revisions.first, ...revisions.later].map(
        (revision) => `+${revision.ref}:${revision.ref}`,
      ),
    ]);
    // The submitted commit on the branch carries a Reviewed-on trailer naming the change; the
    // grep is a prefix match (".../+/123" also finds ".../+/1234"), so the line is checked whole.
    const url = `https://${source.host}/c/${source.project}/+/${number}`;
    const merged =
      git(mirror, [
        "log",
        "--all",
        "--format=%H",
        "--fixed-strings",
        `--grep=Reviewed-on: ${url}`,
      ])
        .stdout.split("\n")
        .filter((line) => /^[0-9a-f]{40}$/.test(line))
        .find((sha) =>
          git(mirror, ["show", "-s", "--format=%B", sha])
            .stdout.split("\n")
            .some((line) => line.trim() === `Reviewed-on: ${url}`),
        ) ?? null;
    record = {
      version: 1,
      caseId: `gerrit:${source.project}:${number}`,
      source: name,
      provider: "gerrit",
      number,
      title: (detail as { subject: string }).subject,
      url,
      author: String(
        (detail.owner as { username?: string; email?: string }).username ??
          (detail.owner as { email?: string }).email ??
          detail.owner._account_id,
      ),
      createdAt: gerritTime(detail.created),
      outcome: detail.status === "MERGED" ? "merged" : "abandoned",
      family: `gerrit:${source.project}:${number}`,
      split,
      era: eraOf(gerritTime(detail.created)),
      control,
      selection,
      firstRevision: {
        head: revisions.first.head,
        base: revisions.first.base,
        at: revisions.first.at,
        how: "gerrit-patchset-1",
        baseFrom: "gerrit-parent",
      },
      later: {
        finalHead: revisions.current,
        merged,
        revisions: revisions.later.map((revision) => revision.commit),
      },
      size: null,
      capture: { at, files },
      clone: null,
      checks: null,
      unavailable: null,
    };
  } else {
    const captured = captureGithub(source, number, captureDirectory);
    const { pull } = captured;

    const first = firstReviewedCommit(captured.reviews, captured.comments);
    const named = namedCommits(captured);
    const unfetchable = fetchShas(mirror, [...named, pull.base.sha]);
    const ghstack = /^gh\/[^/]+\/\d+\/base$/.test(pull.base.ref);
    let unavailable: string | null = null;
    let firstRevision: Case["firstRevision"] = null;
    let later: Case["later"] = null;
    let stackedUnverified: string | null = null;
    if (first === null) unavailable = "no review names a commit";
    else if (unfetchable.includes(first.commit))
      unavailable = `the first reviewed commit ${first.commit} cannot be fetched`;
    else {
      const head = first.commit;
      const base = ghstack
        ? ghstackBase(captured.commits, head)
        : githubBase(
            mirror,
            head,
            [
              pull.base.sha,
              ...(pull.merge_commit_sha === null
                ? []
                : [`${pull.merge_commit_sha}^1`]),
            ],
            pull.base.ref,
            new Date(first.at).toISOString(),
          );
      const stacked =
        base === null || ghstack
          ? { base, unverified: null }
          : stackedBase(
              mirror,
              base,
              head,
              captured.commits.map((commit) => commit.sha),
              number,
              (sha) =>
                (
                  github(
                    `repos/${source.repo}/commits/${sha}/pulls`,
                  ) as ReadonlyArray<{
                    number: number;
                  }>
                ).map((pull) => pull.number),
            );
      stackedUnverified = stacked.unverified;
      if (base === null) unavailable = `no base found for ${head}`;
      else
        firstRevision = {
          head,
          base: stacked.base ?? base,
          at: new Date(first.at).toISOString(),
          how: "first-review-commit",
          baseFrom: ghstack
            ? "ghstack-parent"
            : stacked.base !== base
              ? "stacked-parent"
              : "merge-base",
        };
      // Later: every commit the record names that the first head does not contain.
      later = {
        finalHead: pull.head.sha,
        merged: pull.merge_commit_sha,
        revisions: named.filter(
          (sha) =>
            sha !== head &&
            !(present(mirror, sha) && isAncestor(mirror, sha, head)),
        ),
      };
    }
    record = {
      version: 1,
      caseId: `github:${source.repo}:${number}`,
      source: name,
      provider: "github",
      number,
      title: pull.title,
      url: `https://github.com/${source.repo}/pull/${number}`,
      author: pull.user.login,
      createdAt: new Date(pull.created_at).toISOString(),
      outcome: pull.merged_at !== null ? "merged" : "closed",
      family: `github:${source.repo}:${ghstack ? `ghstack:${pull.user.login}` : number}`,
      split,
      era: eraOf(pull.created_at),
      control,
      // A base the stacked-branch check could not verify is kept, and said so, for the report.
      selection:
        stackedUnverified !== null
          ? {
              ...selection,
              reasons: [
                ...selection.reasons,
                `base unverified: ${stackedUnverified}`,
              ],
            }
          : selection,
      firstRevision,
      later,
      size: null,
      capture: { at, files: captured.files },
      clone: null,
      checks: null,
      unavailable,
    };
  }
  if (record.firstRevision !== null) {
    const numstat = git(mirror, [
      "diff",
      "--numstat",
      record.firstRevision.base,
      record.firstRevision.head,
    ]).stdout.trim();
    const rows =
      numstat === "" ? [] : numstat.split("\n").map((line) => line.split("\t"));
    record.size = {
      files: rows.length,
      insertions: rows.reduce((sum, row) => sum + (Number(row[0]) || 0), 0),
      deletions: rows.reduce((sum, row) => sum + (Number(row[1]) || 0), 0),
    };
    const lines = record.size.insertions + record.size.deletions;
    if (
      record.size.files > SIZE.maxFiles ||
      lines < SIZE.minLines ||
      lines > SIZE.maxLines
    )
      record.unavailable = `the first revision changes ${lines} lines in ${record.size.files} files`;
  }
  writeCase(record);
  return record;
};

export const writeCase = (record: Case) =>
  writeFileSync(
    join(
      caseDirectory(record.source as SourceName, record.number),
      "case.json",
    ),
    `${JSON.stringify(CaseRecord.parse(record), null, 2)}\n`,
  );

/** A case record; checks recorded under an older check schema read as not yet checked. */
export const readCase = (name: SourceName, number: number) => {
  const raw = JSON.parse(
    readFileSync(join(caseDirectory(name, number), "case.json"), "utf8"),
  ) as Record<string, unknown>;
  return CaseRecord.parse({
    ...raw,
    checks: LeakageChecks.safeParse(raw["checks"]).success
      ? raw["checks"]
      : null,
  });
};

/**
 * Clones `head` and its ancestors only out of `mirror` into `replay`: a temporary branch at the head
 * is cloned with `--no-local --single-branch --no-tags`, so only the objects it reaches are copied,
 * then renamed to `replay`, the remote removed and the reflogs deleted. The mirror keeps no branch.
 */
export const makeReplayClone = (
  mirror: string,
  head: string,
  replay: string,
  branch: string,
) => {
  git(mirror, ["update-ref", `refs/heads/${branch}`, head]);
  try {
    run([
      "git",
      "clone",
      "--quiet",
      "--no-local",
      "--single-branch",
      "--no-tags",
      "--branch",
      branch,
      mirror,
      replay,
    ]);
  } finally {
    git(mirror, ["update-ref", "-d", `refs/heads/${branch}`]);
  }
  git(replay, ["branch", "-q", "-m", branch, "replay"]);
  git(replay, ["remote", "remove", "origin"]);
  // Reflogs name every commit a ref has held; deleting them leaves nothing but HEAD's history.
  rmSync(join(replay, ".git", "logs"), { recursive: true, force: true });
  // A clone can still carry objects HEAD does not reach: the server sends annotated tags that
  // point into the history even with --no-tags, and a tag's date and message can be later than
  // the first revision. Repacking from the one ref and pruning drops everything else.
  git(replay, ["repack", "-a", "-d", "-q"]);
  git(replay, ["prune", "--expire=now"]);
};

/** Builds the case clone at the first head and records the leakage checks (design §6). */
export const cloneCase = (record: Case): Case => {
  if (record.firstRevision === null || record.later === null)
    throw new Error(
      `${record.caseId} has no first revision: ${record.unavailable}`,
    );
  const source = SOURCES[record.source as SourceName];
  const mirror = ensureMirror(source);
  const replay = join(
    caseDirectory(record.source as SourceName, record.number),
    "replay",
  );
  if (existsSync(replay))
    throw new Error(
      `${replay} exists; remove it before preparing the clone again`,
    );
  makeReplayClone(
    mirror,
    record.firstRevision.head,
    replay,
    `replay/${record.source}-${record.number}`,
  );
  const prepared: Case = {
    ...record,
    clone: { path: replay, preparedAt: new Date().toISOString() },
  };
  const checked = { ...prepared, checks: leakageChecks(prepared) };
  writeCase(checked);
  return checked;
};

/** What `.git` holds in a fresh clone: anything else (modules, worktrees, shallow, ...) fails. */
const GIT_ENTRIES = new Set([
  "HEAD",
  "config",
  "description",
  "hooks",
  "index",
  "info",
  "objects",
  "packed-refs",
  "refs",
]);

/** Links followed in one resolution before it counts as a loop, as the kernel's limit. */
const LINK_LIMIT = 40;

/**
 * An absolute path resolved as the kernel resolves it, without requiring it to exist (as Python's
 * non-strict `os.path.realpath`): each component that exists and is a link is replaced by its
 * target, `..` applies after, and from the first missing component on the rest is taken as written.
 * Null for a loop.
 */
/** Whether a path is a link; a path through a regular file (ENOTDIR) or missing is not one. */
const linkAt = (path: string) => {
  try {
    return (
      lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }
};

export const resolveLikeKernel = (path: string): string | null => {
  let parts = path.split(sep).filter((part) => part !== "");
  let resolved: string = sep;
  let links = 0;
  while (parts.length > 0) {
    const part = parts.shift()!;
    if (part === ".") continue;
    if (part === "..") {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, part);
    if (linkAt(next)) {
      if (++links > LINK_LIMIT) return null;
      const target = readlinkSync(next);
      parts = [...target.split(sep).filter((piece) => piece !== ""), ...parts];
      if (isAbsolute(target)) resolved = sep;
      continue;
    }
    resolved = next;
  }
  return resolved;
};

/**
 * Symlinks anywhere in the clone, `.git` included, whose target resolves outside it, or that loop.
 * A first revision can commit a link like `x -> ../labels/concerns.jsonl` or to an absolute path;
 * whatever reads the clone could then read outside it. Each link is resolved as the kernel would
 * (`resolveLikeKernel`), links before `..`: so `x -> self/../labels/later.json` with `self -> .` is
 * outside although its text looks inside, while a dangling link that stays inside, as a committed
 * `node_modules/.bin/acorn -> ../acorn/bin/acorn` without its package, passes. The walk never
 * follows a link, so a linked directory is checked as one link and not entered. Paths are relative
 * to the clone.
 */
export const escapingSymlinks = (clone: string) => {
  const root = realpathSync(clone);
  const escaping: Array<string> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      if (!entry.isSymbolicLink()) continue;
      const real = resolveLikeKernel(path);
      if (real === null || (real !== root && !real.startsWith(`${root}${sep}`)))
        escaping.push(relative(root, path));
    }
  };
  walk(root);
  return escaping.toSorted();
};

/**
 * The keys `git clone` writes to a clone's own config, and all the check allows. git prints key
 * names in lower case. core.symlinks appears only on a file system without links.
 */
export const CLONE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
]);

const TRANSIENT_HEADS = [
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "AUTO_MERGE",
] as const;

/** Lines of every non-empty reflog file under a repository's `.git/logs`. */
const reflogLines = (directory: string): number =>
  !existsSync(directory)
    ? 0
    : readdirSync(directory, { withFileTypes: true }).reduce(
        (sum, entry) =>
          sum +
          (entry.isDirectory()
            ? reflogLines(join(directory, entry.name))
            : readFileSync(join(directory, entry.name), "utf8")
                .split("\n")
                .filter((line) => line !== "").length),
        0,
      );

/**
 * The leakage checks of design §6 that hold before a run, recomputed from the clone itself. The
 * clone must hold exactly what HEAD reaches: any other object (a dangling commit, a fetched one, a
 * planted blob) could be read by SHA, so it fails the check whether or not `later` names it; and
 * reflogs and transient heads, which keep or name commits outside HEAD, must be absent.
 */
export const leakageChecks = (record: Case) => {
  const replay = record.clone!.path;
  const first = record.firstRevision!;
  const later = record.later!;
  const gitDirectory = join(replay, ".git");
  // Read first, from the file and without includes: a key like core.fsmonitor would run a command
  // as soon as a porcelain command such as status touched the clone. The other commands here are
  // plumbing that runs none.
  const configKeys = git(replay, [
    "config",
    "--file",
    join(gitDirectory, "config"),
    "--list",
    "--name-only",
  ])
    .stdout.split("\n")
    .filter((key) => key !== "");
  const configOnlyCloneKeys = configKeys.every((key) =>
    CLONE_CONFIG_KEYS.has(key.toLowerCase()),
  );
  const refs = git(replay, ["for-each-ref", "--format=%(refname)"])
    .stdout.trim()
    .split("\n");
  const laterShas = [
    ...new Set(
      [later.finalHead, later.merged, ...later.revisions].filter(
        (sha): sha is string => sha !== null && sha !== first.head,
      ),
    ),
  ];
  // A merge commit or final head that is the first head itself (no later change) is not later.
  const laterPresent = laterShas.filter((sha) => present(replay, sha));
  const reachable = new Set(
    git(replay, ["rev-list", "--objects", "HEAD"])
      .stdout.split("\n")
      .map((line) => line.slice(0, 40))
      .filter((sha) => sha !== ""),
  );
  const unreachableObjects = git(replay, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname)",
  ])
    .stdout.split("\n")
    .filter((sha) => sha !== "" && !reachable.has(sha)).length;
  const transientHeads = TRANSIENT_HEADS.filter((name) =>
    existsSync(join(gitDirectory, name)),
  );
  const reflogEntries = reflogLines(join(gitDirectory, "logs"));
  // The run's own store, `.git/neuve`, is reported by noStore instead.
  const escaping = escapingSymlinks(replay);
  const unexpectedGitEntries = readdirSync(gitDirectory).filter(
    (entry) => !GIT_ENTRIES.has(entry) && entry !== "neuve",
  );
  // A reduce, not Math.max(...): a long history has more commits than a call has arguments.
  const newestSeconds = git(replay, ["log", "--format=%ct", "HEAD"])
    .stdout.split("\n")
    .filter((line) => line !== "")
    .reduce((newest, line) => Math.max(newest, Number(line)), 0);
  const newestAt = new Date(newestSeconds * 1_000).toISOString();
  const checks = {
    headIsFirstRevision:
      git(replay, ["rev-parse", "HEAD"]).stdout.trim() === first.head,
    // Never run status on a config that could make it run a command.
    worktreeClean:
      configOnlyCloneKeys &&
      git(replay, ["status", "--porcelain"]).stdout.trim() === "",
    onlyReplayRef: refs.length === 1 && refs[0] === "refs/heads/replay",
    noRemote: git(replay, ["remote"]).stdout.trim() === "",
    baseIsAncestor: isAncestor(replay, first.base, first.head),
    noStore: !existsSync(join(gitDirectory, "neuve")),
    laterPresent,
    laterChecked: laterShas.length,
    unreachableObjects,
    reflogEntries,
    transientHeads: [...transientHeads],
    configOnlyCloneKeys,
    unexpectedGitEntries,
    escapingSymlinks: escaping,
    newestCommitAt: newestAt,
    // Commit dates are the author's clock: an hour of slack for skew, never more.
    newestCommitNotAfterFirstRevision:
      newestSeconds * 1_000 <= new Date(first.at).getTime() + 3_600_000,
    checkedAt: new Date().toISOString(),
  };
  return LeakageChecks.parse({
    ...checks,
    passed:
      checks.headIsFirstRevision &&
      checks.worktreeClean &&
      checks.onlyReplayRef &&
      checks.noRemote &&
      checks.baseIsAncestor &&
      checks.noStore &&
      laterPresent.length === 0 &&
      unreachableObjects === 0 &&
      reflogEntries === 0 &&
      transientHeads.length === 0 &&
      configOnlyCloneKeys &&
      unexpectedGitEntries.length === 0 &&
      escaping.length === 0 &&
      checks.newestCommitNotAfterFirstRevision,
  });
};
