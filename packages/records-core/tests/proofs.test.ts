// Why (H4b, 11.2): a proof record wrongly decoded, or wrongly treated as current, would pass as proof.
// These check the boundaries of `proof.recorded@1` (what decodes, what is refused, and that a rebuild
// reproduces its projection, and that the log refuses a record whose artefact bytes are missing or
// not what it says) and the currency rule of 11.10 from real git objects: current only when
// none of the unit's owned files changed after the record's commit up to the head; stale, with the
// reason, for a later change, a commit outside the head's history and an unknown commit.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { RecordEvent } from "@neuve/records-schema";
import { Admin, Blobs, Log, Proofs, mintUlid } from "../src/index.ts";
import {
  actor,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

const repositories: Array<string> = [];
afterAll(() => {
  removeTemporaryDirectories();
  for (const directory of repositories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const range = {
  baseRef: "main",
  baseOid: "b".repeat(40),
  headOid: "c".repeat(40),
};

const worktree = { head: "c".repeat(40), scope: "tracked-tree", dirty: false };

const proofEvent = (overrides: Record<string, unknown> = {}) => ({
  id: mintUlid(),
  kind: "proof.recorded@1",
  idempotencyKey: `proof:${mintUlid()}`,
  actor,
  occurredAt: "2026-10-19T10:00:00.000Z",
  attribution: { range, sessionId: "session-1" },
  refs: [{ ref: `blob:${"d".repeat(64)}`, role: "artefact" }],
  payload: {
    kind: "screenshot",
    revision: "c".repeat(40),
    claim: "The revoked link opens to an access-denied page.",
    requirement: { text: "A revoked link stops working", scopeItem: "DOD-2" },
    artefact: { mediaType: "image/png", bytes: 52_114 },
    worktree,
  },
  ...overrides,
});

test("proof.recorded@1 decodes with its recorder, range and artefact, and refuses what would misstate proof", () => {
  expect(RecordEvent.safeParse(proofEvent()).success).toBe(true);
  const refused = (event: unknown) => RecordEvent.safeParse(event).success;
  const base = proofEvent();
  // A media type the kind does not take: a "screenshot" that is a text file.
  expect(
    refused({
      ...base,
      payload: {
        ...base.payload,
        artefact: { mediaType: "text/plain; charset=utf-8", bytes: 10 },
      },
    }),
  ).toBe(false);
  // No artefact ref, or a ref in another role.
  expect(refused({ ...base, refs: [] })).toBe(false);
  expect(
    refused({ ...base, refs: [{ ref: base.refs[0]!.ref, role: "vent" }] }),
  ).toBe(false);
  // The recorder's session and the range are required.
  expect(refused({ ...base, attribution: { range } })).toBe(false);
  expect(refused({ ...base, attribution: { sessionId: "s" } })).toBe(false);
  // A record supersedes nothing, and its claim is capped and has text.
  expect(refused({ ...base, causation: { supersedes: mintUlid() } })).toBe(
    false,
  );
  expect(
    refused({ ...base, payload: { ...base.payload, claim: "x".repeat(501) } }),
  ).toBe(false);
  expect(refused({ ...base, payload: { ...base.payload, claim: "   " } })).toBe(
    false,
  );
  expect(
    refused({
      ...base,
      payload: { ...base.payload, kind: "verify-script" },
    }),
  ).toBe(false);
});

test("the log keeps a proof only when its artefact bytes are stored as it says; each projects one row, which rebuild reproduces", async () => {
  const location = freshLocation();
  const screenshot = new Uint8Array(52_114).fill(7);
  const output = new TextEncoder().encode("3 pass\n0 fail\n");
  const artefact = (bytes: Uint8Array, mediaType: string) =>
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const stored = yield* blobs.put({
        bytes,
        mediaType,
        retention: "raw-capture",
      });
      return stored.blob.hash;
    });
  const result = await runOn(
    location,
    Effect.gen(function* () {
      const imageHash = yield* artefact(screenshot, "image/png");
      const textHash = yield* artefact(output, "text/plain; charset=utf-8");
      const first = proofEvent({
        refs: [{ ref: `blob:${imageHash}`, role: "artefact" }],
      });
      const second = proofEvent({
        refs: [{ ref: `blob:${textHash}`, role: "artefact" }],
        payload: {
          kind: "test-run",
          revision: "b".repeat(40),
          claim: "The revoke test passes.",
          requirement: { text: "A revoked link stops working" },
          artefact: {
            mediaType: "text/plain; charset=utf-8",
            bytes: output.byteLength,
          },
          worktree: { ...worktree, dirty: true },
        },
      });
      const outcome = (event: unknown) =>
        Effect.match(Log.append([event]), {
          onFailure: (error) => error._tag,
          onSuccess: () => "appended",
        });
      const refusals = {
        // No blob holds these bytes.
        missing: yield* outcome(proofEvent()),
        // The stored bytes are a PNG of another size than the record states.
        wrongSize: yield* outcome(
          proofEvent({
            refs: first.refs,
            payload: {
              ...first.payload,
              artefact: { mediaType: "image/png", bytes: 10 },
            },
          }),
        ),
      };
      yield* Log.append([first, second]);
      const report = yield* Admin.rebuild;
      return {
        first,
        second,
        refusals,
        report,
        history: yield* Log.history({ kind: "proof.recorded@1" }),
      };
    }).pipe(Effect.provide(Blobs.layer(location))),
  );
  expect(result.refusals).toEqual({
    missing: "InvalidEvent",
    wrongSize: "InvalidEvent",
  });
  // The fixtures are plain objects, so the decoded events are compared as values.
  expect(result.history.map((stored): unknown => stored.event)).toEqual([
    result.first,
    result.second,
  ]);
  const before = result.report.before.find(
    (row) => row.table === "projection_proofs",
  );
  const after = result.report.after.find(
    (row) => row.table === "projection_proofs",
  );
  expect(before?.rows).toBe(2);
  expect(after).toEqual(before);
});

/** A repository whose history is: A adds a.ts and b.ts; B changes a.ts; C changes b.ts; side branch S off B. */
const history = () => {
  const repository = mkdtempSync(join(tmpdir(), "records-core-proofs-"));
  repositories.push(repository);
  const git = (...args: Array<string>) => {
    const run = Bun.spawnSync(
      [
        "git",
        "-C",
        repository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(repository, path), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const a = commit({ "a.ts": "1\n", "b.ts": "1\n" }, "A");
  const b = commit({ "a.ts": "2\n" }, "B");
  const c = commit({ "b.ts": "2\n" }, "C");
  git("checkout", "-q", "-b", "side", b);
  const s = commit({ "c.ts": "1\n" }, "S");
  git("checkout", "-q", "main");
  return { repository, a, b, c, s };
};

test("a record is current for a unit only if none of its owned files changed after its commit", async () => {
  const { repository, a, b, c, s } = history();
  const check = Proofs.currencyChecker({ repository, headOid: c });
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  // B changed a.ts; nothing touched a.ts after B, so a record at B is current for a unit owning it.
  expect(await run(check(b, ["a.ts"]))).toEqual({ status: "current" });
  // At the head, every unit's files are as observed.
  expect(await run(check(c, ["a.ts", "b.ts"]))).toEqual({ status: "current" });
  // C changed b.ts after B: stale for a unit owning b.ts, with the file named.
  expect(await run(check(b, ["b.ts"]))).toEqual({
    status: "stale",
    reason: "changed-after",
    changed: ["b.ts"],
    changedCount: 1,
  });
  // A record at A predates B's change to a.ts: stale even though a later commit (C) left a.ts alone.
  expect(await run(check(a, ["a.ts", "untouched.ts"]))).toEqual({
    status: "stale",
    reason: "changed-after",
    changed: ["a.ts"],
    changedCount: 1,
  });
  // A commit the head does not descend from is stale, even when the owned file is identical.
  expect(await run(check(s, ["a.ts"]))).toEqual({
    status: "stale",
    reason: "not-in-history",
  });
  expect(await run(check("e".repeat(40), ["a.ts"]))).toEqual({
    status: "stale",
    reason: "unknown-revision",
  });
  // A unit owns at least one path: no paths is refused, never read as current.
  const empty = await Effect.runPromise(
    Effect.match(check(b, []), {
      onFailure: (error) => error._tag,
      onSuccess: () => "checked",
    }),
  );
  expect(empty).toBe("ProofRefused");
});
