# Full preparation: what made it cheaper, 25 October 2026

Full preparation is the Graph engine building its complete graph of a commit. Rebases, amends, branch switches and review bases pay for it in full. Two changes made it about a third cheaper, with the same output byte for byte. The work stops here: every remaining target is under 5%.

## Before and after, from this morning to now

Each figure is the mean of three runs of the full snapshot build, interleaved on the same load, timed with `/usr/bin/time`.

| Base | Build | Wall time | CPU | Peak memory |
| --- | --- | --- | --- | --- |
| Neuve (`db59b684`) | This morning (`b30809c`) | 34.0 s | 60.4 s | 593 MB |
| | Relation-phase passes (`d1eae68`) | 23.2 s | 44.8 s | 603 MB |
| | Re-export facts (`52ea48d`) | 22.5 s | 40.4 s | 610 MB |
| neuve_effect (`efcd52f6`) | This morning | 13.7 s | 28.5 s | 551 MB |
| | Relation-phase passes | 9.3 s | 21.3 s | 535 MB |
| | Re-export facts | 9.1 s | 20.3 s | 521 MB |

From this morning to now:
- **Neuve:** wall −34%, CPU −33%.
- **neuve_effect:** wall −34%, CPU −29%.

In the 71-hunk long run, its 23 full preparations, all cold, took 428 s, then 313 s, then 298 s (−30%).

## The proof

- **Snapshot.** The full snapshot NDJSON (files, symbols and every relation) is byte for byte the same on both bases, in all 18 timed runs and across all three builds: 226,688 records on Neuve and 224,938 on neuve_effect.
- **Long run.** 142 of 142 answers are identical after each change, with 0 failures.
- **Reference tests.** Each changed function is compared with its verbatim old version on real source and on generated adversarial text, and deliberate breakages fail every test.
- **Review and suites.** Each change passed an independent review with nothing blocking, and the race suites.

## What changed

Half of a full preparation's CPU was regular expressions in the relation phase. Parsing was only about 4%.

1. **String constants found once.** Each file's constants re-ran their regex over the whole file on each of up to five fixed-point rounds. Now the assignments are found once. Two identical copies of the derivation are one.
2. **One answer per file per phase.** A file's constants and JavaScript import bindings are derived once and shared by the route passes, the per-file loop and the Express pass. Up to seven passes had each derived them again.
3. **Router passes.**
   - The route regex was compiled on every call, which meant once per symbol; it is now compiled once.
   - The router extractors skip text without the literal their patterns require.
   - Case is ignored only on pure-ASCII text. A case-insensitive regex also folds the long s with s and the Kelvin sign with k, so any other text still runs the regex.
4. **Return flows.** They look for a returned local before scanning a body's assignments, since only a returned local reads them.
5. **Re-export facts.** Resolving imports through re-exports re-read every module it reached from git, once for every importing file. Now each module's facts are found once per phase and kept instead of its content: whether it can be read, its named re-exports with the names they bind, and its star re-exports.

Tried and dropped:
- **A phase-wide content cache.** It saved about 1 s of CPU for 62 MB of extra memory.
- **Batching the per-file pipeline's hand-offs.** No measurable change.

## Why the work stops here

Profile of the current build on Neuve, 33.3 s of CPU:

| Target | Share | Why it falls under the bar |
| --- | --- | --- |
| Rest of return flows | 8.9% | Spread over about fourteen helpers, the largest 0.73 s (2.2%). Prefiltering them one by one would gain perhaps 2–3%. |
| Cross-file Express pass | 6% | Splits into sub-2% extractors. |
| Receiver calls | 5.5% | Splits into sub-2% pieces. |
| Remaining per-file regexes | each 2% or less | |
| Parsing | about 5% | Not a regex cost. |
| Runtime scheduling wake-ups | about 18% | Not traced to any pipeline we own. |

## For incremental reuse

What each pass's output depends on (per file, per symbol or cross-file) is below, in "What each relation pass reads". It is the groundwork for dependency-tracked reuse. The per-file and per-symbol derivations can be reused by content digest. The per-file worker needs the global-table keys it looked up. Re-export resolution needs the content of the modules it reached.

## What each relation pass reads: groundwork for reusing relations per file

This is gathered while making full preparation cheaper (25 October 2026). For each pass it records what decides the pass's output for one file, so later work can tell which relations stay valid when other files change. It only lists what was read in the code; it is not an exhaustive audit.

| Pass or derivation | What its output depends on | Scope |
| --- | --- | --- |
| `staticStringConstants` / `staticJSStringConstants` | The file's content only (one regexp, fixed-point resolution among the file's own assignments) | Per file |
| `importedJavaScriptBindings` | The file's content only (its import and require forms, and the file's own constants) | Per file |
| `returnFlowCalls` and its helpers | One symbol's stripped body and its parameter names | Per symbol |
| `jsRouterRoutes`, `jsRouterMounts`, `jsRouterConstructorPrefixes` | The text block given (a file, or one symbol's block) and that file's constants | Per file or symbol |
| `crossFileExpressRouterRelations` | Every JS/TS file's routes, mounts and plugin mounts; each file's import bindings and default export; other files' symbols by name; the set of known files | Cross-file: a mount in one file joins routes declared in another |
| `jsDirectRouteRelations` | Each file's content, constants and symbols | Per file |
| `resolvedImportedNameModules` → `resolvedJavaScriptReexportTargets` | The importing file's imports; the content of every module reached through re-exports, up to 8 levels; the known-file set; manifest import resolution | Cross-file: a change to a re-exporting module changes its importers' resolved targets |
| Per-file relation worker (`forEachRelation`'s workers) | The file's content and symbols, plus global tables built from all files: symbols by short name, by file, by container; container children, methods and fields; return types by name and file or directory; route handlers; GraphQL fields and resolvers; partial-type canonical containers | Cross-file through the global tables |

### What follows for incremental reuse

- **Per-file and per-symbol derivations** (constants, import bindings, return flows, router extraction from one file) can be reused by content digest alone.
- **The per-file worker's relations** depend on the global tables. Reusing them needs, per file, the keys it looked up in each table (positive and negative) and the values it saw.
- **Re-export resolution** depends on the content of the modules it reached. Their paths and digests would have to be recorded per importing file.
- **The cross-file Express pass** is global by construction and would be re-run whole from per-file facts. It is cheap once the per-file extraction behind it is reused.
