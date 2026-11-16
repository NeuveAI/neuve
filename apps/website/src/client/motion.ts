import { EASE, SPRING } from "@workspace/ui/lib/motion";

/** Motion helpers over Neuve's tokens (@workspace/ui/lib/motion), for canvas and FLIP work. */

export const REDUCED =
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export type Spring = { readonly stiffness: number; readonly damping: number };

/** A CSS cubic-bezier as a function of progress (0–1). */
export function bezier([x1, y1, x2, y2]: readonly number[]): (
  x: number,
) => number {
  const ax1 = x1 ?? 0,
    ay1 = y1 ?? 0,
    ax2 = x2 ?? 1,
    ay2 = y2 ?? 1;
  const cx = 3 * ax1,
    bx = 3 * (ax2 - ax1) - cx,
    ax = 1 - cx - bx;
  const cy = 3 * ay1,
    by = 3 * (ay2 - ay1) - cy,
    ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t;
  const Y = (t: number) => ((ay * t + by) * t + cy) * t;
  const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (X(t) - x) / d;
    }
    return Y(Math.min(1, Math.max(0, t)));
  };
}

export const emphasizedDecelerate = bezier(EASE.emphasizedDecelerate);

/** A spring's unit step response at `s` seconds (mass 1), as motion/react draws it. */
export function spring(
  { stiffness: k, damping: c }: Spring,
  s: number,
): number {
  if (s <= 0) return 0;
  const w = Math.sqrt(k),
    z = c / (2 * w);
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    return (
      1 -
      Math.exp(-z * w * s) *
        (Math.cos(wd * s) + ((z * w) / wd) * Math.sin(wd * s))
    );
  }
  return 1 - Math.exp(-w * s) * (1 + w * s);
}

/** A spring as a CSS linear() easing over `ms`. */
export function cssSpring(sp: Spring, ms: number): string {
  const pts: number[] = [];
  for (let i = 0; i <= 40; i++)
    pts.push(+spring(sp, ((i / 40) * ms) / 1000).toFixed(4));
  pts[40] = 1;
  return `linear(${pts.join(",")})`;
}

export { SPRING };

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Deterministic noise from three integers: the same cell always draws the same glyph. */
export function hash(a: number, b: number, c: number): number {
  let x =
    Math.imul(a | 0, 374761393) ^
    Math.imul(b | 0, 668265263) ^
    Math.imul(c | 0, 1440662683);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export type RGB = readonly [number, number, number];

/** A --nv-* token's current value, as RGB, for canvas drawing. */
export function token(name: string): RGB {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--nv-${name}`)
    .trim();
  if (raw.startsWith("#") && raw.length >= 7)
    return [
      parseInt(raw.slice(1, 3), 16),
      parseInt(raw.slice(3, 5), 16),
      parseInt(raw.slice(5, 7), 16),
    ];
  const m = raw.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
}

export const rgba = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/**
 * Runs `fn` once, the first time `el` is really in view: at least `threshold`
 * of it, or, for an element taller than the screen, enough of it to fill half
 * the screen. The observer's first callback reports any partial overlap as
 * "intersecting" even below the threshold, so the share is checked here
 * rather than trusted (the owner saw "Where it's heading" play before it
 * came into view).
 */
export function once(el: Element, fn: () => void, threshold = 0.35) {
  if (!("IntersectionObserver" in window)) return fn();
  const io = new IntersectionObserver(
    (es) => {
      if (es.some((e) => inView(e, threshold))) {
        io.disconnect();
        fn();
      }
    },
    { threshold: STEPS },
  );
  io.observe(el);
}

/**
 * Calls `fn(true)` whenever `el` comes into view by the same rule as `once`,
 * and `fn(false)` whenever it leaves it, for as long as the page is open.
 */
export function whileInView(
  el: Element,
  fn: (seen: boolean) => void,
  threshold = 0.35,
) {
  if (!("IntersectionObserver" in window)) return;
  new IntersectionObserver(
    (es) => {
      const e = es.at(-1);
      if (e) fn(inView(e, threshold));
    },
    { threshold: STEPS },
  ).observe(el);
}

const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

/** At least `threshold` of the element is on screen, or enough of it to fill
 * half the screen. */
function inView(e: IntersectionObserverEntry, threshold: number) {
  if (!e.isIntersecting) return false;
  const screen = e.rootBounds?.height ?? innerHeight;
  return (
    e.intersectionRatio >= threshold ||
    e.intersectionRect.height >= screen * 0.5
  );
}

export const byId = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el as T;
};

/** Listeners that redraw canvases when the theme changes. */
export const onTheme: Array<() => void> = [];
