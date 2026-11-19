# Stack context: design proposal

Historical proposal. Its review-stage graph and budgets are superseded by the [fixed-shape pipeline record](../../architecture/decisions/0005-harness-pipeline.md), which describes the NEU-111 trial. The [owner's decisions](../decisions.md) remain authoritative for accepted product meaning and the other topics below.

Status: proposal, drafted 20 October 2026 for [decision 11.14](../decisions.md#area-11-verification-and-review-delivery-19-october-2026), which lets reviewers and implementers search the sources of the stack a repository uses and leaves its design open until the owner rules. Revised the same day after an independent review. Nothing here is built. The [decisions record](../decisions.md) wins wherever this text differs from it. The shape follows the [M3 harness proposal](m3-harness.md): starting facts, conflicts that need a ruling, numbered decision rows (SC1–SC13) with options, a recommendation and its basis, slices, and a decision list. "Unverified" marks something not checked.

**What prompted it.** In the held-out M4 case `neuve_effect:24f1c2d3..234bd935`, a new 94-line `apps/home/src/routes/__root.tsx`, the adjudication council judged TanStack Start's root route on its meta tags and paths without recognising it as framework scaffolding ([11.13](../decisions.md#area-11-verification-and-review-delivery-19-october-2026), which adds "understand what you are looking at first"). The reviewer had nothing to compare it with. The range's head pins `@tanstack/react-start` 1.168.6, published from TanStack/router commit `ee8a6753`, the same commit that published the `@tanstack/react-router` 1.170.4 it also pins, so one upstream tree serves both. That tree holds TanStack's own `examples/react/start-basic/src/routes/__root.tsx`. The published package does not: `@tanstack/react-start` ships `src/`, `dist/` and `skills/` only (measured on 1.169.3, below).

**Words.** Product words follow the [vocabulary](../../vocabulary.md). The following are internal implementation words, not product terms; none appears in the review desk without the owner's approval (SC9): _stack_ (the packages a repository's manifests and lockfiles resolve to, 11.14's word); _stack entry_ (one package at one resolved version); _stack sources_ (what is fetched for an entry: its published package contents and, where its commit is known, the upstream tree at that commit); _upstream tree_ (the source repository's tree at that commit); _stack store_ (where stack sources live); _stack state_ (the set of entries a repository revision pins, with which of them are ready); _ecosystem capability_ (a declared reader for one manifest and lockfile family, the way [`chunker.ts`](../../packages/harness/src/chunker.ts) declares parsing capabilities); and the three _source levels_, _package contents_, _attested upstream_ and _registry-stated upstream_ (SC4). If the desk ever shows the source levels, their wording is new product copy for the owner to approve.

## At a glance

```
neuve setup stack, or a commit that changes a declared lockfile
  │
  ├─► ecosystem capabilities read pins from git objects at the revision (name, version, registry, hash)
  │
  ├─► stack.fetch job (background slot, nice 10, behind the heavy-work gate, inside the head-only budget)
  │      registry package over HTTPS, hash checked against the lockfile ─┐
  │      upstream tree at the commit, depth 1, into a quarantine store   ─┼─► extract: no scripts, no links,
  │                                                                       │   no .git parts, no collisions;
  │                                                                       │   read-only files + git objects
  ├─► stack.index job: a persisted index per entry, in the store, outside Records
  │
  ├─► harness: the cycle freezes its stack state; the range manifest records it
  │      Understand: stack_list · Investigate and Dispose: stack_list, stack_search, stack_read
  │
  └─► inner loop: `neuve stack list` prints read-only paths; skills say how and when to read them
```

## Starting facts

| Finding | Evidence |
| --- | --- |
| Every harness read goes through git objects at the range's revisions; untracked and ignored files are never read (10.34) | [`lookups.ts`](../../packages/harness/src/lookups.ts), lines 48–60; [M3 proposal §3.1](m3-harness.md#31-tools) |
| The BM25 index is assembled per tree OID from per-blob computations that `blobChunks` writes into the repository's own Records computation and blob stores; the assembled index lives only in memory, for the last 2 trees; it is built when a run first asks for it. Submodules, symlinks, binaries and files over 1 MiB are left out and counted | [`search-index.ts`](../../packages/harness/src/search-index.ts), lines 30–44, 133–143, 183–226, 356 and 502 |
| Parsing capabilities declare, as data, the path suffixes they read and the language they report; two exist (ECMAScript symbols, Markdown sections) | [`chunker.ts`](../../packages/harness/src/chunker.ts), lines 94–128 |
| A declared reader already reads `package.json` by name, behind a declared boundary; no reader declares lockfiles | [`declarations.ts`](../../packages/harness/src/declarations.ts), lines 7–24, 43 and 197 |
| A handle names a region by blob, path, revision and commit, with its lineage; its revision is `head`, `base` or `lead-tree` | [`lookups.ts`](../../packages/harness/src/lookups.ts), lines 74–95 |
| The ledger's source origins are repository, scope excerpt and same-batch (history in pass 2) | [M3 proposal §3.2](m3-harness.md#32-the-evidence-ledger-and-context-growth-control) |
| Tools per stage are ruled: Understand has no search (10.40); Dispose has `read` and its pagers; the tool rules were accepted with 10.77 | [M3 proposal §3.1](m3-harness.md#31-tools) |
| The worker's background slot starts no new heavy subprocess while a review runs (the heavy-work gate); job kinds are a closed list | [`worker.ts`](../../packages/records-core/src/worker.ts), lines 55–72; [`operational.ts`](../../packages/records-schema/src/operational.ts), lines 24–31 |
| User-level settings live outside any repository, at a path built from the home directory only | [`settings.ts`](../../packages/harness/src/settings.ts), lines 14–23 |
| `neuve mcp` serves `vent` and `record_proof`; with `--review-range` it serves the harness's read-only range tools to the ACP route | [`mcp.ts`](../../apps/neuve-cli/src/mcp.ts), lines 19–28 |
| The reviewer skill already tells reviewers to read the stack's sources when unsure, but nothing provides them | [review-against-scope skill](../../.agents/skills/review-against-scope/SKILL.md), line 12 |
| H8 (Dispose and Publish) has landed; H9 (judging) is next | plan, M3 row, commit `aa7dd5a3` |
| This repository's `bun.lock`: 1,039 packages over 14 workspaces; 62 external direct dependency names, which are 64 entries under SC4's rule, because `typescript` and `prettier` are pinned at two versions each. The 62 names' installed contents take about 215 MiB on disk (`du`), about 180 MiB of actual file size; the 64 entries about 249 MiB on disk. The largest are `effect` (53 MiB), `lucide-react` (44), `storybook` (22) and `prettier` (10). The store keeps both extracted files and git objects (SC2), so disk use is higher than these figures. No entry here records a non-default registry | Measured 20 October from `bun.lock` and `node_modules/.bun`, read-only, and checked by the review |
| `effect@4.0.0` takes about 33 MiB of `dist/` and 20 MiB of `src/` on disk, with `ai-docs/`, `AGENTS.md` and `CLAUDE.md`: about as many indexable files (2,557) as this repository's tracked tree (2,571 blobs under 1 MiB). `neuve_effect` pins `effect` 3.x, so the two repositories share no `effect` entry | Same; `neuve_effect/bun.lock` |
| This repository's TanStack entries come from three upstream trees: `react-start` 1.168.58 and `react-router` 1.170.39 at `ddad69a4`, `router-devtools` 1.167.2 at `6954a370`, and `router-cli` 1.167.38 at `84bde660` | npm provenance, checked by the review |
| `@tanstack/react-start@1.169.3`: 92 files, 106 KB unpacked; `repository` names `TanStack/router` with `directory: packages/react-start`; no `gitHead`; an SLSA v1 provenance attestation names the release workflow and commit `caaf32da`. The upstream tree at that commit is 12,491 blobs, 43.2 MiB (packages 12.9, e2e 11.6, examples 11.4, docs 3.2), with one symlink, no submodules and 2 blobs over 1 MiB; `examples/react/start-basic` is 222 KiB and `docs/start` 657 KiB | `registry.npmjs.org` metadata and attestation, the tarball's listing, and GitHub's tree API, fetched 20 October; nothing executed |
| A depth-1 fetch with `--filter=blob:limit=1m` into a bare store does not keep the filter: `git ls-tree -r -l` (what the harness's `lsTree` runs) fetched the omitted 2.2 MB blob from the remote and started `git maintenance run --auto --detach`. With `GIT_NO_LAZY_FETCH=1`, `ls-tree -l` prints the size as `BAD` and `cat-file` reports the blob missing | The review's experiment, 20 October |
| Packages increasingly ship material for agents: TanStack's packages ship `skills/<name>/SKILL.md` through TanStack Intent (alpha, self-reported), and Effect ships `ai-docs/` | [TanStack Intent](https://tanstack.com/intent/latest); the package listings above |
| npm: `repository` may carry `directory` for monorepos; `.git`, `.npmrc`, `node_modules` and lockfiles are never published. Provenance is signed through Sigstore and logged publicly, only from GitHub Actions or GitLab CI/CD cloud runners, and "does not prove a package is free of malicious code" | [package.json docs](https://docs.npmjs.com/cli/v10/configuring-npm/package-json); [provenance docs](https://docs.npmjs.com/generating-provenance-statements) |
| Go: the module proxy serves `.info`, `.mod` and a source `.zip` per version (zip at most 500 MiB, files under `$module@$version/`); `.mod` and `.zip` are checked against `go.sum` and the `sum.golang.org` transparent log; `go-get=1` meta tags map a module path to its repository. `.info` for `spf13/cobra` v1.8.0 carries an `Origin` with VCS, URL, `refs/tags/v1.8.0` and the commit hash | [Go modules reference](https://go.dev/ref/mod); `proxy.golang.org`, fetched 20 October |
| Rust: a `.crate` is source, with `.cargo_vcs_info.json` giving the git `sha1` and `path_in_vcs`, but "the provenance of the package is not verified" | [`cargo package`](https://doc.rust-lang.org/cargo/commands/cargo-package.html) |
| Python: PyPI publishes sdists and wheels, and `project_urls` names the repository. PEP 740 attestations bind a file's digest to a Trusted Publisher identity (repository and workflow); the attestation's predicate carries no commit, which appears only in the signing certificate's extensions | [PyPI attestations](https://docs.pypi.org/attestations/); `pypi.org/pypi/fastapi/json`, fetched 20 October; the review's check |
| Bun's text `bun.lock` is the default since Bun 1.2. Each package entry is `["name@version", "<registry, or empty for the default>", {metadata}, "sha512-…"]` | [Bun lockfile docs](https://bun.sh/docs/install/lockfile); entry layout read from this repository's lockfile |
| A pull request can repoint a lockfile entry at a malicious tarball; reviewers miss it because lockfile diffs are large and collapsed. The mitigation is to accept only HTTPS URLs from allowed hosts | [Snyk on lockfile injection](https://snyk.io/blog/why-npm-lockfiles-can-be-a-security-blindspot-for-injecting-malicious-modules/) |
| A crafted repository's submodules could run a hook during a recursive clone (CVE-2024-32002, fixed in Git 2.45.1 and backports such as 2.42.2); disabling symlinks prevents it | [Git advisory](https://github.com/git/git/security/advisories/GHSA-8h77-4q3w-gfgv) |
| `git clone` takes a tag for `--branch`, a shallow `--depth`, a partial-clone `--filter`, `--sparse` and `--bare` | [git-clone](https://git-scm.com/docs/git-clone) |
| A JavaScript repository that is installed already has its packages' contents in `node_modules`, but that is ignored working-tree state (10.34), may not match the reviewed revision, and has no upstream examples or docs | This repository's `node_modules/.bun` |

## Conflicts with existing rulings

Each needs the owner's ruling; the rows below recommend one.

| # | Conflict | The tension | Recommended ruling | Row |
| --- | --- | --- | --- | --- |
| X1 | 11.14's "next to the repository" against 8.6 and 6.10 | 8.6 puts Neuve's data in `.git/neuve/` plus a user-level list. A sibling folder writes into a directory Neuve owns nothing in (for example `~/code/`), is shared by sibling repositories without an owner, and duplicates entries across clones | A user-level stack store, keyed by entry, with each repository's pins in `.git/neuve/`; the literal sibling folder stays an option | SC2 |
| X2 | 10.34: the harness reads only git objects at the range's revisions | Stack sources are not tracked work of the repository under review | Amend 10.34: a second, declared read surface, stored as git objects and read only at a frozen stack state, never a working tree | SC5, SC8 |
| X3 | 10.52 and 10.5: a commit in a reviewed range cannot change what the worker starts or where it connects | A lockfile changed on any branch names packages to fetch | Fetch only from hosts the ecosystem capability or the user's own settings declare, on URLs Neuve builds, never a URL from the lockfile; entries the default branch does not pin share one small budget on every fetch path | SC7 |
| X4 | 3.6 and 3.8: the semantic layer indexes code and local docs; separate indexes are queried separately | Stack sources are neither | A separate stack index, never merged into `search` or the preloaded leads (10.43, 10.84), so M4's comparisons stay intact | SC6, SC8 |
| X5 | 10.40 and 10.77: ruled tool sets per stage | Understand has no search; Dispose has only `read` and pagers | Understand gains `stack_list` only; Investigate and Dispose gain the three stack tools | SC8 |
| X6 | 10.15 and 10.26: ten minutes per review run | Fetching and indexing a large entry does not fit in a run | Fetch and index only in the background; a run uses what is ready and discloses the rest | SC1, SC6 |
| X7 | 10.5's reading of credentials | 10.5 already allows the user's own environment credentials, passed only to the call that needs them, so private registries are allowed in principle. The risk is that a reviewed lockfile could aim a credentialed request | Not a conflict in the letter: public fetches only in the first build; private registries later, with credentials named per host in user settings, as 10.52 names integration variables | SC7 |
| X8 | 9.58 and 11.13: held-out parity | Re-running the prompting case is the obvious demonstration | Re-run it once for the owner to read, never scored and never used to tune | SC13 |
| X9 | 10.8, 10.14 and 10.24: stored turns are masked captures kept under raw-capture retention | Replacing stack result bodies in captures with handles would make captures depend on a store that can lose entries (SC6) | Keep stack result bodies in captures like any tool result, masked by the same rules; no handle-only exception | SC7 |
| X10 | 10.71 and 10.72: H9's judging is ruled (one packet, M4 scores, the decide-then-reveal sheet) | Comparing Dispose with and without stack tools adds an arm to H9 | Either the owner adds that arm to H9, or it runs as ST2's own judging after H9 | SC13 |
| X11 | 5.4: never recompute; a rerun of the same range reuses its computations | A stack that was partly ready at the first run and fuller at a rerun would give the same range different context | The cycle freezes its stack state at its first run, as 10.53 freezes the scope snapshot; reruns in the cycle use it; the next cycle takes the new state, with the entries that became ready disclosed | SC8 |
| X12 | The architecture's Reuse layer and [record 0004](../../architecture/decisions/0004-persistence-and-range-immutability.md), which make Records' computation store the one home for computations such as retrieval results, and 8.6, which keeps a repository's store in its `.git/neuve/` | The stack store's persisted index is a second home for retrieval computations, at user level and shared across repositories | Accept a third kind of persistence, a rebuildable user-level cache of third-party inputs and what is derived from them, which Records references by tree OID and recipe but never holds; record it in a new architecture record (0012), because 0004 says persistence has exactly two kinds and the layer table names one home for computations | SC2, SC6 |

## SC1. The install step

| | A. Inside `neuve setup` | B. Inside `neuve setup hooks` | C. A new `neuve setup stack`, which `setup hooks` runs at its end (recommended) |
| --- | --- | --- | --- |
| Who runs it | Users of the Graph setup only | Everyone who enables capture | Everyone who enables capture, and anyone on its own |
| Consent | Hidden in graph indexing | Hidden in hook installation | Its own lines in what `setup hooks` prints (what it will fetch, the caps), and `--no-stack` |
| Undo | None | Bundled with the hooks uninstall (8.18) | `neuve setup stack --off`, which removes the repository's pins and lets eviction reclaim disk |

**Recommendation: C.** The command reads pins, writes the repository's stack manifest, enqueues a `stack.fetch` job in the background slot and returns at once (6.9: no long work in the foreground). **Refresh:** `commit.prepare` enqueues `stack.fetch`, keyed by the lockfile blobs, when a commit changes a file an ecosystem capability declares; a review request does the same for a base or head whose stack is not ready. Every path draws on the same head-only budget (SC7). Branch switches have no hook, so a stale pin is caught at the next commit or review. **Opt-out:** per repository (`--no-stack`, recorded in `capture.json`), and per user (`stack.enabled` in user settings, which also holds the caps and extra hosts). **Basis:** fetching is network and disk work the user should see named; capture is already the per-repository opt-in (8.6), and the background slot already bounds this kind of work (10.31).

## SC2. Folder layout and location

| | A. Sibling `<parent>/.neuve-stack/<name>@<version>` (the owner's example) | B. User-level store, shared across repositories (recommended) | C. Per repository, `.git/neuve/stack/` |
| --- | --- | --- | --- |
| Sharing | Between siblings in one parent only, implicitly | Across every repository; one copy per entry | None, except worktrees of one clone |
| Disk | Duplicated per parent folder | Least: each entry stored once for every repository | Duplicated per clone |
| Isolation | Writes in a folder Neuve does not own | Neuve's own cache folder; read-only files | Inside Neuve's own folder (8.6) |
| Seen by agents in containers | Only if the parent is mounted | Only if the store is mounted | Yes, with the repository |
| Lifetime | Unclear who deletes it | One eviction policy (SC6) | Dies with the clone |

**Recommendation: B**, at `~/Library/Caches/Neuve/stack/` on macOS and `~/.cache/neuve/stack/` elsewhere, built from the home directory only, as [`settings.ts`](../../packages/harness/src/settings.ts) builds the settings path. Layout:

- `trees/<tree OID>.git/`: one small bare repository per tree, written once and never repacked, garbage-collected or checked with `fsck`. A package's tree is built from its extracted files, so it is self-contained: each blob is written with `git hash-object -w --no-filters`, and the tree with `git mktree` (or `update-index --index-info` from those blob IDs), never with `git add` or `update-index --add` on paths. Path-based adds let the package's own `.gitignore` and `.gitattributes` change what is stored; the review saw a file dropped and CRLF line endings turned into LF. An upstream tree keeps the filtered pack its fetch produced, with git's `.promisor` marker and a promisor remote whose URL is unreachable (SC5).
- `src/<ecosystem>/<name>@<version>/` and `upstream/<host>/<path>@<commit>/`: read-only extracted files of both package contents and upstream trees, for inner-loop agents and plain tools. The caps count these and the repositories together.
- `index/<tree OID>/`: each entry's persisted search index (SC6).
- `quarantine/`: temporary stores for fetches in progress, deleted on every ending.
- Each repository keeps its pins (entries per revision) in `.git/neuve/stack.json`, and is already in the user-level list (8.6), which eviction reads.

**Why one repository per tree, not one shared object store.** A shared store would keep blobs shared between versions once, but it cannot reclaim disk: once a filtered tree sits in a store without a promisor, `git repack` fails and `fsck` reports the store corrupt, and with a promisor every eviction needs a store-wide repack and prune, a heavy job over gigabytes. With one repository per tree, eviction deletes a directory, nothing is ever repacked, and a damaged tree damages only itself. The cost is that versions no longer share blobs: this repository's three TanStack trees are stored three times, within the upstream cap (SC3).

**Basis:** the store is a cache of public, immutable inputs keyed by name, version and hash, so sharing across repositories is safe; a refetch is checked against the same hash, so it is the same content when it succeeds (SC6 covers when it cannot). This departs from the letter of 11.14's "next to the repository" (conflict X1). **Open:** devcontainers that mount only the repository see neither A nor B; whether `setup stack` should also offer C for such setups is the owner's call.

## SC3. Which stacks

| | A. Every dependency in the lockfile | B. "Frameworks" only | C. Every direct dependency's package contents; upstream trees ranked by use (recommended) |
| --- | --- | --- | --- |
| This repository | 1,039 packages | Needs a definition of "framework" | 64 entries, about 249 MiB on disk before the store's second copy |
| Neutrality | Neutral | A list of frameworks breaks the constitution; size is a poor proxy (`typescript` is large and appears in few source files) | Neutral: selection by declared dependencies and observed use |
| Covers the prompting case | Yes | Only if TanStack Start is on the list | Yes |

**Recommendation: C.** Fetch the package contents of every direct dependency (runtime, development and optional, across workspaces; workspace and linked packages are the repository itself and are skipped). Fetch upstream trees for the entries most used, in rank order, until the **upstream cap** is reached: at most 10 distinct upstream trees per repository and 1 GiB of upstream disk in the store (files plus objects), entries that share a tree counting once.

**Ranking.** One bounded `git grep` per revision, behind the heavy-work gate: `git grep -F -l` over the revision's tree for the quoted reference forms each ecosystem capability states for its entries (for an ECMAScript package, its name as a quoted specifier and as a quoted specifier followed by `/`; a Go import path; a crate name), with 2 threads, at nice 10 and with its output capped. Each entry's rank is the number of tracked files that match its forms. At review time, a direct dependency that a changed file references and that lacks an upstream tree is queued, and disclosed if not ready. Transitive dependencies are excluded; **open:** whether a direct dependency that only re-exports another (for example a framework's adapter) should pull that one in. **Basis:** no category of "framework" is needed. The reviewer judges what a file is from evidence (11.13, 10.23), and use in this repository is that evidence. Size alone would pick `lucide-react` (44 MiB of icons) over most of the stack, which is why use ranks upstream trees and package contents are cheap enough to take for all.

## SC4. How the stack is detected

**Readers.** Each ecosystem is one capability that declares, as data: the manifest and lockfile names it reads (as the existing reader declares `package.json`), how it parses them, its default registry host, the hash it verifies, and the reference forms SC3 counts. Product code iterates capabilities and names no ecosystem. A repository whose lockfile no capability reads gets one disclosed gap ("no capability reads this lockfile"), never a guess. Readers read git objects at the revision (10.34). The first capability is `bun.lock`, which this repository and `neuve_effect` use; npm, pnpm, Yarn, `go.sum`, `Cargo.lock` and `uv.lock` follow as their own slices (ST4).

**Version pinning.** The exact resolved version, registry and hash from the lockfile, never a manifest range. A manifest without a lockfile pins nothing and is disclosed. Several versions of one package in different workspaces are separate entries.

**Registries.** An entry whose lockfile record names a registry other than the capability's default, or whose repository declares another default registry in its committed registry configuration, is a disclosed gap and is never looked up on the public registry under the same name. That configuration is read at the revision for its registry host only, never for credentials, and user-level configuration is not read at all. Looking a private name up publicly is how dependency confusion works: a public package with a private package's name. **Open risk:** whether `bun.lock` records an empty registry (the default) for packages resolved through a default registry the user set outside the repository, such as a private mirror. If it does, Neuve would look those names up on the public registry; the hash check refuses the content, but the lookup has already disclosed the name. Until this is checked, a user setting can declare that the user's default registry is not the public one, which turns every such entry into a gap.

**Source location.**

| | A. The manifest's `repository` field and a tag guessed from the version | B. Registry metadata, ranked by how much each field proves (recommended) | C. Provenance attestations only |
| --- | --- | --- | --- |
| Coverage | High, but tags vary (`v1.2.3`, `name@1.2.3`, none) | High | Low: npm and PyPI only, and only from supported CI |
| Trust | Low | Each source labelled | Highest |

**Recommendation: B.** The package contents always come from the registry and are checked against the lockfile's hash: source level _package contents_. The upstream commit is taken, in order, from:

1. **Attested upstream:** an attestation that passes real Sigstore verification. That means the bundle's certificate chains to the Sigstore root, its transparency-log inclusion proof checks, the signed subject's digest equals the fetched package's digest, and the certificate's identity names the same repository the registry metadata names. The commit is read from what was verified: the SLSA predicate's `gitCommit` for npm, or the certificate's source-commit extension for PEP 740, whose predicate carries none. Anything short of this is not _attested_.
2. **Registry-stated upstream, unverified:** registry-supplied fields (the Go proxy's `.info` Origin hash, Cargo's `.cargo_vcs_info.json`, npm's `gitHead`), as Cargo's own docs warn.

The repository URL comes from the same record and the manifest's `repository` (with `directory` or `path_in_vcs` naming the package's folder). **Tags are never guessed** in the first build: no commit means no upstream tree, disclosed. **Basis:** both levels come from the registry rather than from the commit under review, and every citation can say which it is (SC9). Verification needs a Sigstore client library, which ST2 must pass under the repository's release-age policy.

## SC5. What gets fetched

| | A. Full clone | B. Shallow, whole tree at the commit | C. Sparse: the package's folder plus docs and examples | D. Published package contents |
| --- | --- | --- | --- | --- |
| TanStack Start example | 119 MB of history; history is pass 2 at most (3.7, 10.3) | 43.2 MiB, holds the example root route | Choosing "docs" and "examples" is a guess by folder name | 106 KB; has no example |
| Verification | Commit ID | Commit ID | Commit ID | The lockfile's hash |

**Recommendation: D for every entry, plus B for the entries SC3 ranks.** Docs and examples come with the tree, so no folder names are chosen; the published package's own agent material (`skills/`, `ai-docs/`) comes with D. Entries from one monorepo at one commit share one tree. Documentation websites are not fetched: they are external services, not versioned sources. **Basis:** D is what the repository actually runs and is verified by hash; B is the only place scaffolding templates, examples and docs live; history adds cost without a pass-1 use.

**How B is fetched so the blob filter holds.** A partial clone remembers its remote and fetches omitted blobs on demand, which the review showed `ls-tree -l` does. So:

1. Fetch into a fresh quarantine store: `git fetch --depth 1 --filter=blob:limit=1m --no-recurse-submodules <url> <commit>`, with the transport rules of SC7 and `-c maintenance.auto=false -c gc.auto=0`.
2. Enforce the byte cap with a watchdog, since git cannot cap a fetch. Git starts in its own process group; the job polls the quarantine's size each second and, once it passes the entry's cap or the fetch passes 5 minutes, sends the whole group SIGTERM and, 5 seconds later, SIGKILL, so `git-remote-https` and `index-pack` die with it. The overshoot is about one second of bandwidth. A package download is a single stream Neuve reads itself, stopped at the cap, with a 2-minute timeout. A killed or failed fetch deletes the quarantine and is disclosed.
3. On success, rename the quarantine to `trees/<tree OID>.git/`. The `remote.<url>.promisor` configuration section the filtered fetch wrote, named by the upstream URL, is removed, so the real URL does not stay in the configuration, and its promisor remote's URL is replaced with one that cannot be reached (a `file:` URL to a path that does not exist, which `protocol.allow=never` also refuses), so the filtered pack stays valid to git while a lazy fetch, should one start, fails locally. `maintenance.auto=false` and `gc.auto=0` are set in its configuration.
4. Every git command against a tree repository runs with `GIT_NO_LAZY_FETCH=1` as the first guard. The tree listing accepts `BAD` sizes and missing blobs, counting them as left out by the filter, the way the index counts its other exclusions. The harness's `lsTree` gains that handling for store reads.

## SC6. Bounds (6.10) and the store's index

| Bound | Recommendation |
| --- | --- |
| Disk per entry | Package contents at most 256 MiB unpacked; an upstream tree at most 128 MiB after the 1 MiB blob filter, counted in the quarantine. Over the cap: refused and disclosed |
| Disk in total | 2 GiB by default, set in user settings, counting extracted files, objects and indexes. The upstream share is at most 1 GiB (SC3). This repository's 64 entries take about 249 MiB of package contents before the store's second copy, plus its three TanStack trees and the other ranked trees |
| CPU | `stack.fetch` and `stack.index` run in the background slot at nice 10; extraction, `git fetch`, the ranking grep and index builds start behind the heavy-work gate; git with `-c pack.threads=2`; one stack job at a time per worker |
| Network | One download at a time; HTTPS only; a timeout per request; backoff on 429 and 5xx, as 2.6 asks; the per-entry byte caps enforced while downloading (a registry download stops at the cap; a git fetch by the watchdog) |
| Eviction | Least recently used across repositories when over the total cap, by deleting the entry's tree repository, extracted files and index (SC2); an entry no registered repository pins for 30 days goes first. Never evicted: an entry in a frozen stack state of an open cycle; a cycle with no run for 7 days stops holding its entries, the stand-in 10.79 uses until cycles have a close event. When the entries open cycles hold already exceed the cap, new fetches are refused and disclosed ("stack store full: held by open cycles"), in `neuve stack list` and on the runs that miss them, until a cycle releases its hold. Eviction is not lossless: packages can be unpublished, repositories deleted and commits force-pushed away. A refetch is checked against the same hash, and one that fails is disclosed as "no longer available". What a published package cites survives because the cited excerpt is kept with the context reference (SC9), and captures keep their result bodies (SC7) |

**The index.** `treeIndex` cannot be reused as is: `blobChunks` writes every blob's chunks into the repository's own Records stores, so each repository would recompute and store the same packages; the assembled index lives in memory for only 2 trees, so stack trees would push out the range's own; it is built when a run first asks, inside the 10-minute limit; and the stack is many times larger than a repository's own index (the review estimated about 20 times this repository's). **Recommendation:** a separate store-level index, outside Records:

- `stack.index` builds one index per entry tree in the background, from the same chunker functions and BM25 parameters as the repository's index, and persists it under `index/<tree OID>/` with its recipe (chunker, bounds, BM25). It is a rebuildable cache, so it is never Records data.
- At query time, `stack_search` scores over the frozen stack state by summing the persisted document counts, lengths and term frequencies of its distinct tree OIDs, each counted once (`react-start` and `react-router` share one tree), which gives one BM25 over the union without building a union index. A query uses at most 32 distinct terms, and only those terms' postings are read, so a run's memory does not grow with the stack.
- An entry whose index is not ready answers "not indexed yet" in `stack_search`, while `stack_list` and `stack_read` still work from the objects. Nothing is indexed inside a run.

**Basis:** every bound reuses an existing mechanism (the slot, the gate, the user-level list), and the index keeps the repository's own index and Records unchanged.

## SC7. Isolation and security (2.16, 10.5)

| Risk | Recommendation |
| --- | --- |
| Executing fetched code | Nothing fetched is run, built or installed; no package manager is invoked |
| Extraction | Refuse absolute paths, `..`, symlinks, hard links and device files; refuse any path component that git would treat as `.git` (case-insensitively, and the variants git itself rejects); refuse two paths that collide under case folding or Unicode normalisation, as the Go module zip rules do; cap entry counts and sizes; write files read-only without execute bits. A planted `.git/config` could set `core.fsmonitor` and run a command when an inner-loop agent runs `git status` inside the folder |
| Transports | Neuve builds every URL itself from the capability's host and a validated name (packages) or from the registry-stated repository URL, normalised to `https://<host>/<path>` on an allowed host (git). Git runs with `-c protocol.allow=never -c protocol.https.allow=always -c http.followRedirects=false`; package downloads follow redirects only to hosts the capability declares |
| Git as an attack surface | Git with the CVE-2024-32002 fix (2.45.1, or a patched release such as 2.42.2); no submodules; `-c core.symlinks=false`; hooks off (`core.hooksPath=/dev/null`); system and global config ignored (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`), which also removes credential helpers |
| Environment | Every fetch runs in a scrubbed environment built from an allowlist (a fixed `PATH`, a temporary `HOME`, locale): no `SSH_AUTH_SOCK`, no `GIT_*` other than those set here, no `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` or `NO_PROXY`, no `GIT_ASKPASS` or `SSH_ASKPASS`, and `GIT_TERMINAL_PROMPT=0`. **Open:** a user behind a required proxy gets no fetches until a proxy can be named in user settings |
| Credentials | None in the first build. Requests carry no auth headers. Committed registry configuration is read at the revision for its registry host only, never for credentials (SC4); user-level client configuration such as `~/.npmrc` is never read. Private registries and repositories are disclosed gaps; 10.5 would allow user-named credentials later (conflict X7) |
| A reviewed commit steering fetches (conflict X3) | The lockfile supplies a name, a version, a registry and a hash, never a URL. Fetches go only to the capability's default registry (for `bun.lock`, `registry.npmjs.org`) and git hosts the user lists in user settings (`setup stack` writes `github.com` and `gitlab.com` as editable defaults); anything else is skipped and disclosed. Git, file, link and tarball-URL dependencies are skipped |
| The head-only budget                             | Entries that the default branch's head does not pin are _unvetted_. The default branch is the one the local `refs/remotes/origin/HEAD` points to, read without network; without it, the base branch the review request is attributed to (1.4); without either, every entry is unvetted. Its head is the commit that local ref names now. All fetch paths (`setup stack`, `commit.prepare`'s enqueue, review requests) draw on one rolling budget per repository: at most 10 unvetted entries and 256 MiB per 24 hours, package contents only (no upstream trees). Without a byte budget, 10 entries at the per-entry caps (256 + 128 MiB) could reach 3.75 GiB, more than the 2 GiB total. Entries beyond the budget are disclosed as not fetched |
| Lockfile injection and dependency confusion | The fetched package's hash must equal the lockfile's; a mismatch is refused and disclosed as a fact on the hunk that changed the lockfile, because a lockfile that disagrees with the registry is something a reviewer should see. Non-default registries are never looked up publicly (SC4) |
| Typosquats | The lockfile is what the repository depends on; reading a typosquat's source adds no execution. Its text may try to instruct agents, which the next row covers. Detecting malicious packages is out of scope (open) |
| Prompt injection in fetched text | Stack results are wrapped in tags with a random ID and a system note that they are third-party data, never instructions, as diffs already are ([M3 proposal §3.3](m3-harness.md#33-prompt-layout-and-caching)); stack tools are read-only |
| Kept out of the repository and of Records | The store is outside the work tree and outside `.git/neuve/`, and its index is not Records data (SC6). Records keeps references, plus the excerpt each cited context reference shows (SC9). Stored turns keep stack result bodies like any tool result, masked by 10.24's rules and under 10.8's retention, because the store can lose an entry (conflict X9) |
| Telling agents it is third-party | Every stack result line begins with the entry, its version and its source level (`third-party · npm @tanstack/react-start@1.168.6 · package contents`). The prompt says these are the stack's own sources, a reference for what the repository's files follow, never part of the change. Findings still anchor on changed lines only (3.5), so stack code cannot be reviewed or receive a disposition |
| Isolation of facts from agent work (2.16) | The store holds only fetched sources, git objects and their indexes: no agent outputs, rankings or Records data, so pointing an agent at it shows it nothing else |

## SC8. Harness tools

**Recommendation:** three tools in the [`lookups.ts`](../../packages/harness/src/lookups.ts) model: handles with lineage, one page of at most 3,000 tokens (10.18) with what comes next, and an explicit empty result with the scope searched.

| Tool | Returns |
| --- | --- |
| `stack_list(entry?, prefix?, page?)` | With no entry: the frozen stack state at base and, where they differ, head: ecosystem, name, version, what was fetched and its source level, the entry's rank (SC3), and gaps (not ready, not indexed, over cap, over budget, private, no commit, no longer available). With an entry: the files under a prefix, from its tree |
| `stack_search(query, entries?, k)` | BM25 over the store's index (SC6), in the same result lines `search` uses (enclosing symbol, specific identifiers, excerpt), each prefixed as third-party. A separate index, never merged with `search` (conflict X4) |
| `stack_read(handle \| entry:path, lines)` | One page of the file, from the entry tree's blob |

Handles gain a `stack` revision: `commit` is a commit object the store makes for each entry tree, and `blob`, `path` and lines work as they do now. **The stack state is frozen per cycle** (conflict X11): the first run in a cycle records which entries were ready, with their tree OIDs, in the range manifest; reruns in that cycle read exactly that state, so cached results stay valid (5.4); the next cycle takes the current state and discloses entries that became ready.

**Who gets them.** Understand: `stack_list` only, so it can say which stack a changed file follows when it names each hunk's role (11.13), without a search tool (10.40). Investigate: all three, for context such as the framework's template or contract. Dispose: all three, within its 15 turns, because 11.14 names the harness's reviewers. Assemble: none. The worst-case sums are unchanged: each result is capped at 3,000 tokens and the turn limits stand (10.18). The ACP route's `--review-range` toolkit gains the same three. **Prompt guidance:** one rule (stack sources are reference, never the change) and two examples that do not come from the prompting case, so its demonstration stays meaningful (SC13): a good use (reading the framework's documented shape for a generated route-tree file before judging a change to it) and a bad one (citing a framework internal as a defect in the change).

## SC9. Evidence ledger and citations

A ledger entry's source gains a new origin, **stack**, beside repository, scope excerpt and same-batch, with this provenance: ecosystem, name, version, the lockfile hash, the source level, the upstream URL and commit where they exist, path, lines, blob OID, the entry tree OID, and the fetch time. Lineage (10.47) works unchanged: the lookup, its arguments and the entry it was followed from. Grade and stance are as for any entry; most stack items will be useful background, and some necessary (for example, the contract a changed call must meet). Like scope excerpts (3.12), the cited excerpt is kept with the context reference, so the L3 source sheet still renders after eviction or after the source disappears upstream; the rest of the entry is linked, not stored. Every reference is anchored on a changed line (3.5).

**Open: how the desk shows it.** The vocabulary's marker kinds include _doc_ and _captured source_; either could fit, or the owner may want a distinct kind, which would be a vocabulary change needing approval. The source levels' wording, if shown, is new product copy. This proposal invents none.

## SC10. The inner loop

| | A. Plain files plus skill guidance (recommended) | B. A `neuve stack` CLI with search | C. MCP tools in `neuve mcp` |
| --- | --- | --- | --- |
| What agents use | Their own grep and read on the store's read-only folders | `neuve stack search` with ranked handles | The harness's three tools |
| Cost | Lowest | Moderate | Moderate; one more server surface |

**Recommendation: A, plus `neuve stack list`**, which prints, for the repository's HEAD, each entry with its version, source level and read-only paths (package contents and upstream tree), and the gaps. The [reviewer skills](../../.agents/skills/) (11.7) say when to look (before judging a file that follows a stack's conventions, and when a finding depends on what the framework expects) and how (`neuve stack list`, then read). `setup stack` adds the store as a read-only directory to the agents' user-level configuration, with the same backups `setup hooks` makes, because some agent harnesses read outside the project only from directories they were given (unverified per harness). B and C wait for dogfooding to show the plain route falls short (7.6). **Basis:** coding agents already search files well; 1.2 builds the inner loop's data surfaces, not a product flow, and a path list is a data surface.

## SC11. Implementers

Implementers use the same store and command: to check a generated template or a current API against the pinned version, which matters most where the model's knowledge is older than the stack (this repository pins `effect` 4.0.0). Guidance lives in the inner-loop skills that brief implementers once they exist; until then, one line in `AGENTS.md` naming `neuve stack list`. **Basis:** 11.14 names implementers; the reading surface is the same, and only the guidance differs.

## SC12. Language neutrality, restated

No ecosystem, language or file name is selected in product code. Ecosystems are capabilities with their reads declared as data (SC4); selection is by declared dependency and observed use (SC3); coverage gaps are disclosed per repository. This follows the [constitution's neutrality rule](../../CONSTITUTION.md#repository-language-neutrality), which allows language-specific analysis only behind a capability-declared boundary.

## SC13. Milestones, cost and measurement

**Placement.** H8 has landed (`aa7dd5a3`); H9, M3's judging, is next (10.71, 10.72). **Recommendation:** ST1 starts now, beside the M3 lanes. ST2 follows ST1, handed the harness files (`lookups.ts`, `understand.ts`, `investigate.ts`, `dispose.ts`) by whichever lane holds them. Comparing Dispose with and without stack tools is either an arm the owner adds to H9 or ST2's own judging after H9 (conflict X10). M4 is unaffected: stack results never enter `search` or the leads, and the M4 labelling stays frozen (11.13).

| # | Slice | Built | The owner opens and judges | Depends on |
| --- | --- | --- | --- | --- |
| ST1 | Store, `bun.lock` capability, package contents | New: the ecosystem-capability boundary and the `bun.lock` reader; the store with its extraction rules, scrubbed fetches, caps, head-only budget and eviction; `neuve setup stack` and `neuve stack list`. Shared files, handed on in order: `records-schema/src/operational.ts` (the `stack.fetch` job kind) and `records-core/src/jobs.ts` (its policy); `harness/src/commit-prepare.ts` (the enqueue on a changed lockfile); `harness/src/settings.ts` (stack settings); `apps/neuve-cli/src/capture/setup-hooks.ts` and `cli.ts` (running `setup stack`) | `neuve stack list` for this repository and `neuve_effect`; `neuve jobs` showing `stack.fetch` in the background slot at nice 10; worker logs of a refused hash mismatch, an over-cap entry, an over-budget unvetted entry, a refused `.git` path in a crafted archive and a non-default registry disclosed; disk use against the cap | M2, H2 |
| ST2 | Upstream trees, index and harness tools | Sigstore-verified and registry-stated source levels; the quarantine fetch with its watchdog and lazy-fetch guards; the `stack.index` job and the persisted index; the frozen stack state; the three tools; the ledger's stack origin and the kept excerpt | The prompting case's review read by the owner, with the cited example root route and its source level; `neuve review show` listing stack references; telemetry of stack tool calls; the worker log of a fetch killed at its cap | ST1 |
| ST3 | Inner-loop guidance | The skills' text, the agents' read-only directory entry, the `AGENTS.md` line | An inner-loop review in this repository that reads a stack source, from its transcript capture | ST1 |
| ST4 | More ecosystems | npm, pnpm and Yarn lockfiles, `go.sum`, `Cargo.lock`, `uv.lock`, each its own capability | `neuve stack list` on a repository of each kind, with its gaps | ST1 |

**Cost.** Disk: about 249 MiB of package contents for this repository before the store's second copy, plus the ranked upstream trees (at most 1 GiB), within the 2 GiB default. CPU: in the background, one index build per tree. Package contents are mostly small (median about half a MiB), but `effect` has about as many files as this repository's tracked tree (2,557 against 2,571), and one TanStack upstream tree has 12,491 blobs, about five times this repository's. Tokens: no new turn budget; stack calls compete with other lookups inside the existing limits, so the cost ceiling per run is unchanged and the actual change is measured.

**What to measure to know it helps.**

| Measure | How |
| --- | --- |
| The prompting case | Re-run once on the held-out range for the owner to read: does the review recognise the root route as scaffolding and judge it against the example? Never scored, never used to tune (conflict X8). It is not independent of the design: this proposal was shaped by that case, so it shows the mechanism works, not that it generalises; SC8's prompt examples are kept apart from it |
| Misread findings | On the M4 development ranges whose changed files reference a stack entry (at least 16 of the 71 dev hunks show such an import in the hunk text itself, a lower bound), Dispose with and without stack tools on the same units; the owner's decide-then-reveal sheet (10.71) marks findings that misread what a file is, and requests for changes on scaffolding |
| Understanding first (11.13) | Understand's role for each hunk against the owner's reading of what kind of code it is, on the same units |
| No displacement | Investigate's M4 scores (10.78's scorer) on the same 12 dev ranges with and without stack tools; stack items cannot earn credit, because the gold has none, so a drop means stack reading crowded out repository context |
| Use and cost | Telemetry: stack tool calls per agent, the share of ledger entries citing stack sources by source level, turns and tokens spent on them, cost per run, fetch bytes, disk and CPU per job, gaps by reason |

## Decision list for the owner

| # | Decision | Recommendation | Basis |
| --- | --- | --- | --- |
| SC1 | Install step | `neuve setup stack`, run by `setup hooks` with `--no-stack`; refreshed by commits that change a declared lockfile and by review requests, all inside the head-only budget; off per repository or per user | Network and disk work named and consented; background only (6.9, 10.31) |
| SC2 | Location and layout | User-level store: one write-once git repository per tree, evicted by deleting it (blobs are not shared across versions); read-only extracted package contents and upstream trees; persisted indexes; a quarantine; pins in `.git/neuve/stack.json`; open for devcontainers | Disk can be reclaimed without repacking; departs from "next to the repository" (X1) |
| SC3 | Which stacks | Package contents for every direct dependency; upstream trees ranked by one bounded grep for quoted reference forms, up to 10 trees and 1 GiB; on demand for changed files' references; transitive re-exports open | No "framework" category to define (constitution) |
| SC4 | Detection | One ecosystem capability per lockfile family, read from git objects; exact version, registry and hash; non-default registries disclosed, never looked up publicly; attested only after real Sigstore verification, else registry-stated; no tag guessing | Pins from the lockfile; trust from the registry, labelled; no dependency confusion |
| SC5 | What is fetched | Published contents always; a depth-1 upstream tree at the commit for ranked entries, fetched into a quarantine with a byte and 5-minute watchdog that kills git's process group, then kept as its own repository with an unreachable promisor remote, `GIT_NO_LAZY_FETCH=1`, and automatic maintenance off | Scaffolding, examples and docs live upstream; the blob filter must hold |
| SC6 | Bounds and index | 256 MiB per package, 128 MiB per upstream tree, 2 GiB total; background slot, nice 10, heavy-work gate; LRU and 30-day eviction, not lossless, disclosed; a separate persisted store-level index outside Records, counting each tree once and at most 32 query terms, never built in a run; refuse new fetches when open cycles hold more than the cap | 6.10; `treeIndex` writes into each repository's Records and lives in memory; conflict X12 |
| SC7 | Isolation and security | Never executed; extraction refuses `.git` parts and collisions; Neuve-built HTTPS URLs, other protocols and git redirects off; scrubbed environment; no credentials; one head-only budget of 10 entries and 256 MiB a day on every path; hash must match; captures keep result bodies | 2.16, 10.5, 10.52; lockfile injection; fsmonitor through the inner loop |
| SC8 | Harness tools | `stack_list`, `stack_search`, `stack_read` in the handle model, over a stack state frozen per cycle; Understand gets `stack_list`; Investigate and Dispose get all three | 10.18, 10.47; conflicts X2, X4, X5, X11 |
| SC9 | Ledger and citations | A new stack origin with full provenance and source level; the cited excerpt kept; marker kind and copy open | 3.4, 3.5, 3.12's excerpt rule |
| SC10 | Inner loop | Plain files plus `neuve stack list` and skill guidance; MCP later if dogfooding needs it | 1.2, 7.6, 11.7 |
| SC11 | Implementers | The same store and command, with implementer guidance | 11.14 |
| SC12 | Neutrality | Capabilities as data; selection by use; gaps disclosed | Constitution |
| SC13 | Milestones and measurement | ST1 now beside M3; ST2 after ST1; the with-and-without comparison in H9 or after it (X10); measured by the prompting case read (not independent), the decide-then-reveal sheet, Understand's roles, M4 scores and telemetry | 10.71, 10.72, 9.58 |

**Open points**, beyond the rows' recommendations: the conflicts X1–X12, including whether a new architecture record (0012) holds the stack store; devcontainer reach (SC2); whether `bun.lock` records an empty registry under a user-configured default registry (SC4); transitive re-exports (SC3); proxies (SC7); detecting malicious packages (SC7); the marker kind and the source levels' copy (SC9).

## Sources and limits

Registry and API facts were fetched on 20 October 2026 and nothing fetched was executed; measurements of this repository were read-only, and an independent review rechecked them, corrected the entry counts, sizes and the prompting case's versions, and ran the partial-clone experiment cited above. Some agent harnesses' rules for reading outside the project are from my knowledge, marked unverified where used. Disk figures for package contents are installed sizes, which approximate published sizes. Working notes are outside the repository, in the session scratchpad.
