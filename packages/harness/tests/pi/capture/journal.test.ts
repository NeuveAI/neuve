// Why: a dump must disclose a rejected capture or a torn line even after the writer exits.
import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDump } from "../../../src/pi/capture/build.ts";
import {
  JOURNAL_FILE,
  OBJECTS_DIRECTORY,
  openCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import type { CaptureEvent } from "../../../src/pi/capture/types.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-capture-journal-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const START: CaptureEvent = {
  type: "run.start",
  scope: { runId: "R" },
  runKind: "scored",
  sourceRevision: "abc123",
  route: "chatgpt",
  pricing: "subscription",
};
const END: CaptureEvent = {
  type: "run.end",
  scope: { runId: "R" },
  status: "completed",
};

const thrown = (run: () => void) => {
  try {
    run();
    return "kept";
  } catch (error) {
    return error;
  }
};

const gapsOf = async (folder: string) =>
  (await buildDump({ runId: "R", journal: folder })).run.gaps.map((gap) => [
    gap.code,
    gap.count,
    gap.detail,
  ]);

test("an invalid event is thrown to its emitter, nothing after it is kept, and the reopened journal's dump says so", async () => {
  const folder = join(directory, "invalid");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  expect(
    thrown(() =>
      journal.capture({
        type: "stage.end",
        scope: { runId: "R", stage: "" },
        status: "completed",
      }),
    ),
  ).toMatchObject({
    _tag: "CaptureFailed",
    kind: "invalid",
    event: "stage.end",
  });
  expect(thrown(() => journal.capture(END))).toMatchObject({
    _tag: "CaptureFailed",
    kind: "failed",
    event: "run.end",
  });
  expect(thrown(() => journal.close())).toMatchObject({ kind: "invalid" });

  const reopened = openCaptureJournal(folder, "R");
  reopened.capture(END);
  reopened.close();
  expect(await gapsOf(folder)).toEqual([
    [
      "journal-failed",
      1,
      "stage.end: scope.stage Too small: expected string to have >=1 characters",
    ],
    [
      "journal-interrupted",
      1,
      "capture sessions opened at line 1 ended without a clean close (a crash, a failed capture, or a capture taken while one was open), so events may be missing",
    ],
  ]);
});

// The session writes through a descriptor it holds, which a later chmod no longer refuses, so the
// refusal is the disk's own: a child under a file-size limit (its SIGXFSZ ignored, as a full disk
// returns an error rather than a signal) writes what fits of one line, then gets EFBIG.
test("a later append replaces the torn tail left by a failed model capture write", async () => {
  const folder = join(directory, "refused");
  const child = Bun.spawnSync(
    [
      "/bin/sh",
      "-c",
      'trap "" XFSZ; ulimit -f 8; exec "$0" "$@"',
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "journal-child.ts"),
      "refuse",
      folder,
    ],
    { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } },
  );
  expect(child.exitCode).toBe(0);
  const seen = JSON.parse(child.stdout.toString());
  expect(seen).toMatchObject({
    refused: "io:model.request",
    next: "kept",
    closed: "io:model.request",
  });
  expect(seen.afterRefusal).toBeGreaterThan(seen.before);
  expect(seen.afterClose).toBeLessThan(seen.afterRefusal);
  expect(statSync(join(folder, JOURNAL_FILE)).size).toBe(seen.afterClose);
  expect((await gapsOf(folder)).map(([code]) => code)).toEqual([
    "journal-interrupted",
  ]);
});

test("a lost artifact leaves a gap in the dump after journal writes recover", async () => {
  const folder = join(directory, "lost-artifact");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  const objects = join(folder, OBJECTS_DIRECTORY);
  chmodSync(objects, 0o500);
  try {
    expect(
      thrown(() =>
        journal.capture({
          type: "artifact",
          scope: { runId: "R" },
          name: "notes.txt",
          mediaType: "text/plain",
          bytes: Buffer.from("lost artifact"),
        }),
      ),
    ).toMatchObject({ kind: "io", event: "artifact" });
  } finally {
    chmodSync(objects, 0o700);
  }
  journal.capture(END);
  expect(thrown(() => journal.close())).toMatchObject({
    kind: "io",
    event: "artifact",
  });
  const { run } = await buildDump({ journal: folder, runId: "R" });
  expect(run.complete).toBe(false);
  expect(run.gaps.map(({ code, count }) => [code, count])).toEqual([
    ["journal-interrupted", 1],
  ]);
  expect(run.gaps[0]?.detail).toContain("Lost writes: artifact.");
});

