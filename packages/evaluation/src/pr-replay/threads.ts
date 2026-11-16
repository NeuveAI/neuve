import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { gerritTime } from "./gerrit.ts";
import { git } from "./providers.ts";
import { follow, hunks } from "./rework.ts";
import type { CaseRecord } from "./schema.ts";
import {
  SOURCES,
  caseDirectory,
  isAutomatedAccount,
  mirrorPath,
  type SourceName,
} from "./sources.ts";

/**
 * A case's review discussion as one list of threads (design §3 step 1), built by code from the
 * captured provider record so the labeller judges substance, never provenance: who wrote each
 * message, at which revision, on which line, and that line in the first revision's numbering where
 * it can be followed there. Evaluator-only: it is written under `labels/`, never into a clone.
 */

const TEXT_LIMIT = 4_000;

export const ActorKind = z.enum(["author", "person", "bot"]);

export const Thread = z.strictObject({
  id: z.string(),
  kind: z.enum(["inline", "file", "change"]),
  /** The revision the thread was opened on: 1 is the first revision. */
  revision: z.int().min(1).nullable(),
  commit: z.string().nullable(),
  at: z.string(),
  anchor: z
    .strictObject({
      path: z.string(),
      side: z.enum(["new", "old"]),
      line: z.int().nullable(),
      /** The line key in the first revision (`<path>:<side>:<line>`), when it can be followed there. */
      firstRevisionKey: z.string().nullable(),
    })
    .nullable(),
  resolved: z.boolean().nullable(),
  messages: z.array(
    z.strictObject({
      id: z.string(),
      actor: z.string(),
      actorKind: ActorKind,
      at: z.string(),
      text: z.string(),
    }),
  ),
});
export type Thread = z.infer<typeof Thread>;

export const Revision = z.strictObject({
  number: z.int().min(1),
  commit: z.string().nullable(),
  at: z.string().nullable(),
  note: z.string(),
});

const clip = (text: string) =>
  text.length <= TEXT_LIMIT
    ? text
    : `${text.slice(0, TEXT_LIMIT)}\n[clipped: ${text.length - TEXT_LIMIT} more characters]`;

const read = (record: CaseRecord, name: string) =>
  JSON.parse(
    readFileSync(
      join(
        caseDirectory(record.source as SourceName, record.number),
        "capture",
        name,
      ),
      "utf8",
    ),
  ) as unknown;

/** A line at a later revision, followed back to the first revision when it existed there. */
const toFirst = (
  mirror: string,
  record: CaseRecord,
  path: string,
  side: "new" | "old",
  line: number | null,
  commit: string | null,
) => {
  const head = record.firstRevision!.head;
  if (line === null || commit === null) return null;
  if (commit === head) return `${path}:${side}:${line}`;
  // The old side's numbering is the base's, which a rebase moves: only followed at the first revision.
  if (side === "old") return null;
  if (git(mirror, ["cat-file", "-e", `${commit}:${path}`], true).code !== 0)
    return null;
  const back = follow(hunks(mirror, commit, head, path), line);
  return back === null ? null : `${path}:new:${back}`;
};

interface GerritAccount {
  readonly _account_id?: number;
  readonly name?: string;
  readonly email?: string;
  readonly username?: string;
}

const gerritBot = (account: GerritAccount | undefined) =>
  account === undefined ||
  /(gserviceaccount|LUCI|Commit Bot|CQ|-bot@|robot)/i.test(
    `${account.name ?? ""} ${account.email ?? ""}`,
  ) ||
  isAutomatedAccount(account.username ?? "");

/** Change messages that are only votes, uploads or CQ status carry no review content. */
const gerritMessageText = (text: string) =>
  text
    .split("\n")
    .filter(
      (line) =>
        !/^(Patch Set \d+:.*|Uploaded patch set \d+.*|\(\d+ comments?\)|.*Commit-Queue[+-]\d.*)$/.test(
          line.trim(),
        ),
    )
    .join("\n")
    .trim();

