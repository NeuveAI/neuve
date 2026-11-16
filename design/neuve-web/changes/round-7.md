# neuve-web design round 7: the delivery glyph joins the dock

The round started on 2026-10-17. It closes the open item from [round 6](round-6.md#open-items): what happens to the [review delivery](../../../vocabulary.md#surfaces) glyph once the unit title has scrolled away. The design is the board `DialScrolled.dc.html` ("Delivery dial after the title scrolls away") on the Claude design canvas, kept privately. The repo copy is in [design-export/](../design-export/).

| Topic | Decision | Decided by |
|---|---|---|
| [Where the glyph goes](#where-the-glyph-goes) | Option B: the [decision dock](../../../vocabulary.md#surfaces) | User |
| [The dock cell](#the-dock-cell) | The glyph lives in a cell that slides out from behind the dock's left edge. The dock's body never moves until the change is over, then the whole dock re-centres. | User |
| [Arrival and exit](#arrival-and-exit) | No travel between the title and the dock. The cell and the glyph take turns: the cell lands, then the glyph's bars grow in one by one, each fill following once its bar is 90% up. The way out is the reverse, at twice the speed. | User; values from the motion tokens |
| [The dial and the trigger](#the-dial-and-the-trigger) | Opened from the dock, the dial wears the dock. Both triggers get an open state that differs from rest and hover. | User |

## Where the glyph goes

The board showed three options, each as a desk you can scroll:
- A: the sticky file header;
- B: the decision dock;
- C: nowhere, so the reader scrolls back to the title.

**Decision (user, 2026-10-17).** The user chose **B**, "but add a motion to it so we can better track the change visually".

| Part | Rule |
|---|---|
| When it shows | Only while the unit title's glyph is out of view in the desk's scroll column (the board approximates this by the title's text). When the title comes back, the dock glyph leaves; the title glyph is never shown twice. |
| Glyph | The same four-tick glyph as the title (filled up to the stop, hollow after it), drawn in the dock's colours: `--nv-dock-muted` at rest; `--nv-dock-hover` fill and `--nv-dock-fg` on hover and keyboard focus. Its focus ring uses `--nv-focus-inverse`. Its accessible name and tooltip say the stop ("Review delivery: Briefed"). |
| Every stop | The dock keeps the glyph at every stop, Guided included, as long as the title is out of view. |
| Dock states | The glyph shows in the resting dock only. The composer and the decided states have no "Covers …" and keep their own layout (a design call in the code, accepted by its review). |
| Lanes | The glyph adds no decision, so the lane still decides the dock's actions ([round 4, rule 7](round-4.md#the-stops)). |
| Dismissal | The dial dismisses as the title's dial does ([round 6](round-6.md#dismissal)): a press outside, focus moving out, Escape (topmost layer first, focus back to the glyph) or the glyph again. Choosing a stop doesn't close it, unless the choice brings the title back into view (the row below). |
| Scrolling with a dial open | The board closes the open dial whose glyph leaves view. The spec for the code: when the title scrolls out with the title's dial open, that dial closes and focus moves to the dock glyph if focus was in the dial; when the title comes back with the dock's dial open, that dial closes and focus moves to the title glyph if focus was in the dial. Choosing Guided can bring the title back by removing the code, and closes the dock's dial the same way. |

**Not chosen:**
- A, because at Guided there is no code and so no file header to hold the glyph.
- C, because it costs a scroll every time.

## The dock cell

The user refined the dock's part in five steps on 2026-10-17, each on the live board:

| The user's direction | Result |
|---|---|
| "lets stagger the divider and the 'dial' entrance/exit. For the entrance, the dial is first, for the exit i is last (reversed)." | A divider after the glyph followed it in and left before it. Superseded by the third row. |
| "lets ensure that we 'freeze' placement to the right of the dock, the 'approve' cta gets cutoff on the exit and weirdly placed on the entry. Make it so the origin of the motion is the left part of the dock only" | The dock body stopped moving. The glyph moved into a cell that slides out from behind the dock's left edge. |
| "I see what you're doing there and I quite like, but in this. case the divider border is not useful anymore and we can also recenter the dock after the entrance and exit" | The divider went. The whole dock re-centres once the change is over. |
| "centralize the 'trigger' button" (the opening of the message quoted under [The dial and the trigger](#the-dial-and-the-trigger)) | The glyph was centred in the cell's measured width. |
| "the trigger is not centered on its 'dock cell' . At least not visually" | The glyph is centred on the cell as it reads, not as it is measured (below). |

The rules now:

| Part | Rule |
|---|---|
| Cell | A dock-coloured piece with the dock's 14px corner radius on all four corners. It sits beneath the dock body, with 14px tucked under the body's left edge. Where the body's rounded corners sit over it, a small notch separates the two; that notch is the only separator, so there is no divider. |
| Hidden | Translated right by its own width minus 14px, so it rests fully under the body. Its corners match the body's, so nothing peeks out. The glyph inside is not focusable, is `aria-hidden`, and is hidden after its exit. |
| Centring | The cell's right edge reads as the middle of the notch, half the corner radius (7px) past the body's edge. The glyph is centred between the cell's left edge and that point: 10px of space, the 32px glyph, then 3px to the body's edge plus the 7px to the notch. The cell's visible width is 2 × 10 + 32 − 7 = 45px. |
| Re-centring | While the glyph is in, the whole dock is translated right by half the cell's visible width, so the combined shape is centred in the column. When the glyph is gone, it translates back. The body itself never moves before the re-centre. |
| Shadow | The dock's shadow follows the combined shape. In the code, every dock state draws it as one drop-shadow filter (`--nv-dock-ring`, `--nv-dock-drop`), and the dock dial takes the bar's shadow. The Pen and Figma draw a ring plus a shadow, which is recorded in [figma/README.md](../figma/README.md). |

## Arrival and exit

**Decision (user, 2026-10-17).** The user rejected a first version in which the glyph travelled from the title to the dock: "It does not have to transition the element itself, we just have to add a motion as it appears on the dock so our eyes can better understand that new visual ownership". The version that came out of the refinements above was approved with "good".

**Refinements (user, 2026-10-18).** In that version the glyph grew in while the cell was still sliding, so the two read as one movement. The user asked, in three steps:
- "lets stager the 'expansion' of the 'appendix' for the dial and the dial entrance motion. I want to better distinguish better between the two visually as the bars animating are of great visual interest. Lets do the same on in reverse for the exit but with a faster tempo."
- "for the animation for the 'bars' lets instead of scaling the whole icon, we scale each bar in staggered with their fills staggered as they reach 90% of their height. The reverse can be 2x accelerated."
- "lets speed up the animation by about 15% for the bars / fill on the glyph"

The cell and the glyph now take turns, and the glyph itself never scales: each of its four bars grows from its base in turn, and a filled bar's fill rises once that bar has made 90% of its height. Bars chain as they do on the title glyph since [round 6](round-6.md): the next starts when the one before has made 85% (`SHARE.chainThreshold`). The 90% is a new token, `SHARE.fillStart`. The bars and fills then run at 0.85 of their tokens' durations and beats (`SHARE.dockBarPace`, read in the code as `BAR_PACE`), so about 15% quicker; the springs keep their shape. The re-centre comes last both ways, as the user asked in the refinements above. The values come from [`lib/motion.ts`](../../../apps/neuve-web/packages/ui/src/lib/motion.ts); n is the stop's filled bars, from 1 at Facts to 4 at Guided.

```
title scrolls out   the glyph arrives
  0ms     the cell slides out from behind the dock's left edge        TIMING.card, EASE.standard
  220ms   once it has landed, the first bar grows from its base,      TIMING.card; SPRING.snappy at BAR_PACE
          scaleY 0 → 1; the glyph itself never scales
  +108.375ms each  the next bar, when the one before has made 85%     DOCK_BAR_CHAIN: SHARE.chainThreshold
                                                                      at BAR_PACE
  +119ms  a filled bar's fill rises once its bar has made 90%         FILL_AT: SHARE.fillStart at BAR_PACE;
          of its height                                               SPRING.snappy; TIMING.hint fade
  220 + max(4 × 108.375, n × 108.375 + 119)ms   once the last bar     TIMING.card, EASE.standard
          and fill have made 85%, the whole dock re-centres (Briefed: 653.5ms)

title scrolls back  the same, last bar first, at twice the speed      TIMING.dockExit / TIMING.dockRise
  0ms     the last bar's fill falls (if filled), its bar shrinks      TIMING.dockExit at BAR_PACE (102ms),
          59.5ms later; each bar before it 54.19ms later              standard accelerate
  222.06ms  the glyph fades over the first bar's shrink               102ms, emphasized accelerate
  324.06ms  once the bars are down, the cell slides back              TIMING.cardExit, EASE.standard
  484.06ms  once it is back, the whole dock re-centres                TIMING.cardExit, EASE.standard

reduced motion      everything changes in one step
```

- Twice the speed is the dock's own exit-to-rise ratio (`TIMING.dockExit` 120ms against `TIMING.dockRise` 240ms). The beats between the bars and their fills are halved, and each fall runs over the exit token `dockExit` at `BAR_PACE`.
- At Briefed, the arrival takes 873.5ms, against 525ms before, and the exit 644ms, against 538ms before. Most of the added time goes to the bars, which the user called out as the part worth watching.
- `BAR_PACE` applies to the dock glyph's arrival and exit only. The title glyph's bars, and a stop change on either glyph, keep the round-6 chain.
- Motion is transform and opacity only. The bars grow from their base (transform-origin at the bottom).
- `SCALE.glyph`, the glyph's old .6 start scale added in `c3e0a634`, is gone with the scale.
- A quick reversal (the title back before a change ends) turns back from where things are and never replays: in the code, the CSS transitions start again with no beat, and the bars' exit runs turn back. On the board, the CSS transitions turn back but re-apply their delays, and the bars' rise and fall restart on every change. The board chains the bars every 125ms at the same pace (106.25ms), a rounding of the code's 127.5ms (108.375ms).

The 2026-10-17 version timed the glyph's arrival at `TIMING.card × SHARE.contentStart` (165ms) and the cell's return at `TIMING.hint × (1 − SHARE.morphStartOpacity)` (98ms). Both delays are gone, and with them the open item on whether to retime them to round 6's shares.

## The dial and the trigger

**Decision (user, 2026-10-17).** "centralize the 'trigger' button and make the options adopt the dock's visual identity for this mode. Also I've noticed that the trigger active style is the same as its idle and that should not be the case, this is both for the docked and 'standard' variants". The colours are a design call, shown to the user, who approved them with the rest.

| Part | Rule |
|---|---|
| Dial from the dock | The same dial as the title's, opening above the glyph, in the dock's colours: background `--nv-dock` with the dock shadow; the thumb on `--nv-dock-hover` with an inset 1px `--nv-dock-line` ring; stops in `--nv-dock-muted`, with hover and the selected stop in `--nv-dock-fg`; the stop focus ring in `--nv-focus-inverse`. Opened from the title, the dial keeps its surface look (`--nv-surface`). |
| Title trigger, open | `--nv-raised-2` fill, `--nv-ink` ticks and an inset 1px `--nv-line` ring; hollow ticks outlined in `--nv-ink-2`. Rest and hover are unchanged (hover is the `--nv-raised` fill). |
| Dock trigger, open | `--nv-dock-line` fill, `--nv-dock-fg` ticks and an inset 1px `--nv-dock-muted` ring. Hover is the `--nv-dock-hover` fill. |

## Open items

None. The retiming item closed with the refinements of 2026-10-18 ([Arrival and exit](#arrival-and-exit)). The bar pace, at first written in the code and the board, became the token `SHARE.dockBarPace` at the user's request the same day; the board reads it from `tokens.css`.

## Surfaces

| Surface | Status |
|---|---|
| Canvas | `DialScrolled.dc.html`, approved at version 1792266740-cdad; `tokens.css` republished at 1792276761-d96d. The 10-18 refinements: version 1792280304-fff9, with the `tokens.css` regenerated in `8b089cc8`; the pace token: version 1792306542-ac19, with `tokens.css` from `a966f42d` |
| Export | [design-export/](../design-export/): `5d1080d1`, `070b99cd`, and `tokens.css` in `c3e0a634`; the 10-18 board with the Pen's R7e (`500fccbd`), and `tokens.css` in `8b089cc8`; the board reading the pace token with the Pen's R7f, and `tokens.css` in `a966f42d` |
| Code and Storybook | `c3e0a634`, with 13 new plays; the 10-18 refinements in `8b089cc8`, with a new play for the bars' exit; the pace token in `a966f42d` |
| Pen | `0ece360d` (the first version), `f564329d` (the cell), `e2aaa4f8` (dark mode), `70f4a1a3` (the tooltip slot), `500fccbd` (R7e: the bars take turns, and the `fillStart` row); R7f (the `dockBarPace` row) with the pace token |
| Figma | `b4dfdb0c`, mirroring Pen R7d, with design.fig (kept in the private archive) re-saved; F8 mirrors R7e (`830f2985`, `.fig` in `311e352b`); F9 mirrors R7f (`share/dock-bar-pace`) |
