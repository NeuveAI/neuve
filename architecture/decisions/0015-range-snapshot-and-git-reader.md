# 0015: Range snapshot and Git reader

Status: accepted by the owner on 5 and 6 November 2026 as the reference for how a review reads source ([decisions 12.44 to 12.49](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026)). Not built. NEU-113 lands the per-review reader that this design grows from; the [changes](#what-has-to-change), [tests](#tests-on-real-ranges) and [build order](#build-order) below need their own Linear scope. "Range snapshot" is a working name, not yet a vocabulary term.

## Decision

The Git reader stops being a hidden cache under review stages. It is the service that produces a range's snapshot and answers questions about that range.

| Layer                 | Holds                                                                                                     | Lifetime                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Git**               | Commits, trees and blobs. The only source of hunk text                                                    | The repository's own                                                              |
| **Durable record**    | The range's identity, hunk coordinates and hashes, the Graph facts used, and each drilldown's commit hash | As Records                                                                        |
| **Range diff blob**   | The consolidated diff for the range, and nothing per commit                                               | A strict expiry, rebuilt on a miss                                                |
| **Reader warm cache** | Objects, the range's text and any per-commit diff asked for                                               | In memory, bounded, for the range while it is in use. Losing it is never an error |

The default view is the whole range, as a pull request shows it. Per-commit detail is there on request, and is answered from memory the second time.

Stages use the [fixed review shape](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) (12.41). Map reads files and Graph facts. Find reads the diffs of the files it picks. No step reads the whole diff.

## The stored shape

```ts
type RangeSnapshot = {
  format: number;
  key: {
    repository: string;
    baseOid: string;
    headOid: string;
    graphGeneration: string | null;
    diffRecipe: number; // the pinned settings below
  };
  mergeBaseOid: string;
  baseTree: string;
  headTree: string;
  commits: { oid: string; parents: string[] }[];
  files: ChangedFile[];
  hunks: HunkEntry[]; // ordered; position is the ordinal in 12.32
  noNetChange: { path: string; commits: string[] }[];
  graph: GraphFacts;
  gaps: Gap[];
  diffSha256: string; // the consolidated diff, for rebuild checks
};

type ChangedFile = {
  path: string;
  oldPath: string | null;
  oldOid: string | null;
  newOid: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "type-changed";
  added: number;
  deleted: number;
  binary: boolean;
  commits: string[];
  declared: { kind: "generated" | "test" | "doc"; by: string }[];
  area: string;
  hunks: [first: number, count: number];
};

type HunkEntry = {
  hunkId: string;
  contentKey: string;
  file: number;
  kind: "text" | "binary" | "metadata";
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ownedRanges: OwnedRange[];
  textSha256: string; // the text itself is not stored
  enclosing: { symbols: string[]; language: string } | null;
};

type GraphFacts = {
  profile: "full" | "syntax-only";
  relations: GraphRelationObservation[];
  byHunk: Record<string, number[]>;
  dropped: { hunkId: string; count: number }[];
};

type Gap = {
  kind:
    | "graph-unavailable"
    | "unreadable-text"
    | "over-bound"
    | "source-gone"
    | "rebuild-mismatch";
  path?: string;
};
```

Commit messages and file lists per commit come from Git through the reader. A session's drilldowns are recorded as a commit hash and path.

## The reader's surface

The surface is a proxy to `git diff` and `git show` for one range. It refuses commits outside the range.

```ts
interface RangeReader {
  snapshot(): Promise<RangeSnapshot>;
  diff(options?: { paths?: string[] }): Promise<string>; // consolidated, for the range
  hunk(hunkId: string): Promise<string>;
  // Short hash and title, or with the message too. Never the author (12.49). Pages past the limit.
  log(options?: {
    commit?: string;
    paths?: string[];
    format?: "oneline" | "message";
    cursor?: string;
  }): Promise<{ lines: string[]; remaining: number; cursor?: string }>;
  commit(
    oid: string,
  ): Promise<{ subject: string; body: string; files: string[]; diff: string }>;
  commitFile(oid: string, path: string): Promise<string>;
  blob(
    oid: string,
    options?: { headBytes?: number },
  ): Promise<Uint8Array | undefined>;
}
```

Code that works on hunk text today keeps a text-bearing hunk in memory. The reader fills it in from the stored entry when a stage loads the range, so the change is in what's stored, not in each stage.

## Rules

- **A rebuilt diff must match.** The same range has to produce the same bytes, because `hunkId` and `textSha256` are hashes of the text. The recipe fixes every setting that alters the output, and `diffRecipe` names it. A mismatch is reported as a `rebuild-mismatch` gap. It never attaches the wrong text to a stored hunk.
- **Missing source is stated, not hidden.** If the objects are gone anyway, the review's findings, dispositions and comments still show, with a `source-gone` gap in place of the code. Comment anchors keep their quoted lines ([`ReviewCommentAnchor`](../../packages/records-schema/src/submission.ts), which a comment needs to stay readable). The review desk already reads its source from Git ([`git-source.server.ts`](../../apps/neuve-web/apps/web/src/server/git-source.server.ts), the precedent for this rule).
- **Unaddressed reviews keep their commits (owner, 12.47).** A review holds a ref on its head, `refs/neuve/reviews/<head>`, from the start of its run. The head reaches every commit of the range, so one ref is enough, and the ref stops Git pruning them after a rewrite. It is released once the review is addressed, and nothing expires it by age.
- **Filtering sets reading order, not coverage.** A model can skip reading a file, but only code removes a file from review, as 12.33's floor does. No Graph edge doesn't mean irrelevant, and an `@generated` marker can be written by anyone.

## Warm cache

- Keys are immutable: object ids, and the range key with its recipe. Nothing is invalidated, only evicted.
- Memory has a byte budget, evicts least recently used first and keeps the active range. The per-review map in NEU-113 needs no eviction; a reader that outlives one review does.
- Identical requests in flight share one read. Bodies are hashed against their id before they are kept.
- An idle reader releases its Git child and its memory. A process restart only costs a rebuild.
- Building the snapshot warms the range's blobs in one batch.
- The range diff blob has an expiry from last read and a total byte cap, evicts oldest last use first, as [Graph's store](0013-graph-search-service.md) does, and leaves no tombstone.
- Hit rate, evictions, peak bytes and rebuilds are in telemetry.

## Measured, 5 November 2026

On the store in the LaCie development checkout (one store, not a sample):

| Records                  | Stored    | Of which text |
| ------------------------ | --------- | ------------- |
| `harness.range-manifest` | 101.3 MiB | 42.6 MiB      |
| `harness.file-hunks`     | 21.2 MiB  | 17.9 MiB      |
| `harness.commit-hunks`   | 0.9 MiB   | 0.6 MiB       |
| **Together**             | 123.4 MiB | 61.1 MiB      |

All durable blobs in that store total 181.8 MiB. The rest of each manifest is mostly leads, which no stage reads (below), and per-hunk detail such as outlines.

On the pi-transition range, `diffTrees`' command gave a diff of about 10 MB and 2,056 hunks, in 0.16 s with the disk cache warm (one run). The same command with one setting changed gave different bytes:

| Setting                      | Hunks | Same bytes |
| ---------------------------- | ----- | ---------- |
| `diff.algorithm=histogram`   | 2,055 | No         |
| `diff.algorithm=patience`    | 2,056 | No         |
| `diff.indentHeuristic=false` | 2,056 | No         |
| `diff.interHunkContext=3`    | 1,916 | No         |

`diffTrees` pins none of these today. Across the 173 real ranges below, 87 changed under at least one of these settings: 73 with `diff.interHunkContext=3`, 25 with `histogram`, 20 with `diff.indentHeuristic=false` and 18 with `patience`.

## What has to change

The snapshot isn't a local swap. These are the parts that read the range today.

| Part                                                                                              | Today                                                                                         | Change                                                                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`                                                                                     | One `RangeManifest` mixes the range's facts with settings, allowances, query text and leads   | Splits into the settings-free snapshot and whatever settings-dependent output still has a reader                  |
| `git-objects.ts`, `git.ts`, `hunks.ts`                                                            | Diff settings come from the person's Git config                                               | One pinned recipe, used by every diff that produces hunks                                                         |
| `records-schema`, `review-rules`                                                                  | `SubmittedHunk.text` is required                                                              | Stays required in memory, filled in by the reader, never stored                                                   |
| `frame.ts`, `review-map.ts`, `find.ts`                                                            | Read manifest hunks                                                                           | Read the snapshot, and take the new first steps below                                                             |
| `lookups.ts` tools                                                                                | `commit` gives a message and file list; `hunk` reads stored text                              | `commit` can give the diff; all read through `RangeReader`, counted in the reading budget                         |
| `verify.ts`, `units.ts`, `sections.ts`, `lane-rule.ts`, `coverage.ts`, `pipeline.ts`, `frozen.ts` | Read `hunk.text`, or sum its bytes                                                            | Read the in-memory hunk. Byte totals come from stored counts                                                      |
| `link.ts`, `compose.ts`, `pi/review-task.ts`, `pi/stages/`                                        | Parse a stored `RangeManifest` by key                                                         | Parse the snapshot by key, with the old format still readable for stored runs                                     |
| `commit-prepare.ts`, `commit-hybrid.ts`                                                           | Store text per commit and per blob pair; `commit.hybrid` embeds `query.text`                  | Store hashes and coordinates; rebuild query text from Git when embedding                                          |
| `recompose.ts`                                                                                    | Runs with a repository already (`--repo`)                                                     | Reads through the reader, and states a gap if the objects are gone                                                |
| `pi/capture/dump.ts`, `packages/evaluation`                                                       | Dumps and `harness-compare` read manifests, hunks and leads                                   | Dumps carry what scoring needs. Exports leave the repository, so they keep their text                             |
| `apps/neuve-web` `git-source.server.ts`                                                           | Runs its own `diffTrees`, with hunk ids by position                                           | Uses the reader and recipe, so the desk and harness can't disagree                                                |
| Review start and cycle end                                                                        | No ref is held, and cycles have no close event                                                | Create the ref at the start of a run, and release it when the review is addressed. Replay's clone checks allow it |
| `records-core` `blobs`                                                                            | Two retention classes                                                                         | A cache class, through a store migration, if the diff blob is built                                               |
| `packages/graph-client`, `apps/neuve-graph`                                                       | Relationship reads take one focus; the harness sends no relationship plan (`graph-search.ts`) | A bounded read of relations for a range's changed symbols. Whether Graph needs a new command isn't checked        |

Two things the fixed shape left behind, found while tracing this:

- **No stage reads `hunk.leads`.** Only telemetry, counts and evaluation do. Leads are 19.9 of the 42.5 MiB in the largest manifest and 14.1 of 31.2 MiB in the 420-commit one, and `harness.hunk-leads` holds 28.6 MiB more. Searching is cheap (median 0.3 s per review), so the cost is storage.
- **Finders wait for the search index.** `index.build` is a median 42 s of a median 43 s Precompute on the 63-case sample, and only the lookup tools need it.

## The first steps of a review (proposal, not decided)

Understand no longer runs as a stage: 12.41 replaced it with Frame and Map, and [the pipeline record](0005-harness-pipeline.md) describes them. What each sees today:

| Step  | Sees                                                                      | Doesn't see                                                                          |
| ----- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Frame | Scope, commit subjects (sampled over 12,000 tokens), counts per area      | Which commit touched what, any code, Graph                                           |
| Map   | The Frame, then file paths with status, tags and up to three symbol names | Commits, any code, Graph. At 1,227 files this is already 28,141 of its 30,000 tokens |
| Find  | The Frame, the groups, and a row per file with hunk ids                   | Any code until it spends a turn on it. It has eleven tool turns                      |

So grouping by intent rests on paths and names, and a finder starts cold. All three steps work from the snapshot (12.48): each file with its consolidated diff or a link to fetch it, and the commits as a flattened map of what touched what. Losing the per-commit view doesn't cost them the connections, because that map still shows which files changed together, and a drilldown to one commit goes through the reader. The proposal, as a trial behind the [12.31 quality guard](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026):

1. **Precompute builds only the snapshot.** The search index builds alongside the front steps, and the first lookup waits for it.
2. **Frame** keeps its job and its one call, and sees the changes, their files and the flattened commit map in place of a sample.
3. **Code precomputes as much of Map's structure as it can** (12.48): candidate groups from Graph relations between changed files, then files the commit map shows changing together, then directories, in a glanceable form for Map to read, so that no agent turn goes on basic structure. Map names them, merges or splits them, ties them to done-when conditions and sets reading order. It stays one call with no tools, as 12.41 fixes, unless the open point in 12.48 changes that. The trial checks that candidate groups don't anchor Map on structure over intent. A range without Graph facts falls back to commits and directories, with the gap stated, so no language or repository setup is assumed.
4. **Each finder starts with a glanceable view of its slice** (12.39, 12.48): what is present in the core groups for its lens and how they relate, with the diffs behind tools, so its first turns go to following the change and it chooses what to open. The form and how much it shows are for the exploration below.
5. **Leads** are either given to finders in that slice or no longer computed.

What reaches an agent (12.48) is the snapshot's content in a form made for reading, not its stored shape: progressive disclosure, an initial view of what is present, and tools to explore the rest. A quick exploration, on stored cases and with context-engineering practice as its reference, checks this doesn't drop quality before much is invested.

Unknowns: whether any of this makes comments deeper, which [12.43's depth measure](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) can show once each part is checked on its labelled sample. The labelled sample tops out at 98 hunks, where code-proposed groups may change little, and the large ranges have no quality labels.

## The initial context (12.49)

The snapshot's stored shape is what code keeps; this is what an agent reads. It is one form for Frame, Map and Find, with a worked example in the prompt showing how to read it. Illustrative lines from the large range below:

```text
Log
242e89b1 Merge cloud review profiling and the effort switch into pi-transition (NEU-111)
… 12 commits
9dde51ad Remove the Assemble and Dispose agents, per-behaviour batches, the old cut-off f…

Groups
G1 228 files +39,479 -27,344
  folders: packages/harness/tests 76 (76 not named), packages/harness/src 69 (68 not named), packages/harness/src/pi/stages 15 (15 not named)
  commits: 9dde51ad 365273dc c60ba337 +191
  hottest: M packages/harness/src/pipeline.ts +194 -3213

Found before this turn
Unchanged files that call into this range: 463
```

- **The log has a token limit.** A log under it is shown whole. Over it, the log keeps the commits that best cover the hottest files, in log order, with each skipped run counted. The `log` tool returns the rest, for a range or a commit. Groups cite only hashes shown in the log, and count the others.
- **Every folder is listed once,** with its total and, when some files are folded, how many are not named: `packages/harness/src 69 (63 not named)`. Paths are written out. Folder keys saved 5 to 6% of the groups' tokens on the measured ranges, and every tool call would have to expand them.
- **Find allocates its opening in order.** Its character limit is 50,000. First reserve the whole Frame, including gaps and section ids. Then reserve group headings, every folder's count and commit citations. If this skeleton exceeds a third of the limit, roll the smallest folders into their parent paths, repeating toward the top level, for example `crates/ide/src/** 3 folders, 40 files`. Then reserve commits by coverage until the reachable files in the hottest tenth are covered, and at least three hottest names per group, or all names in a smaller group. Of the characters left after the Frame and skeleton, the log may use up to 30%. Its coverage floor can exceed that share; the log stays capped at 16,000 characters. Names get the rest. Either section lends space it cannot use to the other.
- **Fold, never drop the Frame or skeleton.** Names and log entries may be counted instead of shown; folder rollups always retain a path and totals. If the Frame and resulting skeleton cannot fit, the log becomes its commit count, names become zero, and one line states the exact character overrun. Preserve the whole Frame and group totals even when the opening must exceed its limit.
- **No authors.** Agents don't need them to review. Code attaches the author from Git to what is shown as a concern or attribution, so it is deterministic and can't be invented.
- **Found before this turn holds pointers with their source,** never pasted text. It starts with Graph callers and scope. Keyword results join once they are filtered: summed over hunks they returned `bun.lock` and a raw benchmark file.

Opening tokens with the o200k tokenizer, with the log whole:

| Range              | Map today | Each finder today | Log    | Groups | Together |
| ------------------ | --------- | ----------------- | ------ | ------ | -------- |
| Small, 16 files    | 323       | 1,035             | 48     | 304    | 378      |
| Medium, 256 files  | 6,984     | 15,569            | 3,035  | 1,971  | 5,036    |
| Large, 1,216 files | 19,474    | 14,608            | 13,067 | 3,728  | 16,830   |

The first version runs on Find only, ranking by lines changed. Measured on `rust-lang/rust-analyzer`, 513 commits and 500 files, one review on each build with no labels, so this shows reach and cost, not quality:

- Provider input was about equal: 1,432,478 tokens before and 1,438,573 with it. Published findings were 7 each. They landed in 5 distinct files before and 9 with it.
- All finders together opened 30 and 31 distinct files, but the opened files moved up the ranking: median rank 110 before and 62 with it, out of 500.
- Finders opened files the opening names: 54 of 55 per-finder file opens, and 246 of the 281 named were opened by no finder. So what is folded is close to invisible, and which files are named decides what gets reached.
- Finders opened about half as many core hunks in full, 33 against 70, and read more whole files, 55 reads against 25.
- The `log` tool wasn't called on this range, and was called 3 times across five replay reviews, which have one commit each.
- Context is not the limit: the worst whole-finder context recorded is 62,891 tokens, about 13% of Sol's usable window.

At the 50,000-character budget, on the same range and on a much wider one of 6,808 commits and 1,935 files, one review each. The widest opening named 489 files, counted 1,435 in their folders, showed 151 log lines, covered all 193 of the hottest tenth, needed no rollups and stayed within its limit. It took about 19,300 input tokens per finder. The largest whole-finder context was 52,871 tokens on the same range and 47,432 on the wider one, about 11% and 10% of Sol's usable window. On the wider range, finders mostly read whole files and opened few hunks in full: 2 of its 5,437 core hunks.

On five labelled replay cases the two builds caught the same 1 of 21 concerns, which is too few to show a gain or a loss.

## What hottest means

Hottest is a ranking of a range's changed files, and through them its commits. It decides which files a group names and which commits the log keeps when either must be folded. The code that computes it carries a comment pointing here, so this stays the one definition.

- **A file's rank** is its position by lines changed plus its position by Graph relations to other changed files, lowest first. Without Graph facts, the rank is lines changed alone, and the gap is stated.
- **The log's selection** repeatedly adds the commit whose files add the most uncovered heat, until the token limit. A commit's heat is its files' heat, so a commit that sweeps many files doesn't win on size alone once its files are covered.

Why, from 11 real pull requests, 185 files and 42 that people commented on, the share of commented files in the first quarter of each order: path order 23%, chance 28%, Graph alone 49%, size and Graph 51%, size alone 54%. Size alone and size with Graph are too close to separate on 42 files. Both are kept so that a small change to a central file isn't buried. No pull request there exceeds 33 files, and a comment isn't a defect.

The log's selection, on the large range with a 2,000-token limit, by the share of the hottest tenth of files that a shown commit touches: newest first 48%, a contiguous window 70%, picked by coverage 100%. At 1,000 tokens on the medium range a contiguous window reached 52% where newest first reached 92%, so a window isn't reliable. Picking leaves gaps in the story, which the counted runs and the `log` tool make up for. Re-measure this definition on larger reviewed ranges before relying on it.

## Tests on real ranges

Why: a snapshot that shifts between builds moves hunk ids, breaks anchors and attaches the wrong text with no error, and hand-written fixtures wouldn't have shown the instability measured above.

**The ranges.** Real history first, with small constructed cases only for what no real range has.

- 173 replay ranges are on disk, from six projects in several languages: at most 8 commits, 24 files, 98 hunks and 75 KB. Among them are 46 with several commits, 8 with merges, 4 with renames, 4 with no-net-change files and 1 with a binary file. None has a symlink, submodule change, non-ASCII path, CRLF, type change or a base that has moved on.
- This repository adds the large ones: 205, 420 and 777 commits, the last with 1,218 files, 119 merges and 24 binary files.

| Tier                  | Runs                                           | Holds                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In `bun run check`    | Every change                                   | About ten real ranges as trimmed object packs, each chosen for a feature, plus constructed cases for the features above. The remote check carries no `.git`, so it can't rely on history. Three trial packs came to 68 to 780 KiB against 4.7 to 248 MiB of history; that a snapshot builds from one is still to prove, and third-party licences need checking |
| Range gate, no models | Before each stage lands                        | All 173 ranges and the three large ones, from their clones                                                                                                                                                                                                                                                                                                     |
| Replay, with models   | The storage cut and the first-steps trial only | The 63-case sample against 12.42's guards. Modal credits are tight, so each case runs once                                                                                                                                                                                                                                                                     |

**What every range must satisfy:**

- **Same bytes.** Two builds match, and still match under hostile settings: the four above, `diff.context`, `diff.noprefix`, `color.ui`, `core.quotePath`, `core.attributesFile`, `info/attributes` and `diff.orderFile`.
- **Same as today.** `hunkId`, `contentKey`, coordinates and owned ranges match today's manifest on default settings, so stored anchors keep resolving.
- **Round trip.** Stored snapshot plus Git gives back every `textSha256` and `diffSha256`, and each hunk's text is the right slice of the diff.
- **Agrees with Git.** Files, counts and statuses match `--raw` and `--numstat`; every changed line sits in exactly one hunk; `commits` and `noNetChange` match `git log`.
- **Reader answers.** `commit`, `commitFile` and `blob` match `git show` and `cat-file`, a commit outside the range is refused, and warm answers equal cold ones through eviction and restart.
- **The ref holds.** A reviewed range still rebuilds after a rewrite and `git gc --prune=now`, and is prunable once released.
- **Failures are stated.** Pruned objects give `source-gone`, a changed hash gives `rebuild-mismatch`, and no Graph gives `graph-unavailable`, each with no wrong text.
- **Size holds.** Snapshot bytes per hunk and Map's token bound are recorded across range sizes, so growth shows in review.
- **Graph facts.** The same generation gives the same facts, across at least the six projects' languages.

The Git versions a review can meet also need checking, from 2.42 up. Only 2.54 is on this machine.

## Build order

1. **Land NEU-113.**
2. **Pin the recipe and add the range tests.** Output on default settings doesn't change, so this is safe alone, and it's already a defect on main.
3. **Build the snapshot and reader in shadow.** Built beside the manifest and compared on every range. Nothing reads it yet.
4. **Move the readers,** per the table above, one at a time, including the desk.
5. **Cut storage.** Hold the review ref first, since text stops being stored here. Then stop writing text, query text and unread leads, migrate the store, then decide on pruning old rows and on the diff blob.
6. **Trial the first steps.** This comes last. It also fixes what Graph facts the snapshot must carry, so settle those before step 3 and treat later additions as a format bump.

## Consequences

- Revises [8.10](../../process/decisions.md) and the Retention line of [0004](0004-persistence-and-range-immutability.md) for hunk text only: Git can always rebuild it while the objects exist, so it isn't an output to keep. Everything a model or person wrote stays durable.
- A new retention class needs a store migration: the `blobs` table allows only `durable` and `raw-capture`.
- Computations are append-only, so a new `opVersion` stops new text being stored but doesn't remove what's there. Old text stays until something prunes it.
- Blob writes upgrade a blob to `durable` when the same bytes are stored as durable, so the diff blob must not share a hash with a durable blob.
- Records live in `.git/neuve`, so deleting the repository removes both, and a fresh clone has neither. The case that matters is a commit rewritten away: without a ref, by Git's defaults, it stays for at least 30 days in the reflog and then two weeks before pruning, and a person's settings can shorten that.
- A held ref keeps everything those commits hold in the person's local repository, including a secret that was rewritten out, until it is released. In a scratch repository, a held commit survived `git gc --prune=now` and went once released. A default push and a normal clone didn't carry the ref; `git push --mirror` did, so a mirror needs telling.
- The replay's clone check requires `refs/heads/replay` to be the only ref (`verify_clone.py`, `prepare.ts`), so it must allow review refs or a recompose's re-check could refuse its clone.

## Open

- What "addressed" means for releasing the ref. The working rule is that the review's cycle has ended, meaning every needed disposition is given, as [the vocabulary](../../vocabulary.md) defines a cycle's end. Cycles have no close event yet (10.79), so the rule needs one or a check over Records. Whether unanswered comments, or a later cycle that uses this one as context, keep the ref is also open.
- How an abandoned review, such as one on a deleted branch that nobody addressed, lets go of its ref. Age doesn't, so it likely needs a person's explicit release, which also covers removing a secret.
- The diff blob's expiry and cap. One day from last read is the starting proposal.
- Whether the diff blob is worth its migration. Rebuilding looks cheap, so measure a cold rebuild on a worker before building it.
- Evaluation exports leave the repository, so they must carry whatever text they score against. `packages/evaluation` reads stored manifests' hunks; which fields it needs isn't checked.
- `harness.blob-chunks` (20.5 MiB) and `harness.hunk-leads` (28.6 MiB) weren't examined for text Git could rebuild.
- `hunkId` stability across Git versions, how files split between units, and where a reader lives between reviews.
- The [first steps' proposal](#the-first-steps-of-a-review-proposal-not-decided), and how Graph supplies relations for a whole range. Reading them took about 35 seconds per side of a range across this repository, so they need caching.
- The log's token limit in the [initial context](#the-initial-context-1249), and whether Map gets tools, which 12.41 doesn't allow today.
- The name, against the [cycle's preparation snapshots](../../foundations/02-review-modes-and-cycles.md#cycle-attribution-and-immutable-preparation-snapshots), which mean something else.
