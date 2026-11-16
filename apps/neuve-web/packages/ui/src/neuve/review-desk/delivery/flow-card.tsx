import { useSetAtom } from "jotai"
import { RotateCcwIcon } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import {
  closeCardAtom,
  openCitationAtom,
  openSheetAtom,
} from "@workspace/ui/neuve/review-desk/atoms"
import { landOnAtom } from "@workspace/ui/neuve/review-desk/landing"
import { blockProps } from "@workspace/ui/neuve/review-desk/delivery/phased-layer"
import type {
  DeliveryFlow,
  DeliveryFlowEdge,
  DeliveryFlowNode,
  DeliveryFlowRow,
} from "@workspace/ui/neuve/shared/delivery"
import type {
  ContextualMarker,
  DiffFile,
  LineRange,
} from "@workspace/ui/neuve/types"

/** "29–36" or "34". */
export function rangeLabel(range: LineRange) {
  return range.start === range.end
    ? `${range.start}`
    : `${range.start}–${range.end}`
}

export function rangeAria(range: LineRange) {
  return range.start === range.end
    ? `line ${range.start}`
    : `lines ${range.start} to ${range.end}`
}

/** Chip look of a line reference (neutral: it cites lines, not a marker). */
export const LINE_CHIP =
  "inline-flex h-5 items-center gap-1 rounded-[5px] bg-raised px-1.5 font-mono text-[11px] leading-5 whitespace-nowrap text-ink-2"
export const LINE_CHIP_BUTTON = cn(
  LINE_CHIP,
  "cursor-pointer border-0 transition-colors duration-surface-tone ease-standard hover:bg-raised-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"
)

const NODE =
  "inline-flex h-7 items-center rounded-[7px] px-2.5 font-mono text-xs whitespace-nowrap"
const NODE_TONE = {
  plain: "bg-raised text-ink-2",
  fails: "bg-del-bg text-del-fg",
  end: "bg-raised-2 text-ink",
} as const

/** A row alternates node, edge, node… */
function items(row: DeliveryFlowRow) {
  return row.map((item, i) => ({ item, isNode: i % 2 === 0 }))
}

/** The source-sheet marker for a flow range (Guided has no diff to land in). */
export function flowSourceKey(filePath: string, range: LineRange) {
  return `delivery-flow:${filePath}:${range.side}:${range.start}-${range.end}`
}

/** Unchanged lines shown around a flow range in its source sheet. */
const SHEET_CONTEXT = 2

/**
 * Source-sheet markers for every range the flow cites, built from the
 * unit's own file contents (the cited lines plus a little context). Only
 * the source sheet reads them; they have no anchor, so no margin pin.
 */
export function flowSourceMarkers(
  flow: DeliveryFlow | undefined,
  files: ReadonlyArray<DiffFile>
): Record<string, ContextualMarker> {
  if (!flow) return {}
  const file = files.find((candidate) => candidate.path === flow.filePath)
  if (!file) return {}
  const ranges = [
    flow.range,
    // Each row alternates node, edge, node…: nodes sit at even indices.
    ...[flow.before, flow.after].flatMap((row) =>
      row.flatMap((item, i) =>
        i % 2 === 0 && (item as DeliveryFlowNode).range
          ? [(item as DeliveryFlowNode).range!]
          : []
      )
    ),
  ]
  const markers: Record<string, ContextualMarker> = {}
  for (const range of ranges) {
    const key = flowSourceKey(flow.filePath, range)
    if (markers[key]) continue
    const contents =
      range.side === "deletions" ? file.oldContents : file.newContents
    const all = contents.split("\n")
    const from = Math.max(1, range.start - SHEET_CONTEXT)
    const to = Math.min(all.length, range.end + SHEET_CONTEXT)
    const lines = all.slice(from - 1, to).map((text, i) => ({
      number: from + i,
      text,
      cited: from + i >= range.start && from + i <= range.end,
    }))
    const where = `${flow.filePath} · ${rangeAria(range)}`
    markers[key] = {
      key,
      tone: "source",
      short: "Source",
      peek: where,
      kindLabel: "Source · this unit",
      title: flow.title,
      meta: where,
      quote: lines
        .filter((line) => line.cited)
        .map((line) => line.text)
        .join("\n"),
      applies: "Cited by the flow of this change.",
      source: {
        kind: "Code",
        chips: [{ text: "Source", tone: "neutral" }],
        title: flow.filePath,
        subtitle: rangeAria(range),
        actions: [],
        facts: [
          { label: "File", value: flow.filePath, mono: true },
          { label: "Lines", value: rangeLabel(range), mono: true },
        ],
        blocks: [{ kind: "code", lines }],
        citedBy: ["This unit"],
      },
    }
  }
  return markers
}

