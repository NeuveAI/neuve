import { gerrit, keep } from "./providers.ts";
import {
  SIZE,
  isAutomatedAccount,
  isIncidentalPath,
  type GerritSource,
} from "./sources.ts";

/**
 * Gerrit changes: patchset 1 is the first revision, exactly, and every later patchset stays
 * fetchable (`refs/changes/NN/<change>/<patchset>`), so the first-review boundary needs no
 * reconstruction. A comment's `patch_set` says which revision it was written against.
 */

interface GerritAccount {
  readonly _account_id: number;
  readonly username?: string;
  readonly email?: string;
  readonly name?: string;
}

interface GerritRevision {
  readonly _number: number;
  readonly ref: string;
  readonly created: string;
  readonly commit?: {
    readonly parents: ReadonlyArray<{ readonly commit: string }>;
  };
}

interface GerritChange {
  readonly _number: number;
  readonly subject: string;
  readonly owner: GerritAccount;
  readonly created: string;
  readonly status: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly total_comment_count?: number;
  readonly current_revision?: string;
  readonly revisions?: Readonly<Record<string, GerritRevision>>;
}

interface GerritComment {
  readonly id: string;
  readonly patch_set?: number;
  readonly author: GerritAccount;
  readonly in_reply_to?: string;
  readonly message?: string;
  readonly line?: number;
  readonly unresolved?: boolean;
}

const accountName = (account: GerritAccount) =>
  account.username ??
  account.email ??
  account.name ??
  String(account._account_id);

/** Gerrit timestamps are UTC without a zone: "2021-06-10 12:34:56.000000000". */
export const gerritTime = (text: string) =>
  new Date(`${text.replace(" ", "T").slice(0, 23)}Z`).toISOString();

/** Quarters of the source's window, so candidates spread across it rather than its last weeks. */
/** The window's calendar quarters, as [first day, last day] ISO dates. */
export const quarters = (window: readonly [string, string]) => {
  const out: Array<[string, string]> = [];
  for (
    let at = new Date(`${window[0]}T00:00:00Z`);
    at < new Date(`${window[1]}T00:00:00Z`);
  ) {
    const next = new Date(at);
    next.setUTCMonth(next.getUTCMonth() + 3);
    out.push([at.toISOString().slice(0, 10), next.toISOString().slice(0, 10)]);
    at = next;
  }
  return out;
};

/** Merged changes by people, of a reviewable size, with discussion and more than one patchset. */
export const gerritCandidates = async (
  source: GerritSource,
  perQuarter = 100,
) => {
  const found: Array<GerritChange> = [];
  for (const [after, before] of quarters(source.window)) {
    const query = `project:${source.project} status:merged after:${after} before:${before}`;
    const page = (await gerrit(
      source.host,
      `/changes/?q=${encodeURIComponent(query)}&n=${perQuarter}&o=CURRENT_REVISION&o=DETAILED_ACCOUNTS`,
    )) as Array<GerritChange & { readonly _more_changes?: boolean }>;
    // The server may cap a page below n; say so rather than list a quarter short in silence.
    if (page.at(-1)?._more_changes === true)
      console.error(
        `${source.name} ${after}..${before}: Gerrit listed ${page.length} of more than ${page.length} changes`,
      );
    found.push(
      ...page.filter((change) => {
        const lines = change.insertions + change.deletions;
        const patchsets =
          Object.values(change.revisions ?? {})[0]?._number ?? 1;
        return (
          !isAutomatedAccount(accountName(change.owner)) &&
          (change.total_comment_count ?? 0) >= 5 &&
          patchsets >= 2 &&
          lines >= SIZE.minLines &&
          lines <= SIZE.maxLines * 2
        );
      }),
    );
  }
  return found;
};

/**
 * Whether a change is a good interaction at patchset 1: someone other than the owner commented
 * on its code at patchset 1, the owner replied, and patchset 1 itself is of a reviewable size.
 * The score counts those threads and replies; a model judges substance later, at labelling.
 */
