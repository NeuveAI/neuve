// Why: the journal, its artifact objects and pi's native backup are read into memory to build a
// dump, so a large or tampered file in the run folder could take the process's heap with it. These
// check that every path refuses over the dump's byte budgets from a file's size, before reading
// it, and says so instead of cutting anything short.
import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { buildDump } from "../../../src/pi/capture/build.ts";
import { CloseDiagnostic } from "../../../src/pi/capture/close-diagnostic.ts";
import {
  JOURNAL_FILE,
  OBJECTS_DIRECTORY,
  openCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import type { DumpLimits } from "../../../src/pi/capture/types.ts";

const directory = mkdtempSync(
  join(realpathSync(tmpdir()), "harness-capture-limits-"),
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const folder = () => mkdtempSync(join(directory, "journal-"));
const limits = (objectBytes: number, totalBytes: number): DumpLimits => ({
  manifestBytes: 4096,
  objectBytes,
  totalBytes,
});
const scope = { runId: "R" };
const refusal = (run: () => unknown) =>
  Promise.resolve()
    .then(run)
    .then(
      () => "kept",
      (error: { kind?: string; detail?: string; reason?: string }) =>
        error.reason ?? [error.kind, error.detail],
    );

test("a close diagnostic atomically replaces a file symlink without touching its target", async () => {
  const at = folder();
  const target = join(directory, "diagnostic-target");
  writeFileSync(target, "unchanged");
  symlinkSync(target, join(at, "close-diagnostic.json"));
  writeFileSync(join(at, JOURNAL_FILE), "invalid journal\n");
  expect(await refusal(() => buildDump({ runId: "R", journal: at }))).not.toBe(
    "kept",
  );
  expect(readFileSync(target, "utf8")).toBe("unchanged");
  expect(lstatSync(join(at, "close-diagnostic.json")).isFile()).toBe(true);
  expect(
    CloseDiagnostic.parse(
      JSON.parse(readFileSync(join(at, "close-diagnostic.json"), "utf8")),
    ).outcome,
  ).toBe("refused");
  expect(
    readdirSync(at).some((name) => name.startsWith(".close-diagnostic-")),
  ).toBe(false);
});

test("an artifact or a spill over the object limit is refused at capture", async () => {
  const journal = openCaptureJournal(folder(), "R", {
    limits: limits(200, 1 << 20),
  });
  expect(
    await refusal(() =>
      journal.capture({
        type: "artifact",
        scope,
        name: "big.txt",
        mediaType: "text/plain",
        bytes: new Uint8Array(201),
      }),
    ),
  ).toEqual(["invalid", "big.txt: 201 bytes, over the 200-byte object limit"]);

  const roots = mkdtempSync(join(directory, "spills-"));
  writeFileSync(join(roots, "out.log"), "x".repeat(201));
  const spilling = openCaptureJournal(folder(), "R", {
    spillRoots: [roots],
    limits: limits(200, 1 << 20),
  });
  expect(
    await refusal(() =>
      spilling.ingest({
        scope,
        name: "out",
        mediaType: "text/plain",
        path: join(roots, "out.log"),
      }),
    ),
  ).toEqual([
    "invalid",
    `out: ${join(roots, "out.log")} is over the 200-byte limit`,
  ]);
});

test("a journal is refused once it would outgrow the dump, at capture, at reopen and at build", async () => {
  const at = folder();
  const journal = openCaptureJournal(at, "R", { limits: limits(1024, 400) });
  const start = {
    type: "run.start",
    scope,
    runKind: "coding",
    sourceRevision: { status: "not-applicable", reason: "no repository" },
    route: "chatgpt",
    pricing: "subscription",
  } as const;
  journal.capture(start);
  expect(await refusal(() => journal.capture(start))).toEqual([
    "full",
    `${JOURNAL_FILE} would grow over the 400-byte limit`,
  ]);
  appendFileSync(join(at, JOURNAL_FILE), "x".repeat(400));
  expect(
    await refusal(() =>
      openCaptureJournal(at, "R", { limits: limits(1024, 400) }),
    ),
  ).toEqual([
    "full",
    expect.stringMatching(
      new RegExp(
        `^could not open the capture journal: ${JOURNAL_FILE} is \\d+ bytes, over the 400-byte limit$`,
      ),
    ),
  ]);
  expect(
    await refusal(() =>
      buildDump({ runId: "R", journal: at, limits: limits(1024, 400) }),
    ),
  ).toMatch(/^capture journal is \d+ bytes, over the 400-byte limit$/);
});

test("an artifact object grown or swapped after capture is refused from its size before it is read", async () => {
  const at = folder();
  const journal = openCaptureJournal(at, "R");
  journal.capture({
    type: "artifact",
    scope,
    name: "notes.txt",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("twelve bytes"),
  });
  journal.close();
  const [object] = readdirSync(join(at, OBJECTS_DIRECTORY));
  appendFileSync(join(at, OBJECTS_DIRECTORY, object!), "x".repeat(4096));
  expect(await refusal(() => buildDump({ runId: "R", journal: at }))).toBe(
    `artifact ${object} is 4108 bytes where 12 were recorded`,
  );
  expect(
    await refusal(() =>
      buildDump({ runId: "R", journal: at, limits: limits(1024, 1 << 20) }),
    ),
  ).toBe(`artifact ${object} is 4108 bytes, over the 1024-byte object limit`);
});

test("pi's native backup over the object limit is refused from the copy's size", async () => {
  const at = folder();
  openCaptureJournal(at, "R").close();
  const database = join(directory, "pi.sqlite");
  await (await openNodeSqliteStorage(database)).close(BACKGROUND_CONTEXT);
  expect(
    await refusal(() =>
      buildDump({
        runId: "R",
        journal: at,
        nativeDatabase: database,
        limits: limits(1024, 1 << 20),
      }),
    ),
  ).toMatch(
    new RegExp(
      `^native backup of ${database}: the copy is \\d+ bytes, over the 1024-byte object limit$`,
    ),
  );
  expect(
    readdirSync(directory).filter((name) => name.includes(".backup-")),
  ).toEqual([]);
});
