import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quarters } from "./gerrit.ts";
import { gerrit, github } from "./providers.ts";
import {
  SIZE,
  indexDirectory,
  isAutomatedAccount,
  type GerritSource,
  type GitHubSource,
  type Source,
  type SourceName,
} from "./sources.ts";

/**
 * Control cases (design §1; the owner's call, 26 October 2026): changes that measure over-escalation
 * rather than review. Neuve should leave them to automation or pass them quickly; a control that
 * Neuve sends to a person is the over-escalation lanes round 2 measures. Four kinds, each replayed
 * at its first revision like any case, from the source's own window:
 *
 * - quiet: merged with at most one comment, by a person, neither a revert nor mechanical;
 * - abandoned: abandoned on Gerrit, or closed unmerged on GitHub, by a person;
 * - revert: the original change that a merged revert later undid (10.128's strongest evidence that a
 *   person was needed), with few comments so it is no interaction case; the revert itself is at
 *   most a mechanical control;
 * - mechanical: merged with at most one comment, by a roll bot, or whose every file is a lockfile,
 *   DEPS, generated, a snapshot, a minified file, a source map, a translation or a copied package
 *   (`isMechanicalPath`). Never by title.
 *
 * Every kind has the cases' size ceiling, and every kind but mechanical their floor (a roll may be
 * two lines). A change whose every file is under third_party/ or vendor/ is ambiguous (a copied
 * dependency or a project's own tooling there) and no control. No change listed as an interaction
 * candidate (the
 * source's `index/candidates/<source>.json`) is a control. The listing reads public providers
 * read-only; selection (the author cap and the held-out split) is the batch's.
 */

export const CONTROL_KINDS = [
  "quiet",
  "abandoned",
  "revert",
  "mechanical",
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** Design §1's controls per source. */
export const CONTROL_TARGETS: Readonly<Record<SourceName, number>> = {
  "devtools-frontend": 8,
  go: 4,
  "react-compiler": 4,
  "react-core": 3,
  "entire-cli": 4,
  t3code: 4,
};

/**
 * The most comments a control may have: quiet and mechanical changes at most one; a reverted original
 * fewer than the interaction cases' five, so the two never overlap. Abandoned changes are unbounded.
 */
export const CONTROL_COMMENTS = { quiet: 1, mechanical: 1, revert: 4 } as const;

const REVERT = /^\s*revert\b/i;

/** What the kind decision reads of a change, from either provider. */
export interface ControlFacts {
  readonly title: string;
  readonly author: string;
  readonly merged: boolean;
  readonly abandoned: boolean;
  readonly lines: number;
  readonly files: number | null;
  /** Inline comments and top-level messages from people other than the owner. */
  readonly comments: number;
  /** The changed paths, or null when they were not fetched. */
  readonly paths: ReadonlyArray<string> | null;
  /** A merged revert in the window undid this change. */
  readonly reverted: boolean;
}

/**
 * A file nobody writes by hand. Stricter than the cases' `isIncidentalPath`: third_party/ and vendor/
 * can hold a project's own code (DevTools keeps its build tooling in third_party/typescript/), so
 * only copied packages (node_modules/) count among vendored paths.
 */
// Known edge cases, left as they are: hand-written code under a generated/ folder, or docs under
// i18n/, count as mechanical.
export const isMechanicalPath = (path: string) =>
  /(^|\/)node_modules\//.test(path) ||
  /(^|\/)(__generated__|generated)\//.test(path) ||
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|DEPS)$/.test(
    path,
  ) ||
  /\.(snap|min\.js|map)$/.test(path) ||
  /(^|\/)(locales?|i18n)\/.*\.(json|xtb|grd)$/.test(path);

/** A roll bot's change, or one whose every file is one nobody writes by hand. */
export const isMechanicalChange = (change: ControlFacts) =>
  isAutomatedAccount(change.author) ||
  (change.paths !== null &&
    change.paths.length > 0 &&
    change.paths.every(isMechanicalPath));

