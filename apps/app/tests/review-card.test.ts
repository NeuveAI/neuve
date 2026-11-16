import { expect, test } from "bun:test";

const origin = "http://127.0.0.1:4141";
const cycle = "01M67KE42FHX345RCRHW57DRQ5";
const base = `/review/${"a".repeat(64)}`;
const batch = `${base}/cycles/${cycle}`;

// openReview checks routes against the page it runs in.
Object.assign(globalThis, { location: new URL(`${origin}/`) });

const { register } = await import("../src/review-destination");
const cards = await import("../src/review-card");

// The integrated run found card links still going through a stand-in that opened a second
// browser tab; cards and the new-commit row must reach the channel's Review tab and nothing else.
test("card links open the channel's Review tab, never a browser tab", () => {
  const windows: unknown[] = [];
  Object.assign(globalThis, {
    window: { open: (...args: unknown[]) => windows.push(args) },
  });
  try {
    const opened: string[] = [];
    const release = register("one", (path) => opened.push(path));
    const actions = cards.reviewActions(
      {},
      true,
      async () => {},
      cards.reviewTab("one"),
    );
    actions.open(`${batch}/desk`);
    actions.open(`${base}/api/events`);
    // Another channel's links don't reach this window's tab.
    cards.reviewActions({}, true, async () => {}, cards.reviewTab("two")).open(
      batch,
    );
    release();
    expect(opened).toEqual([`${batch}/desk`]);
    expect(windows).toEqual([]);
    // The stand-in opener is gone, so nothing can import it again.
    expect("openReview" in cards).toBe(false);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
