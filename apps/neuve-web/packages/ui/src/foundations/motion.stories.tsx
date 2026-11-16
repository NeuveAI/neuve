import type { Meta, StoryObj } from "@storybook/react-vite"
import { atom, useAtom } from "jotai"
import { motion, useReducedMotionConfig } from "motion/react"
import type * as React from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { tokenNotes } from "@workspace/ui/foundations/inventory"
import { Group, Name, Sheet } from "@workspace/ui/foundations/sheet"
import { codeSources } from "@workspace/ui/foundations/sources"
import {
  CSS_ANIMATIONS,
  CSS_DELAYS,
  CSS_UTILITIES,
  EASE,
  OFFSET,
  OPACITY,
  PAGE,
  SCALE,
  SPRING,
  TIMING,
  cssBezier,
  cssName,
  cssSpring,
} from "@workspace/ui/lib/motion"

/**
 * Every motion token in lib/motion.ts with a live demo: TIMING as bars that
 * fill over their duration, EASE as plotted curves with a dot moving on
 * them, SPRING as plotted step responses with a dot on motion/react and one
 * on the CSS linear() twin. Each row names the CSS variable and utilities
 * (styles/motion.css). Replay restarts every demo; under reduced motion
 * (the toolbar's Motion menu, or the system setting) they hold their end
 * state, as the product does.
 */
const NOTES = tokenNotes(codeSources["packages/ui/src/lib/motion.ts"] ?? "")
const replayAtom = atom(0)
const UTILITY = {
  duration: new Set<string>(CSS_UTILITIES.duration),
  delay: new Set<string>(CSS_UTILITIES.delay),
  ease: new Set<string>(CSS_UTILITIES.ease),
}

/** The sheet's own keyframes; the reduced rule mirrors the product's. */
const DEMO_CSS = `
@keyframes nv-fd-fill { from { transform: scaleX(0) } }
@keyframes nv-fd-move { from { translate: 0 } to { translate: var(--fd-travel) } }
.nv-fd-fill { transform-origin: left; animation: nv-fd-fill var(--fd-dur) var(--nv-ease-linear) both }
.nv-fd-move { animation: nv-fd-move var(--fd-dur) var(--fd-ease) both }
@media (prefers-reduced-motion: reduce) {
  .nv-fd-fill, .nv-fd-move { animation: none }
  .nv-fd-move { translate: var(--fd-travel) }
}
`

/** Demo span for the easing curves: long enough to read a curve. */
const EASE_DEMO = "working"
const TRAVEL = 160

type CustomStyle = React.CSSProperties & Record<`--${string}`, string>

function Row({
  children,
  token,
}: {
  children: React.ReactNode
  token: string
}) {
  return (
    <div
      data-motion-token={token}
      className="grid grid-cols-[200px_220px_minmax(0,1fr)] items-center gap-4 border-b border-line-2 py-2.5 last:border-b-0"
    >
      {children}
    </div>
  )
}

function Label({
  table,
  name,
  value,
}: {
  table: keyof typeof NOTES
  name: string
  value: string
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="font-medium">
        {table}.{name}{" "}
        <span className="font-mono text-[11.5px] text-ink-muted">{value}</span>
      </span>
      {NOTES[table]?.[name] && (
        <span className="text-xs text-faint">{NOTES[table][name]}</span>
      )}
    </span>
  )
}

function Names({ names }: { names: Array<string | false> }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      {names.filter(Boolean).map((name) => (
        <Name key={name as string}>{name}</Name>
      ))}
    </span>
  )
}

/** A curve on a 0–1 square, drawn from points (x = time, y = progress). */
function Plot({ points, testId }: { points: string; testId?: string }) {
  return (
    <svg
      viewBox="-4 -24 108 128"
      className="size-14 shrink-0 overflow-visible text-ink-2"
      aria-hidden="true"
      data-testid={testId}
    >
      <rect x="0" y="0" width="100" height="100" className="fill-raised" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
    </svg>
  )
}

