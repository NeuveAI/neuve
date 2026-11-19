# The full test: design proposal

Historical proposal. Its review-stage graph and budgets are superseded by the [fixed-shape pipeline record](../../architecture/decisions/0005-harness-pipeline.md), which describes the NEU-111 trial. The [owner's decisions](../decisions.md) remain authoritative for accepted product meaning and the other topics below.

Status: proposal, drafted 20 October 2026 for the checkpoint the owner set after M4's held-out round, which [decisions 9.61 and 9.63](../decisions.md#area-9-benchmark-m4-17-october-2026) call "the full test": the chosen retrieval runs through the whole M3 harness, each stage is attested, and the result says which hills to climb. Revised the same day after an independent review. Nothing here is built. The [decisions record](../decisions.md) wins wherever this text differs from it. The shape follows the [M3 harness proposal](m3-harness.md): starting facts, conflicts that need a ruling, decision rows (FT1–FT17) with options, a recommendation and its basis, slices, and a decision list. "Estimate" marks a figure derived from the measurements below, not measured; "unverified" marks something not checked.

**What the arms can and cannot differ in.** In the harness today, retrieval reaches an agent only as the leads Investigate starts with: the top 10 per hunk as handles, the top 3 seeded into the ledger (10.43, 10.84). Investigate's own `search` tool is BM25 over the range's chunks, the retriever port admits only BM25, and nothing in the harness calls Graph or an embedding model ([10.25](../decisions.md#area-10-harness-m3-18-october-2026); no Graph structural tool, 10.10). So R(H3-E0) and R(H1-E0) differ only in their starting leads. "The chosen retrieval through the whole harness" holds for the leads and not for agentic search; FT17 gives the owner the option to change that, and C7 records what this means for 9.63.

**What it must answer.** For each harness stage (retrieval, Investigate's ledger and the context margin, lanes, dispositions, digests, proof and the receipts), how far the output is from what it should be, how much of that is run-to-run noise, and how fixable it is. Beside that, 9.63's question, within the limit above: what Graph in the fusion changes in what Investigate gathers. And H9's: how the harness as shipped performs.

**Words.** Product words follow the [vocabulary](../../vocabulary.md). The following are internal process words, not product terms: _arm_ (one retrieval configuration's leads fed to the harness), _phase_ (one arm's runs over every range), _run_ and _generation_ (as in the M3 proposal), _pool_ (M4's frozen ranking for a hunk), _lead_ and _ledger_ (Investigate's preloaded handles and its evidence ledger), _sheet_ (the owner's decide-then-reveal form of [10.71](../decisions.md#area-10-harness-m3-18-october-2026)), _known case_ (a range with a defect known in advance), _noise floor_ (how far two runs of the same arm differ) and _hill_ (the owner's word for a stage-level gap worth climbing). Arms use M4's names: **R(H3-E0)** is Graph, keyword search and untuned EmbeddingGemma 2 fused by RRF, then the reranker (9.61); **R(H1-E0)** is the same without Graph (9.63).

## At a glance

```
M4 (frozen, read only)                     harness, pinned snapshot, Sol on the ChatGPT sign-in (10.85)
  leads files for every harness hunk ─┐
    R(H3-E0), R(H1-E0)                │   22 dev ranges, 431 harness hunks, 64 scored M4 hunks, 15 families
  dev gold (b182a860)                 │
                                      ├─► A    R(H3-E0)       full pipeline       Understand computed once
                                      ├─► C    harness BM25   full pipeline       Understand shared · H9's subject
                                      ├─► A'   R(H3-E0)       full pipeline       Understand shared with A
                                      ├─► U'   Understand only, recomputed         (Understand's own variation)
                                      └─► B    R(H1-E0)       stop after Investigate, unless the pre-registered rule says go on
  known cases: 0c874b72 (in-sample for 10.86) + 3 planted ranges, in A and A'; proof ranges in A

per stage            automatic (code, M4 scorer)                            owner (decide first, then reveal)
  retrieval          served leads at depth, all and cross-family              —
  ledger / margin    ledger and published references against gold             20 margin cards against gold text
  lanes              10.9, 10.55, 10.82, 4.4 checks; agreement and kappa      lane on the sheet (from C)
  dispositions       known cases, Guided-row rules, agreement and kappa       verdict and findings on the sheet
  digests            citations, verdict words, obligation roll-up             short rubric on a sample
  proof, receipts    coverage, timeouts, turns, tokens, vents                 timed-out runs on the sheet
                                                       └──────────► hills report: measurements, then interpretation
```

## Starting facts

| Finding | Evidence |
| --- | --- |
| In the harness, agentic `search` is BM25 over shared chunks; the retriever port's configuration admits only `bm25`; no harness code calls graph-client | [`lookups.ts`](../../packages/harness/src/lookups.ts) `searchTool`; [`retriever.ts`](../../packages/harness/src/retriever.ts), lines 25–30 |
| The 9.57 comparison on Opus found no detectable difference between R(H3-E1) and R(H3-E3), and run-to-run noise was at least as large as the effect: on the 24 hunks with identical leads the mean absolute relevant delta was 0.068, against 0.037 where leads differed | The 9.57 harness comparison report (kept in the private archive), "Treatment contrast and run-to-run noise" |
| That treatment was thin: only M4's hunks got frozen leads. The 12 ranges held 280 harness hunks; the 246 without an M4 hunk got the harness's own BM25 leads in both arms | Same report; [the harness side of the runner](../../packages/evaluation/src/harness-compare/harness-side.ts), `seed` |
| The pre-check for this test, on dev pools: R(H3-E0) and R(H1-E0) have different top-3 sets on 18 of the 64 scored hunks (mean overlap 0.90) and different top-10 sets on 50 of 64 (0.84). On all 71 M4 hunks, 24 and 57 | The reviewer's and the M4 coordinator's counts over `pools/dev` |
| 10.84 on Sol (one run per arm, 34 hunks, 8 families): no detectable effect of seeded leads; the family permutation test cannot fall below p 0.0078 with 8 families. Of 56 dropped seeded leads on scored hunks, 21 touched gold, 10 of them necessary | The 10.84 Sol report (kept in the private archive) |
| Investigate on Sol, stopping after Investigate, used 15.2M (no-seed) and 16.1M (seeded) input tokens on the 12 ranges: about 56k a hunk, 0.08–6.5M a range, median about 1.0M; Understand about 0.51M over the 12. Cache reads were 7% of input. The invocations totalled 31.6M input tokens in one afternoon without reaching the plan's usage limit | Same report, "Spend"; its `spend.json` |
| Understand plus Investigate took about 1.3–5.3 minutes a range on Sol, and 6.8–8.1 minutes on `78c53866` (137 hunks), where all 11 partitions submitted at about 12 of their 35 turns. Investigate planned 227 units for 280 hunks: 0.81 a hunk | Run timestamps in that `spend.json`; the runs' plans |
| The M3 exit range (`0c874b72`, 11 hunks, 10 units) on Sol, full pipeline: 1.46M input tokens recorded (about 1.6M with the cap overshoot), 25k output; Investigate 756k in 236 s for 18 turns (about 13 s a turn); Assemble about 12.5k and Dispose about 52k input tokens a unit, and together about 52 s of stage time a unit, so about 6.5 s a unit when 8 calls are in flight | The M3 exit evidence, `evidence-1086/m3-exit/show.txt` and `follow.txt` (session scratchpad, transient); plan follow-ups for the overshoot |
| Investigate's ledger on Sol covers about 0.36–0.42 of relevant gold (fractional rule) and 0.46–0.53 (any line). For the same arm, ranges and gold, the Opus 9.57 ledger covered 0.32 necessary and 0.12 relevant, against 0.67 and 0.36 on Sol without seeding; the harness snapshot also differs (`06f5cde9` against `d5c15b0e`), so route and harness version are confounded | The two reports above |
| Dev has 23 ranges, 71 M4 hunks and 16 families. With E0 in both arms the tuned-adapter exclusion lifts; the Graph fork's exclusion (9.47) drops 3 hunks in 2 ranges. `neuve:27ffd6bc..8b430f65` (family `neuve/stress`) has 96,031 review lines by M4's count and 168 hunks | The 9.57 selection's frame (kept in the private archive); hunk counts from `git diff` at default context, which matched the harness's count on all 12 measured ranges |
| The other 22 ranges hold 431 harness hunks: 280 in the 12 already used, 151 in the other 10, which add 7 families. Those 10 are small by M4's review-line count (2,967 in all), but `ba99ae43` has 70 hunks and `1cfb2b48` 26. The family `architectural-review` holds 21 of the 64 scored hunks | Same counts |
| On two ranges the harness counts far more review lines than M4 (`32bff21a`: 8,557 against 9; `c6e159cd`: 10,583 against 15), and Investigate spent about 1M tokens on each. The extra lines are Drizzle migration snapshot JSON (`packages/db/migrations/meta/0037_snapshot.json`, 8,541 lines; `0055_snapshot.json`, 10,561), not lockfiles | Run manifests in the 10.84 runs; the review's check of those files |
| Historical dev ranges have no proof records, so on them no validation requirement can be solid: static automation cannot open (10.82) and every approval says proof is not recorded (10.83). The M3 exit range has two proof records | [Area 10](../decisions.md#area-10-harness-m3-18-october-2026); the M3 exit evidence |
| Not yet seen live: 10.86's pure omission path (unchanged lines no reference covers), withheld or flipped approvals, advice-once, Dispose resuming, and a re-request after a timeout end to end | Plan follow-ups, H7, H8 and 10.86 entries |
| The dev gold holds 32 later-commit items graded useful, over 24 distinct commits; 2 sit on Graph-fork-excluded hunks (`6d1144a2`). They are hindsight for grading only (9.12), and some are fixes of the reviewed change | `validation/benchmarks/m4/labelling/dev/hunks/*/*/gold.json` (kept in the private archive), items with `availability: commit-later` |
| The runner already stops a run after Investigate and checks input tokens during a run (it stops the worker); it re-requests a cut-off run only when stopping after Investigate. Each lane has its own clone and store, and only Understand, its merge pass and the scope snapshot are copied between stores | [The runner](../../packages/evaluation/src/harness-compare/runner.ts); `harness-side.ts` `copy` |

## Conflicts with existing rulings

| # | Conflict | Recommendation |
| --- | --- | --- |
| C1 | **Two "full tests".** [1.10](../decisions.md#area-1-product-loop-and-roles-16-october-2026) and the plan's goal define the full test as the owner opening a real batch in the review desk, M5's exit. 9.61 and 9.63 use the same words for this harness-level checkpoint before M5 | The owner confirms that 9.63's full test is a harness run read through the CLI, and that 1.10's full test stays M5's exit. This document says "the full test (9.63)" |
| C2 | **Hill-climbing before the first full round.** 1.10 puts quality hill-climbing after one full round works, and M6 is where "the first numbers, and where to climb" come from | The full test measures pass 1 on M4's dev gold only; M6 keeps its gold set of real ranges, pass 2 and the scorecard. The owner confirms that climbing harness hills may start before M5 |
| C3 | **Range count.** [10.81](../decisions.md#area-10-harness-m3-18-october-2026) narrowed 9.57's harness comparison to 12 of 23 dev ranges for Anthropic spend | FT2 runs 22. The narrowing was for USD on Opus; Sol on the plan has no USD price |
| C4 | **A size exclusion.** With E0 the stress range becomes eligible under 9.47; excluding it by size is a new rule, and 9.24 asks that selection stay scripted | FT2's pre-registered rule, ruled before any run |
| C5 | **The sheet's size and source.** 10.71 starts the sheet at about 20 units over 2–3 ranges | FT13 keeps about 20 units from phase C, drawn from 22 ranges, plus a separate block of up to 6 phase-A units where A and A' disagree, labelled and reported apart. The [M3 proposal](m3-harness.md#11-how-m3s-output-is-judged-before-m6) lets the sheet grow when the counts are larger |
| C6 | **Route and share.** The harness was built and first judged on Opus (2.12), and 9.41 reads the winner at Opus's share. This run is on Sol, whose per-hunk allowances follow its own window (2.11) | Report retrieval at both shares; compare arms only within the route (FT7). 10.85 asks for Sol baselines wherever earlier evidence is on Opus |
| C7 | **9.63's rationale cannot be observed.** 9.63 keeps Graph partly because "Graph's structural lookups in agentic search do not show in retrieval scores". The harness has no Graph in agentic search (10.25), and [10.10](../decisions.md#area-10-harness-m3-18-october-2026) rules out a Graph structural tool in M3, so the full test cannot see that contribution, and neither could FT17's options, which add only Graph's semantic query. The full test measures Graph only through the starting leads, whose top 3 differ on 18 of 64 scored hunks | The hills report states that Graph's structural lookups in agentic search were not measured, and 9.63's comparison is read as a leads comparison. Measuring the structural rationale needs 10.10 revisited, which this proposal does not ask for |
| C8 | **H9 judges M3 as shipped.** [10.72](../decisions.md#area-10-harness-m3-18-october-2026)'s slice order puts H9 after H8 and M4's dev gold, judging M3's output. M3 ships BM25 leads; the frozen R(H3-E0) leads of phase A are not M3's output, and the first draft's shipped arm stopped after Investigate | Options in FT1. Recommended: the shipped harness (phase C) runs the full pipeline and is H9's subject |
| C9 | **Held-out is not independent here.** 9.58 runs held-out once per frozen configuration, and 9.46 keeps any further comparison to what the owner names after dev. R(H3-E0) was partly chosen on held-out (9.61's E0 against E1, 9.62's speed, 9.63's Graph figures), so a harness check on held-out would not be independent of the retrieval choice, and each repeat wears held-out down | FT3 |
| C10 | **Commit-time model work.** [10.75](../decisions.md#area-10-harness-m3-18-october-2026) allows only code work at each commit in M3: hunks, symbols, the search index, leads. Running R(H3-E0) as the harness's live leads needs E0 encoding and a reranker at commit time; whether embedding and reranking inference count as "model work" is unruled, and 9.34's Modal compute is for the benchmark only | Does not block the full test, whose leads are frozen. The owner rules it before R(H3-E0) runs live in the harness |

## FT1. The relationship to H9

[H9](m3-harness.md#12-milestone-slices) is M3's judging slice ([10.72](../decisions.md#area-10-harness-m3-18-october-2026)): Investigate scored on M4's dev cases with M4's scorer, and the decide-then-reveal sheet drawn from telemetry's counts (10.71), with no model judge deciding anything. The full test needs both instruments.

- **A. The full test is H9**, renamed and widened; its exit becomes the hills report.
- **B. The full test carries out H9 and extends it, judging the shipped harness.** H9's instruments run as ruled on phase C, the harness as shipped with its own BM25 leads, through the full pipeline; the sheet is drawn from C's packets. The other phases add the stage comparisons and the hills report. H9 is done when C's scores and the sheet are in.
- **C. As B, but H9 judged on phase A's frozen R(H3-E0) leads**, which emulate what M4's package will ship; C stays Investigate-only. Cheaper by about one Investigate pass, but judges a harness M3 does not ship (C8).
- **D. H9 apart:** a small run of the shipped harness on 2–3 ranges (10.71's starting size, about 5M tokens) with its own sheet; the full test does not carry H9.
- **E. The full test replaces H9.** H9 is dropped from M3.

**Recommendation: B.** It keeps 10.71's ruled method (owner's sheet, M4 scorer, no model judge, evidence from receipts, telemetry and logs) on M3's real output, and avoids a separate set of runs. Its extra cost is largely offset by B (R(H1-E0)) stopping after Investigate (FT4). **The owner rules:** this option, C1's naming and C8.

## FT2. Ranges

- **A. The 12 ranges already used.** Comparable with the 9.57 and 10.84 runs; 8 families; 280 hunks.
- **B. All 23 dev ranges.** 16 families, but the stress range alone adds 168 hunks and cannot finish inside the 10-minute lifetime.
- **C. 22 ranges: every dev range except those over 50,000 review lines by M4's count (the selection frame's `reviewLines`), pre-registered.** The rule excludes only `neuve:27ffd6bc..8b430f65` (`neuve/stress`, 96,031); 431 hunks, 64 scored M4 hunks after 9.47's Graph-fork exclusion, 15 families.
- **D. A new stratified subset.** Little saving: cost sits in the few large ranges (`78c53866` alone is 137 hunks).

**Recommendation: C**, with the stress range run once in phase A as a separate scale probe, bounded by its lifetime and reported apart (an estimate of at most about 10M tokens). **Basis:** the 10 extra ranges add about half again the hunks of the 12 and nearly double the families, which is what the family-weighted tests are short of (the sign-flip test's p floor falls from 0.0078 to about 0.00006). The 12 stay a named subset, so results can be read beside 9.57 and 10.84.

## FT3. Held-out

- **A. Dev only for this round; the confirmation comes from fresh cases**, the next benchmark round's (9.64) or M6's newer work (9.28).
- **B. Dev, plus one R(H3-E0) harness run on held-out now.**
- **C. Dev now; one held-out run after the first climb.**

**Recommendation: A.** Under C9 a held-out run here is not independent of the retrieval choice, before or after a climb, and every use wears it down; fresh cases are. M4's held-out pools will exist either way. If the owner still wants a held-out figure, C is the less harmful timing, reported as not independent.

## FT4. Arms

- **R(H3-E0) and R(H1-E0), both reranked**, as 9.61 and 9.63 rule.
- **Harness BM25 leads (the harness as shipped, 10.25).** H9's subject under FT1, and the baseline for whether M4's leads change anything end to end.
- **No leads at all.** 10.84 already measured seeding against not seeding; adds little.

**Recommendation:** A and A' (R(H3-E0)) and C (shipped) through the full pipeline; **B (R(H1-E0)) stopped after Investigate**, its question being what Graph in the leads changes in what Investigate gathers. No no-lead arm.

**Pre-registered rule for B, since the pre-check is already in** (top 3 differ on 18 of 64 scored hunks, counted on M4's region ids). B's later stages run only if **either** the top 3 the harness actually serves (the handles after mapping M4's regions to the harness's own chunks, as the runner's seed step does) differ on at least half of all 431 harness hunks, **or** B's ledger separates from A's under FT5's rule on **both** necessary and relevant coverage (fractional rule, view all), in the same direction, as 9.54 asks of a winner. Otherwise B stays at Investigate and the report says why. **To go on,** B's job, held before Assemble, is dropped first, then re-requested as a new generation that reuses B's stored Understand and Investigate. That generation has a fresh 10-minute lifetime for Assemble and Dispose alone, so B's later stages are compared with A's and C's final generations only, never with generation 0. **Basis:** with 72% of scored hunks starting from the same top 3, downstream differences between A and B would sit inside the noise floor, as 9.57's did; spending a full arm to show that is waste.

## FT5. Repeats and the noise floor

- **A. One run per arm** (as 10.84). Noise cannot be separated from effect.
- **B. Two runs of every arm.** Doubles cost.
- **C. R(H3-E0) twice with Understand shared (A and A'), every other arm once, and Understand recomputed once on its own (U').** A against A' is the noise floor of everything after Understand, on the same footing as A against B and A against C, which share A's Understand too. U' (Understand only, through `--stub-hold investigate=…`, about 1M tokens, in a store with only the scope snapshot copied) measures Understand's own variation, reported apart. It does not measure how that variation carries into lanes and dispositions, which would need a full run from U''s Understand (about 47M more).

**Recommendation: C.** The first draft had A' recompute Understand, which would have put Understand's variance into the noise floor but not into A against B or C, inflating the floor and hiding real differences; sharing it removes that bias, and U' measures Understand's variation directly. **U''s metric:** the adjusted Rand index between A and U' over each hunk's candidate batch, and over each hunk's Investigate partition (the plan is code over the change map, so it can be computed from U''s); behaviours matched one to one by the hunks they cover (Jaccard of at least 0.5) and obligations by their cited basis and normalised text, each reported as the matched share both ways.

**Pre-registered statistic.** For each measure and each scored hunk (or matched hunk, FT10), take the per-hunk difference δ = A − X, for X in A', B and C. Report the mean δ with B4's paired family bootstrap at 95%, and the mean |δ|, for both the family-weighted and the plain hunk mean (family weighting amplifies a one-hunk family's swing, the 10.84 lesson). **A difference between A and B or C counts as separable from noise only when its 95% interval excludes zero and its mean |δ| exceeds the upper 95% bound of A against A''s mean |δ|.** Every result is recomputed leaving out each family in turn; one that loses separability or changes sign without a family is reported as resting on it (`architectural-review` holds 21 of the 64 scored hunks). 9.63's comparison can only be descriptive: at 64 hunks a one-point retrieval difference is not detectable whatever the repeats.

## FT6. Leads on every hunk

- **A. Frozen leads on M4's hunks only**, as in 9.57: 64 of 431 hunks see the arm; the rest get BM25 in every arm.
- **B. Every harness hunk in the 22 ranges gets each arm's ranking.** Only M4's hunks are scored.

**Recommendation: B.** Under A, 85% of hunks never see the chosen retrieval, and the 9.57 review asked that a future comparison vary leads on more hunks. **The M4 coordinator's estimate:** about 800 extra hunks, 2–4 USD of Modal, 3–5 hours of wall time and half a day of a lane on M4's side, as a separate arms mode that writes a leads file, not pools, so nothing enters the labelled benchmark. It also gives Graph's per-hunk latency on real harness hunks, which matters for commit-time leads (10.75, C10) though not for the run's lifetime.

## FT7. The route and model control

| Route | What it can do for the harness | What it can't |
| --- | --- | --- |
| **Sol on Neuve's ChatGPT sign-in** (`neuve review --route openai`, 10.85) | Runs the whole pipeline in Neuve's own loop; ran the M3 exit range and 10.84's 12 ranges | No USD price, so stops are in tokens; little caching (7% of input read from cache); about 49 output tokens a second and about 13 s an Investigate turn; plan usage limits unknown, met as a typed failure; the provider's rate limit for 8 calls in flight unverified (10.27) |
| **Opus on the Anthropic API key** (2.12) | The route the 9.57 evidence is on | No credit since 20 October |
| **The owner's Claude subscription** (headless Claude Code, 9.55) | Side work in Claude's own app: the sheet's neutral briefings (9.38), the planted cases' authoring session | Cannot run the harness: Anthropic's terms allow plan sign-ins only in Claude's own apps (10.85) |
| **The owner's Codex sign-in, over ACP** (2.12, 9.60) | Labelling and council steps | Runs Codex's agent, not Neuve's loop; the ACP turn calling Neuve's tools has never run live; one Codex session per unit (10.64) makes it a different harness |

**Recommendation:** every harness run on Sol through `--route openai`; arms compared only within the route. **Controlling for the model against the Opus evidence:** (1) rescore the committed Opus 9.57 R(H3-E1) ledgers and the Sol 10.84 no-seed ledgers with one scorer version, which costs no model call and shows the size of the confounded route-and-snapshot gap; (2) report retrieval at Opus's and Sol's shares; (3) when Anthropic credit returns, optionally replay phase A on 6 of the 12 ranges on Opus at the same snapshot (an estimate of about 20 USD from 9.57's per-range spend, scaled for the full pipeline). No conclusion about Opus is drawn from Sol figures.

## FT8. Harness snapshot, settings and the lifetime

Every run uses one pinned snapshot (as the runner already pins), the ruled settings (effort `medium`, 8 calls in flight, 35 turns per Understand and Investigate agent, 40 per Assemble batch, 15 per Dispose unit, the 10-minute lifetime) and 10.84's seeded top 3.

- **A. Pin now.** Measures the harness as it is, with lead drops as a known hill.
- **B. Pin after the lead-drops lane's mitigation is committed and re-measured.**

**Recommendation: B, if the mitigation lands before M4's leads files; otherwise A**, recording which. Nothing lands mid-run.

**Timeouts, from the measured runs.** Investigate is not the exposure: on `78c53866` every partition submitted at about 12 of 35 turns, and Understand plus Investigate took 7–8 minutes. The exposure is Assemble and Dispose at about 6.5 s a unit with 8 calls in flight. Units come from the 10.84 plans where measured (227 for the 12 ranges' 280 hunks, 0.81 a hunk; the large ranges run lower, 104 on `78c53866` and 31 on `efcd52f6`, 0.76 each), else 0.81 a hunk. A range's time is roughly its measured Understand and Investigate time plus 6.5 s a unit, against the 9:45 cut-off (10.42):

| Range | Hunks | Units (estimate) | Understand + Investigate | Assemble + Dispose | Outcome in generation 0 (estimate) |
| --- | --- | --- | --- | --- | --- |
| `78c53866` | 137 | 104, measured | 7–8 min | about 11 min | Times out; about 85 units not yet assessed, so they go to human-suggested with gaps |
| `ba99ae43` | 70 | about 57 | not measured; about 4–5 min | about 6 min | Likely times out |
| `efcd52f6` | 41 | 31, measured | about 3–5 min (one attempt took longer) | about 3.4 min | Borderline |
| Every other range | 2–27 | up to 23 (`268ad695`, measured) | 1.3–5.3 min | up to about 2.5 min | Completes |

So 2–3 of 22 ranges time out in generation 0 in each full phase. Generation 0 is the product's outcome and is reported as such (what published, what was disclosed). The runner then re-requests up to twice; each new generation reuses every stored stage (10.42), so later stages are attested on every range. Lifting the lifetime for the test would need a ruling and would hide a real hill.

## FT9. Measures per stage

| Stage | Measure | How | Owner time |
| --- | --- | --- | --- |
| **Retrieval** | The served leads (the 10 per hunk, and the 3 seeded) at depth, necessary and relevant, fractional and any line, all and cross-family; M4's own figures at the real share for Opus and Sol beside them; the lead-difference counts over all hunks | M4's scorer over the leads files; automatic | None |
| **Investigate's ledger** | Coverage at depth against gold (both overlap rules, all and cross-family), ledger plus top 3, drops touching gold, look-alikes recorded against gold's misleading items (9.9, 10.49); each entry's lineage (lead, BM25 search or procedural lookup, 10.47) and which of them reached gold | As in harness-compare, with M4's scorer; automatic | None |
| **Context margin** | The published context references against gold, at depth; the misleading share by item (9.42's guard, applied to references); anchors on changed lines (3.5); what is lost between ledger and packet | Same scorer over the packet; automatic | About 20 min for 20 cards (FT13) |
| **Lanes** | FT10 | Automatic checks and run agreement | On the sheet |
| **Dispositions** | FT11 | Known cases, rule checks, run agreement | On the sheet |
| **Digests and delivery stops** | FT12 | Automatic checks | About 70 min |
| **Proof** | Coverage levels per requirement, proof disagreements (11.1), stale records (11.10), static automation reached (10.82) | The known cases with proof records, plus 2–3 recent ranges of this repository that `neuve proof list` shows with records, in phase A only (about 3–5M tokens); automatic. Dev ranges have none (starting facts) | None |
| **Receipts and telemetry** | Tokens and time by stage; turns against limits; final generations (10.11); timeouts and what they published; gaps by kind; retries; tool-result cuts; cache-read share; per-turn latency; calls in flight; the day-one counts of 10.73; vents by stage (2.15); which H7 and H8 live conditions occurred | Receipts, `neuve review show` and `neuve review stats` read through Records; automatic | Timed-out runs on the sheet |

Every measure is also reported on the 12 named ranges alone. No run agent sees gold, pool ranks, scores or the sheet (2.16).

## FT10. Lanes

There is no lane gold.

- **Owner's sheet** (10.71): the owner places the unit on both axes and picks the lane first, then sees the agent's assessment.
- **Agreement between runs.** Matching is at hunk level: each harness hunk takes its unit's lane and axis levels, and a hunk counts only when its unit was assessed in both runs (unassessed hunks, for example after a timeout, are counted apart). Raw agreement and **Cohen's kappa** are reported side by side, for the lane (four categories) and each axis (two levels), with family-bootstrap intervals, for A against A' (the noise floor) and A against C. A unit-level view matches units whose owned changed lines overlap by at least half (Jaccard 0.5), as a check on the hunk-level figures. Disagreement is instability, not error, and points the sheet at the units most worth checking.
- **Consistency rules, as checks over the packets:** 10.9 (high complexity and hard to validate on cited evidence stays human-required whatever the gaps); 10.55's case counted; 4.4 (a gap alone never makes a unit human-required); 10.82 (static automation only with every requirement solid, so none on dev); 10.56 (every movement signal cited, with its direction); 4.13 and 4.14 (an agent's verdict never closes human-required work). A violation is a defect against H7 or H8.
- **A model judge.** Excluded by 10.71.

**Recommendation:** the first three. The rules and agreement are automatic; the owner's time goes to the sheet.

## FT11. Dispositions

- **Known cases.**
  - The real one: `0c874b72~1..0c874b72`, 9.59's empty-file defect. It is **in-sample for 10.86**: 10.86 was found on this range and the prompts were changed for it, so it is a regression check, not an independent test.
  - Three planted ranges in a scratch clone at a dev range's base: an omission in unchanged code no reference is likely to cover (10.86's pure path), a test that mocks away the behaviour it claims to verify (10.63), and a plain defect in changed lines. A separate session authors them in its own folder and never shares it with the runs (2.16); they are reported apart and never mix with dev measures.
  - They run in A and A' (about 6M and 5M tokens), so each has a repeat. The measure is whether Dispose requested changes citing the defect's lines, which is automatic.
  - None of these ranges, nor the proof ranges, is in M4's corpus. Their R(H3-E0) leads are built by M4's leads-file mode into the full test's own folder, with any index for their bases built there too, **never written into M4's pools, queries or indexes**, so planted text cannot reach the benchmark. If that is not available, they run on the harness's BM25 leads, disclosed.
- **Later fixes in the gold.** The 30 later-commit items graded useful outside the excluded hunks, over at most 24 commits. The coordinator lists the lines each commit changed that the reviewed hunk had touched; the owner confirms which are fixes of a defect present in the range; code checks whether the review raised a finding on those lines. The confirmations are stored in the full test's results folder, outside the gold.
- **False positives.** Every request for changes on the sheet's units, judged valid, invalid or unsure by the owner after deciding the verdict.
- **Rules over Guided rows:** no approval beside a not-met row (10.86); rows scoped to the unit (10.87); approvals cite proof or say it is not recorded (10.83); requests for changes link their defect comments (10.69). Automatic.
- **Agreement between runs:** as in FT10, for verdicts (approve, request changes, and suggested review on human-required units), on hunks whose unit was disposed in both runs, raw and Cohen's kappa.

**Recommendation:** all five. The planted cases are the only way to exercise the pure omission path on purpose.

## FT12. Digests and delivery stops

- **Automatic:** every citation resolves (10.61); verdict words flagged and lane words in Facts counted; each batch digest's obligation roll-up matches its units' rows (10.87); length.
- **Owner:** a short rubric (accurate, complete, any misleading claim, neutral before the verdict) on about 6 batch digests and 10 unit digests with their Facts, Briefed and Explained stops, beside the unit's diff and the gold's "why it applies" text where it exists (9.8). There is no agent verdict in these stops to anchor on.
- **Model rubric:** not used (10.71; the M3 proposal's option D).

**Recommendation:** automatic checks on every packet; the owner's rubric on the sample, from phase C.

## FT13. The owner's sheet and time

The sheet follows 10.71 and 9.38: neutral context and a neutral briefing from a separate context (headless Claude Code on the subscription) that never proposes an answer; the owner decides first; then the agent's lane, verdict and findings are shown; first and final answers are recorded. It reuses the M4 adjudication queue's decide-then-reveal form.

**Sample, from phase C's packets, bounded as 10.71 rules it:** every uncited request for changes; a sample of 6 approvals without recorded proof (on dev that is nearly every approval); every forged-evidence defect and up to 2 test-bloat warnings; every unit in 10.55's case; and, for each run that timed out, **what it published and what it disclosed**, one item per run, not its units. That is about 12–20 units plus 2–3 timed-out runs, depending on the counts. **Apart from H9's sheet,** a block of up to 6 phase-A units where A and A' disagree on lane or verdict, in the same form, labelled phase A and reported apart, never counted as H9's.

| Owner task | Size | Time (estimate) |
| --- | --- | --- |
| The sheet: lane, verdict, then each finding judged | About 12–20 units from C, plus up to 6 from A, in sessions of 6–8 (9.38's fatigue finding) | About 45–80 min, plus about 20 for A's block |
| Timed-out runs: what they published and disclosed | 2–3 runs | About 15 min |
| Margin cards against gold text | 20 references | About 20 min |
| Digest rubric | 6 batch and 10 unit digests | About 70 min |
| Later fixes: confirm which are fixes | 30 items over at most 24 commits, pre-listed | About 20 min |
| Reading the hills report and choosing | One document | About 30 min |
| **Total** | About 7 short sessions | **About 3.7–4.3 h** |

## FT14. Cost, bounds and stopping

**Per stage, measured on Sol:** Understand about 43k input tokens a range; Investigate about 56k a hunk; Assemble about 12.5k and Dispose about 52k a unit; the 12 measured ranges' plans hold 227 units, and 0.81 a hunk for the other 10 adds about 122, so about 350 units over the 22 ranges. A full run is therefore about 24M (Investigate) plus 22.5M (Assemble and Dispose); the upper bound uses the M3 exit range's 140k a hunk.

| Run | Input tokens (estimate) |
| --- | --- |
| A, R(H3-E0), full, 22 ranges, Understand computed | 47–61M |
| U', Understand recomputed | About 1M |
| A', R(H3-E0) again, Understand shared | 46–60M |
| C, harness BM25, full, Understand shared | 46–60M |
| B, R(H1-E0), stopped after Investigate | About 24M (about 22.5M more if FT4's rule sends it on) |
| Known cases: 4 ranges in A and A' | About 11M |
| Proof ranges, in A | About 3–5M |
| Scale probe, `neuve/stress`, generation 0 only | Up to about 10M |
| Work lost to interrupted calls at timeouts | Plus 3–5% |
| **Total** | **About 195–245M input (about 220–270M if B goes on); about 2.7–3.4M output** |

**Per range and arm, full pipeline (estimate):** its Investigate cost plus about 64.5k a unit.

| Range | Hunks | Investigate, measured | Full (estimate) |
| --- | --- | --- | --- |
| `562ff2c2` | 2 | 0.08–0.09M | about 0.2M |
| `250ab2fd` | 16 | 0.47–0.55M | about 1.3–1.4M |
| `7d689400` | 9 | 1.35–1.98M | about 1.8–2.5M |
| `efcd52f6` | 41 | 1.37–1.80M | about 3.4–3.8M (31 units) |
| `ba99ae43` | 70 | not measured; about 3.9M at 56k a hunk | about 7.5M |
| `78c53866` | 137 | 4.98–6.49M | about 12–13M (104 units), a quarter of an arm |

**Wall time (estimate):** a full phase is about 2.2 hours (Understand and Investigate about 70 minutes over the 22 ranges, Assemble and Dispose about 40, plus each run's start-up), so about 6.5 hours for A, C and A'; B about 1.3 hours; U', the known cases, proof ranges and the probe about 1.5 hours; re-requests about 1–1.5 hours. About 10–11 hours of runs, one at a time, over one or two days of plan windows.

**Stopping rules:**

1. **Pilot:** the first 3 ranges in the selection's hash order, every phase; project the total from their per-hunk and per-unit rates; the owner confirms the budget before the rest (10.81's projection step).
2. **A token stop over every run**, checked before each run against the range's projected cost and during it (the runner already does both, stopping the worker). Recommended: 250M, raised to 270M with the owner's confirmation if FT4's rule sends B on (the upper estimate is then about 267M); the owner sets it.
3. **Phases run in order A, C, A', U', B**, each across all ranges before the next, so any stop leaves whole phases. A and C give every stage and H9's subject; A' adds the noise floor; U' and B are the cheapest and least decisive.
4. **The plan's usage limit** stops the invocation; the next resumes from the next run on the same snapshot.
5. **Timeouts:** generation 0 at the ruled lifetime, then at most two re-requests (FT8). A range still incomplete is reported incomplete.
6. **Systematic failure:** the same failure on 3 runs in a row (no receipt, no model call, a refused publish) stops the invocation; a fix changes the snapshot, so the affected phase is rerun rather than reported over two snapshots.
7. **If the pilot projects over budget:** C stays whole, since it is H9's subject; A' runs only on the 12 named ranges, and every comparison against the noise floor (FT5, FT10, FT11) then uses only the hunks A' covers, with the other ranges' A against B and C differences reported without a floor; the known cases still run in A', since they are cheap and their repeat is their only check; B stays at Investigate whatever its rule says. If that is still over, A' stops after Investigate, which keeps the ledger's noise floor and drops the lanes' and verdicts'.

## FT15. What M4 supplies

| Item | As the M4 coordinator states it |
| --- | --- |
| Pools | R(H3-E0) and R(H1-E0), the reranker over the top 50 of each, on dev and held-out, frozen at a commit (names and commit to be confirmed); `pools/<split>/<arm>.jsonl.gz`, read with `decodePool`; entries in `arms.<split>.json`; deep rankings through `deepSpec` for the real-share figures |
| Gold | Dev gold as committed in `b182a860`, unchanged by 9.59 |
| Scorer | `loadScoringInputs(split = SPLITS.dev)`; `splitCases(cases, SPLITS.dev)` from `retrieval-bench/split.ts` in place of the removed `devCases`; the cross-family rule as `keepCrossFamily` in `score/gold.ts`. Harness-compare imports it and deletes its own copy (`crossFamily` in [its scorer](../../packages/evaluation/src/harness-compare/score.ts)), under 7.11. No other scorer hooks are needed |
| **Leads for every harness hunk (FT6)** | A separate arms mode that writes a leads file, not pools: both arms for every harness hunk of the 22 ranges, unlabelled, with per-hunk timings; about 800 extra hunks, 2–4 USD of Modal, 3–5 hours, half a day of a lane (the M4 coordinator's estimate). The same mode writes the known cases' and proof ranges' leads into the full test's folder, never into M4's pools, queries or indexes (FT11). Without it the full test falls back to FT6 option A |
| **The lead-difference counts over all hunks** | Per hunk, whether the two arms' top 3 and top 10 differ, from the leads files; it feeds FT4's rule |

**On the full test's side (T1), new work:** re-requests of a full-pipeline run after a timeout (the runner re-requests only when stopping after Investigate); a store for each of A', C and B per range, with Understand, its merge pass and the scope snapshot copied from A's, and for U' a store with only the scope snapshot copied, so its Understand is recomputed; stop-after-Understand detection for U' (the runner detects only Investigate's end); copying the proof records (`proof.recorded` events and their stored artefacts) for `0c874b72` and the proof ranges from the store that holds them into each run's clone before the request, since a clone starts with an empty store; each range's clones kept across its phases and the phases of a range finished within 10.79's 7-day window for the cycle's scope copy; `--stub-hold investigate=…` for U'; the retriever seam the 9.57 review asked for (`{ id: "frozen", candidate }`), owned by whichever lane holds `packages/harness`, or the existing workaround kept and disclosed.

## FT16. The hills report

One report in `validation/benchmarks/m4/results/full-test/` (kept in the private archive), in the shape of the harness-compare reports:

- **Measurements.** Per stage, each FT9 measure per arm, A against A' (the noise floor), A against B and A against C under FT5's statistic, over all 64 hunks and the 12 named ranges, with the leave-one-family-out results, U''s Understand stability, the counts behind every figure, and generation-0 outcomes apart from completed packets. Rendered from the data, as the existing reports are.
- **Gaps.** Each gap as stage, measure, size in its own unit, share of hunks or units affected, and whether it exceeds the noise floor. A gap inside the noise floor is listed as not separable.
- **Fixability**, one of three: a known lever in reach (a prompt, a setting, a known defect such as lead drops, or migration snapshot JSON counted as review lines, which the repository could declare as generated, 10.23); a known lever that costs a round (a new source, another model, agentic Graph or E0 search under FT17, an M4 round such as 9.64's weighted fusion); cause unknown.
- **Ranking:** within each fixability class, by size over the noise floor.
- **Interpretation**, kept apart under its own heading and labelled as the agent's reading, never mixed into the measurements. The report states that Graph's structural lookups in agentic search were not measured (C7) and, unless FT17's C ran, neither was Graph's semantic query as a search tool.

The owner chooses the hills; the report proposes none as decided.

## FT17. Graph and E0 in agentic search

- **A. Leads only, as the harness is.** The full test measures how much gold Investigate reaches through its own BM25 search beyond the leads and procedural lookups. That says whether agentic semantic search is a hill. A ledger entry's recorded lineage (10.47) alone would undercount search: in 10.84's seeded Sol runs, 387 of 673 entries came from `read`, 144 from preloaded leads and 23 from `search`, and only 103 record `followedFrom`, because agents search and then read by path. So an entry counts as found through search when a search result shown earlier to the same agent covered its lines (any line), or its `followedFrom` chain reaches a search; both attributions are reported. When an entry was covered by both a preloaded lead and an earlier search result, the lead gets the credit, since the agent held it before searching; such entries are also counted apart. **Pre-registered trigger for C:** in A and A' alike, at least 15% of the ledger entries that touch a gold necessary or useful target are credited to search alone (under either attribution), on at least half of the 15 families.
- **B. Before the full test: add Graph's semantic query (not a structural tool, which 10.10 rules out) and E0 as Investigate search tools** behind the retriever port. Rough cost (estimate): one harness slice, about 1–2 days of an implementer and a reviewer: the port admitting more than BM25, graph-client in the harness, a long-lived local E0 encoder and chunk embeddings at each range's base (Modal is for the benchmark only, C10). Each Graph query takes about 6–14 s warm (9.62's medians) against about 13 s a Sol turn, so a few searches per agent add a minute or more, against the lifetime. It delays the test by the slice and changes the harness the hills are found on.
- **C. As a later phase of the full test**, once B's slice exists, on the same ranges and snapshot plus that slice.

**Recommendation: A**, with C if A's lineage shows search is where Investigate finds gold beyond its leads. **Basis:** the checkpoint's aim is to find hills; A finds out whether this one is worth its slice before paying for it, and it keeps the full test's start independent of new harness work.

## Slices

| # | Slice | Built | The owner opens and judges | Depends on |
| --- | --- | --- | --- | --- |
| T1 | **Runner and measures** | Harness-compare generalised: arms from configuration (two leads files, harness BM25), leads on every hunk, the full pipeline with re-requests, phases, stores and copies per FT15, the token and usage-limit stops; ledger and packet scoring through M4's scorer and `keepCrossFamily`; FT5's statistic with leave-one-family-out; hunk-level agreement and kappa; U''s adjusted Rand index and set matching; search attribution for FT17; the lane, disposition, Guided-row and digest checks; the sheet's queue with neutral briefings; the planted cases from a separate session | A dry run listing every run, its leads and the lead-difference counts; the pilot's receipts, spend and projection | M4's leads files; FT8's snapshot |
| T2 | **Runs** | Phases A, C, A', U' and B, the known cases, proof ranges and the probe, on the pinned snapshot | `spend.json`, receipts, `neuve review show` and `neuve review stats` per run | T1, the budget |
| T3 | **Hills report and sheet** | FT16's report; the owner's sheet, cards, rubric and later-fix confirmations | The report and the sheet with first and final answers | T2 |

Each slice has one implementer and one independent reviewer (7.1). Evidence is receipts, telemetry and Records state through Neuve's commands; a passing check is not approval (7.2, 7.3).

## Decision list for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| C1–C10 | The conflicts above | As tabled |
| FT1 | Relation to H9 | The full test carries out H9 on the shipped harness (phase C, full pipeline) and extends it; H9 is done with it |
| FT2 | Ranges | 22 dev ranges, excluding ranges over 50,000 review lines by M4's count (only `neuve:27ffd6bc..8b430f65`), pre-registered; that range as one scale probe; the 12 reported alone too |
| FT3 | Held-out | None this round; confirmation on fresh cases (9.64's next round or M6) |
| FT4 | Arms | A, A' and C (shipped) through the full pipeline; B (R(H1-E0)) stopped after Investigate, going on only if the served top 3 differ on half the hunks or its ledger separates on both necessary and relevant coverage; then final generations compared only |
| FT5 | Repeats | A and A' sharing Understand; U' for Understand's own variation (adjusted Rand index and set matching); the pre-registered separability statistic with leave-one-family-out |
| FT6 | Leads on every hunk | Every harness hunk gets each arm's ranking, from M4's leads-file mode |
| FT7 | Route | Sol on `--route openai` for every run; within-route comparison; rescore the Opus and Sol ledgers with one scorer; optional Opus replay of 6 ranges when credit returns |
| FT8 | Snapshot and lifetime | Pin after the lead-drops mitigation if it lands before the leads files; ruled settings; the 10-minute lifetime kept, 2–3 ranges expected to time out, up to two re-requests |
| FT9 | Stage measures | As tabled; all automatic except the margin cards, the digest rubric and the timed-out runs |
| FT10 | Lanes | Sheet, hunk-level agreement with Cohen's kappa, rule checks; no model judge |
| FT11 | Dispositions | Known cases in A and A' (one real and in-sample, three planted), later fixes confirmed outside gold, the sheet's findings, Guided-row rules, agreement |
| FT12 | Digests | Automatic checks; the owner's short rubric on a sample from C |
| FT13 | Owner's time | About 12–20 sheet units from C plus 2–3 timed-out runs, a labelled block of up to 6 phase-A units, and the samples: about 3.7–4.3 hours in short sessions |
| FT14 | Budget and stops | About 195–245M input tokens (up to about 267M if B goes on); pilot projection, a 250M stop raised to 270M if B goes on, phases in order A, C, A', U', B |
| FT15 | M4's supply | As stated by the M4 coordinator, plus the leads-file mode for every hunk and the known cases, and the lead-difference counts |
| FT16 | Output | The hills report: measurements, gaps against the noise floor, fixability, ranking, interpretation apart |
| FT17 | Agentic search | Leads only for now; measure what Investigate's own search adds, attributed through the results each agent saw; a later phase with Graph's semantic query and E0 as search tools if that shows a hill |

## Sources and limits

**Relied on most.** The [decisions record](../decisions.md), Areas 1, 9, 10 and 11; the [M3 proposal's judging section and slices](m3-harness.md#11-how-m3s-output-is-judged-before-m6); the living plan's lanes and follow-ups; the 9.57 harness comparison (kept in the private archive) and its `spend.json` and `selection.json`; the 10.84 Sol measurement (kept in the private archive), its `spend.json` and run manifests; [the harness-compare runner](../../packages/evaluation/src/harness-compare/runner.ts) and [its 10.84 mode](../../packages/evaluation/src/harness-compare/sticky.ts); the M3 exit evidence in the session scratchpad (`m3-h8/evidence-live/`, `evidence-1086/`), which is transient; the independent review's recomputations and pre-check (session scratchpad, `full-test-review/notes.md`).

**Limits.** The Assemble and Dispose rates (tokens and 6.5 s a unit) rest on one range's run of 10 units, where 8 calls were not saturated. `ba99ae43`'s Understand and Investigate time is not measured. The cause of the twofold Opus–Sol ledger gap is unknown. The plan's usage limits are unknown. M4's file names, commit, scorer signatures and its all-hunks estimate are as the M4 coordinator relayed them, partly from uncommitted work.
