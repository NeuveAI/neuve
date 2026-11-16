# neuve-web design handover

Written on 2026-10-17, at the end of the design work that ran from 2026-10-03 to 2026-10-17. It is for whoever picks up the Neuve web review UI next, person or agent. It gathers four things in one place:
- what was built and where each part lives;
- the user's editing directions and notes, in their own words;
- the design ethos those directions add up to;
- the working rules and the open items.

**Since 2026-10-23 the Pen is retired.** The design system lives in the [Figma file](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS/Design-System), and a design change reaches it only after the owner approves it ([decision 10.105](../../process/decisions.md#area-10-harness-m3-18-october-2026)). The rules below are updated for that; the dated status, history and directions still describe the Pen as it was.

Details stay in the documents this one links to. Terms follow [vocabulary.md](../../vocabulary.md#review-interface); where a word is still a proposal, this document says so.

## Start here

The design lives on five surfaces, and the [five-surface rule](design-system.md#keeping-every-surface-in-step) covers all of them. A visual, token or motion change is finished only when it has landed in each of these places, or each is marked not applicable with a reason:
- Figma;
- Storybook;
- the web app;
- every canvas board it appears on, older rounds included;
- the design export.

Until 2026-10-23 the Pen held the design system and Figma mirrored it, outside the five-surface rule. Since then Figma takes the Pen's place in the rule.

| Surface | Where | What it is the authority for |
|---|---|---|
| Claude design canvas | Neuve Web — Review UI, kept privately | New design. Every round starts here and is approved here. |
| Web app | [`apps/neuve-web/apps/web`](../../apps/neuve-web/apps/web), with sample data on `/mock` | How the product runs. Colour comes through [`globals.css`](../../apps/neuve-web/packages/ui/src/styles/globals.css), and motion values from [`lib/motion.ts`](../../apps/neuve-web/packages/ui/src/lib/motion.ts). |
| Storybook | [`apps/neuve-web/packages/ui`](../../apps/neuve-web/packages/ui) | Behaviour: every state, with plays for keyboard and pointer. |
| Pen (retired) | design.pen (kept in the private archive) | Nothing since 2026-10-23. Kept as a record and no longer edited. |
| Design export | [`design-export/`](design-export/) | The repo copy of the canvas: its `.dc.html` boards, `canvas.json` and `tokens.css`. |
| Figma design system | The [Figma file](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS), structured as [design-system.md](design-system.md) describes, with its local copy `design.fig` (kept in the private archive) and the [port notes](figma/README.md) | The component library: foundations, atoms, components, patterns, screens and rules. Edit it through the Figma integration, after the owner approves the change. The live Figma file is the authority; `design.fig` is a dated snapshot. |

Where they stand on 2026-10-18:

| Surface | Version |
|---|---|
| Pen | R7f, commit `81c40b22` (`design.pen` SHA-256 `ec9101ea…`): 476 components and 215 variables. R7f added the `dockBarPace` row; R7e, `500fccbd`, retimed the dock glyph's storyboard and added the `fillStart` row; R7d, `70f4a1a3`, had 0 broken references in its independent review |
| Figma | Mirrors Pen R7f (F9), with design.fig (kept in the private archive) re-saved on 10-18 (SHA-256 `554fe033…`). It has 477 components: the Pen's 476 plus one Figma-only variant, explained under [Guidelines](#figma). It also has 341 variables, 97 text styles, 58 icons and 50 screens. |
| Canvas and export | Canvas version 1792306542-ac19: the round-7 board approved at 1792266740-cdad, refined on 10-18 (the bars take turns, at the `dockBarPace` token), plus the `tokens.css` regenerated in `a966f42d`. Mirrored in export commits `5d1080d1`, `070b99cd`, `c3e0a634`, `8b089cc8`, `500fccbd`, `a966f42d` and `81c40b22`. |
| Code | Round 7 in `c3e0a634` and its 10-18 refinements in `8b089cc8` and `a966f42d` ([round 7](changes/round-7.md#surfaces)), on top of `3f588458`. That is round 6 ([landed](changes/round-6.md#landed)), plus two sets of 10-16 commits: dock focus (`7037b9bf`, `5ef81ac7`) and keyboard line selection with commentable lines (`09e880c5`, `bea5d98b`, `5fa1ba94`). On 10-17, `3f588458` removed Start a review from the live pages until M5, which now show empty states. The canvas and the Pen still draw it. |

## The design ethos

These principles come from the user's directions across six rounds. Each row gives the principle, what it means in practice, and the words it came from. Quotes keep the user's words; obvious typos are corrected.

| Principle | In practice | The user's words |
|---|---|---|
| **Less is more** | Every element must carry information the reader acts on. Cut repeated terms, captions and meta. Consolidate rather than add. | "Less is more and we need to filter information to the minimum needed to convey the next actions needed." (10-03) · "we don't need terms repeated 4 times on screen...consolidation is key." (10-14) |
| **No self-describing copy** | No provenance lines or captions that narrate the mechanism, such as "Prepared by the harness", "Built from the graph…" or "From the context margin". Use the source's own words, such as a ticket's "Done when", and the [vocabulary](../../vocabulary.md) nouns. Conclusions like "2 of 3 not done" are computed from the data. | "this 'prepared by the harness....' thing has to go from all places" · "same for those slop descriptions" (10-14) |
| **Show, don't tell** | Prefer a visual to an explanation, in the UI and in how work is presented for a decision. | "Show, do not tell and remember /interface-craft" (10-03) |
| **Context stays out of the code until asked** | Context sits in the [context margin](../../vocabulary.md#surfaces) and opens in [disclosure layers](../../vocabulary.md#context-elements), L0 pin to L3 source sheet. The code never moves. | "surrounding context can work similarly to how Notion does comments, we hint that there's more information … and use UI to disclose within the layers" (10-03) |
| **Distinct identities, not more options** | Clarity comes from one consistent identity per kind. Human and agent differ by a single, consistent avatar identity, not by a growing set of visual treatments. | "clarity and consistency walk hand-in-hand...less is always more but distinct identities is what matters." (10-14) |
| **Never assume the reader** | No inference of anyone's proficiency or preferences. The [review delivery](../../vocabulary.md#surfaces) stop comes only from the workspace setting or from the reader moving the dial. | Canvas comments on round 4 (10-13 and 10-14), recorded in [round 4](changes/round-4.md#user-decisions-canvas-comments-2026-10-13-and-14) |
| **Layers behave like layers** | An open layer isolates what is beneath it, so hovers and other controls don't bleed through. Every separate visual layer dismisses the same way: a press outside, Escape (topmost layer first) or the trigger again. Use shadcn primitives for it. | "We should disable the other options / isolate the inline option opened in a higher layer to prevent this mess." (10-03) · "the dismissal needs to happen like any other component that has a separate visual layer, with clicking outside and with 'escape' like the others" (10-15) |
| **Hover is real hover** | A hint shows only on real pointer hover or on keyboard focus-visible, and goes away when the pointer leaves. | "we should treat hover as a proper hover state, the comment is still showing despite the mouse not hovering the 'tag'" (10-03) |
| **One connection, one treatment** | Anything that links to code (a citation chip, a marker pin, a briefing link) hovers and lands the same way, so the eye connects context to its lines. | "Lets consolidate the hover and active behavior to get the same treatment as the hover and active from the citation as it make the connection clearer" (10-15) |
| **Motion explains change** | Motion is purposeful, spring-first and phased: one movement for height, then contents, slightly staggered, with exits in reverse. It must never read as a "shutter" or show two states at once. Reduced motion is mandatory. | "Height first (expand, contract), contents later and contents should also be slightly staggered. For outgoing elements it's the opposite steps that play first" (10-15) · "I want a single movement to scale up or down to accommodate the new content" (10-15) |
| **Quiet until wanted** | Controls the reader rarely needs stay discreet and are toggled into view. For example, the delivery dial is a four-tick glyph in the unit title rather than a permanent row. | "the delivery dial being always shown is a bit of a waste and noise. maybe we need something that is more discrete at first and then toggled into view" (10-15) |
| **Read-only reads as read-only** | Read-only units use a more muted palette, and still come with their surrounding context. | "the read-only design needs to be clearer visually that is read-only with a more muted color palette" (10-03) |
| **Flat and calm** | No gradients, and no coloured edge rails to signal state. Use a tone shift, a full focus ring for keyboard, or a label. | Standing rules since round 2 ([round-2.md](changes/round-2.md#rules-that-still-apply)) |
| **Best-in-class diff** | The diff is the heart of the desk. It builds on Pierre's diff work (our fork lives in `apps/neuve-web/packages/diffs`), with GitHub-grade affordances such as sticky file headers and drag-to-select line ranges. | "At heart I want us to use best in class code diff visualization" (10-03) · "there's no way to do line ranges...clicking and dragging similar to github" (10-03) |

## Guidelines

### Visual and interaction

- **Tokens.** Colour, type, spacing, radius, shadow and motion come from the tokens: [`globals.css`](../../apps/neuve-web/packages/ui/src/styles/globals.css), [`lib/motion.ts`](../../apps/neuve-web/packages/ui/src/lib/motion.ts) and the generated `tokens.css`. Figma binds to the same names. Literals are exceptions, each written down: the two deliberate literals and the four Pen-only tokens in [Pen versus code](figma/README.md#pen-versus-code), and the off-scale values and avatar id sizes in the [Figma file notes](figma/README.md#the-figma-file). The unbound 2px avatar padding is an [open item](#open-items).
- **Flat.** No gradients, and no coloured edge rails for state.
- **Light and dark, light by default.** Dark is the same screen with the dark theme on, never a separate drawing.
- **Contrast.** Text meets WCAG 1.4.3 and non-text marks (focus rings, hollow ticks, the "Follows default" outline) meet 1.4.11 at 3:1. Colour is never the only signal.
- **Marker identity.** Pins, previews, cards, source sheets and citation chips follow [context-markers.md](context-markers.md). Colour is reserved for kinds that ask something of the reader: magenta when a decision is needed, amber when evidence is missing or failed. A dashed edge marks transient context or unsaved work.
- **Review identity.** Identity is who, so each actor has one avatar, never altered by placement or state.
  - **People** are a chat bubble.
  - **Agents** are a rounded square in their role tint, with an antenna and a dashed outer edge. When a ring appears around an agent's comment pin, the antenna rises to clear it. A resolved agent comment drops the ring and keeps only the dashed edge.
  - **State** sits beside the avatar, never on it.

  The full identity is in [round 4.2](changes/round-4.md#review-identity-round-42).
- **Motion.** Motion uses `motion/react` with the neuve-motion springs, and transform and opacity only, never blur. On a stop change:
  - the height moves once;
  - contents follow 27.5ms apart;
  - exits play in reverse;
  - a quick return reverses from where things are;
  - the glyph's bars chain at 85% of the previous bar's travel.

  Values and storyboard: [round 6](changes/round-6.md#phased-choreography).
- **Copy.** Use vocabulary nouns. In UI copy a disposition is a *review*, and the harness's prepared one is a *suggested review*. The delivery stop names (Facts, Briefed, Explained, Guided) are still proposed: use them in copy and code, but don't add them to the vocabulary without approval.
- **Product rules from the rounds.**
  - Agree reads as your approval ([round 3](changes/round-3.md#shell-and-smaller-refinements)).
  - The lane decides the dock.
  - Guided never shows code.
  - A unit's language is provider data, never a shipped list ([round 4](changes/round-4.md)).

### Code

Paths here are relative to `apps/neuve-web`.
- **Skills.** For UI and motion work, load `/interface-craft`, `/interface-design-guardrails` and `/neuve-motion`. Use `/shadcn-ui` primitives for layers, popovers and tooltips. Load `modern-web-guidance` for any web task. Put the same instructions in every brief to an agent doing UI work.
- **State.** No `useState`; use jotai. `useEffect` only where React's "You Might Not Need an Effect" justifies it, with a `// Effect:` comment.
- **Bun** as package manager and runtime, with the global 10-day minimum release age. Exceptions need the user's approval.
- **Storybook** validates every state. Fixtures live in `packages/ui/src/fixtures`. Stories reuse the shared compositions in `packages/ui/src/neuve/story-kit` instead of rebuilding layouts. Plays exercise keyboard and pointer paths, including focus rings.
- **Scope.** UI work stays in the frontend and the BFF (`apps/web/src`) unless the user widens it.

### Figma

- **The lowest layer first.** Fix the atom or component, and the screens follow through their instances. Screens hold instances only. A detached copy is a defect unless a note gives the reason ([design-system.md](design-system.md#keeping-every-surface-in-step)).
- **The code wins** where Figma and the code differ, for both shape and motion. The limits Figma can't match are listed in [design-system.md](design-system.md#what-figma-cant-match).
- **One Figma-only variant**: `Desk / Rail lane row` with `Lane=Human-suggested, State=Expanded`. It exists because Figma won't rotate an icon inside an instance. Figma's other deliberate choices are listed in [figma/README.md](figma/README.md).
- **Never publish or share** the Figma library, and never touch other Figma files. This is a working rule of the Figma track; ask the user before changing it.

## How we work

| Step | Who | Gate |
|---|---|---|
| Prototype on the canvas | Design, with the user | The user approves the round |
| Update Figma, the code and Storybook | Parallel tracks | The owner approves a design change before it reaches Figma. Each change gets an independent review of its exact source |
| Bring the canvas boards and the export up to date | Design | Parity on every board that shows the change |
| Re-save `design.fig` | The Figma track | After each reviewed Figma change. An independent review of the live file and of the saved copy. |

1. **Prototype on the canvas** with the user until the round is approved. The real batch's work (M5) has no design round ([10.101](../../process/decisions.md#area-10-harness-m3-18-october-2026)): it builds from Figma and Storybook, and the owner uses the canvas only when they ask to explore.
   - Fixes found in running code can be made in code first. Carry them back to Figma (once the owner approves), the canvas and the export in the same round.
   - Ship each of the user's tuning iterations to the live canvas on its own review, never bundled with parity work.
2. **Supervise in parallel tracks.**
   - Give each track disjoint file ownership in the shared checkout (no worktrees).
   - Keep a record at `apps/neuve-web/.scratchpad/<round>/scratchpad.txt`, plus one `agent-<name>.txt` per agent.
   - Write the round's catalogue (`changes/round-N.md`) before dispatching.
3. **Review before commit.**
   - Freeze each change as a patch, or as a frozen copy of the `.fig`, with its SHA-256.
   - An independent reviewer applies the [adversarial review standard](../../process/adversarial-review-standard.md) to that exact source.
   - Then stage only your own hunks, commit with no attribution trailer, and name the accepted hashes in the message.
4. **Ask with pictures.**
   - When the user has more than one or two calls to make, publish a decision page in product terms, with real screenshots, a recommended option and a copy-answers box.
   - The user delegates small calls, such as a highlight treatment or an interaction detail. Decide those with accessibility and design best practice, record them in the round doc, and show the result.
5. **Commit when ready.**
   - Once a change is verified and accepted, commit it straight away; uncommitted work in the shared checkout gets tangled with other sessions'.
   - After committing, tell any peer session that shares those files that HEAD moved.
   - Never revert shared files in place.

**Saving the local Figma copy.**
- **`design.fig`.** This needs screen control, or the user saves it.
  1. In Figma, choose File → Save local copy….
  2. Name it `design.fig`, save it into `design/neuve-web/` and confirm Replace.
  3. Update the local-copy paragraph in [figma/README.md](figma/README.md) with the date, size and hash.

## What we built

| When | Round | What changed | Record |
|---|---|---|---|
| 10-03 | 1 | The review desk and batch overview designed from scratch: the context margin, the decision dock, the unit rail, comments with line-range selection, empty and loading states, the `/mock` route | git history; [design-export/](design-export/) |
| 10-03 | 2 | Stacked and split views; per-unit decisions for the human-suggested, agentic and static-automation lanes; read-only neighbors with their own context; the Units/Files tabs; the agents control; agent threads and events; the new-commit notice; the collapsible rail | [round-2.md](changes/round-2.md) |
| 10-06 | 3 | Refinements: the sticky file header, the contextual marker identity (one pin per line, named by kind), the margin and shell details | [round-3.md](changes/round-3.md), [context-markers.md](context-markers.md) |
| 10-13 to 10-14 | 4 | [Review delivery](../../vocabulary.md#surfaces): a four-stop dial, the settings page and the suggested review at Guided. Round 4.2 added the human and agent review identity. | [round-4.md](changes/round-4.md) |
| 10-14 to 10-15 | — | The Pen rebuilt into a design system: tokens from the code, one component per concept, screens built from instances, round boards folded into Rules | [design-system.md](design-system.md) |
| 10-15 | 5 | Briefing descriptive links, icon-only chips in the briefing, one hover and landing for every line reference, engaged pins that keep their lines lit | [round-5.md](changes/round-5.md) |
| 10-15 to 10-16 | 6 | The delivery dial moves into the unit title. Also: popover dismissal, the phased choreography, a toolbar that keeps only "N/M viewed", a Guided dock that uses the lane's own verbs, and accessibility and parity sweeps. | [round-6.md](changes/round-6.md) |
| 10-16 to 10-17 | Pen R6–R6i | The Pen brought up to the code, step by step:<br>• R6: round 6 (the dial in the title, dismissal, focus colours, lineage marks)<br>• R6b: the Guided dock copy, the SHARE motion table and the Figma-prep token fixes<br>• R6c: the backlog from the Figma review, including 187 token bindings<br>• R6d–R6i: icons and chevrons drawn as the code draws them; the unavailable marker and all nine thread-card states matched to the code and Storybook | [round-6.md](changes/round-6.md#landed), the Pen's changelog frame |
| 10-17 to 10-18 | 7 | The delivery glyph joins the decision dock once the title scrolls away: a cell slides out from behind the dock's left edge, the glyph's bars grow in one by one with their fills, and the dock re-centres; the dial from the dock wears the dock, and both triggers gain a distinct open state | [round-7.md](changes/round-7.md) |
| 10-16 to 10-17 | Figma port | The whole Pen ported to Figma (variables, styles, icons, components, patterns, all 49 screens) and reviewed in three rounds (`34abbea0`). Four more reviewed rounds then kept it in step with Pen R6c–R6i. | [figma/README.md](figma/README.md) |

## The user's editing directions

This is a log, by theme, of the directions the user gave in conversation, each with its date. Directions given through canvas comments and decision pages are recorded in the round documents, listed after the log. Quotes keep the user's words; obvious typos are corrected.

**Review desk and context**
- 10-03: "directionally good, context setting as an opener with the relevant citation inline and the different contextual and AI 'prefilled' disposition notes added to aid reviews". Fix the z-axis and rethink the comment form.
- 10-03: line comments were "a horrible UI … The line as a dropdown??? … no way to do line ranges". This led to click-and-drag ranges, like GitHub's.
- 10-03: resolved comments can be hidden, with "view resolved comments", "but lets reduce noise". The collapsed comment needs something better.
- 10-03: "if a signal/marker is connected to more than one unit / hunk we need to find a better way to signal that. That footnote crowds". Use tooltips to expand a path on hover. Fix clipping, and never introduce horizontal scrolling in the margin.
- 10-03: "read-only units should also come with its surrounding context". The units/files header is too crowded, and the source view needs glanceable information and links to external editors.
- 10-03: more than two agents (one implementer, one reviewer) can work on a branch, so comments have threads and event-based micro-interactions.
- 10-06: a refinement, not a redesign. Make the file name sticky "similar to how GH does". On the margin pins, "one per line, named by kind... is really good", and this should be "a proper consolidated identity with rules and base elements".
- 10-15: when a chip opened from the context margin is active, the code needs a visual signal: "I cannot connect visually the context to the part of the code it relates to when the chip is active".

**Batch overview**
- 10-03: the lane bar's descriptions should show on hover, aligned to each section, not spread on a grid. The page had "too much text noise". Drop "since your review of cycle 1" and "suggested for you". Keep the advisory briefing, and give verification more prominence.
- 10-03: the back link must read clearly as a back link, as a higher-hierarchy element.
- 10-03: the empty state gets a call to start a new review, in a better tone than "start a new review now!".
- 10-03: the view transition from the batch overview to the review desk "is awful … there's no common element". It needed a different motion concept, more stagger, and never both views visible at once.

**Review delivery and the dial**
- 10-13: "People are now doing more work on languages, frameworks and things that they don't fully understand", so some clients need "a dial to tune the 'delivery' of the review facts and pre generated dispositions … To lean more on digests, diagrams and the dispositions pre-generated or less". Motion should showcase how the review looks at each stop.
- 10-14: copy from a product perspective: "we did a poor job at the 'Against <ticket> . Definition of done'".
- 10-15: the toolbar meta was "redundant and bad visual noise...lets keep just the 0/x viewed".
- 10-15: the dial always shown is noise; make it discreet, toggled into view and merged into the title. The user chose option B, with eased bars, and asked to "be very careful with staggering motions".
- 10-15: bars chain: "the next bar start animating only when the previous bar is at its last 15%".
- 10-15: "too much motion now … between the two initial phase there's kinda like an 'shutter effect' … I want a single movement".
- 10-15: dismiss like any separate layer, using shadcn.
- 10-16: "I'm not sure I like 'approve instead' copy...we can do better". The dock now uses the lane's own verbs.

**Identity**
- 10-14: there were "about 4 different visual identities for the 'avatar' distinction". The human is a chat bubble "for the more organic feel"; the agent adds "a little 'antenna'".
- 10-14: the antenna needs a thinner rod, slightly taller, scaling consistently across sizes. The dashed border sits outside and must not clash with the antenna. Later: "the ring was fine as it was on the human version … the antenna expands with a 'motion' to accommodate the ring". A resolved agent comment goes back to the dashed line.

**Process and consistency**
- 10-03: prototype on the canvas first; after approval, update the Pen, the code (with Storybook) and the export.
- 10-03: "use /modern-web-guidance always when doing web work".
- 10-06: product-facing asks with screenshots, "a great way to gather feedback from me".
- 10-14: "ensure that the full extent of our updates is applied at the design system level in .pen, in storybook, in the web app and in our canvas here and the exported version for all pages … I also want our motion primitives properly consolidated in all those places."
- 10-14: name and organise the Pen's layers properly. "the .pen should be a proper design system … we can't scale on ad-hoc design" ([design-system.md](design-system.md)).
- 10-15: "I delegate this decision to you as it is too small a scope to matter. Use best accessibility and design practices."
- 10-15: work in parallel tracks, with stories reusing shared compositions, and keep the user's fine-tuning lane first.
- 10-15: "as soon as you have it ready you should commit".
- 10-16: port the design system to Figma and save it next to the `.pen` ("I want a full port"), then keep both in step through cleanup rounds.

**Where the other notes are.** These directions were given on the canvas, on decision pages or as short replies to a proposal, and are recorded with the rounds:

| Source | Recorded in |
|---|---|
| Round-3 decision page: the header's shed order, grey gap ranges, Agree reads as approval | [round-3.md](changes/round-3.md) |
| Round-4 canvas comments: never assume the reader, no label beside the dial, Guided shows no code | [round-4.md](changes/round-4.md#user-decisions-canvas-comments-2026-10-13-and-14) |
| Round 4.2: Option A for human-suggested units, the S2 scope fallback | [round-4.md](changes/round-4.md#review-identity-round-42) |
| Pen design system calls | [design-system.md](design-system.md) |
| Scope is always gathered (a reply on 10-14), and the wording for changes with no linked ticket or doc ("Unlinked", from the Pen design system calls page) | [round-4.md](changes/round-4.md#scope-is-always-gathered) |
| Motion calls: Done when marks on the snappy spring, layers leave together over 200ms | [design-system.md, rule 6](design-system.md#keeping-every-surface-in-step) |
| Round-5 choices (replies on 10-15): descriptive links, icon-only chips in the briefing | [round-5.md](changes/round-5.md#decision) |
| Round-6 dial choices (replies on 10-15): option B, bars chained | [round-6.md](changes/round-6.md#the-delivery-dial-in-the-unit-title) |
| Round-7 choices (10-17, on the live board): option B, the in-place arrival, the frozen dock body, the cell from the left, no divider, the re-centre, the dial in the dock's colours, the open states | [round-7.md](changes/round-7.md) |
| Round-7 refinements (10-18): the cell and the glyph take turns; the bars grow one by one, each fill at 90% of its bar, instead of the glyph scaling; the exit at twice the speed; the bars and fills about 15% quicker, as the token `SHARE.dockBarPace` | [round-7.md](changes/round-7.md#arrival-and-exit) |

## Open items

| Item | Where | Who decides |
|---|---|---|
| Start a review is hidden in the app until M5, while the canvas and the Pen still show it | Batch overview empty state | The user |
| Draft and transient pins over tinted rows measure 3.30–4.51:1 | `apps/neuve-web/packages/ui/src/neuve/shared/marker-kind.tsx` | The next contrast sweep |
| The overview's loading skeleton shifts 28px on load at 375px | Batch overview | Design call |
| Dock story exports keep old names (`ApproveInstead` and others) so their ids stay stable | Storybook and Figma | Rename them together |
| `overlay.stories.tsx` is not on the story kit yet | Storybook | After the other session's edits to it land |
| The story-kit lint guard can't see a dynamic `import()` | Lint | If one ever appears |
| Canvas-only round-4 motion tokens (`deliveryLayer` and the others) stay in `lib/motion.ts` | Code and canvas | Remove each once no board reads it |
| Dotted term underlines in the diff are deferred | `apps/neuve-web/packages/diffs` | A later round |
| A review sent from a suggestion must record that it started from it | Backend and harness | The harness track |
| Gathered scope ([round 4](changes/round-4.md#scope-is-always-gathered)) and descriptive phrases with targets ([round 5](changes/round-5.md#what-the-generator-has-to-emit)) must be emitted | Harness | The harness track |
| The Pen's R7f changelog row says "this step" instead of `81c40b22` | The Pen's changelog frame | No one: the Pen is retired |
| Some Figma motion variable descriptions and the SHARE table's morph-start-opacity row show a literal `&#39;` for an apostrophe, a leftover of the port's generator; `share/fill-start` follows its siblings | Figma | A later Figma round |
| Figma drops the 1px ring on frames that don't clip: about a hundred cards, popovers, dial thumbs and docks (56 with `shadow/card`, 20 thumbs, 27 with `shadow/dock`). Only the two round-7 dock bases draw it, through their Dock body layer and the clipped glyph cell ([figma/README.md](figma/README.md)) | Figma | A later Figma round |
| The Guided dock has the round-7 cell's clip but no tooltip slot; nothing is cut today, but a future Guided hover or focus variant needs the slot | Figma | The next change to that dock |
| Two Pen threads pin their byline height to 20 as an override instead of inheriting it, so they won't follow a later master change: the open thread in the "Thread open" pattern, and the inner-loop commit thread in the New-commit notice spec | Pen | No one: the Pen is retired |
| The 2px person-avatar padding equals the `space-2` token but isn't bound | Figma thread cards | The next Figma change |
| The reviews that accepted the round-6 and round-7 commits, Pen and Figma included, are named only in the commit messages; Records was unavailable throughout | Records | The Records track |

The mock route's hydration fix (`0d4a9588`) was removed on 2026-10-17 by `3f588458`, which deleted the old ledger package it worked around. Checked afterwards on 2026-10-17: `/mock`, a review unit, `/mock/settings` and `/mock/changes/b71e5aa` load and respond with no console errors, and the title dial opens and closes on Escape.
