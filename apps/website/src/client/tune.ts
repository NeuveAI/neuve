/*
 * Live tuning for the page's motion, in `vite dev` only (Interface Craft's
 * DialKit, plain-JavaScript adapter). entry-client imports this only when
 * import.meta.env.DEV is true, so it never reaches the built site.
 *
 * Each panel holds one storyboard's timing table. Moving a dial writes the
 * value into that table, which the motion reads as it plays, and keeps it for
 * this tab's session (tune-store.ts applies it again before the page starts).
 * Replay plays that part again with the new values. Copy a tuned table
 * back into its storyboard to keep it.
 */
import {
  createDialKit,
  createDialRoot,
  type DialConfig,
} from "dialkit/vanilla";
import "dialkit/vanilla/styles.css";
import { DTIMING, applyDeskTiming, replayDesk } from "./desk";
import { FOOT, replayFooterMark } from "./footer-mark";
import { MTIMING, applyHeadingTiming } from "./heading";
import { TIMING, applyHeroTiming } from "./hero";
import { TTIMING, applyTerminalTiming, replayTerminal } from "./terminal";
import { saveTuning } from "./tune-store";

type Table = Record<string, number>;

/** [min, max, step] for each dial; the table's current value is the default. */
const PARTS: Array<{
  name: string;
  table: Table;
  ranges: Record<string, [number, number, number]>;
  apply?: () => void;
  replay: () => void;
}> = [
  {
    name: "Hero",
    table: TIMING,
    ranges: {
      gather: [0, 3000, 10],
      gatherEach: [0, 200, 1],
      gatherDur: [100, 3000, 10],
      find: [0, 10000, 10],
      findEach: [0, 500, 5],
      findPop: [0, 1000, 10],
      travelPace: [0.5, 4, 0.05],
      check: [0, 20000, 10],
      checkEach: [0, 1500, 10],
      checkDur: [100, 4000, 10],
      you: [0, 25000, 10],
      youEach: [0, 800, 5],
      youDur: [100, 3000, 10],
      rowIn: [0, 2000, 10],
      rowFlash: [0, 3000, 10],
      end: [0, 30000, 10],
    },
    apply: applyHeroTiming,
    replay: () => document.getElementById("replay")?.click(),
  },
  {
    name: "Desk",
    table: DTIMING,
    ranges: {
      pulse: [0, 3000, 10],
      pulseEach: [0, 1500, 10],
      pulseDur: [100, 2500, 10],
      land: [0, 10000, 10],
      landHold: [0, 4000, 10],
      landFade: [100, 5000, 10],
    },
    apply: applyDeskTiming,
    replay: () => replayDesk(),
  },
  {
    name: "Terminal",
    table: TTIMING,
    ranges: {
      start: [0, 4000, 10],
      line: [0, 1200, 5],
      lineIn: [0, 2000, 10],
    },
    apply: applyTerminalTiming,
    replay: replayTerminal,
  },
  {
    name: "Where it's heading",
    table: MTIMING,
    ranges: {
      chipEach: [0, 800, 5],
      chipRise: [0, 2500, 10],
      tag: [0, 10000, 10],
      ledgerFlash: [0, 4000, 10],
      move: [0, 15000, 10],
      moveDur: [100, 4000, 10],
      arrive: [0.1, 1, 0.05],
      ring: [0, 4000, 10],
    },
    apply: applyHeadingTiming,
    replay: () => document.getElementById("m-replay")?.click(),
  },
  {
    name: "Footer mark",
    table: FOOT,
    ranges: { gather: [100, 6000, 10] },
    replay: () => replayFooterMark(),
  },
];

createDialRoot({ position: "bottom-right", theme: "system" });
for (const part of PARTS) {
  const config: DialConfig = { replay: { type: "action", label: "Replay" } };
  for (const [key, [min, max, step]] of Object.entries(part.ranges))
    config[key] = [part.table[key] ?? min, min, max, step];
  const kit = createDialKit(part.name, config, {
    defaultCollapsed: true,
    onAction: (action) => action === "replay" && part.replay(),
  });
  kit.subscribe((values) => {
    for (const key of Object.keys(part.ranges)) {
      const v = (values as Record<string, unknown>)[key];
      if (typeof v === "number") part.table[key] = v;
    }
    part.apply?.();
    saveTuning(part.name, part.table);
  }, false);
}
