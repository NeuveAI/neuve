import {
  autoUpdate,
  computePosition,
  flip,
  hide,
  limitShift,
  offset,
  shift,
  size,
  type Placement,
} from "@floating-ui/dom";
import { DESK } from "../content";
import { TIMING } from "@workspace/ui/lib/motion";
import { REDUCED, byId, once } from "./motion";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD · the desk
 *
 *    0ms   the desk is half in view
 *  0.5s    the four numbered callouts pop in, one every 0.5s, each
 *          over 0.8s
 * ~2.8s    rest: four callouts, nothing moving
 *  3.6s    the claim "retries up to three times" lands on lines 29–37:
 *          the landing tint holds 1.2s, then fades over 1.6s
 *          (emphasized accelerate). Slower than the desk's own
 *          TIMING.landHold/landFade, so a first-time reader sees where
 *          it landed
 *  hover   a callout opens its card beside it (a tap on touch, focus
 *          from the keyboard); it closes 180ms after the pointer leaves
 *          both. The card keeps inside the viewport the way the app's
 *          popovers do: it flips to the other side, or below or above,
 *          and shifts along its side, staying attached to its callout
 *          (PLACE)
 *          (TIMING.card 220ms in, TIMING.cardExit 160ms out): a direct
 *          response, so it keeps the desk's speed
 * reduced  callouts and tint shown at once, no fade
 * ───────────────────────────────────────────────────────── */
export const DTIMING = {
  pulse: 500, // the first callout
  pulseEach: 500, // between callouts
  pulseDur: 800, // each callout's pop
  land: 3600, // the claim lands on its lines
  landHold: 1200, // the tint holds
  landFade: 1600, // then fades
  cardExit: TIMING.cardExit,
  hoverClose: 180, // a hovered card stays this long after the pointer leaves
};

/** Where a callout's card sits: Floating UI's flip and shift, the engine
 * under the app's Radix popovers (side, align, avoidCollisions,
 * collisionPadding). */
export const PLACE = {
  side: "right-start" as Placement, // beside the callout, its top a little above
  fallbacks: ["left-start", "bottom-start", "top-start"] as Placement[],
  gap: 8, // between the callout and the card
  lift: -30, // the card starts this far above the callout's top
  edge: 12, // the nearest the card comes to the viewport's edge (below the top bar at the top)
};

export function applyDeskTiming() {
  const frame = byId("desk-frame");
  frame.style.setProperty("--pulse-dur", `${DTIMING.pulseDur}ms`);
  frame.style.setProperty("--land-hold", `${DTIMING.landHold}ms`);
  frame.style.setProperty("--land-fade", `${DTIMING.landFade}ms`);
}

/** Plays the callouts and the landing again (the dev tuning panel's Replay). */
export let replayDesk = () => {};

