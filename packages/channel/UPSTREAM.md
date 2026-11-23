# Ace channel upstream boundary

Pinned source is [Ace fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee), mapped from `packages/channel/` to `packages/channel/`. Every original tracked file is present. Original package names and source paths remain authoritative.

The prior `apps/neuve-host/src/capabilities.ts` blanket refusal module and `apps/neuve-host/src/browser-client.ts` duplicate path are removed. The original browser module is restored at `gateway-client.ts`; the private transport has its own path.

Neuve runs beside Ace through the seams below. Its review admission, Records validation, provider capture and storage ownership stay in own modules or outer composition. No original capability is replaced by a blanket refusal. Real machine prerequisites and the original standalone entry behavior remain.

Managed hosts use the actual tailnet when available. Explicit loopback or missing actual identity uses a separate `local: true` owner namespace; it never fabricates a team or tailnet. Configured workers and the managed CLI share validated configuration. Private `ace-token.` credentials remain server-side.

Channel document kinds/versions stay compatible. Legacy external reference objects stay readable; only the host interprets precise GitHub/Records meaning. Full native snapshots retain pi documents, tasks, submissions and children; editable seeds intentionally omit those archival details.

The native extension binding installs before harness open/recovery and attaches before resume. Native close joins producer work before capture export while raw storage is readable, then confirms storage close before releasing source/home ownership.

## Original files

| File | Correspondence and reason | Seam ranges against pinned source |
| --- | --- | --- |
| `packages/channel/package.json` | Keep original @ace package identity, native dependencies and exports. Materialize exact root catalog pins, add own adapter exports/dependencies, and pair actual source with generated declaration type exports for strict Neuve callers. | `@@ -4,23 +4,101 @@` |
| `packages/channel/src/agents.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/browser.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/captions.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/changes.ts` | Retain two existing correctness fixes. Parse numstat using only its first two tabs so tab-containing filenames survive; parse name-status records sequentially so status-shaped filenames cannot include unrelated diffs. Actual Git regression evidence is core-lifecycle-tests.log and core-channel-tests.log. | `@@ -60,7 +60,12 @@`<br>`@@ -223,8 +228,14 @@` |
| `packages/channel/src/channel.ts` | Install native pi extensions and wrap every installed tool before Harness.open; observe conversations and attach handlers before resume. Preserve root/fork/relocate/native scheduling. Standalone digest claims bind retry IDs to payload and selection, with per-chat serialization for say and ask. Idempotent close joins captions/admissions/producers before native storage close and cleans partial startup. Optional reasoning, price, caption/recap Models and environment callbacks retain Neuve policy outside native core. Optional resume:false skips only the native harness.resume call for administrative opens; normal workers default to original resume. Actual pending-task proof retains id/checkpoint without model calls and later resumes exactly once. | `@@ -1,3 +1,5 @@`<br>`@@ -29,6 +31,7 @@`<br>`@@ -128,6 +131,8 @@`<br>`@@ -152,6 +157,7 @@`<br>`@@ -178,6 +184,9 @@`<br>`@@ -199,6 +208,10 @@`<br>`@@ -233,19 +246,22 @@`<br>`@@ -271,6 +287,8 @@`<br>`@@ -319,7 +337,11 @@`<br>`@@ -338,13 +360,48 @@`<br>`@@ -377,7 +434,7 @@`<br>`@@ -502,7 +559,7 @@`<br>`@@ -654,16 +711,41 @@`<br>`@@ -701,6 +783,16 @@`<br>`@@ -731,7 +823,23 @@`<br>`@@ -767,6 +875,7 @@`<br>`@@ -789,7 +898,7 @@`<br>`@@ -805,8 +914,14 @@`<br>`@@ -827,7 +942,7 @@`<br>`@@ -930,7 +1045,8 @@`<br>`@@ -939,6 +1055,8 @@`<br>`@@ -965,7 +1083,7 @@`<br>`@@ -987,7 +1105,7 @@`<br>`@@ -1144,7 +1262,7 @@` |
| `packages/channel/src/context.ts` | Read user and repository skill folders, including linked skills. User copies win same-name collisions. List every skill under one header per folder, with repository folders first in fixed order and case-insensitive sorting within each folder. Show paths under the user's home with `~/` and add the front-matter name when it differs from the skill's folder name. Read folded YAML descriptions and cap their length. Keep capped repository descriptions whole when they fit and divide the remaining room evenly among user descriptions. If repository descriptions alone exceed the budget, share the room among them. Shorten with an ellipsis at a nearby word boundary when possible and add a closing notice when any description is shortened or dropped. | `@@ -1,12 +1,19 @@`, `@@ -21,7 +28,7 @@`, `@@ -30,39 +37,134 @@`, `@@ -99,13 +201,7 @@` |
| `packages/channel/src/desktop.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/git.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/handoffs.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/images.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/index.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/lanes.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/log.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/messages.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/metadata.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/models.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/progress.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/protocol.ts` | Unknown pricing omits optional Usage.cost rather than representing an unknown price as zero. All native Request/Event fields and operations remain original, including optional metadata.shared and desktop/watch compatibility. | `@@ -15,7 +15,7 @@` |
| `packages/channel/src/questions.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/queue.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/room.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/seed.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/tabs.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/transfer.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/workspace.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/tsconfig.json` | Path-only reference to the exact pinned Ace compiler base. Host additionally accepts .ts imports from its own Neuve Records adapter; channel retains runtime-neutral types/lib options. No broad strictness weakening or mechanical source churn. | `@@ -1,5 +1,5 @@` |

