import { expect, test } from "bun:test";

import type { Listing } from "@ace/host/protocol";

import { pulse } from "../src/pulse";

const now = Date.UTC(2026, 10, 1, 16, 0, 0);
const people = { "owner@example.com": "owner", "mate@example.com": "mate" };
const listing = (id: string, ran: Record<string, unknown>): Listing =>
  ({
    id,
    host: "laptop",
    name: id,
    prefix: id,
    owner: "owner@example.com",
    project: "/project",
    created: now - 60_000,
    state: "running",
    ran: { chat: 1, at: now - 1_000, ...ran },
  }) as Listing;

const wake = { kind: "neuve:review:terminal", review: "01JD8Q3ZK6V7W2X9Y4R5T1M0NB" };

// The integrated run showed "unknown · Finished in #channel" for the turn the review wake
// started: the host's input has no author prefix, so only its mark can say it was Neuve's.
test("a run the review wake started is Neuve's, from the mark alone", () => {
  const team = pulse(
    [
      listing("wake", { outcome: "done", author: "unknown", system: wake }),
      listing("asked", { outcome: "done", author: "mate@example.com" }),
      listing("broke", { outcome: "failed", author: "unknown", system: wake }),
    ],
    [],
    people,
    "owner@example.com",
    0,
    now,
  );
  expect(team.map((row) => [row.login, row.neuve, row.finished.map((c) => c.id), row.failed.map((c) => c.id)]))
    .toEqual([
      ["mate", undefined, ["asked"], []],
      ["Neuve", true, ["wake"], ["broke"]],
    ]);
  expect(team.some((row) => row.login === "unknown")).toBe(false);
});

test("an author named like Neuve, or a mark of another kind, is not Neuve's", () => {
  const team = pulse(
    [
      listing("named", { outcome: "done", author: "Neuve" }),
      listing("other", { outcome: "done", author: "mate@example.com", system: { kind: "other" } }),
      // A run that ended before the last visit stays out, Neuve's too.
      listing("old", { outcome: "done", author: "unknown", system: wake, at: 5 }),
    ],
    [],
    people,
    "owner@example.com",
    10,
    now,
  );
  expect(team.map((row) => [row.login, row.neuve, row.finished.map((c) => c.id)])).toEqual([
    ["mate", undefined, ["other"]],
    ["Neuve", undefined, ["named"]],
  ]);
});