const gerritThreads = (record: CaseRecord, mirror: string) => {
  const detail = read(record, "detail.json") as {
    owner: GerritAccount;
    revisions: Record<string, { _number: number; created: string }>;
    messages: ReadonlyArray<{
      id: string;
      author?: GerritAccount;
      date: string;
      message: string;
      _revision_number?: number;
    }>;
  };
  const comments = read(record, "comments.json") as Record<
    string,
    ReadonlyArray<{
      id: string;
      patch_set?: number;
      line?: number;
      side?: string;
      in_reply_to?: string;
      unresolved?: boolean;
      updated: string;
      message?: string;
      author: GerritAccount;
    }>
  >;
  const owner = detail.owner._account_id;
  const kindOf = (account: GerritAccount | undefined) =>
    gerritBot(account)
      ? ("bot" as const)
      : account?._account_id === owner
        ? ("author" as const)
        : ("person" as const);
  const nameOf = (account: GerritAccount | undefined) =>
    account?.name ?? account?.email ?? String(account?._account_id ?? "?");
  const commitOf = new Map<number, string>(
    Object.entries(detail.revisions).map(([sha, revision]) => [
      revision._number,
      sha,
    ]),
  );
  const revisions = Object.entries(detail.revisions)
    .map(([sha, revision]) => ({
      number: revision._number,
      commit: sha,
      at: gerritTime(revision.created),
      note: `patchset ${revision._number}`,
    }))
    .sort((a, b) => a.number - b.number);
  // Comment threads: roots and their reply chains.
  const all = Object.entries(comments).flatMap(([path, list]) =>
    list.map((comment) => ({ ...comment, path })),
  );
  const byId = new Map(all.map((comment) => [comment.id, comment]));
  const rootOf = (id: string): string => {
    const parent = byId.get(id)?.in_reply_to;
    return parent === undefined || !byId.has(parent) ? id : rootOf(parent);
  };
  const groups = new Map<string, typeof all>();
  for (const comment of all) {
    const root = rootOf(comment.id);
    groups.set(root, [...(groups.get(root) ?? []), comment]);
  }
  const threads: Array<Thread> = [];
  for (const [rootId, group] of groups) {
    const sorted = [...group].sort((a, b) =>
      a.updated.localeCompare(b.updated),
    );
    const root = byId.get(rootId)!;
    const side = root.side === "PARENT" ? "old" : "new";
    const fileLevel =
      root.path === "/PATCHSET_LEVEL" || root.path === "/COMMIT_MSG";
    const commit =
      root.patch_set === undefined
        ? null
        : (commitOf.get(root.patch_set) ?? null);
    threads.push({
      id: `gerrit:comment:${rootId}`,
      kind:
        root.path === "/PATCHSET_LEVEL"
          ? "change"
          : root.line === undefined
            ? "file"
            : "inline",
      revision: root.patch_set ?? null,
      commit,
      at: gerritTime(root.updated),
      anchor: fileLevel
        ? null
        : {
            path: root.path,
            side,
            line: root.line ?? null,
            firstRevisionKey: toFirst(
              mirror,
              record,
              root.path,
              side,
              root.line ?? null,
              commit,
            ),
          },
      resolved: !(sorted.at(-1)?.unresolved ?? false),
      messages: sorted.map((comment) => ({
        id: comment.id,
        actor: nameOf(comment.author),
        actorKind: kindOf(comment.author),
        at: gerritTime(comment.updated),
        text: clip(comment.message ?? ""),
      })),
    });
  }
  // Change messages with review content beyond votes and uploads, each its own thread.
  for (const message of detail.messages) {
    const text = gerritMessageText(message.message);
    if (text === "" || gerritBot(message.author)) continue;
    threads.push({
      id: `gerrit:message:${message.id}`,
      kind: "change",
      revision: message._revision_number ?? null,
      commit:
        message._revision_number === undefined
          ? null
          : (commitOf.get(message._revision_number) ?? null),
      at: gerritTime(message.date),
      anchor: null,
      resolved: null,
      messages: [
        {
          id: message.id,
          actor: nameOf(message.author),
          actorKind: kindOf(message.author),
          at: gerritTime(message.date),
          text: clip(text),
        },
      ],
    });
  }
  return { threads, revisions };
};

interface GitHubUser {
  readonly login: string;
}

