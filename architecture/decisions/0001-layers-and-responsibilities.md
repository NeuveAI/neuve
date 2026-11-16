# 0001: Layers and responsibilities

Status: accepted, 16 October 2026; revised 17 October 2026. Source: decisions [1.7, 2.2, 5.1 and 8.3](../../process/decisions.md).

## Context

Today the Records process also makes model calls, relays ACP messages and runs finalization. The web backend keeps the whole review state in memory and derives records from it. The EVE agent server calls back into Records, so a restart of either one kills in-flight reviews. Responsibilities have collapsed into two god objects: `history.ts` at 19.8k lines and `store.ts` at 5.6k lines.

## Decision

There are six base layers: harness, system of records, graph, CLI, MCP and web app. Each owns its internal abstractions and talks to the others only through declared boundaries. The [architecture overview](../README.md#layers) lists what each layer owns.

- Records stores and coordinates. It never calls a model, runs retrieval or orchestrates agents.
- Records is a library, not a server (8.3). Every process that needs it (CLI, MCP, worker, BFF) links it and works on one SQLite file. Its schema and projectors run in each of those processes, and stored schema and minimum-writer versions stop an older binary from writing.
- The harness owns the final-review pipeline completely and is a client of Records.
- The web app is an event-driven interface. The BFF projects Records state, watching a sequence number for changes, and relays commands. It holds no business logic.
- ACP is a connection to external coding harnesses, used only when one is available.

## Consequences

- Model I/O, the ACP relay and finalization move out of Records into worker jobs.
- No dependency cycle between layers. Records does not import the harness, AI, editor or backend packages.
- A layer can restart without killing work in another, because work is queued and resumable ([0002](0002-event-driven-processes.md)).
