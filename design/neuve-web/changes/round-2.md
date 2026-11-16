# neuve-web design round 2: change catalogue

Approved on 2026-10-03 in the Claude design canvas, kept privately. The repo copy of the canvas is [design-export/](../design-export/). These artboards are the source of truth for this round:

| Artboard | Covers |
|---|---|
| `Main.dc.html` | Review desk with every round-2 element integrated |
| `Overview.dc.html` | Batch overview |
| `Header.dc.html` | Header and agents control |
| `Split.dc.html` | Stacked and split diff, read-only neighbor context |
| `Lanes.dc.html` | Per-unit lane decisions |
| `Source.dc.html` | Source sheet variants |
| `Threads.dc.html` | Comment threads and live events |
| `Cycle.dc.html` | New revision mid-review |

Where this catalogue and an artboard disagree, `Main.dc.html` wins. It was iterated last.

Terms follow [vocabulary.md](../../../vocabulary.md). "Implementer", "reviewer" and "review comment as a contextual marker" are working labels that `vocabulary.md` does not yet define; don't treat them as vocabulary.

## Shell and navigation

1. **Header.**
   - Order: logo + logotype, then repo / branch, then the commit chip, then the Agents control, then Find ⌘K, then the theme toggle.
   - The human gate and Units/Files are no longer in the header.
2. **Units / Files.** Tabs at the top of the unit column. The human-gate meter (for example `0/2`) sits beside "Needs your decision" in the rail.
3. **Rail copy.**
   - The second group is titled **"Decided by agents and tools"**.
   - The Suggested sub-label is **"Agent approved · yours to override"**.
   - Each unit shows its owning agent tag (I1, I2).
   - No lane tabs. Lanes stay as rail groups.
4. **Collapsible rail.**
   - Collapses to a 60px icon column of identical 36px buttons: expand, back, divider, units-to-decide as their lane glyph (selected = tone shift), divider, lane groups as glyph + small count badge.
   - No loose numbers or text; names appear as tooltips. Shortcut `[`. The collapsed state is remembered per viewer.
5. **Agents control.**
   - **Avatars:** side by side with a small gap. Don't overlap them; the overlapped version was tried and rejected. Build them from shadcn/ui's Avatar with a badge for the status dot, a "+N" count, and the label "N agents · M live".
   - **Popover:** groups agents as Implementers and Reviewers. Each row shows scope (paths), unit count, status, and Connect / Disconnect.
   - **Connect:** picks from configured agents only. It never takes a command typed in the browser.
   - **Disconnect:** warns that the agent's context is lost while thread history stays.

## Diff

6. **Stacked / Split.** Split pairs removed and added rows side by side. Margin items anchor to the new-side row.
7. **Wrap.**
   - A Wrap toggle in the diff toolbar, on by default. Wrapped rows grow, and margin items follow the measured row position.
   - With wrap off, long lines scroll sideways per file. The gutter (line numbers and sign) stays pinned, and every row is as wide as the widest, so tints end evenly.
8. **Read-only neighbor.**
   - Shown in muted grayscale.
   - When expanded it shows its own surrounding context as muted pins.
   - You can comment on it; its decision stays in its own lane.

## Context margin