/** The kind of control a change is, or null when it is none. */
export const controlKind = (change: ControlFacts): ControlKind | null => {
  const ceiling =
    change.lines <= SIZE.maxLines &&
    (change.files === null || change.files <= SIZE.maxFiles);
  if (!ceiling) return null;
  const automated = isAutomatedAccount(change.author);
  // Below the floor only a mechanical change counts: a roll or a lockfile bump may be tiny.
  if (change.lines < SIZE.minLines)
    return change.merged &&
      !change.reverted &&
      change.comments <= CONTROL_COMMENTS.mechanical &&
      isMechanicalChange(change)
      ? "mechanical"
      : null;
  // A reverted revert is a re-land, not the change a person's judgement undid.
  if (change.reverted)
    return change.merged &&
      !automated &&
      !REVERT.test(change.title) &&
      change.comments <= CONTROL_COMMENTS.revert
      ? "revert"
      : null;
  if (change.abandoned) return automated ? null : "abandoned";
  if (!change.merged || change.comments > CONTROL_COMMENTS.quiet) return null;
  // Quiet and mechanical are told apart by the files: undecided until they are known.
  if (change.paths === null && !automated) return null;
  if (isMechanicalChange(change)) return "mechanical";
  if (REVERT.test(change.title) || automated) return null;
  // Every file under third_party/ or vendor/: a copied dependency or owned tooling, undecided.
  if (change.paths?.every((path) => /(^|\/)(third_party|vendor)\//.test(path)))
    return null;
  return "quiet";
};

/**
 * The pull request a GitHub revert names, as GitHub's revert button writes it: a line starting
 * "Reverts owner/repo#123" (or "Reverts #123"). A named repository must be this one; prose such as
 * "This PR reverts #5" is no revert link.
 */
export const revertedPull = (body: string, repo: string): number | null => {
  const match = /^\s*Reverts\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/m.exec(body);
  if (match === null) return null;
  if (match[1] !== undefined && match[1].toLowerCase() !== repo.toLowerCase())
    return null;
  return Number(match[2]);
};

/** The commit a revert names: git's "This reverts commit <sha>." */
export const revertedCommit = (text: string): string | null =>
  /\bThis reverts commit ([0-9a-f]{7,40})\b/i.exec(text)?.[1] ?? null;

export interface ControlCandidate {
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly kind: ControlKind;
  readonly comments: number;
  readonly lines: number;
}

/** Every number listed as an interaction candidate for the source: never a control. */
export const interactionNumbers = (name: SourceName): ReadonlySet<number> => {
  const path = join(indexDirectory(), "candidates", `${name}.json`);
  // Without the index the exclusion would be silent: list the candidates first.
  if (!existsSync(path))
    throw new Error(
      `no interaction candidates at ${path}: run candidates ${name} first`,
    );
  const index = JSON.parse(readFileSync(path, "utf8")) as {
    qualified: ReadonlyArray<{ number: number }>;
  };
  return new Set(index.qualified.map((candidate) => candidate.number));
};

/** File checks per source: they cost one call each, and the controls needed are few. */
const PATH_CHECKS = 160;

/** Takes every k-th item so a bounded check spreads over the whole window. */
const spread = <T>(list: ReadonlyArray<T>, limit: number) => {
  const step = Math.max(1, Math.floor(list.length / limit));
  return list.filter((_, at) => at % step === 0).slice(0, limit);
};

interface GerritAccount {
  readonly _account_id: number;
  readonly username?: string;
  readonly email?: string;
  readonly name?: string;
}

interface GerritListed {
  readonly _number: number;
  readonly subject: string;
  readonly status: string;
  readonly created: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly total_comment_count?: number;
  readonly revert_of?: number;
  readonly owner: GerritAccount;
  readonly messages?: ReadonlyArray<{
    readonly author?: GerritAccount;
    readonly tag?: string;
    readonly message?: string;
  }>;
}

const gerritName = (account: GerritAccount) =>
  account.username ??
  account.email ??
  account.name ??
  String(account._account_id);

/**
 * Whether a Gerrit message says anything beyond votes: "Patch Set 3: Code-Review+1" or
 * "Patch Set 2: Commit-Queue+2\n\n(1 comment)" is a vote (the inline comment counts on its own).
 */
export const gerritMessageSays = (text: string) =>
  text
    .replace(/^Patch Set \d+:/, "")
    .replace(/\b[\w-]+[+-]\d\b/g, "")
    .replace(/\(\d+ (?:inline )?comments?\)/g, "")
    .trim() !== "";

/** Inline comments plus top-level messages from people other than the owner that say something. */
const gerritComments = (change: GerritListed) =>
  (change.total_comment_count ?? 0) +
  (change.messages ?? []).filter(
    (message) =>
      message.author !== undefined &&
      message.author._account_id !== change.owner._account_id &&
      !(message.tag ?? "").startsWith("autogenerated:") &&
      !isAutomatedAccount(gerritName(message.author)) &&
      gerritMessageSays(message.message ?? ""),
  ).length;

const gerritFacts = (
  change: GerritListed,
  paths: ReadonlyArray<string> | null,
  reverted: boolean,
): ControlFacts => ({
  title: change.subject,
  author: gerritName(change.owner),
  merged: change.status === "MERGED",
  abandoned: change.status === "ABANDONED",
  lines: change.insertions + change.deletions,
  files: paths === null ? null : paths.length,
  comments: gerritComments(change),
  paths,
  reverted,
});

const gerritControls = async (
  source: GerritSource,
  perQuarter: number,
  exclude: ReadonlySet<number>,
): Promise<Array<ControlCandidate>> => {
  const listed: Array<GerritListed> = [];
  for (const [after, before] of quarters(source.window))
    for (const status of ["merged", "abandoned"] as const) {
      const query = `project:${source.project} status:${status} after:${after} before:${before}`;
      const page = (await gerrit(
        source.host,
        `/changes/?q=${encodeURIComponent(query)}&n=${perQuarter}&o=DETAILED_ACCOUNTS&o=MESSAGES`,
      )) as ReadonlyArray<GerritListed & { readonly _more_changes?: boolean }>;
      if (page.at(-1)?._more_changes === true)
        console.error(
          `${source.name} ${after}..${before} ${status}: Gerrit listed ${page.length} of more`,
        );
      listed.push(...page);
    }
  const found = new Map<number, ControlCandidate>();
  const add = (change: GerritListed, kind: ControlKind | null) => {
    if (kind === null || exclude.has(change._number)) return;
    found.set(change._number, {
      number: change._number,
      title: change.subject,
      author: gerritName(change.owner),
      kind,
      comments: gerritComments(change),
      lines: change.insertions + change.deletions,
    });
  };
  const [start, end] = source.window;
  for (const change of listed) {
    if (change.status === "ABANDONED")
      add(change, controlKind(gerritFacts(change, null, false)));
    // A merged revert: its original, if it merged inside the window, is the revert control.
    if (change.status === "MERGED" && change.revert_of !== undefined) {
      const original = (await gerrit(
        source.host,
        `/changes/${change.revert_of}?o=DETAILED_ACCOUNTS&o=MESSAGES`,
      ).catch(() => null)) as GerritListed | null;
      if (
        original !== null &&
        original.created.slice(0, 10) >= start &&
        original.created.slice(0, 10) < end
      )
        add(original, controlKind(gerritFacts(original, null, true)));
    }
  }
  // Quiet and mechanical need the files: checked for a bounded spread of the merged changes with
  // at most one comment, of the cases' size.
  const quietish = listed.filter(
    (change) =>
      change.status === "MERGED" &&
      change.revert_of === undefined &&
      !found.has(change._number) &&
      gerritComments(change) <= CONTROL_COMMENTS.quiet &&
      change.insertions + change.deletions <= SIZE.maxLines,
  );
  for (const change of spread(quietish, PATH_CHECKS)) {
    const files = (await gerrit(
      source.host,
      `/changes/${change._number}/revisions/current/files`,
    ).catch(() => null)) as Record<string, unknown> | null;
    if (files === null) continue;
    const paths = Object.keys(files).filter((path) => !path.startsWith("/"));
    add(change, controlKind(gerritFacts(change, paths, false)));
  }
  return [...found.values()];
};

const CONTROL_SEARCH = `query($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title body additions deletions changedFiles merged closed createdAt
      author { login }
      comments { totalCount }
      reviewThreads { totalCount }
      files(first: 100) { nodes { path } }
    } }
  }
}`;

interface ControlNode {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly merged?: boolean;
  readonly closed?: boolean;
  readonly createdAt?: string;
  readonly author?: { readonly login: string } | null;
  readonly comments?: { readonly totalCount: number };
  readonly reviewThreads?: { readonly totalCount: number };
  readonly files?: { readonly nodes: ReadonlyArray<{ readonly path: string }> };
}

interface RestPull {
  readonly number: number;
  readonly title: string;
  readonly user: { readonly login: string } | null;
  readonly created_at: string;
  readonly merged_at: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly comments: number;
  readonly review_comments: number;
}

const githubControls = (
  source: GitHubSource,
  perQuarter: number,
  exclude: ReadonlySet<number>,
): Array<ControlCandidate> => {
  const found = new Map<number, ControlCandidate>();
  const add = (
    number: number,
    title: string,
    author: string,
    facts: ControlFacts,
  ) => {
    const kind = controlKind(facts);
    if (kind === null || exclude.has(number)) return;
    found.set(number, {
      number,
      title,
      author,
      kind,
      comments: facts.comments,
      lines: facts.lines,
    });
  };
  const [start, end] = source.window;
  for (const [from, to] of quarters(source.window))
    for (const state of ["is:merged", "is:unmerged is:closed"]) {
      let after: string | null = null;
      let seen = 0;
      do {
        const fields: Record<string, string> = {
          query: CONTROL_SEARCH,
          q: `repo:${source.repo} is:pr ${state} created:${from}..${to} ${source.query}`.trim(),
        };
        if (after !== null) fields["after"] = after;
        const page = (
          github("graphql", { fields, method: "POST" }) as {
            data: {
              search: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: ReadonlyArray<ControlNode>;
              };
            };
          }
        ).data.search;
        for (const node of page.nodes) {
          const author = node.author?.login;
          if (node.number === undefined || author === undefined) continue;
          const title = node.title ?? "";
          const paths = (node.files?.nodes ?? []).map((file) => file.path);
          add(node.number, title, author, {
            title,
            author,
            merged: node.merged === true,
            abandoned: node.merged !== true && node.closed === true,
            lines: (node.additions ?? 0) + (node.deletions ?? 0),
            files: node.changedFiles ?? null,
            comments:
              (node.comments?.totalCount ?? 0) +
              (node.reviewThreads?.totalCount ?? 0),
            // A listing of 100 files is partial beyond that: undecided rather than guessed.
            paths: (node.changedFiles ?? 0) > paths.length ? null : paths,
            reverted: false,
          });
          // A merged revert: its original, if it merged inside the window, is the revert control.
          if (node.merged === true && REVERT.test(title)) {
            const body = node.body ?? "";
            let original = revertedPull(body, source.repo);
            const sha = original === null ? revertedCommit(body) : null;
            if (sha !== null) {
              const pulls = github(
                `repos/${source.repo}/commits/${sha}/pulls`,
              ) as ReadonlyArray<{
                number: number;
              }>;
              original = pulls[0]?.number ?? null;
            }
            if (original === null) continue;
            const pull = github(
              `repos/${source.repo}/pulls/${original}`,
            ) as RestPull;
            if (
              pull.merged_at === null ||
              pull.created_at.slice(0, 10) < start ||
              pull.created_at.slice(0, 10) >= end ||
              pull.user === null
            )
              continue;
            add(pull.number, pull.title, pull.user.login, {
              title: pull.title,
              author: pull.user.login,
              merged: true,
              abandoned: false,
              lines: pull.additions + pull.deletions,
              files: pull.changed_files,
              comments: pull.comments + pull.review_comments,
              paths: null,
              reverted: true,
            });
          }
        }
        seen += page.nodes.length;
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after !== null && seen < perQuarter);
    }
  return [...found.values()];
};

/**
 * Every control candidate in the source's window, by kind, never an interaction candidate; at most
 * `perQuarter` changes listed per quarter and state.
 */
export const controlCandidates = async (
  name: SourceName,
  source: Source,
  perQuarter = 200,
) => {
  const exclude = interactionNumbers(name);
  return source.provider === "gerrit"
    ? await gerritControls(source, perQuarter, exclude)
    : githubControls(source, perQuarter, exclude);
};
