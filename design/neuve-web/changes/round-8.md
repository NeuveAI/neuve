# neuve-web design round 8: the batch overview says where the batch is

The round started on 2026-10-23, from the owner's review of the real batch once every human-required unit had a decision. Three things read as if nothing had happened: the lane bar and the strong "Open review desk" button, the briefing, and a Verification grid with no tie to its units or their decisions. The design is the board `Overview.dc.html` ("Current review batch — decision panel and units by lane, by state") on the Claude design canvas, kept privately; its `state` lever shows each state. The repo copy is in [design-export/](../design-export/). The directions were shown on a decision page with every state of each.

| Topic | Decision | Decided by |
|---|---|---|
| [The top of the page](#the-top-of-the-page) | B, the decision panel | Owner |
| [Verification and its units](#verification-and-its-units) | Y, verification inside the unit rows | Owner |
| [When the branch moves on](#when-the-branch-moves-on) | A notice above the title with "Start a review" | Design call, within [10.103](../../../process/decisions.md) |
| [Smaller calls](#smaller-calls) | Copy, phone layout, motion | Design calls |

## The top of the page

**Decision (owner, 2026-10-23): B.** One panel under the title holds the [human gate](../../../vocabulary.md#responsibility-and-review-flow).

| Part | Rule |
|---|---|
| Squares | One per human-required unit, in the batch's order: an outlined diamond on the requirement tint while it waits, its verdict (the review mark's check or cross) once a person decides it. Each opens its unit; its name says the title and the state, and a tooltip shows the title on real hover or focus. |
| Headline | Nothing decided: "4 need your judgment". Partly: "2 of 4 still need you". Nothing waits: the outcome, "2 changes requested · 2 approved", "All 4 approved" or "All 4 changes requested", the verdict icons leading. With no human-required units: "Nothing here needs your judgment". |
| Action | Dark while units wait: "Start review", then "Continue review" once one is decided ("Inspect assessments" while assessments are pending). Light once nothing waits: "Open review desk". |
| Lane split | While units wait, the lane bar stays below the hero. Once nothing waits, it leaves, and the panel's foot lists each lane's glyph, name and count. It stays a count, never a disposition ([Lane bar](../../../vocabulary.md#surfaces)). |
| Briefing | Open while units wait; folded into one "Briefing" disclosure once nothing waits. |

**Not chosen:** A, the same page with a quieter tone per state: a progress line under the title, a light button and a folded briefing, with the lane bar unchanged.

## Verification and its units

**Decision (owner, 2026-10-23): Y.** There is no separate grid of missing requirements. A "Units" section lists every unit under its lane, with the verification summary beside its heading.

| Part | Rule |
|---|---|
| Groups | "Needs your judgment" (open), "Decided" (closed while units wait, open once none do), then Human-suggested, Agentic review and Static automation (closed), each with its lane glyph and count. |
| Rows | Lane glyph and title (the whole row opens the unit), the review that stands (the 16px review mark: a person's on decided human-required work, the agent's on the agents' lanes unless a person's overrides it), the missing count, an arrow. |
| Missing count | "N missing" is a button above the row's link. It opens the unit's requirements under the row, their reason said once when they share it, and the actions: "Decide intent in unit" only while the unit waits on you, and "Request checks". |
| Needs your judgment | Keeps its table and columns; its Evidence cell is the missing count when the unit has missing requirements, else the evidence as before. On a phone the count sits under the title. |
| Verification | Keeps the evidence that exists (captures, tests, browser runs); each test or run names its unit with the lane glyph and title. It shows only when there is evidence. |

**Not chosen:** X, the same grid of missing cards, grouped by lane, each card carrying its lane glyph and review mark.

## When the branch moves on

When the branch points past the head the batch reviewed, a notice sits above the title: "New work on main since this review", the two heads, and "Start a review" as the one strong action. Past means the branch's head descends from the reviewed head: an unrelated branch, or a reset behind the review, is no new work. While that review runs, the notice says "Reviewing main". It never shows when the branch still points at the reviewed head, or when git can't say where the branch is.

## Smaller calls

- Copy uses the vocabulary's nouns and the screen's existing words; "Continue review" and "New work on … since this review" are new labels, not terms.
- Phone: the panel's two outcome counts stack and drop the separator; unit titles wrap rather than truncate; the batch title is 30px.
- Motion (tokens in `lib/motion.ts`): a square's verdict pops in on a live update (scale .96 → 1, snappy spring), never on first paint; a row's requirements drop in (detail 240ms, emphasized decelerate) and leave at once. Reduced motion: fades only (reduced 150ms).
- The "Decided" group component of the 23 October fix is folded into the unit rows.

## Surfaces

| Surface | State |
|---|---|
| Web app | `batch-overview/`: `decision-panel.tsx`, `unit-list.tsx`, `missing-requirements.tsx`, `new-work-notice.tsx`; the BFF lists every unit's lane and standing review |
| Storybook | Screens/Batch overview: Waiting, RowOpensRequirements, SomeDecided, AllApproved, AllDecided, BranchMoved, BranchMovedRunning, BranchUnmoved, AgentLanes, with dark and phone variants |
| Canvas | `Overview.dc.html`, with the `state` lever; `VerifyUnits.dc.html` is marked replaced |
| Design export | `Overview.dc.html`, `canvas.json` |
| Figma | The batch overview frames in the Design System file |
