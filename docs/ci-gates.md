# CI coverage gates

The [PR workflow](../.github/workflows/ci.yml) builds the pinned Graph engine on trusted runs. The cold Linux build measured 94 seconds in [the first manual run](https://github.com/NeuveAI/neuve/actions/runs/44104230234), below the three-minute budget. Fork PRs cannot receive `NEUVE_GRAPH_DEPLOY_KEY`; only those runs declare `NEUVE_CHECK_WITHOUT_GRAPH=1`. Missing Graph on a trusted run fails the check.

## Graph without credentials

The following 118 unique cases require the private engine. This combines the prerequisite gates with the older remote-plan exclusions, deduplicating the cases present in both. The inherited handover counted seven setup-next-steps cases; the current base has nine, including full and partial old-Git clones. No new Graph coverage gate was added.

### apps/neuve-cli/tests/setup-next-steps.test.ts

- setup keeps its record in the store, leaves git status clean, covers worktrees and ends with the next steps
- Neuve's own old working-tree folder stays set up, and setup moves it into the store
- an installed neuve's setup replaces a recorded engine that is gone with the one beside it
- two repositories set up on one machine share one engine copy, and neither store holds an engine
- a project's Neuve/ folder on a case-insensitive disk is never taken for setup's old folder
- setup --route writes the route and names its sign-in; a refused route writes nothing
- setup, doctor and a refresh work while the repository's worker runs
- setup records old Git's assessment in a full clone
- setup records old Git's assessment in a partial clone

### apps/neuve-cli/tests/setup-safety.test.ts

- a project's own neuve/ folder is never deleted and never stops setup
- setup and a refresh work on a repository that commits links to a device, to another volume and relative ones, with the engine and the temporary folder on its volume or another
- an old folder whose index only looks like setup's is left whole
- an old folder that also holds a project file is left whole
- when Git can't say whether it tracks the old folder, it is left whole
- a refresh with nowhere to put its view but the Git folder says why and what to change
- setup works on a repository whose objects live in another repository

### apps/neuve-cli/tests/relations-prepare.test.ts

- stores the head and the merge base with the real engine, and a second run finds both stored
- the command stores both sides into the repository's store and says so, then says already-stored

### packages/harness/tests/section-facts.test.ts

- a declaration only the head has is added (fact: declaration added)
- a declaration deleted whole is removed and old-side only (facts: declaration removed, old side only)
- a changed parameter list is a changed signature, and leaves the body not known (fact: signature changed)
- a changed line inside a declaration with the same signature is a changed body; the export keyword alone is not (fact: body changed)
- a method added to a class is a symbol added to its span, and a changed body (fact: class member added)
- a Rust function's changed body is a changed body, with its own signature the same (the span took its name from Graph's body block, whose signature is the body, so the body was not known)
- the repository's declared kinds are the file's declared kind, and none is undeclared (fact: declared kind)
- a kind only Linguist's lists give is worded as Linguist's mark, not the repository's declaration, and keys apart from it (fact: declared kind)
- where Graph gives no signature the signature and the body are not known, never false (fact: not known)
- the stored computation's key changes when a blob's structure changes (a blob given with none, here for conflicting paths, later read with a cut), and not with input order; a second run reads what the first stored (keyed by what it reads)
- a same-named Go method inserted before an existing one is added, and the existing one is untouched (it was matched as the existing one, changed)
- a body changed in the second of two adjacent Go methods of one name is a changed body (the fact read only the first, and said false)
- a declaration moved without change has no changed body: equal text wins
- a statement that is still there after a blank line before it was removed is not 'removed' (an unnamed span has no counterpart rule)
- symbols whose parts hold colons are matched by their own parts, and their signature ids cannot collide
- with three suites' `works` tests, the middle deleted and the first edited, neither is called added or removed: several share the name (it read 'added, the base has no declaration of this kind and name')
- a row changed in another block of a one-span Terraform file is not 'no body change' (the fact read the first block only, and said false)
- a body changed in the second declarator of `export const a = 1, b = () => …` is a changed body (it read `a` only, and said false)
- a declaration moved to the end unchanged, with a different blank line before it, has no changed body (it read true)
- a statement moved inside a function body is a changed body (its added and removed rows read the same, which was read as a move)
- a blank line removed inside a body leaves the body not known: inside a template string or a heredoc it is content