## Own files

| File | Why it lives beside Ace |
| --- | --- |
| `packages/channel/NOTICE` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/effort.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/extensions.ts` | Runtime-neutral native Extension install/binding, conversation observation, tool wrapping and optional model/pricing callbacks. No Neuve imports or alternate plugin/scheduler system. |
| `packages/channel/src/external-lanes.ts` | Own runtime-neutral native pi lane extension for configured external worktrees. Replaces the same native extension by name through pi Registry.install; native lanes.ts and unconfigured behavior remain original. |
| `packages/channel/src/external-ref.ts` | Channel owns opaque neutral references and legacy JSON receipts. Host alone validates/maps precise GitHub references, with an explicit versioned new encoding; existing durable values are not reinterpreted. |
| `packages/channel/src/frame.ts` | Complete generic native event/frame validation with upstream optional compatibility fields left optional. |
| `packages/channel/src/github.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/operations-protocol.ts` | Single data-only authority for the existing extension request schema/type, importing only zod and neutral external-ref/planning-protocol schemas. Runtime operations reexport the identical object; public DTO declarations do not traverse ChannelExtension, Models or pi-durable. |
| `packages/channel/src/operations.ts` | Reexport the unchanged request schema/type from the data-only operations-protocol leaf. The channelOperations body remains byte-identical. Separate typed extension operations and native pi harness binding. Review/planning docs retain their original kinds/versions. Mutating extension operations obey worker lifecycle gates; host-only association writes never enter from browser clients. |
| `packages/channel/src/parse.ts` | Strict complete native ingress schema and verified-author stamping live beside original protocol declarations; extension schema is separate. |
| `packages/channel/src/planning-protocol.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/planning.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/requests.ts` | Generic durable pi-document digest claims prevent same-ID/different-payload retries without new SQL tables. Existing document kind/version are retained. |
| `packages/channel/src/review-context.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/review-protocol.ts` | Channel stores preparation receipts as neutral JSON and bounded identifiers. Host adapter separately validates precise Records/GitHub preparation and attribution before admission. |
| `packages/channel/src/review.ts` | Own precise Git/Records preparation, immutable range selection, external source validation and admission policy. |
| `packages/channel/tests/changes.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/channel.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/effort.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/helpers.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/operations-protocol.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/paused-administration.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/planning.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/review.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/startup-lifecycle.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/structure.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/transfer.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/tsconfig.json` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |

21 of 27 original tracked files retain exact pinned bytes. The machine manifest records SHA-256 for every original and own file; changed originals also have full unified diffs in the review evidence. No normalization of scopes, whitespace or optional types is applied.

## Verification and limits

Plan mode extends the upstream `packages/channel/src/channel.ts` admission and watch paths. An ask binds the mode to its retry digest, and admission updates a separate mode document. The harness passes the chat ID when it obtains file access. The environment gate uses the same inherited mode check as the tool guard to permit confined access before lane placement. The channel publishes mode changes on the agent event and carries the recorded mode on replies.

| Integration file | Plan mode behavior |
| --- | --- |
| `packages/channel/src/extensions.ts` | The existing tool wrapper checks the chat's effective mode inside execute, including safe replays. |
| `packages/channel/src/frame.ts` | Agent and reply frames retain the mode through relay. |
| `packages/channel/src/parse.ts` | The ask schema accepts the mode at both channel and gateway ingress. |
| `packages/channel/src/plan-mode.ts` | Stores the chat mode, resolves inheritance from the chat's creator, and applies the allowlist to model requests. |
| `packages/channel/tests/plan-mode.test.ts` | Exercises admission, busy chats, inheritance, and interrupted tool replay. |

Actual focused evidence uses native pi 1.0.0, real SQLite/Git, local HTTP/WebSockets and faux provider calls. Full snapshot/seed separation, complete ingress schemas, request retry, startup/close, physical-home/source ownership and native review admission have focused tests. The existing real-Git filename regression tests substantiate the two changes.ts hunks.

The coordinator runs the full composed check and isolated browser/CLI journeys at the frozen product hashes. Team membership, cloud deploy/compute, real keychain/provider authentication and remote transfers are not established by these tests. External independent review remains owner-operated; implementation completion and passing tests do not grant approval.
