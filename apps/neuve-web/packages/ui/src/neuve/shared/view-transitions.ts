import type * as React from "react"

/**
 * View-transition names for router navigation (storyboard in
 * apps/web/src/router.tsx). Timing is PAGE in lib/motion.ts; the CSS in
 * globals.css reads it as the generated --nv-vt-* custom properties.
 *
 * The chrome stays put and the content moves in the direction of travel:
 * - `app-header`: the header (with the Agents control) never animates.
 * - content regions (class `page stage-N`): they leave together, then enter
 *   in stages; forward and back are typed.
 * - `rail`: the desk's unit rail; it fades in a beat after the content when
 *   it appears, and stays put desk → desk.
 * Each name is used by exactly one element per page. No shared-element
 * morphs: nothing is truly shared between the overview and the desk.
 */
export const APP_HEADER_TRANSITION = "app-header"
export const RAIL_TRANSITION = "rail"
/**
 * A named content region that takes part in the page transition. Each name
 * is used by one element per page, and names differ between kinds of page
 * (an overview region is never paired with a desk region, which would
 * stretch one snapshot into the other's box). The class carries the stage:
 * regions enter one after another (stage 1, 2, 3) once the old page is
 * gone. Desk → desk pairs the same regions.
 *
 * The name only applies while a view transition is active
 * (`html:active-view-transition [data-vt]` in globals.css): a named element
 * is its own stacking context, which would otherwise change how the desk's
 * layers (sticky file headers, the floating margin) stack outside a
 * transition.
 */
export type TransitionStage = 1 | 2 | 3

export interface TransitionProps {
  "data-vt": ""
  style: React.CSSProperties
}

function transitionProps(name: string, className: string): TransitionProps {
  return {
    "data-vt": "",
    style: {
      "--vt-name": name,
      "--vt-class": className,
    } as React.CSSProperties,
  }
}

export function regionTransition(
  name: string,
  stage: TransitionStage
): TransitionProps {
  return transitionProps(name, `page stage-${stage}`)
}

/** The desk's rail: opacity only, after the last region. */
export const railTransition: TransitionProps = transitionProps(
  RAIL_TRANSITION,
  "rail"
)

/** The header: static, never animated. */
export const headerTransition: TransitionProps = transitionProps(
  APP_HEADER_TRANSITION,
  "chrome"
)

/** View-transition types the router sets from the direction of travel. */
export type NavigationDirection = "forward" | "back"