### packages/harness/tests/sections.test.ts

- a block that deletes all of one declaration and adds a line to its neighbour gives the removal to the deleted declaration (it was credited to the neighbour)
- a declaration renamed in place stays one section (the pairing must not split a replacement)
- rows removed from inside a declaration with nothing added stay its own (the commonest removal)
- every row the review rules own is in exactly one section, on a change mixing all of the above (ownership is the rules', 10.21)
- section identities are given for the new pairing's output: an old-side-only section, a renamed declaration, a renamed file and a mode change (two lanes read identities from it)
- deleting one of two Rust functions whose bodies end alike gives the removal to the deleted function (spans were named after Graph's body block, `a` for both, so the pairing matched the other function)
- deleting a test from the first of two suites that both have a test of that name gives the rows to the deleted test, not to the other suite's (same-named declarations were matched by occurrence)
- deleting one of two Go methods of one name gives the rows to the deleted method (they landed in the other type's method)
- a TypeScript declaration of several names is named after the first, as Graph orders them (the greatest extent renamed it after a later one)
- a file's structure: imports as one block, a declaration with its namesake, a suite opened into its tests, a class kept whole
- a newly added file is cut into its parts, and the parts own exactly the lines the review rules gave the hunk
- changes to several members of one class are one section, across hunks
- nested describe and it calls use exposed outline ranges and never open class members

### packages/harness/tests/section-rules.test.ts

- a blank row beside an unchanged declaration, outside its symbol's lines, holds (holds)
- an unchanged declaration that owns a non-blank row is not held (owns-non-blank-rows): a slid closing line
- a blank row inside the declaration's symbol lines is not held (row-inside-declaration): a blank line can be content
- a blank row before a top-level statement holding a multi-line template is not evaluated (no-symbols): Graph gives the expression statement no symbols to tell its own lines by
- a blank row added inside a neighbouring statement's multi-line template is no blank-rows judgement: the statement's text changed
- a declaration removed from one path and added byte-identical in another hold as a pair, each naming the other (holds)
- two added and one removed of the same text are ambiguous for all three (not-held, ambiguous)
- a pair in one path is not held (same-path)
- the same hunks in another order give the same judgements, every judgement parses with the schema, and a rule that does not apply gives none

### packages/harness/tests/index-wait.test.ts

- uses answers within its bounds while the build and a shown file's chunks are held, and both carry on
- uses with every shown file's chunks ready answers as before, on both routes
- defs answers a disclosed gap while the build runs, keeps it for the call, and answers in a later turn
- semantic_search with the index ready answers as before

### packages/harness/tests/index-budget.test.ts

- a foreground second admission overlaps a held background batch within the fairness bound
- a foreground preparation overtakes a background build at its next batch release
- an existing outer grant admits once and a warm chunk cache admits nothing

### packages/harness/tests/declarations-snapshot.test.ts

- undecided and asked survive the publication and the snapshot file

### packages/harness/tests/graph-fallback.test.ts

- past the review's wait, Graph's leads and answers fall back, disclosed and counted, while Graph finishes and keeps them

### packages/harness/tests/graph-leads-at-commit.test.ts

- Graph's leads are searched at commit time with their timings and CPU, and the review finds them ready

### packages/harness/tests/graph-declare.test.ts

- the worker declares the bases still needed, none that ended, and looks again after a failure

### apps/neuve-cli/tests/preparation-orphan.test.ts

- SIGKILL of prepare-code stops a real indexing engine and its group within five seconds
- SIGKILL of prepare-commit stops a real indexing engine and its group within five seconds

### packages/harness/tests/stack-index-admission.test.ts

- upgrades the real available index fixture through admission
- upgrades the real unavailable index fixture through admission
- upgrades the real source-bound-graph index fixture through admission
- stack build cancellation during Graph work never publishes
- stack admission cancellation during Graph work never publishes
- the previous unverified Graph recipe upgrades through admission

### packages/harness/tests/graph-source-binding.test.ts

- stack discards an engine change before-graph and the next request rebuilds
- stack discards an engine change freeze-ABA and the next request rebuilds
- snapshot discards an engine change before-graph and the next request rebuilds
- snapshot discards an engine change freeze-ABA and the next request rebuilds

### packages/harness/tests/graph-request-source.test.ts

- shared tree materialization serves an index from its keyed engine

### packages/harness/tests/graph-outline-parts.test.ts

- the holder keeps an outline it cannot publish; a subscriber elsewhere gets the recorded failure, disclosed once
- a read over its bound comes in parts, each its own key, and the merged answer is one whole read's, file by file
- two callers in different processes asking for the same read at once start each part once
- two callers whose reads overlap share the parts they have in common
- within the CPU budget at most the fixed number of parts run at once, one inside an inherited grant, and cancellation stops the rest

### packages/harness/tests/graph-outline-discovery.test.ts

- checkout outline discovery and source identity do not depend on HOME or cwd
- replacing a PATH-named engine rejects its old stack index

### packages/harness/tests/commit-hunks-source.test.ts

- stored commit hunks use the source identity in their key

### packages/harness/tests/precompute-lock.test.ts

- a completed background index publishes before yielding to a new review

### packages/harness/tests/precompute-priority.test.ts

- two processes reuse one index build through the bounded temporary cache

### packages/harness/tests/result-cap.test.ts

- every pager's whole result stays within 3,000 UN9 tokens, and uses loses no match

### packages/harness/tests/git-read-retrieval.test.ts

- describeHunks keeps the captured hunk and query data when a shared symlink blob straddles groups

### packages/harness/tests/stack-tools.test.ts

- the stack tools freeze the stack state per cycle, read third-party data wrapped and labelled, and never pass for the repository

### packages/harness/tests/relations-real.test.ts

- the real engine reads the merge base and the head by commit while HEAD is on the base branch's tip, and the slice shows the real callers, the declared test callers, and counts the name match as dropped
- the real engine says where each import of a commit resolves while HEAD is elsewhere
- on the real engine, file-level callers removed with a function are not still pointing at it, and untouched ones are
- with the worker's socket in the repository's Git directory, both sides are read from the store's private clone and the repository is untouched
- a commit made after the private clone exists is read from it
- moving the private clone's HEAD between two reads of one commit gives the same index
- on the real engine, Python relative modules sharing one relation are read on both sides of a round, and each answers its own target

### packages/harness/tests/relations-matched-real.test.ts

- on the real engine, a resolved, a receiver-type and a name-only call into changed symbols each say how they were matched, and a same-file name-only method match is counted, not kept

### packages/harness/tests/relations-fixture.test.ts

- on the real engine, every expected relation is the row the slice gives, with its match class, test flag and site, and no other row appears
- on the real engine, the three removals, the symbols with no caller, the counterparts, two members of one name, the counts and the changed edges are as recorded

### packages/harness/tests/relations-task.test.ts

- on the real engine the task stores both sides once each, and a round afterwards reads both stored

### packages/harness/tests/commit-relations-real.test.ts

- a review started after preparation finds both sides stored without starting a read
- with readings off the preparation child reads nothing, makes no clone and logs as before
- a range preparation reads no relations, for the range or any of its commits
- the worker's and the preparation child's clones give the same index, repoKey included
- with the commit's hunks held by another caller, the preparation reads no relations

### packages/evaluation/tests/retrieval-bench-cancel.test.ts

- interrupting a one-file benchmark view aborts its real Graph symbols command
- interrupting a one-file benchmark query aborts its real Graph symbols command
- interrupting a one-file benchmark changed-symbols aborts its real Graph symbols command
- benchmark CLI shutdown reaches provider setup before its command starts

## Cases kept off Linux

The portable plan retains these existing platform boundaries. They are not new skips:

- Root: `the generated protocol preserves SDK and native types`, which reads the Mac native SDK.
- Records: names beginning `a process that can only read an older store`, which use macOS `chflags uchg` to make the store immutable to its owner. Local checks run them.
- Web: names beginning `the web app and the CLI freeze the same run key`, whose fixture still writes settings under the macOS `Library/Application Support` path. Local checks run them.
- Evaluation: `the committed harness holds every snapshot marker the seam path needs`, which reads the owner's installed archive. Local checks run it.
- CLI: names beginning `the worker this build starts loads neither the project's`, which exercise this checkout's source worker environment. The legacy plan runs this test locally; a current macOS-only requirement has not been established. This exclusion is unchanged and needs reassessment when CI can run again.
- The `@ace/host` suite stays outside the portable plan, as before. It includes the native host runtime and stays local in the legacy plan.

The observed Linux run also retains these existing environment gates:

- `macOS starts a real preparation child at nice 19, with no background class` requires macOS scheduling behavior.
- `spawnEnvironment > the CLI, launched with it, prepares through paths with spaces and apostrophes and refuses another identity as JSON` needs a real disk identity from macOS DiskManagement. The other storage cases use stand-in identities when the host cannot identify a mount.
- `the offer reads its answer from /dev/tty, as the installer gives it` requires `/usr/bin/expect`, which the Linux runner does not provide.
- Shared-worker cases `a stopped older worker with a full backlog retains attempt one`, `drop notice survives a refused publication`, and `worker ${outcome} delivers with its own socket saturated` for `completed`, `failed` and `exhausted` require the Mac socket-backlog behavior. Those five existing platform skips are the skips in the successful Linux observer probe.

## Release archives

The four macOS jobs run only for the four path groups documented in [the development command table](development.md#commands), or on `workflow_dispatch`. This is a cost gate for the hour-long installer suite, not a portable test exclusion. Every distribution and systemd-installer registration belongs to exactly one runner; the other release files use Bun's file shards. The external-files matrix registers each shell and login-shell combination separately so its full 42 scenarios can be distributed too. Local `bun run test:release` still runs the whole suite.

Without the Graph deploy key, the existing `available` gates in `archive.test.ts` and `distribution.test.ts` omit native archive cases because they cannot build an archive containing the private engine. Fixture installer and release-command cases still run. Linux-only systemd cases keep their existing platform gates on these Mac runners.

NEU-405's `GITHUB_ACTIONS` gate stays in `distribution.test.ts`, as requested. These hosted launchctl fixtures previously reported the registered agent "runs another command". The command-reader correction has local coverage, but its full hosted rerun is blocked by Actions billing. These cases still run locally:

- `launchd final state after handoff: ${shell}/${order}/${boundary}`, for each available shell (`sh`, `dash`), both orders (`A-B`, `B-A`), and boundaries `uninstall` and `rollback`. The `print` boundary still runs on Actions.
- `rechecks the launchd file at each rollback step: ${shell}`, for each available shell.

Three pre-existing explicitly skipped distribution cases remain unchanged:

- `upgrades release A to B through file downloads and keeps repository links`
- `restores native release A after group TERM during upgrade and retries to B`
- `upgrades from file downloads and refuses a tampered script`

Their adjacent source comments record that these older file-download upgrade cases require public release downloads and the installer now authenticates GitHub downloads under NEU-374. This change adds no unconditional test skip.
