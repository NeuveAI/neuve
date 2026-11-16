# NOTICE

`@workspace/diffs` is a modified copy of **`@pierre/diffs`** 1.5.1 by The
Pierre Computer Company (<https://github.com/pierrecomputer/pierre>,
`packages/diffs`, upstream commit `228c5848583efb501ef5dbaf859a60eac3391ccb`), licensed under the Apache
License 2.0. The original license is kept unchanged in [`LICENSE.md`](LICENSE.md).
Each modified file carries its own prominent change notice for section 4(b)
of that license. This file records the source and the complete inventory.

Copyright for the original work remains with its authors. The modifications
below were made in 2026 for the Neuve web workspace and are distributed under
the same Apache-2.0 license.

## What was copied

The comparison uses all tracked files in upstream `packages/diffs/` at the
commit above, plus four files from upstream `apps/demo/src/mocks/` mapped to
`test/fixtures/`: `fileOld.txt`, `fileNew.txt`, `diff.patch` and
`fileConflictLarge.txt`. The four fixtures are byte-identical to upstream,
so they carry no added notice. `LICENSE.md` is also byte-identical.
Generated files and installed dependencies are outside this inventory.

The comparison found 310 identical files, 28 modified files, 8 files added
by Neuve and 73 upstream files omitted from this copy.

## Modified files

Every file below starts with a notice in this form:
`Modified by Neuve AI in 2026: <what changed>. See NOTICE.md.`
TypeScript and `tsconfig.json` use line comments, CSS uses a block comment,
and Markdown uses an HTML comment. `package.json` keeps valid JSON with the
notice in its first `_comment` field, since JSON does not support comments.
Existing upstream attribution and license text remain unchanged.

| File                                           | Change                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `README.md`                                    | Document the fork and workspace commands.                                      |
| `package.json`                                 | Adapt workspace exports, dependencies and scripts.                             |
| `src/components/FileDiff.ts`                   | Add overlay annotations, presentation controls and skeleton rows.              |
| `src/components/VirtualizedFileDiff.ts`        | Position overlay annotations in virtualized diffs.                             |
| `src/components/web-components.ts`             | Add a placeholder slot before rendering.                                       |
| `src/highlighter/languages/constants.ts`       | Remove the replaced language promise map.                                      |
| `src/highlighter/languages/resolveLanguage.ts` | Share language loading through SharedWork.                                     |
| `src/highlighter/shared_highlighter.ts`        | Handle disposal during highlighter loading.                                    |
| `src/index.ts`                                 | Export the annotation overlay manager.                                         |
| `src/managers/InteractionManager.ts`           | Add accessible expansion, commentable lines and controlled keyboard selection. |
| `src/renderers/DiffHunksRenderer.ts`           | Add ranged review gutters, folds and gap controls.                             |
| `src/style.css`                                | Style overlays, skeletons and ranged review rows.                              |
| `src/types.ts`                                 | Add overlay annotation and ranged review options.                              |
| `src/utils/areDiffLineAnnotationsEqual.ts`     | Compare annotation ids and anchor slots.                                       |
| `src/utils/areOptionsEqual.ts`                 | Import file options without React.                                             |
| `src/utils/createSeparator.ts`                 | Add accessible expansion and hidden line ranges.                               |
| `src/utils/getDiffHunksRendererOptions.ts`     | Forward ranged review options.                                                 |
| `src/utils/hast_utils.ts`                      | Render dual line numbers in unified gutters.                                   |
| `test/CodeView.collapsed.test.ts`              | Preload themes and dispose the highlighter.                                    |
| `test/CodeView.headerFooter.test.ts`           | Preload themes before CodeView assertions.                                     |
| `test/CodeView.partialHydration.test.ts`       | Preload themes before hydration assertions.                                    |
| `test/CodeView.rangeScroll.test.ts`            | Preload themes before scrolling assertions.                                    |
| `test/DiffHunksRender.test.ts`                 | Check the renamed unchanged-lines label.                                       |
| `test/editorApplyEdits.test.ts`                | Preload highlighting before editable-content assertions.                       |
| `test/mocks.ts`                                | Load the relocated demo fixtures.                                              |
| `test/parseMergeConflictDiffFromFile.test.ts`  | Load the relocated conflict fixture.                                           |
| `test/sharedHighlighter.test.ts`               | Cover disposal during language loading.                                        |
| `tsconfig.json`                                | Configure standalone workspace typechecking.                                   |

