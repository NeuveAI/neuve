# Fresh candidate comparison (NEU-58)

The replay runners and benchmark inputs are kept in the private archive, so the historical commands below run only from a checkout of it. By default, shared evaluation helpers look for benchmark inputs inside the repository they run from.

NEU-58 owns the comparison scope. This guide describes how to run it against the fixed baseline.

A fresh candidate is a changed build's scored review of the replay's cases, compared with the replay's first runs. Here the changed build is the pi port. The baseline is the existing corpus on the research volume (called R, and kept privately), which this path only reads. Everything it writes goes to a treatment folder outside R.

The candidate is its own kind of run. The other kinds cannot measure a new runtime:

| Kind                                   | Why it cannot measure the port                               |
| -------------------------------------- | ------------------------------------------------------------ |
| Repeat (`cloud-2` … `cloud-7`)         | It must be the replay's build, and that refusal is unchanged |
| Recompose (`rc-<k>`)                   | It reuses the replay's stored model steps                    |
| Reading run (`reading-8`, `reading-9`) | It is never scored                                           |

What runs where:

- **Modal orchestrator.** `research/pr-bench/replay/modal/app.py` (kept in the private archive) runs `upload --out candidate-<k>` and `candidate`. The candidate's machine runs `candidate.sh`, which wraps the unchanged `review.sh`.
- **Local collector.** `bun packages/evaluation/src/candidate/cli.ts` writes the manifests and the comparison.
- **Labelling.** It is the existing `pr-replay` commands with `--run candidate-<k>`, under `NEUVE_TREATMENT_ROOT`.

## What decides whether a case is scored

The manifest reads each run's receipt, never an exit code, and its outcome is one of these states:

- `completed`: the outcome is completed, the packet is complete with at least one batch, and every stage was computed or reused.
- `timed-out`, `partial`, `missing` or `malformed` otherwise.

A candidate run is scorable only when all of these hold:

- its execution completed;
- `build.json` records no undeclared build difference and no run-policy difference (model, effort, lifetime), except the explicit effort comparison below;
- the control receipt it was compared with is still byte-identical;
- its snapshot was recorded by the run's `ended` close, with execution `ended` (`capture.json`'s `close`);
- its session dump passes `captureBlockers`.

`captureBlockers` asks four things of the dump, read through the capture lane's public reader:

- The capture is complete, meaning there is no gap of kind `capture`.
- The run status is `completed`.
- Every stage ended `completed`, and there is at least one.
- No gap of kind `execution` is left. Such a gap is work an open run still owes.

Once `run.end` is captured, the [capture gap rules](../../../harness/src/pi/capture/dump.ts) count the same `EXECUTION_GAPS` codes as capture gaps. An ended run with `lead-fates-absent` or `leads-open` is therefore incomplete. The native [Investigate, Assemble, and Dispose handoffs](../../../harness/src/pi/stages/batch-task.ts) and [Publish handoff](../../../harness/src/pi/stages/index.ts) emit `lead.fate` events. Their presence in source does not establish any candidate capture's completeness. The public reader checks each dump, and the comparison lists each gap code with its count.

The machine files the run's latest snapshot. A held or interrupted close is filed too and asked again, up to twelve times five seconds apart, until the ended close lands. At that deadline the last healthy snapshot stays as a partial run. A failed or malformed latest close leaves no dump at all; an older snapshot never stands in for it.

A run that may not be scored stays in the denominator. The parity method lists it as failed and leaves it out of its pairs. The candidate report also counts every concern of its case as `lost`.

Reviewer threads with no majority label are counted apart as unavailable labels, never as misses. Coding and reading captures are refused by name.

## Score an effort comparison

Pass `--effort-comparison low` or `--effort-comparison medium` to both `manifest candidate` and `compare`. The manifest admits a policy difference only when `build.json` lists exactly `["effort"]` and the receipt's effort matches the named level. Model and lifetime differences, undeclared build differences, incomplete execution or capture, and a changed control receipt remain blockers. Without the flag, the existing policy gate and output format are unchanged.

The manifest records the declaration as `effortComparison` and each receipt's effort in `cases[].runs[].route.effort`. `compare.json` records `effortComparison` and both arms' receipt efforts in `efforts`. The Markdown title and headline table name the efforts. Token totals and ratios still compare scorable pairs, with both efforts labelled in the token heading. They measure different efforts rather than repeats of one policy.

