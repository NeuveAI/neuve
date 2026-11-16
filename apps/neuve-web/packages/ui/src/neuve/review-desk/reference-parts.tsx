import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"
import { useFeedbackTarget } from "@workspace/ui/neuve/review-desk/feedback/atoms"
import {
  GRADE_LABEL,
  STANCE_LABEL,
  pathParts,
} from "@workspace/ui/neuve/review-desk/reference-tie"
import type { DeskFeedback, ReferenceTie } from "@workspace/ui/neuve/types"

/**
 * A cited file named for reading: the file name first, its folder quiet
 * below. In the card the folder keeps its end and drops its start ("…/
 * review-desk"); in the sheet it wraps whole. Assistive tech reads the path
 * once, as written.
 */
export function PathLabel({
  path,
  size = "card",
  className,
}: {
  path: string
  size?: "card" | "sheet"
  className?: string
}) {
  const { name, folder } = pathParts(path)
  return (
    <span className={cn("flex min-w-0 flex-col", className)}>
      <span className="sr-only">{path}</span>
      <span
        aria-hidden="true"
        className={cn(
          "font-semibold tracking-[-0.01em] wrap-break-word text-ink",
          size === "card"
            ? "text-[13.5px] leading-[19px]"
            : "text-lg leading-6 tracking-[-0.015em]"
        )}
      >
        {name}
      </span>
      {folder && (
        <span
          aria-hidden="true"
          // The folder's end says the most: with right-to-left flow the
          // ellipsis falls at its start; the bdi keeps the path reading left
          // to right.
          dir={size === "card" ? "rtl" : undefined}
          className={cn(
            "font-mono text-ink-muted",
            size === "card"
              ? "truncate text-left text-[10.5px] leading-4"
              : "text-xs leading-[18px] wrap-break-word"
          )}
        >
          <bdi dir="ltr">
            {size === "card" ? folder : <BreakAfterSlashes path={folder} />}
          </bdi>
        </span>
      )}
    </span>
  )
}

/** A path that wraps after its slashes, never inside a folder's name. */
function BreakAfterSlashes({ path }: { path: string }) {
  const parts = path.split("/")
  return parts.map((part, i) => (
    <React.Fragment key={i}>
      {/* Whole on a line when it fits; a name longer than the line still wraps. */}
      <span className="inline-block max-w-full wrap-anywhere">
        {part}
        {i < parts.length - 1 && "/"}
      </span>
      {i < parts.length - 1 && <wbr />}
    </React.Fragment>
  ))
}

/**
 * A reference's reason, led by one word for how it bears on the change:
 * "Supports. The desk adapter maps…". Contradicts takes the decision tone;
 * an unclear fit is muted, so it never reads as support. Other props reach
 * the paragraph, so the sheet can make it the dialog's description.
 */
export function ReferenceWhy({
  tie,
  why,
  inline = false,
  className,
  ...props
}: {
  tie: ReferenceTie
  why: string
  /** Inside a button (the line's list): a span, which a button may hold. */
  inline?: boolean
} & React.ComponentProps<"p">) {
  const Text = inline ? "span" : "p"
  return (
    <Text {...props} className={cn("m-0 text-pretty text-ink", className)}>
      <span
        className={cn(
          "font-semibold",
          tie.stance === "contradicts" && "text-req-ink",
          tie.stance === "unresolved" && "text-ink-muted"
        )}
      >
        {STANCE_LABEL[tie.stance]}.
      </span>{" "}
      {why}
    </Text>
  )
}

/**
 * "Before you decide": the one thing to check, under a quiet label. No box:
 * it follows the reason as its conclusion.
 */
export function BeforeYouDecide({
  check,
  children,
  className,
}: {
  check: string
  /** The check's one action, when it has one. */
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="label-mono text-[10px]">Before you decide</span>
      <p className="m-0 text-pretty text-ink-2">{check}</p>
      {children}
    </div>
  )
}

/**
 * The harness's grade, in the words the owner grades with, only while the
 * owner's feedback is on. It reads the same grade the feedback answer
 * records as visible, so the two never disagree.
 */
export function HarnessGrade({
  markerKey,
  className,
}: {
  markerKey: string
  className?: string
}) {
  // The hook returns the plain target; a reference's carries the grade.
  const feedback: DeskFeedback["references"][string] | undefined =
    useFeedbackTarget((desk) => desk.references[markerKey])
  const grade = feedback?.harnessGrade
  if (!grade) return null
  const label =
    grade === "necessary" || grade === "useful" ? GRADE_LABEL[grade] : grade
  return (
    <p className={cn("m-0 text-[11.5px] leading-4 text-ink-muted", className)}>
      Harness grade: {label}
    </p>
  )
}
