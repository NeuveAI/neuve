import {
  HEADING,
  MATRIX_UNITS,
  type LaneKey,
  type MatrixUnit,
} from "../content";
import { REDUCED, SPRING, byId, cssSpring, once } from "./motion";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD · where it's heading
 *
 *  0.0s    in view: units rise into their quadrants one at a time,
 *          0.25s apart, 0.8s each
 * ~1.8s    rest: five units in their review lanes
 *  2.7s    a "past outage" tag pops onto the retry change
 *          (SPRING.snappy); the ledger's History line changes and
 *          flashes --nv-lit (1.4s)
 *  4.9s    after time to read why, the retry change moves to "hard to
 *          validate" (FLIP on SPRING.gentle, 1.5s); its new neighbour
 *          moves with it
 *  5.95s   on arrival its glyph becomes a diamond, the quadrant rings
 *          once (1.6s) and the ledger's review lane line changes
 * reduced  the final state at once
 * ───────────────────────────────────────────────────────── */
export const MTIMING = {
  chipEach: 250, // between units rising in
  chipRise: 800, // each unit's rise
  tag: 2700, // the tag pops
  ledgerFlash: 1400, // a changed ledger line's flash fades
  move: 4900, // the retry change moves
  moveDur: 1500, // its FLIP
  arrive: 0.7, // arrival, as a share of the move
  ring: 1600, // the quadrant's ring
};

export function applyHeadingTiming() {
  const section = byId("matrix").closest("section");
  section?.style.setProperty("--chip-rise", `${MTIMING.chipRise}ms`);
  section?.style.setProperty("--ledger-flash", `${MTIMING.ledgerFlash}ms`);
  section?.style.setProperty("--arrive", `${MTIMING.ring}ms`);
}

type State = { moved: boolean; tagged: boolean };

export function initHeading() {
  const matrix = byId("matrix"),
    ledger = byId("ledger-body");
  const glyphs = byId<HTMLTemplateElement>("glyphs");
  // Built from nodes, never HTML strings: the CSP enforces Trusted Types.
  const glyph = (lane: LaneKey): Node[] =>
    [
      ...(glyphs.content.querySelector(`[data-glyph="${lane}"]`)?.childNodes ??
        []),
    ].map((n) => n.cloneNode(true));
  const el = (tag: string, cls: string, ...kids: (Node | string)[]) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...kids);
    return e;
  };
  const st: Record<string, State> = {};
  let selected = "retry";
  const view = (u: MatrixUnit) =>
    st[u.id]?.moved && u.after
      ? { ...u, ...u.after }
      : { ...u, h: st[u.id]?.tagged && u.after ? u.after.h : u.h };
  const chips: Record<string, HTMLButtonElement> = {};

  const ledgerNodes = (u: MatrixUnit) => {
    const v = view(u);
    const r = HEADING.rows;
    const row = (dt: string, dd: Node | string, k = "") => {
      const d = el("dd", "", dd);
      if (k) d.dataset.k = k;
      return [el("dt", "", dt), d];
    };
    return [
      el("h3", "", v.title),
      el(
        "dl",
        "",
        ...row(r.cx, v.cx),
        ...row(r.v, v.v, "v"),
        ...row(r.h, v.h, "h"),
        ...row(r.br, v.br),
        ...row(
          r.lane,
          el("span", "lanechip", ...glyph(v.lane), v.laneName),
          "lane",
        ),
      ),
    ];
  };
  const renderLedger = (changed: string[] = []) => {
    const u = MATRIX_UNITS.find((x) => x.id === selected);
    if (!u) return;
    ledger.replaceChildren(...ledgerNodes(u));
    if (REDUCED) return;
    for (const k of changed) {
      const dd = ledger.querySelector(`[data-k="${k}"]`);
      dd?.classList.add("changed");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => dd?.classList.remove("changed")),
      );
    }
  };
  const build = (final: boolean) => {
    matrix.querySelectorAll(".uchip").forEach((c) => c.remove());
    for (const u of MATRIX_UNITS) {
      st[u.id] = { moved: final && !!u.after, tagged: final && !!u.tag };
      const v = view(u);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "uchip";
      b.dataset.id = u.id;
      b.setAttribute("aria-pressed", String(u.id === selected));
      b.append(
        el("span", "g", ...glyph(v.lane)),
        el("span", "", u.title),
        ...(u.tag ? [el("span", final ? "tag in" : "tag", u.tag)] : []),
      );
      matrix.querySelector(`[data-q="${v.q}"]`)?.appendChild(b);
      chips[u.id] = b;
      b.addEventListener("click", () => {
        selected = u.id;
        Object.values(chips).forEach((c) =>
          c.setAttribute("aria-pressed", String(c.dataset.id === selected)),
        );
        renderLedger();
      });
    }
    renderLedger();
  };
  const flip = (els: HTMLElement[], mutate: () => void, ms: number) => {
    const first = els.map((e) => e.getBoundingClientRect());
    mutate();
    els.forEach((e, i) => {
      const l = e.getBoundingClientRect(),
        f = first[i]!;
      e.style.transition = "none";
      e.style.transform = `translate(${f.left - l.left}px, ${f.top - l.top}px)`;
    });
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        els.forEach((e) => {
          e.style.transition = `transform ${ms}ms ${cssSpring(SPRING.gentle, ms)}`;
          e.style.transform = "none";
        }),
      ),
    );
  };
  let timers: ReturnType<typeof setTimeout>[] = [];
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
  const play = () => {
    // A replay mid-play starts clean: no beat from the last run fires early.
    timers.forEach(clearTimeout);
    timers = [];
    build(REDUCED);
    matrix.classList.remove("play");
    void matrix.offsetWidth;
    matrix.classList.add("play");
    if (REDUCED) return;
    Object.values(chips).forEach(
      (c, i) => (c.style.transitionDelay = `${i * MTIMING.chipEach}ms`),
    );
    later(() => {
      st.retry = { moved: false, tagged: true };
      chips.retry?.querySelector(".tag")?.classList.add("in");
      if (selected === "retry") renderLedger(["h"]);
    }, MTIMING.tag);
    later(() => {
      const q = matrix.querySelector<HTMLElement>('[data-q="hh"]'),
        retry = chips.retry,
        sib = chips.revoke;
      if (!q || !retry || !sib) return;
      Object.values(chips).forEach((c) => (c.style.transitionDelay = "0ms"));
      flip([retry, sib], () => q.insertBefore(retry, sib), MTIMING.moveDur);
      later(() => {
        st.retry = { moved: true, tagged: true };
        const g = retry.querySelector(".g");
        if (g) {
          g.replaceChildren(...glyph("human-required"));
          g.classList.add("swap");
        }
        q.classList.remove("arrive");
        void q.offsetWidth;
        q.classList.add("arrive");
        if (selected === "retry") renderLedger(["v", "lane"]);
      }, MTIMING.moveDur * MTIMING.arrive);
    }, MTIMING.move);
  };
  applyHeadingTiming();
  build(true);
  matrix.classList.add("play");
  if (!REDUCED) {
    build(false);
    matrix.classList.remove("play");
    once(matrix, play, 0.45);
  }
  byId("m-replay").addEventListener("click", play);
}
