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
| `packages/channel/package.json` | Keep original @ace package identity, native dependencies and exports. Materialize exact root catalog pins, add own adapter exports/dependencies, and pair actual source with generated declaration type exports for strict Neuve callers. The runtime dependency supplies the Zod-only approval contract. The host imports the argument helpers through `./tool-arguments`. | `@@ -4,23 +4,101 @@` |
| `packages/channel/src/agents.ts` | Validates chat tool arguments before pi so agents see accepted fields and values. Explains how to find a destination channel and reports a child chat's failure with its model. | Changed |
| `packages/channel/src/browser.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/captions.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/changes.ts` | Retain two existing correctness fixes. Parse numstat using only its first two tabs so tab-containing filenames survive; parse name-status records sequentially so status-shaped filenames cannot include unrelated diffs. Actual Git regression evidence is core-lifecycle-tests.log and core-channel-tests.log. | `@@ -60,7 +60,12 @@`<br>`@@ -223,8 +228,14 @@` |
| `packages/channel/src/channel.ts` | Install native pi extensions and wrap every installed tool before Harness.open; observe conversations and attach handlers before resume. Preserve root/fork/relocate/native scheduling. Before a writable chat input is submitted, the configured host places checkout-bound chats on `chat-<id>` lanes and atomically records cwd and lane ownership. Plan chats and valid external cwd values remain unchanged. Pending writable tasks receive the same placement before resume; failures never resume them on the checkout. Standalone digest claims bind retry IDs to payload and selection, with per-chat serialization for say and ask. Idempotent close joins captions/admissions/producers before native storage close and cleans partial startup. Optional reasoning, price, caption/recap Models and environment callbacks retain Neuve policy outside native core. Optional resume:false skips only the native harness.resume call for administrative opens; normal workers default to original resume. Actual pending-task proof retains id/checkpoint without model calls and later resumes exactly once. Installs the plan writer and comment answer tool before recovery. Keeps scope reads out of the default extensions and clears inherited scope-read access before a new chat is configured. Serializes plan reads, approval, and comment requests with writes in the same chat. Publishes plans and comments to opt-in watches. Cancels reply admission if Stop withdraws its queued comment. | `@@ -1,3 +1,5 @@`<br>`@@ -29,6 +31,7 @@`<br>`@@ -128,6 +131,8 @@`<br>`@@ -152,6 +157,7 @@`<br>`@@ -178,6 +184,9 @@`<br>`@@ -199,6 +208,10 @@`<br>`@@ -233,19 +246,22 @@`<br>`@@ -271,6 +287,8 @@`<br>`@@ -319,7 +337,11 @@`<br>`@@ -338,13 +360,48 @@`<br>`@@ -377,7 +434,7 @@`<br>`@@ -502,7 +559,7 @@`<br>`@@ -654,16 +711,41 @@`<br>`@@ -701,6 +783,16 @@`<br>`@@ -731,7 +823,23 @@`<br>`@@ -767,6 +875,7 @@`<br>`@@ -789,7 +898,7 @@`<br>`@@ -805,8 +914,14 @@`<br>`@@ -827,7 +942,7 @@`<br>`@@ -930,7 +1045,8 @@`<br>`@@ -939,6 +1055,8 @@`<br>`@@ -965,7 +1083,7 @@`<br>`@@ -987,7 +1105,7 @@`<br>`@@ -1144,7 +1262,7 @@` |
| `packages/channel/src/context.ts` | Show pi chats the shared skill finder's names, descriptions and absolute file paths. Codex and Claude Code load skills through their own runtimes. | Changed |
| `packages/channel/src/desktop.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/git.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/handoffs.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/images.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/index.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/lanes.ts` | Defines the shared work lane arguments and refusals. Shares Git base selection and the busy chat check with the external worktree tool. Lane entries optionally mark host-created chat placement, so a caller-supplied name does not imply restoration or disposal authority. | Changed |
| `packages/channel/src/log.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/messages.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/metadata.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/models.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/progress.ts` | Pinned upstream bytes retained. | Byte-identical |
| `packages/channel/src/protocol.ts` | Unknown pricing omits optional Usage.cost rather than representing an unknown price as zero. All native Request/Event fields and operations remain original, including optional metadata.shared and desktop/watch compatibility. | `@@ -15,7 +15,7 @@` |
| `packages/channel/src/questions.ts` | Shares message dismissal and the waiting mark with runtime approvals. | Changed |
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
| `packages/channel/src/build.ts` | Selects the scope-read extension for chats started by an approved plan and pins the query inputs to the chat and its approved plan. |
| `packages/channel/src/effort.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/extensions.ts` | Runtime-neutral native Extension install/binding, conversation observation, tool wrapping and optional model/pricing callbacks. No Neuve imports or alternate plugin/scheduler system. |
| `packages/channel/src/external-lanes.ts` | Installs the work lane tool for worktrees outside the checkout. Uses the native tool's argument schema, refusals, base selection, and ownership check. |
| `packages/channel/src/external-ref.ts` | Channel owns opaque neutral references and legacy JSON receipts. Host alone validates/maps precise GitHub references, with an explicit versioned new encoding; existing durable values are not reinterpreted. |
| `packages/channel/src/frame.ts` | Complete generic native event/frame validation with upstream optional compatibility fields left optional. |
| `packages/channel/src/github.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/operations-protocol.ts` | Single data-only authority for the existing extension request schema/type, importing only zod and neutral external-ref/planning-protocol schemas. Runtime operations reexport the identical object; public DTO declarations do not traverse ChannelExtension, Models or pi-durable. |
| `packages/channel/src/operations.ts` | Reexport the unchanged request schema/type from the data-only operations-protocol leaf. The channelOperations body remains byte-identical. Separate typed extension operations and native pi harness binding. Review/planning docs retain their original kinds/versions. Mutating extension operations obey worker lifecycle gates; host-only association writes never enter from browser clients. |
| `packages/channel/src/parse.ts` | Strict complete native ingress schema and verified-author stamping live beside original protocol declarations; extension schema is separate. |
| `packages/channel/src/planning-protocol.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/plan.ts` | Stores Markdown, the plan lifecycle, and comments in session state. A rewrite retains the previous Markdown by hash while a comment anchors to it. Reads check each version against its committed hash. |
| `packages/channel/src/plan-comments.ts` | Keeps and edits threads in the plans document. Each chat shares verified comparisons and placements by anchor and current hashes across watches and sends. The shared file-lines rule owns placement decisions. Builds the quoted batch and registers the Plan-mode answer tool. Sending a comment includes its kept replies in order and names each reply's author. A later reply can queue behind its comment. |
| `packages/channel/src/planning.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/requests.ts` | Generic durable pi-document digest claims prevent same-ID/different-payload retries without new SQL tables. Existing document kind/version are retained. |
| `packages/channel/src/review-context.ts` | Own integration module retained beside pinned Ace source; channel files stay runtime-neutral and import no Neuve package. |
| `packages/channel/src/review-protocol.ts` | Channel stores preparation receipts as neutral JSON and bounded identifiers. Host adapter separately validates precise Records/GitHub preparation and attribution before admission. |
| `packages/channel/src/review.ts` | Owns Git and Records preparation, immutable range selection, external source validation, and admission policy. Derives the review tools' parameters and argument refusals from their input schemas. |
| `packages/channel/src/tool-arguments.ts` | Derives pi parameters and repair advice from Zod, with the received call included in each refusal. |
| `packages/channel/tests/changes.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/channel.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/effort.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/helpers.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/operations-protocol.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/paused-administration.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/plan.test.ts` | Holds a draft rewrite in flight and verifies that approval waits in that chat while another chat can read its plan. |
| `packages/channel/tests/plan-comments.test.ts` | Exercises comment admission, durable anchor versions, placement, thread answers, and send preparation with the native channel and a faux model, including mixed sends, reply attribution, edits before delivery, and Stop followed by resend. |
| `packages/channel/tests/planning.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/review.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/startup-lifecycle.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/structure.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/transfer.test.ts` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |
| `packages/channel/tests/tsconfig.json` | Owned behavioral fixture or regression test. Exercise actual native pi/Git/SQLite/HTTP boundaries; host fixtures force loopback, replace only OS secrets with memory, and refuse external fetches. They do not claim real keychain/team/cloud/provider success. |

