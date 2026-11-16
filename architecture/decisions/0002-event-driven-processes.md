# 0002: Event-driven processes

Status: accepted, 16 October 2026; revised 17 and 18 October 2026. Source: decisions [5.2, 6.3, 6.9, 8.2, 8.4, 8.12 and 10.31](../../process/decisions.md).

## Context

The current local stack starts five long-lived processes on four ports and rebuilds code on every start. An orphaned MCP server held port 4318 for a day on a stale revision. entire-cli runs no daemon at all: git hooks and agent hooks call the CLI on each event.

## Decision

The system is fully event-driven, and all additive work runs in the background.

1. **Capture.** Git hooks and agent hooks call the CLI, which writes the event to a spool file and returns quickly. The worker ingests the spool, so a busy database never makes a hook drop an event. Interactive commands write to Records directly.
2. **Queue.** Records turns events into durable jobs, such as embedding a new blob, updating the graph, or running the pipeline for a review request.
3. **Work.** Any process that queues work starts the worker. There is one worker per repository, held by an OS socket that is claimed under SQLite's write lock. No time lease is used anywhere (8.2). The worker stays alive while an ACP session is open. Otherwise it exits after 60 s idle, re-checking the spool and job table under the lock first. The release install registers a macOS launchd agent that sweeps every 5 minutes and at login.

There is no always-on service. MCP runs over stdio and lives exactly as long as the agent session that started it. The SSE server stays only until EVE leaves in M3 (8.4).

## Job queue

The worker has two slots (10.31): an interactive slot for review runs and a background slot for everything else, each taking its most urgent job first, so a burst of commit work never holds a review. The queue is "dial 2", the local essentials of [ruling 8.12](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026): durable jobs written in the same transaction as their event, de-duplication by key, retries with backoff, a final failed state with its cause, recovery of a dead worker's active jobs on start, and a deadline per job. It has no timed locks and is built with Effect primitives over SQLite. Callers use a small `JobQueue` service, so a shared or hosted setup can swap in `PersistedQueue` or BullMQ. Agents manage it through `neuve jobs`: list running and queued jobs with IDs and times, then inspect, drop or enqueue.

## Consequences

- Hooks never wait for long jobs.
- Background workers do precomputation driven by commits, such as embeddings ([0004](0004-persistence-and-range-immutability.md)).
- Pipeline runs are durable workflows that resume after a restart ([0003](0003-effect-native-harness-runtime.md)).
- The worker and launchd agent need a lifecycle that can be inspected: what is running, what is queued, and how to stop it.
