/**
 * What a unit's briefing draws at its stop: which kind of text, whether
 * its changes are rows, and where the changes no agent decided go, with
 * their notes, and the decided ones with their suggestions, when a stop
 * draws no rows. Pure, so the rules the projection offers stops by
 * and the ones the desk draws by can be pinned together.
 */
import {
  explainedShows,
  rowExplained,
} from "@workspace/ui/neuve/shared/explained-rule"
import type { BriefingSection, ExplainedText } from "@workspace/ui/neuve/types"

/** Facts' sentence, Briefed's (and Guided's) claims, or Explained's Before and After. */
export type BriefingKind = "facts" | "claims" | "explained"

/**
 * The kind at the unit's stop. Explained shows by the shared rule
 * (`explainedShows`): the unit's own, or a row per change when every one
 * has its own; at Explained with neither, the claims stay.
 */
export function briefingKind(
  at: { factsOnly: boolean; atExplained: boolean } | undefined,
  explained: ExplainedText | undefined,
  sections: ReadonlyArray<BriefingSection> | undefined
): BriefingKind {
  if (at?.factsOnly) return "facts"
  if (at?.atExplained && explainedShows(explained, rowExplained(sections)))
    return "explained"
  return "claims"
}

/** A change no agent decided, of a unit some agent decided: its row says so. */
export const undecidedRow = (
  section: BriefingSection,
  unitUndecided: boolean
) => !!section.noAgentDecision && !unitUndecided

/**
 * Whether a joined unit's changes show as rows at this kind. Claims always
 * do. Facts do when every change has its own Facts, or, lacking them, its
 * "No agent decision" line to show in their place. Explained does when
 * every change has its own.
 */
export function rowedAt(
  kind: BriefingKind,
  sections: ReadonlyArray<BriefingSection> | undefined,
  unitUndecided: boolean
): boolean {
  if (sections === undefined) return false
  if (kind === "claims") return true
  if (kind === "facts")
    return sections.every(
      (section) => !!section.facts || undecidedRow(section, unitUndecided)
    )
  return explainedShows(undefined, rowExplained(sections)) === "rows"
}

/**
 * A change whose row isn't drawn, as the header says it: one no agent
 * decided, or one an agent decided and suggests a review for.
 */
export interface StrandedSection {
  id: string
  /** Leads its "No agent decision" line, or its suggestion. */
  title: string
  /** Why no agent decided it, under that line. */
  notes: ReadonlyArray<string>
  /** What an agent suggests for it, in place of that line. */
  suggestion?: BriefingSection["suggestion"]
}

/**
 * The changes of a unit some agent decided that say their state on their
 * row, while those rows aren't drawn: each for the header's slot, where its
 * title leads the "No agent decision" line and its notes follow, or leads
 * the agent's suggestion for it. So no change loses its line, with notes or
 * without, and no decided change loses its suggestion. A unit no agent
 * decided has none: its header says its one line and each reason once.
 */
export function strandedSections(
  sections: ReadonlyArray<BriefingSection> | undefined,
  rowed: boolean,
  unitUndecided: boolean
): Array<StrandedSection> {
  if (sections === undefined || rowed || unitUndecided) return []
  return sections.flatMap((section) =>
    undecidedRow(section, unitUndecided)
      ? [
          {
            id: section.id,
            title: section.title,
            notes: section.undecidedNotes ?? [],
          },
        ]
      : section.suggestion
        ? [
            {
              id: section.id,
              title: section.title,
              notes: [],
              suggestion: section.suggestion,
            },
          ]
        : []
  )
}

/**
 * Whether the notes Records wrote about the unit (`briefingNotes`) show
 * apart: where the briefing they lead isn't shown as text, at Facts and at
 * Explained without rows. A joined unit's lead shows them at Explained.
 */
export function notesApart(
  kind: BriefingKind,
  sections: ReadonlyArray<BriefingSection> | undefined
): boolean {
  return kind === "facts" || (kind === "explained" && sections === undefined)
}