const githubThreads = (record: CaseRecord, mirror: string) => {
  const pull = read(record, "pull.json") as { user: GitHubUser };
  const comments = read(record, "review-comments.json") as ReadonlyArray<{
    id: number;
    user: GitHubUser | null;
    path: string;
    original_line: number | null;
    side: string | null;
    subject_type?: string;
    original_commit_id: string;
    in_reply_to_id?: number;
    created_at: string;
    body: string;
  }>;
  const reviews = read(record, "reviews.json") as ReadonlyArray<{
    id: number;
    user: GitHubUser | null;
    commit_id: string | null;
    submitted_at: string | null;
    state: string;
    body: string | null;
  }>;
  const issueComments = read(record, "issue-comments.json") as ReadonlyArray<{
    id: number;
    user: GitHubUser | null;
    created_at: string;
    body: string;
  }>;
  const timeline = read(record, "timeline.json") as ReadonlyArray<{
    event?: string;
    sha?: string;
    created_at?: string;
    committer?: { date?: string };
    after_commit?: { sha: string } | null;
  }>;
  const author = pull.user.login;
  const kindOf = (user: GitHubUser | null) =>
    user === null || isAutomatedAccount(user.login)
      ? ("bot" as const)
      : user.login === author
        ? ("author" as const)
        : ("person" as const);
  const head = record.firstRevision!.head;
  // Revisions: the first head, then each later head as commits and force-pushes brought it.
  const revisions: Array<z.infer<typeof Revision>> = [
    {
      number: 1,
      commit: head,
      at: record.firstRevision!.at,
      note: "first revision",
    },
  ];
  // The timeline names commits pushed after the first review by their commit time, and gives
  // force-pushes a time but (over REST) no head; so a later revision is any named commit dated after
  // the first review, in time order. Commit times are the author's clock: an approximation the
  // labeller sees as such.
  const firstAt = new Date(record.firstRevision!.at).getTime();
  const later = timeline
    .map((event) => ({
      event: event.event,
      commit:
        event.event === "committed"
          ? (event.sha ?? null)
          : event.event === "head_ref_force_pushed"
            ? (event.after_commit?.sha ?? null)
            : null,
      at: event.created_at ?? event.committer?.date ?? null,
    }))
    .filter(
      (event) =>
        (event.event === "committed" ||
          event.event === "head_ref_force_pushed") &&
        event.at !== null &&
        new Date(event.at).getTime() > firstAt &&
        event.commit !== head,
    )
    .sort((a, b) => a.at!.localeCompare(b.at!));
  for (const event of later)
    revisions.push({
      number: revisions.length + 1,
      commit: event.commit,
      at: event.at,
      note: event.event === "committed" ? "commit pushed" : "force-push",
    });
  const numberOf = new Map(
    revisions.map((revision) => [revision.commit, revision.number]),
  );
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const groups = new Map<number, Array<(typeof comments)[number]>>();
  for (const comment of comments) {
    let root = comment;
    while (root.in_reply_to_id !== undefined && byId.has(root.in_reply_to_id))
      root = byId.get(root.in_reply_to_id)!;
    groups.set(root.id, [...(groups.get(root.id) ?? []), comment]);
  }
  const threads: Array<Thread> = [];
  for (const [rootId, group] of groups) {
    const root = byId.get(rootId)!;
    const side = root.side === "LEFT" ? "old" : "new";
    threads.push({
      id: `github:review-comment:${rootId}`,
      kind:
        root.subject_type === "file" || root.original_line === null
          ? "file"
          : "inline",
      revision: numberOf.get(root.original_commit_id) ?? null,
      commit: root.original_commit_id,
      at: root.created_at,
      anchor: {
        path: root.path,
        side,
        line: root.original_line,
        firstRevisionKey: toFirst(
          mirror,
          record,
          root.path,
          side,
          root.original_line,
          root.original_commit_id,
        ),
      },
      resolved: null,
      messages: [...group]
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((comment) => ({
          id: String(comment.id),
          actor: comment.user?.login ?? "ghost",
          actorKind: kindOf(comment.user),
          at: comment.created_at,
          text: clip(comment.body),
        })),
    });
  }
  for (const review of reviews) {
    if ((review.body ?? "").trim() === "" || review.submitted_at === null)
      continue;
    threads.push({
      id: `github:review:${review.id}`,
      kind: "change",
      revision:
        review.commit_id === null
          ? null
          : (numberOf.get(review.commit_id) ?? null),
      commit: review.commit_id,
      at: review.submitted_at,
      anchor: null,
      resolved: null,
      messages: [
        {
          id: String(review.id),
          actor: review.user?.login ?? "ghost",
          actorKind: kindOf(review.user),
          at: review.submitted_at,
          text: clip(`[${review.state}] ${review.body ?? ""}`),
        },
      ],
    });
  }
  for (const comment of issueComments)
    threads.push({
      id: `github:issue-comment:${comment.id}`,
      kind: "change",
      revision: null,
      commit: null,
      at: comment.created_at,
      anchor: null,
      resolved: null,
      messages: [
        {
          id: String(comment.id),
          actor: comment.user?.login ?? "ghost",
          actorKind: kindOf(comment.user),
          at: comment.created_at,
          text: clip(comment.body),
        },
      ],
    });
  return { threads, revisions };
};

/** The case's threads, oldest first, and its revisions. */
export const caseThreads = (record: CaseRecord) => {
  if (record.firstRevision === null)
    throw new Error(`${record.caseId} has no first revision`);
  const mirror = mirrorPath(SOURCES[record.source as SourceName]);
  const { threads, revisions } =
    record.provider === "gerrit"
      ? gerritThreads(record, mirror)
      : githubThreads(record, mirror);
  return {
    threads: threads
      .map((thread) => Thread.parse(thread))
      .sort((a, b) => a.at.localeCompare(b.at)),
    revisions: revisions.map((revision) => Revision.parse(revision)),
  };
};
