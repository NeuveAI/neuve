# neuve-web design round 4: review delivery

The user approved this round for implementation on 2026-10-14. The source is the "Review delivery" row of the Claude design canvas, kept privately, after two rounds of the user's comments. The repo copy is in [design-export/](../design-export/).

| Artboard | Covers |
|---|---|
| `Delivery.dc.html` | The dial on the review desk and the layers each stop adds. At Guided the code gives way to reasons. |
| `DeliverySettings.dc.html` | The workspace setting: one default dial, refined by language, with a live preview |
| `DeliveryRules.dc.html` | What each stop adds, the dial's anatomy and states, the rules, the motion timelines and the "never" list |

Terms follow [vocabulary.md](../../../vocabulary.md).
- ***Review delivery*** was approved by the user on 2026-10-14 and is in the vocabulary.
- **User-facing naming** (user, 2026-10-14):
  - UI copy calls a disposition a ***review*** (a verdict).
  - The one the harness prepares is a ***suggested review***.
  - ***Comments*** stay a separate unit: suggestions and nitpicks, not verdicts.
  - Code, docs and records keep *disposition* and *suggested disposition*.
  - A suggested review is not a disposition until a person sends it.
- The stop names *Facts / Briefed / Explained / Guided* are still **proposed**. Use them in UI copy and code, but don't add them to the vocabulary without approval.

Where this document and a board disagree, the board wins for layout and behaviour, and [`globals.css`](../../../apps/neuve-web/packages/ui/src/styles/globals.css) wins for colour. Two exceptions, where this document wins:
- **Provenance.** Board rule 6 says sending a suggestion is noted in history as having started from it. That recording is backend follow-up (see Implementation scope). On `/mock` the status line is fixture text only.
- **Leftover code.** `Delivery.dc.html` still contains code for the removed readout and "where this came from" line (`.readout`, `.rd-*`, `.origin`, `.reset`, `STOPS[].readout`, `isDefault`, `isOwn`, `resetStop`). It isn't rendered and isn't behaviour.

## Why

The user's brief, 2026-10-13: people are now reviewing languages, frameworks and code they don't fully understand. Some potential clients need a dial that tunes how a review delivers its facts and pre-generated dispositions, leaning more or less on digests, diagrams and pre-generated dispositions. The user also asked to control how verbose the generations are. Text length per stop is a target for the evals that tune generation length; the UI enforces only structure.

## User decisions (canvas comments, 2026-10-13 and 14)

- The flow diagram ("How Commit changes") is kept and loved.
- **Never assume the reader.** No "new to Go" nudge and no inference of anyone's proficiency or preferences. The stop comes only from the workspace setting or from the reader moving the dial.
- **No label beside the dial on the desk.** No readout and no "where this came from" line; the dial stands alone.
- **Guided shows no code.** The code isn't the focal point there. The change is described in words and in the flow. The context the margin gathered feeds the reasoning and the disposition.
- **Guided assumes the harness's pre-generated disposition will be used,** so it has to justify it. The disposition is reasoned from known facts: the ticket's scope and definition of done, docs, tests, the graph and the source.
- **Settings:** the workspace default is the main dial, refined by language, with no frameworks. The Reviewers switches (reviewers may move the dial, the nudge, and drafts) are removed.

## The stops

| Stop | Briefing | Adds | Dock |
|---|---|---|---|
| Facts | One cited sentence (proposed: ≤ 30 words) | Nothing. Diff and margin only. | As the lane offers |
| Briefed | Today's cited paragraph (proposed: ≤ 70 words) | Nothing | As the lane offers |
| Explained | Same paragraph | **How it changes**: a before/after flow from the graph, proposed ≤ 6 boxes, each landing on its symbol. **Language terms**: proposed ≤ 3 constructs from the owned lines, each with a line chip. Dotted underlines appear on those terms in the diff. | As the lane offers |
| Guided | Same paragraph | The flow stays. The diff, terms and margin leave. **"Done when"**, headed by the ticket's **title** with its id secondary (ids are opaque to people), lists one row per item the ticket asks for: Done, Not done or No evidence. A **"Blast radius"** section follows, with what the margin found beyond the ticket and no status. Each row says what the change does, in words, and cites evidence as [marker-identity](../context-markers.md) pins. A Source pin opens only a short excerpt of its lines. On human-required units it ends in the **suggested review**: a plain card whose review mark carries the dashed edge ("Suggested · request changes", per the review identity; one separation method, so the card itself is not dashed), with the decision, the conclusion computed from the rows ("2 of 3 not done") and the message. Other lanes: see "Guided per lane" below. | Human-required, suggestion **Request changes**: **Approve instead · Edit message · Send request ⌘↵**. Suggestion **Approve**: **Request changes instead · Approve ⌘↵**. Other lanes: the lane's dock, unchanged. |