Use the existing pinned baseline and the same sample after the candidate's cloud labelling is complete. Set `NEUVE_RESEARCH_ROOT` to the research volume, `NEUVE_TREATMENT_ROOT` to the collected treatment, `SAMPLE` to the pinned sample, `BASELINE` to its baseline manifest, and `RUN` to the collected candidate run. `MANIFEST` and `REPORT` must be fresh paths outside the research volume.

```bash
: "${TMPDIR:?Set TMPDIR to the tmp folder in the external state folder}"
export TMPDIR
bun packages/evaluation/src/candidate/cli.ts manifest candidate \
	--sample "$SAMPLE" --run "$RUN" --effort-comparison medium --out "$MANIFEST"
bun packages/evaluation/src/candidate/cli.ts verify "$MANIFEST"
bun packages/evaluation/src/candidate/cli.ts compare \
	--baseline "$BASELINE" --candidate "$MANIFEST" --effort-comparison medium --out "$REPORT"
```

The compare flag must match the manifest's declaration. An existing manifest collected without the flag retains its policy blockers. Collect a fresh manifest with the flag to score an effort comparison.

## Recipe for the final comparison

Root runs this only after the integrated code is approved at its final commit. A passed root check or local build admission does not approve the source or authorize dispatch. The owner still performs the full integrated run before any merge to main, as [decision 12.4](../../../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) requires. Reviews and model labelling calls run only in the cloud. The collector and label settlement run locally.

Reuse the existing version 3 baseline and inventory under `$S/preflight/codex-baseline-v3-15950d27-20261029`. They pin 63 comparison cases including 3 controls, 133 development floor cases, and 159 inventory cases. Keep the 5 historical sample timeouts. Do not collect a replacement baseline or repair historical runs. Verify the pinned manifests with the final collector before dispatch and after comparison.

Use the final approved source commit for both clean clones. A later capture correction changes that commit and requires matching clones and build admission. Existing preparation for an earlier commit cannot stand in for it. If exact final clones and treatment metadata are already prepared, verify and reuse them through their guarded continuation. The clone commands below are for an unprepared final commit and refuse existing paths.

**Preconditions:**

- The pinned build exports `@neuve/harness/session-dump` (`readSessionDump`), and has `neuve review export-dump` (`apps/neuve-cli/src/review-cli.ts`).
- The pinned build's runtime writes `run.snapshot` and `run.close-failed` to the run log at each close.
- `neuve review show --json` still gives the `RunReceipt` fields.
- The refresher (`lease.py`) is deployed and the labellers' cloud sign-ins exist. Both are the owner's.
- Root refreshes cloud occupancy, locks, deployed app and sign-in-volume metadata, and refresher readiness before dispatch. Use eight review machines only when no competing work is present. Eight is the orchestrator's existing maximum, set in `research/pr-bench/replay/modal/app.py` (kept in the private archive).
- The three cloud labellers (`research/pr-bench/replay/modal/label.py`, kept in the private archive) use separate Codex/Sol judge accounts, with one call at a time per account. Keep their existing model, effort, prompts, two passes, tie pass, retries, and decoy stop. Keep review settings, retrieval, and scoring policy unchanged. The review policy in `app.py` (kept in the private archive) retains the OpenAI route, high effort, and 20-minute deadline. The [judge route](../retrieval-bench/labelling/routes.ts) uses `gpt-6.1-sol`; [matching](../pr-replay/matching.ts), [rubric judging](../pr-replay/rubric-judge.ts), and [merit](../pr-replay/merit.ts) retain medium effort.