20 of 27 original tracked files retain exact pinned bytes. The machine manifest records SHA-256 for every original and own file; changed originals also have full unified diffs in the review evidence. No normalization of scopes, whitespace or optional types is applied.

## Verification and limits

Plan mode extends the upstream `packages/channel/src/channel.ts` admission and watch paths. An ask binds the mode to its retry digest, and admission updates a separate mode document. The harness passes the chat ID when it obtains file access. The environment gate uses the same inherited mode check as the tool guard to permit confined access before lane placement. The channel publishes mode changes on the agent event and carries the recorded mode on replies.

The channel dispatches comment requests through the same chat admission queue as plan writes. It registers the answer tool before recovery and shares the plans document watch for opt-in comment events. Comment sends stage their batch with the request claim and use native ask admission. Pi's submission commits drive the comment document updates and identify transcript entries whose `Said` omits mentions. The session retains the first receipt for retries and reconciles unfinished sends before scheduling resumes.

| Integration file | Plan mode behavior |
| --- | --- |
| `packages/channel/src/extensions.ts` | The existing tool wrapper checks the chat's effective mode inside execute, including safe replays. |
| `packages/channel/src/frame.ts` | Agent and reply frames retain the mode through relay. |
| `packages/channel/src/parse.ts` | The ask schema accepts the mode at both channel and gateway ingress. |
| `packages/channel/src/plan-mode.ts` | Stores and inherits the chat mode, limits tools in Plan mode, offers the comment answer tool only in Plan mode, and tells planning agents how to deliver a plan or revision. |
| `packages/channel/tests/plan-mode.test.ts` | Exercises admission, busy chats, inheritance, interrupted tool replay, and the instruction delivered to planning agents. |

