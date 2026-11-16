import { REDUCED, byId, once } from "./motion";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD · terminal
 *
 *    0ms   half in view: the commands are already there
 *  0.8s    after a rest on the commands, the JSON your agent reads
 *          streams in, one line every 0.3s, each rising over 0.5s
 * reduced  the transcript at once
 * ───────────────────────────────────────────────────────── */
export const TTIMING = {
  start: 800, // the first JSON line
  line: 300, // between lines
  lineIn: 500, // each line's rise
};

export function applyTerminalTiming() {
  byId("term").style.setProperty("--line-in", `${TTIMING.lineIn}ms`);
}

let timers: ReturnType<typeof setTimeout>[] = [];
const lines = () => [
  ...byId("term").querySelectorAll<HTMLElement>(".ln.later"),
];
const stream = () => {
  timers.forEach(clearTimeout);
  const later = lines();
  if (REDUCED) return later.forEach((l) => l.classList.add("in"));
  timers = later.map((l, j) =>
    setTimeout(() => l.classList.add("in"), TTIMING.start + j * TTIMING.line),
  );
};

/** Streams the transcript again (the dev tuning panel's Replay). */
export function replayTerminal() {
  lines().forEach((l) => l.classList.remove("in"));
  void byId("term").offsetWidth;
  stream();
}

export function initTerminal() {
  applyTerminalTiming();
  once(byId("term"), stream, 0.5);
}
