import { BATCH, FINDERS, FINDINGS } from "../content";
import {
  REDUCED,
  SPRING,
  byId,
  clamp01,
  emphasizedDecelerate,
  hash,
  onTheme,
  once,
  rgba,
  whileInView,
  spring,
  token,
  type RGB,
} from "./motion";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD · hero, one review on one batch
 *
 * Plays once when a quarter of the stage is in view. The headline
 * never moves; its landing tint plays at 300ms on load (entry-client).
 * It pauses when less than that quarter is in view (or, on a screen
 * shorter than the stage, less than half the screen holds it) and
 * resumes from the same moment when it is back: the clock, the frame
 * loop and the rows' transitions stop, so nothing runs off-screen (the
 * owner's ask).
 *
 * Four phases, staggered: each one completes and rests (about 0.9s,
 * nothing moving) before the next begins, and inside a phase its items
 * start one after another (staggered, so some overlap) so the eye can
 * follow each. Second pass, after the owner found the first slow-down
 * still too quick.
 *
 *  0.0s   the range: every changed line as a + or − glyph, at rest
 *  0.6s   GATHER: lines gather into 26 parts (review units), one every
 *         60ms, each over 0.8s                              step 1
 *         the range stays behind at 20%
 *  2.9s   rest: 26 parts, no changed line left out
 *  3.8s   FIND: one agent at a time, each kept finding pops from its
 *         unit (SPRING.snappy) and travels to its agent's row
 *         (SPRING.responsive at 2× its time), one every 160ms  step 2
 * ~7.1s   rest: 16 findings in four rows
 *  8.0s   CHECK: a hairline crosses each agent's row in turn, 0.4s
 *         apart, 1.2s each. Verified findings fill; the rest become
 *         dashed rings at 35%, counted, never shown
 * 10.4s   rest: 9 verified, 7 counted
 * 11.3s   LAND: verified findings fly to You one every 0.26s, 0.9s
 *         each, growing 8 → 10px; the first per agent lands as a row
 *         that fades in (0.48s) and flashes --nv-lit (1.2s); the count
 *         ticks 0 → 9                                       step 3
 * 14.8s   at rest: all three steps lit
 * waiting  a step whose phase hasn't begun is dimmed (.wait); until the
 *          first finding lands, step 3 shows a "Waiting" status and
 *          skeleton rows in place of its findings (the owner, 17 November)
 * reduced  the final state, drawn at once
 *
 * The values are tunable live in `vite dev` (client/tune.ts, DialKit).
 * ───────────────────────────────────────────────────────── */
export const TIMING = {
  gather: 600, // lines start gathering into units
  gatherEach: 60, // between units
  gatherDur: 800, // each unit's gather
  find: 3800, // findings leave their units
  findEach: 160, // between findings
  findPop: 240, // a finding pops at its unit before it travels
  travelPace: 2, // SPRING.responsive's travel, stretched in time
  check: 8000, // the first row's check hairline starts
  checkEach: 400, // between the four rows
  checkDur: 1200, // each row's crossing
  you: 11300, // verified findings fly to You
  youEach: 260, // between them
  youDur: 900, // each flight
  rowIn: 480, // a landed row fades and rises in
  rowFlash: 1200, // and its --nv-lit flash fades
  end: 14800, // at rest, once the ninth finding has landed
};
/** The share of the stage in view that starts the hero, and below which it
 * pauses. One rule both ways, so it never starts and pauses at once. */
const IN_VIEW = 0.25;
/** When agent row `f`'s check starts. */
const checkAt = (f: number) => TIMING.check + f * TIMING.checkEach;
/** When each of the three steps lights: frame and split, then find and
 * check, then validate and decide as findings land; all three at rest. */
const stepAt = () => [0, TIMING.find, TIMING.you];

