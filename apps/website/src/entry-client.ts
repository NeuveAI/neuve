import "./styles/site.css";
import { initCopy } from "./client/copy";
import { DTIMING, initDesk } from "./client/desk";
import { FOOT, initFooterMark } from "./client/footer-mark";
import { MTIMING, initHeading } from "./client/heading";
import { TIMING, initHero } from "./client/hero";
import { REDUCED } from "./client/motion";
import { TTIMING, initTerminal } from "./client/terminal";
import { initTheme } from "./client/theme";
import { loadTuning } from "./client/tune-store";

/*
 * The page is complete as rendered; this adds the theme toggle, the copy
 * buttons and the motion. `#t-<ms>` freezes the hero at that time, for
 * screenshots (headless Chrome has no display clock).
 */
const freeze = /^#t-(\d+)$/.exec(location.hash);
const freezeAt = freeze ? Number(freeze[1]) : null;

// In `vite dev`, timing tuned in the DialKit panel (client/tune.ts) applies
// before anything plays. The built site drops this branch.
if (import.meta.env.DEV)
  loadTuning({
    Hero: TIMING,
    Desk: DTIMING,
    Terminal: TTIMING,
    "Where it's heading": MTIMING,
    "Footer mark": FOOT,
  });

const root = document.documentElement;
// The inline script set .js before first paint. If its fallback already took
// .js off (the bundle came late), it stays off: the parts still start, but
// nothing that is already showing is hidden again.
const parts: Array<[string, () => void]> = [
  ["theme", initTheme],
  ["copy", initCopy],
  ["hero", () => initHero(freezeAt)],
  ["desk", initDesk],
  ["terminal", initTerminal],
  ["heading", initHeading],
  ["footer mark", () => initFooterMark(freezeAt !== null)],
];
let failed = false;
for (const [name, start] of parts) {
  try {
    start();
  } catch (error) {
    // A part that fails leaves the page as rendered (its final state) rather than half-hidden.
    failed = true;
    console.error(`neuve site: ${name} failed`, error);
  }
}
if (failed) {
  root.classList.remove("js");
  // Show the hero's final frame too, so its counts match the rows now showing.
  document.getElementById("replay")?.click();
}
root.classList.add("live");
if (import.meta.env.DEV)
  import("./client/tune").catch((error) =>
    console.error("neuve site: the tuning panel failed", error),
  );
// The headline lands on load (300ms, emphasized decelerate 520ms), whatever the stage is doing.
setTimeout(
  () => document.getElementById("hero")?.classList.add("landed"),
  REDUCED || freezeAt !== null ? 0 : 300,
);

const top = document.getElementById("top");
addEventListener("scroll", () => top?.classList.toggle("stuck", scrollY > 8), {
  passive: true,
});
