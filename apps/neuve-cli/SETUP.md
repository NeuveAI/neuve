# Install Neuve in a repository

Build the current Graph source, then install copies of the public CLI, that Graph engine and the review desk from your Neuve checkout into a folder of your own, and put its `bin` on your `PATH`:

```sh
bun run build:graph
bun run install:cli --prefix ~/.neuve-src
export PATH="$HOME/.neuve-src/bin:$PATH"
```

Keep a from-source copy out of `~/.neuve`, where the one-line installer puts release builds; it refuses a folder that holds a from-source install. Without `--prefix`, `install:cli` writes the machine's shared copy in `~/.local`, which every hook and terminal on the machine runs. That install is guarded: it takes only a clean integration branch such as `main`, after `bun run check` passed on that exact commit, so a half-tested build never replaces the copy other sessions use. Maintainers install that way; a copy in your own prefix skips those guards.

Graph's `mise.toml` selects its Go toolchain. `mise run build` is the equivalent configured build when mise is installed. The [root command table](../../docs/development.md#commands) says where `install:cli` puts the copies and what it refuses to replace; rebuilding or testing the workspace does not change them. If its manifest `<prefix>/lib/neuve/install.json` is corrupt or incomplete, remove it, `<prefix>/bin/neuve` and `<prefix>/lib/neuve/entire-graph`, then install again. Then run the installed command against an existing Git repository:

```sh
neuve setup --repo /absolute/path/to/repository
```

Repositories set up before the copy install keep their Graph link to the workspace build until `neuve setup --graph-binary <prefix>/lib/neuve/entire-graph` is re-run in them, with the prefix you installed into (`~/.neuve-src` above, `~/.local` for the shared copy).

Run setup before a review. In a repository where setup hasn't run, `neuve review` and `neuve review desk` stop and print the `neuve setup` command to run. Setup resolves the Git root, records the built executables it found and checks, through the validated Graph-client boundary, that the Graph engine can work on the repository: its identity and capabilities, the repository's Git metadata and the engine's preparation plan for `HEAD`. In a repository whose objects live in another repository (cloned with `--shared` or `--reference`), the client doesn't read the Git metadata yet, so setup checks the engine's identity and capabilities alone; reviews read their own clone and work there. It indexes nothing: a review builds and stores what it reads itself. It reports whether local work differs from `HEAD`.

Setup keeps its state beside the Records store, in `<git common directory>/neuve/setup/`, so the repository's working tree and `git status` are the same before and after it. Every worktree of the repository shares it, as they share the store.

| Path under `<git common directory>/neuve/setup/` | Purpose                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `config.json`                                    | The installation (schema 4): the repository that ran setup, and the CLI and Graph engine it found, by path |
| `initial-index.json`                             | The engine check: its status, the revision and the engine's identity                                       |

Setup links nothing: the Graph engine refuses a repository whose Git directory holds a link to another volume. A recorded engine that is gone (after an install elsewhere) gives way to the engine beside the CLI the next time setup runs. A Graph refresh (`neuve query --refresh-cache`) checks the revision out in a temporary view outside the Git folder and on the repository's disk: `<temporary folder>/neuve-<uid>/graph-views/`, else `/private/tmp/neuve-<uid>/graph-views/`, else `.neuve-<uid>/graph-views/` at the top of the repository's disk, each a private folder of yours, removed when empty. Only when none can be made does it go in the store's `graph/views/`, under the same checks, where Graph refuses a repository that commits a link leaving its disk; `neuve query` then says so and what to change.

Setup also settles how reviews sign in, kept as `review.route` in your Neuve settings (`~/Library/Application Support/Neuve/settings.json` on macOS):

- `neuve setup --route openai` chooses ChatGPT; then sign in with `neuve auth login openai`.
- `neuve setup --route anthropic` chooses an Anthropic API key; then set `ANTHROPIC_API_KEY` in the shell you run Neuve from. It must be an API key: a Claude subscription token doesn't work.
- A Claude subscription isn't a setup choice yet. Sign in with Claude Code's own `claude auth login`, then name it on each review: `neuve review <base>..<head> --route claude`. `neuve auth status claude --check` checks that sign-in without spending usage.
- Without `--route`, setup asks on a terminal when no route is set yet ("Sign in with ChatGPT, or use an Anthropic API key?"). With no terminal (a script or an agent) it asks nothing, writes nothing and says how to choose. A route already set is changed only with `--route`.