## Files added by Neuve

These files are Neuve additions, distributed under the same Apache-2.0
license as the package. They are listed explicitly here instead of adding
headers to them.

- `NOTICE.md`.
- `src/managers/AnnotationOverlayManager.ts`.
- `test/annotationOverlay.test.ts`.
- `test/commentableLines.test.ts`.
- `test/keyboardSelection.test.ts`.
- `test/rangedReview.test.ts`.
- `test/resolveLanguage.shared.test.ts`.
- `tsconfig.build.json`.

## What was removed

The following 73 upstream files are omitted. Neuve's React binding lives in
`packages/ui` and keeps its state in jotai; this copy keeps the vanilla DOM
and web component implementation. The build uses Bun rather than the
upstream pnpm, moon and tsdown setup.

### React bindings (21 files)

- `src/react/CodeView.tsx`.
- `src/react/EditContext.tsx`.
- `src/react/File.tsx`.
- `src/react/FileDiff.tsx`.
- `src/react/MultiFileDiff.tsx`.
- `src/react/PatchDiff.tsx`.
- `src/react/UnresolvedFile.tsx`.
- `src/react/Virtualizer.tsx`.
- `src/react/WorkerPoolContext.tsx`.
- `src/react/constants.ts`.
- `src/react/index.ts`.
- `src/react/jsx.d.ts`.
- `src/react/types.ts`.
- `src/react/utils/assignRef.ts`.
- `src/react/utils/renderDiffChildren.tsx`.
- `src/react/utils/renderFileChildren.tsx`.
- `src/react/utils/templateRender.tsx`.
- `src/react/utils/useFileDiffInstance.ts`.
- `src/react/utils/useFileInstance.ts`.
- `src/react/utils/useStableCallback.ts`.
- `src/react/utils/useUnresolvedFileInstance.ts`.

### Server rendering (6 files)

- `src/ssr/FileDiffReact.tsx`.
- `src/ssr/index.ts`.
- `src/ssr/preloadDiffs.ts`.
- `src/ssr/preloadFile.ts`.
- `src/ssr/preloadPatchFile.ts`.
- `src/ssr/renderHTML.ts`.

### Playwright suite (34 files)

- `test/e2e/annotations.pw.ts`.
- `test/e2e/check-playwright-binary.ts`.
- `test/e2e/code-view-annotations.pw.ts`.
- `test/e2e/code-view-prediction.pw.ts`.
- `test/e2e/conflict.pw.ts`.
- `test/e2e/diff-render.pw.ts`.
- `test/e2e/e2e-globals.d.ts`.
- `test/e2e/edit-collapsed.pw.ts`.
- `test/e2e/edit-rewrite.pw.ts`.
- `test/e2e/edit.pw.ts`.
- `test/e2e/file-states.pw.ts`.
- `test/e2e/find-replace.pw.ts`.
- `test/e2e/fixtures/annotations.html`.
- `test/e2e/fixtures/code-view-annotations.html`.
- `test/e2e/fixtures/code-view-prediction.html`.
- `test/e2e/fixtures/conflict.html`.
- `test/e2e/fixtures/diff-render.html`.
- `test/e2e/fixtures/edit-collapsed.html`.
- `test/e2e/fixtures/edit.html`.
- `test/e2e/fixtures/editable.html`.
- `test/e2e/fixtures/file-states.html`.
- `test/e2e/fixtures/index.html`.
- `test/e2e/fixtures/line-select.html`.
- `test/e2e/fixtures/markers.html`.
- `test/e2e/fixtures/selection-action-edges.html`.
- `test/e2e/fixtures/selection-action.html`.
- `test/e2e/fixtures/theme.html`.
- `test/e2e/line-select.pw.ts`.
- `test/e2e/markers.pw.ts`.
- `test/e2e/multi-edit.pw.ts`.
- `test/e2e/playwright.config.ts`.
- `test/e2e/selection-action.pw.ts`.
- `test/e2e/theme.pw.ts`.
- `test/e2e/vite.config.ts`.

### Other tests and tooling (12 files)

