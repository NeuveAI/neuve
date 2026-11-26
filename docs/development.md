# Developing Neuve

How to work in this repository: where the truth lives, how to set the repository up, what every root command does, and how the coding workspace opens. The [README](../README.md) is the short version for people trying Neuve; this page is for people changing it. [Contributing](../CONTRIBUTING.md) says how changes are proposed and reviewed.

The [product vocabulary](../vocabulary.md) defines Neuve's terms. Neuve has six layers: harness, system of records, graph, CLI, MCP and web app. The [architecture overview](../architecture/README.md) says what each owns, how work flows between them, and the records behind each choice. Much of the current code does not match it yet.

## Where decisions live

The [working-truth table in `AGENTS.md`](../AGENTS.md#working-truth) says which document holds the truth on what: the owner's design decisions override older text; the architecture records and the living plan follow from them, and the vocabulary and foundations stay authoritative for product meaning. The [research synthesis](../research/00-synthesis.md) holds the background and evidence behind the decisions. The first scope ends at the full test in [decision 1.10](../process/decisions.md#area-1-product-loop-and-roles-16-october-2026): the owner opens a real batch in the review desk.

## Set up the repository

Agents start with [`AGENTS.md`](../AGENTS.md). Follow the [repository constitution](../CONSTITUTION.md) for contextual links.

You need Git, [Bun](https://bun.sh) 1.4.4 and [Go](https://go.dev) 1.27 (an older Go downloads 1.27 for Neuve Graph on its first build). Clone with submodules, install, and set up the Neuve Graph fork:

```sh
git clone --recurse-submodules https://github.com/NeuveAI/neuve.git
cd neuve
bun install --frozen-lockfile
bun run setup:graph
bun run build:graph
```

`setup:graph` configures the Graph fork's upstream remote for external validation; building and querying don't need it. Neuve Graph is a [separate repository](https://github.com/NeuveAI/neuve-graph) mounted at `apps/neuve-graph`; before working in it, read its own `AGENTS.md`.

## Commands

| Command | What it does |
| --- | --- |
| `neuve auth list [--check] [--json]` | Shows each account's saved sign-in state and limits. `--check` checks them without spending usage |
| `neuve auth add claude <name>` / `neuve auth add chatgpt <name>` | Creates a separate private sign-in folder and prints the command to sign in |
| `neuve auth status <account> [--check] [--json]` | Shows one account's saved sign-in state, or checks it now with `--check` |
| `neuve auth login <account> [--print]` | Checks the sign-in, then uses its own sign-in command. `--print` or a non-terminal input only prints that command |
| `neuve auth remove <account> [--force]` | Stops new and running use, signs out, then removes the account's folder and record. `--force` permits removal when Claude Code is missing, leaving any Keychain sign-in in place |
| `bun run check` | Builds Graph, then runs `typecheck`, `test` and `check:ace` in sequence on demand, in check mode (`NEUVE_MODE=check`); lanes rely on pull-request CI instead ([decision 17.62](../process/decisions.md#agents-across-channels)), and fails if any phase fails. Requires Go and a clean Graph submodule initialized at the commit's pointer; fails with a fix when either is missing or the source differs. Every phase runs even after a failure. Typechecks run together. Test suites run through the bounded pool described in the `bun run test` row. Check mode never writes the installed copy or a live store (decision 12.24). When every phase passed on a clean tree, it records a receipt for that commit in `<git common directory>/neuve-check/`, which `install:cli` requires |
| `bun run check:remote <commit>` | Retired on 12 November 2026 ([decision 14.10](../process/decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026): checks run locally; amended by [17.62](../process/decisions.md#agents-across-channels): lane checks run in pull-request CI); the command remains for reference. Requires a clean macOS checkout, Bun 1.4.4 and the target lockfile already installed. Pins the requested commit for local parts and restores the original branch; dirty work is never overwritten. Uses the existing Modal profile through the replay's pinned Python environment and `uv`. Runs portable package tests and typechecks in separate parallel sandboxes with no secrets, volumes or outbound networking. Builds Graph and runs its dependent tests, macOS-dependent tests and installed-copy reporting locally. Requires Go and a clean Graph submodule initialized at the pinned commit's pointer; fails with a fix when either is missing or the source differs. Uploads Git’s tracked-source archive only; sandbox Git metadata is generated there without original history. Writes `<git common directory>/neuve-check/<commit>.remote.json` with per-part results and logs. This remote receipt never permits `install:cli`; its existing local receipt is still required. CLI and harness tests use a 15-second default test window on Linux, with declared test deadlines retained. Native compiler pools (Rolldown, Rayon) are limited to four workers to match the sandbox CPUs. Storage-sensitive compiler adapters refuse changed source scripts until reconciled |
| `bun run check:graph` | Requires Go and a clean Graph submodule at HEAD's pointer, then builds the gitignored workspace engine through `build:graph`; fails with the fix when a prerequisite is missing or the source differs |
| `bun run check:installed` | Not part of `bun run check`. Reads only: one line saying whether the copy `bun run install:cli` built from source is behind this checkout by git history, and, on an integration branch, the commands that would install it (`bun run install:cli --dry-run`, then `bun run install:cli`) |
| `bun run typecheck` | Generates checked Ace declarations, then typechecks the root tooling and TypeScript workspaces without traversing the graph submodule. Ace retains its original compiler policy; Neuve consumers retain their stricter policy |
| `bun run build:ace-types` | Checks and emits Records schema declarations first, then the actual directory, channel and host declarations with their pinned native TypeScript compiler. API Extractor rolls the channel wire protocol into one declaration using the actual SDK types, without importing unused provider SDKs into frontend consumers. Output staging uses the configured external build directory; ignored package `.types` directories supply package type exports. Run this before a direct consumer workspace typecheck after a fresh install |
| `bun ace [command]` | Runs Ace's complete original CLI against the managed workspace's public runtime receipt, including its actual home, port, mode, captured worker and external lanes. Before the first workspace launch it constructs the same managed configuration from the default profile. Explicit `ACE_HOME` without a managed receipt retains native independent operation. `bun ace review ...` forwards to the same Neuve review command and Records admission as `neuve review` |
| `bun run format:check` | Checks formatting |
| `bun run test` | Runs root tests, then workspace suites through a bounded pool (`NEUVE_TEST_JOBS`, default 6 slots), with the harness split into 4 isolated shard processes (`NEUVE_TEST_SHARDS=1` runs it as one process). Every workspace suite runs as a test process with its own budget directory, so suites using plain `bun test` no longer reach `~/Library/Application Support/Neuve/budget`. The launcher gives each test a 30 s limit unless the test or its caller chooses one. A package running `bun test --parallel` calls Bun directly with its own `--timeout`, since the launcher cannot watch a parallel run. It never builds into or replaces the installed command |
| `bun run build` | Builds the CLI at `apps/neuve-cli/dist/neuve` |
| `bun run build:graph` | Builds the Graph engine at `apps/neuve-graph/entire-graph` |
| `bun run setup:graph` | Configures and verifies, idempotently, the fetch-only upstream remote that external validation checks. Run it after a fresh recursive clone; normal builds and queries do not need it |
| `bun run install:cli` | The only command that writes the shared installed copy: a fresh CLI build to `~/.local/bin/neuve`, and the built `apps/neuve-graph/entire-graph`, semantic workers and review desk to `~/.local/lib/neuve/`, recorded in `~/.local/lib/neuve/install.json` with the Records versions and the commit they came from. The installed command never points into the workspace. `--dry-run` runs every guard and prints the plan, writing nothing. It installs only from a clean `main` or `codex/pi-transition` whose history contains the installed copy's commit, after `bun run check` passed on that exact commit, and never in check mode or from tests. It also refuses to replace a copy with a higher Records schema or writer version. `--prefix <path>` (or `NEUVE_INSTALL_PREFIX`) makes a private scratch install, which skips the branch, history and receipt guards. Every install holds `<prefix>/lib/neuve/install-lock.sqlite` and replaces only what it installed, or the older symlink into the workspace. Stores never wait for this: a build opening an older store migrates it after a backup in `<store>/backups/`, and an older build uses a newer store in compatibility mode. Only a migration that declares older writers unsafe makes a worker refuse, naming the writer it needs, in `<store>/version-skew.json`, which hooks and `neuve jobs` report. The [release record](../architecture/decisions/0010-release-and-distribution.md) describes the full distribution this precedes. Neuve's own lanes no longer run this copy: they run the released one in `~/.neuve`, upgraded with `neuve upgrade` ([which Neuve runs](../process/neuve-in-the-loop.md#which-neuve-runs)) |
| `bun run release --version <v> [--dry-run] [--out <folder>]` | Legacy local command for the macOS Apple-silicon archive only. It is not the release path. Use **Actions → Release → Run workflow** in GitHub, described in the release workflow row below. The local command remains available unchanged |
| Pull-request CI ([`ci.yml`](../.github/workflows/ci.yml)) | `portable` is the required check. It requires portable tests, integration, typechecks, formatting and any selected release-archive tests. The CLI uses two file shards and the harness eight, each on its own Linux runner; another group runs the remaining tests and typechecks. Each Linux group has a 15-minute limit. Graph is public and runs on fork PRs too; each native platform builds the pinned engine once and shares it with its shards. Five `macos-15` release-archive shards run for the release dependencies in the [CI gate list](ci-gates.md#release-archives), plus every main push and `workflow_dispatch`. Each archive job has a 40-minute limit and each suite a 30-minute budget. Bun divides other release files across runners; distribution and systemd-installer cases are divided separately using recorded duration estimates because those files dominate installer coverage. The [complete CI gate list](ci-gates.md) names the retained platform exclusions and Graph cases and records restored NEU-405 hosted-runner launchd coverage. Release publishing only builds.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Release workflow ([`release.yml`](../.github/workflows/release.yml)) | The one release path is **Actions → Release → Run workflow** in GitHub. Choose `bump` as `patch` (default), `minor` or `major`, or set `version` to an explicit `X.Y.Z` or `X.Y.Z-pre.N`. Set `ref` to the source branch, tag or commit (default `main`). Publishing requires the workflow to run from `main` and the source commit to be an ancestor of `origin/main`. Dry runs may build other sources. It finds the highest semver among published non-draft version releases and requires a higher version with an unused tag. A patch bump promotes a prerelease to its stable version, so `0.3.0-pre.1` becomes `0.3.0`; minor and major bumps also promote when already at that version boundary. Notes list non-merge commits since that release, newest first, excluding `Release X.Y.Z` commits. It builds the exact prepared SHA for macOS Apple silicon, stamps the installer and writes `SHA256SUMS`. It runs no tests; tests and integration belong in pull-request CI. With `dry_run` selected, it saves the files and notes as workflow artifacts without creating a tag or release. Otherwise it creates an annotated `vX.Y.Z` tag and publishes the archive, `install.sh` and `SHA256SUMS` with provenance attestations and the collected notes. Stable releases become latest; prereleases do not. Runs queue one at a time without cancelling earlier runs, up to GitHub's limit of 100 pending runs. The `main tags` ruleset must allow the GitHub Actions integration (id `15368`) to bypass tag creation. The [installer](../scripts/install.sh) verifies `SHA256SUMS` before installing |
| `bun run test:release` | Runs the release tests: the detached release build, the native archive, the installer, its private download and the release command; no other root command runs them. Path-filtered pull-request CI, every main push and manual CI runs execute them on five macOS runners                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `bun run --cwd apps/website build` | Builds the neuve.ai site into `apps/website/dist`, with the repository's [`scripts/install.sh`](../scripts/install.sh) copied in as `install.sh`, the file `curl -fsSL https://neuve.ai/install.sh \| sh` downloads |
| `bun run --cwd apps/website deploy:gcp headers <backend-bucket>` | Builds the site and prints the `gcloud` command that sets the security headers, including the page's Content-Security-Policy, on the Google load balancer's backend bucket. Run it, then deploy |
| `bun run --cwd apps/website deploy:gcp <bucket> --backend-bucket <name> [--dry-run]` | Builds the site and uploads it to its Cloud Storage bucket with `gcloud`, signed in as whoever runs it. It stops first if the backend bucket's headers differ from the ones this build needs. Nothing is deleted from the bucket. `--dry-run` prints the steps and uploads nothing. The [deploy script](../apps/website/scripts/deploy-gcp.ts) lists the headers and cache times |
| `bun run dev` | Starts the web app from source. Records is a library, not a service, so nothing else starts; it never builds and never uses the installed command. See [the web README](../apps/neuve-web/README.md) |
| `bun workspace [--profile <pi-transition\|local\|profile.json>] [--repo <path>] [--loopback]` | Builds and opens Ace's coding home through a loopback web listener. Requested Neuve reviews use a cached production build per project and source content, with one loopback BFF per project announcing its address. Native configured team discovery and tailnet listeners remain active by default; `--loopback` keeps the host off them. Storage defaults by where the checkout is: the LaCie layout for the LaCie clone and its worktrees, a local layout elsewhere. The [workspace launcher](../apps/neuve-cli/src/workspace-cli.ts) defines the optional storage, project, port and user overrides. A copy installed from a checkout with `install:cli` offers the same command as `neuve workspace`; a release build refuses it |
| `neuve review export-dump --run <run-id> --root <dir> [--redaction restricted\|portable] [--repo <path>]` | Files the latest recorded close's session dump into an existing dataset folder outside Records. The [review CLI](../apps/neuve-cli/src/review-cli.ts) reads Records without a worker, network, or credentials. It refuses a failed, malformed, mismatched, or pruned capture and exits 3 when an admitted attempt has not closed. Refiling verifies and reuses the same snapshot |

Bun stays pinned to 1.4.4, the version the checks run on; older versions can hang Vite's port probe. No read depends on a closed database keeping its WAL sidecars, which Bun's `node:sqlite` removes at close on 1.4.4 and once the database's statements are garbage collected before that. [One module](../packages/records-core/src/read-only.ts) holds the read-only opens of a database that may be in WAL mode, and `check:remote`'s macOS parts run each read path against such a file, because only Apple's SQLite refuses it; Linux's reads it and writes the sidecars beside it. Review covers new code that opens one.

Desktop and Electrobun keep their original Bun 1.3.14 declarations; root, host and Neuve retain Bun 1.4.4 declarations. Desktop's compiler resolves the `bun` platform import through its actual installed declarations, keeping its authored FFI types consistent under Bun's isolated dependency layout. TypeScript's [module resolution paths](https://www.typescriptlang.org/tsconfig/paths.html) document this compiler setting and its unchanged emitted imports. The [desktop source record](../apps/desktop/UPSTREAM.md) identifies the exact seam.

Run graph-native checks from `apps/neuve-graph` with its Go or mise tasks. The installed CLI uses the Graph engine copied beside it. A workspace build at `apps/neuve-cli/dist/neuve` and a run from source both use the sibling `apps/neuve-graph/entire-graph`. Set `NEUVE_GRAPH_BINARY` only to test another executable deliberately.

`neuve query` sends a natural-language question unchanged through `packages/graph-client` to Neuve Graph for retrieval, with an optional relationship plan. The [command boundary](../apps/neuve-cli/src/boundary.ts) defines its options.

## Open the workspace

The coding workspace and Ace's coding app, which it opens, aren't part of the first release ([decision 13.9](../process/decisions.md#area-13-open-source-release-10-november-2026)). The maintainers use them to build Neuve. To read and decide reviews, run `neuve review desk`, as the [README's quick start](../README.md#quick-start) shows.

From the checkout, with dependencies installed:

```sh
bun workspace
```

This builds and opens Ace's actual coding app with its own interface and styling. The native host keeps channels across projects; the current directory selects the initial project. Neuve's review UI opens separately when a review action needs it, with the exact Records cycle and a return link to Ace. Coding sessions follow mutable work, not a fixed commit. No commit hash, clean checkout or specific branch is required to open the workspace. Individual review requests still identify their committed base and head.

Ask `@neuve` to review code, a branch or a PR. Coding agents use the native `neuve_review` tool to start the existing Neuve stages and report their Records request, exact range, cycle link, job, run and status. The default target is the connected project checkout's current branch, compared with its locally resolvable default base. Supply an explicit comparison such as "against origin/main" when needed. A chat lane is reviewed only when explicitly requested; requesting review never creates a lane. Reviews require committed, clean source and a nonempty comparison. `neuve_review_status` reads the exact admission. Pending work, completed runs and complete packets never establish approval; the review desk holds recorded findings and dispositions. If Neuve cannot admit or read a review, the agent reports the failure.

The [workspace launcher](../apps/neuve-cli/src/workspace-cli.ts) chooses its [storage profile](../scripts/pi-storage.ts) from where the Neuve source checkout is, never from what is mounted ([decision 12.7](../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026), as amended). From the LaCie canonical clone or one of its worktrees it uses the pi-transition profile, which keeps state, captures, worktrees, caches, temporary files and builds on LaCie; projects and their Git common directories must be on that volume, and an unavailable or misplaced volume is refused without a storage fallback. From any other checkout it uses the local profile, with no volume pin, under `~/Library/Application Support/Neuve/workspace/` on macOS and `~/.local/state/neuve/workspace/` elsewhere; projects may be anywhere. `bun run typecheck` chooses the same way. Use `--profile <pi-transition|local|profile.json>` for an explicit layout, `NEUVE_WORKSPACE_PROFILE` for the type builds, or `--repo <path>` for another initial project. The installed `neuve workspace` takes `--source <checkout>`; without it, it uses an explicit profile's canonical clone, or the LaCie clone when no profile is given.

The launcher prints a JSON readiness record with `"neuve-host":"ready"`, `url`, `tokenFile`, `web`, `repository`, and `pid`. Open the `web` URL. The coding web app defaults to loopback port 4141 so its saved drafts and layout keep the same browser origin across restarts. Use `--web-port <n>` to choose another port, or `--web-port 0` for a free port in an isolated or additional profile. The host uses a free loopback port unless `--port <n>` fixes it. With Tailscale running, the default also joins discovery, directory and lobby watching and opens tailnet listeners. A dynamic host port selects a separate free HTTPS port; `ACE_WEB_PORT` can set it explicitly. Use `--loopback` to opt out of tailnet sharing. A busy web port is refused; the launcher never stops its existing listener. Ctrl-C stops the processes the launcher owns.

The [review settings](../packages/harness/src/settings.ts) supply the coding provider, model and reasoning effort. On macOS these settings live at `~/Library/Application Support/Neuve/settings.json`. `review.route` names `anthropic`, `openai` or `claude`; the [CLI guide's review settings](../apps/neuve-cli/SETUP.md#review-settings) say what each route needs. `openai` selects [GPT-6.1 Sol through the ChatGPT subscription route](../packages/harness/src/route.ts), with a default effort of `medium`. An absent route still selects Anthropic, as it does for independent review. `telemetry.enabled` turns spans and metrics on or off: without it or an OTLP endpoint, compiled builds default to off and a checkout run by Bun (dev mode) defaults to run-log timings only; an existing `telemetry.otlp` endpoint still enables export. Off keeps Records, receipts, review progress and complete session dumps, and prevents OTLP export even with an endpoint. Storage profiles do not move sign-in files or change those settings. The [native provider](../packages/harness/src/pi/providers/agent-route-provider.ts) delegates sign-in and refresh to [Neuve's credential owner](../packages/harness/src/openai-auth.ts).

The installed `neuve` remains separate. `bun run dev` continues to start only the web app.

The [pi implementation map](../architecture/decisions/0014-ace-style-pi-harness.md#implementation-entrypoints) links the runtime, capture contract, and fresh candidate comparison. The transition scope in the maintainers' Linear (NEU-50) holds acceptance and current status. The owner counted the port's regression validation as passed on 23 November 2026 ([decisions record](../process/decisions.md#area-17-the-owners-rulings-on-returning-23-november-2026)).

## Validate Ace in a second workspace

A fresh lane worktree starts with an empty Graph submodule and no `node_modules`. Prepare it from the lane.

```sh
git submodule update --init apps/neuve-graph
bun install --frozen-lockfile
bun run check:graph
```

From a lane, plain `bun workspace` and `bun ace` use the owner's storage and runtime receipt. Lanes sit under `~/Library/Application Support/Neuve/workspace/worktrees/neuve-lanes/<channel id>/`. Create the scratch folder on LaCie for the launcher's profile and point the CLI at that profile's host home. The [storage validator](../scripts/pi-storage.ts) checks that the lane and the main checkout share a Git common directory.

```sh
lane="$(pwd -P)"
canonical="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
scratch="$(mktemp -d '/Volumes/LaCie Blu/neuve-validation.XXXXXX')"
cat > "$scratch/profile.json" <<EOF
{
  "sourceCheckout": "$lane",
  "paths": {
    "canonicalClone": "$canonical",
    "worktrees": "$scratch/worktrees",
    "state": "$scratch/state",
    "captures": "$scratch/captures",
    "cache": "$scratch/cache",
    "bunCache": "$scratch/bun-cache",
    "tmp": "$scratch/tmp",
    "builds": "$scratch/builds"
  }
}
EOF

# Keep stdin open. The launcher exits on EOF.
mkfifo "$scratch/input"
tail -f /dev/null > "$scratch/input" &
input_pid=$!
bun --no-env-file ./apps/neuve-cli/src/cli.ts workspace \
  --profile "$scratch/profile.json" --repo "$lane" --web-port 0 --port 0 --loopback \
  < "$scratch/input" > "$scratch/startup.log" 2>&1 &
workspace_pid=$!
printf '%s\n' "$workspace_pid" > "$scratch/workspace.pid"
printf '%s\n' "$input_pid" > "$scratch/input.pid"
```

Wait for the `"neuve-host":"ready"` record in `startup.log`. To sign in, type that workspace's `web` address straight into the browser with `#token=` followed by the token from its `tokenFile`. Use only the second workspace's token. Keep it and the sign-in URL out of command lines, logs, proof, screenshots, and commits.

Run CLI commands from the lane with the isolated host home.

```sh
ACE_HOME="$scratch/state/neuve-host" bun ace ls
```

After validation, let the launcher close its host, workers and web listener. Once the launcher has exited, delete the scratch folder that holds the workspace's token file.

```sh
kill -TERM "$(cat "$scratch/workspace.pid")"
wait "$workspace_pid"
kill -TERM "$(cat "$scratch/input.pid")"
wait "$input_pid" || true
rm -rf -- "$scratch"
```

## Linear planning integration

The planning scope in the maintainers' Linear (NEU-59) holds acceptance and current status. The [optional integration boundary](../architecture/decisions/0014-ace-style-pi-harness.md#optional-linear-scope) defines trusted local configuration, credential ownership and cycle attribution. Real-account setup and the planning entry in the adopted Ace app wait only on the owner's Linear sign-in. The former reduced workspace's Linear dialog is not the Ace interface.

Selection identifies the source for review admission. Records keeps the cycle's dated excerpt and existing freshness behavior. Reading or selecting a changed issue cannot silently replace a running cycle's scope. A cleared selection does not rewrite an admitted cycle. Issue completion never supplies a review disposition.

The native planning boundary reports an absent configured connection explicitly. Independent review keeps its existing scope discovery, permissions, and failure behavior. Configure authentication through the external bridge's operator workflow; the workspace does not request OAuth consent.
