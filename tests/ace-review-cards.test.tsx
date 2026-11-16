import { expect, test } from "bun:test";

import type { ReviewCard } from "@ace/channel/review-cards";

import {
  reviewActions,
  reviewCard,
  reviewCommits,
  type ReviewCards,
  reviewEntry,
  reviewNotice,
  reviewTool,
  wakeNote,
  withReviews,
} from "../apps/app/src/review-card";
import { toEvents } from "../apps/app/src/timeline";
import type { Item, Tool } from "../apps/app/src/transcript";

const RANGE = {
  branch: "codex/pi-transition",
  base: "main",
  head: "a3f9c2e81d",
  commits: 41,
};
const EMPTY: ReviewCards = {};
const admitted = JSON.stringify({
  outcome: "admitted",
  review: "R1",
  recovered: false,
  range: RANGE,
  notify: false,
});
const card = (patch: Partial<Extract<ReviewCard, { kind: "review" }>> = {}) =>
  ({
    kind: "review",
    review: "R1",
    source: "branch",
    label: "codex/pi-transition against main",
    range: RANGE,
    recovered: false,
    notify: false,
    phase: "running",
    stage: null,
    stages: [],
    finished: null,
    stopped: null,
    newCommits: null,
    links: null,
    updatedAt: 1,
    ...patch,
  }) satisfies ReviewCard;
const start = (patch: Partial<Tool> = {}): Tool => ({
  call: "c1",
  name: "neuve_review_branch",
  args: { against: "main" },
  ...patch,
});

// The rows replace raw names and JSON; whatever comes back, the person reads a sentence.
test("review tool rows read as plain lines, including results that are not the tools' JSON", () => {
  expect(reviewTool(start(), EMPTY)).toEqual({
    name: "Start Neuve review",
    summary: "of this branch against main",
    result: undefined,
  });
  expect(
    reviewTool(
      start({
        result: {
          error: false,
          text: `${admitted}\nPoint the person at the review card.`,
        },
      }),
      EMPTY,
    ),
  ).toMatchObject({
    summary: "codex/pi-transition against main",
    result:
      "Admitted: 41 commits from main to a3f9c2e. The card below follows it.",
  });
  expect(
    reviewTool(
      start({
        result: {
          error: true,
          text: JSON.stringify({
            outcome: "refused",
            reason: "uncommitted_changes",
            detail: "12 uncommitted paths",
            fix: "Commit or remove them, then ask again",
          }),
        },
      }),
      EMPTY,
    )?.result,
  ).toBe(
    "Didn't start: 12 uncommitted paths. Commit or remove them, then ask again.",
  );
  expect(
    reviewTool(
      start({ result: { error: true, text: "Error: socket closed {" } }),
      EMPTY,
    )?.result,
  ).toBe("Neuve couldn't answer this call.");
  expect(
    reviewTool(
      start({ result: { error: false, text: '{"outcome":"admitted"}' } }),
      EMPTY,
    )?.result,
  ).toBe("Neuve answered in a form this app can't read.");
  expect(
    reviewTool(
      start({
        name: "neuve_review_pull_request",
        args: { repo: "neuveai/neuve", number: 482 },
      }),
      EMPTY,
    )?.summary,
  ).toBe("neuveai/neuve#482");
  expect(
    reviewTool(start({ name: "neuve_review_lane", args: {} }), EMPTY)?.summary,
  ).toBe("of this chat's lane");
  expect(reviewTool(start({ name: "bash" }), EMPTY)).toBeUndefined();
});

test("status and outcome rows name the review they read and never show findings", () => {
  const feed: ReviewCards = { c1: card() };
  const status = reviewTool(
    {
      call: "s",
      name: "neuve_review_status",
      args: {},
      result: {
        error: false,
        text: JSON.stringify({
          review: "R1",
          state: "running",
          stage: { done: 1, of: 5, name: "Investigate" },
          new_commits: true,
        }),
      },
    },
    feed,
  );
  expect(status).toEqual({
    name: "Check Neuve review",
    summary: "codex/pi-transition",
    result: "Running, stage 2 of 5: Investigate. The branch has newer commits.",
  });
  const outcome = reviewTool(
    {
      call: "o",
      name: "neuve_review_outcome",
      args: { review: "R1" },
      result: {
        error: false,
        text: JSON.stringify({
          review: "R1",
          complete: false,
          units: 26,
          gaps: 2,
          undecoded: 1,
        }),
      },
    },
    feed,
  );
  expect(outcome?.result).toBe(
    "Incomplete: 26 review units, 2 gaps, 1 undecoded.\nCompleting a review does not approve the change.",
  );
});

