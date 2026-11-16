import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  openCaptureJournal,
  sha256Of,
} from "../../../src/pi/capture/journal.ts";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
} from "../../../src/session-dump.ts";
import { readDump } from "../../../src/pi/capture/archive.ts";

const root = mkdtempSync(join(tmpdir(), "capture-text-encoding-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const encode = (text: string, encoding: string, bom: boolean) => {
  const bytes = Buffer.from(text, encoding === "utf-8" ? "utf8" : "utf16le");
  if (encoding === "utf-16be") bytes.swap16();
  return Buffer.concat([
    bom
      ? Buffer.from(
          encoding === "utf-8"
            ? [0xef, 0xbb, 0xbf]
            : encoding === "utf-16be"
              ? [0xfe, 0xff]
              : [0xff, 0xfe],
        )
      : Buffer.alloc(0),
    bytes,
  ]);
};

for (const encoding of ["utf-8", "utf-16le", "utf-16be"]) {
  for (const category of ["text", "json", "spill", "text-json"]) {
    for (const bom of [false, true]) {
      test(`${category} ${encoding} BOM=${bom} preserves originals and portable masks`, async () => {
        const runId = `${category}-${encoding}-${bom}`;
        const directory = join(root, runId);
        mkdirSync(directory);
        mkdirSync(join(directory, "datasets"));
        const journal = openCaptureJournal(join(directory, "journal"), runId, {
          spillRoots: [directory],
        });
        journal.capture({
          type: "run.start",
          scope: { runId },
          runKind: "coding",
          sourceRevision: "synthetic",
          route: "local",
          pricing: "subscription",
        });
        const text =
          category === "text"
            ? "你好 😀\nann@example.com PRIVATE-名字"
            : JSON.stringify({
                note: "你好 😀\nann@example.com PRIVATE-名字",
                token: "synthetic",
                nested: [42, null, true],
              });
        const bytes = encode(text, encoding, bom);
        const before = Buffer.from(bytes);
        const mediaType = `${category.startsWith("text") ? "TeXt/PlAiN" : "application/problem+json"}; ChArSeT="${encoding.toUpperCase()}"`;
        if (category === "spill") {
          const path = join(directory, "spill.json");
          writeFileSync(path, bytes);
          await journal.ingest({
            scope: { runId },
            name: "result",
            mediaType,
            path,
          });
          expect(readFileSync(path)).toEqual(before);
        } else
          journal.capture({
            type: "artifact",
            scope: { runId },
            name: "result",
            mediaType,
            bytes,
          });
        journal.close();
        const input = {
          runId,
          journal: journal.directory,
          root: join(directory, "datasets"),
          declared: ["PRIVATE-名字"],
          retention: { policy: "test" },
        };
        const restricted = await exportSnapshot(input);
        const carried = await readDump(restricted.directory);
        const restored = await Effect.runPromise(
          readSessionDump(restricted.directory),
        );
        const artifact = restored.run.artifacts[0]!;
        expect(carried.files.get(artifact.original.file!)!).toEqual(before);
        expect(bytes).toEqual(before);
        expect(artifact.mediaType).toBe(mediaType);
        expect(artifact.sanitization).toBe("sanitized");
        const portable = await exportPortableSnapshot({
          directory: restricted.directory,
          root: input.root,
          retention: input.retention,
        });
        const exported = await readDump(portable.directory);
        const portableRead = await Effect.runPromise(
          readSessionDump(portable.directory),
        );
        const item = portableRead.run.artifacts[0]!;
        const output = exported.files.get(item.file!)!;
        expect(item.mediaType).toBe(mediaType);
        expect(item.sha256).toBe(sha256Of(output));
        expect(item.original.file).toBeNull();
        const decoded = new TextDecoder(encoding, { fatal: true }).decode(
          output,
        );
        if (category === "text")
          expect(decoded).toBe("你好 😀\n<email> <masked>");
        else
          expect(JSON.parse(decoded)).toEqual({
            note: "你好 😀\n<email> <masked>",
            token: "<masked>",
            nested: [42, null, true],
          });
      });
    }
  }
}

for (const [label, mediaType, bytes] of [
  ["unknown", "text/plain; charset=not-an-encoding", Buffer.from("safe")],
  ["unsupported", "text/plain; charset=windows-1252", Buffer.from("safe")],
  [
    "duplicate",
    "text/plain; charset=utf-8; CHARSET=utf-16le",
    Buffer.from("safe"),
  ],
  ["quoted", 'text/plain; charset="utf-16le', Buffer.from("safe")],
  ["missing", "text/plain; charset=", Buffer.from("safe")],
  [
    "contradictory",
    "text/plain; charset=utf-8",
    encode("safe", "utf-16le", true),
  ],
  ["invalid-utf8", "text/plain", Buffer.from([0xc3])],
  ["invalid-utf16", "text/plain; charset=utf-16le", Buffer.from([0x61])],
  ["surrogate", "text/plain; charset=utf-16be", Buffer.from([0xd8, 0x00])],
] as const) {
  test(`${label} direct and spill refuse without rewriting source`, async () => {
    for (const spill of [false, true]) {
      const runId = `${label}-${spill}`;
      const directory = join(root, runId);
      mkdirSync(directory);
      mkdirSync(join(directory, "datasets"));
      const journal = openCaptureJournal(join(directory, "journal"), runId, {
        spillRoots: [directory],
      });
      journal.capture({
        type: "run.start",
        scope: { runId },
        runKind: "coding",
        sourceRevision: "synthetic",
        route: "local",
        pricing: "subscription",
      });
      if (spill) {
        const path = join(directory, "source");
        writeFileSync(path, bytes);
        await journal.ingest({
          scope: { runId },
          name: label,
          mediaType,
          path,
        });
        journal.close();
        await expect(
          exportSnapshot({
            runId,
            journal: journal.directory,
            root: join(directory, "datasets"),
            retention: { policy: "test" },
          }),
        ).rejects.toMatchObject({
          _tag: "DumpFailed",
          reason: expect.stringContaining("source retained"),
        });
        expect(readFileSync(path)).toEqual(bytes);
      } else {
        expect(() =>
          journal.capture({
            type: "artifact",
            scope: { runId },
            name: label,
            mediaType,
            bytes,
          }),
        ).toThrow();
        expect(
          existsSync(join(journal.directory, "objects", sha256Of(bytes))),
        ).toBe(true);
      }
    }
  });
}

test("BOM-only text and WHATWG labels preserve representation, binary stays raw", async () => {
  const runId = "labels-binary";
  const directory = join(root, runId);
  mkdirSync(directory);
  mkdirSync(join(directory, "datasets"));
  const journal = openCaptureJournal(join(directory, "journal"), runId);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: "local",
    pricing: "subscription",
  });
  const sources = [
    {
      name: "bom",
      mediaType: "text/plain",
      bytes: encode("你好 ann@example.com", "utf-16be", true),
    },
    {
      name: "alias",
      mediaType: "text/plain; charset=unicode",
      bytes: encode("你好 ann@example.com", "utf-16le", false),
    },
    {
      name: "utf8",
      mediaType: "text/plain; charset=utf8",
      bytes: encode("你好 ann@example.com", "utf-8", false),
    },
    {
      name: "binary",
      mediaType: "application/octet-stream",
      bytes: Buffer.from([0xff, 0x00, 0x80]),
    },
  ];
  for (const source of sources)
    journal.capture({ type: "artifact", scope: { runId }, ...source });
  journal.close();
  const snapshot = await exportSnapshot({
    runId,
    journal: journal.directory,
    root: join(directory, "datasets"),
    retention: { policy: "test" },
  });
  const restricted = await readDump(snapshot.directory);
  const read = await Effect.runPromise(readSessionDump(snapshot.directory));
  for (const [i, source] of sources.entries())
    expect(
      restricted.files.get(read.run.artifacts[i]!.original.file!)!,
    ).toEqual(source.bytes);
  expect(read.run.artifacts[3]!.sanitization).toBe("raw-uninspected");
  const portable = await exportPortableSnapshot({
    directory: snapshot.directory,
    root: join(directory, "datasets"),
    retention: { policy: "test" },
  });
  const output = await Effect.runPromise(readSessionDump(portable.directory));
  for (const [i, encoding] of ["utf-16be", "utf-16le", "utf-8"].entries())
    expect(
      new TextDecoder(encoding, { fatal: true }).decode(
        output.artifacts.get(output.run.artifacts[i]!.file!)!,
      ),
    ).toBe("你好 <email>");
  expect(output.run.artifacts[3]!.file).toBeNull();
});

test("a portable copy without the current policy refuses even with recomputed export metadata", async () => {
  const runId = "portable-policy";
  const directory = join(root, runId);
  mkdirSync(directory);
  mkdirSync(join(directory, "datasets"));
  const journal = openCaptureJournal(join(directory, "journal"), runId);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: "local",
    pricing: "subscription",
  });
  journal.close();
  const snapshot = await exportSnapshot({
    runId,
    journal: journal.directory,
    root: join(directory, "datasets"),
    retention: { policy: "test" },
  });
  const portable = await exportPortableSnapshot({
    directory: snapshot.directory,
    root: join(directory, "datasets"),
    retention: { policy: "test" },
  });
  const changed = join(directory, "changed");
  cpSync(portable.directory, changed, { recursive: true });
  const manifestPath = join(changed, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.inspectionPolicy;
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(manifestPath, bytes);
  const recordPath = join(changed, "export.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.manifest = sha256Of(bytes);
  writeFileSync(recordPath, JSON.stringify(record));
  await expect(
    Effect.runPromise(readSessionDump(changed)),
  ).rejects.toMatchObject({
    _tag: "DumpRejected",
    reason: expect.stringContaining("inspection policy"),
  });
});
