# neuve-web design system

The design system lives in the Figma file [Design System](https://www.figma.com/design/Ye2zTyk0LbcwufrAKv3HAS/Design-System). It is edited through the Figma integration, and a design change reaches Figma only after the owner approves it. The owner set this on 2026-10-23 in [decision 10.105](../../process/decisions.md#area-10-harness-m3-18-october-2026), which retired design.pen (kept in the private archive).

**How it got here.** Until then the design system was the Pen, design.pen (kept in the private archive). The owner approved its structure, the naming scheme, how the round boards are folded in and which screens it holds on 2026-10-14, in the Pen design system calls, kept privately. The calls followed the owner's note that day: "the .pen should be a proper design system, components, rules, atoms and so on… we can't scale on ad-hoc design". The Pen was rebuilt in that shape ([history](#history-the-pen-rebuild)) and ported to Figma on 2026-10-16, keeping its layers, names and code twins; the [port notes](figma/README.md) record how. `design.pen` stays in the private archive as a record and is no longer edited.

Some details here are working rules rather than decisions: the sizes, the override limits, the code-twin descriptions and what commit messages name. They can change without a new call, and the owner is told when they do.

Paths below are relative to `apps/neuve-web/packages/ui/src/`.

## Working in the file

- **Approval first.** A change reaches Figma only after the owner approves it.
- **Through the Figma integration.** Load the `figma:figma-use` skill before any `use_figma` call, and read the file before changing it.
- **The code wins** where Figma and the code differ, for shape and for motion.
- **Never publish or share** the Figma library, and never touch other Figma files. This is a working rule of the Figma track; ask the owner before changing it.
- **The local copy.** design.fig (kept in the private archive) is a dated snapshot, re-saved after each reviewed change as [the port notes](figma/README.md#the-figma-file) describe. The live file is the authority.

## Pages and layers

Foundations, Atoms, Components, Patterns, Screens and Rules are the layers. In Figma they sit on six pages: Foundations; Components, which holds the atoms first, then the icons and the components, one section per area; Patterns; Screens; Motion and rules; and Changelog, with one entry per round.

| Layer | What lives there | Examples | Rule |
|---|---|---|---|
| **Foundations** | Variables in four collections (Colour with Light and Dark modes, Spacing and radius, Type, Motion), text styles and effect styles, with specimen sheets on the Foundations page. The motion sheet, generated from the Motion collection, mirrors `lib/motion.ts` | `ink`, `raised-2`, `req`, `agt-tint`, `line-strong`, `focus`, `shadow-thumb` | Names and values as in `styles/globals.css` and `lib/motion.ts`; each variable carries its CSS variable as its code syntax. The code is the source, and Figma follows it. No raw colours, sizes or fonts anywhere else, apart from the literals a component's description notes. |
| **Atoms** | The smallest pieces with their own identity, in the "Atoms · area" sections of the Components page | Person avatar, agent avatar, marker-kind icon, verdict icon, delivery ticks, status mark (fill or ring), focus ring, divider | One component each, with variants for size and state. Placement never changes identity. |
| **Components** | Atoms composed into reusable parts | Review mark, delivery dial (compact, large, mini, each with a touch size), marker pin, comment pin, citation chip, evidence pin row, criterion row, segmented control, dock button | Built only from atoms. Variants for state and size, not copies. |
| **Patterns** | Larger, recognisable blocks | Review card, basis card (Done when, Scope, Gathered scope), flow card, terms card, decision dock (per lane), rail row, margin column, settings language row, settings preview | Built only from components. A block that varies by lane or basis is a variant or property, not a new drawing. Content that comes from data, such as diff code, sits in a slot. |
| **Screens** | One screen per delivery stop and surface, in one section per area: Desk, Overview, Revision, Settings, States, Reviews | Desk at Facts, Briefed, Explained and Guided; settings at 1440 and on a phone; batch overview; lineage; error and empty states; the Reviews page at 1440 and on a phone | **Instances only.** Overrides may change text and data, never shape or colour. Dark is the same screen with the Colour collection set to Dark. Other states are component variants on their sheets; Storybook covers how screens behave. |
| **Rules** | Guidance and flows, on the Motion and rules page | Identity, placement and state; dial anatomy and motion; delivery stops; comment steps; desk flows; copy rules | Short and built from instances. Each rule board names the layer sections it governs. |

## Naming

Names follow `<Area> / <Component> / <Variant> / <State>`, with size as a trailing segment where a component has sizes. Theme is never a segment: dark is the theme switch. In Figma the last segments are variant properties, such as `State=Rest, Other units=true`.

The area names where the code lives. A Figma component should lead to its code twin through its area, and a part keeps its name when it moves up a layer. Where one family has a set on two layers, Figma adds the layer to the name, as in `States / Skeleton · Atom` and `States / Skeleton · Component`. The table covers every component folder; `review-comments/` holds data and stories only, so it has no area.

| Area | Code | Examples |
|---|---|---|
| Identity | `neuve/shared/person-avatar.tsx`, `neuve/agents/agent-avatar.tsx`, `neuve/shared/review-mark.tsx` | `Identity / Avatar / Agent · Reviewer / 20`, `Identity / Review mark / Agent / Approved` |
| Agents | `neuve/agents/agents-control.tsx` | `Agents / Control / Open`, `Agents / Row / Connecting` |
| Desk | `neuve/review-desk/*` apart from the margin and delivery files | `Desk / Dock / Human-required / Rest`, `Desk / Diff row / Add`, `Desk / Rail row / Reviewed` |
| Margin | `neuve/review-desk/{context-margin,thread-card,source-sheet,floating,history-source,reference-parts}.tsx`, `neuve/shared/marker-kind.tsx` | `Margin / Pin / Source / Hover`, `Margin / Comment pin / Agent / Open` |
| Delivery | `neuve/shared/delivery-dial.tsx`, `neuve/review-desk/delivery/*` | `Delivery / Dial / Compact / Briefed`, `Delivery / Basis card / Gathered`, `Delivery / Flow node / Fails` |
| Overview | `neuve/batch-overview/*` | `Overview / Lane bar / Pointing · Agentic review` |
| Revision | `neuve/cycle/*` | `Revision / New-commit notice`, `Revision / Lineage row / Approved` |
| Settings | `neuve/settings/*` | `Settings / Language row / Refined / Selected` |
| States | `neuve/states/*` | `States / Skeleton / Desk`, `States / Empty / No units` |
| Reviews | `neuve/reviews/*` | `Reviews / Row / Phone`, `Reviews / Gate square / Waiting · Human-suggested` |
| Shared | the rest of `neuve/shared/*`: app header, brand mark, logo, nav link, theme toggle, disclosure, segmented, lane glyph; and `components/pagination.tsx` | `Shared / Top bar / Review desk`, `Shared / Disclosure / Open`, `Shared / Lane glyph / Human-required` |

Only `/` separates segments; `·` joins words inside one segment. A name never records history, behaviour notes or sample content. History goes in the Changelog page, behaviour in the component description, and content in properties.

## Code twins

Every Atom, Component and Pattern names its code twin and Storybook story in its component description: the file under `apps/neuve-web/packages/ui/src` and the story id. A component with no code twin says so and gives the reason. The table has one row per component family, read from the Figma file on 2026-10-24, with the Reviews families added on 2026-10-25; paths are relative to `apps/neuve-web/packages/ui/src`, and a family with more stories lists the first three. The variant counts include one variant that exists only in Figma: `Desk / Rail lane row` with `Lane=Human-suggested, State=Expanded`, because Figma can't rotate an icon inside an instance.

| Layer | Component | Variants | Code twin | Story | Status |
|---|---|---|---|---|---|
| Atoms | Identity / Avatar | 9 | `neuve/shared/person-avatar.tsx`, `neuve/agents/agent-avatar.tsx` | `shared-review-identity--avatars` | twin |
| Atoms | Delivery / Ticks | 2 | `neuve/shared/delivery-dial.tsx` | `shared-delivery-dial--ticks`, `shared-delivery-dial--all-sizes` | twin |
| Atoms | Delivery / Criterion mark | 4 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided` | twin |
| Atoms | Delivery / Scope mark | 3 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided-scope` | twin |
| Atoms | Delivery / Line chip | 2 | `neuve/review-desk/delivery/flow-card.tsx` | `screens-review-desk-delivery--explained` | twin |
| Atoms | Delivery / Flow node | 3 | `neuve/review-desk/delivery/flow-card.tsx` | `screens-review-desk-delivery--explained` | twin |
| Atoms | Delivery / Flow edge | 1 | `neuve/review-desk/delivery/flow-card.tsx` | `screens-review-desk-delivery--explained` | twin |
| Atoms | Delivery / Term chip | 1 | `neuve/review-desk/delivery/terms-card.tsx`, `neuve/review-desk/delivery/explained-prose.tsx` | `screens-review-desk-delivery--explained`, `screens-real-packet-briefing--joined-explained` | twin |
| Atoms | States / Skeleton · Atom | 1 | `components/skeleton.tsx` | `primitives-skeleton--breathing` | twin |
| Atoms | Shared / Lane glyph | 5 | `neuve/shared/lane-glyph.tsx` | `shared--lane-glyphs` | twin |
| Atoms | Shared / Brand | 2 | `neuve/shared/logo.tsx`, `neuve/shared/brand-mark.tsx` | `shared--brand` | twin |
| Atoms | Shared / Icon card | 1 | none | `foundations-icons--imported` | no code twin: a sheet card for the Lucide icon inventory |
| Components | Identity / Review mark | 16 | `neuve/shared/review-mark.tsx` | `shared-review-identity--review-marks`, `screens-review-desk-delivery--guided`, `screens-review-desk-delivery--guided-suggests-approve` … | twin |
| Components | Identity / Provenance tooltip | 1 | `neuve/shared/review-mark.tsx` | `shared-review-identity--provenance-on-focus` | twin |
| Components | Agents / Control | 2 | `neuve/agents/agents-control.tsx` | `agents-agents-control--rest`, `agents-agents-control--open` | twin |
| Components | Agents / More avatar | 1 | `neuve/agents/agents-control.tsx` | `agents-agents-control--rest` | twin |
| Components | Agents / Row | 3 | `neuve/agents/agents-control.tsx` | `agents-agents-control--open`, `agents-agents-control--connecting` | twin |
| Components | Agents / Popover | 1 | `neuve/agents/agents-control.tsx` | `agents-agents-control--open` | twin |
| Components | Desk / Phrase link | 4 | `neuve/review-desk/briefing.tsx` | `screens-review-desk-briefing-links--phrase-links`, `screens-review-desk-briefing-links--phrase-hover-lights`, `screens-review-desk-briefing-links--phrase-keyboard` | twin |
| Components | Desk / Rail tabs | 2 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail`, `review-desk-chrome--rail-files-tab` | twin |
| Components | Desk / Wrap toggle | 2 | `neuve/review-desk/diff-file.tsx` | `screens-review-desk--layout-and-wrap-toggles`, `screens-review-desk--wrap-off` | twin |
| Components | Desk / Resolved toggle | 2 | `neuve/review-desk/review-desk-screen.tsx` | `review-desk-overlay-annotations--resolved-hidden`, `review-desk-overlay-annotations--resolved-shown` | twin |
| Components | Desk / Overlay toggle | 3 | `neuve/review-desk/review-desk-screen.tsx` | `screens-review-desk--context-card-open`, `screens-review-desk--show-comments-previews`, `screens-review-desk--rest` | twin |
| Components | Desk / Diff toolbar | 2 | `neuve/review-desk/review-desk-screen.tsx` | `screens-review-desk--rest`, `screens-review-desk--split-wrap-off` | twin |
| Components | Desk / Diff row | 33 | `neuve/review-desk/diff-file.tsx`, `lib/diffs.ts` | `screens-review-desk--rest`, `screens-review-desk-briefing-links--engaged-list-pinned`, `screens-review-desk-briefing-links--engaged-card-same-from-chip` … | twin |
| Components | Desk / Hunk header | 1 | `neuve/review-desk/diff-file.tsx` | `review-desk-diff-file--sticky-headers` | twin |
| Components | Desk / Split row | 6 | `neuve/review-desk/diff-file.tsx` | `screens-review-desk--split`, `screens-review-desk--card-follows-wrap-and-split` | twin |
| Components | Shared / Segmented | 7 | `neuve/shared/segmented.tsx` | `review-desk-diff-file--owned-ranges`, `review-desk-diff-file--whole-file`, `review-desk-diff-file--narrow-headers` … | twin |
| Components | Desk / File header | 7 | `neuve/review-desk/diff-file.tsx` | `review-desk-diff-file--sticky-headers`, `review-desk-diff-file--viewed-folds`, `review-desk-diff-file--owned-ranges` … | twin |
| Components | Desk / Gap row | 4 | `neuve/review-desk/diff-file.tsx` | `review-desk-diff-file--gap-opens`, `review-desk-diff-file--crowded-file` | twin |
| Components | Desk / Sibling-owned lines | 1 | `neuve/review-desk/diff-file.tsx` | `review-desk-diff-file--sibling-shown`, `review-desk-diff-file--whole-file` | twin |
| Components | Desk / Generated diff | 3 | `neuve/review-desk/generated-diff.tsx` | `screens-review-desk--static-generated-diff`, `screens-review-desk--static-generated-diff-open` | twin |
| Components | Desk / Feedback option | 2 | `neuve/review-desk/feedback/feedback-controls.tsx` | `screens-real-packet-feedback--reference-rubric`, `screens-real-packet-feedback--unit-call`, `screens-real-packet-feedback--digest-rubric` | twin |
| Components | Desk / Feedback trigger | 4 | `neuve/review-desk/feedback/feedback-controls.tsx` | `screens-real-packet-feedback--unit-call`, `screens-real-packet-feedback--setting-on`, `screens-real-packet-feedback--digest-rubric` | twin |
| Components | Desk / Owner chip | 2 | `neuve/review-desk/diff-file.tsx` | `review-desk-diff-file--whole-file`, `review-desk-diff-file--crowded-file`, `review-desk-context-margin-l0-l2--sibling-row-names-owner` | twin |
| Components | Margin / Pin | 36 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--kinds`, `review-desk-context-margin-l0-l2--states`, `screens-real-packet-feedback--reference-rubric` … | twin |
| Components | Margin / Comment pin | 17 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--comment-pin-states`, `review-desk-overlay-annotations--resolved-shown`, `review-desk-context-margin-l0-l2--shared-line` … | twin |
| Components | Margin / Peek card | 2 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--peek` | twin |
| Components | Margin / Card header | 10 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--card-conflicting-intent` | twin |
| Components | Margin / Sheet header | 3 | `neuve/review-desk/source-sheet.tsx` | `review-desk-source-sheet-l3--ticket` | twin |
| Components | Margin / Citation chip | 27 | `neuve/shared/marker-kind.tsx`, `components/tooltip.tsx` | `review-desk-context-margin-l0-l2--citation-chips`, `screens-review-desk-briefing-links--icon-only-chips` | twin |
| Components | Margin / Comment preview · Component | 1 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--comment-preview` | twin |
| Components | Margin / Peek row | 4 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--peek`, `review-desk-context-margin-l0-l2--peek-references`, `screens-real-packet-feedback--reference-rubric` | twin |
| Components | Margin / History source | 1 | `neuve/review-desk/history-source.tsx` | `review-desk-history-source--snapshot` | twin |
| Components | Margin / Reference card | 6 | `neuve/review-desk/context-margin.tsx`, `neuve/review-desk/floating.tsx`, `neuve/review-desk/reference-parts.tsx`, `neuve/review-desk/feedback/feedback-controls.tsx` | `review-desk-context-margin-l0-l2--card-reference-supports`, `review-desk-context-margin-l0-l2--card-reference-with-feedback`, `screens-real-packet-feedback--reference-rubric` … | twin |
| Components | Margin / Reference sheet | 1 | `neuve/review-desk/source-sheet.tsx`, `neuve/review-desk/reference-parts.tsx` | `review-desk-source-sheet-l3--reference-supports`, `review-desk-source-sheet-l3--reference-background`, `review-desk-source-sheet-l3--reference-at-phone-width` … | twin |
| Components | Margin / Checkpoint state | 10 | `neuve/review-desk/checkpoint-parts.tsx` | `screens-review-desk-checkpoints--every-state` | twin |
| Components | Margin / Checkpoint pin | 15 | `neuve/review-desk/checkpoint-parts.tsx`, `neuve/review-desk/context-margin.tsx` | `screens-review-desk-checkpoints--every-state`, `screens-review-desk-checkpoints--shared-line`, `screens-review-desk-checkpoints--card-open` | twin |
| Components | Margin / Checkpoint peek | 6 | `neuve/review-desk/checkpoint-parts.tsx` | `screens-review-desk-checkpoints--every-state`, `screens-review-desk-checkpoints--shared-line` | twin |
| Components | Margin / Checkpoint card | 6 | `neuve/review-desk/checkpoint-parts.tsx`, `neuve/review-desk/floating.tsx` | `screens-review-desk-checkpoints--card-open` | twin |
| Components | Desk / Checkpoint row | 5 | `neuve/review-desk/checkpoint-parts.tsx`, `neuve/review-desk/briefing.tsx` | `screens-review-desk-checkpoints--every-state` (only a checkpoint no line meets is a row; the rest are pins) | twin |
| Components | Desk / Claim bullet | 1 | `neuve/review-desk/briefing.tsx` | `screens-real-packet-briefing--joined` | twin |
| Components | Desk / Claim | 1 | `neuve/review-desk/briefing.tsx`, `neuve/review-desk/briefing-claims.ts` | `screens-review-desk-briefing-links--claim-per-line`, `screens-real-packet-briefing--joined` | twin |
| Components | Delivery / Before and After | 3 | `neuve/review-desk/delivery/explained-prose.tsx` | `screens-real-packet-briefing--joined-explained`, `screens-review-desk-explained--prose`, `screens-real-packet-briefing--joined-explained-phone` | twin |
| Components | Delivery / Before and After header | 1 | `neuve/review-desk/delivery/explained-prose.tsx` | `screens-real-packet-briefing--joined-explained` | twin |
| Components | Delivery / Explained term | 1 | `neuve/review-desk/delivery/explained-prose.tsx` | `screens-real-packet-briefing--joined-explained` | twin |
| Components | Desk / Section row | 9 | `neuve/review-desk/section-rows.tsx` | `screens-real-packet-sections--rows`, `screens-real-packet-sections--split`, `screens-real-packet-sections--phone` … | twin |
| Components | Margin / Section title | 3 | `neuve/review-desk/section-rows.tsx` | `screens-real-packet-sections--margin-title-holds` | twin |
| Components | Delivery / Dial | 29 | `neuve/shared/delivery-dial.tsx` | `shared-delivery-dial--compact`, `shared-delivery-dial--compact-narrow`, `shared-delivery-dial--mini-follows` … | twin |
| Components | Delivery / Title glyph | 13 | `neuve/review-desk/delivery/delivery-title-dial.tsx` | `screens-review-desk-delivery-title-dial--rest`, `screens-review-desk-delivery-title-dial--hover-tooltip`, `screens-review-desk-delivery-title-dial--keyboard-focus` … | twin |
| Components | Delivery / Source excerpt | 1 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided-excerpt` | twin |
| Components | Delivery / Criterion row | 4 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided`, `screens-review-desk-delivery--guided-excerpt` | twin |
| Components | Delivery / Blast radius row | 1 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided` | twin |
| Components | Delivery / Scope row | 3 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided-scope` | twin |
| Components | Delivery / Gathered row | 3 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided-gathered-scope` | twin |
| Components | Overview / Start review | 2 | `neuve/batch-overview/batch-hero.tsx` | `screens-batch-overview--rest`, `batch-overview-sections--hero` | twin |
| Components | Overview / Meta item | 1 | `neuve/batch-overview/batch-hero.tsx` | `batch-overview-sections--hero` | twin |
| Components | Overview / Judgment table | 6 | `neuve/batch-overview/judgment-table.tsx` | `batch-overview-sections--needs-your-judgment`, `batch-overview-sections--judgment-cells-truncate`, `batch-overview-sections--unmet-checkpoints` | twin |
| Components | Overview / Lane bar | 3 | `neuve/batch-overview/lane-bar.tsx` | `batch-overview-sections--lanes-rest`, `batch-overview-sections--lanes-with-empty-lane`, `batch-overview-sections--lanes-agentic` | twin |
| Components | Overview / Unmet count | 1 | `neuve/batch-overview/checkpoint-count.tsx` | `batch-overview-sections--unmet-checkpoints`, `screens-batch-overview--row-counts-checkpoints` | twin |
| Components | Revision / New-commit notice | 1 | `neuve/cycle/new-commit-notice.tsx` | `screens-commit-lineage--notice` | twin |
| Components | Revision / New-commit pill | 1 | `neuve/cycle/new-commit-notice.tsx` | `screens-commit-lineage--notice-parked` | twin |
| Components | Revision / Lineage list row | 2 | `neuve/cycle/lineage-screen.tsx` | `screens-commit-lineage--registered` | twin |
| Components | States / Empty | 9 | `neuve/states/empty-states.tsx`, `neuve/states/error-page.tsx` | `screens-states--desk-no-decision`, `screens-states--load-error-with-details`, `screens-states--no-review-batch` … | twin |
| Components | States / Start review | 3 | `neuve/states/start-review.tsx` | `screens-states--overview-empty-idle`, `screens-states--overview-empty-starting`, `screens-states--overview-empty-failed` | twin |
| Components | States / Retry button | 1 | `neuve/states/error-page.tsx` | `screens-states--load-error` | twin |
| Components | States / Error details | 2 | `neuve/states/error-page.tsx` | `screens-states--load-error`, `screens-states--load-error-with-details` | twin |
| Components | States / Skeleton · Component | 4 | `neuve/states/skeletons.tsx` | `screens-states--batch-overview-loading`, `screens-states--review-desk-loading`, `screens-states--lineage-loading` | twin |
| Components | Shared / Theme toggle | 2 | `neuve/shared/theme-toggle.tsx` | `shared--theme-switch` | twin |
| Components | Shared / Nav link | 2 | `neuve/shared/nav-link.tsx` | `screens-states--not-found` | twin |
| Components | Shared / Icon button | 2 | `components/button.tsx` | `primitives-button--variants` | twin |
| Components | Shared / Disclosure | 4 | `neuve/shared/disclosure.tsx` | `shared--disclosure-rows` | twin |
| Components | Shared / Live status | 2 | `neuve/shared/app-header.tsx` | `review-desk-chrome--header-live`, `review-desk-chrome--header-reconnecting` | twin |
| Components | Shared / Find button | 1 | `neuve/shared/app-header.tsx` | `review-desk-chrome--header` | twin |
| Components | Shared / Batch menu trigger | 3 | `neuve/shared/batch-menu.tsx` | `review-desk-chrome--header-several-batches`, `screens-batch-overview--several-batches-menu-open` | twin |
| Components | Shared / Batch row | 3 | `neuve/shared/batch-menu.tsx` | `screens-batch-overview--several-batches-menu-open`, `review-desk-chrome--header-several-batches` | twin |
| Components | Shared / Pagination link | 13 | `components/pagination.tsx` | `primitives-pagination--first-of-two`, `primitives-pagination--middle-of-many`, `primitives-pagination--last-page` | twin |
| Components | Shared / Pagination | 4 | `components/pagination.tsx`, `neuve/reviews/reviews-screen.tsx` | `screens-reviews--first-page`, `screens-reviews--second-page`, `screens-reviews--phone` | twin |
| Components | Reviews / Run state | 4 | `neuve/reviews/review-row.tsx` | `screens-reviews--first-page`, `screens-reviews--running`, `screens-reviews--failed` | twin |
| Components | Reviews / Gate square | 4 | `neuve/reviews/review-row.tsx` | `screens-reviews--first-page`, `screens-reviews--nothing-waits` | twin |
| Components | Reviews / Lane count | 4 | `neuve/reviews/review-row.tsx` | `screens-reviews--first-page` | twin |
| Components | Reviews / Batches trigger | 3 | `neuve/reviews/review-row.tsx` | `screens-reviews--batches-open` | twin |
| Components | Reviews / Batch item | 2 | `neuve/reviews/review-row.tsx` | `screens-reviews--batches-open` | twin |
| Patterns | Desk / Back link | 2 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail` | twin |
| Patterns | Desk / Rail unit row | 5 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail`, `review-desk-chrome--rail-linked-from-graph`, `review-desk-chrome--rail-switching-unit` | twin |
| Patterns | Desk / Rail collapse button | 1 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail-collapse-toggle` | twin |
| Patterns | Desk / Rail | 1 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail-collapsed` | twin |
| Patterns | Desk / Rail row | 5 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail-lane-groups-open`, `review-desk-chrome--rail-approved`, `review-desk-chrome--rail-long-lane` | twin |
| Patterns | Desk / Rail section label | 1 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail` | twin |
| Patterns | Desk / Status chip | 3 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail`, `screens-review-desk--approved` | twin |
| Patterns | Desk / Rail lane header | 1 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail` | twin |
| Patterns | Desk / Rail lane row | 7 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail-lane-group-expand`, `review-desk-chrome--rail-linked-from-doc`, `review-desk-chrome--rail-linked-from-graph` | twin |
| Patterns | Desk / Rail file row | 4 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail-files-tab` | twin |
| Patterns | Desk / Rail lane group | 2 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail-long-lane`, `review-desk-chrome--rail-long-lane-phone`, `review-desk-chrome--rail-long-lane-at-860` | twin |
| Patterns | Desk / Rail lane sheet | 1 | `neuve/review-desk/unit-rail.tsx` | `review-desk-chrome--rail-long-lane-phone` | twin |
| Patterns | Desk / Dock | 26 | `neuve/review-desk/decision-dock.tsx` | `review-desk-decision-dock--rest`, `review-desk-decision-dock--composing-with-draft`, `review-desk-decision-dock--composing` … | twin |
| Patterns | Desk / Read-only neighbor | 3 | `neuve/review-desk/read-only-neighbor.tsx` | `review-desk-read-only-neighbor--collapsed`, `review-desk-read-only-neighbor--expanded`, `screens-review-desk--neighbor-expanded` | twin |
| Patterns | Desk / Review card | 5 | `neuve/review-desk/briefing.tsx` | `screens-review-desk-delivery--human-suggested-briefed`, `screens-review-desk-delivery--guided-human-suggested`, `screens-review-desk-delivery--guided-human-suggested-why-open` … | twin |
| Patterns | Desk / Feedback layer | 6 | `neuve/review-desk/feedback/feedback-controls.tsx` | `screens-real-packet-feedback--reference-rubric`, `screens-real-packet-feedback--reference-rubric-keyboard`, `screens-real-packet-feedback--layer-stays-with-its-card-wide` … | twin |
| Patterns | Desk / Briefing header | 2 | `neuve/review-desk/briefing.tsx` | `screens-review-desk--rest`, `screens-review-desk-delivery--guided-human-suggested` | twin |
| Patterns | Desk / Briefing row | 6 | `neuve/review-desk/briefing.tsx`, `neuve/review-desk/briefing-claims.ts` | `screens-real-packet-briefing--joined`, `screens-real-packet-briefing--joined-facts`, `screens-real-packet-briefing--joined-explained` … | twin |
| Patterns | Margin / Context card | 7 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--card-documentation`, `review-desk-context-margin-l0-l2--card-committed-graph`, `review-desk-context-margin-l0-l2--card-conflicting-intent` … | twin |
| Patterns | Margin / Source sheet | 7 | `neuve/review-desk/source-sheet.tsx` | `review-desk-source-sheet-l3--captured-source`, `review-desk-source-sheet-l3--ticket`, `review-desk-source-sheet-l3--verification-evidence` … | twin |
| Patterns | Margin / Thread card | 9 | `neuve/review-desk/thread-card.tsx` | `screens-review-desk--thread-open`, `review-desk-context-margin-l0-l2--thread-queued`, `review-desk-context-margin-l0-l2--thread-sent` … | twin |
| Patterns | Desk / Mini diff | 2 | `neuve/review-desk/diff-file.tsx` | `review-desk-overlay-annotations--select-single-line`, `review-desk-overlay-annotations--drag-range` | twin |
| Patterns | Desk / Gutter comment handle | 1 | `neuve/review-desk/diff-file.tsx` | `review-desk-overlay-annotations--select-single-line` | twin |
| Patterns | Margin / Selection chip | 1 | `neuve/review-desk/context-margin.tsx` | `review-desk-overlay-annotations--drag-range` | twin |
| Patterns | Margin / Comment composer | 1 | `neuve/review-desk/context-margin.tsx` | `review-desk-overlay-annotations--composer-open-on-range` | twin |
| Patterns | Margin / Comment preview · Pattern | 1 | `neuve/review-desk/context-margin.tsx` | `review-desk-context-margin-l0-l2--comment-preview` | twin |
| Patterns | Delivery / Flow card | 1 | `neuve/review-desk/delivery/flow-card.tsx` | `screens-review-desk-delivery--explained` | twin |
| Patterns | Delivery / Term row | 1 | `neuve/review-desk/delivery/terms-card.tsx` | `screens-review-desk-delivery--explained` | twin |
| Patterns | Delivery / Terms card | 1 | `neuve/review-desk/delivery/terms-card.tsx` | `screens-review-desk-delivery--explained` | twin |
| Patterns | Delivery / Basis rows | 6 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided`, `screens-review-desk-delivery--guided-scope`, `screens-review-desk-delivery--guided-gathered-scope` … | twin |
| Patterns | Delivery / Basis card | 5 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided`, `screens-review-desk-delivery--guided-scope`, `screens-review-desk-delivery--guided-gathered-scope` … | twin |
| Patterns | Delivery / Suggested review | 3 | `neuve/review-desk/delivery/criteria-card.tsx` | `screens-review-desk-delivery--guided`, `screens-review-desk-delivery--suggested-review-sent`, `screens-review-desk-delivery--guided-suggests-approve` | twin |
| Patterns | Overview / Hero | 2 | `neuve/batch-overview/batch-hero.tsx` | `batch-overview-sections--hero`, `batch-overview-sections--hero-digest-sections`, `screens-batch-overview--all-approved` | twin |
| Patterns | Overview / Digest section | 2 | `neuve/batch-overview/batch-hero.tsx` | `batch-overview-sections--hero-digest-sections`, `batch-overview-sections--hero-briefing-with-phrase` | twin |
| Patterns | Overview / Decision panel | 4 | `neuve/batch-overview/decision-panel.tsx` | `screens-batch-overview--waiting`, `screens-batch-overview--some-decided`, `screens-batch-overview--all-approved`, `screens-batch-overview--all-decided` | twin |
| Patterns | Overview / Gate cell | 3 | `neuve/batch-overview/decision-panel.tsx` | `screens-batch-overview--some-decided` | twin |
| Patterns | Overview / Review action | 2 | `neuve/batch-overview/decision-panel.tsx` | `screens-batch-overview--waiting`, `screens-batch-overview--all-decided` | twin |
| Patterns | Overview / Lane counts | 1 | `neuve/batch-overview/lane-bar.tsx` | `screens-batch-overview--all-approved` | twin |
| Patterns | Overview / Unit group | 3 | `neuve/batch-overview/unit-list.tsx` | `screens-batch-overview--waiting`, `screens-batch-overview--agent-lanes` | twin |
| Patterns | Overview / Unit row | 1 | `neuve/batch-overview/unit-list.tsx` | `screens-batch-overview--all-decided`, `screens-batch-overview--agent-lanes`, `screens-batch-overview--row-counts-checkpoints` | twin |
| Patterns | Overview / New work notice | 1 | `neuve/batch-overview/new-work-notice.tsx` | `screens-batch-overview--branch-moved` | twin |
| Patterns | Overview / Section heading | 1 | `neuve/batch-overview/judgment-table.tsx`, `neuve/batch-overview/unit-list.tsx` | `batch-overview-sections--needs-your-judgment` | twin |
| Patterns | Settings / Language row | 6 | `neuve/settings/review-delivery-section.tsx` | `settings-review-delivery--default`, `settings-review-delivery--previewing-go`, `settings-review-delivery--phone` | twin |
| Patterns | Settings / Delivery preview | 4 | `neuve/settings/delivery-preview.tsx` | `settings-review-delivery--facts`, `settings-review-delivery--briefed`, `settings-review-delivery--explained` … | twin |
| Patterns | Settings / Section nav | 1 | `neuve/settings/settings-screen.tsx` | `settings-review-delivery--default` | twin |
| Patterns | Settings / Workspace default | 2 | `neuve/settings/review-delivery-section.tsx` | `settings-review-delivery--default`, `settings-review-delivery--phone` | twin |
| Patterns | Settings / Refine by language | 2 | `neuve/settings/review-delivery-section.tsx` | `settings-review-delivery--default`, `settings-review-delivery--phone` | twin |
| Patterns | Shared / Top bar | 7 | `neuve/shared/app-header.tsx` | `review-desk-chrome--header`, `review-desk-chrome--header-several-batches`, `screens-batch-overview--several-batches` … | twin |
| Patterns | Shared / Batch menu | 1 | `neuve/shared/batch-menu.tsx` | `screens-batch-overview--several-batches-menu-open`, `review-desk-chrome--header-several-batches` | twin |
| Patterns | Revision / Lineage title row | 1 | `neuve/cycle/lineage-screen.tsx` | `screens-commit-lineage--renewed-open` | twin |
| Patterns | Revision / Lineage column labels | 1 | `neuve/cycle/lineage-screen.tsx` | `screens-commit-lineage--renewed-open` | twin |
| Patterns | Revision / Lineage row | 4 | `neuve/cycle/lineage-screen.tsx` | `screens-commit-lineage--renewed-open`, `screens-commit-lineage--corrected-open`, `screens-commit-lineage--regrouped-open` … | twin |
| Patterns | Reviews / Row | 3 | `neuve/reviews/review-row.tsx` | `screens-reviews--first-page`, `screens-reviews--phone`, `screens-reviews--running` | twin |
| Patterns | Reviews / Batches list | 1 | `neuve/reviews/review-row.tsx` | `screens-reviews--batches-open` | twin |
| Patterns | Reviews / Waiting panel | 3 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--first-page`, `screens-reviews--nothing-waits`, `screens-reviews--phone` | twin |
| Patterns | Reviews / Failed start notice | 2 | `neuve/reviews/reviews-screen.tsx`, `neuve/states/start-review.tsx` | `screens-reviews--newest-failed` | twin |
| Patterns | Reviews / List bar | 3 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--first-page`, `screens-reviews--waiting-on-you` | twin |
| Patterns | Reviews / List footer | 2 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--first-page`, `screens-reviews--second-page`, `screens-reviews--phone` | twin |
| Screens | Desk · Guided | 1 | `neuve/review-desk/review-desk-screen.tsx` | `screens-review-desk-delivery--guided` | twin |
| Screens | Batch overview · rest | 1 | `neuve/batch-overview/batch-overview-screen.tsx` | `screens-batch-overview--rest` | twin |
| Screens | Batch overview · partly decided | 1 | `neuve/batch-overview/batch-overview-screen.tsx` | `screens-batch-overview--some-decided` | twin |
| Screens | Batch overview · all decided | 1 | `neuve/batch-overview/batch-overview-screen.tsx` | `screens-batch-overview--all-decided` | twin |
| Screens | Batch overview · branch moved | 1 | `neuve/batch-overview/batch-overview-screen.tsx` | `screens-batch-overview--branch-moved` | twin |
| Screens | Settings · review delivery | 1 | `neuve/settings/settings-screen.tsx` | `settings-review-delivery--default` | twin |
| Screens | Reviews · rest | 1 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--first-page`, `screens-reviews--first-page-dark` | twin |
| Screens | Reviews · second page | 1 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--second-page` | twin |
| Screens | Reviews · waiting on you | 1 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--waiting-on-you` | twin |
| Screens | Reviews · newest failed | 1 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--newest-failed` | twin |
| Screens | Reviews · batches open | 1 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--batches-open` | twin |
| Screens | Reviews · phone | 1 | `neuve/reviews/reviews-screen.tsx` | `screens-reviews--phone` | twin |

Exceptions inside a family:
- `Delivery / Dial / Compact / Briefed / Set by workspace` has no story: it is reserved for a workspace-locked stop the code doesn't render yet.
- `Desk / Dock / Agentic review / Awaiting review` has no story: the code's awaiting-review dock (`decision-dock.tsx`) has none yet.

## Keeping every surface in step

1. **A visual change starts at the lowest layer it touches.** Fix the atom or component, and the screens follow through their instances.
2. **The same unit updates every surface.** When a commit changes a component's visuals in code, the same round updates its Figma component, once the owner has approved the change, and every canvas board that shows it, and refreshes the export. The reviewer's gate includes parity on each of those for every component the commit touches, and the commit message names them.
3. **The owner approves new design before it reaches Figma; Storybook is the truth for behaviour.** After approval, Figma, the code, the canvas boards and the export are updated together, as the [workflow](README.md#workflow) describes. A code-only fix is carried back to Figma, once approved, and to the canvas and the export in the same round. The real batch in the desk has no design round: it is built from the Figma components and the Storybook stories ([decision 10.101](../../process/decisions.md#area-10-harness-m3-18-october-2026)).
4. **No detached copies.** Detaching an instance is a defect, unless a written note gives the reason.
5. **Five surfaces, every time.** A visual, token or motion change is done only when it has landed in Figma, Storybook, the web app, every board of the live design canvas it appears on (older rounds included) and the design export, or each is marked not applicable with a reason. Motion values come from `lib/motion.ts` everywhere. The owner set this on 2026-10-14, when the Pen held the design system: "the full extend of our updates is applied at the design system level in .pen, in storybook, in the web app and in our canvas here and the exported version for all pages … I also want our motion primitives properly consolidated in all those places." Since 2026-10-23 Figma takes the Pen's place ([decision 10.105](../../process/decisions.md#area-10-harness-m3-18-october-2026)).
6. **Motion follows the code.** Where the canvas and the code animate the same thing differently, the code's `lib/motion.ts` values win, and the canvas, Figma's motion sheet and the export are brought to them. The owner confirmed this on 2026-10-14 for the two cases that felt different, in the Motion calls, kept privately: Done when marks pop on the snappy spring, and leaving layers fade together over 200ms (emphasized accelerate).

## What Figma can't match

Some things are written down rather than worked around. The port notes give the detail, under [what won't map one to one](figma/README.md#what-wont-map-one-to-one), [Pen versus code](figma/README.md#pen-versus-code) and the deliberate choices in [the Figma file](figma/README.md#the-figma-file):
- an icon can't be rotated inside an instance, hence the Figma-only lane-row variant;
- an instance can't override nested sizes or layout direction, so four component bases stay detached, each saying so in its description;
- a frame that doesn't clip its content drops the ring of a ringed shadow, so about a hundred cards, dial thumbs and docks draw no ring (an open item);
- a CSS filter can't be drawn, so the dock's one silhouette shadow is approximated;
- text can't wrap around an instance, so a briefing's claims and Facts are drawn line by line, as the browser breaks them: words, `Desk / Phrase link` and `Margin / Citation chip` instances in each Line. A joined unit's rows on the screens follow `Desk / Briefing row`'s anatomy with each change's own lines, since an instance can't take another change's lines;
- a 2fr to 3fr grid can't be drawn, so `Delivery / Before and After` uses fixed 328 and 492 columns at the desk's body width;
- line-height variables are in pixels, so ratio line heights are stored as literals, and easing curves are stored as `cubic-bezier()` strings;
- text can't be truncated at its start, so a folder that the code cuts from the left (an untitled unit's row in the rail) is written already cut;
- nothing scrolls, so a bounded list (a long lane group in the rail) is drawn as a clipped list;
- nothing in the file animates, so motion lives in the motion sheet and the Rules.

## History: the Pen rebuild

design.pen (kept in the private archive) grew screen by screen. Its screens contained their own drawings and detached copies, so a rule changed in code never reached every place it was drawn; the delivery dial's equal stops are one example. On 2026-10-14 and 15 it was rebuilt into the layers above, in the steps below, before the port to Figma. The plan rested on a read-only audit of the Pen, made on 2026-10-14 before the rebuild. The audit isn't kept, so every finding the plan relied on is carried in [Stale items](#stale-items-and-the-step-that-fixes-them).

**Round boards were folded in.** Flows that still described the product were rebuilt as Rules from instances, such as the comment steps and the dial motion. Round showcases were removed, because the screens show the same states. Each round's history stays in `changes/round-N.md`, the canvas export and git, and the file keeps one changelog.

### Rebuild order

Each step was a restructure. A screen looked the same before and after it, apart from the stale items the step fixed. Each step was built, every screen was exported before and after it and the pixels compared, an independent reviewer checked it, including every stale item it owned, and the saved file was committed.

| Step | Scope |
|---|---|
| 0 · Checkpoint | Save, review and commit the current file as a known-good point. Done in e37e691a. |
| 1 · Foundations | Text styles for the code's type classes. Spacing, radius and shadow variables, bound on every node. The four missing dock tokens: `dock-ok`, `dock-ok-tint`, `dock-req`, `dock-req-tint`. Token names spelled as in the code: `raised-2`, `line-2`, `ink-2` and the `*-tint-2` set. The `player-*` names and values aligned with `--nv-player-*`. Three variables stay Pen-only, each noted as having no code token: `shadow-seg` mirrors the literal shadow in `components/toggle.tsx`, and `player-fg-92` and `player-fg-25` mirror the code's `bg-player-fg/92` and `/25`. Round 6's Pen R6b (06fb85d6) adds a fourth, `paper-20`: the Pen's alias for the code's `bg-paper/20`, which themes with the paper colour. Radius values aligned with the code. Bindings keep every node's current value: a value with no code token stays literal and is listed for step 2, and no other Pen-only token is added to fit it. One motion sheet. Done in ad78e346. |
| 2 · Atoms and components | One component per concept. The older duplicates are retired and every screen moves to the current component: `Pin / *` → `Marker pin / *`, `File header` → `File header / *`, `Expand row` → `Gap row`, `Decision dock / Decided (round 3 copy)` → `Decided · Next unit`, `Citation chip / Default` → the per-kind chips, `Context card / *` → card headers, the round-1 context card and source sheet, and the superseded hover hint. Agent pins wrap the avatar instead of redrawing it. Dials get a touch size. Add the code components the Pen lacks: skeletons, empty states, start review, theme toggle, nav link, the generated-diff dock and the history source. Done in 698e6b54. |
| 2b · Layers | Organise the file's top-level frames by layer: Foundations, Atoms, Components, Patterns and Screens, with one section per area inside each, and rules inside the area they govern. The round boards, the dark rows and the dark component boards wait in a "To fold in" frame until step 4, which retires them because dark is the theme switch. Moving components changes no screen. Done in b54b7e12 and e586fdfe. |
| 3 · Patterns | A diff row with a code slot. A review mark with actor and verdict as properties. One basis card with basis as a property, including the Unlinked subtitle. A rail row with a reviewed state. A peek row for person comments. Done in 356634e3. |
| 4 · Screens | Rebuild hand-drawn screens from instances. Dark screens become theme switches. Fold in the round boards. Done in fd0db7ef (desk), ba941289 (dark) and 444687af (fold-in). |
| 5 · Names and records | Apply the naming scheme, add the changelog frame and fill the code-twin table. Done in d513fe72. |

### Stale items and the step that fixes them

"Now" describes the file before the rebuild; every row has since been fixed in its step. They come from the read-only audit, from the independent reviews of the step-0 checkpoint and of step 1, and from the change list each step recorded. Each step's result is in the commit named in the [rebuild order](#rebuild-order). A step's before-and-after comparison could change only these.

| Item | Now | Fix | Step |
|---|---|---|---|
| Decided-dock colours | Done tiles and checks use hex; "Requested changes" uses `#FFFFFF1F` | Use the dock tokens; check against the decision-dock stories | 1 |
| 12px corners | 74 cards and docks (context, thread, verification, delivery and settings cards, decided docks, agents popover, spec cards) are 12px where their code twins draw `rounded-xl`, 14px | Settle each against its code twin: 14 when the twin renders 14, a noted literal when the twin uses 12 | 2 |
| Other off-scale values | Radii 2–16, gaps and padding of 1–9, 17 inexact line heights, mono caption tracking | Settle each against its code twin; keep avatar-id sizes literal | 2 |
| Decided-dock tiles | Radius 6 where the code uses 8 (`rounded-md`); "Approved against the suggested review" is an instance of the requested-changes dock | Radius from the code; the approved-against dock becomes its own variant so it keeps its check when the requested-changes icon changes | 2 |
| Line heights matched loosely | Four line-height variables were matched within ±0.02, and some have "-b" duplicates | Exact values from the code, one variable each | 2 |
| Dock and sticky shadows | Decided docks 12/32 against the code's 16/40; stuck header 8/16 against 8/18 | Use the code's shadow tokens | 2 |
| Tooltips | Shadowed 4/12, with their own fill, padding and radius | Follow `components/tooltip.tsx`: no shadow, radius 8, padding 6/12, ink fill, with its arrow | 2 |
| Retired duplicates that looked different | The round-2 file header (whole path one colour); the 28px expand row; the round-3 decided dock (wider Undo) | The current components: muted folders with a medium-weight file name; the 32px gap row, which moves everything below it down 4px per gap; the decided dock from the code (radius 14, shadow 16/40, 8px tile, 36px buttons) | 2 |
| Context-card headers | Each card drew its own header: 6px kind tile, 8px close button, 12px card | Card header instances from the code's header row: 8px tile, 10px close, 14px card, dashed tile for Same batch | 2 |
| Dial and control radii | Dial stops and thumbs one step below the code (compact 8, mini group 8, mini stops 6); icon buttons, card close buttons, conflict sources and the composer field at 8 | The code's radii: compact 10, mini group 10 and stops 8; those controls 10 | 2 |
| Line chips | Amber tint of the suggested lane, 18px tall | The code's neutral chip (`bg-raised`), 20px tall | 2 |
| Resolved comment pins | 3px gap to the check; agent resolved radius 11 | 4px gap, radius 7, as `context-margin.tsx` draws them | 2 |
| Thread-card range text | 11px | 10.5px on a 15px line, as `thread-card.tsx` | 2 |
| Board and spec text | Board headings 36 and 44; captions on hand-set line heights | The nearest code display and label styles (32, 40, label-mono); boards reflow slightly | 2 |
| Segmented control | Group radius 8 and items 6, one step below the code; owned-ranges variants 32px tall | The code's radii (group 10; items round only at the group's outer corners, 10px) and 36px height | 3 |
| Agent status on avatars | "Agent avatar · status" variants drew a dot on the avatar | Nothing on the avatar; the agent row shows a 6px dot and its label beside it, as `agents/agents-control.tsx` | 2b |
| Agent row details | "N units" is plain text; "+N" is semibold | The code's raised "N units" chip; "+N" in regular weight | 3 |
| Icon sheet | 25 icons, a stroke note of "1.6–1.9", a truncated label and uneven cards | Every Lucide icon the code imports, each with its name, where it's used and its stroke, on equal cards | 3 |
| Requested-changes dock icon | A check | The code's reply arrow (`CornerUpLeftIcon`) | 3 |
| Touch-height dial | Code makes every stop 44px on touch screens (`pointer-coarse:h-11`); the Pen's phone dials are 26 or 34 | A touch size on each dial | 2, used in 4 |
| Agentic dock copy | Reads "Decided by agentic review" | "Covers N hunks", or "Awaiting agent review" before one is recorded | 3 |
| Rail review marks | Drawn on three screens by replacing the avatar | `Rail row / Reviewed` with the 16px review mark | 3 |
| Person comment peek row | Only the agent version exists; "Desk · peek on a shared line" overrides by hand | `Margin / Peek row / Comment · Person` | 3 |
| "Progress, not a disposition." rule copy | Uses the internal word | Vocabulary nouns | 3 |
| Two pins on one line | Comments step 8: the I1 and YO resolved pins share line 20 | Move one pin, or show one pin with a count | 4 |
| Dark board | Captions say "80PX / 72PX STOPS" and "56px"; no compact phone dial or rule note | Dark becomes the theme switch on the light screens | 4 |
| Large dial on phones | Heading says "≤ 640px"; code switches at a 520px container | Heading and frame follow the code | 4 |
| Settings phone preview | Raw redraw with fixed line widths | Instance of the delivery preview | 4 |
| Lineage avatars and thread-card initials | Unchecked against the stories ("YO" against "VD") | Check and match the stories | 4 |
| Suggested review cards | Draw a "SUGGESTED REVIEW" label and "◆ Request changes" | The code's review mark: a dashed "Suggested · request changes", or "You requested changes" with the avatar once sent (`delivery/criteria-card.tsx`). The settings preview keeps the code's current card until code and Pen change together | 4 |
| Desk layout | Units/Files sits at the top of the main column; human-suggested units sit in the Suggested lane | Units/Files in the rail, and human-suggested units under "Needs your decision", as `unit-rail.tsx` | 4 |
| Screen-level drift found in step 2 | The error page draws a card the code doesn't have; the lane segment has no code twin; thread-card header layout, settings preview bar height, the phone toggle at 44px | Fixed when each screen is rebuilt from instances; the lane segment is replaced by a lane-bar component built first | 4 |
| Page skeletons | Absolute positions measured from Storybook | Auto layout where the Pen allows it | 4 |
| Missing screens for existing stories | Guided on agentic and static units, Guided with no basis, phone and dark variants, settings focus rings | Component variants on their sheets (call 3), plus the screens in the layer table | 2–4 |
| Old dial and history in layer names | "80px" layers, "(was Test)", "(round 3 copy)" | The naming scheme | 5 |

### Screen names

Step 2b named the screens after what they show, and the Figma screens keep those names. Earlier reviews, handoffs and this document used letters such as "desk (h)", so this is the cross-reference.

| Old frame | Screen |
|---|---|
| Review desk (a) rest | Desk · rest |
| Review desk (b)–(g) context cards | Desk · context card · conflict, graph, doc, same batch, test, history |
| Review desk (h) shared line hover | Desk · peek on a shared line |
| Review desk (i) collapsed rail | Desk · unit rail collapsed |
| Review desk (k) source sheet, ticket | Desk · source sheet · ticket |
| Review desk (l) composer, request changes | Desk · composer · request changes |
| Review desk (m) decided, approved | Desk · decided · approved |
| Review desk (n) read-only neighbor expanded | Desk · read-only neighbor expanded |
| Review delivery (a), (b), (c) | Desk · Facts, Desk · Explained, Desk · Guided |
| Review delivery (e) suggested review sent | Desk · Guided · suggested review sent |
| Review delivery (i) human-suggested, Explained | Desk · Explained · human-suggested |
| Review delivery (j), (k) human-suggested, Why closed and open | Desk · Guided · human-suggested · Why closed, Why open |
| Review delivery (l) scope fallback | Desk · Guided · scope card |
| Review delivery (m) gathered scope | Desk · Guided · gathered scope card |
| Review delivery (f), (g) settings | Settings · review delivery, Settings · review delivery · phone |
| Batch overview (a)–(d) | Batch overview · rest, lane hover, verification video playing, lane bar and judgment table |
| New revision (a)–(c) | Revision · new-commit notice, new-commit notice parked, lineage |
| Review delivery (h) spec | Review delivery · stops, rules and motion (in 4 · Patterns › Delivery) |
| Review desk (j) split, (o) round 3, Review delivery (d) dark | Kept under their old names in "To fold in · step 4" |
