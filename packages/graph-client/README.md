# Graph inspection cache and executable contract

`planGraphPreparation` observes the provider's exact syntax-generation selection
and `ready` or `absent` availability through a read-only index plan. Absence is a
prospective selection, not an attested retained read. `prepareGraphGeneration`
requires that expected generation identity and explicitly prepares it. Both return
Effects with `GraphPreparationError`; they qualify source owner/scope, commit,
tree, serving policy receipt and frozen executable through this package's single
provider boundary. A producer or policy change refuses the expected selection.
Neither API creates a source worktree, substitutes HEAD, queries for readiness,
or falls back to full indexing.

Preparation reports actual invocation extraction/reuse work and the provider's
coverage, warnings and partial failures. Syntax generation supports only
DEFINES/CONTAINS; it does not provide full relationship binding, LSP or embeddings.
Callers still own durable Git-event intent, retries, freshness and publication.
Retrieval remains separate and read-only.

`GraphInspectionRequest.cache` optionally selects `"reuse"`, `"refresh"` or `"prepared"`.
Omission reuses compatible committed snapshots. Refresh runs Graph's existing
`index --head --profile full --format json --force` before retrieval. Graph-client
requires a successful index receipt for the exact serving root, commit, tree,
provider, version and full profile. A refresh failure ends the inspection before
its first retrieval event, after removing the owned temporary view.

The committed cache plan (removed; in git history at `c8b73b41` as
`process/graph-cache-plan.md`) assigns snapshot
identity, serialization, serving-root rebinding and generation replacement to
Graph. Graph-client continues to own one unique pinned inspection view and its
cleanup. This cache does not implement the historical committed graph.

Production index, query and neighbors commands pass an explicit cache directory,
by default the store's Graph folder, `<git common directory>/neuve/graph/cache`:
the cache the harness keeps, shared by every worktree of the repository and never
inside a working tree. Detached inspection views share that owner location;
provider environment defaults cannot redirect it to a global cache.
Evaluation callers may explicitly select `GraphInspectionRun.cacheDirectory` for
controlled isolated-cache experiments. The public CLI does not expose that override.

Every inspection copies the configured executable into its owned temporary
directory, preserves its basename, and invokes that copy for version,
capabilities, refresh, query and neighbors. The supported production executable
is the native Graph binary. A self-contained executable script can also run, but
its executable-relative resources are not copied. Such scripts must name external
resources explicitly. There is no fallback to the configured mutable path.

The normalized provider identity records the copied executable's SHA256 digest.
An optional Graph `build_identity` report must equal that digest. Missing reports
are `unreported`; a matching report is `verified`. The copy is read-only during
normal use, and a final digest check rejects changes before the completion event.

Successful query and relationship observations each contain one operational
`cache` observation with `status` of `hit`, `miss` or `unreported`, and
`indexLatencyMs` of a nonnegative integer or `null` when absent. A resolved
relationship uses its final stable-ID neighbors command. An unresolved focus uses
its selector command. Malformed present fields fail the relevant boundary.
These observations add no trust or completeness claim. The CLI's existing public
JSON and streaming schemas continue to select their established product fields.

The query-only `indexedFileCount` reports Graph's `stats.files_indexed` as a safe
nonnegative integer, or `null` when the provider omits it. It describes the
provider's indexed file population for that query, not which files were indexed,
exhaustive relationship coverage, or evidence sufficiency. Compare it alongside
cache state and controlled invocation traces when measuring selective and
full-index queries. Relationship observations do not invent a corresponding
count. Public JSON and streaming projections omit this operational field.

The public command accepts the optional boolean `--refresh-cache` flag. Repeating
it or supplying an attached value is an error.

Prepared mode requires the provider capability `prepared_snapshot_query` and
forwards `--prepared-only` to every query and neighbor read, including focus
resolution. It never issues `index`. Each successful read must report both a
cache hit and `analysis_scope: "complete-prepared"`; unsupported providers,
unconfirmed reads and retained-artifact failures become typed section errors
with an optional `preparedFailure` reason. Arbitrary provider diagnostics do not
become public errors.

The [prepared-read decision](../../apps/neuve-graph/docs/adr/0005-prepared-only-reads.md)
explains exact-commit qualification, history handling and the remaining ingestion
work. Complete prepared graph scope preserves existing natural-language ranking,
source snippets, partial failures and budgets; it does not certify complete
language coverage or review quality. Existing cold and warm lexical selection can
produce different corpus scores. Native equality tests compare separately built
complete artifacts under the same serving retrieval policy.

The public command also accepts the optional boolean `--prepared-only` flag.
It is mutually exclusive with `--refresh-cache`; repetitions and attached values
are errors. MCP query input exposes the corresponding `prepared_only` boolean.
Ordinary reuse remains the default until the record-service ingestion gate can
select prepared reads for a durably published exact revision.

Run `bun run verify:prepared /absolute/path/to/neuve-graph` from this package
to verify a compiled capable native provider with an isolated no-remote Git
fixture. This explicitly prepares only that fixture, then exercises the public
inspection API and its default owner cache; it does not ingest the workspace.
Detached serving views preserve the original directory basename inside a unique
owned source parent separated from the pinned executable directory so local provider IDs agree with preparation. This does not fix the
existing basename collision limitation of `local/<basename>` IDs; cache ownership
still separately binds Git common-directory and scope.
