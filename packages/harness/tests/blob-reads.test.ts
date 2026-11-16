// Why: every index, hunk and declaration reads blob bytes through one streaming parser of
// `git cat-file --batch`. A parsing slip at a chunk boundary, an empty blob or a missing object
// would silently corrupt chunks or shift every later blob, and nothing downstream would fail.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { readBlobs } from "../src/git-objects.ts";

const repository = mkdtempSync(join(tmpdir(), "harness-blobs-"));
afterAll(() => rmSync(repository, { recursive: true, force: true }));

const hashObject = (bytes: Uint8Array) => {
  const result = Bun.spawnSync(
    ["git", "-C", repository, "hash-object", "-w", "--stdin"],
    { stdin: bytes },
  );
  return result.stdout.toString().trim();
};

test("blobs are read exactly, across chunk boundaries, with heads only when asked", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  const large = new Uint8Array(300_000).map((_, index) => (index * 7) % 251);
  const blobs = [
    new TextEncoder().encode("first\n"),
    new Uint8Array(0),
    large,
    new TextEncoder().encode("after the large one\n"),
  ];
  const oids = blobs.map(hashObject);
  const missing = "0".repeat(39) + "1";
  const whole = await Effect.runPromise(
    readBlobs(repository, [...oids, missing]),
  );
  expect(whole.size).toBe(4);
  blobs.forEach((bytes, index) =>
    expect(Buffer.compare(whole.get(oids[index]!)!, bytes)).toBe(0),
  );
  const heads = await Effect.runPromise(
    readBlobs(repository, oids, { headBytes: 16 }),
  );
  expect(heads.get(oids[2]!)!.length).toBe(16);
  expect(Buffer.compare(heads.get(oids[2]!)!, large.subarray(0, 16))).toBe(0);
  expect(new TextDecoder().decode(heads.get(oids[3]!))).toBe(
    "after the large ",
  );
});
