import { cn } from "@workspace/ui/lib/utils"
import { Logo } from "@workspace/ui/neuve/shared/logo"

/**
 * Neuve logomark + logotype used in both headers (from neuve_effect).
 * `logotypeClassName` lets a header drop the word where it has no room.
 */
export function BrandMark({
  className,
  logotypeClassName,
}: {
  className?: string
  logotypeClassName?: string
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-[17px] font-semibold tracking-normal text-ink",
        className
      )}
    >
      <Logo className="size-[22px] shrink-0 text-ink" />
      <span className={logotypeClassName}>Neuve</span>
    </span>
  )
}