9. **Layout and placement.**
   - The margin column is 300px. An open card or thread must never clip.
   - Margin cards, threads, previews and pin hints anchor to their margin pin and are placed against the viewport like shadcn's HoverCard/Tooltip: prefer below, flip above when space runs out, shift to stay in view, cap height to the available space and scroll inside.
   - A nested graph path tooltip anchors to its path row and stays inside the visible card and viewport. When the card scrolls, its visible height cap remains the tooltip boundary. This clarifies the distinct anchors; it does not change the [Main artboard's precedence](../design-export/Main.dc.html) for the integrated review desk.
   - It re-positions on scroll, resize and anchor movement (CSS anchor positioning with fallbacks, else Floating UI autoUpdate or Radix popper). This replaces the earlier "sticky while scrolling" rule.
10. **Context card (L2).**
    - **Header:** kind icon tile, then one kind label that already carries status (for example "Same batch · unreviewed", "Decision signal", "Evidence gap", "Graph · blast radius"), cut off with an ellipsis if long, then close. No duplicate badge.
    - **Body:** title + mono meta, then a kind-specific excerpt:
      - **Graph:** a plain mono read-by tree with `├`/`└` branches and the file on the right. Untraced edges say "not traced" in red. Truncated paths expand to the full `path:line` in a tooltip on real hover or keyboard focus, wrapped and kept inside the card.
      - **Conflict:** the two sources side by side, "vs".
      - **Code / test:** a highlighted mono snippet that wraps rather than scrolling.
      - **Doc / history:** a quoted excerpt.
    - **Why it's here:** one line.
    - **"Before you decide" callout:** one plain sentence naming what to check in real code or UI, plus one action. Examples: Open admins unit · Open cache/links.ts · Ask the implementer · Go to that unit · Request a check · Open routes/open.ts. Don't use an "Uncertain" line or opaque copy.
    - **Footer:** a quiet "Open source →" only, no "cited by" text. Never scrolls sideways.
11. **Markers shared across units: show it, don't footnote it.**
    - **At rest:** the pin carries one small dot per other unit (up to three, current text colour at 50%).
    - **On hover or open:** the linked units in the rail tone-shift over 160ms. A unit gets a link glyph; a lane group gets one dot per linked unit.
    - **Rejected:** a stacked/raised pin edge and a unit-glyph strip in the card header.
12. **Source sheet (L3).**
    - Kind label and status chips.
    - Title and mono subtitle.
    - Actions: VS Code / Cursor / Zed / copy path for code; Open in Linear for tickets; Show commit and the incident for history.
    - Two to four facts, coloured where they carry status.
    - Kind-specific blocks: highlighted code with line numbers, the highlighted requirement, done-when rows with observed or no-evidence states, file rows with +/−, reader rows.
    - Footer: "Cited by" chips and "Go to its unit" when relevant.
    - Code is always Geist Mono.

## Decisions and lanes

13. **Per-unit decisions only.**
    - Suggested unit: Request changes (overrides the agent's approval and goes to the implementer) or Agree.
    - Agentic and static units: no escalation. **Comment** adds context for that unit's next cycle.

## Comments, threads and events

14. **Comments UI** (already in code; keep it and document it in Pen):
    - **Gutter:** a "+" handle on line numbers. Click, drag, Shift-click, Shift+↑/↓ or a touch tap selects a range.
    - **Comment chip:** "Comment · L20–23".
    - **Composer:** isolates the other pins.
    - **Drafts:** Escape with text, or an outside click, parks the draft as a pin.
    - **Saved comment:** a speech-bubble avatar pin with a light hover preview card. The preview appears only on real hover or keyboard focus, and stays inside the margin.
    - **Thread card:** human bubble avatars and agent rounded-square avatars.
    - **Resolved:** hidden by default, with an "N resolved" toggle.
15. **Thread states** (the ACP research found no read receipts):
    - The states are queued → sent → picked up → working → replied, plus "needs your input" (with Allow once / Deny) and failed.
    - Only the agent's final reply is a message. Interim narration and tool calls collapse under "working".
16. **New-commit notice.**
    - A Neuve event sourced from Git: a dark notice with Later / What changed. Later shrinks it to a corner pill.
    - Commits inside the inner loop show as thread activity, not as a new cycle.

## Batch overview

17. The same header and Agents control. Each "Needs your judgment" row carries its owning agent tag.

## Rules that still apply

- **State and effects:** no `useState`; use jotai. `useEffect` only with a `// Effect:` justification.
- **Motion:** `motion/react` with the neuve-motion tokens. Reduced motion is mandatory.
- **Visual bans:** no gradients and no coloured edge-rail state indicators.
- **Hover:** a hint shows only on real pointer hover or keyboard focus-visible.
- **Storybook:** validates every state, with fixtures in `packages/ui/src/fixtures`.
- **Commits:** never add `Co-Authored-By` trailers.
