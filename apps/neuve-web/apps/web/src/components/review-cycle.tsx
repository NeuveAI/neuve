import { useSearch } from "@tanstack/react-router"
import type { ReviewOrigin } from "@neuve/records-schema"
import { EmbeddedRow } from "@workspace/ui/neuve/shared/app-header"
import { BrandMark } from "@workspace/ui/neuve/shared/brand-mark"
import { ThemeToggle } from "@workspace/ui/neuve/shared/theme-toggle"

type Cycle = {
  reference: string
  base: string
  head: string
  batches: { id: string; title: string }[]
  origins: ReviewOrigin[]
}
export function ReviewCycle({ cycle }: { cycle: Cycle | undefined }) {
  const search = useSearch({ strict: false })
  const query = new URLSearchParams()
  if (typeof search.returnTo === "string")
    query.set("returnTo", search.returnTo)
  const suffix = query.size ? `?${query}` : ""
  // Under the app's base: `/` on its own address, `/review/<project>/` in Ace.
  const base = import.meta.env.BASE_URL
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <header className="flex h-14 items-center gap-4 border-b border-line px-6 embedded:hidden">
        <a href={`${base}${suffix}`} aria-label="All reviews">
          <BrandMark />
        </a>
        <span className="ml-auto" />
        <a
          href={`${base}${suffix}`}
          className="text-sm text-ink-muted hover:text-ink"
        >
          All reviews
        </a>
        <ThemeToggle />
      </header>
      <EmbeddedRow />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        {cycle ? (
          <>
            <div className="space-y-2">
              <h1 className="text-xl font-medium">
                Review {cycle.reference.slice(-6)}
              </h1>
              <p className="font-mono text-sm text-ink-muted">
                {cycle.base.slice(0, 12)}..{cycle.head.slice(0, 12)}
              </p>
            </div>
            {cycle.batches.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {cycle.batches.map((batch) => (
                  <li key={batch.id}>
                    <a
                      className="block px-4 py-3 text-sm hover:bg-raised focus-visible:outline-focus"
                      href={`${base}batch/${encodeURIComponent(batch.id)}${suffix}`}
                    >
                      {batch.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="text-sm text-ink-muted">
                This review has no published batches yet. Its submitted range
                remains fixed. Updates appear here as Records publishes them.
              </p>
            )}
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Where this review started</h2>
              {cycle.origins.map((origin, index) => (
                <div key={index} className="space-y-1 text-sm">
                  {origin.kind === "channel" && (
                    <p className="text-ink-muted">
                      Channel {origin.channel}, chat {origin.chat}
                    </p>
                  )}
                  {origin.items.map((item) => (
                    <p key={item.url}>
                      <a
                        className="text-ink-muted underline-offset-3 hover:underline"
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.repo} #{item.number}
                      </a>
                    </p>
                  ))}
                </div>
              ))}
            </section>
          </>
        ) : (
          <>
            <h1 className="text-xl font-medium">Review not found</h1>
            <p className="text-sm text-ink-muted">
              Records does not contain this cycle in this repository.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
