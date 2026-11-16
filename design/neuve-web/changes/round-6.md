# neuve-web design round 6: the delivery dial moves into the title

The round started on 2026-10-15, once round 5 had landed. The user marked two things on the review desk:
- the diff toolbar's meta, which should keep only the viewed count;
- the [review delivery](../../../vocabulary.md#surfaces) dial, always shown in its own row, which they called noise. They asked for a discreet dial that is toggled into view, merged into the title, with its first micro-interactions rethought: "Lets first explore on the canvas here".

The design is on the Claude design canvas, kept privately, mainly the new board `DialTitle.dc.html` ("Delivery dial in the title"). The repo copy is in [design-export/](../design-export/). The round also took on the accessibility and parity work that came up while every surface was brought in step.

Who decided what:
- **User** marks the user's own decisions. Their words are quoted where they were recorded.
- **Design call** marks a decision made on the design side, under the user's delegation of small design calls, and shown to the user.

| Topic | Decision | Decided by | Code |
|---|---|---|---|
| [Toolbar](#toolbar-only-the-viewed-count) | The meta is only "N/M viewed". The Split fallback status appears only when it applies. An unavailable Split stays focusable and says why. | User (meta); design call (status, Split) | e7501215, d6b436be |
| [Dial in the title](#the-delivery-dial-in-the-unit-title) | Option B: a four-tick glyph after the title opens the dial, beside the title or inline below it | User | e8bbb8a2, 295ba0f7 |
| [Dismissal](#dismissal) | The dial dismisses like any popover layer | User, correcting their own earlier rule | e8bbb8a2 |
| [Phased choreography](#phased-choreography) | Height first, once; contents after, slightly staggered; exits in reverse | User; values tuned on the canvas | 5001df06, 295ba0f7 |
| [Guided dock copy](#guided-dock-copy) | The lane's own verbs replace "Approve instead" and the related labels | User (the problem); design call (the wording) | 781d49df |
| [Accessibility and parity](#accessibility-and-parity) | Focus ring at 3:1, contrast and hit areas, lineage verdict marks, derived numbers, the story kit | Design calls and review findings | See the section |

## Toolbar: only the viewed count

**Decision (user, 2026-10-15).** Remove the toolbar meta "Split from 980px · 1 file · 1 hunk · 4 markers" and keep only the viewed count.
- **Meta.** Only "N/M viewed" remains.
- **Fallback status (design call).** "Split shows as stacked below 980px" is a message about the current state, not meta, so it stays. It appears only when the reader has chosen Split and the column has no room for it. It uses the muted ink (5.38:1). Its live region stays mounted, empty until the fallback applies, so screen readers announce it.
- **Unavailable Split (design call).** Split was a disabled button whose reason lived only in a `title`, so keyboard users skipped it without learning why. It is now `aria-disabled`: Tab and the arrow keys reach it, and the reason, "Split needs a column of 980px", shows in the shared tooltip on focus and hover. Choosing it is refused. Only its icon and label dim, so its focus ring keeps full strength (4.77:1 or better).
- **Toggles stay (design call).** The resolved and overlay toggles are controls, not meta.

**Landed:** code e7501215 (meta) and d6b436be (Split and the status); the canvas Main, Header, Split and Sticky boards in 8d510550; Pen a431a0f6.

## The delivery dial in the unit title

**Options.** `DialTitle.dc.html` showed three ways to keep the dial quiet until it is wanted (canvas commit ff071b5c):
- A: the stop as the eyebrow's last word, which the board recommended;
- B: a four-tick glyph after the title;
- C: a lead-in to the briefing.

**Decision (user, 2026-10-15).** The user chose **B**. They asked to "add a motion to the bars to ease the transitions" and to "be very careful with staggering motions for the content as it transitions between the modes". Later they asked for the bars to chain: each one starts when the previous one is 85% of the way. The always-shown dial row on the desk is gone.

| Part | Rule now |
|---|---|
| Glyph | Four ascending ticks on the title's last line. Ticks are filled up to the stop and hollow after it, so the stop reads by shape as well as tone. Its accessible name says the stop ("Review delivery: Briefed"), and a tooltip names it on hover and on keyboard focus. |
| Where it opens | Beside the title where there is room. This is the shadcn Popover, rendered in place, so Tab follows the page's order. Where there is no room it opens inline, in flow below the title, and pushes only what follows down, in one transform-only movement. It never covers the briefing, and it doesn't drift while the content below changes height. |
| Bars | A changing tick grows from its base or empties into it on the snappy spring. Ticks fill left to right and empty right to left. Each starts when the previous one has made 85% of its travel, about 125ms later. A tick in motion reverses from where it is. |
| Ticks in the dials | Ticks replace the stacked bars in the stops of the compact, large and popover dials. The mini dial on the settings language rows keeps labels only, and the code wins there. Below the `sm` breakpoint the compact and popover dials drop the glyph, as before. Hollow ticks and the "Follows default" outline reach 3:1. |
| Press | The glyph is a popup trigger, so it doesn't compress when pressed (design call). |
| Scrolled away | When the glyph scrolls out of its column, the floating dial hides with it. If focus was in the dial, the dial closes and focus returns to the glyph. |
| With a marker card open | One press on the glyph closes the card and opens the dial. |

This supersedes the compact dial's own row and the stacked-bar glyph in round 4's [dial anatomy](round-4.md#dial-anatomy).

**Landed:** canvas ff071b5c (the options), 78ac51f5 (B decided, bars eased) and 5a49075c (bars chained); code e8bbb8a2 (the component) and 295ba0f7 (wired into the desk); Pen a431a0f6; the canvas Delivery and Main boards in 8d510550.

## Dismissal

The rule changed once, at the user's direction:

| When (2026-10-15) | The user's direction | Result |
|---|---|---|
| After seeing content motion on the canvas | The dial must not close on its own. Only the glyph again, or Escape, folds it. | Canvas revision r16b (f0ae2837) |
| On the live r16b board | "dismissal needs to happen like any other component that has a separate visual layer, with clicking outside and with escape like the others, like it was before… within /shadcn-ui". "Otherwise we are looking good." | The dismissal below: canvas revision r16c (f1f3c081), the Delivery and Main boards (8d510550), code e8bbb8a2, Pen a431a0f6 |

The dial now dismisses like any popover layer:
- A press outside it, Escape, or focus moving out of it closes it.
- The glyph toggles it.
- Choosing a stop never closes it.
- Escape closes only the topmost layer, so it closes the dial before an open margin card. It returns focus to the glyph without showing the glyph's tooltip.
- The beside and inline placements follow the same rules.

## Phased choreography

**Decision (user, 2026-10-15).** In the user's words: "Height first (expand, contract), contents later and contents should also be slightly staggered. For outgoing elements it's the opposite steps that play first." After trying it on the canvas, the user found that per-layer heights made a "shutter" on swaps, a dip and then a rise. They asked for one height movement. They also suggested a DialKit jig to tune the values.

```
On a stop change, from lib/motion.ts.

leaving         leaving blocks fade out, last first                     TIMING.hint
height          the stack's height moves once, when the last leaving
                block is at 30% opacity (13ms before its fade ends)     SHARE.morphStartOpacity
                transform-only FLIP; height itself is never animated     EASE.standard over TIMING.card
arriving        arriving blocks fade in from 75% of that movement,      SHARE.contentStart
                27.5ms apart, each rising 2px, held at their final
                place so nothing shows past the stack
quick return    a change before the sequence ends reverses from where
                things are; a leaving fade never restarts
reader's line   the line the reader is on in the diff stays put
reduced motion  the height snaps once; leaving blocks fade where they were
glyph bars      each starts at 85% of the previous bar's travel           SHARE.chainThreshold
```

**Tokens.** The three shares are motion tokens: `SHARE` in [`lib/motion.ts`](../../../apps/neuve-web/packages/ui/src/lib/motion.ts), and `--nv-share-morph-start-opacity` (0.3), `--nv-share-content-start` (0.75) and `--nv-share-chain-threshold` (0.85) in the generated `tokens.css`, published to the canvas and the export.

**Retired.** The round-4 layered choreography is gone from the app's code (295ba0f7): `CARD_STAGGER`, `explainedLayer` and the delivery layer timings. The settings preview uses the same phased model. `lib/motion.ts` keeps, marked "canvas only", the round-4 delays that only boards still read: `deliveryLayer`, `deliveryGuided`, `deliveryChildren`, `deliveryNode`, `deliveryNodeStagger`, `deliveryMark`, `deliveryMarkStagger`, `deliveryVerdict` and `SCALE.mark`. Each is to be removed once no board reads it. Three stay in use in the code: `deliveryChildStagger` (the phased 27.5ms step is half of it), `deliveryExit` (the longest a leaving fade may run) and `deliveryExcerpt` (a Source pin's excerpt drops in at Guided). This supersedes round 4's [motion storyboard](round-4.md#motion-interface-craft-storyboard-neuve-motion-tokens) for the desk.

**Tuning and guards.** First, 5001df06 added the phased model as an opt-in, behind the default, with the "Jigs / Delivery choreography" DialKit jig in Storybook. `dialkit` is a devDependency, and a lint guard allows it only in stories. Then 295ba0f7 made the model the desk's only choreography. Plays added in 171ed96f and 6abbc9c4 fail without the fixes they guard: a leaving fade that restarts, an end snap in the settings preview, and the reader's line moving through a quick return.

**A canvas bug, fixed in canvas revision r16d (2138e0f1).** Under the real canvas runtime, the boards read their motion timing before `tokens.css` had applied:
- On `DialTitle.dc.html`, the height started about 82ms after a stop change, while the leaving block was still at 0.85–0.88 opacity. The design allows at most 0.30.
- On the Delivery and Main boards, the bars didn't chain, and the inline row folded with its stops still visible.

The boards now read their timing from the tokens live. The live board the user had approved ran the overlapped sequence, and the user was told so. They were also told that the corrected sequence would feel more stepped, and that the overlap could come back as a value if they preferred it. The canvas motion note and the Rules board's motion section describe the phased sequence from 469f8f9e.

**Landed:** canvas 5a49075c, f0ae2837, 2138e0f1 and 469f8f9e; code 5001df06, 295ba0f7, 171ed96f and 6abbc9c4; Pen a431a0f6 (its motion storyboard records one height move per stop change, phased contents and the 85% chain) and 06fb85d6 (the SHARE table, the canvas-only marks and the 27.5ms step).

## Guided dock copy

**Decision (2026-10-16).** The user found "Approve instead" weak. The Guided dock now offers the lane's own verbs, the same ones as every human-required [decision dock](../../../vocabulary.md#surfaces). The wording is a design call that was shown to the user.

| The suggested review | Round 4 | Now (the primary carries ⌘↵) |
|---|---|---|
| Requests changes | Approve instead · Edit message · Send request ⌘↵ | Approve · Edit request · **Request changes** |
| Approves | Request changes instead · Approve ⌘↵ | Request changes · **Approve** |

The primary sends the suggestion as yours. Each button keeps its recorded origin, so the states decided in round 4 still read "Approved · against the suggested review", and the composer is still tagged "from the suggested review". Round 4's rule 7 still holds: the lane decides the dock.

**Landed:** canvas Delivery board aef43073; code 781d49df; Pen 06fb85d6, which also gives the composer opened from a suggestion its "Send to implementer" action, as the code does.

## Accessibility and parity

**Focus, contrast and hit areas.**

| Change | Before | Now | Commit |
|---|---|---|---|
| Light focus ring | `#d2a62b`: 2.14:1 on paper, and as low as 1.52:1 on a selected deletion number | `#866400`, the same golden hue: 3.17:1 or better on every light surface. Dark is unchanged (5.09:1 or better). A contrast test covers every surface and fails on the old value. | 84479e7f |
| Ring on dark surfaces | The dock, the new-commit notice and the capture player stay dark in both themes; the ring sat at 2.6–3.2:1 on them | A documented `[data-surface="inverse"]` scope maps the ring to `--nv-focus-inverse` (`#e2ca5e`): 7.55:1 or better, in both themes. Peeks flip with the theme and hold nothing focusable, so they take no scope. | a760f99b |
| Buttons, toggles, badges, text fields | A half-opacity ring | The house 2px solid outline: on Buttons at a 2px offset (4.3:1 or better in light, 8.7:1 in dark), and 4.77:1 or better on toggles, badges and fields. The global focus rule also covers native input, select and summary. | a760f99b, 4d04ddeb |
| Faint desk text | Pin targets, the read-only status and pins, rail directories, the card's "vs", the graph tree prefix, the History quote and the sibling lock, at 2.5–3.0:1 | The muted ink, 4.75:1 or better. Pin targets take the pin's own ink on hover. | 4d04ddeb |
| Smaller fixes | The Find key hint, the dock's ⌘↵ hints at 70% opacity, the Viewed box edge, shared dots on filled pins, the thread's steps toggle | The Find hint in ink-2; the hints at full opacity; the Viewed edge at 3:1; shared dots at 75%; a hit area for the steps toggle that never covers Allow, Deny or the first step. Keyboard-opened tooltips appear at once, and a play pins that. | 4d04ddeb |
| Gap-row focus | Expanding a gap row fully removed the focused row, so focus fell to the page and the reader lost their place | Focus moves to the first revealed line's gutter cell, which becomes the gutter's one tab stop, or else to the line above. It never lands on the file's fold chevron. A partial expand keeps focus on the row. Keyboard expands show the ring and pointer expands don't. The user asked for this on 2026-10-16: "fix the gap rows". | 98c6fa69 |
| Source sheet focus | Escape or Back returned focus only to a floating card's trigger, so on the overview focus fell to the page | The sheet remembers what opened it and returns focus there. It falls back to the card's trigger when the opener is gone. | 2e7c70b1 |
| Source-sheet row marks | Text glyphs, read aloud next to their status word | Hidden from screen readers and drawn as icons from the product's icon language. The status word carries the meaning. | 0ebdcef6 |

**Lineage verdict marks (design call; the user delegated this call on 2026-10-15).** Earlier verdicts on a commit's lineage were tinted "you ✓" and "agent ✓" chips, and carried rows were dimmed by opacity to 3.78:1. Now each verdict is the 16px review mark with words ("You approved", "R1 requested changes"), from round 4's [review identity](round-4.md#review-identity-round-42). It is inert inside its row, and the row's name says the verdict once. A status that isn't a verdict, such as "Assessment pending", is muted mono with no mark. Carried rows use the muted text token (4.97:1 or better) instead of opacity. A viewer named "You" is labelled "You", never "You, You". Commit 15cb5d8f; a07df9a9 records who decided each earlier verdict.

**Derived batch numbers.** The overview said 24 units while its lanes summed to 26. The desk's human-gate meter said 2 where the batch has 4 human-required units. The lineage counts were written by hand. Now every count comes from one list of units, and an invariant test fails on any mismatch:
- 26 units, 4 need you, lanes 4/3/7/12, and the human-gate meter "1 of 4";
- the agents I1 9, I2 5, R1 7 and R2 3, each counted by role only (implemented for implementers, reviewed for reviewers);
- a static-automation unit names no implementer, so a comment there goes to no agent;
- a literal anchor pins these values, so derived checks can't drift together;
- the History "Regression" chip is neutral, because neutral marker kinds never take the decision colour;
- one reviewer identity (You, VD) runs through every fixture;
- a lineage entry without a review may carry a plain status but never claims a verdict.

Commits a07df9a9, 3efc4831 and 8edd79c0.

**Overview.**
- **Amber evidence.** Missing or failed evidence ("N gap", "Missing", "Invalidated") is amber, as the vocabulary's [marker kind](../../../vocabulary.md#context-elements) entry defines it. Magenta stays for decisions. Unresolved graph coverage and the source sheet's "no evidence" row are amber too.
- **Copy and layout.** Browser evidence reads "2 pages · 1 indexed artifact". The loading skeleton starts its content where the loaded page does.
- **Earlier fixes.** Counts are pluralised. The hero's briefing chips are icon-only, as on the desk in round 5. Pending assessments, Needs your judgment and Verification share one section heading.

Commits 2e7c70b1, a07df9a9, 0ebdcef6 and 3b54f927.

**Settings preview (design call).** The preview's mini suggested review is now the desk's plain card with the shared review mark, replacing the retired dashed card (e7501215).

**The story kit.** The user found too much drift between the canvas and Storybook, and asked for stories to reuse the app's compositions.
- **One kit.** Ten desk story files each rebuilt the desk, its store, frames and play helpers by hand. Now `story-kit/` owns these compositions: a fresh in-memory store per story, the desk at a unit and stop, settings providers, frames and play helpers (39addc03, 6bf9cee9).
- **A leak fixed.** File stories wrote comments to the browser's real `neuve.review-comments.v2` store, where they survived story switches and reloads (39addc03).
- **Focus checks.** One set of helpers checks focus rings. They fail loudly when the document has no focus, instead of passing without checking anything (f43f36e0, ac9a7575).
- **A canvas twin.** `DeskMainBoard` is the twin of the canvas Main board (f43f36e0).
- **Lint guards.** Lint fails when product code imports the story kit, by alias or relative path, including type imports and re-exports (8d1babff). The story-kit and DialKit guards apply in `apps/web` too (a41e87d5).

**Canvas parity.** Each set was reviewed, published, read back against its hashes, and mirrored into the export:

| Set | Boards | Commit | Canvas version |
|---|---|---|---|
| Overview, revision, identity and desk layers | Overview, Lanes, Cycle, Polish, Verdicts, Threads, Source, Disclosure (kept as round-1 history), Ranges, Margin, Markers | 10fd5e8e | 1792098680-7042 |
| Numbers and lineage marks | Overview, Lanes, Cycle, Polish; the inverse focus ring on the player, dock and notice | 863e6b3e | 1792100962-669a |
| The desk follows the picked unit | Lanes | 7573e2ad | 1792101758-67cd |
| Delivery and desk boards built from the app's fixtures | Delivery, DeliverySettings, DeliveryRules, Briefing, Main, Header, Split, Sticky | 8d510550 | 1792102434-b312 |
| Desk layers: numbers, the neutral History chip, a clean console | Threads, Source, Ranges, Margin, Markers | fbc6debc | 1792104151-eb66 |

Since r16d, every board loads with zero console errors.

## Landed

| Surface | Where |
|---|---|
| Code and Storybook | The toolbar in e7501215 and d6b436be. The dial in e8bbb8a2, 295ba0f7, 171ed96f and 6abbc9c4. Motion in 5001df06. The dock copy in 781d49df. Accessibility in 84479e7f, a760f99b, 4d04ddeb and 98c6fa69. Lineage and numbers in 15cb5d8f, a07df9a9, 3efc4831 and 8edd79c0. The overview in 2e7c70b1, 0ebdcef6 and 3b54f927. The story kit in 39addc03, 6bf9cee9, f43f36e0, ac9a7575, 8d1babff and a41e87d5. |
| Canvas | Versions 1792085933-2345 (the options), 1792088935-0a38 (B decided), 1792092514-3eaf (phased), 1792098378-5555 (r16b), 1792098680-7042, 1792099315-cca7 (`tokens.css`), 1792100962-669a, 1792101758-67cd, 1792102434-b312, 1792104035-3bdf (r16c), 1792104151-eb66, 1792110629-05b2 (r16d), 1792118678-847c (the phased notes and `--nv-share-*`), 1792130996-21be (the dock copy) |
| Pen | a431a0f6: the dial in the title, the ticks, the popover and inline dial, dismissal, the toolbar meta, the plain settings mini card, the motion storyboard, both focus colours, the lineage marks, the derived numbers, the neutral History chip, and the R6 changelog. 06fb85d6 (R6b): the Guided dock copy, including the composer's "Send to implementer"; the SHARE table (`--nv-share-*`) on the motion sheet, with the canvas-only timings marked; 27.5ms in the dial storyboard and the motion note, as in the code; the card-shadow variables on the settings preview miniatures; a new `paper-20` variable in place of an 18%-white literal on the open-pin count tile; four unused variables removed; and the changelog's R6 row with hash a431a0f6, plus an R6b row. 0c019e71 (R6c, from the Figma review's Pen backlog): the load-error details wrap inside their 420px slot, as the code's `pre` does; the judgment rows say "1 hunk"; the two dial rules move to the end of the Rules board as 11 and 12; the truncated judgment row's readers cell uses the code's target icon instead of circle-minus; 77 transparent `#00000000` fills are cleared to an empty fill list (the peek row, 12 node fills, 63 instance overrides and the Copy path button); the blast radius row loses its unused stroke; slot contents fill or hug their slot; the long and short skeleton rows become components instead of nested width overrides; the R6b changelog row names its Pen commit and no longer mentions a white binding; and 187 token-valued literals are bound (79 gaps, 94 paddings and 14 radii). ce7f3a31 (R6d): the 8 open chevrons that drew chevron-up now draw chevron-down turned 180°, as the code does (5 component icons in the sibling-owned row, generated diff, read-only neighbor, human-suggested Why and renewed lineage row, and 3 rail lane-row overrides on the human-suggested screens), so the icon sheet covers every icon the Pen draws; the skeleton row's code twin is `review-desk/diff-surface.tsx`; and the changelog's R6c row names its Pen commit, plus an R6d row. 438b1256 (R6e): the chevrons match their code sizes, 14px for the Why toggle in both review-card states (`size-3.5`, briefing.tsx) and 15px in all four lineage row states (`size-[15px]`, lineage-screen.tsx); the Why button is 2px wider, as in the code; and the changelog's R6d row names its Pen commit, plus an R6e row. 1cfa80d9 (R6f): the unavailable marker kind draws the code's `circle-dashed-x` from its 10 paths in `shared/marker-kind.tsx` at stroke 2.2, on the icon sheet card and on the 3 unavailable components (the pin, the card header and the icon-only citation chip), replacing a circle-dashed icon with a separate x icon on top; gap glyphs keep the plain circle-dashed, as the code does; and the changelog's R6e row names its Pen commit, plus an R6f row. 8d092c4a (R6g): the code draws `wrench` in one place, a thread card's open step list, beside each tool-call step (`thread-card.tsx`, 12px, the muted ink); a new "Working · Steps open" state lists the three fixture steps, a narration step marked with a dot and two tool steps with the wrench. The 8 thread-card states now follow their Storybook stories and the fixture: the messages are Maya Chen's comment, Implementer 1's reply and your follow-up on L22–23; a delivery line appears only for queued, sent and picked up, in the code's words ("Queued · reaches Implementer 1 when it's free", "Sent to Implementer 1", "Picked up by Implementer 1"), and the queued message is no longer dimmed; Working reads "Implementer 1 is working" over the "3 steps" toggle; Needs input shows the request, its detail, Allow once and Deny on the suggestion tint, then "2 steps"; Failed shows the reason and Retry; and Replied keeps the reply composer. The changelog's R6f row names its Pen commit, plus an R6g row. 86efee96 (R6h): the 9 thread cards now equal their Storybook card heights (290, 343, 328, 328, 366, 438, 467, 392 and 473px). Each name-and-time line takes the 20px avatar row, the header and the reply composer add the code's 1px border to their height, and delivery lines and commit chips use a 15px line height. The reply box uses `radius-lg` (10px), as `rounded-lg` renders. The changelog's R6g row names its Pen commit, plus an R6h row. 003a0812 (R6i): thread-card avatars sit where the code puts them (`MessageAvatar` centres the avatar in a 20px box, and `AgentAvatar` adds `-translate-y-[10%]`). The 13 agent avatars now sit in a 20px box, raised 2.16px, and the 17 person avatars' initials move up 1px; card heights and text positions are unchanged. The open thread in the "Thread open" pattern now renders at its master's 290px (its byline heights had stayed at 16), as does the inner-loop commit thread at 473px, and the pattern's stage grows 1px so nothing clips. The 30 byline and steps-toggle 4px paddings are bound to `space-4`. The changelog's R6h row names its Pen commit, plus an R6i row. |
| Export | Each canvas commit above mirrors its published version into [design-export/](../design-export/). `tokens.css` was also regenerated with 84479e7f, a760f99b and 295ba0f7. |

## Open items

- **A compact glyph in the sticky header or dock** for when the title has scrolled away. Decided on 2026-10-17: the dock. See [round 7](round-7.md).
- **Draft and transient pins over tinted rows.** Their muted ink measures 4.30–4.51:1 in light and 3.30–3.70:1 in dark (`neuve/shared/marker-kind.tsx`). This goes to the next contrast sweep.
- **The overview skeleton on phones.** At 375px the loading skeleton shifts 28px when the page loads, because the Verification summary wraps.
- **`overlay.stories.tsx` on the story kit.** Moving it onto the kit waits for another session's edits to that file.
- **Dynamic `import()`.** The story-kit and DialKit guards use `no-restricted-imports`, which can't see a dynamic `import()` of the kit. None exists today.
- **Story names for the dock.** The Storybook story exports `SendRequest`, `EditMessage` and `ApproveInstead` keep their old names so their ids stay stable. They will be renamed together with the Pen.
- **Records registration.** It was unavailable for the whole round: every round-6 commit records that the records service was down. The reviews that accepted each change are named only in the commit messages. They still need to be registered against these commits once Records is available.