function bezierPoints(curve: ReadonlyArray<number>) {
  const [x1, y1, x2, y2] = curve as [number, number, number, number]
  const at = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3
  return Array.from({ length: 41 }, (_, index) => {
    const t = index / 40
    return `${at(t, x1, x2) * 100},${100 - at(t, y1, y2) * 100}`
  }).join(" ")
}

function springPoints(spring: { stiffness: number; damping: number }) {
  const values = /linear\((.*)\)/
    .exec(cssSpring(spring).easing)![1]!
    .split(", ")
    .map(Number)
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100
      return `${x},${100 - value * 100}`
    })
    .join(" ")
}

function Track({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative block h-2.5 w-[200px] rounded-full bg-raised">
      {children}
    </span>
  )
}

function Dot({ style, className }: { style: CustomStyle; className?: string }) {
  return (
    <span
      className={`absolute top-[-1px] left-0 block size-3 rounded-full bg-brand ${className ?? ""}`}
      style={style}
    />
  )
}

function MotionSheet() {
  const [replay, setReplay] = useAtom(replayAtom)
  const reduce = useReducedMotionConfig() ?? false
  return (
    <Sheet
      title="Motion"
      lede="lib/motion.ts is the source; styles/motion.css carries it into CSS. Each row: the token, its CSS variable and utilities, and a live demo."
    >
      <style>{DEMO_CSS}</style>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setReplay((count) => count + 1)}
          className="inline-flex h-8 press items-center rounded-lg border-0 bg-ink px-3 text-[12.5px] font-medium text-paper"
        >
          Replay
        </button>
        <span
          data-reduced-state={reduce ? "on" : "off"}
          className="text-[12.5px] text-ink-muted"
        >
          {reduce
            ? "Reduced motion is on: demos hold their end state, as the product does."
            : "Reduced motion is off. Set it in the toolbar's Motion menu."}
        </span>
      </div>

      <Group label="Timing" note="bar fills over the duration, linearly">
        {Object.entries(TIMING).map(([key, value]) => {
          const name = cssName(key)
          return (
            <Row key={`${key}-${replay}`} token={`dur-${name}`}>
              <Label table="TIMING" name={key} value={`${value}ms`} />
              <Names
                names={[
                  `--nv-dur-${name}`,
                  UTILITY.duration.has(name) && `duration-${name}`,
                  UTILITY.delay.has(name) && `delay-${name}`,
                ]}
              />
              <Track>
                <span
                  data-demo="bar"
                  className="nv-fd-fill absolute inset-0 rounded-full bg-brand"
                  style={{ "--fd-dur": `var(--nv-dur-${name})` } as CustomStyle}
                />
              </Track>
            </Row>
          )
        })}
      </Group>

      <Group
        label="Easing"
        note={`dot crosses in TIMING.${EASE_DEMO} (${TIMING[EASE_DEMO]}ms) so the curve reads`}
      >
        {Object.entries(EASE).map(([key, curve]) => {
          const name = cssName(key)
          return (
            <Row key={`${key}-${replay}`} token={`ease-${name}`}>
              <Label table="EASE" name={key} value={`[${curve.join(", ")}]`} />
              <Names
                names={[
                  `--nv-ease-${name}`,
                  UTILITY.ease.has(name)
                    ? `ease-${name}`
                    : "no utility (Tailwind's own keeps its curve)",
                ]}
              />
              <span className="flex items-center gap-4">
                <Plot points={bezierPoints(curve)} />
                <Track>
                  <Dot
                    className="nv-fd-move"
                    style={{
                      "--fd-dur": `var(--nv-dur-${cssName(EASE_DEMO)})`,
                      "--fd-ease": `var(--nv-ease-${name})`,
                      "--fd-travel": `${TRAVEL - 12}px`,
                    }}
                  />
                </Track>
              </span>
            </Row>
          )
        })}
      </Group>

      <Group
        label="Springs"
        note="top dot: motion/react; bottom dot: the CSS linear() twin over its settle time"
      >
        {Object.entries(SPRING).map(([key, spring]) => {
          const name = cssName(key)
          const css = cssSpring(spring)
          return (
            <Row key={`${key}-${replay}`} token={`spring-${name}`}>
              <Label
                table="SPRING"
                name={key}
                value={`${spring.stiffness} / ${spring.damping}`}
              />
              <Names
                names={[
                  `--nv-spring-${name}`,
                  `--nv-spring-${name}-dur (${css.duration}ms)`,
                  `ease-spring-${name} duration-spring-${name}`,
                ]}
              />
              <span className="flex items-center gap-4">
                <Plot points={springPoints(spring)} />
                <span className="flex flex-col gap-2">
                  <Track>
                    <motion.span
                      data-demo="spring"
                      className="absolute top-[-1px] left-0 block size-3 rounded-full bg-brand"
                      initial={{ x: 0 }}
                      animate={{ x: TRAVEL - 12 }}
                      transition={spring}
                    />
                  </Track>
                  <Track>
                    <Dot
                      className="nv-fd-move"
                      style={{
                        "--fd-dur": `var(--nv-spring-${name}-dur)`,
                        "--fd-ease": `var(--nv-spring-${name})`,
                        "--fd-travel": `${TRAVEL - 12}px`,
                      }}
                    />
                  </Track>
                </span>
              </span>
            </Row>
          )
        })}
      </Group>

      <Group label="Loops" note="static under reduced motion">
        {Object.entries(CSS_ANIMATIONS).map(([name]) => (
          <Row key={name} token={`animate-${name}`}>
            <span className="font-medium">CSS_ANIMATIONS.{name}</span>
            <Names names={[`animate-${name}`]} />
            <span
              data-demo="loop"
              className={
                name === "skeleton"
                  ? "block h-3 w-40 rounded-md bg-raised-2 motion-safe:animate-skeleton"
                  : name === "working-spin"
                    ? "block size-4 rounded-full border-2 border-line border-t-brand motion-safe:animate-working-spin"
                    : "block size-4 rounded-full border-2 border-line border-t-brand motion-safe:animate-pending-spin"
              }
            />
          </Row>
        ))}
      </Group>

      <Group label="Amplitudes">
        {(
          [
            ["OFFSET", OFFSET, "px", "offset"],
            ["SCALE", SCALE, "", "scale"],
            ["OPACITY", OPACITY, "", "opacity"],
          ] as const
        ).flatMap(([table, values, unit, prefix]) =>
          Object.entries(values).map(([key, value]) => (
            <Row key={`${table}-${key}`} token={`${prefix}-${cssName(key)}`}>
              <Label table={table} name={key} value={`${value}${unit}`} />
              <Names names={[`--nv-${prefix}-${cssName(key)}`]} />
              <span className="flex h-6 items-center">
                <span
                  className="block size-4 rounded-[4px] bg-brand"
                  style={
                    prefix === "offset"
                      ? { translate: `var(--nv-offset-${cssName(key)})` }
                      : prefix === "scale"
                        ? { scale: `var(--nv-scale-${cssName(key)})` }
                        : { opacity: `var(--nv-opacity-${cssName(key)})` }
                  }
                />
              </span>
            </Row>
          ))
        )}
      </Group>

      <Group label="Page transition" note="PAGE, as --nv-vt-* (forward)">
        {(
          [
            ["exit", 0, PAGE.exit],
            ["stage 1", PAGE.exit + PAGE.beat, PAGE.enter],
            ["stage 2", PAGE.exit + PAGE.beat + PAGE.stagger, PAGE.enter],
            [
              "stage 3",
              PAGE.exit + PAGE.beat + 2 * PAGE.stagger,
              PAGE.enterLast,
            ],
            ["rail", PAGE.railDelay, PAGE.rail],
          ] as const
        ).map(([label, start, length]) => (
          <div
            key={label}
            className="grid grid-cols-[80px_minmax(0,440px)_120px] items-center gap-4 py-1"
          >
            <span className="text-[12.5px]">{label}</span>
            <span className="relative block h-2.5 rounded-full bg-raised">
              <span
                className="absolute inset-y-0 rounded-full bg-brand"
                style={{
                  left: `${(start / 440) * 100}%`,
                  width: `${(length / 440) * 100}%`,
                }}
              />
            </span>
            <span className="font-mono text-[11px] text-faint">
              {start} → {start + length}ms
            </span>
          </div>
        ))}
        <span className="pt-2">
          <Names
            names={Object.keys(PAGE).map(
              (key) => `--nv-vt-${cssName(key)}: PAGE.${key}`
            )}
          />
        </span>
      </Group>
    </Sheet>
  )
}