- `benchmarks/CSS_PERFORMANCE_BENCHMARK.md`.
- `moon.yml`.
- `scripts/benchmarkEditorPieceTable.ts`.
- `scripts/benchmarkEditorTokenizer.ts`.
- `scripts/benchmarkParseMergeConflictDiffFromFile.ts`.
- `test/preloadAnnotations.test.ts`.
- `test/preloadDiffs.optionalSides.test.ts`.
- `test/preloadThemeType.test.ts`.
- `test/reactCodeViewEditorOptions.test.ts`.
- `test/reactEditorOptions.test.ts`.
- `test/reactPartialHydration.test.ts`.
- `tsdown.config.ts`.

## Build and tooling

- pnpm + moon + tsdown → bun. The package is consumed as TypeScript
  source (`exports` → `src/*.ts`; Vite bundles it, including the worker via
  `?worker`). `typecheck` also emits declarations to `dist/types` for
  consumers' `tsc`. Tests still run with `bun test`.

## Functional modifications

The file inventory above covers every modification. Local `NEUVE FORK`
comments also describe some of the changes inside the implementation.

1. **Overlay annotation layer** (`annotationLayout: 'overlay'`).
   - New `src/managers/AnnotationOverlayManager.ts`: a positioned layer in the
     shadow root, beside the code, with one item per anchor (side + line),
     per-annotation pin and body slots, a single shared hint slot, collision
     stacking (downward, then contained inside the host), and state: one
     expanded annotation (isolation: other items dimmed, `inert`, no pointer;
     optional page-wide isolation), dismissed annotations (body collapses to
     the pin), dismiss/reopen all, hint. Alignment and the update triggers are
     documented at the top of that file.
   - `src/components/FileDiff.ts`: in overlay mode the hunks renderer gets no
     annotations, so no annotation rows exist and code rows never shift;
     annotation changes no longer force a code re-render; new public methods
     (`expandAnnotation`, `dismissAnnotation`, `reopenAnnotation`,
     `dismissAllAnnotations`, `reopenAllAnnotations`, `showAnnotationHint`,
     `hideAnnotationHint`, `setAnnotationOverlayState`,
     `getAnnotationOverlayState`, `getAnnotationOverlayLayout`,
     `layoutAnnotationOverlay`) and options (`annotationLayout`,
     `annotationOverlay`, `renderAnnotationPin`).
   - `src/components/VirtualizedFileDiff.ts`: places items for rows outside
     the render window from `getLinePosition()`; overlay annotations do not
     force re-renders or count as a file-annotation row.
   - `src/types.ts`: optional `id` on `DiffLineAnnotation` (also compared in
     `areDiffLineAnnotationsEqual`).
   - `src/style.css`: overlay layer styles (geometry via
     `--diffs-overlay-*` custom properties, L0 underline, expanded and
     active anchor rings, reduced-motion fallbacks).
   - Sticky expanded content (round 2): the expanded item runs from its
     anchor to the host bottom (`--diffs-overlay-item-top`, set by the
     manager) so a host can make its card `position: sticky` and cap it at
     the viewport; the item is stacked at its pin-row height, and only
     slotted content takes pointer events.
2. **Keyboard access to hunk expansion.** Expand buttons are focusable with an
   accessible name (`src/utils/createSeparator.ts`) and activate on
   Enter/Space (`src/managers/InteractionManager.ts`).
3. **Tests.** `test/annotationOverlay.test.ts` covers the overlay layer and
   `test/rangedReview.test.ts` the ranged review presentation (item 4). The
   retained upstream tests pass; one is extended:
   `test/DiffHunksRender.test.ts` keeps its "0 unmodified lines" negative
   check and adds "0 unchanged lines", since item 4 renames the separator
   wording and the upstream check alone could no longer fail.
