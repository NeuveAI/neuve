# 0011: Zod schemas

Status: accepted, 16 October 2026. Source: decision [5.9](../../process/decisions.md).

## Decision

Zod is the single schema library for stored and wire types, and Effect consumes zod schemas. The duplicate Effect Schema definitions of domain types in the web backend and storage packages are removed and derived from the zod definitions.

## Reading stored data

Producer input is parsed strictly. Stored Records and cross-process messages use the shared compatible-read rule: try the strict schema, then drop a key only when at least one applicable schema rejects it as unrecognized and none declares it at that occurrence, and retry. Successful reads report newer keys dropped by retry or stripped by Zod, and preserve them on write-back. Other failures stay corrupt under [8.19's corruption rule](../../process/decisions.md#area-8-records-rebuild-m2-17-october-2026); integrity checks use the stored data.

[12.56's narrowed helper contract](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) leaves strict reads unchanged and refuses additive retry through codecs, transforming pipes or aliased union occurrences selecting different branches. Every refusal captures the store or file, redacted schema path, shape kind and build identities in the run log with telemetry when enabled, or on stderr outside a run. The registry test traverses real reader roots and keeps production records under [12.24's cross-build rule](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) in full: additive fields need no new kind version; breaking changes do.

A read-modify-write restores every dropped key at its stored path with the shared preservation helper. If it cannot preserve those keys, it leaves the operation to the newer build; projection rebuilds and advisory caches leave newer data untouched.