const meta = {
  title: "Foundations/Motion",
  component: MotionSheet,
} satisfies Meta<typeof MotionSheet>

export default meta
type Story = StoryObj<typeof meta>

/** CSS reads the same value motion.ts holds, for every TIMING key. */
async function expectTimingInCss(canvasElement: HTMLElement) {
  const root = getComputedStyle(document.documentElement)
  for (const [key, value] of Object.entries(TIMING))
    await expect(
      root.getPropertyValue(`--nv-dur-${cssName(key)}`).trim(),
      `TIMING.${key}`
    ).toBe(`${value}ms`)
  const rows = canvasElement.querySelectorAll("[data-motion-token^='dur-']")
  await expect(rows.length).toBe(Object.keys(TIMING).length)
  for (const delay of CSS_DELAYS)
    await expect(canvasElement).toHaveTextContent(`delay-${cssName(delay)}`)
}

export const Tokens: Story = {
  globals: { reducedMotion: "full" },
  play: async ({ canvasElement }) => {
    await expectTimingInCss(canvasElement)
    const canvas = within(canvasElement)
    await expect(
      canvasElement.querySelector("[data-reduced-state]")
    ).toHaveAttribute("data-reduced-state", "off")
    // Bars run on their token's duration.
    const bars =
      canvasElement.querySelectorAll<HTMLElement>("[data-demo='bar']")
    for (const [index, value] of Object.values(TIMING).entries())
      await expect(getComputedStyle(bars[index]!).animationDuration).toBe(
        `${value / 1000}s`
      )
    // Replay remounts the demos: the 12s capture bar starts again.
    const before = canvasElement.querySelector(
      "[data-motion-token='dur-capture'] [data-demo='bar']"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Replay" }))
    const capture = canvasElement.querySelector<HTMLElement>(
      "[data-motion-token='dur-capture'] [data-demo='bar']"
    )!
    await expect(capture).not.toBe(before)
    await expect(
      Number(capture.getAnimations()[0]?.currentTime ?? TIMING.capture)
    ).toBeLessThan(TIMING.capture / 2)
    // The motion/react spring dot arrives.
    await waitFor(() =>
      expect(
        canvasElement.querySelector<HTMLElement>("[data-demo='spring']")!.style
          .transform
      ).toContain(`translateX(${TRAVEL - 12}px)`)
    )
  },
}

export const ReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    await expectTimingInCss(canvasElement)
    await expect(
      canvasElement.querySelector("[data-reduced-state]")
    ).toHaveAttribute("data-reduced-state", "on")
    for (const demo of canvasElement.querySelectorAll<HTMLElement>(
      "[data-demo='bar'], [data-demo='loop']"
    ))
      await expect(getComputedStyle(demo).animationName).toBe("none")
    // motion/react jumps to the end on the first frame.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await expect(
      canvasElement.querySelector<HTMLElement>("[data-demo='spring']")!.style
        .transform
    ).toContain(`translateX(${TRAVEL - 12}px)`)
  },
}

export const TokensDark: Story = {
  globals: { theme: "dark", reducedMotion: "full" },
  play: async ({ canvasElement }) => expectTimingInCss(canvasElement),
}
