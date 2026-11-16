import { cn } from "@workspace/ui/lib/utils"

/**
 * REVIEW IDENTITY (changes/round-4.md § Review identity, Verdicts.dc.html)
 *
 *   identity   who: one avatar per actor, never altered by placement or state
 *   placement  where: size only (24 header · 20 cards, threads, margin · 16 rail)
 *   state      what happened: an icon and a verb beside the avatar (ReviewMark)
 */
export type AvatarSize = 16 | 20 | 24

/** A person as the identity needs them: a name for people, initials to show. */
export interface AvatarPerson {
  name: string
  initials: string
}

const PERSON_SIZE: Record<AvatarSize, string> = {
  16: "size-4 text-[7.5px]",
  20: "size-5 text-[8.5px]",
  24: "size-6 text-[9.5px]",
}

/**
 * A person: a chat bubble (radius 50% 50% 50% 14%, the familiar 11 11 11 3
 * at 22px) with their initials in Geist 600, ink-2 on raised-2. Neutral at
 * every size and in every state.
 *
 * Decorative by default (the name is beside it). Pass `label` when the
 * avatar stands alone so it carries the person's name.
 */
export function PersonAvatar({
  person,
  size = 20,
  label,
  className,
}: {
  person: Pick<AvatarPerson, "initials">
  size?: AvatarSize
  /** Accessible name when no visible name sits beside the avatar. */
  label?: string
  className?: string
}) {
  return (
    <span
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      data-avatar="person"
      data-size={size}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[50%_50%_50%_14%] bg-raised-2 font-sans leading-none font-semibold text-ink-2 select-none",
        PERSON_SIZE[size],
        className
      )}
    >
      {person.initials}
    </span>
  )
}
