import { useMemo, useRef } from "react"
import { atom, useAtom } from "jotai"
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import type {
  UnitHistoryPage,
  UnitHistoryLoader,
} from "@workspace/ui/neuve/types"

function FullRecord({
  unitId,
  recordId,
  loader,
}: {
  unitId: string
  recordId: string
  loader?: UnitHistoryLoader
}) {
  const openAtom = useMemo(() => atom(false), [])
  const [open, setOpen] = useAtom(openAtom)
  const query = useQuery({
    queryKey: ["unit-history-record", unitId, recordId],
    queryFn: () =>
      loader
        ? loader.record({ unitId, recordId })
        : Promise.resolve("Full record unavailable"),
    enabled: open && loader !== undefined,
    staleTime: Infinity,
    retry: false,
  })
  return (
    <details
      className="pt-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs text-ink-muted">
        Full record and references
      </summary>
      {open &&
        (!loader ? (
          <p className="text-xs text-ink-muted">
            Full record unavailable in this view.
          </p>
        ) : query.isPending ? (
          <p role="status" className="text-xs text-ink-muted">
            Loading record…
          </p>
        ) : query.isError ? (
          <div role="alert" className="text-xs text-req-fg">
            The record could not be loaded.{" "}
            <button type="button" onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <pre className="max-h-80 overflow-auto text-[11px] leading-4 break-all whitespace-pre-wrap">
            {query.data}
          </pre>
        ))}
    </details>
  )
}
function Records({
  page,
  loadPage,
}: {
  page: UnitHistoryPage
  loadPage?: UnitHistoryLoader
}) {
  const query = useInfiniteQuery({
    queryKey: ["unit-history", page.unitId, page.highWaterMark],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      loadPage
        ? loadPage.page({
            unitId: page.unitId,
            after: pageParam,
            through: page.highWaterMark,
          })
        : Promise.resolve(page),
    getNextPageParam: (last) =>
      loadPage ? (last.nextAfter ?? undefined) : undefined,
    initialData: { pages: [page], pageParams: [0] },
    staleTime: Infinity,
    retry: false,
  })
  const records = query.data.pages.flatMap((value) => value.records)
  return (
    <section
      aria-label="Recorded review history"
      className="flex flex-col gap-3"
    >
      <p role="status" className="text-xs text-ink-muted">
        {records.length} records loaded
        {query.hasNextPage || (!loadPage && page.nextAfter !== null)
          ? " · more available"
          : " · end of this snapshot"}
        . Snapshot through record {page.highWaterMark}.
      </p>
      {records.length === 0 && (
        <p className="text-sm text-ink-muted">
          No records were retained for this unit at this snapshot.
        </p>
      )}
      {records.map((record) => (
        <details
          key={record.id}
          className="rounded-lg border border-line-2 px-3 py-2"
        >
          <summary className="cursor-pointer text-[13px] font-medium text-ink">
            {record.title}
            <span className="block pt-1 text-xs font-normal text-ink-muted">
              {record.actor} · {record.occurredAt}
            </span>
          </summary>
          <p className="text-[13px] whitespace-pre-wrap">{record.summary}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-ink-muted">Record</dt>
            <dd className="m-0 font-mono break-all">{record.id}</dd>
            <dt className="text-ink-muted">Cycle</dt>
            <dd className="m-0 font-mono break-all">
              {record.cycleId ?? "No cycle recorded"}
            </dd>
            <dt className="text-ink-muted">Origin</dt>
            <dd className="m-0">{record.origin}</dd>
            <dt className="text-ink-muted">Saved</dt>
            <dd className="m-0">{record.recordedAt}</dd>
          </dl>
          <FullRecord
            unitId={page.unitId}
            recordId={record.id}
            loader={loadPage}
          />
        </details>
      ))}
      {query.isFetchNextPageError && (
        <p role="alert" className="text-xs text-req-fg">
          The next records could not be loaded. The displayed records remain
          available.
        </p>
      )}
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage
            ? "Loading records…"
            : query.isFetchNextPageError
              ? "Retry loading records"
              : "Load more records"}
        </Button>
      )}
      {!loadPage && page.nextAfter !== null && (
        <p className="text-xs text-ink-muted">
          More records are available through the ledger CLI.
        </p>
      )}
    </section>
  )
}
export function HistorySource(props: {
  page: UnitHistoryPage
  loadPage?: UnitHistoryLoader
}) {
  const client = useMemo(() => new QueryClient(), [])
  const page = useRef(props.page).current
  return (
    <QueryClientProvider client={client}>
      <Records page={page} loadPage={props.loadPage} />
    </QueryClientProvider>
  )
}
