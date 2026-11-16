# Contextual marker identity

**Status: accepted on 2026-10-06.** The user directed implementation after reviewing the identity board. Round-3 implementation follows [round 3, item 8](changes/round-3.md#margin-and-markers).

Sources:
- the Claude design canvas, kept privately, "Identity · contextual markers" row (`Markers.dc.html`);
- `Margin.dc.html`, which shows the identity in use;
- `design-export/` for the repo copies.

This document gives one visual identity to everything the context margin shows: its pins, previews, cards, source sheets and briefing citation chips. Terms are defined in [vocabulary.md](../../vocabulary.md#review-interface): contextual marker, marker pin, marker kind, the disclosure layers, review comment and draft.

## Why

The live app (localhost:3000, 2026-10-06) shows markers in three conflicting ways:
- **File names as labels.** Captured-source markers use the cited file's name as the pin label, so a file with six citations shows six identical `start-review-operation.ts` chips.
- **Kinds that look alike.** Doc, Graph and History share one grey chip.
- **Colour that doesn't match the need.** Recorded decision signals and failed native checks look no different from context that only informs.

## Three channels, one job each

| Channel | Carries | Values |
|---|---|---|
| Icon | What kind of marker it is | A Lucide icon at 12px, stroke 2.2. Never the lane primitives ◆ ◐ ○ □, which belong to [review lanes](../../vocabulary.md#responsibility-and-review-flow). |
| Colour | Whether it asks something of the reviewer | **Magenta** (`req`): it needs your decision (conflict, decision signal). **Amber** (`sug`): evidence is missing or failed. **Neutral**: it only informs. |
| Edge | Where it comes from | Filled: committed, retrieved context. Dashed: transient same-batch context, or unsaved work. Speech bubble: written by a person. |

Colour never separates two kinds on its own: each kind also has its own icon. A dashed edge is a secondary cue, so the label and icon still identify the pin without it.

## Kinds

Listed in priority order. When several markers share a line, the pin shows the highest-priority kind and counts the rest (rule 3).

| Pin label | Family | L2 kind label | Lucide icon | Data today → identity (`MarkerTone`) |
|---|---|---|---|---|
| Conflict | asks you · magenta | Conflict | `arrow-right-left` | `conflict` (unchanged) |
| Decision | asks you · magenta | Recorded decision signal | `flag` | `conflict` "Decision" → **`decision`** |
| Failed | asks you · amber | Failed or invalidated check | `flask-conical-off` | `test` "Check" whose outcome is failed or invalidated → **`failed`** |
| Gap | asks you · amber | Reported assessment gap | `circle-dashed` | `test` "Gap" → **`gap`** |
| Unavailable | asks you · amber | Linked evidence unavailable | `circle-dashed` with an x | `test` "Check" for linked evidence that is missing, or a native check that is not usable but neither failed nor invalidated → **`unavailable`** |
| Same batch | transient | Same batch · unreviewed | `layers` | `batch` (unchanged) |
| Signal | informs | Recorded contextual signal | `activity` | `history` "Context" → **`signal`** |
| Test | informs | Test / recorded native check | `flask-conical` | `test`, when the check is usable |
| Source | informs | Captured source | `code` | `graph` + file name as label → **`source`** |
| Graph | informs | Graph · blast radius | `git-fork` | `graph` (unchanged) |
| History | informs | Unit history | `history` | `history` (unchanged) |
| Doc | informs | Doc / ticket | `file-text` | `doc` (unchanged) |

### Margin items that are not markers

Review comments and drafts share the margin, the pin anatomy and the grouping rule. They are not contextual markers in the [vocabulary](../../vocabulary.md#review-units-and-context) sense, because they are not retrieved context. Carrying a review comment into later cycles as a marker is still a proposal (see `ContextualMarker.sourceKind` in `packages/ui/src/neuve/types.ts`).

| Pin | Family | Shape | Data |
|---|---|---|---|
| Author initials | person | speech bubble, radius 11 11 11 3 | `comment` |
| Draft (icon only) | person · unsaved | dashed bubble with `pencil-line` | UI only (parked draft) |

For grouping they rank after Unavailable and before Same batch.

## Rules

1. **One pin per line.** It sits on the first line of its anchored row (pins are 22px, rows 24px), flush left in the 300px margin column. The one exception is rule 4.
2. **The label is the kind, never the file.** A cited file appears as a faint target after the kind, and only when it differs from the file being reviewed. The target truncates before the kind does.
3. **A shared line** shows its highest-priority kind plus a count badge. The peek lists every item on that line; choosing one opens its card.
4. **Markers in collapsed lines** collect on the gap row as an outlined "N hidden" pin. Clicking it opens the gap.
5. **Shared with other units:** one dot per other unit, up to three, in the current text colour at 50%. This is unchanged from [round 2, item 11](changes/round-2.md#context-margin).
6. **Hover means real pointer hover; keyboard uses focus-visible.** Either one tints exactly the lines the item is about (`--nv-lit`, 140ms) and raises the peek: a light card with one short row per item on that line. There is no grey translucent tooltip. The open state (`--diffs-overlay-range-strong`) always reads stronger than hover.
7. **States:**

   | State | Treatment |
   |---|---|
   | Rest | The kind's tint |
   | Hover | One tint step darker |
   | Focus | 2px focus ring, offset 2px |
   | Open | Ink fill while its card is open (kind pins). A comment pin is its author's avatar, so open, hover and resolved draw a ring around the avatar and never change the avatar itself. |
   | Read-only neighbor | Outline only, no colour |
   | Resolved comment | Hidden behind "N resolved" |

8. **The same mark at every depth.** The kind icon appears on the L0 pin, in the L1 peek row, in the L2 card header (24px tile), in the L3 source-sheet header (32px tile) and on the briefing citation chip. Tile and chip colours follow the family.
9. **Accessible name:** kind, line, count, and the units it's shared with. For example: "Gap on line 1179, 2 markers, shared with 2 units".

## Measures

| Part | Value |
|---|---|
| Pin | 22px high, 6px radius, padding 0 8 0 6, gap 5, max width 220px |
| Text | Geist Mono 11px. The count badge is 16px. |
| Comment pin | Its author's avatar from the [review identity](changes/round-4.md#review-identity-round-42): a person's chat bubble or an agent's antenna square, 20px in the margin |
| Dashed edge | 1px dashed `--nv-line-strong` |
| Hit area | The pin plus 4px. On touch, the margin strip opposite the line. |

## Changes this needs

The web server layer (`apps/neuve-web/apps/web/src/server`) is the BFF, owned by the round-3 markers agent. No backend package changes.

| Where | Change |
|---|---|
| `live-review.ts`, captured-source citations | `tone: "source"`, `short: "Source"`, and the cited path in a new `target` field instead of the label |
| `live-review.ts`, recorded signals | decision → `tone: "decision"`; contextual → `tone: "signal"` |
| `overview-briefing.ts`, captured-source citations | `tone: "source"` (currently `graph`) |
| `live-model.ts`, recorded native checks | usable → `test`; failed or invalidated → `failed`; otherwise not usable → `unavailable` |
| `live-model.ts`, linked evidence unavailable | `unavailable` |
| `live-model.ts`, reported assessment gap | `gap` |
| `unit-history.ts`, `unit-responsibility.ts` | No change. `unitHistoryMarker` already uses `history` / "History". `unit-responsibility.ts` builds line anchors, not markers. |

**Types** (`packages/ui/src/neuve/types.ts`):
- Extend `MarkerTone` with `source`, `decision`, `failed`, `gap`, `unavailable` and `signal`.
- Add an optional `target` to `ContextualMarker`.

**UI** (`packages/ui/src/neuve/review-desk/context-margin.tsx`, plus `shared/marker-kind.tsx`):
- A kind table holding icon, family, label and priority.
- Grouping of same-line items by priority.
- The hidden-lines pin.
- The kind icon reused in the card, sheet and briefing chip.

Storybook covers each kind, each state, a shared line and the hidden pin.
