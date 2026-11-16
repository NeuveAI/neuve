/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Loading skeletons
 *
 *    0ms   route pending for 150ms (pendingMs): the skeleton appears, no
 *          fade (it must not flash on fast loads)
 *  loop    blocks breathe, opacity 1 → .55 → 1 (animate-skeleton 1400ms,
 *          ease-in-out) — only when motion is allowed
 *  ≥400ms  shown for at least pendingMinMs, then the content region
 *          replaces it and fades in (content-fade 160ms, standard) — unless
 *          a page view transition is running, which wins
 *
 * Every block reserves the real element's box, so the swap shifts nothing.
 * Reduced motion: static raised tint, content appears without the fade.
 * ───────────────────────────────────────────────────────── */

import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import { BrandMark } from "@workspace/ui/neuve/shared/brand-mark"
import {
  headerTransition,
  railTransition,
  regionTransition,
} from "@workspace/ui/neuve/shared/view-transitions"

/**
 * The header while loading: the brand is real, the rest is reserved at the
 * loaded header's sizes, so it wraps where that header wraps and the page
 * holds still when it arrives. Each page's header differs: the Reviews
 * page's breadcrumb is the repository and "Reviews", with no Agents
 * control; a batch's (overview, desk, lineage) is repository / branch and
 * the commit, then the Agents control. On a phone (narrower than 600px)
 * both take the header's two rows (app-header.tsx), the breadcrumb below
 * the controls.
 */
function HeaderSkeleton({ page }: { page: "reviews" | "batch" }) {
  const batch = page === "batch"
  return (
    <header
      {...headerTransition}
      className="box-border flex min-h-14 flex-wrap items-center gap-4 border-b border-line px-5 py-2 max-[600px]:gap-x-2 max-[600px]:gap-y-1 max-[600px]:px-4"
    >
      <BrandMark
        className="max-[600px]:mr-auto"
        logotypeClassName="max-[360px]:hidden"
      />
      <span
        className={cn(
          "flex min-w-0 items-center gap-2 max-[600px]:order-last max-[600px]:h-[21px] max-[600px]:w-auto max-[600px]:basis-full",
          batch ? "h-[20.4px] w-[315px]" : "h-[18.6px] w-[109px]"
        )}
      >
        <Skeleton
          className={cn(
            "h-4 max-[600px]:min-w-0",
            batch ? "w-[220px]" : "w-[109px]"
          )}
        />
        {batch && <Skeleton className="h-5 w-16 shrink-0" />}
      </span>
      <span className="flex-auto max-[600px]:hidden" />
      {batch && (
        <Skeleton className="h-[34px] w-[224px] rounded-[9px] max-[600px]:w-[110px]" />
      )}
      <Skeleton className="h-8 w-[95px] rounded-lg max-[600px]:w-8" />
      <Skeleton className="size-9 rounded-lg" />
      <Skeleton className="size-9 rounded-lg" />
    </header>
  )
}

/** Page wrapper: busy while loading, named for assistive tech. */
function Loading({
  label,
  header = "batch",
  className,
  children,
}: {
  label: string
  /** Whose header the page loads into (HeaderSkeleton). */
  header?: "reviews" | "batch"
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      role="region"
      className={cn(
        "flex min-h-svh flex-col bg-paper font-sans text-sm text-ink",
        className
      )}
    >
      <HeaderSkeleton page={header} />
      {children}
    </div>
  )
}

/**
 * The Reviews page while its reviews load: the heading, the panel, the list
 * bar and a page of rows, each at its real size.
 */