/**
 * How it changes (Explained and Guided): a before/after flow from the graph.
 * With the diff shown (Explained) each box lands on its symbol; at Guided,
 * with no diff to land in, a box opens its lines in the source sheet. The
 * card itself never moves between Explained and Guided.
 */
export function FlowCard({
  flow,
  unitId,
  lands,
}: {
  flow: DeliveryFlow
  unitId: string
  /** The diff is shown, so boxes and the range land in it. */
  lands: boolean
}) {
  // The layer staggers the blocks (heading, Before, After); nothing here
  // animates itself.
  const block = blockProps()
  const landOn = useSetAtom(landOnAtom)
  const openCitation = useSetAtom(openCitationAtom)
  const openSheet = useSetAtom(openSheetAtom)
  const closeCard = useSetAtom(closeCardAtom)
  const go = (range: LineRange) => () => {
    if (lands) return landOn({ unitId, filePath: flow.filePath, range })
    openCitation(flowSourceKey(flow.filePath, range))
    openSheet()
    closeCard()
  }
  const action = (range: LineRange) =>
    lands
      ? `land on ${rangeAria(range)}`
      : `open ${rangeAria(range)} in the source`
  const rows = [
    { label: "Before", items: items(flow.before) },
    { label: "After", items: items(flow.after) },
  ]
  return (
    <section
      aria-label={flow.title}
      className="flex flex-col gap-3 rounded-xl bg-surface px-[18px] py-4 shadow-[0_0_0_1px_var(--nv-line)]"
    >
      <div {...block} className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 label-mono text-ink-muted">{flow.title}</h2>
        <button
          type="button"
          className={LINE_CHIP_BUTTON}
          aria-label={`${lands ? "Land on" : "Open"} ${rangeAria(flow.range)}${lands ? "" : " in the source"}`}
          aria-haspopup={lands ? undefined : "dialog"}
          onClick={go(flow.range)}
        >
          {rangeLabel(flow.range)}
          {lands && <span aria-hidden="true">↓</span>}
        </button>
      </div>
      <div className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-2 gap-y-2.5">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <span
              {...blockProps(`row-${row.label}`)}
              className="label-mono text-[10px] text-ink-muted"
            >
              {row.label}
            </span>
            <ol
              {...blockProps(`row-${row.label}`)}
              className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0"
            >
              {row.items.map(({ item, isNode }, i) => (
                <li key={i} className="inline-flex">
                  {isNode ? (
                    <FlowNode
                      node={item as DeliveryFlowNode}
                      lands={lands}
                      label={
                        (item as DeliveryFlowNode).range
                          ? `${(item as DeliveryFlowNode).label}: ${action((item as DeliveryFlowNode).range!)}`
                          : undefined
                      }
                      onOpen={
                        (item as DeliveryFlowNode).range
                          ? go((item as DeliveryFlowNode).range!)
                          : undefined
                      }
                    />
                  ) : (
                    <FlowEdge edge={item as DeliveryFlowEdge} />
                  )}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  )
}

function FlowNode({
  node,
  lands,
  label,
  onOpen,
}: {
  node: DeliveryFlowNode
  lands: boolean
  label?: string
  onOpen?: () => void
}) {
  const tone = NODE_TONE[node.tone ?? "plain"]
  if (!onOpen) return <span className={cn(NODE, tone)}>{node.label}</span>
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      aria-haspopup={lands ? undefined : "dialog"}
      className={cn(
        NODE,
        tone,
        "cursor-pointer border-0 transition-shadow duration-surface-tone ease-standard hover:shadow-[inset_0_0_0_1px_var(--nv-line-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none"
      )}
    >
      {node.label}
    </button>
  )
}

function FlowEdge({ edge }: { edge: DeliveryFlowEdge }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10.5px] whitespace-nowrap text-ink-muted">
      {edge.loop && (
        <RotateCcwIcon
          aria-hidden="true"
          strokeWidth={2.2}
          className="size-[11px]"
        />
      )}
      {edge.label && <span>{edge.label}</span>}
      <span aria-hidden="true">→</span>
    </span>
  )
}
