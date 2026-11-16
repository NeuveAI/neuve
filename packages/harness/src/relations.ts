/**
 * Graph relations for a review (NEU-148 WP11): one stored relations index per commit
 * (`relations-index.ts`), a relation slice per changed symbol at each side (`relations-slices.ts`),
 * and both sides of a range stored before a review (`relations-prepare.ts`).
 *
 * Every caller row, changed edge and still-pointing row of a slice says how Graph matched it
 * (`matched`): `resolved` (the engine resolved the call), `receiver-type` (matched by the receiver's
 * type along an import path) or `name-only` (matched by name alone along an import path). A
 * `resolved` or `receiver-type` row may count as caller or test evidence; a `name-only` row is
 * context only and must never count as evidence that lifts a gap. The caller and test-caller counts
 * say how many rows may count (`trusted`) beside the total, and how many of those show a place
 * (`placed`). Every row's `site` says what its line shows (`SliceSite`): `call` ("called here"),
 * `reference` ("used here") or `caller` (no place: only "called from this function").
 */
export * from "./relations-index.ts";
export * from "./relations-prepare.ts";
export * from "./relations-slices.ts";