export function ReviewsSkeleton() {
  return (
    <Loading label="Loading reviews" header="reviews">
      <div
        {...regionTransition("reviews-loading", 1)}
        className="mx-auto box-border flex w-full max-w-[1180px] flex-col gap-10 px-6 pt-14 pb-24 max-[600px]:px-4"
      >
        <section className="flex flex-col gap-5">
          <Skeleton className="h-[46px] w-[180px] rounded-lg" />
          <div className="flex items-end justify-between gap-6 rounded-[16px] bg-surface p-5 shadow-[0_0_0_1px_var(--nv-line)]">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-7 w-[240px] max-w-full" />
              <Skeleton className="h-4 w-[90px]" />
            </div>
            <Skeleton className="h-11 w-[132px] rounded-[10px]" />
          </div>
        </section>
        <section className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-7 w-[150px]" />
            <Skeleton className="h-9 w-[220px] rounded-lg" />
          </div>
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-3.5 w-[60px]" />
            <div className="overflow-hidden rounded-[14px] bg-surface shadow-[0_0_0_1px_var(--nv-line)]">
              {[0, 1, 2, 3, 4].map((row) => (
                <div
                  key={row}
                  className={cn(
                    "flex min-h-16 items-center gap-6 px-5 py-3",
                    row > 0 && "border-t border-line-2"
                  )}
                >
                  <div className="flex flex-auto flex-col gap-1.5">
                    <Skeleton className="h-[22px] w-[420px] max-w-full" />
                    <Skeleton className="h-4 w-[260px] max-w-full" />
                  </div>
                  <Skeleton className="h-4 w-[110px] max-[760px]:hidden" />
                  <Skeleton className="h-4 w-[160px] max-[760px]:hidden" />
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </Loading>
  )
}

/**
 * Batch overview while its review batch loads: hero lines, the meta row, the
 * lane bar and the judgment table rows, each at its real size.
 */
export function BatchOverviewSkeleton() {
  return (
    <Loading label="Loading the review batch">
      <div
        {...regionTransition("overview-loading", 1)}
        className="mx-auto box-border flex w-full max-w-[1180px] flex-col gap-14 px-6 pt-14 pb-24"
      >
        <section className="flex max-w-[760px] flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-[38px] w-[92%] rounded-lg" />
            <Skeleton className="h-[38px] w-[55%] rounded-lg" />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {[72, 150, 70, 64].map((width, i) => (
              <Skeleton key={i} className="h-[18px]" style={{ width }} />
            ))}
          </div>
          <div className="flex flex-col gap-2 pt-1">
            <Skeleton className="h-[19px] w-full" />
            <Skeleton className="h-[19px] w-[96%]" />
            <Skeleton className="h-[19px] w-[40%]" />
            <Skeleton className="mt-1 h-4 w-[240px]" />
          </div>
          <div className="pt-2">
            <Skeleton className="h-11 w-[200px] rounded-[10px]" />
          </div>
        </section>
        {/* The lane bar (lane-bar.tsx): a thin bar, then the legend. */}
        <section className="flex flex-col gap-2.5">
          <div className="flex h-2.5 gap-[3px] overflow-hidden rounded-[5px]">
            {[4, 3, 7, 12].map((grow, i) => (
              <Skeleton
                key={i}
                className="rounded-[2px]"
                style={{ flex: `${grow} 1 0` }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {[223, 137, 115, 139].map((width, i) => (
              <span key={i} className="flex h-[18px] items-center">
                <Skeleton className="h-3" style={{ width }} />
              </span>
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-3">
          {/* SECTION_HEADING's line box is 31px plus mb-1: a 28px bar and
          7px below keep the table where it lands. */}
          <Skeleton className="mb-[7px] h-7 w-[220px]" />
          <div className="overflow-hidden rounded-[14px] bg-surface shadow-[0_0_0_1px_var(--nv-line)]">
            <div className="border-b border-line-2 px-5 py-3">
              <Skeleton className="h-3.5 w-[60%]" />
            </div>
            {[0, 1].map((row) => (
              <div
                key={row}
                className={cn(
                  "flex items-center gap-5 px-5 py-4",
                  row > 0 && "border-t border-line-2"
                )}
              >
                <div className="flex flex-auto flex-col gap-1.5">
                  <Skeleton className="h-[22px] w-[300px] max-w-full" />
                  <Skeleton className="ml-5 h-[18px] w-[200px]" />
                </div>
                {[112, 150, 120, 112].map((width, i) => (
                  <Skeleton
                    key={i}
                    className="h-[18px] max-[900px]:hidden"
                    style={{ width }}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>
    </Loading>
  )
}

/**
 * Diff rows shaped like the renderer's (unified, 2-digit numbers): one
 * number cell at 11.5px mono, 2ch padding, old and new numbers 1.5ch apart,
 * 2.2ch before a 2px edge (68.9px), then code 1ch in at 12.5px (76.4px).
 */
const ROWS = [
  { indent: 0, width: 62, tone: "ctx" },
  { indent: 2, width: 44, tone: "ctx" },
  { indent: 2, width: 40, tone: "del" },
  { indent: 2, width: 58, tone: "del" },
  { indent: 2, width: 36, tone: "add" },
  { indent: 2, width: 64, tone: "add" },
  { indent: 2, width: 80, tone: "add" },
  { indent: 2, width: 50, tone: "add" },
  { indent: 2, width: 30, tone: "ctx" },
  { indent: 0, width: 4, tone: "ctx" },
] as const

function DiffCardSkeleton() {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-auto overflow-hidden rounded-[10px] bg-surface shadow-[0_0_0_1px_var(--nv-line)]">
        <div className="flex h-11 items-center gap-2.5 border-b border-line-2 px-3.5">
          <Skeleton className="h-3.5 w-[180px]" />
          <Skeleton className="h-3.5 w-12" />
        </div>
        <div className="flex h-7 items-center bg-expand px-3.5">
          <Skeleton className="h-3 w-[150px]" />
        </div>
        {ROWS.map((row, i) => (
          <div
            key={i}
            className={cn(
              "grid h-6 grid-cols-[auto_minmax(0,1fr)] items-center font-mono text-[11.5px]",
              row.tone === "add" && "bg-add-bg",
              row.tone === "del" && "bg-del-bg"
            )}
          >
            <div
              data-skeleton-gutter=""
              className={cn(
                "flex h-full items-center gap-[1.5ch] border-r-2 border-transparent pr-[2.2ch] pl-[2ch]",
                row.tone === "add" && "bg-add-num",
                row.tone === "del" && "bg-del-num"
              )}
            >
              {(["old", "new"] as const).map((side) =>
                (side === "old" && row.tone === "add") ||
                (side === "new" && row.tone === "del") ? (
                  <span key={side} className="w-[2ch]" />
                ) : (
                  <Skeleton
                    key={side}
                    className="h-2.5 w-[2ch] rounded-[3px]"
                  />
                )
              )}
            </div>
            <div className="min-w-0 pl-[1ch] text-[12.5px]">
              <Skeleton
                data-skeleton-code=""
                className="h-2.5 rounded-[3px]"
                style={{
                  width: `${row.width}%`,
                  marginLeft: `${row.indent}ch`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {/* A quiet margin: two pin-sized blocks, no cards. */}
      <div className="flex shrink-0 grow-0 basis-[300px] flex-col gap-1.5 pt-[172px] max-[1180px]:basis-[260px] max-[860px]:hidden">
        <Skeleton className="h-[22px] w-[52px]" />
        <Skeleton className="h-[22px] w-[110px]" />
      </div>
    </div>
  )
}

/**
 * Review desk while its review unit loads: header, rail rows, briefing
 * lines, the toolbar, and a diff file card with gutter-shaped rows beside a
 * quiet margin.
 */
export function ReviewDeskSkeleton() {
  return (
    <Loading label="Loading the review unit" className="shell:h-svh">
      <div className="flex flex-auto flex-wrap items-stretch shell:min-h-0 shell:flex-nowrap">
        <nav
          aria-hidden="true"
          {...railTransition}
          className="box-border flex max-w-full flex-[1_1_272px] flex-col gap-6 border-r border-line pt-4 pr-3 pb-5 pl-4"
        >
          <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 gap-y-1.5 p-2.5">
            <Skeleton className="row-span-2 size-8 rounded-lg" />
            <Skeleton className="h-3 w-[90px]" />
            <Skeleton className="h-4 w-[170px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Skeleton className="mx-2.5 mb-2 h-3.5 w-[140px]" />
            {[0, 1].map((row) => (
              <div key={row} className="flex flex-col gap-2 p-2.5">
                <Skeleton className="h-4 w-[85%]" />
                <Skeleton className="h-3 w-[60px]" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2.5">
            <Skeleton className="mx-2.5 mb-1 h-3 w-[170px]" />
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="flex items-center gap-2.5 px-2.5 py-[9px]"
              >
                <Skeleton className="size-2.5 rounded-[3px]" />
                <Skeleton className="h-3.5 w-[110px]" />
                <span className="flex-auto" />
                <Skeleton className="h-3 w-4" />
              </div>
            ))}
          </div>
        </nav>
        <main
          {...regionTransition("desk-loading", 1)}
          className="relative flex min-w-0 flex-[999_1_560px] flex-col"
        >
          <div className="flex flex-auto flex-col shell:absolute shell:inset-0 shell:overflow-hidden">
            <div className="flex gap-1 px-8 pt-4">
              <Skeleton className="h-[30px] w-[60px] rounded-[7px]" />
              <Skeleton className="h-[30px] w-[52px] rounded-[7px] opacity-60" />
            </div>
            <div className="flex max-w-[1060px] flex-col gap-3 px-8 pt-7 pb-5">
              <Skeleton className="h-3.5 w-[180px]" />
              <Skeleton className="h-[30px] w-[420px] max-w-full rounded-lg" />
              <div className="flex max-w-[660px] flex-col gap-2 pt-1">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-[94%]" />
                <Skeleton className="h-4 w-[52%]" />
              </div>
            </div>
            <div className="flex items-center gap-4 px-8 pb-3">
              <Skeleton className="h-9 w-[170px] rounded-lg" />
              <Skeleton className="h-[30px] w-[72px] rounded-[7px]" />
              <Skeleton className="h-3 w-[220px]" />
            </div>
            <div className="flex flex-col gap-5 px-8 pb-10">
              <DiffCardSkeleton />
            </div>
          </div>
        </main>
      </div>
    </Loading>
  )
}

/** Commit lineage while it loads. */
export function LineageSkeleton() {
  return (
    <Loading label="Loading what changed">
      <div
        {...regionTransition("lineage-loading", 1)}
        className="mx-auto box-border flex w-full max-w-[1080px] flex-col gap-7 px-6 pt-8 pb-24"
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[30px] w-[130px] rounded-lg" />
          <Skeleton className="h-9 w-[380px] max-w-full rounded-lg" />
        </div>
        <div className="flex flex-col gap-1">
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="grid grid-cols-[minmax(0,1fr)_148px_minmax(0,1fr)] items-center gap-4 px-4 py-3.5"
            >
              <Skeleton className="h-[18px] w-[75%]" />
              <Skeleton className="h-3.5 w-[110px] justify-self-center" />
              <div className="flex flex-col gap-1">
                <Skeleton className="h-[18px] w-[70%]" />
                <Skeleton className="h-3.5 w-[40%]" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Loading>
  )
}
