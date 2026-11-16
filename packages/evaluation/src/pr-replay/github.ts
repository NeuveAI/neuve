import { github, keep } from "./providers.ts";
import {
  SIZE,
  isAutomatedAccount,
  isIncidentalPath,
  type GitHubSource,
} from "./sources.ts";

/**
 * GitHub pull requests: the first revision is the commit the first review saw, which every review
 * (`commit_id`) and inline comment (`original_commit_id`) records. Force-pushes can drop it from the
 * pull request's commit list, so it is fetched by SHA; one that cannot be fetched makes the case
 * unavailable, never approximated (design §2).
 */

interface User {
  readonly login: string;
}

interface Pull {
  readonly number: number;
  readonly title: string;
  readonly user: User;
  readonly created_at: string;
  readonly merged_at: string | null;
  readonly state: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly base: { readonly ref: string; readonly sha: string };
  readonly head: { readonly ref: string; readonly sha: string };
  readonly merge_commit_sha: string | null;
}

interface Review {
  readonly user: User | null;
  readonly commit_id: string | null;
  readonly submitted_at: string | null;
  readonly state: string;
}

interface ReviewComment {
  readonly id: number;
  readonly user: User | null;
  readonly in_reply_to_id?: number;
  readonly original_commit_id: string;
  readonly created_at: string;
  readonly body: string;
}

interface TimelineEvent {
  readonly event?: string;
  readonly sha?: string;
  readonly before_commit?: { readonly sha: string } | null;
  readonly after_commit?: { readonly sha: string } | null;
}

const quarters = (window: readonly [string, string]) => {
  const out: Array<[string, string]> = [];
  for (
    let at = new Date(`${window[0]}T00:00:00Z`);
    at < new Date(`${window[1]}T00:00:00Z`);
  ) {
    const next = new Date(at);
    next.setUTCMonth(next.getUTCMonth() + 3);
    const last = new Date(next.getTime() - 86_400_000);
    out.push([at.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]);
    at = next;
  }
  return out;
};

const SEARCH = `query($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title additions deletions changedFiles
      author { login }
      reviewThreads { totalCount }
    } }
  }
}`;

interface SearchNode {
  readonly number?: number;
  readonly title?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly author?: { readonly login: string } | null;
  readonly reviewThreads?: { readonly totalCount: number };
}

/**
 * Merged pull requests by people in each quarter of the window, with their size and review-thread
 * count from one GraphQL search, so only changes of a reviewable size with inline review go on to
 * be qualified. Sorting by comments alone surfaces the largest changes, which are never cases.
 */
export const githubCandidates = (source: GitHubSource, perQuarter = 200) => {
  const found: Array<{
    number: number;
    title: string;
    author: string;
    threads: number;
  }> = [];
  for (const [from, to] of quarters(source.window)) {
    let after: string | null = null;
    let seen = 0;
    do {
      const argv: Record<string, string> = {
        query: SEARCH,
        q: `repo:${source.repo} is:pr is:merged created:${from}..${to} ${source.query}`.trim(),
      };
      if (after !== null) argv["after"] = after;
      const page = (
        github("graphql", { fields: argv, method: "POST" }) as {
          data: {
            search: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: ReadonlyArray<SearchNode>;
            };
          };
        }
      ).data.search;
      for (const node of page.nodes) {
        const login = node.author?.login;
        const lines = (node.additions ?? 0) + (node.deletions ?? 0);
        if (
          node.number !== undefined &&
          login !== undefined &&
          !isAutomatedAccount(login) &&
          (node.changedFiles ?? 0) <= SIZE.maxFiles &&
          lines >= SIZE.minLines &&
          lines <= SIZE.maxLines * 2 &&
          (node.reviewThreads?.totalCount ?? 0) >= 2
        )
          found.push({
            number: node.number,
            title: node.title ?? "",
            author: login,
            threads: node.reviewThreads!.totalCount,
          });
      }
      seen += page.nodes.length;
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after !== null && seen < perQuarter);
  }
  return found;
};

