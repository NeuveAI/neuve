# neuve-web design round 3: refinement catalogue

Approved for implementation on 2026-10-06. The source is the round-3 rows of the Claude design canvas, kept privately; the repo copy is in [design-export/](../design-export/). Round 3 refines the [round 2](round-2.md) screens from what the running app showed (localhost:3000, 2026-10-06). It is not a redesign.

| Artboard | Covers |
|---|---|
| `Sticky.dc.html` | Sticky file header, viewed and collapse, jump landing, Files-tab tracking |
| `Ranges.dc.html` | Owned ranges with gap rows, sibling-owned lines, old/new gutters, skeleton rows |
| `Margin.dc.html` | Margin pins in use: one per line, kind icon, linked lines, peek, card |
| `Markers.dc.html` | Contextual marker identity. Its written spec is [context-markers.md](../context-markers.md). |
| `Polish.dc.html` | Smaller refinements, shown now vs proposed |

Terms follow [vocabulary.md](../../../vocabulary.md). Its [review-interface section](../../../vocabulary.md#review-interface), added 2026-10-06, defines the UI terms used here. That includes implementer, reviewer and review comment, which round 2 had kept out of the vocabulary.

Where this catalogue and a board disagree, the board wins for layout and behaviour. For colour values `globals.css` wins: boards are prototypes and may lag a token fix. For example, the Sticky board's dark jump tint is .28, but the token is .20. The boards' `--hunk` (#F6F3EC) is `--nv-expand` in code.

## Diff

1. **Sticky file header.**
   - The file header sticks to the top of the desk's scroll container until its file scrolls out, as on GitHub. Use native `position: sticky` inside a card with `overflow: clip`, not `hidden`.
   - Stuck styling: a soft shadow. Use a CSS `scroll-state(stuck: top)` container query, with the IntersectionObserver fallback from modern-web-guidance where the shadow matters.
   - **Merged variant** (chosen): the toolbar is not sticky. When the header is stuck, it gains a faint "1 / 3" file position and compact icon buttons for Stacked, Split and Wrap.
   - Path: the directory in muted ink truncates first; the basename stays in ink at 500 weight.
   - When the header runs out of room, the file name wins (user decision, kept privately, 2026-10-06). The name is cut only once nothing else can shrink. Items give way by actual available space, not fixed widths, in this order:
     1. the directory truncates from the left, then disappears;
     2. the stuck-only controls (the "1 / 3" position and Stacked / Split / Wrap);
     3. "Owned ranges / Whole file" become "Owned / Whole";
     4. Viewed keeps only its box;
     5. the +/− counts;
     6. the basename truncates last, with the full path in the tooltip.
   - The chevron and the Viewed box never go. Accessible names stay complete at every step. Steps 2 and 5 follow from the user's "nothing else can shrink"; the user was told and may veto dropping the counts.
   - Copy-path button: appears on real hover or focus-within.
2. **Viewed and collapse.**
   - A chevron collapses the file.
   - A Viewed checkbox marks the file viewed and folds it. Viewed state persists per viewer per unit and revision (`viewedFilesAtom`).
   - The toolbar shows "N/M viewed".
3. **Jump landing.**
   - Briefing citation chips and Files-tab rows scroll the target in below the sticky header (`scroll-margin-top`) and expand it if collapsed.
   - The range tint holds 275ms, then fades over 825ms. Reduced motion: an instant scroll and a static tint.
4. **Files tab tracking.** The rail Files tab marks the file under the sticky header as current (tone shift plus `aria-current`), shows viewed checks and +/− counts, and jumps on click.
5. **Owned ranges.**
   - Ranges render in line order with old and new line-number gutters.
   - Between ranges, a gap row ("12 unchanged lines · L9–20") opens in place, chunk by chunk.
   - The line range uses the same secondary grey as its label (`--nv-muted`), not the faint grey, so it meets text contrast (user decision, kept privately, 2026-10-06).
   - Lines owned by a sibling unit show as one grey row with a lock icon, the lane glyph and unit name, Show/Hide, and "Open unit →". Expanded, they use the read-only neighbor styling.
   - An Owned ranges / Whole file toggle in the file header replaces the bottom "Original submitted patch" `<details>`.
6. **Skeleton rows.** Rows that are virtualized but not yet painted keep their line numbers and show skeleton bars in the code column (`--nv-skel`), never blank white.
7. **Split view.** The missing side of a pair gets a flat `--nv-expand` fill.

## Margin and markers

8. **Marker identity.** Implement the accepted [marker identity](../context-markers.md) in full:
   - kind table, families, Lucide icons;
   - one pin per line, the highest-priority kind leads with a count;
   - the "N hidden" pin on gap rows;
   - states;
   - the same icon in the peek, card header, source-sheet header and briefing citation chip.
9. **Peek.** A light card with one row per marker on the line, never a grey translucent tooltip. Hovering or focusing a pin tints exactly its lines (`--nv-lit`, 140ms).

## Shell and smaller refinements

10. **Unit switch.**
    - The clicked rail row selects at once, and its lane glyph becomes a spinner.
    - After 150ms without arrival, the old unit dims to 45%.
    - On arrival the desk scrolls to the top of the new unit. Today it keeps the previous unit's scroll position.
11. **Decision dock.**
    - The scroll content gets bottom padding equal to the dock height plus 24px, so the dock never covers code.
    - After a decision the dock confirms what was recorded, then offers Undo and "Next unit →". "Back to batch" appears only when no undecided unit remains.
    - The confirmation names the action actually taken:
      - Approve: "You approved this unit".
      - Request changes: "You requested changes".
      - Agree, on human-suggested work: "You approved this unit", the same as Approve. The user decided on 2026-10-06 that agreeing reads as approval in the dock and in history (see the [vocabulary](../../../vocabulary.md#review-interface)).
12. **Batch overview.**
    - Judgment-table cells use fixed columns and truncate with an ellipsis; the full text appears in a tooltip.
    - Lane bar: a thin bar of solid lane colours, plus a legend row with lane glyphs, names and ink counts. The zero lane is a 6px stub. No raw slugs such as `awaiting-human`.
13. **One disclosure style.** A chevron row: 40px, a chevron rotating 90° over 200ms, label, count chip. It replaces native `▸` summaries on the batch overview (recorded limitations), lineage and anywhere else.
14. **Live status.** The full-width "Watching live review updates" strip is removed. The header shows "● Live" after the commit chip, and "Reconnecting" with an amber pulsing dot while the connection is down.
15. **Lineage rows.** One divided list with lane glyph, title, status chip ("You approved", "Agent approved") and a chevron. No raw lane slugs, and no separate bordered cards.
16. **Error page.** Technical detail moves into a collapsed mono "Details" disclosure with a copy button. `/changes/<short sha>` resolves or shows not-found, never the raw validation pattern.

## Rules that still apply

These carry over from [round 2](round-2.md):

- **State and effects:** no `useState`; use jotai. `useEffect` only with a `// Effect:` justification.
- **Motion:** `motion/react` with neuve-motion tokens. Reduced motion is mandatory.
- **Visual bans:** no gradients, no coloured edge rails.
- **Hover:** a hint shows only on real pointer hover or keyboard focus-visible.
- **Storybook:** validates every state.
- **Commits:** none until the user asks, and never with a `Co-Authored-By` trailer.
