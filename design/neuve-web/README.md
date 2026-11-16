# neuve-web design

Design sources for the Neuve web UI ([`apps/neuve-web`](../../apps/neuve-web)).

The design system is the Figma file [Design System](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS/Design-System); [design-system.md](design-system.md) describes it. design.pen (kept in the private archive) was retired on 2026-10-23 ([decision 10.105](../../process/decisions.md#area-10-harness-m3-18-october-2026)).

Start with the [design handover](HANDOVER.md): where each surface lives and stands, the design ethos, the user's directions, the working rules and the open items.

| Path | What it is |
| --- | --- |
| [HANDOVER.md](HANDOVER.md) | The design handover of 2026-10-17, written while the Pen was the design system. |
| [design-export/](design-export/) | Repo copy of the Claude design canvas: the prototyping source of truth. `.dc.html` artboards plus `canvas.json` (layout and the motion storyboard note). They need the canvas runtime to render. |
| [context-markers.md](context-markers.md) | Contextual marker identity (accepted 2026-10-06): kinds, icons, families, states and grouping rules for pins, previews, cards and citation chips. |
| design.pen (kept in the private archive) | The Pen, which held the design system until it was retired on 2026-10-23. Kept as a record and no longer edited. |
| [design-system.md](design-system.md) | How the Figma design system is structured (pages, layers, naming, code twins), the rule that keeps every surface in step, and the history of the Pen rebuild. |
| [figma/](figma/) | The record of the port from `design.pen` to Figma: the transfer manifest and a README with the [Figma file](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS) link, its build history, its deliberate choices and how to refresh the local copy. |
| design.fig (kept in the private archive) | A dated local snapshot of that Figma file, saved with Figma's File → Save local copy…. The live Figma file is the authority; see [figma/README.md](figma/README.md#the-figma-file) for when the copy was saved and how to re-save it. |

## Workflow

1. **Design and approval.** A design change reaches Figma only after the owner approves it. Where a round calls for a prototype, iterate on new screens and micro-interactions in the Claude design canvas with the owner until the round is approved. The real batch in the desk has no design round: it is built from the Figma components and the Storybook stories ([decision 10.101](../../process/decisions.md#area-10-harness-m3-18-october-2026)).
2. **After approval, every surface is updated in the same round** (see [design-system.md](design-system.md#keeping-every-surface-in-step)):
   - Figma: update the [Design System](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS/Design-System) file through the Figma integration, from the lowest layer the change touches, following [design-system.md](design-system.md). Re-save `design.fig` as [figma/README.md](figma/README.md#the-figma-file) describes.
   - Code: implement in `apps/neuve-web`. UI goes in `packages/ui`, validated in Storybook. Diff and margin behaviour goes in `packages/diffs`.
   - Canvas: bring every board that shows the changed part up to date, older rounds included.
   - Export: refresh `design-export/` from the published canvas.
3. **Back-port code-only fixes in the same round.** Bugs found in the running code are fixed in code, and the same round updates the Figma component (once the owner approves the change), the canvas boards that show it and the export.