**Superseded in round 6:** the Guided dock's labels changed to the lane's own verbs: Approve · Edit request · Request changes ⌘↵, or Request changes · Approve ⌘↵. See [Guided dock copy](round-6.md#guided-dock-copy).

Rules, from the Rules board:
1. Facts are fixed: Explained and Guided reuse the Briefed paragraph word for word.
2. Every added line lands somewhere.
3. Terms come only from the owned lines.
4. Guided reasons from known facts; a suggestion with no rows behind it isn't shown.
5. Guided describes and doesn't show code. Code appears only on demand: a Source pin's short excerpt, or a flow box opening its lines in the source sheet.
6. A suggestion is unrecorded until sent.
7. The lane decides the dock. Guided never adds or removes dock actions: the dock offers exactly the lane's actions as the [decision dock entry](../../../vocabulary.md) defines them.
8. The workspace sets the stop, refined by language. A reader's change applies to one unit only, isn't recorded and doesn't change anyone else's view.
9. Never assume the reader.
10. **Language is data.** Under the constitution's [repository-language neutrality](../../../CONSTITUTION.md) rule, a unit's language is provider-declared observation metadata. The settings list shows the languages observed in the workspace. Neuve never ships a closed list, an extension allowlist, or its own inference of a unit's language. The four rows on the board (TypeScript, Go, SQL, HCL) are sample data, and so are their file types. How a multi-language unit gets its language is open, and the board's "most of their changed lines" line is only a proposal.

**Guided per lane** (user, 2026-10-14: "show 'suggested' lanes more as a FYI and trust more on the agent's disposition"):
- **Human-required:** the full "Done when" card, then the suggested review and its dock, as above.
- **Human-suggested: an FYI.** The agent's recorded review leads ("The agent approved"). The "Done when" card is collapsed behind a quiet "Why" disclosure that shows the computed count ("Why · 1 of 3 not done") and opens on demand. There is no dashed suggestion. The dock stays as the vocabulary defines it.
- **Agentic and static automation:** the "Done when" card as reasons only, with no review card. The dock offers comments only.

**States** from the board:
- "Approved · against the suggested review" when the reader approves instead.
- The composer is tagged "from the suggested review" when opened through Edit message.
  - Superseded in round 6: "approves instead" is now the Approve button, and Edit message is now Edit request. The state and the composer tag are unchanged. See [Guided dock copy](round-6.md#guided-dock-copy).
- The suggestion card carries no provenance line (no "prepared by the harness"; user decision, 2026-10-14). Its review mark shows the state, per the [review identity](#review-identity-round-42): before sending, "Suggested · request changes" with a dashed edge and no avatar; once sent, "You requested changes" with your avatar and no edge. Undo returns it to the suggested mark.
- A conclusion such as "2 of 3 not done" is computed from the rows, never written separately.

**Without a "Done when"** (decided 2026-10-14, see [Scope fallback (S2)](#review-identity-round-42)): rows come from the ticket's scope and the linked docs, and the card is headed "Scope" over the ticket's title. **Without a ticket scope either**, the harness gathers one; see [Scope is always gathered](#scope-is-always-gathered).

**Copy rules for Guided** (user, 2026-10-14): no self-describing captions such as "Built from the graph…" or "From the context margin", and no provenance lines. Use the ticket's own words ("Done when") and the vocabulary's nouns ("Blast radius"), not process jargon ("definition of done", "criteria", "met"). The conclusion reads "<n> of <m> not done", computed from the rows.

## Implementation scope (round 4)

The features don't exist in the backend yet, so this round **informs** them:

- **Desk: `/mock` only.** The dial appears only when `ReviewDeskData.delivery` is present. Fixtures carry it; the live `/review` route never does in this round.
- **Settings: a real `/settings` route** with a single "Review delivery" section, plus `/mock/settings` so mock-mode links stay under `/mock`. The data is mock: browser storage via `deliverySettingsAtom`, with a quiet note that it's a sample setting stored in this browser. The app header gets a Settings link.
- **Allowed:** frontend (`packages/ui`, `apps/web/src/routes|components|mock`), the BFF (`apps/web/src/server`) only if route wiring needs it, Storybook, and design.pen (kept in the private archive) through the Pencil MCP.
- **Forbidden:** `packages/backend`, `packages/ai`, `packages/storage`, `packages/editor` and anything outside `apps/neuve-web`, except `design/neuve-web`. Other agents are working there.
- Contract: [`delivery.ts`](../../../apps/neuve-web/packages/ui/src/neuve/shared/delivery.ts) (stops, settings atoms, payload types; languages are plain ids) and the `TIMING.delivery*` tokens in [`motion.ts`](../../../apps/neuve-web/packages/ui/src/lib/motion.ts).
- Follow-up for the backend, not this round: record "started from the harness's suggestion" in review history when a suggestion is sent.
- Deferred: the dotted term underlines in the diff. Diff rows are virtualized rows owned by `packages/diffs`, which is out of scope this round. Their timing token was removed on 2026-10-14 (commit c35b6b2a) because nothing used it; a timing returns to `lib/motion.ts` when the underlines are built.
- The terms card is titled "<languageName> in this unit" when the payload carries the provider's language name, and "Terms in this unit" otherwise.

## Motion (Interface Craft storyboard, neuve-motion tokens)

**Superseded in round 6:** on the desk, a stop change now plays one phased sequence. The height moves once, and the contents follow, slightly staggered; exits play in reverse. The layered timings below are retired from the app. See [Phased choreography](round-6.md#phased-choreography).

```
stage = stop index 0..3; one integer drives every layer
All times are absolute, measured from the stop change. TIMING tokens hold the relative parts.

thumb           0ms   SPRING.snappy, slight overshoot; labels never move
→ Explained
  layer        60ms   flow + terms layer opens (emphasizedDecelerate)   TIMING.deliveryLayer
  children    160ms   6px rise + fade, stagger 55ms                     + deliveryChildren / ChildStagger
  flow boxes  220ms   left → right, 6px slide + fade, stagger 70ms      + deliveryNode / NodeStagger
→ Guided
  leaving       0ms   diff, terms and margin leave together, 200ms      TIMING.deliveryExit
  layer       120ms   "Done when" card opens                               TIMING.deliveryGuided
  card        220ms   the card's content enters as one (6px rise + fade)
  marks       340ms   pop (scale .6 → 1, snappy), stagger 90ms, in reading order
  verdict     740ms   suggested review rises 8px, last
→ back from Guided
  leaving       0ms   "Done when" card and suggested review leave together, 200ms
  diff          0ms   returns at once (the reader's main surface)
  terms        60ms   with the Explained layer
excerpt       220ms   a Source pin's lines drop 4px (on click, at Guided)
```

- The flow card and the facts paragraph never move.
- Height uses motion/react `layout` (FLIP) on the layer stack, not grid-rows.
- Keep the topmost visible row anchored when layers open above the reader.
- Retarget springs on rapid changes; don't queue.
- **Reduced motion:** the thumb snaps; layers fade with a 150ms opacity tween only. No height animation, travel, pop or stagger.
- Transform and opacity only; never blur. Real hover only. Focus-visible rings for keyboard.

## Dial anatomy

**Superseded in round 6:** the compact dial no longer has its own row on the desk. A glyph of four ticks after the unit title opens the dial, and ticks replace the stacked bars in the dial's stops. See [The delivery dial in the unit title](round-6.md#the-delivery-dial-in-the-unit-title).

- Four detents, never a continuous slider. A native radio group: arrow keys move between stops, focus shows a full ring, and the screen reader announces "Review delivery, Briefed, 2 of 4".
- The glyph is a stack of four bars that fills one bar per stop.
- Sizes:
  - **compact:** on the desk, in its own row between the unit title and the briefing (as on the Delivery board). The four stops are equal width, sized to the widest label, with at least 12px between each label and the thumb's edge (user, 2026-10-14). On phones (below the `sm` breakpoint) compact and mini drop the glyph and the gap shrinks to 8px, so the dial fits a 311px column; labels never touch the edge. The diff toolbar keeps its place below;
  - **large:** settings hero, each stop with name and description; it becomes two columns on a phone;
  - **mini:** language rows, with the same equal-width rule and 12px gap as compact. While a language follows the default, the thumb is an outline only and the row says "Follows default". A changed language shows "Reset".
- States: rest, hover (the label darkens a step, the thumb doesn't move), focus, and "set by workspace" (locked: outline only), which is reserved for later.

## Settings page

- **Hero:** title "Review delivery" with one line of help, then the large dial for the workspace default.
- **Refine by language:** one card of rows for TypeScript (.ts .tsx), Go (.go), SQL (.sql) and HCL (.tf). Each row has a mini dial plus "Follows default" or "Reset". The header counts how many are refined. An "Add a language" button sits below; it can be inert in the mock.
- **Preview** (sticky aside, stacks on narrow screens): a miniature unit whose layers open and close with the same mechanics as the desk. Selecting a language row previews that language. At Guided the code block gives way to the ticket check and the suggestion.

## Review identity (round 4.2)

The user approved this on 2026-10-14. The board is `Verdicts.dc.html` in the canvas row "Identity · reviews and verdicts". It was refined over several comments: "identity, placement and state are different things", then a chat bubble for people, then an antenna and a dashed outer edge for agents, then the antenna's gap and rod length.

**Identity is who.** There is one avatar per actor, and it is never altered by placement or state.
- **Person:** a chat bubble (`border-radius: 50% 50% 50% 14%`, which at 22px is the familiar 11 11 11 3). Initials in Geist 600 on `--nv-raised2`, ink-2 text. It is the same bubble the margin comment pins already use.
- **Agent:** one SVG on a `viewBox="0 -1.2 24 29.2"` grid, so every part scales together.
  - Antenna: a rod `x1=12 y1=1.4 x2=12 y2=6.4`, 0.85 stroke, round caps; a ball at `cx=12 cy=1.2 r=1.7`.
  - Body: `rect x=2 y=6 w=20 h=20 rx=5.5` in the role tint.
  - Edge: an open dashed path outside the fill that leaves a 3.6 opening under the antenna, so the rod rises through the gap and not across a dash: `M13.8 5.3H16.5A6.2 6.2 0 0 1 22.7 11.5V20.5A6.2 6.2 0 0 1 16.5 26.7H7.5A6.2 6.2 0 0 1 1.3 20.5V11.5A6.2 6.2 0 0 1 7.5 5.3H10.2`, `stroke-dasharray="2.619 1.964"`, 1 stroke, opacity .5. The dash values go on the element; don't rely on CSS.
  - The id in Geist Mono 8.6/600, centred at y 16.3.
  - Role tints: implementer `--nv-agt-tint` / `--nv-agt-fg`; reviewer `--nv-sug-tint` / `--nv-sug-ink`, as in the agents control.
  - The SVG is shifted up 10% so its body, not the antenna, aligns with the text beside it.

**Placement changes size only:** 24 in the header agents control, 20 in review cards, threads and the margin, 16 in the rail.

**Comment pins** (user, 2026-10-14). A comment pin is its author's real avatar: a person's bubble, or an agent's antenna square. Agents' comments must never draw a person bubble. States draw *around* the avatar:

| State | Person | Agent |
|---|---|---|
| Rest | The avatar | The avatar |
| Hover | 1.5px `--nv-line-strong` ring following the bubble | A 1.4 ring just outside the dashed edge (`M14.4 3.9H16.9A7.6 7.6 0 0 1 24.1 11.1V20.9A7.6 7.6 0 0 1 16.9 28.1H7.1A7.6 7.6 0 0 1 -0.1 20.9V11.1A7.6 7.6 0 0 1 7.1 3.9H9.6`, with the same opening under the antenna) in `--nv-line-strong`; the antenna rises |
| Focus | 2px focus ring | 1.8 ring in the focus colour; the antenna rises |
| Open | 2px ink ring | 1.8 ink ring; the antenna rises |
| Resolved | 1px `--nv-line-strong` ring, plus a muted check beside it | No ring, just the dashed edge, plus a muted check beside it |

When an agent's ring appears, the antenna ball moves up 1.6 units and the rod stretches to follow (`scaleY(1.32)` from its base at y 6.4), so the antenna clears the ring.
- **Motion:** the ring fades in over 140ms with the antenna on SPRING.snappy, which gives a slight overshoot. Leaving takes 100ms.
- **Reduced motion:** the ring and the raised antenna appear instantly.

**State goes beside the avatar, never on it.**
- **Review mark:** avatar, verdict icon (check in `--nv-agt`, cross in `--nv-req`, on the icon only), then words in ink: "R1 approved", "You approved", "R1 requested changes". The mark has no fill and no chip.
- **Suggested review, unsent:** a dashed edge around the whole mark, no avatar, "Suggested · request changes". Once sent it is "You requested changes" with your avatar.
- **Comment:** avatar plus text, with no icon and no verb.
- **Provenance on demand:** hovering or focusing the avatar shows a tooltip (e.g. "R1 · reviewer agent · agentic review · a3f9c2e"). It is never a subheading.

**Human-suggested units (Option A, kept privately, user 2026-10-14), at every stop:**
- The attribution card becomes the one review card: the review mark, then the agent's reason, then its evidence. At Guided it also gains the "Why · n of m not done" disclosure, which replaces the separate FYI card.
- The dock no longer repeats the verdict; its label says what the decision covers ("Covers 1 hunk").
- The rail shows the 16px avatar with the verdict icon, and the "Agent approved · yours to override" note goes.

**Scope fallback (S2, user 2026-10-14).** When the ticket has a scope but no "Done when", the card is headed "Scope" over the ticket's title.
- Its rows use ring marks (an outline in the status colour) instead of fills.
- The statuses read **Covered / Not covered / No evidence**, and the conclusion reads "n of m not covered".
- When the ticket has neither, see "Scope is always gathered" below.

## Scope is always gathered

The user decided this on 2026-10-14: "the harness should perform some form of 'hill climb' / 'best effort' to gather the needed scope always. It's important that this is well documented. Which means that the context markers will come mostly from code and history facts."

Guided never runs without a basis, and it never falls back to showing the code. The basis is chosen in this order:

| Basis | When | Card label | Title | Marks and statuses | Evidence mostly from |
|---|---|---|---|---|---|
| `done-when` | The ticket has a "Done when" list | Done when | Ticket title, id secondary | Filled · Done / Not done / No evidence | Ticket, docs, tests, source |
| `scope` | The ticket describes a scope but no list | Scope | Ticket title, id secondary | Rings · Covered / Not covered / No evidence | Ticket, docs, source |
| `gathered` | No usable ticket | Gathered scope | The gathered intent, in one line, with no id | Rings · Covered / Not covered / No evidence | **Source and History**, then Graph and earlier reviews |

**What the harness does for `gathered`** is a backend requirement, not this round:
1. **Start from the change itself:** the changed symbols and what the diff does. Describing the diff is always possible, so the basis is never empty. But the diff can only describe itself: it can't confirm its own intent. An item supported only by the diff is marked No evidence, never Covered.
2. **Climb outward while each step adds intent:** commit messages and the history of the touched lines and files; earlier reviews and recorded decisions on them; the blast radius (callers and dependents); linked docs.
3. **Stop when the intent is stated from at least one source other than the diff** (history, an earlier review, a decision, a doc or a caller), and every item can cite at least one fact; drop items that can't. If the climb finds nothing beyond the diff, its items stay No evidence.
   - **Unlinked:** when no ticket, doc, recorded decision or earlier review connects to the change, the card's subtitle reads "No ticket or doc is linked to this change, so this briefing and any suggested review come from the code and its history alone." The user decided this on 2026-10-14, in the Pen design system calls, kept privately (call 4): the line should say "that the changes are not connected to sources so any suggested dispositions or digests are purely from code and git history sources."
   - Rows under an Unlinked card can still be Covered, when History or Graph evidence states the intent. When the climb found nothing beyond the diff, every row is No evidence, and the same subtitle is how the card "says so plainly". There is no second line.
   - The harness reports Unlinked explicitly. The desk never infers it from the marks.
   - **Inside an agent's recorded review** (human-suggested work, behind "Why"), the line names the review on screen: "No ticket or doc is linked to this change, so this briefing and the agent's review come from the code and its history alone." The words "the agent's review" link to that review's line in the card. Following the link lands on the line with the citation-jump tint and focuses the reviewer's mark, which opens its provenance. Decided by the user on 2026-10-14 in Unlinked line on agent reviews, kept privately: "we can do with A but linking it to the relevant review line, as for the human to have access to it and direct linkage".
   - Contract: `check.unlinked?: boolean`, reported for `gathered` only.
4. **Return** the intent line, the items (each with Source, History, Graph or Doc evidence pins) and which basis was used. Record the basis with the review, so a gathered scope is never mistaken for a ticket's.

**In the UI,** a gathered scope looks like a ticket scope (ring marks, same card) but carries no ticket id, and its label says "Gathered scope". On human-required work the suggested review still follows, reasoned from these rows, like any other basis. The weaker the basis, the quieter the marks: fills for "Done when", rings for scope and gathered scope.

Contract: `check.basis` is `"done-when" | "scope" | "gathered"`, and `check.ticket` becomes `{ id?: string; title: string }`. For `gathered`, the title is the gathered intent and there is no id.
