# neuve-web design round 5: briefing descriptive links

The product requirement comes first. [foundations/04](../../../foundations/04-review-units-and-context.md#give-the-reviewer-an-attributed-briefing) records "Descriptive text links to what it describes" (user requirement, 2026-10-15), and the vocabulary's *Contextual briefing* entry says its descriptive phrases link to the part of the change they describe.

The design is the "Briefing · descriptive links" row of the Claude design canvas, kept privately (`Briefing.dc.html`; [design-export/](../design-export/) gets a copy when the decided board is published). It showed three options on the Index-writes briefing:
- A: phrases replace chips;
- B: phrases link, and the chips stay;
- C: chips only for evidence the words don't name.

## Decision

The user chose **B, with icon-only chips** on 2026-10-15: "I vouch for B actually, but with a correction that on the briefing, the chips are icon only".

- **Phrases link.** Each phrase that describes part of the change (a hunk, a file, a marker, a recorded review) links to that part. Following it lands there with the landing tint, as a citation chip lands on its range.
- **Chips stay, icon only.** In the briefing a citation chip shows only its marker-kind icon, after the claim it supports. Its accessible name and its tooltip still say the kind and the target, for example "Source, lines 29–36".
- **One landing.** A phrase and its chip land on the same lines; the chip adds the evidence kind at a glance.
- **Reading states.** A phrase link reads as ink with an underline, which turns ink on real hover. Keyboard focus shows the focus ring. Hovering or focusing a phrase lights the lines it describes, as a marker pin does. With reduced motion the jump is instant and the tint stays until the next action.

The agent's-review link (commit 94afe37b) is the first instance of this rule.

## What changes where

The [five-surface rule](../design-system.md#keeping-every-surface-in-step) applies:

| Surface | Change | Status |
|---|---|---|
| Canvas | Mark B as decided on `Briefing.dc.html`, with icon-only chips. Bring the briefings on the desk boards in line. | Done: Briefing, Main, Delivery and Markers boards |
| Code and Storybook | Render phrase links and icon-only chips in the briefing. Carry phrase targets with the text in the payload, and pass them through the BFF. Cover each state with fixtures and stories. | Done for the desk: commit 521f91ce, and the BFF names live chips "Kind, target". Passing stored phrases through the BFF waits for the harness to emit them; until then live briefings carry text and chips only. |
| Pen | Let the briefing header pattern's paragraph slot take phrase links and icon-only chip instances. | Done: commit 85435a97 |
| Export | Refresh from the published canvas. | Done: commits 197aeea8 and 48f0f6c4 |
| Harness | Emit each describing phrase with its target from the generator. This is a backend requirement for the harness, outside the web app. | Recorded for the harness session |

## What the generator has to emit

The desk renders phrases once its payload carries them; live briefings need the harness to emit them and the BFF to pass them through. For the briefing to read correctly, the generator should:
- emit each describing phrase as its own segment, with its target;
- break paragraphs with blank lines, because once a briefing contains a phrase, paragraphs break only there;
- put the punctuation that closes a claim at the start of the text segment that follows the claim's chip, where the web app keeps it on the chip's line.

Until the generator emits phrases, each text segment of a live briefing is its own paragraph. A segment that starts with the previous claim's punctuation would leave it stranded, so until then the claim keeps its punctuation in its own segment, before its chip.

## Follow-up decisions (2026-10-15)

After trying the boards, the user asked for one treatment wherever a reference to lines appears: "Lets consolidate the hover and active behavior to get the same treatment as the hover and active from the citation as it make the connection clearer". The briefing phrase, the briefing's citation chip and the margin pin are the three entry points.

| | Briefing phrase | Briefing citation chip | Margin pin |
|---|---|---|---|
| Hover or keyboard focus | Lights its lines | Lights its lines (was: nothing) | Lights its lines |
| Activate | Lands on its lines: the tint holds, then fades | Lands, and opens the marker's card | A marker pin lands on its lines, without scrolling when they are in view, and opens its card (was: the card's open outline only) |
| While a card is open | Same open state, whichever entry point opened it | | |

Exceptions to the Activate row: a phrase that names a marker also opens its card, and one that names a recorded review jumps to it. A chip whose source the diff doesn't show opens the source sheet instead. A comment pin opens its thread and lights its lines on hover, but doesn't land.

Reduced motion keeps the existing rule: no scroll animation, and the tint stays until the next action.

The user also chose **B** for clicks while a margin card is open: a click on a briefing phrase or chip closes the card and follows the link in one step. Any other click outside the card still only closes it.

Landed on 2026-10-15: code 397a5eea, canvas 54b5aab5 (published as version 1792066856-a00e), Pen 3f0e6e59. While a card is open, other margin pins stay dimmed and inert, as the margin already isolates them; briefing phrases and chips still light their lines. Touch and pen close a card on a tap, so a scroll gesture leaves it open.

## Engaged pins keep their lines lit (2026-10-15)

The user found that an active pin had no visible tie to its code: "active chips clicked from the context margin still does not have a proper visual signal on the code part, we need to either do outline or something like the hover...I cannot connect visually the context to the part of the code it relates to when the chip is active". Clicking a pin with several markers opened its list and darkened the pin, but marked no line. They left the treatment to the design side, with "Use best accessibility and design practices".

While a pin is engaged (its list is open, or one of its cards is open, whichever entry point opened it), its lines keep the hover tint, gain a 2px outline in the engaged-ring colour round the code cells only, and keep the stronger number-cell tint. The tint ties the code to the margin the same way hover does. The ring marks the held state without relying on colour alone. Both clear when the list or card closes.

Accessibility, decided on the same delegation: the outline uses a new ring token that reaches 3:1 against every row; comments, number literals, added and deleted signs and line numbers (now their own tokens) reach 4.55:1 on plain, hovered, engaged, landed and selected rows in both themes, with headroom for the browser's colour rounding; the read-only neighbour's ink reaches 4.55:1 on its own backgrounds; dark read-only rows step visibly from the surface; a focus ring shows only when a marker layer opens from the keyboard. apps/neuve-web/packages/ui/test/foundations/contrast.test.ts checks these pairs. A pinned list leaves the other pins usable; an open card or the comment composer dims them.

Landed on 2026-10-15: code 0030a946, eaf0dd2a, 8278d8c9, 2be80a9d, ade45129 and a30c1772; Pen b28af344; canvas 29ce7c22 (published as version 1792080600-37fa).
