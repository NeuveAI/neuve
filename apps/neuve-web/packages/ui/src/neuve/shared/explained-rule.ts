/**
 * How a unit's Explained shows: the one rule the projection offers the
 * Explained stop by (`deliveryStopsOf`) and the desk draws it by
 * (`Briefing`), so the stop is offered exactly when the desk has something
 * to show there. No imports: the BFF reads it on the server.
 *
 * - `rows`: the unit has several changes and every one has its own
 *   Explained, one row each.
 * - `unit`: the unit's own Explained, once. A unit of one change has its
 *   change's, which the projection hands on as the unit's.
 * - undefined: none. Several changes with only some explained show none.
 *
 * `rows` are the changes the desk draws as rows (`rowExplained`).
 */
export function explainedShows(
  own: object | null | undefined,
  rows: ReadonlyArray<object | null | undefined>
): "rows" | "unit" | undefined {
  if (rows.length > 1 && rows.every((row) => row != null)) return "rows"
  return own != null ? "unit" : undefined
}

/**
 * Each change's Explained when the desk draws the unit's changes as rows,
 * two or more; with fewer there are no rows.
 */
export function rowExplained<T>(
  sections: ReadonlyArray<{ readonly explained?: T | null | undefined }> = []
): ReadonlyArray<T | null | undefined> {
  return sections.length > 1 ? sections.map((section) => section.explained) : []
}
