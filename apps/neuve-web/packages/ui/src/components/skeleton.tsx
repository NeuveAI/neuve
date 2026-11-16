import { cn } from "@workspace/ui/lib/utils"

/**
 * Neuve skeleton: a raised-tone block that breathes (opacity only, the
 * `nv-skeleton` keyframes in globals.css, animate-skeleton: TIMING.skeleton)
 * when motion is allowed and
 * stays a static tint under reduced motion. No gradient sweep.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "rounded-md bg-raised motion-safe:animate-skeleton",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