```bash
set -euo pipefail
: "${C:?Set C to the independently approved final codex/pi-transition commit}"
: "${NEUVE_RESEARCH_ROOT:?Set NEUVE_RESEARCH_ROOT to the research volume}"
: "${NEUVE_STATE_ROOT:?Set NEUVE_STATE_ROOT to the external state folder}"
: "${NEUVE_SOURCE_ROOT:?Set NEUVE_SOURCE_ROOT to a local clone of this repository}"
R="$NEUVE_RESEARCH_ROOT"
S="$NEUVE_STATE_ROOT"
P="$S/preflight/codex-baseline-v3-15950d27-20261029"
B="$S/validation/build-${C:0:12}"
O="$S/validation/orchestrator-${C:0:12}"
T="$S/validation/treatments/pi-port-${C:0:12}"
BASELINE="$P/baseline-v3.json"
RUN=candidate-1
# Reconfirm candidate-1 is unused on the cloud volume. Do not replace a used candidate subpath.
# If it is used, stop. The owner chooses any whole-sample retry and its new candidate-<k> name.
test ! -e "$B"
test ! -e "$O"
test ! -e "$T"
mkdir -p "$S/tmp/validation"
export TMPDIR="$S/tmp/validation" BUN_INSTALL_CACHE_DIR="$S/cache/bun" \
  UV_CACHE_DIR="$S/cache/uv" UV_PROJECT_ENVIRONMENT="$S/cache/validation-modal-venv" NEUVE_RESEARCH_ROOT="$R" \
  PYTHONDONTWRITEBYTECODE=1
unset NEUVE_TREATMENT_ROOT NEUVE_IMAGE_WORKSPACE NEUVE_REASONING_SUMMARIES

git clone --recurse-submodules "$NEUVE_SOURCE_ROOT" "$B"
git -C "$B" checkout --detach "$C"
git -C "$B" submodule update --init --recursive
git clone "$NEUVE_SOURCE_ROOT" "$O"
git -C "$O" checkout --detach "$C"
(cd "$O" && bun install --frozen-lockfile --backend=copyfile)
EVAL="$O/packages/evaluation"
M="$O/research/pr-bench/replay/modal"
SAMPLE="$O/validation/benchmarks/m4/results/full-test/lanes/parity-sample.json"
test "$(git -C "$B" rev-parse HEAD)" = "$C"
test "$(git -C "$O" rev-parse HEAD)" = "$C"
test -z "$(git -C "$B" status --porcelain)"
test -z "$(git -C "$O" status --porcelain)"
python3 - "$SAMPLE" "$BASELINE" <<'PY'
import hashlib,json,sys
m=json.load(open(sys.argv[2]))
assert m['version']==3
assert hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest()==m['sample']['sha256']
assert len(m['cases'])==63 and len(m['floorUniverse'])==133
PY
bun "$EVAL/src/candidate/cli.ts" verify "$BASELINE"
# Preserve the historical inventory and index. This reads their exact pinned files and absences.
bun "$EVAL/src/candidate/cli.ts" verify "$P/inventory-v3.json"
mkdir -p "$T/manifests" "$T/logs" "$T/tmp"
python3 - "$BASELINE" "$T" <<'PY'
import json,pathlib,sys
m=json.load(open(sys.argv[1])); t=pathlib.Path(sys.argv[2])
cases=[c['source']+':'+pathlib.Path(c['directory']).name for c in m['cases']]
(t/'cases.txt').write_text('\n'.join(cases)+'\n')
for n in range(3): (t/f'labeller-{n+1}.cases').write_text('\n'.join(cases[n::3])+'\n')
PY
mapfile_compat() { CASE_ARGS=(); while IFS= read -r c; do CASE_ARGS+=("$c"); done < "$T/cases.txt"; }
mapfile_compat
# This port declares productCommit,scripts, with Graph unchanged.
# Recheck the final C against every control before upload. Do not broaden declarations to hide a change.
# Deadline, settings, model, effort, and lifetime cannot be declared different.
(cd "$M" && uv run --frozen python - "$B" "$T" "$RUN" <<'PYBUILD'
import json,sys
from pathlib import Path
import app
app.image_build.use_workspace(Path(sys.argv[1]).resolve())
t=Path(sys.argv[2]); run=sys.argv[3]
cases=[app.parse_case(line.strip()) for line in (t/'cases.txt').read_text().splitlines() if line.strip()]
app.refuse_dirty_orchestrator()
build=app.candidate_build()
declared={'productCommit','scripts'}
problems=app.candidate_problems(cases,build,declared,t,run)
record={'build':build,'declared':sorted(declared),'problems':problems}
(t/'manifests/build-preflight.json').write_text(json.dumps(record,indent=2)+'\n')
if problems: raise SystemExit('Final build preflight refused. Inspect treatment/manifests/build-preflight.json before any upload.')
PYBUILD
)
(cd "$M" && uv run --frozen python app.py upload "${CASE_ARGS[@]}" --out "$RUN")
(cd "$M" && uv run --frozen python app.py candidate "${CASE_ARGS[@]}" --out "$RUN" \
  --treatment "$T" --build "$B" --declare productCommit,scripts --concurrency 8)

export NEUVE_TREATMENT_ROOT="$T" NEUVE_LABEL_RUNNER=cloud TMPDIR="$T/tmp" \
  UV_CACHE_DIR="$T/tmp/uv-cache" UV_PROJECT_ENVIRONMENT="$T/tmp/modal-venv"
# The three accounts receive disjoint cases. Each command retains its own two passes and tie pass.
# Busy-lock refusals use the existing driver's 360 attempts, 30 seconds apart.
case_worker() {
  local labeller="$1" command="$2" c try rc log completed
  while IFS= read -r c; do
    test -n "$c" || continue
    log="$T/logs/${command}-${labeller}-${c/:/-}.log"
    completed=0
    for try in $(seq 1 360); do
      rc=0
      NEUVE_LABELLER="$labeller" bun "$EVAL/src/pr-replay/cli.ts" "$command" \
        "${c%%:*}" "${c##*:}" --run "$RUN" > "$log" 2>&1 || rc=$?
      if rg -q 'the cloud labeller is busy' "$log"; then sleep 30; continue; fi
      test "$rc" -eq 0 || return "$rc"
      if rg -q ': incomplete, run again' "$log"; then return 1; fi
      completed=1
      break
    done
    test "$completed" -eq 1 || return 1
  done < "$T/labeller-$labeller.cases"
}
case_worker 1 match & a=$!
case_worker 2 match & b=$!
case_worker 3 match & c=$!
wait "$a"; wait "$b"; wait "$c"
F="$T/labels/confirm-$RUN"
bun "$EVAL/src/pr-replay/cli.ts" confirm "$F" 20261029 --run "$RUN" > "$T/logs/confirm-build.log"
# Atomic chunk claims allow the existing rubric command to share this folder.
# A busy refusal does not count as a failed round. The historical rubric driver allows 30 rounds.
rubric_worker() {
  local labeller="$1" round=0 rc log="$T/logs/rubric-$1.log"
  while [ "$round" -lt 30 ]; do
    test ! -f "$F/decided.json" || return 0
    rc=0
    NEUVE_LABELLER="$labeller" bun "$EVAL/src/pr-replay/cli.ts" rubric "$F/items.json" "$F" > "$log" 2>&1 || rc=$?
    if rg -q '"busy":true|the cloud labeller is busy' "$log"; then sleep 120; continue; fi
    test "$rc" -eq 0 || return "$rc"
    round=$((round+1))
    test ! -f "$F/decided.json" || return 0
    sleep 30
  done
  return 1
}
rubric_worker 1 & a=$!
rubric_worker 2 & b=$!
rubric_worker 3 & c=$!
wait "$a"; wait "$b"; wait "$c"
bun "$EVAL/src/pr-replay/cli.ts" confirm-settle "$F" > "$T/logs/confirm-settle.log"
python3 - "$F/report.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['complete'], 'confirmation is incomplete'
assert not r['decoys']['stop'], 'existing confirmation decoy stop exceeded'
PY
case_worker 1 merit & a=$!
case_worker 2 merit & b=$!
case_worker 3 merit & c=$!
wait "$a"; wait "$b"; wait "$c"
# Inspect label completeness and decoy reports before freezing candidate outputs.
bun "$EVAL/src/candidate/cli.ts" manifest candidate --sample "$SAMPLE" --run "$RUN" --out "$T/manifests/$RUN.json"
bun "$EVAL/src/candidate/cli.ts" compare --baseline "$BASELINE" \
  --candidate "$T/manifests/$RUN.json" --out "$T/reports/compare-$RUN"
bun "$EVAL/src/candidate/cli.ts" verify "$BASELINE"
bun "$EVAL/src/candidate/cli.ts" verify "$P/inventory-v3.json"
bun "$EVAL/src/candidate/cli.ts" verify "$T/manifests/$RUN.json"
test -z "$(git -C "$B" status --porcelain)"
test -z "$(git -C "$O" status --porcelain)"
shasum -a 256 "$BASELINE" "$P/inventory-v3.json" "$T/manifests/$RUN.json" "$T/reports/compare-$RUN/compare.json" "$T/reports/compare-$RUN/compare.md" > "$T/final-artifacts.sha256"
```