| Integration file | Approval request contract |
| --- | --- |
| `packages/channel/src/protocol.ts` | Defines the approval request record, its per-chat document, the answer operation, and the watch event. Adds the attended flag to ask and describes when a run waits on a person. |
| `packages/channel/src/parse.ts` | Parses the attended and watch flags. Requires an author and a runtime request ID for an approval answer. |
| `packages/channel/src/frame.ts` | Validates each approval request state and preserves the complete list in watch frames. |
| `packages/channel/tests/approvals-protocol.test.ts` | Checks that malformed answers are refused, the verified author replaces the claimed one, and every request state survives the event boundary. |
| `packages/channel/src/protocol.ts` | Requires a typed description of what Allow grants beside the runtime input used for details. Derives the description and work kind types from the [runtime approval schema](../runtime/src/approval.ts). |
| `packages/channel/src/frame.ts` | Validates the shared approval descriptions and refuses a record with no description. Uses the runtime schemas for the descriptions and work kinds and re-exports the description schema as `ApprovalAskedSchema`. |
| `packages/channel/tests/approvals-protocol.test.ts` | Exercises each description through a watch frame and checks that a missing description or an empty patch is refused. |
| `packages/channel/src/approvals.ts` | Stores attendance, publishes approval snapshots, and commits answers and message dismissal. |
| `packages/channel/src/channel.ts` | Admits attendance with a message, checks approval answer authors, and lets the host runtime close approvals before Stop aborts the conversation. |
| `packages/channel/src/plan-mode.ts` | Keeps the attendance section available to the runtime bridge without adding it to the model prompt. |
| `packages/channel/tests/helpers.ts` | Attaches an injected runtime fixture beside the usual channel operations. |
| `packages/channel/tests/approvals.test.ts` | Exercises approval authorization, document races, Stop, message delivery, attendance and opted-in watches across the channel boundary. |
| `packages/channel/src/questions.ts` | Questions accept any queued invocation. Approvals accept a person's queued invocation. Plain messages dismiss neither. |
| `packages/channel/src/approvals.ts` | Refusals describe the recorded decision or closure without repeating the person's sign-in ID. |
| `packages/channel/src/channel.ts` | Gives the runtime an answer callback and orders approval answers with messages in the same chat. |
| `packages/channel/src/approvals.ts` | Records an answer after the runtime reports delivery. A refused reply returns the request's closure reason. |
| `packages/channel/tests/approvals.test.ts` | Registers a runtime answer callback for the channel's approval admission tests. |
| `packages/channel/src/protocol.ts` | Uses the frame validator's JSON type and keeps the shared document definition independent of storage declarations. |
| `packages/channel/src/approvals.ts` | Checks the shared document definition where the channel opens the store. |