/** The CSS durations the stage's rows use, from the same table. */
export function applyHeroTiming() {
  const stage = document.getElementById("stage");
  stage?.style.setProperty("--row-in", `${TIMING.rowIn}ms`);
  stage?.style.setProperty("--row-flash", `${TIMING.rowFlash}ms`);
}
const CELL = {
  field: 11,
  row: 13,
  glyph: 10,
  tile: 5,
  tileSq: 4,
  tileCols: 3,
  mark: 8,
  markEnd: 10,
};

type Unit = { i: number; n: number; ci: number };
type Cell = { u: Unit; k: number; g: "+" | "−"; fi: number };
type Mark = {
  f: number;
  j: number;
  ok: boolean;
  unit: number;
  kind: "defect" | "question";
  order: number;
  row: number;
};
type Box = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
type Drawn = Pt & { size: number; state: -1 | 0 | 1; a: number };

/** The sample batch, deterministic: the same page always draws the same units, lines and findings. */
function batch() {
  const units: Unit[] = Array.from({ length: BATCH.units }, (_, i) => ({
    i,
    n: 6 + Math.floor(hash(i, 3, 7) * 9),
    ci: 0,
  }));
  const last = units[units.length - 1]!;
  last.n += BATCH.lines - units.reduce((a, u) => a + u.n, 0);
  units
    .map((u) => ({ u, o: hash(u.i, 9, 2) }))
    .sort((a, b) => a.o - b.o)
    .forEach(({ u }, ix) => (u.ci = ix));
  const cells: Cell[] = [];
  for (const u of units)
    for (let k = 0; k < u.n; k++)
      cells.push({ u, k, g: hash(u.i, k, 1) < 0.7 ? "+" : "−", fi: 0 });
  cells
    .map((c) => ({ c, o: c.u.ci + hash(c.u.i, c.k, 5) * 2.2 }))
    .sort((a, b) => a.o - b.o)
    .forEach(({ c }, ix) => (c.fi = ix));
  const marks: Mark[] = [];
  let order = 0;
  FINDERS.forEach((f, fi) =>
    f.kept.forEach((ok, j) =>
      marks.push({
        f: fi,
        j,
        ok,
        unit: Math.floor(hash(fi, j, 4) * BATCH.units),
        kind: f.key === "scope" ? "question" : "defect",
        order: order++,
        row: -1,
      }),
    ),
  );
  const verified = marks.filter((m) => m.ok);
  const used = new Set<number>();
  for (const m of verified) {
    const r = FINDINGS.findIndex((x) => x.finder === FINDERS[m.f]!.key);
    if (r >= 0 && !used.has(r)) {
      m.row = r;
      used.add(r);
    }
  }
  return { units, cells, marks, verified };
}