export const qualifyGerrit = async (source: GerritSource, number: number) => {
  const comments = (await gerrit(
    source.host,
    `/changes/${number}/comments`,
  )) as Record<string, ReadonlyArray<GerritComment>>;
  const files = (await gerrit(
    source.host,
    `/changes/${number}/revisions/1/files`,
  )) as Record<
    string,
    { readonly lines_inserted?: number; readonly lines_deleted?: number }
  >;
  const change = (await gerrit(
    source.host,
    `/changes/${number}?o=DETAILED_ACCOUNTS`,
  )) as GerritChange;
  const owner = change.owner._account_id;
  const all = Object.entries(comments).flatMap(([path, list]) =>
    list.map((comment) => ({ ...comment, path })),
  );
  const firstThreads = all.filter(
    (comment) =>
      comment.path !== "/PATCHSET_LEVEL" &&
      comment.patch_set === 1 &&
      comment.in_reply_to === undefined &&
      comment.author._account_id !== owner &&
      !isAutomatedAccount(accountName(comment.author)),
  );
  const threadIds = new Set(firstThreads.map((comment) => comment.id));
  const ownerReplies = all.filter(
    (comment) =>
      comment.author._account_id === owner &&
      comment.in_reply_to !== undefined &&
      threadIds.has(comment.in_reply_to),
  );
  const changed = Object.entries(files).filter(
    ([path]) => path !== "/COMMIT_MSG" && !isIncidentalPath(path),
  );
  const lines = changed.reduce(
    (sum, [, file]) =>
      sum + (file.lines_inserted ?? 0) + (file.lines_deleted ?? 0),
    0,
  );
  const reasons: Array<string> = [];
  if (firstThreads.length === 0)
    reasons.push("no reviewer comment on code at patchset 1");
  if (ownerReplies.length === 0)
    reasons.push("no owner reply to those comments");
  if (lines < SIZE.minLines || lines > SIZE.maxLines)
    reasons.push(`patchset 1 changes ${lines} lines`);
  if (changed.length > SIZE.maxFiles)
    reasons.push(`patchset 1 changes ${changed.length} files`);
  return {
    number,
    title: change.subject,
    author: accountName(change.owner),
    qualifies: reasons.length === 0,
    score: firstThreads.length + ownerReplies.length,
    reasons:
      reasons.length > 0
        ? reasons
        : [
            `${firstThreads.length} reviewer threads on code at patchset 1`,
            `${ownerReplies.length} owner replies`,
            `${lines} lines in ${changed.length} files at patchset 1`,
          ],
  };
};

/** Captures a change's provider record: detail with every revision, comments and robot comments. */
export const captureGerrit = async (
  source: GerritSource,
  number: number,
  directory: string,
) => {
  const detail = (await gerrit(
    source.host,
    `/changes/${number}?o=ALL_REVISIONS&o=ALL_COMMITS&o=MESSAGES&o=DETAILED_ACCOUNTS&o=DETAILED_LABELS&o=ALL_FILES`,
  )) as GerritChange;
  const comments = await gerrit(source.host, `/changes/${number}/comments`);
  // Chromium's Gerrit no longer serves robot comments (404); kept where a host still does.
  const robot = await gerrit(
    source.host,
    `/changes/${number}/robotcomments`,
  ).catch(() => null);
  return {
    detail,
    files: [
      keep(directory, "detail.json", detail),
      keep(directory, "comments.json", comments),
      ...(robot === null ? [] : [keep(directory, "robotcomments.json", robot)]),
    ],
  };
};

/** Patchset 1, its parent and every later patchset, from a captured detail. */
export const gerritRevisions = (detail: GerritChange) => {
  const revisions = Object.entries(detail.revisions ?? {})
    .map(([sha, revision]) => ({ ...revision, sha }))
    .sort((a, b) => a._number - b._number);
  const first = revisions[0];
  if (first === undefined || first._number !== 1)
    throw new Error(`change ${detail._number} has no patchset 1`);
  const parents = first.commit?.parents ?? [];
  if (parents.length !== 1)
    throw new Error(
      `patchset 1 of ${detail._number} has ${parents.length} parents`,
    );
  return {
    first: {
      head: first.sha,
      base: parents[0]!.commit,
      at: gerritTime(first.created),
      ref: first.ref,
    },
    later: revisions.slice(1).map((revision) => ({
      commit: revision.sha,
      ref: revision.ref,
    })),
    current: detail.current_revision ?? null,
  };
};

export type { GerritChange };