| Integration file | Approval and build behavior |
| --- | --- |
| `packages/channel/src/build.ts` | Stores agent starts, revision deliveries, and work log messages. Approval and `agent_start` share the same start steps. Keeps a stop pending until Pi has stopped all the build’s chats. Pauses active builds in the sharing commit. Records thread mentions and steers each named agent after the message posts. |
| `packages/channel/src/channel.ts` | Registers build tools before wrapping them. Marks briefs, keeps build messages out of teammate notifications, and updates the work log from chat events. Keeps build chats read-only on write routes and reuses the chat stop path for stop-all. Publishes mentions on posted thread messages and returns the agents’ final replies to those threads. |
| `packages/channel/src/extensions.ts` | The tool wrapper refuses new tool calls while the agent’s build is paused. |
| `packages/channel/src/external-lanes.ts` | Shares Git worktree creation between the lane tool and the host. A reviewer’s branch starts at the implementer’s head and keeps its base. Recorded chat lanes can restore a missing folder from the existing branch without resetting commits or the diff base; unrecorded branch collisions are refused. Existing matching Git worktrees recover creation interrupted before pi persistence. |
| `packages/channel/src/handoffs.ts` | Leaves the recipient’s shell running when another agent of the build sends a message. |
| `packages/channel/src/plan.ts` | Runs the build decision inside the first approval’s transaction. |
| `packages/channel/src/room.ts` | Leaves the rolling summary out of a reviewer’s prompt. Skips the instruction to create a lane for build agents. |
| `packages/channel/tests/build.test.ts` | Exercises approval, recovery, fresh reviewer context, delivery, stop-all, read-only routes, and pause with real Git and SQLite and a faux model. Ordinary write-capable chats receive their own placement without becoming build agents. |
| `packages/channel/tests/chat-lanes.test.ts` | Exercises first-writable-turn placement, Plan-mode deferral, legacy migration, explicit cwd preservation, Git/persistence interruption recovery, branch collisions, retained-branch restoration, and pre-resume failure with real Git and SQLite. |
| `packages/channel/tests/helpers.ts` | Keeps the fixture’s model registry mutable so the work log test can install a faux caption provider. |

Actual focused evidence uses native pi 1.0.0, real SQLite/Git, local HTTP/WebSockets and faux provider calls. Full snapshot/seed separation, complete ingress schemas, request retry, startup/close, physical-home/source ownership and native review admission have focused tests. The existing real-Git filename regression tests substantiate the two changes.ts hunks.

The coordinator runs the full composed check and isolated browser/CLI journeys at the frozen product hashes. Team membership, cloud deploy/compute, real keychain/provider authentication and remote transfers are not established by these tests. External independent review remains owner-operated; implementation completion and passing tests do not grant approval.
