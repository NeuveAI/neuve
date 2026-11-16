// First: it patches matchMedia before motion/react reads it.
import { motionConfigValue, setReducedMotion } from "./reduced-motion"
import type { ReducedMotionMode } from "./reduced-motion"

import * as React from "react"
import type { Decorator, Preview } from "@storybook/react-vite"
import { withThemeByClassName } from "@storybook/addon-themes"
import { MotionConfig } from "motion/react"

import { RAIL_COLLAPSED_STORAGE_KEY } from "@workspace/ui/neuve/review-desk/atoms"
import { VIEWED_FILES_STORAGE_KEY } from "@workspace/ui/neuve/review-desk/landing"

import "../src/styles/globals.css"

/**
 * The toolbar's reduced-motion mode drives motion/react and CSS together
 * (reduced-motion.ts). Setting it here, before the story renders, is the
 * synchronisation with that external shim (idempotent); the key remounts
 * the story so components that read the preference once read it again.
 */
const withReducedMotion: Decorator = (Story, context) => {
  const mode = (context.globals.reducedMotion ?? "system") as ReducedMotionMode
  setReducedMotion(mode)
  return (
    <MotionConfig reducedMotion={motionConfigValue(mode)}>
      <React.Fragment key={mode}>
        <Story />
      </React.Fragment>
    </MotionConfig>
  )
}

const preview: Preview = {
  globalTypes: {
    reducedMotion: {
      description: "Reduced motion (motion/react and CSS)",
      toolbar: {
        title: "Motion",
        icon: "accessibility",
        items: [
          { value: "system", title: "Motion: system setting" },
          { value: "reduce", title: "Reduced motion" },
          { value: "full", title: "Full motion" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { reducedMotion: "system" },
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
    a11y: { test: "todo" },
    backgrounds: { disable: true },
  },
  decorators: [
    withReducedMotion,
    withThemeByClassName({
      themes: { light: "", dark: "dark" },
      defaultTheme: "light",
      parentSelector: "html",
    }),
  ],
  // Hydrating the rail writes browser storage; without this a story seeded
  // collapsed would leave every later story collapsed. Viewed files likewise:
  // a seeded or clicked Viewed would fold files in every later desk story.
  beforeEach: () => {
    localStorage.removeItem(RAIL_COLLAPSED_STORAGE_KEY)
    localStorage.removeItem(VIEWED_FILES_STORAGE_KEY)
  },
}

export default preview
