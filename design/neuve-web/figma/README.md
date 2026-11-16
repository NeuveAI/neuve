# neuve-web in Figma: transfer manifest

**Since 2026-10-23 the Figma file is the design system** and design.pen (kept in the private archive) is retired ([decision 10.105](../../../process/decisions.md#area-10-harness-m3-18-october-2026)). [design-system.md](../design-system.md) describes the file as it is now. This README and the manifest record the port from the Pen and what each round mirrored; the local-copy steps below still apply.

[`manifest.json`](manifest.json) is the plan for rebuilding the neuve-web design system in Figma. It describes the [Pen design system](../design-system.md#history-the-pen-rebuild) at round R7f (commit `81c40b22`, Pen SHA-256 `ec9101ea…`, which adds the dock glyph's bar pace token). R7e (commit `500fccbd`) retimed the dock glyph so its bars carry the arrival. R7d (commit `70f4a1a3`) showed the dock glyph's whole tooltip. R7c (commit `e2aaa4f8`) kept the dock cell one shape in dark mode. R7b (commit `f564329d`) drew the final round-7 dock cell, and R7 (commit `0ece360d`) put the delivery glyph in the dock once the title scrolls away. R6i (commit `003a0812`) placed the thread-card avatars as the code does. R6h (commit `86efee96`) matched the thread cards to the code, top to bottom. R6g (commit `8d092c4a`) added the Working steps toggle and the Working · Steps open component, and R6f (commit `1cfa80d9`) drew the Unavailable kind as one circle-dashed-x icon. R6e (commit `438b1256`) set the Why and lineage chevron sizes. R6d (commit `ce7f3a31`) replaced chevron-up with a rotated chevron-down and brought the icon sheet in line with the code. R6c (commit `0c019e71`) cleared the Pen backlog the Figma review found, and R6b (commit `06fb85d6`) had already updated the Guided dock copy and fixed the token gaps this transfer found. The Pen was read through the Pencil MCP and was not edited. Where the Pen and the code differ, the code wins. The code sources are [`globals.css`](../../../apps/neuve-web/packages/ui/src/styles/globals.css) for colour, shadow and radius, [`lib/motion.ts`](../../../apps/neuve-web/packages/ui/src/lib/motion.ts) for motion, and the generated [`tokens.css`](../design-export/tokens.css).

## The Figma file

**Status: built.** The plan in this manifest is built in the Figma file [Design System](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS) (file key `Ye2zTyk0LbcwufrAKv3HAS`). It was built through the Figma plugin API, and the Pen was read only through the Pencil MCP. The file has six pages:

| Page | Contents |
|---|---|
| Foundations | Specimen sheets for colour, spacing and radius, type and shadow, bound to the variables |
| Components | Atoms and components in one section per area, plus the 58 icon components |
| Patterns | 144 pattern components in one section per area: the Pen's 143 plus the Figma-only expanded Rail lane row variant |
| Screens | All 53 screens in five sections (Desk 32, Overview 8, Revision 3, Settings 3, States 7). The 3 dark screens set the Colour collection to Dark. |
| Motion and rules | The motion sheet and the rules boards |
| Changelog | The Pen rounds plus a Figma transfer entry |

The first review of the port asked for changes. Those fixes were applied on 2026-10-16:
- each variant now shows its own icon;
- the wrapper variants (Lane bar, Rail row Reviewed, Peek row Comment · Person) fill their width;
- the phone Refine by language head hugs its content;
- the Blast radius row has no border;
- the two screen-level Skeleton rows are instances again.

The second review asked for one more fix, which was applied on 2026-10-16. Every icon that is recoloured inside a variant or instance now has all of its strokes recoloured. Before this, only the first strokes were, so dark Open pins lost parts of their icon.

**R6c.** The file mirrors the Pen's R6c round:
- the truncated judgment row's readers cell uses `target` in ink-2;
- the Overview judgment rows say "1 hunk";
- the Rules board runs 01–12, with the two delivery-dial rules moved to 11 and 12;
- the load-error detail lines wrap inside the 420px slot;
- `Desk / Diff row` gains `Type=Skeleton · Long` (bar 340) and `Type=Skeleton · Short` (bar 180), which mirror the Pen components `xUxMY` and `bK8h0` and are used by the two skeleton rows in Desk · Files tab · stuck header.

The avatar id sizes stay literal.

**Round 4.** Changes applied on 2026-10-16:
- **Token bindings.** 330 token-valued gaps, paddings and radii on Components, Patterns and Screens are now bound to their Spacing and radius variables: 94 gaps, 222 paddings and 14 radii on 173 nodes. The values are unchanged, and the before and after screenshots of sample screens are pixel-identical. Off-scale values (for example 4.5, 7.5, 5 and 7) and the avatar id sizes stay literal.
- **Changelog.** The R6c entry now says what Figma did. The F entry says 465 components (464 from the Pen plus the Figma-only expanded lane row) and all 49 screens.
- **Language rows.** The `Settings / Language row` variants and the phone list keep their inner borders out of layout, as the Pen does, so each row matches the Pen height:
  - Touch rows are 150 and 178;
  - desktop rows are 54;
  - the phone settings screen came to 1768 tall. The remaining 1px was the 15px heading, which Figma's auto line height draws 20px tall where the Pen draws it 19px. The heading fix below brings the screen to 1767.
- **R6d chevrons.** Open toggles use `chevron-down` turned 180° instead of `chevron-up`, as the code does. This covers Sibling-owned row Expanded, Generated diff Open, Read-only neighbor Expanded, Review card Why open and Lineage row Renewed Open.
  - Figma can't rotate an icon inside an instance. The expanded Suggested lane row on three screens therefore uses a new variant, `Desk / Rail lane row` `Lane=Human-suggested, State=Expanded`.
  - No `chevron-up` instance remains, and the icon component is gone (see below).
  - The Figma-only lane-row variant is accepted as the way to handle Figma's rotation limit. The manifest lists it with `figmaOnly`, so Figma counts 465 components against the Pen's 464.
- **R6e chevron sizes** (Pen commit `438b1256`). The Review card Why chevron is 14px in both states, and the Why button stays 161 wide. The lineage row chevron is 15px in all four states: Renewed Open, Corrected, Regrouped and Carried forward.
- **R6f Unavailable icon** (Pen commit `1cfa80d9`). The Unavailable pin, the Unavailable card header and the Unavailable icon-only citation chip each draw one `Icon/circle-dashed-x`: stroke 2.2 in the 24 grid, at 12px, 12px and 11px, in `sug`. This replaces the dashed circle with an x on top. Gap and no-evidence keep the plain `circle-dashed`.
- **R6g thread-card steps** (Pen commit `8d092c4a`). Thread card Working gains a "3 steps" toggle. A new variant, `Status=Working · Steps open` (Pen `kyhrG`), turns the chevron 180° and lists a narration step and two wrench tool steps.
- **R6h thread cards** (Pen commit `86efee96`). All nine `Margin / Thread card` states are rebuilt from the Pen to match the code and Storybook:
  - the L22–23 fixture thread;
  - delivery lines only on Queued, Sent and Picked up;
  - Needs input with its permission panel;
  - Failed with a reason and Retry;
  - Replied with the composer;
  - the R6h rhythm: 20px bylines, 49px headers, 15px delivery and chip lines, and 9px composer top padding, with radius-lg on the composer text box and radius-md on Send.

  Inner borders stay out of layout, so the cards are 290, 343, 328, 328, 366, 438, 467, 392 and 473 tall, as in the Pen. Two text styles were added: `Mono/11.5/Regular · lh 16` and `Sans/12/Medium`.
- **R6i thread-card avatars** (Pen commit `003a0812`). These now sit as the code places them; the card heights are unchanged.
  - Agent avatars sit in a 20×20 `Avatar box` with no layout, at y −2.16. Clip content is off, because Figma clips frames by default and would cut the antenna. The avatar's ink top is about 8px above the name's: 7.7px in Figma, because of font metrics.
  - Person avatars take 2px of bottom padding, which raises the initials by 1px and leaves the bubble where it is.
  - The 30 token-equal paddings are bound to `space/space-4`: 27 Byline padding-bottom and 3 Steps trigger padding-top.
- **R7 delivery glyph in the dock** (Pen commits `0ece360d`, `f564329d` for R7b, `e2aaa4f8` for R7c, `70f4a1a3` for R7d, `500fccbd` for R7e and `81c40b22` for R7f):
  - **Title glyph set.** `Delivery / Title glyph` gains a `Place` property (Title or Dock) and five `Place=Dock` variants: Briefed Rest, Hover, Focus and Open, and Guided Rest. They draw the title glyph in dock colours:
    - `dock-muted` at rest;
    - a `dock-hover` fill with `dock-fg` ticks on hover, focus and open;
    - hollow ticks outlined in `dock-muted`;
    - a `focus-inverse` ring on focus;
    - all four ticks filled at Guided.
  - **Docks.** `Desk / Dock` Human-required Rest and Guided Request changes gain a hidden dock cell and a hidden dial slot, controlled by the set's `Show Delivery glyph` and `Show Delivery dial` properties, so existing screens keep their layout.
    - R7b removed the divider. The glyph sits in a 59×48 dock-coloured `Delivery glyph cell` at x −45, with a 14px radius and 10px left padding. The cell sits inside a clip frame that ends at x 7, so 45px shows left of the body and the notch is the only separator. Two clipped shadow copies sit above and below the body. Each is a `Cell shadow` rectangle placed wholly outside its 60×60 clip frame, so only its shadow shows; metadata reads therefore list those frames as empty. With the cell's own shadow they make one continuous shadow; without them the shadow steps 17 levels at x 7. The clip frames clip their content; the dock frame does not.
    - The five dock variants switch the cell on. The Open variant also fills the `Delivery dial` slot at −41, −46 with the new `Delivery / Dial` variant `Size=Popover · Dock` (Pen `gqx2A`), which wears the dock's colours and shadow.
    - Open states: the title glyph takes a `raised-2` fill, `ink` ticks, a `line` ring and `ink-2` hollow outlines; the dock glyph takes a `dock-line` fill, a `dock-muted` ring and `dock-fg` ticks.
    - Figma draws the dock's fill and shadow on a `Dock body` rectangle in these two docks. An unclipped Figma frame counts its clip-frame children in its own shadow, which left a gap under the body, and drops the ring. The ring now shows on the 35 instances of these two docks, as it does in the Pen. The glyph cell clips its content for the same reason, so its ring draws too; its children sit inside it.
    - R7c: `Specimens · dark theme` joins Patterns · Desk in Dark mode, with the dock at rest and open. At 4× in Figma the body has no seam and the shadow is continuous.
    - R7d: a hidden `Delivery glyph tooltip` slot outside the cell's clip holds the name tooltip "Review delivery: Briefed", controlled by `Show Delivery tooltip`. The hover and focus dock variants turn it on and hide the glyph's own tooltip, which the clip cut to "Review delivery:". It sits centred over the glyph and 6px above it, at −95, −22: Figma's tooltip is 152 wide against the Pen's 151, so −95 keeps the centre where the Pen's −94.5 puts it.
    - The five `Place=Dock` glyph variants sit on a dock-coloured strip in the Title glyph section, as the Pen's dock specimens do.
  - **Screen.** The new screen `Desk · scrolled · delivery glyph in the dock` follows the stuck-header desk, which makes 50 screens. Its dock re-centres 22.5px right of centre.
  - **Rules and storyboard.** Rule 13 and the dock-glyph storyboard with its notes are word for word. R7e (F8) retimed all three: the glyph no longer scales, its bars grow in turn with each fill following at 90%, the bars and fills run at a 0.85 pace, and the exit runs at twice the speed.
  - **Motion tokens.** R7e adds `share/fill-start` (0.9, `var(--nv-share-fill-start)`) to the Motion collection and a `fill-start` row to the SHARE table. R7f (F9) adds `share/dock-bar-pace` (0.85, `var(--nv-share-dock-bar-pace)`) and its row, so the table lists 5 variables, and the storyboard names it.
- **Border and heading drift.** These now match the Pen:
  - The expanded lane row chevron is `ink/faint` again.
  - The desktop `Languages` slot and the Review card Why buttons keep their inner borders out of layout. The list is 216, the Why buttons are 161, and the desktop Refine by language component is 333, so its screen instance no longer cuts it off.
  - The "Refine by language" heading has a fixed 19px text box on desktop and phone, matching the Pen's rendered height, so the head is 61 and the phone screen is 1767.
  - The Overview skeleton's first lane keeps its literal 10px outer radius, as in the Pen.

Figma's Icons section follows the Pen's R6d icon sheet: 57 Lucide icons plus the code's custom `circle-dashed-x`, 58 icon components in all. `chevron-up` and `circle-minus` were removed after their instance counts reached 0, and `wrench` was added. Later rounds added `contrast`, `clock-alert` and `chevron-up` again. The Reviews round (2026-10-25) added `chevron-left`, `ellipsis` and `clock`, which brings the section to 65 icon components. `ellipsis` draws its three dots as filled 4px circles, since a stroked 2px circle doesn't render at icon size.

**The local copy.** ../design.fig (kept in the private archive) is a dated snapshot of that Figma file, saved with Figma's **File → Save local copy…**. The live Figma file is the authority; the `.fig` is a binary convenience copy for review and offline reading. The stored snapshot has `exported_at` `2026-10-28T20:51:59.724Z` in its embedded `meta.json`. It is 1,958,058 bytes, with SHA-256 `5973a3f3d274ea282c86b7a7eb8f0001dfa6348c8bd898377846f7c2738cf9a9`. These values identify the stored snapshot. They do not establish parity with the latest live Figma file.

**Refreshing it.**
1. Open the Figma file in the Figma desktop app.
2. Choose **File → Save local copy…** and save over `design/neuve-web/design.fig`.
3. Update the date, size and hash in the paragraph above.

Re-save after every change to the Figma file that should be reviewed.

**Deliberate choices in the file:**
- **Non-breaking spaces.** Code tokens and trailing spaces in text layers (for example `const ` in the diff slots, or `then returns ErrIndexBusy ` in the briefings) use U+00A0 where the Pen uses U+0020. This keeps the token runs together the way the Pen draws them. Text copied out of Dev Mode carries the non-breaking spaces.
- **Shadow part variables.** The numeric and colour parts of each shadow (`shadow/shadow-card-y`, `-blur`, `-ring`, `-drop`, and the `-color` parts of `shadow-peek` and `shadow-stuck`) have their own WEB code syntax, for example `var(--nv-shadow-card-y)`. Those names exist only in Figma. The code ships each shadow as one composite variable, such as `--nv-shadow-card`, and the effect styles carry that composite.
- **Detached bases.** Four component bases stay detached, because Figma can't override nested sizes or layout direction on an instance:
  - `Delivery / Dial` Compact and Mini touch;
  - `Overview / Lane bar` Static empty;
  - `Settings / Refine by language` Phone.

  Each one says so in its component description.
- **Plain frames in screens.** Where a Pen screen replaces the children of a slot, the Figma screen draws that part as plain frames, not as an instance. This covers the Code cells of split rows, the Delivery glyph in briefing headers, and one peek card.

## Counts

| | Pen | Figma plan |
|---|---|---|
| Components | 476 at R7f, as at R7d (34 atoms, 296 components, 143 patterns, 3 screen components) | 477 variants: 74 component sets and 36 single components, including the Figma-only Rail lane row Expanded variant, plus 58 icon components matching the Pen's R6d icon sheet (57 Lucide icons and the custom circle-dashed-x) |
| Variables | 215 | 341 in 4 collections. Every Pen variable maps to exactly one Figma variable. The extra 126 come from the code: 18 shadcn semantic aliases and 108 motion tokens. |
| Instance refs | 2,116 at R7f, as at R7d | Rebuilt as instances |
| Text styles | Type variables, plus a type-scale sheet of 22 roles | 97 styles, one for each distinct type combination the Pen uses (two added for the R6h thread cards). The 22 sheet roles are tagged. |
| Effect styles | 5 shadow token sets, plus the Pen-only `shadow-seg` | 6 styles, using the code's layers (ring and spread included) |
| Screens | 50 at R7f, as at R7d, including 3 dark-theme instances | 50, with 14 marked `key` to build first |

## Structure of the manifest

- **`collections`**: these become Figma variable collections.
  - `Colour` has a Light and a Dark mode. It is grouped by role: surface, ink, line, status, diff, syntax, `lane/req`, `lane/sug`, `lane/agt`, `lane/sta`, accent, focus, range, dock, read-only, peek, overlay, player, shadow and semantic. The theme-dependent shadow numbers live here too, so a single mode switch flips a whole screen.
  - `Spacing and radius`, `Type` and `Motion` each have one mode.
  - Every variable records its Pen name, its code token, its CSS variable (`codeSyntax.WEB`), its Tailwind name and its source. Aliases are marked with `aliasOf`.
- **`textStyles`**: each style has family, weight, size, line height, tracking and text case, plus the variables it binds to, how often it is used, and example components.
- **`effectStyles`**: the code's shadow layers with variable bindings. `darkResolved` gives the values the Dark mode should render.
- **`componentSets`**: each set is named `<Area> / <Component>` and lists its variant properties. Each variant carries:
  - its Pen id and name;
  - its size;
  - the variables it uses and the components nested inside it;
  - its code twin and story;
  - `mapping` notes wherever the translation isn't one to one.
- **`pages`**: Foundations, Components (atoms first), Patterns, Screens, Motion and rules, and Changelog. Each page lists the Pen frames it comes from.
- **`screens`**: every screen, with its size, mode, how it is built, how many instances it uses and its main components.
- **`mismatches`**: every difference found between the Pen and the code.

## What won't map one to one

| Pen construct | Where | Figma approach |
|---|---|---|
| Three-layer rows stacked with a -24 gap: background, then the engaged or selected ring, then the content | 17 diff-row variants (`Engaged`, `Selected`, `Engaged · landed`) | Build them without auto layout, keeping the order background, ring, content, so the code text draws above the outline. |
| A variant that is an instance of another component with overrides (the root is a `ref`) | 88 variants | Build the variant around that instance and its overrides, so changes to the base still propagate. |
| A ring drawn as an outer stroke, because Pen shadows can't spread | Cards, docks, dial thumbs | Use the ring layer of the effect style. Don't add the stroke as well. **Exception:** Figma drops the ring layer's spread on a frame whose clip is off. The two dock bases with the glyph cell draw their fill and shadow on a `Dock body` rectangle, and the cell clips its content, so both draw the ring. Every other unclipped frame with a ringed shadow style draws no ring, unlike the Pen: about a hundred in all, namely 56 with `shadow/card` (cards, the popover dials, `Agents / Popover`, comment previews), 20 dial thumbs with `shadow/thumb`, and 27 with `shadow/dock` (the 15 other `Desk / Dock` variants, `Revision / New-commit notice` and the dock dial among them). Fixing them is an open item for a later round. |
| Slot frames for data content: diff code, dials, rows | 31 components | Use an instance-swap property or a slot, with a placeholder. |
| Dashed strokes drawn as generated paths | 37 components | Use native dashed strokes. |
| Hidden layers | 60 components | Use boolean properties wherever the code toggles the layer. |
| A family split across two layers | `States / Skeleton` (atom block and page skeletons) and `Margin / Comment preview` | Make one set per layer. |
| Line-height ratio `leading-text-sm` (20/14), applied to several sizes | 42 texts | Figma line-height variables are in pixels, so the resolved pixel value is stored as a literal on each style. |
| Easing curves | Motion | Stored as `cubic-bezier()` strings, because variables have no curve type. |

## Pen versus code

The colour, radius and motion values all match apart from the items below. The generated `tokens.css` matches `globals.css` exactly.

1. **`--nv-shadow-stuck` colour.** The Pen uses `#1C1A1624` in light and `#00000073` in dark. The code uses rgba .22 in light and .7 in dark, with a -10px spread. Because the Pen can't spread a shadow, it draws a lighter drop instead. Figma takes the code values.
2. **Two literal values, kept on purpose:**
   - a 17px line height on the 13px titles of `Margin / Thread card`;
   - `#FFFFFF` for the Viewed check, which matches the code's `text-white`.
3. **Pen-only tokens.** `shadow-seg`, `player-fg-92`, `player-fg-25` and `paper-20` mirror literals or opacity modifiers in the code (`paper-20` is the code's `bg-paper/20` on the open-pin count tile).
4. **The dock's shadow in the round-7 code (`c3e0a634`).** The round-7 code draws `drop-shadow(0 0 0.5px var(--nv-dock-ring)) drop-shadow(0 16px 40px var(--nv-dock-drop))` on every dock state, with two new tokens: `--nv-dock-ring` (`rgba(28,26,22,.16)` light, `rgba(255,255,255,.16)` dark) and `--nv-dock-drop` (.2 light, .6 dark).
   - The filter shadows the combined body-and-cell shape once. Its ring is a blurred 16% halo, not the 1px spread at 8% of `shadow-dock-ring`.
   - The dial opened from the dock takes the bar's shadow in code. In the Pen and Figma it carries `shadow/dock` directly.
   - Neither the Pen nor Figma has `dock-ring` or `dock-drop`, and Figma can't draw a CSS filter. `shadow/dock` keeps the box-shadow numbers; the `Dock body`, the cell and its shadow copies approximate the one silhouette.
   - Because the code rings every dock state, the 15 ring-less dock variants differ from the code as well as the Pen. The manifest records this as a `code-shadow` mismatch.

Round R6b closed the other gaps that phase 1 found; they are listed under `resolvedInR6b`:
- the motion sheet gained its SHARE table and canvas-only marks;
- the dial storyboard gives the 27.5ms step;
- the shadows on the settings preview miniatures are bound to variables;
- the count tile uses `paper-20`;
- the four unused variables were removed.

Round R6c cleared the Pen backlog that the Figma review found; it is listed under `resolvedInR6c`.

**Round 8 (2026-10-23).** The batch overview says where the batch is ([round-8.md](../changes/round-8.md)). A new section, Patterns · Overview state (round 8), holds the Gate cell, Decision panel, Review action, Lane counts, Unit group, Unit row, Missing toggle, Missing requirements and New work notice. Overview / Hero is a set (Briefing=Open|Folded, Show New work). The Judgment table gains Conflict · Missing and Neutral · Missing, and its gap evidence reads `sug-fg` as the code does. The review mark gains Agent · Reviewer, Requested changes, 16, Words. Test cards name their unit. The five overview screens move to Units by lane with evidence-only Verification, and three screens are new: partly decided, all decided, branch moved.

## Regenerating

The manifest was built with a scratch script from four sources:
- Pencil MCP reads: `GetVariables`, a walk over every component, and the screen and board frames;
- the code token files listed above.

The Pen no longer changes, so the manifest is a record of the port and is not regenerated.
