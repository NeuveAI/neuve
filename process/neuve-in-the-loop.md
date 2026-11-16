# Neuve in the lane loop

Status: how Neuve's own build lanes use Neuve, from [decision 12.54](decisions.md#area-12-ace-style-pi-transition-28-october-2026). It adds Neuve to the [lane rules in `AGENTS.md`](../AGENTS.md#how-agents-build-neuve) and the [adversarial review standard](adversarial-review-standard.md); it doesn't replace either. Approval still comes only from review. The aim is to see what running Neuve in the development loop and the final review changes, and where to improve it next, so every round keeps its telemetry, its session logs and an impact record that can be compared across lanes.

`S` is the transition's folder on the owner's drive, the one that holds the `state`, `cache` and `tmp` paths of the owner's [storage profile](../scripts/pi-storage.ts). `L` is the lane's coordination folder, `S/coordination/ace-neuve/large-review`. `D` is `S/dogfood/<lane>/`, where the capture for one lane lives. `<lane>` is the lane's slug, for example `neu-123-desk-claim`. The helper scripts are in `L/tools/dogfood/`.

## Which Neuve runs

Lanes run the installed `neuve` (`~/.local/bin/neuve`). Lanes never use a source checkout or a lane's own build: the build doing the review must not be the code under review, and its worker must not depend on a worktree that keeps changing.

After each merge to main, the coordinator brings the LaCie checkout level with origin (`git pull --ff-only`, then `git submodule update apps/neuve-graph`), reinstalls dependencies (`bun install --backend=copyfile --frozen-lockfile`, because a merge can add workspace links), runs `bun run build:graph`, then `bun run check` in the check queue, then `bun run install:cli`. `bun run check:installed` shows whether the installed copy is behind. Until the install lands, lanes use the copy that is already installed.

A review runs on whichever worker is already up for the store. `neuve review` hands its job to that worker, and `bun workspace` from the LaCie checkout starts one from source. So the capture records two builds: the CLI's, from `source.commit` in `~/.local/lib/neuve/install.json`, and the worker's, from `worker.log`. Neither the run log nor the receipt names the worker's build yet.

## The loop

| Step | Who | Command | Output goes to |
| --- | --- | --- | --- |
| 1. Scope at the start | Implementer, in its worktree | `neuve query --repo <absolute impl worktree> --revision <full base hash> --question "<the ticket's goal and done-when, in one sentence>" --relationship-plan '[]' --max-results 12 --max-context-bytes 60000`. In round 2 and later it also reads the previous round's receipt | `D/scope/round-<n>.json`. The brief names the file. The implementer reads it before the code; it is context, not scope. Linear stays the scope (7.12) |
| 2. Neuve review | Started by the lane coordinator once it holds a heavy slot, when the reviewer starts | `neuve review <base>..<head> --detach --repo <review worktree>` | A review cycle in `.git/neuve/records.sqlite`. The coordinator writes the request's cycle, job and run IDs to `D/round-<n>/request.json` |
| 3. Receipt | Lane coordinator, when the run completes | `neuve review show --run <run-id> --json --repo <review worktree>` | `D/round-<n>/receipt.json`: stages, turns, tokens, cost, time, disclosures and the packet |
| 4. Reviewer's verdict | Codex reviewer | Reviews on its own first, as the standard says, and writes its findings. Then it reads `D/round-<n>/receipt.json` and gives every Neuve finding and validation requirement a verdict: confirmed (with a reproduction), refuted (with the reason), not a defect, or unverified | The review report in `L/reviews/`, with a "Neuve's findings" table of finding, verdict and reason, and the defects it found that Neuve missed. Only confirmed correctness or security defects block, as for the reviewer's own findings |
| 5. Owner's desk | Lane coordinator | `bun workspace` from the LaCie checkout. An agent keeps its stdin open (`tail -f /dev/null \| bun workspace`), because with stdin closed it exits 0 without a word. The batch overview is `<web>/review/<sha256 of the project path>/cycles/<cycle-id>` | When the packet has human-required units, the coordinator sends the owner the batch overview link and the count. The lane doesn't wait on the owner's dispositions unless the owner says so (open in 12.54) |
| 6. Session dump and stats | Lane coordinator, once the run is complete | `neuve review export-dump --run <run-id> --root D/round-<n>/dump --repo <review worktree>` (restricted, the default). Then `neuve review stats --cycle <cycle-id> --json` | `D/round-<n>/dump/`, `D/round-<n>/stats.json` |
| 7. Telemetry | Lane coordinator, once the run is complete | `L/tools/dogfood/capture-telemetry.sh <lane> <n> <run-id> <job> <cli build> <worker build>` | `D/round-<n>/telemetry/`, described below |
| 8. Codex logs | Lane coordinator | Every `codex exec` runs with `--json`, its stdout going to `D/round-<n>/codex-<role>.jsonl`. The session's rollout file under `~/.codex/sessions/` is copied beside it | `D/round-<n>/codex-implementer.jsonl`, `codex-reviewer.jsonl` and their `rollout-*.jsonl` |
| 9. Impact | Lane coordinator, after the reviewer's verdict | Writes `impact.json` and `impact.md` from the files above, then runs `L/tools/dogfood/ledger-append.sh <lane> <n>` | `D/round-<n>/impact.json`, `impact.md`, and one new row in the ledger |

