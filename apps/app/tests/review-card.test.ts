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

// Why: the Review tab opens on its own for the chat's newest review. `updatedAt` moves with every
// progress update, so picking by it would jump back to an older review; and a link that isn't a
// review entry route must never be framed.
test("the newest review is the greatest review id whose batch overview is a review route", () => {
  const card = (review: string, updatedAt: number, links: { batch: string; desk: string } | null) => ({
    kind: "review" as const,
    review,
    source: "branch" as const,
    label: "main",
    range: { branch: "b", base: "main", head: "h", commits: 1 },
    recovered: false,
    notify: false,
    phase: "running" as const,
    stage: null,
    stages: [],
    finished: null,
    stopped: null,
    newCommits: null,
    links,
    updatedAt,
  });
  const older = "01M67KE42FHX345RCRHW57DRQ5";
  const newer = "01M67KE42FHX345RCRHW57DRQ6";
  const newest = "01M67KE42FHX345RCRHW57DRQ7";
  const at = (review: string) => ({ batch: `${base}/cycles/${review}`, desk: `${base}/cycles/${review}/desk` });
  expect(cards.newestReview({})).toBeNull();
  expect(cards.newestReview({
    a: card(older, 300, at(older)),
    b: card(newer, 100, at(newer)),
    // Admitted but not linked yet, and a link that isn't a review route: neither is chosen.
    c: card(newest, 50, null),
    d: { ...card("01M67KE42FHX345RCRHW57DRQ8", 10, null), links: { batch: `${base}/api/events`, desk: "/" } },
    e: { kind: "refused", reason: "uncommitted_changes", title: "t", detail: "d", fix: "f" },
  } as never)).toEqual({ review: newer, path: `${base}/cycles/${newer}` });
});