Setup changes only `review.route`: every other setting stays as it was. It refuses a settings file it can't read rather than overwrite it. When the settings path is a link (settings kept in a dotfiles folder), it writes the file the link leads to and keeps the link; a link that doesn't lead to a file of yours is refused. It never signs in for you. `neuve doctor` shows the route and whether its sign-in is there, without reading the credential.

`neuve review` and `neuve review desk` refuse a repository until setup has run there. Records live in `<git common directory>/neuve/` too; `neuve records --help` describes them. Graph's engine copy and the snapshots `neuve query` builds live in the machine's shared Graph cache, `<budget folder>/graph/cache/`, the one reviews use. `--graph-binary` and `--cli-binary` explicitly select built executables.

An earlier setup wrote `config.json`, `initial-index.json` and the links `bin/neuve` and `bin/neuve-graph` to `neuve/` in the working tree and added `/neuve/` to the local Git exclude file. Neuve's own record there still counts, so such a repository stays set up. The next `neuve setup` removes that folder only when every part is provably Neuve's: real folders, its own record naming those links and this repository, links where it names them, an index it wrote, and nothing Git tracks. Otherwise it leaves the folder as it is and says so in one line; a project's own `neuve/` folder never stops setup. The exclude line stays; it is harmless. Files from the removed review stack (`neuve/backend.env`, `neuve/acp-initialize.json`, `neuve/ledger.sqlite`, `neuve/cache/graph/`) are not read, and you may delete them.

## Review settings

Your own [review settings](../../packages/harness/src/settings.ts) choose the model a review runs on. They live outside every repository, at `~/Library/Application Support/Neuve/settings.json` on macOS and `~/.config/neuve/settings.json` elsewhere. Without the file, reviews run on the Anthropic route.

```json
{
  "version": 1,
  "review": { "route": "openai", "effort": "medium" }
}
```

| `review.route` | Model | What it needs |
| --- | --- | --- |
| `anthropic` (the default) | Claude Opus 5.5 through the Anthropic API | `ANTHROPIC_API_KEY` in the environment of the worker that runs the review |
| `openai` | GPT-6.1 Sol on your ChatGPT plan | `neuve auth login openai` once; `neuve auth status` shows the sign-in |

`neuve review <base>..<head> --route claude` runs a review on Claude Opus 5.5 on your Claude subscription, through your installed Claude Code and its own sign-in (`claude auth login`). Neuve never reads that sign-in. `review.route` can't name it yet, so give `--route claude` on each review. `neuve auth add claude <name>` adds a second Claude sign-in in its own folder and prints the command to sign in; review on it with `--route <name>`.

`review.effort` is `low`, `medium` (the default) or `high`. A review queued where its route's credential is missing waits, and `neuve review` says so; start a worker from a shell that has the credential with `neuve worker start --repo <path>`.

## Open the review desk

```sh
neuve review desk [--repo <path>] [--port <n>]
```

This opens the batch overview and the review desk for the repository you're in, or for the one `--repo` names. It prints the desk's address, such as `http://127.0.0.1:4141/`. The desk stays open until you press Ctrl-C. If port 4141 is taken, it picks a free port and says so. `--port 0` always picks a free port. The desk listens on this computer only.

Each repository has one desk. If its desk is already open, `neuve review desk` prints that desk's address. While the desk is open, `neuve review` prints a link to the review. Otherwise it says to run `neuve review desk`.

The desk is installed with the CLI, in `<prefix>/lib/neuve/desk/`, and runs inside `neuve`, so it needs no Bun. If that folder is missing, incomplete or from another version, the command stops and names the `install:cli` command that fixes it. To run `neuve` from a Neuve checkout without installing it, set `NEUVE_DESK_DIR` to a built desk folder, such as the `lib/neuve/desk` folder of an install.

## Check what's missing

`neuve doctor [--repo <path>] [--json]` checks, without changing anything or using the network, what a first review needs: the CLI and the files its install recorded, `PATH`, the Graph engine, the Xcode command-line tools on a Mac, Git, the repository's setup, the review route's credential, the repository's worker and the review desk. Each line is `ok`, `missing` or `warning`; a missing or warning line ends with the command that fixes it. It names credentials, never their values. It exits 1 when something required is missing. `neuve setup` ends with the same credential check and the next command to run.

## Capture commits and agent sessions

