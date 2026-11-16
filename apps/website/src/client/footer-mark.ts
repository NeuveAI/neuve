import {
  REDUCED,
  byId,
  clamp01,
  emphasizedDecelerate,
  hash,
  onTheme,
  once,
  rgba,
  token,
} from "./motion";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD · the footer mark
 *
 * The Neuve mark (the Logo component's paths) drawn in + and − glyphs
 * on a dot grid.
 *    0ms   in view: glyphs gather into the mark from the dot grid,
 *          each at a hash of its cell, over 2.2s (emphasized
 *          decelerate)
 *  rest    still. Under a mouse the mark resolves to solid ink in a
 *          soft lens; nothing moves otherwise
 * reduced  the finished mark, no lens
 * ───────────────────────────────────────────────────────── */
export const FOOT = { gather: 2200, lens: 110, height: 0.85, ratio: 1.25 };

/** Gathers the mark again (the dev tuning panel's Replay). */
export let replayFooterMark = () => {};

export function initFooterMark(frozen: boolean) {
  const mf = byId("markfield"),
    cv = byId<HTMLCanvasElement>("mark-canvas");
  const ctx = cv.getContext("2d");
  const svg = mf.querySelector("svg");
  if (!ctx || !svg) return;
  const path = new Path2D(
    [...svg.querySelectorAll("path")]
      .map((p) => p.getAttribute("d") ?? "")
      .join(" "),
  );
  const cell = innerWidth < 640 ? 6 : 8;
  let grid: {
    w: number;
    h: number;
    cols: number;
    rows: number;
    inside: Float32Array;
    ch: number;
  } | null = null;
  let pointer: { x: number; y: number } | null = null,
    lens = 0,
    start: number | null = REDUCED || frozen ? -1e9 : null,
    raf = 0;
  let ink = token("ink"),
    faint = token("faint");

  const layout = () => {
    const dpr = Math.min(2, devicePixelRatio || 1),
      r = mf.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ch = cell * FOOT.ratio,
      cols = Math.floor(r.width / cell),
      rows = Math.floor(r.height / ch);
    const off = document.createElement("canvas");
    off.width = Math.max(1, cols);
    off.height = Math.max(1, rows);
    const o = off.getContext("2d");
    if (!o) return;
    const size = rows * FOOT.height;
    o.setTransform(
      (size / 306) * FOOT.ratio,
      0,
      0,
      size / 306,
      (cols - size * FOOT.ratio) / 2,
      (rows - size) / 2,
    );
    o.fill(path);
    const data = o.getImageData(0, 0, off.width, off.height).data;
    const inside = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++)
      inside[i] = (data[i * 4 + 3] ?? 0) / 255;
    grid = { w: r.width, h: r.height, cols, rows, inside, ch };
  };
  const draw = (now: number) => {
    if (!grid) return;
    const { cols, rows, inside, ch } = grid;
    ctx.clearRect(0, 0, grid.w, grid.h);
    const g = start === null ? 0 : clamp01((now - start) / FOOT.gather);
    ctx.font = `500 ${cell + 1}px "Geist Mono Variable", ui-monospace, monospace`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const v = inside[y * cols + x] ?? 0,
          px = x * cell + cell / 2,
          py = y * ch + ch / 2;
        const l =
          pointer && lens > 0
            ? clamp01(
                1 - Math.hypot(px - pointer.x, py - pointer.y) / FOOT.lens,
              ) * lens
            : 0;
        if (v > 0.5) {
          const k = emphasizedDecelerate(
            clamp01((g - hash(x, y, 9) * 0.55) / 0.45),
          );
          if (l > 0.35 && k >= 1) {
            ctx.fillStyle = rgba(ink, 0.92);
            ctx.fillRect(x * cell + 0.5, y * ch + 0.5, cell - 1, ch - 1);
            continue;
          }
          if (k > 0) {
            ctx.fillStyle = rgba(ink, 0.85 * k);
            ctx.fillText(hash(x, y, 3) < 0.7 ? "+" : "−", px, py);
          }
          if (k < 1) {
            ctx.fillStyle = rgba(faint, 0.5 * (1 - k));
            ctx.fillText("·", px, py);
          }
        } else if (x % 3 === 0 && y % 2 === 0) {
          ctx.fillStyle = rgba(faint, 0.45 + l * 0.3);
          ctx.fillText("·", px, py);
        }
      }
  };
  const loop = (now: number) => {
    lens += ((pointer ? 1 : 0) - lens) * 0.14;
    draw(now);
    const busy =
      (start !== null && now - start < FOOT.gather + 50) ||
      pointer ||
      Math.abs(lens) > 0.01;
    raf = busy ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(loop);
  };
  once(
    mf,
    () => {
      if (start === null) start = performance.now();
      kick();
    },
    0.4,
  );
  replayFooterMark = () => {
    if (REDUCED || frozen) return;
    start = performance.now();
    kick();
  };
  mf.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || REDUCED) return;
    const r = mf.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    kick();
  });
  mf.addEventListener("pointerleave", () => {
    pointer = null;
    kick();
  });
  layout();
  draw(performance.now());
  new ResizeObserver(() => {
    layout();
    draw(performance.now());
  }).observe(mf);
  onTheme.push(() => {
    ink = token("ink");
    faint = token("faint");
    draw(performance.now());
  });
  document.fonts?.ready.then(() => draw(performance.now()));
}
