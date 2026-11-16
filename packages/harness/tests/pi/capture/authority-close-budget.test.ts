// Retry state is per immutable capture; failed metadata I/O never authorizes a refusal.
import { afterAll, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authorityCloseRefusal,
  clearAuthorityCloseFailures,
  AUTHORITY_CLOSE_MIN_AGE_MS,
  AUTHORITY_UNAVAILABLE,
} from "../../../src/pi/capture/authority-close.ts";
const root = fs.mkdtempSync(join(tmpdir(), "authority-budget-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const error = Object.assign(new Error("synthetic authority I/O"), {
  code: "EIO",
});
const capture = (digit: string) => `capture.filed:${digit.repeat(64)}`;

test("three rapid failures retain the same capture until its ten-minute floor", () => {
  const source = join(root, "rapid");
  fs.mkdirSync(source);
  for (const now of [0, 1, 2])
    expect(() =>
      authorityCloseRefusal(source, capture("a"), error, now),
    ).toThrow(error);
  expect(
    authorityCloseRefusal(
      source,
      capture("a"),
      error,
      AUTHORITY_CLOSE_MIN_AGE_MS + 1,
    ),
  ).toBe(AUTHORITY_UNAVAILABLE);
});

test("a new capture has its own count and successful filing clears the retry record", () => {
  const source = join(root, "new");
  fs.mkdirSync(source);
  for (const now of [0, AUTHORITY_CLOSE_MIN_AGE_MS])
    expect(() =>
      authorityCloseRefusal(source, capture("a"), error, now),
    ).toThrow(error);
  expect(() =>
    authorityCloseRefusal(
      source,
      capture("b"),
      error,
      AUTHORITY_CLOSE_MIN_AGE_MS + 1,
    ),
  ).toThrow(error);
  const path = join(source, ".capture-authority-failures.json");
  expect(JSON.parse(fs.readFileSync(path, "utf8"))).toMatchObject({
    capture: capture("b"),
    failures: 1,
  });
  clearAuthorityCloseFailures(source);
  expect(fs.existsSync(path)).toBe(false);
});

test("a real counter write failure retains even a backdated folder", () => {
  const source = join(root, "counter-io");
  fs.mkdirSync(source);
  const born = Date.now() - 2 * 86_400_000;
  fs.utimesSync(source, born / 1000, born / 1000);
  const original = fs.writeFileSync;
  const patch = spyOn(fs, "writeFileSync").mockImplementation(
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[1] === "string" && args[1].includes("firstFailureAt"))
        throw Object.assign(new Error("synthetic retry metadata I/O"), {
          code: "EIO",
        });
      return original(...args);
    },
  );
  try {
    expect(() =>
      authorityCloseRefusal(source, capture("c"), error, Math.ceil(born) + 1),
    ).toThrow(error);
    expect(() =>
      authorityCloseRefusal(source, capture("c"), error, Date.now()),
    ).toThrow(error);
  } finally {
    patch.mockRestore();
  }
});

test("a future first-failure time is clamped to the current clock", () => {
  const source = join(root, "future");
  fs.mkdirSync(source);
  const path = join(source, ".capture-authority-failures.json");
  fs.writeFileSync(
    path,
    JSON.stringify({
      capture: capture("a"),
      failures: 3,
      firstFailureAt: 9999999,
      future: true,
    }),
  );
  expect(() => authorityCloseRefusal(source, capture("a"), error, 100)).toThrow(
    error,
  );
  expect(JSON.parse(fs.readFileSync(path, "utf8"))).toMatchObject({
    firstFailureAt: 100,
    future: true,
  });
  clearAuthorityCloseFailures(source);
  expect(fs.existsSync(path)).toBe(true);
});

test("retry cleanup keeps an unknown counter format rather than treating it as absent", () => {
  const source = join(root, "newer-counter");
  fs.mkdirSync(source);
  const path = join(source, ".capture-authority-failures.json");
  const text = JSON.stringify({ version: 99, newer: true });
  fs.writeFileSync(path, text);
  clearAuthorityCloseFailures(source);
  expect(fs.readFileSync(path, "utf8")).toBe(text);
});