/** The first revision: the earliest commit a review or an inline comment names. */
export const firstReviewedCommit = (
  reviews: ReadonlyArray<Review>,
  comments: ReadonlyArray<ReviewComment>,
) => {
  const seen = [
    ...reviews
      .filter(
        (review) => review.commit_id !== null && review.submitted_at !== null,
      )
      .map((review) => ({
        commit: review.commit_id!,
        at: review.submitted_at!,
      })),
    ...comments.map((comment) => ({
      commit: comment.original_commit_id,
      at: comment.created_at,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return seen[0] ?? null;
};

const isBot = (user: User | null) =>
  user === null || isAutomatedAccount(user.login);

/**
 * Whether a pull request is a good interaction at its first revision: a reviewer other than the
 * author commented on code at that revision and someone answered the thread (the author, or a
 * maintainer for a bot's finding). For bot-reviewed sources, a bot finding must also have drawn a
 * person's answer (design §1). The score counts those threads and answers.
 */
export const qualifyGithub = (source: GitHubSource, number: number) => {
  const base = `repos/${source.repo}/pulls/${number}`;
  const pull = github(base) as Pull;
  const reasons: Array<string> = [];
  if (pull.changed_files > SIZE.maxFiles)
    reasons.push(`${pull.changed_files} files`);
  if (pull.additions + pull.deletions > SIZE.maxLines * 2)
    reasons.push(`${pull.additions + pull.deletions} lines at merge`);
  if (reasons.length > 0)
    return {
      number,
      title: pull.title,
      author: pull.user.login,
      qualifies: false,
      score: 0,
      reasons,
    };
  const files = github(`${base}/files`, { paginate: true }) as ReadonlyArray<{
    filename: string;
  }>;
  if (source.paths !== undefined) {
    const { prefix, inside } = source.paths;
    if (!files.every((file) => file.filename.startsWith(prefix) === inside))
      reasons.push(
        inside ? `files outside ${prefix}` : `files inside ${prefix}`,
      );
  }
  if (files.every((file) => isIncidentalPath(file.filename)))
    reasons.push("only incidental files");
  const reviews = github(`${base}/reviews`, {
    paginate: true,
  }) as ReadonlyArray<Review>;
  const comments = github(`${base}/comments`, {
    paginate: true,
  }) as ReadonlyArray<ReviewComment>;
  const first = firstReviewedCommit(reviews, comments);
  if (first === null) reasons.push("no review names a commit");
  const author = pull.user.login;
  const threads = comments.filter(
    (comment) =>
      comment.in_reply_to_id === undefined &&
      comment.original_commit_id === first?.commit &&
      comment.user?.login !== author,
  );
  const threadIds = new Set(threads.map((comment) => comment.id));
  const answered = new Set(
    comments
      .filter(
        (comment) =>
          comment.in_reply_to_id !== undefined &&
          threadIds.has(comment.in_reply_to_id) &&
          !isBot(comment.user),
      )
      .map((comment) => comment.in_reply_to_id!),
  );
  const people = threads.filter((comment) => !isBot(comment.user));
  const bots = threads.filter((comment) => isBot(comment.user));
  const botsAnswered = bots.filter((comment) => answered.has(comment.id));
  if (threads.length === 0)
    reasons.push("no reviewer comment on code at the first revision");
  if (answered.size === 0) reasons.push("no answer to those comments");
  if (source.review === "people" && people.length === 0)
    reasons.push("no person commented on code at the first revision");
  if (source.review === "bots-and-people" && botsAnswered.length === 0)
    reasons.push("no bot finding drew a person's answer");
  return {
    number,
    title: pull.title,
    author,
    qualifies: reasons.length === 0,
    score: threads.length + answered.size,
    reasons:
      reasons.length > 0
        ? reasons
        : [
            `${people.length} threads from people and ${bots.length} from bots on code at the first revision`,
            `${answered.size} threads answered (${botsAnswered.length} bot findings)`,
          ],
  };
};

/** Captures a pull request's provider record: the pull, its commits, files, reviews, comments and timeline. */
export const captureGithub = (
  source: GitHubSource,
  number: number,
  directory: string,
) => {
  const base = `repos/${source.repo}/pulls/${number}`;
  const pull = github(base) as Pull;
  const commits = github(`${base}/commits`, {
    paginate: true,
  }) as ReadonlyArray<{
    sha: string;
    parents: ReadonlyArray<{ sha: string }>;
  }>;
  const files = github(`${base}/files`, { paginate: true });
  const reviews = github(`${base}/reviews`, {
    paginate: true,
  }) as ReadonlyArray<Review>;
  const comments = github(`${base}/comments`, {
    paginate: true,
  }) as ReadonlyArray<ReviewComment>;
  const issueComments = github(
    `repos/${source.repo}/issues/${number}/comments`,
    {
      paginate: true,
    },
  );
  const timeline = github(`repos/${source.repo}/issues/${number}/timeline`, {
    paginate: true,
  }) as ReadonlyArray<TimelineEvent>;
  return {
    pull,
    commits,
    reviews,
    comments,
    timeline,
    files: [
      keep(directory, "pull.json", pull),
      keep(directory, "commits.json", commits),
      keep(directory, "files.json", files),
      keep(directory, "reviews.json", reviews),
      keep(directory, "review-comments.json", comments),
      keep(directory, "issue-comments.json", issueComments),
      keep(directory, "timeline.json", timeline),
    ],
  };
};

/** Every commit SHA the captured record names after the pull request opened: candidates for "later". */
export const namedCommits = (captured: ReturnType<typeof captureGithub>) => {
  const shas = new Set<string>();
  shas.add(captured.pull.head.sha);
  if (captured.pull.merge_commit_sha !== null)
    shas.add(captured.pull.merge_commit_sha);
  for (const commit of captured.commits) shas.add(commit.sha);
  for (const event of captured.timeline) {
    if (event.event === "committed" && event.sha !== undefined)
      shas.add(event.sha);
    if (event.before_commit?.sha !== undefined)
      shas.add(event.before_commit.sha);
    if (event.after_commit?.sha !== undefined) shas.add(event.after_commit.sha);
  }
  for (const comment of captured.comments) shas.add(comment.original_commit_id);
  for (const review of captured.reviews)
    if (review.commit_id !== null) shas.add(review.commit_id);
  return [...shas];
};

export type { Pull };