`D/index.json` lists each round: lane, base, head, both builds, cycle, job, run, and the paths above.

## Telemetry

| What | Where it lands today | What step 7 copies |
| --- | --- | --- |
| Run log: model-call, tool-call, stage and gap records; spans and `harness.*` metrics only while telemetry is on | `.git/neuve/run-logs/<run-id>.jsonl` in the store | `run-log.jsonl`, plus `metrics.jsonl` (its metrics) and `budget-receipts.jsonl` (its `budget.receipt` records) |
| Worker events | `.git/neuve/worker.log`, shared by every run in the store | `worker.log`: the lines naming the run or its job |
| Graph call and deadline records | Graph spans and `harness.graph.*` metrics in the run log, written only when Graph search and telemetry are on | `graph-spans.jsonl` |
| Budget host events | The host keeps no event log. A run sees the budget only through `budget.receipt` records and, while telemetry is on, `harness.budget.*` metrics | Nothing more |
| OTLP export | Off on this Mac. Export needs `telemetry.otlp.baseUrl` in `~/Library/Application Support/Neuve/settings.json` and `telemetry.enabled` must not be false. Its loss ledger is under `.git/neuve/telemetry-state/` | `otlp-ledger/`, when there is one |

`telemetry/sources.json` records the run, both builds, the record counts, and each gap with what would turn it on. From 9 November this Mac's user settings set `telemetry.enabled: true`, logs only, for source runs and compiled builds, as [decision 12.55](decisions.md#area-12-ace-style-pi-transition-28-october-2026) requires for lane timings. Spans and metrics land only while telemetry is on; off keeps the other run-log records, receipts and session dumps. On 9 November the gaps were: Graph search off (`search.graph` isn't set), no OTLP export, no budget event log, and no worker build in the run log. The last two need product changes. This loop changes no settings: turning Graph search or OTLP on is the owner's call.

## Impact record

Every round has `D/round-<n>/impact.json`, with the same fields in every lane, and a short `impact.md` that says the same in prose. Counts and IDs only.

| Part | Fields |
| --- | --- |
| Dev loop | `devLoop`: the context's status and result count; whether the implementer used it, from its report and Codex log; the number of files the context named, the number the implementer touched, and the overlap |
| Final review | `finalReview`: the Codex verdict and report; Neuve's findings, validation requirements and agent dispositions; one verdict per Neuve item (confirmed, refuted, not a defect, unverified); the defects Codex found that Neuve missed, and the reverse |
| Desk | `desk`: human-required, human-suggested, agentic and static units; whether the owner acted (owner dispositions in Records) and when that was checked |
| Overhead | `overhead`: Neuve's wall time, queue wait, model calls, tokens, cost and peak calls in flight; each Codex session's wall time (from its rollout's timestamps) and tokens (from its `turn.completed` usage) |
| Failures | `failures`: each Neuve failure or refusal, with the step, the command and the exact error |

## Ledger

`S/dogfood/ledger.jsonl` has one row per round, across lanes, so trends show. The lane coordinator appends the row with `ledger-append.sh` once the round's `impact.json` is complete, after the reviewer's verdict, and again for a later round. The script derives every field from `impact.json`, including Neuve's share of the lane's agent wall time and input tokens. It refuses a lane and round that are already there. Nobody edits the ledger by hand.

## Rules

- **Graph in lane worktrees.** Tests that need the Graph engine skip when `apps/neuve-graph/entire-graph` is missing, and lane worktrees don't build it. The coordinator copies the engine built in the LaCie checkout into each lane worktree's `apps/neuve-graph/` before the implementer starts.
- **Slots.** A Neuve review run is heavy work. It takes a slot from the same queue as `bun run check`, one at a time on this Mac.
- **Shared work.** When the same range and configuration is asked for twice, the second request follows the first job ([record 0016](../architecture/decisions/0016-shared-work.md)). Never start a second run for the same range.
- **Failures are data.** If any Neuve step refuses or fails, the lane keeps going without it. The coordinator records the exact error in `D/round-<n>/error.txt` and in `impact.json`, and files it as a Neuve defect.
- **Never print** credentials or model content. Dumps, run logs and Codex logs stay restricted, on LaCie. Reports, impact records and the ledger hold counts and IDs only.
- **Independence.** The reviewer's brief carries the scope and the definition of done. Neuve's packet reaches the reviewer only after it has written its own findings, so the packet never sets the reviewer's premise (7.1, 11.4).