// R2: a close that raced an ingest marked the session whole while the spill landed after it, so the
// dump called itself complete without the artifact.
test("a close while a spill is still being kept fails the journal instead of marking it whole", async () => {
  const folder = join(directory, "racing");
  const spills = join(directory, "racing-spills");
  mkdirSync(spills);
  writeFileSync(join(spills, "out.log"), "full output\n");
  const journal = openCaptureJournal(folder, "R", { spillRoots: [spills] });
  journal.capture(START);
  journal.capture(END);
  const ingesting = journal
    .ingest({
      scope: { runId: "R" },
      name: "bash full output",
      mediaType: "text/plain",
      path: join(spills, "out.log"),
    })
    .then(
      () => "kept",
      (error: { kind: string }) => error.kind,
    );
  expect(thrown(() => journal.close())).toMatchObject({
    _tag: "CaptureFailed",
    kind: "invalid",
    event: "journal.close",
  });
  expect(await ingesting).toBe("failed");
  const dump = await buildDump({ runId: "R", journal: folder });
  expect(dump.run.artifacts).toEqual([]);
  expect(dump.run.complete).toBe(false);
  expect(dump.run.gaps.map((gap) => [gap.code, gap.detail])).toEqual([
    [
      "journal-failed",
      "journal.close: 1 artifact ingest(s) still in flight; the session is not whole",
    ],
    [
      "journal-interrupted",
      "capture sessions opened at line 1 ended without a clean close (a crash, a failed capture, or a capture taken while one was open), so events may be missing",
    ],
  ]);
});

test("a line cut short by a crash is moved aside on reopen and disclosed as torn", async () => {
  const folder = join(directory, "torn");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  const tail = '{"v":1,"seq":3,"at":1,"event":{"type":"' + "￥".repeat(30_000);
  appendFileSync(join(folder, JOURNAL_FILE), tail);
  const reopened = openCaptureJournal(folder, "R");
  reopened.capture(END);
  reopened.close();
  const torn = readdirSync(folder).filter((name) => name.startsWith("torn-"));
  expect(torn).toHaveLength(1);
  const [partial] = torn;
  if (!partial) throw new Error("Expected a torn journal frame");
  expect(readFileSync(join(folder, partial), "utf8")).toBe(tail);
  expect((await gapsOf(folder)).map(([code, count]) => [code, count])).toEqual([
    ["journal-torn", 1],
    ["journal-interrupted", 1],
  ]);
});

test("events of another run, calls never requested and artifacts their media type cannot read are refused at capture", () => {
  const capture = (event: CaptureEvent) => {
    const journal = openCaptureJournal(
      join(directory, `refuse-${Math.random()}`),
      "R",
    );
    return thrown(() => journal.capture(event));
  };
  expect(capture({ ...START, scope: { runId: "OTHER" } })).toMatchObject({
    kind: "invalid",
    detail: "belongs to run OTHER, not R",
  });
  expect(
    capture({
      ...START,
      sourceRevision: { status: "not-applicable", reason: "no repository" },
    }),
  ).toMatchObject({
    kind: "invalid",
    detail: "sourceRevision a review run names its source revision",
  });
  expect(
    capture({
      type: "model.request",
      scope: { runId: "R" },
      callId: "c1",
      route: "chatgpt",
      provider: "openai",
      model: "gpt-5.5",
      credentialCoverage: "none",
      headerNames: [],
      body: { status: "sent", json: { stream: Number.NaN } },
    }),
  ).toMatchObject({ kind: "invalid", event: "model.request" });
  expect(
    capture({
      type: "model.end",
      scope: { runId: "R" },
      callId: "c9",
      outcome: "completed",
    }),
  ).toMatchObject({ kind: "invalid", detail: "call c9 was never requested" });
  expect(
    capture({
      type: "artifact",
      scope: { runId: "R" },
      name: "review.json",
      mediaType: "application/json",
      bytes: new TextEncoder().encode('{"cut": "sho'),
    }),
  ).toMatchObject({ kind: "invalid", event: "artifact" });
  expect(
    capture({
      type: "artifact",
      scope: { runId: "R" },
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new Uint8Array([0xff, 0xfe, 0x00]),
    }),
  ).toMatchObject({
    kind: "invalid",
    detail:
      "notes.txt (text/plain): invalid or unsupported artifact text representation",
  });
});

test("a request body the provider could not read is kept as missing and the dump names the gap", async () => {
  const folder = join(directory, "bodiless");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  journal.capture({
    type: "model.request",
    scope: { runId: "R", agent: "dispose.u1" },
    callId: "c1",
    route: "chatgpt",
    provider: "openai",
    model: "gpt-5.5",
    credentialCoverage: "none",
    headerNames: ["content-type"],
    body: { status: "missing", reason: "body was a stream" },
  });
  journal.capture({
    type: "model.end",
    scope: { runId: "R" },
    callId: "c1",
    outcome: "failed",
    error: { message: "x" },
  });
  journal.capture(END);
  journal.close();
  expect(
    (await gapsOf(folder)).filter(([code]) => code === "request-missing"),
  ).toEqual([["request-missing", 1, "c1: body was a stream"]]);
});
