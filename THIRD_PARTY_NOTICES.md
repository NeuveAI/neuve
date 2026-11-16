# Third-party notices

Neuve's own code is under the MIT license in [LICENSE](LICENSE): the repository's root `LICENSE`, which a release archive carries beside this file in `share/neuve/notices/`. The exceptions are listed here, each under its own license:

- the modified copy of `@pierre/diffs` in `apps/neuve-web/packages/diffs/`, which stays under Apache-2.0, Neuve's changes included;
- the source that Neuve and its Neuve Graph submodule copy or vendor from other projects (the table below), each tree keeping its upstream license and copyright notices;
- in the two UI packages (`packages/ui/` and `apps/neuve-web/packages/ui/`), the shadcn/ui components and styles (MIT), the Lucide icons (ISC, with Feather-derived ones under MIT), and the Inter, Geist and Geist Mono fonts (SIL OFL 1.1), as their notices below describe;
- in a release, the Bun runtime compiled into `neuve` (Bun is MIT; it links JavaScriptCore and WebKit under LGPL-2 and the libraries its license lists), and the npm packages and Go modules compiled into `neuve` and the Neuve Graph engine.

A release archive carries a copy of this file in `share/neuve/notices/`, headed by the Neuve commit and Neuve Graph revision it was built from, with the license texts of the code compiled into it (see the last section).

The Ace copies come from Ace commit `fe66277931d2c46f12dcc250b63e1b4428a4e9ee`. Neuve Graph is derived from Entire Graph. Its upstream baseline is commit `5637039f7da7c8f35726eec22c230491a3f90b9f`, marked by the local tag `neuve-upstream-baseline-2026-09-27`. The submodule pin is the commit this repository records for `apps/neuve-graph` (`git ls-tree HEAD apps/neuve-graph` prints it).

Grammar versions come from each grammar's binding in the submodule or from its import history. Where an upstream repository or commit could not be confirmed, the table says so, and the submodule pin identifies the included bytes. In the table, paths that start with `internal/sem/` are relative to `apps/neuve-graph/`.