export function initHero(freezeAt: number | null) {
  const stage = byId("stage");
  const cv = byId<HTMLCanvasElement>("sort-canvas");
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const finders = byId("finders");
  const frows = byId("frows");
  const rows = [...frows.querySelectorAll<HTMLElement>(".frow")];
  const steps = [...stage.querySelectorAll<HTMLElement>(".stage-steps > li")];
  const youN = byId("you-n");
  const foot = stage.querySelector<HTMLElement>(".you-f");
  const you = byId("you");
  const { units, cells, marks, verified } = batch();

  let C: Record<string, RGB> = {};
  const colours = () => {
    C = Object.fromEntries(
      ["ink", "ink-2", "add-fg", "del-fg", "req", "line-strong"].map((k) => [
        k,
        token(k),
      ]),
    );
  };
  colours();

  frows.addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button");
    if (!b) return;
    const row = b.parentElement!;
    const open = !row.classList.contains("open");
    row.classList.toggle("open", open);
    b.setAttribute("aria-expanded", String(open));
  });

  let G: {
    fx: number;
    fy: number;
    cols: number;
    tiles: Array<Pt & { h: number }>;
    tracks: Box[];
    markPos: Pt[];
    slots: Pt[];
    count: Pt;
  };
  const rel = (el: Element): Box => {
    const s = stage.getBoundingClientRect(),
      r = el.getBoundingClientRect();
    return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
  };
  const layout = () => {
    const dpr = Math.min(2, devicePixelRatio || 1),
      s = stage.getBoundingClientRect();
    cv.width = Math.round(s.width * dpr);
    cv.height = Math.round(s.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const f = rel(byId("field"));
    const cols = Math.max(8, Math.floor((f.w - 24) / CELL.field)),
      rowsN = Math.ceil(cells.length / cols);
    const fx = f.x + (f.w - cols * CELL.field) / 2,
      fy = f.y + Math.max(10, (f.h - rowsN * CELL.row) / 2);
    const slotW = CELL.tileCols * CELL.tile + 9,
      slotH = 6 * CELL.tile + 9;
    const perRow = Math.max(4, Math.floor((f.w - 20) / slotW)),
      tRows = Math.ceil(units.length / perRow);
    const tx0 = f.x + (f.w - perRow * slotW) / 2 + 4,
      ty0 = f.y + (f.h - tRows * slotH) / 2;
    const tiles = units.map((u) => ({
      x: tx0 + (u.ci % perRow) * slotW,
      y: ty0 + Math.floor(u.ci / perRow) * slotH,
      h: Math.ceil(u.n / CELL.tileCols) * CELL.tile,
    }));
    const tracks = [...finders.querySelectorAll(".track")].map(rel);
    const markPos = marks.map((m) => {
      const t = tracks[m.f]!,
        pitch = Math.min(20, (t.w - 16) / 4);
      return { x: t.x + 8 + m.j * pitch, y: t.y + t.h / 2 };
    });
    const slots = [...frows.querySelectorAll(".slot")].map((el) => {
      const r = rel(el);
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    });
    const head = rel(stage.querySelector(".you-h b")!);
    G = {
      fx,
      fy,
      cols,
      tiles,
      tracks,
      markPos,
      slots,
      count: { x: head.x + 6, y: head.y + head.h / 2 },
    };
  };

  const cellAt = (c: Cell, t: number) => {
    const tile = G.tiles[c.u.i]!;
    const fieldX = G.fx + (c.fi % G.cols) * CELL.field,
      fieldY = G.fy + Math.floor(c.fi / G.cols) * CELL.row;
    const tileX = tile.x + (c.k % CELL.tileCols) * CELL.tile,
      tileY = tile.y + Math.floor(c.k / CELL.tileCols) * CELL.tile;
    const pg = emphasizedDecelerate(
      clamp01(
        (t - TIMING.gather - c.u.ci * TIMING.gatherEach) / TIMING.gatherDur,
      ),
    );
    return {
      fieldX,
      fieldY,
      pg,
      x: fieldX + (tileX - fieldX) * pg,
      y: fieldY + (tileY - fieldY) * pg,
      glyph: 1 - clamp01(pg * 1.6),
      size: CELL.glyph + (CELL.tileSq - CELL.glyph) * pg,
      col: c.g === "+" ? C["add-fg"]! : C["del-fg"]!,
    };
  };
  const markAt = (m: Mark, t: number): Drawn | null => {
    const tile = G.tiles[m.unit]!,
      to = G.markPos[m.order]!;
    const t0 = TIMING.find + m.order * TIMING.findEach;
    if (t < t0) return null;
    const pop = spring(SPRING.snappy, (t - t0) / 1000),
      travel = spring(
        SPRING.responsive,
        (t - t0 - TIMING.findPop) / 1000 / TIMING.travelPace,
      );
    const fromX = tile.x + 7,
      fromY = tile.y + tile.h / 2;
    const tr = G.tracks[m.f]!,
      c0 = checkAt(m.f),
      passX = tr.x + (tr.w + 40) * clamp01((t - c0) / TIMING.checkDur) - 20;
    const state = t > c0 && passX > to.x ? (m.ok ? 1 : -1) : 0;
    return {
      x: fromX + (to.x - fromX) * travel,
      y: fromY + (to.y - fromY) * travel,
      size: CELL.mark * clamp01(pop),
      state,
      a: state === -1 ? 1 - 0.65 * clamp01((passX - to.x) / 80) : 1,
    };
  };
  const flightAt = (m: Mark, t: number): Drawn | null => {
    const f0 = TIMING.you + verified.indexOf(m) * TIMING.youEach;
    if (t < f0) return null;
    const p = emphasizedDecelerate(clamp01((t - f0) / TIMING.youDur));
    if (p >= 1) return null;
    const from = G.markPos[m.order]!,
      dest = m.row >= 0 ? G.slots[m.row]! : G.count;
    return {
      x: from.x + (dest.x - from.x) * p,
      y: from.y + (dest.y - from.y) * p,
      size: CELL.mark + (CELL.markEnd - CELL.mark) * p,
      state: 1,
      a: m.row >= 0 ? 1 : 1 - clamp01((p - 0.6) / 0.4),
    };
  };
  const drawMark = (p: Drawn, kind: Mark["kind"], alpha = 1) => {
    ctx.save();
    ctx.globalAlpha = p.a * alpha;
    ctx.translate(p.x, p.y);
    const r = p.size / 2;
    ctx.beginPath();
    if (p.state === 1 && kind === "defect") {
      ctx.fillStyle = rgba(C.req!);
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
    } else if (p.state === 1) {
      ctx.fillStyle = rgba(C["ink-2"]!);
      ctx.arc(0, 0, r * 0.75, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = rgba(p.state === -1 ? C["line-strong"]! : C.ink!);
      ctx.lineWidth = p.state === -1 ? 1.2 : 1.4;
      if (p.state === -1) ctx.setLineDash([2, 2]);
      ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  let stageT = 0;
  const draw = (t: number) => {
    const s = stage.getBoundingClientRect();
    ctx.clearRect(0, 0, s.width, s.height);
    ctx.textBaseline = "top";
    ctx.font = `500 ${CELL.glyph + 1}px "Geist Mono Variable", ui-monospace, monospace`;
    for (const c of cells) {
      const p = cellAt(c, t);
      if (p.pg > 0) {
        ctx.fillStyle = rgba(p.col, 0.2 * p.pg); // the range stays behind at 20%
        ctx.fillText(c.g, p.fieldX, p.fieldY - 1);
      }
      if (p.glyph > 0.02) {
        ctx.fillStyle = rgba(p.col, p.glyph);
        ctx.fillText(c.g, p.x, p.y - 1);
      }
      if (p.glyph < 0.98) {
        ctx.fillStyle = rgba(p.col, (1 - p.glyph) * 0.9);
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
    }
    for (const m of marks) {
      const p = markAt(m, t);
      if (p)
        drawMark(
          p,
          m.kind,
          m.ok && t > TIMING.you + verified.indexOf(m) * TIMING.youEach
            ? 0.45
            : 1,
        );
    }
    for (const m of verified) {
      const p = flightAt(m, t);
      if (p) drawMark(p, m.kind);
    }
    G.tracks.forEach((tr, f) => {
      const pc = (t - checkAt(f)) / TIMING.checkDur;
      if (pc <= 0 || pc >= 1) return;
      const x = tr.x + (tr.w + 40) * pc - 20;
      if (x > tr.x && x < tr.x + tr.w) {
        ctx.fillStyle = rgba(C["line-strong"]!);
        ctx.fillRect(x, tr.y - 8, 1.5, tr.h + 16);
      }
    });
    // The text around the canvas follows the same clock. The owner left the
    // counts implicit (no covered, verified or counted figures); only the
    // findings that reach the last step are counted.
    youN.textContent = String(
      verified.filter(
        (_, v) => t > TIMING.you + v * TIMING.youEach + TIMING.youDur,
      ).length,
    );
    rows.forEach((el, r) => {
      const v = verified.findIndex((m) => m.row === r);
      const on = t > TIMING.you + v * TIMING.youEach + TIMING.youDur * 0.85;
      if (on && !el.classList.contains("in")) {
        el.classList.add("in");
        if (!REDUCED && t < TIMING.end) {
          el.classList.add("flash");
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              el.classList.remove("flash");
              // The flash's fade starts here; if the hero paused in between, it waits too.
              if (playing && !raf) hold(el.getAnimations());
            }),
          );
        }
      }
      if (!on) el.classList.remove("in");
    });
    you.classList.toggle(
      "waiting",
      !rows.some((el) => el.classList.contains("in")),
    );
    foot?.classList.toggle(
      "in",
      t > TIMING.you + verified.length * TIMING.youEach + TIMING.youDur,
    );
    const at = stepAt();
    steps.forEach((li, i) => {
      li.classList.toggle(
        "on",
        t >= TIMING.end ||
          (t >= at[i]! && (i === at.length - 1 || t < at[i + 1]!)),
      );
      li.classList.toggle("wait", t < at[i]! && t < TIMING.end);
    });
  };

  let raf = 0,
    t0 = 0,
    playing = false, // started and not yet at rest
    seen = true; // the stage is in view (see `whileInView` below)
  const tick = (now: number) => {
    stageT = now - t0;
    draw(stageT);
    playing = stageT < TIMING.end + 400;
    raf = playing ? requestAnimationFrame(tick) : 0;
  };
  // The clock is the frame loop: stopping the loop stops time, and resuming
  // moves t0 so the storyboard carries on from the frame it paused on.
  // The rows' fades and flashes are CSS transitions the clock starts; they
  // pause and resume with it. Only while the storyboard plays, so a row the
  // reader opens at rest is never left paused.
  let held: Animation[] = [];
  // Only a running loop collects: leaving the stage reports every 5% step,
  // and a later call must not drop what the first one paused (review 18b).
  const halt = () => {
    const wasRunning = raf !== 0;
    cancelAnimationFrame(raf);
    raf = 0;
    if (playing && wasRunning) hold(stage.getAnimations({ subtree: true }));
  };
  const hold = (as: Animation[]) => {
    for (const a of as)
      if (a.playState === "running") {
        a.pause();
        held.push(a);
      }
  };
  // Replay is the reader asking for it, so it plays even when the button is
  // on screen and too little of the stage is (a phone): scrolling still pauses it.
  const run = (asked = false) => {
    if (!playing || raf || (!seen && !asked)) return;
    // A held fade that Replay has since cancelled stays cancelled.
    for (const a of held) if (a.playState === "paused") a.play();
    held = [];
    t0 = performance.now() - stageT;
    raf = requestAnimationFrame(tick);
  };
  // Without .js the page shows its rendered, final state, so the hero does too.
  const settledNow = () => !document.documentElement.classList.contains("js");
  const play = (asked = false) => {
    halt();
    layout();
    if (REDUCED || settledNow()) {
      playing = false;
      stageT = TIMING.end + 400;
      draw(stageT);
      return;
    }
    stageT = 0;
    playing = true;
    draw(stageT);
    run(asked);
  };

  applyHeroTiming();
  stage.classList.add("live");
  layout();
  // If the page already fell back to its rendered state (no .js: the bundle
  // came late or a part failed), the hero shows its final frame instead of
  // replaying from zero beside rows that are already visible.
  if (freezeAt !== null) {
    stageT = freezeAt;
    draw(stageT);
  } else if (REDUCED || settledNow()) {
    stageT = TIMING.end + 400;
    draw(stageT);
  } else {
    draw(0);
    once(stage, play, IN_VIEW);
    whileInView(
      stage,
      (s) => {
        seen = s;
        if (s) run();
        else halt();
      },
      IN_VIEW,
    );
  }
  new ResizeObserver(() => {
    layout();
    draw(stageT);
  }).observe(stage);
  onTheme.push(() => {
    colours();
    draw(stageT);
  });
  document.fonts?.ready.then(() => {
    layout();
    draw(stageT);
  });
  byId("replay").addEventListener("click", () => {
    rows.forEach((r) => {
      r.classList.remove("open");
      r.querySelector("button")?.setAttribute("aria-expanded", "false");
    });
    play(true);
  });
}