The match, rubric, and merit workers above use three disjoint 21-case lists and one call per account. `confirm` and `confirm-settle` collect and settle labels locally. Busy refusals retain the existing waits and do not consume a rubric round. Stop on incomplete labels or the existing decoy stop. A whole-sample retry uses a new `candidate-<k>` name chosen by the owner, never a subset written into an existing run.

The build comparison in `app.py` (kept in the private archive) accepts one comma-separated `--declare` value. For this port it is `productCommit,scripts`, because the product and machine scripts differ while Graph stays fixed. The declarable keys are `productCommit`, `graph`, and `scripts`. `scripts` covers `review.sh`, `verify_clone.py`, and `lease_token.py`; `candidate.sh` is recorded separately. Deadline and settings are never declarable. Receipt model, effort, and lifetime must also match the control. If the final build changes Graph, the `productCommit,scripts` admission refuses that undeclared difference. Resolve the difference before dispatch.

While `NEUVE_TREATMENT_ROOT` is set, three guards hold:

- Only a `candidate-<k>` run can be labelled.
- The Mac's labeller is refused.
- The labeller's events, failures, uv environment and merit's anchor errors go to `$T`.

The cloud labeller's uv environment is therefore built under `$T/tmp` on its first call, from `modal/uv.lock`, which needs PyPI. `compare` refuses while any scorable run is unmatched. It also refuses on any file that differs from either manifest.

