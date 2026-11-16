import { expect, test } from "bun:test";

import { reviewPagePath, reviewPath } from "../packages/ui/src/lib/review-link";

const origin = "http://127.0.0.1:4141";
const cycle = "01M67KE42FHX345RCRHW57DRQ5";
const batch = `/review/${"a".repeat(64)}/cycles/${cycle}`;

// openReview checks routes against the page it runs in.
Object.assign(globalThis, { location: new URL(`${origin}/`) });

const { openReview, openReviewWhenShown, register, reviewChannel } =
  await import("../apps/app/src/review-destination");

test("a batch overview or review desk on this origin opens in the tab", () => {
  expect(reviewPath(batch, origin)).toBe(batch);
  expect(reviewPath(`${origin}${batch}/desk`, origin)).toBe(`${batch}/desk`);
  // Receipts carry the standalone app's return link; the tab is the way back, so it is dropped.
  const back = encodeURIComponent(
    `${origin}/?channel=1885762d7e23a64a#channels`,
  );
  expect(reviewPath(`${origin}${batch}?returnTo=${back}`, origin)).toBe(batch);
  expect(reviewPath(`${batch}/desk?unit=2#diff`, origin)).toBe(`${batch}/desk`);
  // The URL parser resolves dot segments, even encoded ones, before the route is checked.
  expect(reviewPath(`${batch}/x/%2e%2e/desk`, origin)).toBe(`${batch}/desk`);
});

test("anything else stays an ordinary link", () => {
  for (const href of [
    `http://127.0.0.1:58003${batch}`,
    `https://127.0.0.1:4141${batch}`,
    `http://owner@127.0.0.1:4141${batch}`,
    `http://127.0.0.1:58003/?cycle=${cycle}`,
    "/review",
    "/review/",
    `/review/${"a".repeat(64)}/`,
    `/review/${"a".repeat(64)}/api/health`,
    `${batch}/`,
    `${batch}/desk/`,
    `${batch}/units/1`,
    `/review/${"A".repeat(64)}/cycles/${cycle}`,
    `/review/${"a".repeat(63)}/cycles/${cycle}`,
    `/review/${"a".repeat(64)}/cycles/${cycle.toLowerCase()}`,
    `/review/${"a".repeat(64)}/cycles/01M67KE42FHX345RCRHW57DRQU`,
    `/review/${"a".repeat(64)}/cycles%2F${cycle}`,
    `${batch}/../../../settings`,
    "/reviews/x",
    "/",
    "javascript:alert(1)",
    "http://[",
  ])
    expect(reviewPath(href, origin)).toBeUndefined();
});

// The review app's own routes (apps/neuve-web routes/), under the base Ace serves it at: the
// cycle routes redirect to a batch or a unit, and every settled route is reported as navigate.
const base = `/review/${"a".repeat(64)}`;
const pages = [
  `${base}/cycles/${cycle}`,
  `${base}/cycles/${cycle}/desk`,
  `${base}/batch/01M67KE42FHX345RCRHW57DRQ6`,
  `${base}/review/revoke-cuts-off-open-sessions`,
  `${base}/changes/752cf449?fromRevisionId=rev_2`,
  `${base}/review/unit-5#diff`,
];

test("the pages the embedded review moves through are saved with their query", () => {
  for (const page of pages) {
    expect(reviewPagePath(page, origin)).toBe(page);
    expect(reviewPagePath(`${origin}${page}`, origin)).toBe(page);
  }
  // A link from outside the tab still opens only the two entry routes.
  expect(pages.map((page) => reviewPath(page, origin))).toEqual([
    pages[0],
    pages[1],
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("the review app's API, server functions and other pages are never saved or framed", () => {
  for (const href of [
    `${base}/api/events`,
    `${base}/api/health`,
    `${base}/_serverFn/abc`,
    "/_serverFn/abc",
    `${base}/settings`,
    `${base}/workspace`,
    `${base}/mock/review/revoke-cuts-off-open-sessions`,
    `${base}/`,
    `${base}/batch`,
    `${base}/batch/`,
    `${base}/batch//x`,
    `${base}/batch%2Fx`,
    `${base}/batch/x/../../api/events`,
    `/review/${"A".repeat(64)}/batch/x`,
    `/review/${"a".repeat(63)}/batch/x`,
    `http://127.0.0.1:58003${base}/batch/x`,
    `http://owner@127.0.0.1:4141${base}/batch/x`,
    `${base}/batch/x?${"q".repeat(2048)}`,
    "javascript:alert(1)",
  ])
    expect(reviewPagePath(href, origin)).toBeUndefined();
});

test("openReview reaches only the channel this window shows", () => {
  const opened: string[] = [];
  expect(openReview("one", batch)).toBe(false);
  const release = register("one", (path) => opened.push(path));
  expect(openReview("two", batch)).toBe(false);
  expect(openReview("one", "https://example.com/review/x")).toBe(false);
  expect(openReview("one", `${origin}${batch}/desk`)).toBe(true);
  expect(opened).toEqual([`${batch}/desk`]);
  // A layout that unmounts after another registered leaves the newer one in place.
  const next = register("two", (path) => opened.push(`two:${path}`));
  release();
  expect(openReview("two", batch)).toBe(true);
  next();
  expect(openReview("two", batch)).toBe(false);
  expect(opened).toEqual([`${batch}/desk`, `two:${batch}`]);
});

test("a past review waits for the channel it opens in", () => {
  const opened: string[] = [];
  expect(openReviewWhenShown("one", "https://example.com/review/x")).toBe(
    false,
  );
  // The channel picked from a pull request's history mounts after the list unmounts.
  expect(openReviewWhenShown("one", `${origin}${batch}?returnTo=x`)).toBe(true);
  register("two", (path) => opened.push(`two:${path}`))();
  expect(opened).toEqual([]);
  const one = register("one", (path) => opened.push(`one:${path}`));
  expect(opened).toEqual([`one:${batch}`]);
  // Shown already: it opens at once, and nothing is left waiting.
  expect(openReviewWhenShown("one", `${batch}/desk`)).toBe(true);
  expect(opened).toEqual([`one:${batch}`, `one:${batch}/desk`]);
  one();
  register("one", (path) => opened.push(`again:${path}`))();
  expect(opened).toHaveLength(2);
  // A channel created for the item is the next to mount.
  expect(openReviewWhenShown(undefined, batch)).toBe(true);
  register("new", (path) => opened.push(`new:${path}`))();
  expect(opened.at(-1)).toBe(`new:${batch}`);
});

test("a receipt names its channel only through a return link on this origin", () => {
  const back = (url: string) =>
    `${origin}${batch}?returnTo=${encodeURIComponent(url)}`;
  expect(
    reviewChannel(
      back(
        `${origin}/?project=%2Frepo&channel=06a4f163bcc67b23&chat=1#channels`,
      ),
      origin,
    ),
  ).toBe("06a4f163bcc67b23");
  for (const url of [
    batch,
    back(`${origin}/?project=%2Frepo#dashboard`),
    back(`http://127.0.0.1:58003/?channel=06a4f163bcc67b23`),
    back(`${origin}/?channel=..%2Fx`),
    back(`${origin}/?channel=${"a".repeat(65)}`),
    back("not a url"),
  ])
    expect(reviewChannel(url, origin)).toBeUndefined();
});