test("a start call's card comes from its doc entry, else from the call itself", () => {
  const feed: ReviewCards = { c1: card({ phase: "finished" }) };
  expect(reviewCard(start(), feed, false, true)).toMatchObject({
    phase: "finished",
  });
  // Asked only while the run is live; a call the run never ran shows no card.
  expect(reviewCard(start(), EMPTY, true, true)).toEqual({
    kind: "asked",
    label: "This branch against main",
  });
  expect(reviewCard(start(), EMPTY, false, true)).toBeUndefined();
  expect(reviewCard(start({ unrun: true }), EMPTY, true, true)).toBeUndefined();
  expect(
    reviewCard(
      start({ result: { error: false, text: admitted } }),
      EMPTY,
      false,
      true,
    ),
  ).toMatchObject({
    kind: "review",
    phase: "queued",
    label: "codex/pi-transition against main",
  });
  expect(
    reviewCard(
      start({ result: { error: false, text: "not json" } }),
      EMPTY,
      false,
      true,
    ),
  ).toBeUndefined();
  expect(
    reviewCard(start({ name: "neuve_review_status" }), EMPTY, true, true),
  ).toBeUndefined();
});

test("losing the host shows a live card's last state as connection lost, not a settled one", () => {
  const live: ReviewCards = { c1: card({ phase: "running" }) };
  const settled: ReviewCards = { c1: card({ phase: "stopped" }) };
  expect(reviewCard(start(), live, false, false)).toMatchObject({
    phase: "connection_lost",
  });
  expect(reviewCard(start(), settled, false, false)).toMatchObject({
    phase: "stopped",
  });
});

const items: Item[] = [
  {
    kind: "message",
    key: "m1",
    entry: 1,
    at: 1_000,
    author: "me",
    text: "review",
    invoked: true,
  },
  {
    kind: "reply",
    key: "r1",
    entry: 2,
    at: 2_000,
    model: "",
    text: "",
    tools: [start({ result: { error: false, text: admitted } })],
  },
  {
    kind: "reply",
    key: "r2",
    entry: 3,
    at: 3_000,
    model: "",
    text: "Started it.",
    tools: [],
  },
  {
    kind: "message",
    key: "m2",
    entry: 4,
    at: 9_000,
    author: "me",
    text: "thanks",
    invoked: false,
  },
];

function events(
  list: Item[],
  feed: ReviewCards,
  draft = "",
  by: (asker: string) => string | undefined = () => undefined,
) {
  return withReviews(
    toEvents(
      list,
      "t",
      !!draft,
      { text: draft },
      {},
      new Map(),
      {},
      {},
      {},
      by,
      feed,
    ),
    list,
    feed,
    "t",
    !!draft,
    true,
  );
}

test("the card follows the whole run that started it, so the agent's turn stays in one piece", () => {
  expect(events(items, EMPTY).map((event) => event.uid)).toEqual([
    "m1",
    "r1",
    "r2",
    "review:c1",
    "m2",
  ]);
  // While the run still streams, the card stays under the draft.
  expect(
    events(items.slice(0, 2), EMPTY, "Starting").map((event) => event.uid),
  ).toEqual(["m1", "r1", "draft", "review:c1"]);
});

test("a new-commit event becomes a row under the card of the turn it follows", () => {
  const row = reviewCommits({
    kind: "neuve:review:new-commits",
    chat: 1,
    entry: 7,
    at: 5_000,
    review: "R1",
    branch: "codex/pi-transition",
    reviewedHead: RANGE.head,
    head: "b71d004",
    label: "codex/pi-transition against main",
  });
  // A system row: nothing to copy, react to or delete.
  expect(row).toMatchObject({ kind: "review-commits", key: "e7", text: "" });
  expect("entry" in row).toBe(false);
  const list = events([...items.slice(0, 3), row, items[3]!], {
    c1: card({ phase: "finished" }),
  });
  expect(list.map((event) => event.type)).toEqual([
    "message",
    "message",
    "message",
    "neuve:review:card",
    "neuve:review:new-commits",
    "message",
  ]);
  expect(list[4]).toMatchObject({
    uid: "e7",
    review: "R1",
    branch: "codex/pi-transition",
    head: "b71d004",
  });
});

test("a new review is asked for as an ordinary message to the agent", async () => {
  const sent: string[] = [];
  const ask = async (text: string) => {
    sent.push(text);
  };
  const lane: ReviewCards = { c1: card({ source: "lane" }) };
  await reviewActions(EMPTY, true, ask, () => {}).again(
    "R9",
    "codex/pi-transition against main",
  );
  await reviewActions(lane, true, ask, () => {}).again(
    "R1",
    "codex/pi-transition against main",
  );
  expect(sent).toEqual([
    "@neuve review codex/pi-transition against main again",
    "@neuve review this chat's lane again",
  ]);
});