`neuve setup hooks --repo <path>` enables capture for one repository. It installs `post-commit` and `post-rewrite` hooks in the repository's hooks directory, chaining any hook already there (kept as `<name>.pre-neuve`). It writes `<git common directory>/neuve/capture.json`. It also adds Claude Code and Codex hooks to your user configuration (`~/.claude/settings.json`, `~/.codex/hooks.json`), backing up any file it changes as `<file>.neuve-backup-<time>`. Agent hooks are per user, but they do nothing in repositories without `capture.json`. Run with `--dry-run` to see the changes first, and rerun it to update them.

Hooks run a small hook entry: the installed `neuve hook`, or, when setup runs from a checkout, a bundled snapshot of that entry in `~/Library/Application Support/Neuve/hook/neuve-hook.js`, so source being edited cannot break them. Rerun setup to refresh it. Each hook command discards its output and always exits 0, so it never adds to an agent's context or blocks a prompt or a commit. Failures are logged to `<git common directory>/neuve/hooks.log`. Hooks only write events to `<git common directory>/neuve/spool/` and wake the worker, which ingests them into Records. Prompts never enter recorded events. At each turn's end and at session end, hooks record the transcript's path and size; the worker then copies the transcript segment since the previous turn end into the store as a raw capture (it holds the prompts and tool output as the agent wrote them) and records the turn's model, token counts, model calls and tool calls. Raw captures are pruned after 30 days and the token figures are kept ([retention ruling 8.10](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026)); `neuve records stats` shows them. A commit is linked to the agent session that made it through process ancestry. When ancestry is unavailable, as in a sandbox, the harness's own session variable (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`) links it as `declared` when it names a live session recorded in this repository ([declared-link ruling 8.13](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026)). `NEUVE_SESSION=<harness>:<session id>` names the session explicitly. An unlinked commit is attributed to its committer. `neuve agents` lists actors with their aliases, models, turns and commits. `neuve agents current` shows which session a call belongs to.

Pruning leaves a tombstone, so records that reference a capture stay intact. The worker prunes at most once a day, so a capture goes within a day after its 30 days. `neuve records prune --dry-run` shows what a prune now would remove, by class and age; `neuve records prune` enqueues one and wakes the worker.

`--session-trailer` adds a `Neuve-Session` commit trailer to linked commits in your repository. It is off by default and refused in the Neuve repository ([commit-link ruling 8.1](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026)).

## Let agents vent

An agent may say, once per session, what is making that session difficult ([venting ruling 8.8](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026)). A vent never changes the task or a review. `neuve vent "<text>"` records one from a shell command; `neuve vents [--since 7d] [--agent <alias>] [--run <id>] [--json]` lists them, with control characters and terminal escape sequences removed from what agents wrote. A vent is tied to its agent session the way commits are: through process ancestry, the session ID the harness declared, or `--session <harness>:<session id>` (or `NEUVE_SESSION`). With no session to tie it to, nothing is recorded and the command says why. A second vent in the same session is answered normally, and the first is kept. A harness that runs several agents under one session passes each review cycle's session ID as `--reconciliation-id <id>` (the MCP tool's `reconciliationId`), as the [vent-attribution ruling 8.16](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026) sets out. Vent text is pruned after 30 days ([vent-retention ruling 8.17](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026)), and `neuve vents` then shows it as pruned. Vents recorded with the earlier inline-text shape (`vent.recorded@1`, from the S6 build only) keep their text, because the log is append-only.

`neuve mcp` serves the same `vent` tool over MCP on stdio. The harness starts it as a subprocess for each session and it exits when the session closes its input: no port and no daemon. Setup does not install it; add it yourself, once per user:

```sh
# Claude Code (user scope, every repository)
claude mcp add --scope user neuve -- neuve mcp
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.neuve]
command = "neuve"
args = ["mcp"]
```

The server works in the repository of its working directory, normally the one the harness was started in; pass `--repo <path>` to fix one. Each call is tied to the session whose agent process started the server, so the session's hooks (`neuve setup hooks`) must be installed for the repository. A server started outside a captured session answers each call that nothing was recorded.

Queries use the Graph engine setup recorded while it runs, else the one beside the CLI. An explicit `NEUVE_GRAPH_BINARY` overrides both; provider cache environment variables don't change where the cache is.

## Dogfood the Neuve monorepo

Run dependency installation at the monorepo root; the root `bun.lock` governs the combined workspace.

```sh
bun install
bun run install:cli
neuve setup --repo /absolute/path/to/neuve
```

Running setup from a nested source directory resolves the same monorepo, so its record lives in the root's `<git common directory>/neuve/setup/`.

Start the web app from the root with `bun run dev`. The [web README](../neuve-web/README.md) describes it. It runs from source, never the installed copies.
