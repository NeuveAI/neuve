# 0016: Shared work: one run per request, and every caller subscribes

Status: accepted, 7 November 2026. The shared helper is built in `packages/records-core/src/shared-work.ts` and the modules beside it; not every caller named below has moved onto it (checked by search on 19 November 2026). Source: decisions [10.94 and 12.51](../../process/decisions.md), the shared-work section (section 5) of the [machine budget proposal](../../process/proposals/machine-budget.md), and the local claim of [0002](0002-event-driven-processes.md). This is the only design for work that more than one caller can ask for. **Don't put this choice to the owner again:** they settled it on 21 October and again on 7 November.

## Context

The owner set this rule on 21 October (10.94), and the design was accepted with it. Only the cross-process part was left unbuilt, so each new feature that met the problem solved it again by hand:

- **Five hand-made in-process copies:** `shared` in `packages/harness/src/shared-build.ts` (since removed), `sharedTreeIndex` in `packages/harness/src/lookups.ts`, the keys in flight in `packages/records-core/src/computations.ts`, the queue entries in `packages/harness/src/graph-search.ts`, and the `webs` map in `apps/neuve-cli/src/workspace-cli.ts`.
- **A new cross-process claim for the review desk:** the desk build got its own claim in `apps/neuve-cli/src/workspace-review-build.ts`, made of a symlink, a socket, a SQLite file used as a lock and process-ID checks. It ran through three reviews, and a reviewer then suggested allowing duplicate builds to simplify it. The coordinator put that to the owner as a choice instead of reading 10.94.

Code that doesn't exist can't be reused, and a rule that only lives in one decision row and a proposal isn't found. This record is the one place the rule is written down, and the code it names is the one place it's built.

## Decision

A request is identified by its idempotency key: the operation, its version and its inputs. The same key is the same request, and a different key is a different request.

|                                      | What happens                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **First caller**                     | Claims the key and runs the work                                                                                                  |
| **Every other caller with that key** | Subscribes to the one run and is pushed the response when it's ready. It is never polled for and never run twice                  |
| **Where the result lives**           | The result is stored, or published atomically, before the claim ends. The push only wakes subscribers, who then read it           |
| **Failure**                          | Each subscriber gets the run's recorded failure, and its own retry policy decides what happens next. A retry claims the key again |
| **The claimant dies**                | Its claim is a connection, so it ends with the process. A waiting subscriber takes over the claim                                 |
| **Cancellation**                     | A run is cancelled only when no subscriber still wants it ([0013](0013-graph-search-service.md))                                  |

**Where the claim is held:**

| Scope                           | Claim                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inside one process              | A map of keys in flight, with each subscriber awaiting the run                                                                                                                                                                                   |
| Across processes on one machine | The budget host, one claim per store and key, held over its socket like a grant (10.94). Until that's built, a process-wide claim is an OS socket claimed under SQLite's write lock, as the worker's is ([0002](0002-event-driven-processes.md)) |
| Hosted                          | The repository's Durable Object holds the keys in flight, and waiters are woken by an event                                                                                                                                                      |

**Never do these, and never offer them as a simplification:** run a duplicate and discard it, poll for readiness, use a timed lock or lease (8.2), decide liveness by process ID, or write a new claim or keys-in-flight map where the shared one applies.

**The only exceptions are the two that 10.94 discloses:** a process that can't reach the budget host computes on its own and says so, and after the host changes, a holder that wasn't re-declared may be computed beside.

## Consequences

- **Built:** one helper for callers, in `packages/records-core/src/shared-work.ts`, with its Effect wrapper, host, protocol and socket in the `shared-work-*.ts` modules beside it. New work that more than one caller can ask for uses it, and nothing else may claim keys.
- **Moved onto it** (a search on 19 November 2026 finds the helper named in each): the keys in flight in `packages/records-core/src/computations.ts`, the queue entries in `packages/harness/src/graph-search.ts`, and the desk build in `apps/neuve-cli/src/workspace-review-build.ts`.
- **Not found on it by that search:** `sharedTreeIndex` in `packages/harness/src/lookups.ts` and the `webs` map in `apps/neuve-cli/src/workspace-cli.ts`. Whether they still need to move has not been read through.
- **The review desk:** its build names the helper now. Whether every departure listed here is gone has not been read through: its process-ID checks, its claim per project rather than per key, and its symlink are departures from this record, and any that remain are to be removed.
- **Reviews:** under the [adversarial review standard](../../process/adversarial-review-standard.md), a change that departs from this record has a second authority, and that blocks.