| Copied or vendored tree | Source and revision | License | Paths covered | Full license text and changes |
| --- | --- | --- | --- | --- |
| Ace application | [githubnext/ace at fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/app) | MIT | `apps/app/` | [Ace license](apps/app/UPSTREAM-LICENSE); [frontend integration and changes](apps/app/UPSTREAM.md). |
| Ace desktop | [githubnext/ace at fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/desktop) | MIT | Ace portions of `apps/desktop/` | [Ace license](apps/app/UPSTREAM-LICENSE); [desktop changes](apps/desktop/UPSTREAM.md). Bundle notices are described below. |
| Ace host | [githubnext/ace at fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host) | MIT | Ace portions of `apps/neuve-host/`, originally `apps/host/` | [Host notice and license](apps/neuve-host/NOTICE); [host adaptations](apps/neuve-host/UPSTREAM.md). |
| Ace channel | [githubnext/ace at fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/packages/channel) | MIT | Ace portions of `packages/channel/` | [Channel notice and license](packages/channel/NOTICE); [channel adaptations](packages/channel/UPSTREAM.md). |
| Ace UI | [githubnext/ace at fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/packages/ui) | MIT for Ace's code | Ace portions of `packages/ui/` | [Ace license](apps/app/UPSTREAM-LICENSE); [frontend changes](apps/app/UPSTREAM.md); [UI third-party notices and trademark limits](packages/ui/NOTICE.md). |
| Ace split-tabs | [githubnext/ace at fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/packages/split-tabs) | MIT | `packages/split-tabs/` | [Split-tabs notice and license](packages/split-tabs/NOTICE); [frontend integration and naming changes](apps/app/UPSTREAM.md). |
| Ace services | [githubnext/ace at fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/services) | MIT | `services/directory/`, `services/channel/`, `services/compute/`, `services/celld.ts`, `services/deploy.ts`, `services/fly.toml` | [Service notice and license](services/NOTICE); [service adaptations](services/UPSTREAM.md). |
| Modified `@pierre/diffs` 1.5.1 | [pierrecomputer/pierre at 228c5848](https://github.com/pierrecomputer/pierre/tree/228c5848/packages/diffs) | Apache-2.0 | `apps/neuve-web/packages/diffs/`, including the copied demo fixtures under `test/fixtures/` | [Pierre license](apps/neuve-web/packages/diffs/LICENSE.md); [copy inventory and modifications](apps/neuve-web/packages/diffs/NOTICE.md). |
| GitHub Linguist rules | [github-linguist/linguist v9.7.0 at e0c78d62](https://github.com/github-linguist/linguist/tree/e0c78d62c42abae6122235d8e68a7aa43eef89da/lib/linguist) | MIT, copyright 2017 GitHub, Inc. | `packages/harness/src/linguist/` | [Linguist notice, license and the files copied or ported](packages/harness/src/linguist/NOTICE). |
| Neuve Graph | [entireio/entire-graph at baseline 5637039](https://github.com/entireio/entire-graph/tree/5637039f7da7c8f35726eec22c230491a3f90b9f); Neuve's submodule pin | MIT, copyright 2026 Entire Inc.; vendored exceptions below | `apps/neuve-graph/` | [Entire license](apps/neuve-graph/LICENSE). Changes after the baseline are in the submodule's Git history; there is no consolidated change list. |
| Clojure grammar | `sogaiu/tree-sitter-clojure` v0.0.13; upstream commit not confirmed | CC0-1.0 | `internal/sem/grammars/clojure/` | [CC0 text](apps/neuve-graph/internal/sem/grammars/clojure/LICENSE); [vendored binding and version](apps/neuve-graph/internal/sem/grammars/clojure/binding.go). |
| C# grammar | `tree-sitter-c-sharp` v0.23.5; upstream repository and commit not confirmed | MIT | `internal/sem/grammars/csharp/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/csharp/LICENSE); [binding and ABI 14 regeneration](apps/neuve-graph/internal/sem/grammars/csharp/binding.go). |
| Dart grammar | `tree-sitter-dart` from npm; upstream repository and commit not confirmed | MIT | `internal/sem/grammars/dart/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/dart/LICENSE); [vendored binding](apps/neuve-graph/internal/sem/grammars/dart/binding.go). |
| Erlang grammar | `WhatsApp/tree-sitter-erlang` tag `0.19`; upstream commit not confirmed | Apache-2.0 | `internal/sem/grammars/erlang/` | [Apache license](apps/neuve-graph/internal/sem/grammars/erlang/LICENSE); [vendored binding and version](apps/neuve-graph/internal/sem/grammars/erlang/binding.go). |
| F# grammar | `ionide/tree-sitter-fsharp` at upstream commit `02929f0`, as recorded in Neuve Graph import commit `8489487` | MIT | `internal/sem/grammars/fsharp/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/fsharp/LICENSE); [binding and ABI 14 integration](apps/neuve-graph/internal/sem/grammars/fsharp/binding.go). |
| Haskell grammar | `tree-sitter-haskell` v0.23.1; upstream repository and commit not confirmed | MIT | `internal/sem/grammars/haskell/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/haskell/LICENSE); [vendored binding and version](apps/neuve-graph/internal/sem/grammars/haskell/binding.go). |
| Julia grammar | `tree-sitter-julia` v0.23.1; upstream repository and commit not confirmed | MIT | `internal/sem/grammars/julia/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/julia/LICENSE); [vendored binding and version](apps/neuve-graph/internal/sem/grammars/julia/binding.go). |
| Objective-C grammar | `amaanq/tree-sitter-objc` v3.0.2; upstream commit not confirmed | MIT | `internal/sem/grammars/objc/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/objc/LICENSE); [vendored binding and version](apps/neuve-graph/internal/sem/grammars/objc/binding.go). |
| Perl grammar | `tree-sitter-perl/tree-sitter-perl` release branch, deploy commit `d7edf92`, source commit `951e607`, as recorded in Neuve Graph import commit `bb67dc3` | MIT, with the BSD file below | `internal/sem/grammars/perl/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/perl/LICENSE); [vendored binding](apps/neuve-graph/internal/sem/grammars/perl/binding.go). |
| Perl binary search header | Regents of the University of California, 1990; source repository and commit not confirmed | BSD terms with clause 3 rescinded on 22 July 1999 | `internal/sem/grammars/perl/bsearch.h` | [Full file-level copyright, conditions, and disclaimer](apps/neuve-graph/internal/sem/grammars/perl/bsearch.h). No separate change list is recorded. |
| R grammar | `r-lib/tree-sitter-r` v1.3.0; upstream commit not confirmed | MIT | `internal/sem/grammars/r/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/r/LICENSE); [vendored binding and version](apps/neuve-graph/internal/sem/grammars/r/binding.go). |
| Zig grammar | `tree-sitter-grammars/tree-sitter-zig` v1.1.2; upstream commit not confirmed | MIT | `internal/sem/grammars/zig/` | [Grammar license](apps/neuve-graph/internal/sem/grammars/zig/LICENSE); [vendored binding and version](apps/neuve-graph/internal/sem/grammars/zig/binding.go). |
| PostgreSQL grammar | Source repository and upstream commit not confirmed locally | MIT | `internal/sem/pgsql/` | [Grammar license](apps/neuve-graph/internal/sem/pgsql/LICENSE); [PostgreSQL-capable binding](apps/neuve-graph/internal/sem/pgsql/binding.go). |
| Zsh grammar | Source repository and upstream commit not confirmed locally | MIT | `internal/sem/zsh/` | [Grammar license](apps/neuve-graph/internal/sem/zsh/LICENSE); [vendored binding](apps/neuve-graph/internal/sem/zsh/binding.go). |

The grammar bindings describe how each grammar is integrated; they are not a complete list of upstream edits. Each grammar's import and later changes are in the submodule's Git history. To see Neuve Graph's changes since its baseline, run `git -C apps/neuve-graph log neuve-upstream-baseline-2026-09-27..<pin>`, with the submodule pin in place of `<pin>`.

## Package and desktop bundle details

The [UI notice](packages/ui/NOTICE.md) records shadcn/ui components under MIT, Lucide icons under ISC with portions from Feather under MIT, and Inter font files under SIL OFL 1.1. It also states that the MIT license grants no trademark rights to Ace's name or marks.

The [web app UI notice](apps/neuve-web/packages/ui/NOTICE.md) records shadcn/ui components and styles under MIT, adapted Lucide icons under ISC with Feather-derived icons under MIT, and Geist and Geist Mono font files under SIL OFL 1.1. It also lists the dependencies with non-MIT licenses and states that the MIT license grants no trademark rights to Neuve's name or marks.

The `apps/desktop/licenses/` directory keeps [Bun's runtime and linked-library notices](apps/desktop/licenses/bun.md) and the [Apache-2.0 text](apps/desktop/licenses/apache-2.0.txt). It also keeps the licenses for [Electrobun](apps/desktop/licenses/electrobun.txt), [lane](apps/desktop/licenses/lane.txt), [zig-bsdiff](apps/desktop/licenses/zig-bsdiff.txt), [bsdiff](apps/desktop/licenses/bsdiff.txt), [zig-zstd](apps/desktop/licenses/zig-zstd.txt) and [Zstandard](apps/desktop/licenses/zstd.txt). The [desktop notice generator](apps/desktop/scripts/notices.ts) collects the notices for the shipped npm packages and native components into the bundle's `notices.html` and `Credits.html`.

Other npm and Go dependencies are installed rather than copied into these source trees, and they keep their own licenses. A distributed bundle must keep the notices those licenses require. The desktop notice generator and the two UI notices describe the current package details.

## What a release archive carries

In a release archive, `share/neuve/notices/` holds this file, Neuve's `LICENSE`, every file the table links to, and `bundled/`:

- `bundled/bun/`: the `neuve` command is compiled with Bun, so it carries Bun's runtime. This folder holds Bun's own license, which names everything it links and embeds, and the license texts of those libraries, ports and polyfills, each with the commit or version it came from;
- `bundled/npm/`: the license file of every npm package compiled into `neuve`. A package that ships none carries the text from its upstream repository, with the commit it came from;
- `bundled/go/`: the license file of every Go module linked into the Neuve Graph engine, and Go's own, since the engine carries the Go runtime and standard library.

The release build writes these from its own inputs, and stops when one is missing.