const KEY = "4f1c9a0e".repeat(8);
const CYCLE = "01JD8Q3ZK6V7W2X9Y4R5T1M0NB";

// Links come from the host; only the Review tab's two entry routes may become links.
test("card links open only Review tab entry routes; others show as plain text", () => {
  expect(reviewEntry(`/review/${KEY}/cycles/${CYCLE}`)).toBe(true);
  expect(reviewEntry(`/review/${KEY}/cycles/${CYCLE}/desk`)).toBe(true);
  for (const path of [
    "https://example.com/desk",
    `//evil.example/review/${KEY}/cycles/${CYCLE}`,
    `/review/${KEY}/api/cycles/${CYCLE}`,
    `/review/${KEY}/cycles/${CYCLE}?returnTo=/x`,
    `/review/${KEY}/cycles/${CYCLE}/../../api`,
    `/review/${KEY.toUpperCase()}/cycles/${CYCLE}`,
    "/review/4f1c/cycles/01JD8Q",
    "javascript:alert(1)",
  ]) {
    expect(reviewEntry(path)).toBe(false);
  }
  const view = reviewCard(
    start(),
    {
      c1: card({
        phase: "finished",
        links: {
          batch: `/review/${KEY}/cycles/${CYCLE}`,
          desk: "https://example.com/desk",
        },
      }),
    },
    false,
    true,
  );
  expect(view).toMatchObject({
    links: { batch: `/review/${KEY}/cycles/${CYCLE}`, desk: null },
  });
});

test("a finished status row carries the no-approval line", () => {
  expect(
    reviewTool(
      {
        call: "s",
        name: "neuve_review_status",
        args: { review: "R1" },
        result: {
          error: false,
          text: JSON.stringify({
            review: "R1",
            state: "finished",
            new_commits: false,
          }),
        },
      },
      EMPTY,
    )?.result,
  ).toBe("Finished.\nCompleting a review does not approve the change.");
});

const WAKE =
  "[Neuve system note] Review R1 is finished. Point the person at the review card without summarizing findings. Completing a review does not approve the change.";
const MARK = { kind: "neuve:review:terminal" as const, review: "R1" };

test("the host's marked notify wake reads as a Neuve row, never as a person's message", () => {
  const wake: Item = {
    kind: "message",
    key: "w",
    entry: 5,
    at: 4_000,
    author: "unknown",
    text: WAKE,
    invoked: true,
    system: MARK,
  };
  // The mark decides, from whoever the message seems to come from.
  expect(wakeNote(wake)).toEqual(MARK);
  expect(wakeNote({ ...wake, author: "me" })).toEqual(MARK);
  // The note's words without the mark are a person's message.
  const { system: _, ...unmarked } = wake;
  expect(wakeNote(unmarked as Item)).toBeUndefined();
  expect(
    reviewNotice({ system: { kind: "other", review: "R1" } }),
  ).toBeUndefined();
  expect(reviewNotice({ system: MARK })).toEqual(MARK);
  const reply: Item = {
    kind: "reply",
    key: "r9",
    entry: 6,
    at: 5_000,
    model: "",
    text: "It finished.",
    tools: [],
  };
  const list = events(
    [...items.slice(0, 3), wake, reply],
    { c1: card({ phase: "finished" }) },
    "",
    (asker) => `asked by ${asker}`,
  );
  expect(list.map((event) => event.type)).toEqual([
    "message",
    "message",
    "message",
    "neuve:review:card",
    "neuve:review:told",
    "message",
  ]);
  expect(list[4]).toMatchObject({ review: "R1", phase: "finished" });
  // The run the wake started was asked by no one, so its reply credits nobody.
  expect(list[5]).toMatchObject({ sender: { kind: "agent" } });
  expect(
    (list[5] as { sender: { credit?: string } }).sender.credit,
  ).toBeUndefined();
});

test("a withdrawn wake is Neuve's note, never returned to a person", () => {
  const list = events(
    [
      items[0]!,
      {
        kind: "reply",
        key: "r",
        entry: 2,
        at: 2_000,
        model: "",
        text: "Stopped.",
        tools: [],
        withdrawn: [
          // The channel protocol's QueuedMessage gains `system` with the host feed's marker commit.
          {
            submission: 1,
            author: "unknown",
            text: WAKE,
            invoked: true,
            system: MARK,
          } as never,
        ],
      },
    ],
    {},
  );
  const text = JSON.stringify(list[1]);
  expect(text).toContain(
    "Withdrew Neuve's note telling the agent the review ended.",
  );
  expect(text).not.toContain("unknown");
});