export function initDesk() {
  const frame = byId("desk-frame"),
    peek = byId("peek"),
    legend = byId("desk-legend");
  const hots = [...frame.querySelectorAll<HTMLButtonElement>(".hot")];
  // The paragraph's links to the numbered callouts (round 6.1). They are
  // plain text until armed: only where the capture shows (wider than 640px)
  // do they become buttons, so on a phone nothing claims a card it can't show.
  const refs = [...document.querySelectorAll<HTMLElement>(".ref")];
  // Exactly the complement of the stylesheet's phone block, (max-width: 40em), at any text size.
  const wide = matchMedia("not all and (max-width: 40em)");
  const armed = (el: HTMLElement) => el.classList.contains("armed");
  let opener: HTMLElement | null = null; // focus goes back to whatever opened the card
  const lands = [...frame.querySelectorAll<HTMLElement>(".landrect")];
  const triggers = () =>
    document.querySelectorAll<HTMLElement>(
      ".hot, .ref.armed, #desk-legend button",
    );
  let openN = 0;

  // `slow` is the scripted landing (DTIMING's hold and fade); a callout click
  // lands at the desk's own speed (TIMING.landHold/landFade, in the CSS).
  const landLines = (slow = false) => {
    if (REDUCED) return lands.forEach((el) => el.classList.add("on"));
    lands.forEach((el) => {
      el.classList.remove("off");
      el.classList.add("on");
      el.classList.toggle("slow", slow);
    });
    setTimeout(
      () =>
        lands.forEach(
          (el) => (el.classList.remove("on"), el.classList.add("off")),
        ),
      40,
    );
  };
  const open = (n: number) => {
    const d = DESK.callouts.find((x) => x.n === n);
    const hot = hots.find((h) => Number(h.dataset.n) === n);
    if (!d || !hot) return;
    openN = n;
    byId("peek-num").textContent = String(n);
    byId("peek-title").textContent = d.title;
    byId("peek-text").textContent = d.text;
    triggers().forEach((h) =>
      h.setAttribute("aria-expanded", String(Number(h.dataset.n) === n)),
    );
    peek.hidden = false;
    peek.classList.remove("leave", "enter");
    peek.style.visibility = "hidden"; // until it's placed
    stopTracking?.();
    let first = true;
    // Re-placed while open, as the page scrolls or resizes; only the first
    // placement plays the entrance (review 13, B4).
    stopTracking = autoUpdate(hot, peek, () => {
      const entering = first;
      first = false;
      place(hot, entering);
    });
    if (d.land) landLines();
  };
  let stopTracking: (() => void) | undefined;
  const ORIGIN: Record<string, string> = {
    right: "left top",
    left: "right top",
    bottom: "top left",
    top: "bottom left",
  };
  // The sticky top bar covers the viewport's top, so the card keeps below it.
  const bar = document.querySelector<HTMLElement>(".top");
  const room = () => {
    const e = PLACE.edge;
    return {
      top: (bar?.getBoundingClientRect().bottom ?? 0) + e,
      right: e,
      bottom: e,
      left: e,
    };
  };
  const place = (hot: HTMLElement, entering: boolean) =>
    computePosition(hot, peek, {
      placement: PLACE.side,
      middleware: [
        offset({ mainAxis: PLACE.gap, crossAxis: PLACE.lift }),
        flip({ fallbackPlacements: PLACE.fallbacks, padding: room() }),
        shift({ padding: room(), limiter: limitShift() }),
        // A window too short for the card caps its height; the card scrolls.
        size({
          padding: room(),
          apply: ({ availableHeight }) => {
            peek.style.maxHeight = `${Math.max(0, availableHeight)}px`;
          },
        }),
        hide({ padding: room() }),
      ],
    }).then(({ x, y, placement, middlewareData }) => {
      if (peek.hidden || Number(hot.dataset.n) !== openN) return;
      peek.style.left = `${x}px`;
      peek.style.top = `${y}px`;
      peek.style.transformOrigin = ORIGIN[placement.split("-")[0]!]!;
      peek.dataset.side = placement;
      // Like Radix's hideWhenDetached: no card floating free of its callout.
      peek.style.visibility = middlewareData.hide?.referenceHidden
        ? "hidden"
        : "visible";
      if (entering && !REDUCED) {
        void peek.offsetWidth;
        peek.classList.add("enter");
      }
    });
  const close = (returnFocus = false) => {
    if (peek.hidden) return;
    const n = openN;
    openN = 0;
    stopTracking?.();
    stopTracking = undefined;
    peek.classList.remove("enter");
    if (!REDUCED) peek.classList.add("leave");
    setTimeout(
      () => {
        if (!openN) peek.hidden = true;
      },
      REDUCED ? 0 : DTIMING.cardExit,
    );
    triggers().forEach((h) => h.setAttribute("aria-expanded", "false"));
    if (returnFocus && n) {
      // Focus goes back to the opener without reopening the card (review 10, B1).
      restoring = true;
      (opener ?? hots.find((h) => Number(h.dataset.n) === n))?.focus({
        preventScroll: true,
      });
      restoring = false;
    }
  };
  const toggle = (el: Element | null) => {
    const n = Number((el as HTMLElement | null)?.dataset.n);
    if (!n) return;
    opener = el as HTMLElement;
    n === openN ? close() : open(n);
  };
  // The owner (11 November): the numbered callouts open on hover, not on a
  // click. A tap still toggles one on touch screens, keyboard focus opens one,
  // and Escape closes it; aria-expanded follows every path.
  let lastPointer = "";
  let restoring = false;
  let hoverClose: ReturnType<typeof setTimeout> | undefined;
  const keepOpen = () => clearTimeout(hoverClose);
  const closeSoon = () => {
    keepOpen();
    hoverClose = setTimeout(() => close(), DTIMING.hoverClose);
  };
  const show = (hot: HTMLElement) => {
    keepOpen();
    opener = hot;
    const n = Number(hot.dataset.n);
    if (n && n !== openN) open(n);
  };
  document.addEventListener(
    "pointerdown",
    (e) => (lastPointer = e.pointerType),
    { capture: true },
  );
  const live = (el: HTMLElement) => !el.classList.contains("ref") || armed(el);
  [...hots, ...refs].forEach((hot) => {
    hot.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse" && live(hot)) show(hot);
    });
    hot.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && live(hot)) closeSoon();
    });
    hot.addEventListener("focus", () => {
      if (!restoring && live(hot) && hot.matches(":focus-visible")) show(hot);
    });
  });
  // A card opened from the keyboard closes once focus leaves the callouts, the
  // legend and the card (review 10, N1). The legend counts as part of the desk,
  // or a tap on it would open its card and close it at once (review 11, B3).
  [...hots, ...refs, peek, legend].forEach((el) =>
    el.addEventListener("focusout", () =>
      setTimeout(() => {
        const a = document.activeElement;
        if (
          !peek.hidden &&
          !(a && peek.contains(a)) &&
          !a?.closest(".hot, .ref.armed, #desk-legend")
        )
          close();
      }),
    ),
  );
  const arm = () =>
    refs.forEach((ref) => {
      const on = wide.matches;
      ref.classList.toggle("armed", on);
      if (on) {
        ref.setAttribute("role", "button");
        ref.tabIndex = 0;
        ref.setAttribute("aria-controls", "peek");
        ref.setAttribute(
          "aria-expanded",
          String(Number(ref.dataset.n) === openN),
        );
      } else {
        ["role", "tabindex", "aria-controls", "aria-expanded"].forEach((a) =>
          ref.removeAttribute(a),
        );
      }
    });
  arm();
  const onWidth = () => {
    close();
    arm();
  };
  if (wide.addEventListener) wide.addEventListener("change", onWidth);
  else wide.addListener(onWidth);
  peek.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") keepOpen();
  });
  peek.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse") closeSoon();
  });
  frame.addEventListener("click", (e) => {
    const hot = (e.target as Element).closest<HTMLElement>(".hot");
    // A mouse already opened it on hover; a click there keeps it open.
    if (
      hot &&
      e.detail > 0 &&
      lastPointer === "mouse" &&
      Number(hot.dataset.n) === openN
    )
      return;
    toggle(hot);
  });
  refs.forEach((ref) => {
    ref.addEventListener("click", (e) => {
      if (!armed(ref)) return;
      if (
        e.detail > 0 &&
        lastPointer === "mouse" &&
        Number(ref.dataset.n) === openN
      )
        return;
      toggle(ref);
    });
    // Like a native button: Enter acts on keydown, Space on keyup (and its
    // keydown is held back so it doesn't scroll the page).
    ref.addEventListener("keydown", (e) => {
      if (!armed(ref) || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      if (e.key === "Enter") toggle(ref);
    });
    ref.addEventListener("keyup", (e) => {
      if (!armed(ref) || e.key !== " ") return;
      e.preventDefault();
      toggle(ref);
    });
  });
  legend.addEventListener("click", (e) =>
    toggle((e.target as Element).closest("button")),
  );
  byId("peek-close").addEventListener("click", () => close(true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close(true);
  });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    if (
      !peek.hidden &&
      !peek.contains(t) &&
      !t.closest(".hot, .ref") &&
      !t.closest("#desk-legend")
    )
      close();
  });
  let timers: ReturnType<typeof setTimeout>[] = [];
  const play = () => {
    timers.forEach(clearTimeout);
    if (REDUCED) {
      hots.forEach((h) => h.classList.add("pulse"));
      return landLines();
    }
    timers = [
      ...hots.map((h, i) =>
        setTimeout(
          () => h.classList.add("pulse"),
          DTIMING.pulse + i * DTIMING.pulseEach,
        ),
      ),
      setTimeout(() => landLines(true), DTIMING.land),
    ];
  };
  replayDesk = () => {
    hots.forEach((h) => h.classList.remove("pulse"));
    lands.forEach((el) => el.classList.remove("on", "off"));
    void frame.offsetWidth;
    play();
  };
  applyDeskTiming();
  once(frame, play, 0.45);
}
