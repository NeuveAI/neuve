import { createCn } from "cn/config"

import { CSS_UTILITIES } from "@workspace/ui/lib/motion"

/**
 * clsx + tailwind-merge, taught the motion utilities from motion.ts
 * (duration-surface-tone, delay-switch-wait, ease-standard, animate-skeleton),
 * so a later duration-* / delay-* / ease-* / animate-* replaces an earlier one
 * instead of both landing on the element.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      duration: [{ duration: [...CSS_UTILITIES.duration] }],
      delay: [{ delay: [...CSS_UTILITIES.delay] }],
      ease: [{ ease: [...CSS_UTILITIES.ease] }],
      animate: [{ animate: [...CSS_UTILITIES.animate] }],
    },
  },
})
