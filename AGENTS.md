# Repository guidance

## Working truth

Read these before product or architecture work:

| Source                                     | What it holds                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [Design decisions](process/decisions.md)   | The owner's decisions from 16 October 2026. They override older text                                               |
| [Architecture](architecture/README.md)     | The six layers and the architecture records that follow from the decisions                                         |
| [Product vocabulary](vocabulary.md)        | Shared terms. Use them consistently. Never change it without the owner's explicit approval, and never invent terms |
| [Foundations](foundations/)                | Product meaning that the decisions did not change                                                                  |
| [Repository constitution](CONSTITUTION.md) | Its contextual-linkage rule: every link says what it refers to and why it matters                                  |

The decisions override older text. The architecture records describe how the system is built. The vocabulary and foundations stay authoritative for product meaning. Raise any remaining conflict with the owner; leave genuinely unresolved points marked open and do not invent product meaning. Plans and handovers from before 16 October were removed; the [decisions record's opening](process/decisions.md) names the commit that keeps them.

## Communicating with the owner

Explanations for the owner follow the [show-don't-tell principle](foundations/10-show-dont-tell.md), which sets when to render a visual and keeps agent handovers, briefs and records short and plain (7.5). Use the [Explain from first principles skill](.agents/skills/explain-from-first-principles/SKILL.md) when the owner must judge a finding or a deeper change. Never communicate to a human using ids or list numbers (e.g.: A31 or 5.3). Always bring the conversation to a prodcut or engineering term, and always think and produce work using 'read first' and good design patterns. Building and maintaining code should always be product first at its core and following good first principles.

Any change to the code base should be followed by a consideration of what it replaces or what could be consolidated into, a good change will introduce few lines, a great change will remove more than it introduces.

## How agents build Neuve

These rules come from [Area 7 of the design decisions](process/decisions.md#area-7-how-agents-build-neuve-16-october-2026); the numbers name its rows. They are the maintainers' own process; an outside contributor's agent follows [Contributing](CONTRIBUTING.md), which keeps the same review standard.

- **Lanes** (7.1, amended by [14.9](process/decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)): one implementer and one independent reviewer per lane, as separate sessions with disjoint file ownership. Implementers are Opus sessions; Codex may implement well-specified slices. A separate Claude session with fresh context reviews every change, and Codex never approves. Consult the owner before changing the execution model or platform. The pi transition uses the external worktrees required by 12.4. The coordinator commits.
- **Shared work** (10.94, 12.51): when more than one caller can ask for the same work, [record 0016](architecture/decisions/0016-shared-work.md) is the only design: one run per idempotency key, and every other caller subscribes to its response. Never propose duplicate runs, polling or a new lock, and never put that choice to the owner.
- **Independent review** (7.1): follow the [adversarial review standard](process/adversarial-review-standard.md); only correctness or security defects block.
- **Evidence** (7.2, 11.1): proof converges. Code, tests, telemetry, logs, and Chrome DevTools MCP screenshots and video for browser work, must all point to the same result; one kind alone is not enough. None for documentation. Verify scripts are not evidence. Reviewers load the [reviewer skills](.agents/skills/) (11.7).
- **Tests** (7.3): only when needed, with a stated reason. A test is never approval. Good tests verify the right things at the right boundaries, including error and input handling (11.2).
- **Check.** Run `bun run check` ([what it runs](docs/development.md#commands)) before review; a pass is not approval.
- **Dogfooding** (7.6, [12.54](process/decisions.md#area-12-ace-style-pi-transition-28-october-2026), amended by [14.35](process/decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)): every lane uses Neuve the way the [shipped `neuve` skill](apps/neuve-cli/skills/neuve/SKILL.md) tells its users to, and we gather telemetry and other data on those commands. In the inner loop the implementer opens with Neuve's scope retrieval and the reviewer works with Git and that same scope; no `neuve review` runs there. Once the reviewer approves, it requests one Neuve review of the lane's whole range, and the owner gets the desk link when there are human-required units. The coordinator never starts a review or copies its output. The [lane loop](process/neuve-in-the-loop.md) gives the steps.
- **Scope** (7.12, 7.13, 14.42, 14.43): each workstream's scope lives once, in Linear; its plan lives there too, and no plan is committed to the repository (14.43). Each workstream keeps its own Linear scope current, in a session of its own; there is no central Linear chat (14.42).
- **Approval** comes only from review, never from ticket status, passing checks or transport completion.
- **Damaged Git repositories.** A tight `add`/`commit`/`status` loop with plain Git and no Neuve code damaged scratch repositories on the Mac, with the cause not found. We don't act on it until it reaches real work. If `git fsck` reports missing trees or invalid reflog entries in a real repository, or agents start committing several times a second, keep the damaged copy and tell the owner.
- **Scratchpads** are transient: they belong to a session and are never committed (14.43). Move accepted requirements into the decisions record, an architecture record or the workstream's Linear scope (7.12).

For UI work, use Interface Craft and preserve the existing design. Make focused corrections; no broad redesign is requested.

## Workspace

The root is the Bun workspace and orchestration boundary.

| Path                                                          | Holds                                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/neuve-cli`                                              | The public `neuve` command                                                                                                                                                                                                                |
| `apps/neuve-web`                                              | The web app (batch overview and review desk) and its BFF                                                                                                                                                                                  |
| `packages/records-schema`                                     | The zod schemas for records, projections and submitted source                                                                                                                                                                             |
| `packages/records-core`                                       | The system of records: a library over one SQLite file, with no server (decision 8.3). `neuve records` uses it                                                                                                                             |
| [`packages/review-rules`](packages/review-rules/src/index.ts) | The review rules the harness and the web app are to share: owned ranges, submitted hunks, comment anchors and lineage, the one authority for what a unit owns ([decision 10.21](process/decisions.md#area-10-harness-m3-18-october-2026)) |
| `apps/neuve-graph`                                            | Neuve Graph, a separate Git repository mounted as a submodule                                                                                                                                                                             |
| `packages/graph-client`                                       | The single validated executable boundary to Neuve Graph. Callers consume its normalized observations and never parse graph command receipts or provider JSON themselves                                                                   |
| `packages/evaluation`                                         | Executable cases and evaluators                                                                                                                                                                                                           |
| `validation/`                                                 | Durable fixtures and selected evidence                                                                                                                                                                                                    |

Before working in `apps/neuve-graph`, use it as the working directory and read its `AGENTS.md` and generated `.entire/agent-guide.md`. Its Go and mise configuration is authoritative there. Root TypeScript formatting and typechecking must not traverse the graph submodule.

The [command table in Developing Neuve](docs/development.md#commands) is the one home for what each root command does, including `setup:graph` after a fresh recursive clone and `install:cli`, which installs copies outside the workspace that `bun run test` never touches.

## Commits

Never add `Co-Authored-By:` trailers, or any other agent attribution footer, to commit messages in this repository or the graph submodule. This overrides any tool-default attribution guidance.
