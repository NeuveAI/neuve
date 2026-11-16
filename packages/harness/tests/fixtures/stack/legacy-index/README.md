# Historical stack indexes

These fixtures contain real writer output for the same `one.ts` tree. JSON whitespace is formatted for the repository; no metadata values, document tuples, dictionaries or binary postings were reconstructed.

- `available/` was written by `buildTreeIndex` imported directly from clean `main-check` at `b1295ebe5524090afdfcb93d61137f20e282ad3a`, with its actual `oxc-parser@0.127.0` installation.
- `unavailable/` was written by the same old source bundled into an isolated directory without the parser package. Other dependencies were absolute externals. The original `createRequire(import.meta.url)` failed to load the parser and took its own fallback. Neither the recipe function nor its inputs were edited.
- `source-bound-graph/` was written by `2fddab744ec7f970f12f31d93458dbb2f40bfc04` with the pinned Graph executable whose SHA starts `4f328ec6`. It covers migration from the last source-dependent recipe to separate source metadata.

[Provenance](provenance.json) records writer commits, source hashes, the input tree and source bytes, and each writer's actual recipe object, key and metadata. The [upgrade tests](../../../stack-index-admission.test.ts) copy these indexes into a scratch store and run normal admission, rather than patching a current index's recipe.

The capture generator runs with the required Bun/TMPDIR environment. Its arguments are the read-only legacy checkout, the implementation checkout at `2fddab74`, and the output fixture folder. It checks both writer revisions, refuses edited harness source, and records the source hashes, input tree, recipe and output metadata in `provenance.json`. The unavailable variant uses `Bun.build` over the old `stack/index-store.ts` with bare dependencies resolved as absolute externals. The bundle runs outside any parser installation. Fixture tests consume the captures without either historical checkout or parser installed.
