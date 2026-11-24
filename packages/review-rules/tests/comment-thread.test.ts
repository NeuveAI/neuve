import { expect, test } from "bun:test";
import { relativeTime } from "../src/comment-thread.ts";

test("a time label shows elapsed time or a date from an ISO string", () => {
  const now = new Date("2026-11-23T14:00:00Z");
  const ago = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();
  expect(relativeTime(ago(0), now)).toBe("now");
  expect(relativeTime(ago(4), now)).toBe("4 min");
  expect(relativeTime(ago(120), now)).toBe("2 h");
  expect(relativeTime("2026-10-02T12:00:00Z", now)).toBe("Oct 2");
  expect(relativeTime("not a time", now)).toBe("not a time");
});