4. **Ranged review presentation** (round 3, 2026-10-06).
   - `unifiedLineNumbers: 'both'`: the unified gutter shows the old and the
     new line number side by side (`src/utils/hast_utils.ts`
     `createGutterItem`, `src/renderers/DiffHunksRenderer.ts`).
   - `hunkFolds`: a fold renders one slotted row above its hunk
     (`createFoldCell`); collapsed, the hunk's rows are skipped; read-only,
     they carry `data-read-only`. For the non-virtualized `FileDiff` only.
   - `FileDiff.setPresentation()` updates folds, `expandUnchanged` and a
     host-owned gap expansion map (`DiffHunksRenderer.applyExpandedHunks`)
     without rebuilding the instance or re-highlighting.
   - Overlay: `DiffLineAnnotation.anchorSlot` places an item at the row
     holding a slot (a fold row or a custom hunk separator); the
     `landing` state tags a range `data-overlay-land` (`a`/`b` restart the
     tint, `static` holds it).
   - Skeleton rows: virtualizer buffers show numbered skeleton rows next to
     the rendered window (`FileDiff.fillSkeleton`) and a masked bar pattern
     beyond (`--diffs-skeleton-color`), breathing on opacity; the
     `diffs-container` element has a `placeholder` slot shown until the
     renderer's first output (`src/components/web-components.ts`).
   - CSS hooks: `--diffs-content-buffer-image` / `-color` and
     `--diffs-gutter-buffer-color` replace the split view's hatched missing
     side; a 140ms box-shadow transition on rows (overlay highlight); the
     landing keyframes (`--diffs-overlay-land`).
   - `HunkFold.row: false`: the read-only decoration without a fold row, for
     virtualized renders (the virtual layout cannot estimate a host row).
   - Separator label (review round 2): "N unchanged lines" instead of
     "unmodified", and `data-hidden-range` ("L12–30") on the count with the
     new-side lines still hidden, computed in `processDiffResult` from the
     hunk and its expansion region (leading gaps open from both ends, the
     trailing gap from its top). The directional up/down/both expand buttons
     and "Expand all" are unchanged: the Neuve host restyles them to its gap
     row, but plain-file separators keep Pierre's directional controls while
     owned-range gap rows (host-rendered) have one control that opens 20
     lines downward. That difference is accepted.
5. **Commentable lines** (round 6, 2026-10-16). A new
   `isLineCommentable(point)` option (`src/managers/InteractionManager.ts`,
   passed through `pluckInteractionOptions`) says which lines can take a
   comment. When it is set:
   - a focused line number that can't is named just "Line N" (with
     "(removed)" on deletions); one that can keeps "Line N. Enter to comment,
     Shift+Arrow to extend.";
   - the gutter utility ("+") never shows on such a line, whether placed by
     hover, focus or a selection (`showUtilityOnLine`);
   - no selection covers such a line. A press or Space there clears the
     selection; Enter or C there commits the selection only right after
     a clamped Shift+Arrow (focus just past it), otherwise nothing; a plain
     arrow, a press, Space, Escape or any other selection change ends that. Shift+↑/↓, pointer and
     touch selection and a gutter utility drag stop at the last commentable
     line from their anchor (none when the anchor can't take a comment);
     crossing to the other side keeps extending the anchor's side, in row
     order, up to the target row;
   - ↑/↓ still move focus between every line.
     Unset, behaviour is unchanged. `test/commentableLines.test.ts` covers it.
6. **Keyboard selection with a controlled host** (round 6, 2026-10-16), in
   `src/managers/InteractionManager.ts`:
   - Shift+↑/↓ extends from a kept keyboard anchor (set by Space or the
     first extension, kept while it is still an end of the selection), not
     from the range's `start`. A host that echoes the selection back with
     its top line first no longer turns extending upward into shrinking.
   - When a render replaces the focused line number and focus falls to the
     page, `setup()` focuses the same line's new cell as the gutter's tab
     stop (`restoreGutterFocus`). Focus the reader moved elsewhere,
     including to the page, is left alone.
     `test/keyboardSelection.test.ts` covers both.

7. **Language loading and highlighter disposal.**
   `src/highlighter/languages/resolveLanguage.ts` uses Records' `SharedWork`
   for concurrent requests, replacing the promise map in
   `src/highlighter/languages/constants.ts`.
   `test/resolveLanguage.shared.test.ts` covers shared loading and retry.
   `src/highlighter/shared_highlighter.ts` detaches an instance before
   disposal and restarts callers whose instance was disposed during loading;
   `test/sharedHighlighter.test.ts` adds the disposal regression case.
8. **Test isolation and fixture paths.** The four modified `CodeView` tests
   preload their themes. `test/editorApplyEdits.test.ts` preloads its themes
   and language before asserting editable content, instead of polling for
   it. `test/mocks.ts` and `test/parseMergeConflictDiffFromFile.test.ts`
   read the identical demo data from `test/fixtures/` in this package.

## Not verified

- The overlay layer inside `CodeView` (multi-file virtualized lists), edit
  sessions with overlay annotations, and split view with the overlay.
