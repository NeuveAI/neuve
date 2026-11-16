import { atom, useAtomValue, useSetAtom } from "jotai"
import {
  CheckIcon,
  CopyIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react"

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Button } from "@workspace/ui/components/button"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { Disclosure } from "@workspace/ui/neuve/shared/disclosure"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"

/** How long "Copied" stays before the button reads "Copy" again (ms). */
const COPIED_MS = 1600

/** The detail last copied, while its confirmation shows. */
const copiedDetailAtom = atom<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

const copyDetailAtom = atom(null, async (_get, set, detail: string) => {
  await navigator.clipboard.writeText(detail)
  set(copiedDetailAtom, detail)
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => set(copiedDetailAtom, null), COPIED_MS)
})

/** Technical detail, collapsed: mono text and a copy button. */
function ErrorDetails({ detail }: { detail: string }) {
  const copied = useAtomValue(copiedDetailAtom) === detail
  const copy = useSetAtom(copyDetailAtom)
  return (
    <Disclosure
      label="Details"
      className="w-full text-left"
      contentClassName="pl-2.5"
    >
      <div className="flex flex-col gap-2 rounded-lg bg-raised p-3">
        <pre className="m-0 max-h-60 overflow-auto font-mono text-[11.5px] leading-[18px] wrap-anywhere whitespace-pre-wrap text-ink-2">
          {detail}
        </pre>
        <Button
          type="button"
          variant="quiet"
          size="compact"
          className="self-end"
          onClick={() => void copy(detail).catch(() => undefined)}
        >
          {copied ? (
            <CheckIcon data-icon="inline-start" aria-hidden="true" />
          ) : (
            <CopyIcon data-icon="inline-start" aria-hidden="true" />
          )}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
    </Disclosure>
  )
}

/**
 * A page that failed to load: a plain sentence, Retry, and the technical
 * detail folded into a mono "Details" disclosure with a copy button (round 3,
 * item 16). The message is announced once (role="alert": critical, not
 * interstitial); Retry reloads the route's data.
 */
export function ErrorPage({
  title = "This page didn’t load",
  message,
  detail,
  onRetry,
}: {
  title?: string
  /** One plain sentence for the reviewer. */
  message?: string
  /** Technical detail (an error message, a validation path), collapsed. */
  detail?: string
  onRetry?: () => void
}) {
  return (
    <div className="flex min-h-svh flex-col bg-paper font-sans text-sm text-ink">
      <AppHeader />
      <main
        {...regionTransition("state", 1)}
        className="flex flex-auto content-fade items-center justify-center px-6 pt-16 pb-24"
      >
        <Empty className="max-w-[520px]">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-req-tint text-req-ink">
              <TriangleAlertIcon aria-hidden="true" strokeWidth={1.75} />
            </EmptyMedia>
            <EmptyTitle>
              <h1 className="m-0 text-inherit">{title}</h1>
            </EmptyTitle>
            <EmptyDescription role="alert">
              {message ?? "Something went wrong while loading it."}
            </EmptyDescription>
          </EmptyHeader>
          {(onRetry || detail) && (
            <EmptyContent>
              {onRetry && (
                <Button
                  type="button"
                  variant="ink"
                  size="dock"
                  onClick={onRetry}
                >
                  <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                  Retry
                </Button>
              )}
              {detail && <ErrorDetails detail={detail} />}
            </EmptyContent>
          )}
        </Empty>
      </main>
    </div>
  )
}