The [version 3 manifest contract](manifest.ts) retains the full development population in `floorUniverse`, separate from the sample's `cases` and counts. It pins each floor case's present and absent receipts, labels, matching passes, build, and case record, including cases that cannot yet form a floor pair. `verify` and `compare` reject changed membership, changed files, and previously absent inputs that appear later. The floor uses that pinned population.

Version 3 also revalidates recorded candidate capture facts through the public reader. After file and floor checks pass, `verifyManifest` rereads every nonmissing capture and rejects any change in its parsed facts. `compare` verifies both manifests before scoring. Versions 1 and 2 are refused because they do not pin public capture revalidation. Keep old manifests as historical artifacts and reuse the existing version 3 baseline for this comparison.

## What the owner's full run receives

- **The pinned identities.** `$C`, `$B` and `$O` with their clean status; `$T/$RUN.batches.jsonl` (each batch's build and declared differences); every case's `build.json`, which names its control's build and receipt sha256.
- **The manifests.** `$BASELINE`, `$P/inventory-v3.json`, and `$T/manifests/$RUN.json` with their sha256. `compare.json`'s `manifests` records the baseline and candidate hashes; `$T/final-artifacts.sha256` records the final report hashes.
- **The report.** `$T/reports/compare-$RUN/compare.json` and `compare.md`. They hold the execution and capture counts, the denominator table by source and kind, unavailable labels, the parity method's paired comparison and floor, tokens beside the repeats' spread, and the `unresolved` list.
- **The machine records.** `$T/receipt-faults.jsonl`, and each case's `machine.json` with its attempts (a retried attempt is marked `resumed`), its dump settlement and its peak memory.

Local preparation has verified the pinned baseline and inventory and admitted a prepared build against all 63 controls. Those observations do not establish Linux image execution, runtime capture completeness, cloud readiness, model behavior, scored parity, UI behavior, recovery, or whole-port acceptance. A report is not acceptance. Parity's `verdict` retains the existing method, and the owner's full-run gate decides. The local comparison tests use literal fixtures and a stand-in for the public reader. No scored port comparison has run.

## Commands

| Command                                                                  | Writes                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `manifest baseline --sample <file> --floor <run>:<run>[,…] --out <file>` | The sample and the full development floor population, pinned                |
| `manifest inventory --out <file> [--runs first,cloud,…]`                 | Every case with `run/cloud`, for the corpus's counts                        |
| `manifest candidate --sample <file> --run candidate-<k> --out <file>`    | The treatment's runs, with capture reads (needs `NEUVE_TREATMENT_ROOT`)     |
| `verify <manifest>`                                                      | Nothing; checks files, absences, floor membership, and public capture facts |
| `compare --baseline <manifest> --candidate <manifest> --out <folder>`    | `compare.json` and `compare.md` in a new folder                             |

Each output is written once, refused inside R, and refused if it exists.
