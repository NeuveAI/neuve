# Historical EmbeddingGemma R&D source

This source connects the existing offline EmbeddingGemma MAX runtime to a full-census historical TRAIN/DEV reader and differentiable support-set losses. It has no product integration or scientific acceptance.

| Stage | Source connection | Current disposition |
| --- | --- | --- |
| Preparation | Original source bytes, gapless units, complete token segments, frozen BASE query/document vectors | Held |
| DEV observation | Five arms using BASE and zero-adapter document vectors | Held; eligible DEV headroom unestablished |
| Fixed fit | Document-only rank-2 q/v adapter, full TRAIN family macro, A or B, AdamW 60 updates | Held |
| Checkpoint evaluation | Reload equality, BASE/query parity, five-arm composition | Held |
| Native action and acceptance | Separate solver, action and grader obligations | Outside this source allocation |

Applicable committed-source Records verification is unavailable. The worker refuses execution before referenced corpus/query/model reads, including when a caller supplies an acceptance flag or record reference. Source hashes and declared encoder pins do not prove authority, normalization or custody. Connecting that authority remains an implementation obligation. Source review alone cannot admit data or execute these stages.

The existing MAX runtime (kept in the private archive) owns cached local model loading, rank-2 document adapters, complete segmentation, masked-mean representations and checkpoint loading. The worker calls Runtime, prepare, encode and load_adapter. It preserves query/document prefixes, normalization and frozen BASE queries. The existing MAX files remain unchanged; its old candidate/positive reader is not reused.

The three TypeScript modules retain independently reviewed support/noise metrics, all atom-fragment coverage, uniform whole-corpus BM25, normalized segment MAX and RRF60 with canonical unit ties. Permanent relative imports carry ordinary typed local inputs. The runner does not parse provider or Graph receipts. Unknown custody remains UNKNOWN when an input declares identity words.

Objective A compares every required coverage unit in each sufficient semantic alternative with every certified confuser, then selects the minimum-loss alternative. Objective B compares the weakest required unit with the hardest confuser. Stable softplus, frozen query tensors, canonical first-index ties and family macro averaging apply to both. Carrier representations are not independent semantic alternatives. Every scheduled case remains in the census; omitted cases require explicit frozen exclusion reasons. Partial, conflicting and unknown evidence cannot become negatives.

The ordinary local source bundle has schema `embedding-rd-source-bundle-v1`, `learner_root`, `allowlist`, `manifests`, `intents` and `targets_path`. Manifest descriptors supply `path`, `sha256`, `family` and `source_root`; intent descriptors supply `path`, `sha256` and `family`. Original files and gapless segments retain exact bytes, offsets, hashes and UTF-8 text. Independent `embedding-rd-targets-v1` targets contain `tasks`, `cohort` and `exclusions`; qualified tasks declare atoms with all `requiredFragments`, genuine alternatives with `semanticRouteId`/`atomIds`/`requiredUnitIds`, and certified confusers. These remain declarations pending applicable independent data, negative/FN, source, recipe and resource admission. Preparation gates precede fit's semantic/headroom gates.

The worker, runner and Python controls are kept in the private archive because they only serve archived captured inputs and the MAX runtime, which is kept there too. From the root of an archive checkout, offline controls use tiny literal tensors and generated temporary boundary inputs:

```sh
/path/to/cached/python -I -B research/pr-bench/embedding-rd/test_worker.py
```

Future admitted execution uses `run.ts` with prepare, fit or score configurations. Absolute deadline, local-only environment, bounded logs, exclusive attempts and TERM/KILL cleanup follow the existing MAX supervision. No package acquisition or transport framework is introduced. Checkpoint parity and full TRAIN before/after losses are future execution obligations, not results established by offline controls.

Current historical data lacks an accepted complete semantic target/matching/noise contract and eligible DEV headroom. No weights, historical queries, gold or source bodies were consumed for this preparation. A source commit requires independent review of these exact seven files; committed-source review and Records retention remain separate gates.
