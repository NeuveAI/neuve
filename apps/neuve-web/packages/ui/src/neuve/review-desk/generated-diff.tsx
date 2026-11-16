import { atom, useAtomValue, useSetAtom } from "jotai"
import { useId, useMemo } from "react"
import { motion, useReducedMotion } from "motion/react"
import { ChevronDownIcon } from "lucide-react"

import { EASE, TIMING, ms } from "@workspace/ui/lib/motion"
import {
  generatedOpenAtom,
  openCitationAtom,
  openSheetAtom,
  closeCardAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import { DiffFileCard } from "@workspace/ui/neuve/review-desk/diff-file"
import type { CommentContext } from "@workspace/ui/neuve/review-desk/diff-file"
import { cn } from "@workspace/ui/lib/utils"
import type { ReviewCommentRecord } from "@workspace/ui/neuve/review-comments/record"
import type {
  ContextualMarker,
  DiffFile,
  MarkerAnchor,
} from "@workspace/ui/neuve/types"

function lineCount(file: DiffFile): number {
  const lines = file.newContents.split("\n")
  return lines.at(-1) === "" ? lines.length - 1 : lines.length
}

/**
 * A static-automation unit's generated code: collapsed by default behind
 * "Show generated diff · N lines" (the checks already passed), expanding in
 * place into the normal diff with its margin. Same rise motion as the
 * read-only neighbor (DiffFileCard's collapsed state).
 */
export function GeneratedDiff({
  label,
  file,
  markers,
  commentAnchors,
  comments,
  commentContext,
  provenance,
}: {
  label: string
  file: DiffFile
  markers: Record<string, ContextualMarker>
  commentAnchors?: ReadonlyArray<MarkerAnchor>
  comments?: Record<string, ReviewCommentRecord>
  commentContext: CommentContext
  provenance?: Array<{ markerKey: string; summary: string }>
}) {
  const fixtureOpen = useAtomValue(generatedOpenAtom)
  const setFixtureOpen = useSetAtom(generatedOpenAtom)
  const recordedOpenAtom = useMemo(() => atom(false), [])
  const recordedOpen = useAtomValue(recordedOpenAtom)
  const setRecordedOpen = useSetAtom(recordedOpenAtom)
  const open = provenance ? recordedOpen : fixtureOpen
  const setOpen = provenance ? setRecordedOpen : setFixtureOpen
  const openCitation = useSetAtom(openCitationAtom)
  const openSheet = useSetAtom(openSheetAtom)
  const closeCard = useSetAtom(closeCardAtom)
  const reduce = useReducedMotion()
  const recordedRegionId = useId()
  const regionId = provenance
    ? `generated-${recordedRegionId}`
    : `generated-${file.path.replace(/[^a-z0-9]+/gi, "-")}`
  const lines = lineCount(file)

  return (
    <>
      {provenance && (
        <div className="flex flex-wrap gap-1.5 text-[11px] text-ink-muted">
          {provenance.map((value) => (
            <button
              key={value.markerKey}
              type="button"
              className="border-0 bg-transparent p-0 text-left font-mono text-ink-muted underline underline-offset-2"
              onClick={() => {
                openCitation(value.markerKey)
                openSheet()
                closeCard()
              }}
            >
              {value.summary}
            </button>
          ))}
        </div>
      )}
      <DiffFileCard
        file={file}
        markers={markers}
        commentAnchors={commentAnchors}
        comments={comments}
        commentContext={commentContext}
        collapsed={!open}
        surfaceId={regionId}
        header={
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={() => setOpen(!open)}
            className={cn(
              "box-border flex h-11 w-full items-center gap-2.5 rounded-[10px] border-0 bg-transparent px-3.5 text-left transition-colors duration-surface-tone ease-standard hover:bg-raised motion-reduce:transition-none",
              open && "rounded-b-none border-b border-solid border-line-2"
            )}
          >
            <motion.span
              aria-hidden="true"
              className="inline-flex text-ink-muted"
              animate={{ rotate: open ? 180 : 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { duration: ms(TIMING.chevron), ease: EASE.standard }
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </motion.span>
            <span className="text-[13px]">
              {open ? "Hide generated diff" : label}
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {lines} lines
            </span>
            <span className="flex-auto" />
            <span className="min-w-0 truncate font-mono text-[12px] text-ink-muted">
              {file.path}
            </span>
            <span className="font-mono text-[11.5px] text-add-fg">
              +{file.additions}
            </span>
            <span className="font-mono text-[11.5px] text-del-fg">
              −{file.deletions}
            </span>
          </button>
        }
      />
    </>
  )
}
