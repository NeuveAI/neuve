import { expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  appendFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { readOutlines, captureOutlineSource } from "../src/graph-outline.ts";
import {
  PublicationPolicy,
  PUBLICATION_MAGIC,
} from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";
import { deserialize, serialize } from "node:v8";
const files = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)],
  );

const payloads = (root: string) =>
  files(root).filter((name) => /^[0-9a-f-]{36}$/.test(basename(name)));

for (const stable of [false, true])
  test.skipIf(stable && !process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
    stable
      ? "warm outlines write nothing and a changed engine replaces its batch copy"
      : "retryable outlines keep bounded attempts and preserve a newer build's fields",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "outline-publications-"));
      const priorDirectory = process.env.NEUVE_BUDGET_DIRECTORY,
        priorEngine = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
      const authority = publicationHost(root);
      try {
        process.env.NEUVE_BUDGET_DIRECTORY = root;
        if (!stable)
          process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = join(
            root,
            "absent-engine",
          );
        const source = captureOutlineSource();
        const input = [
          {
            path: "one.ts",
            bytes: new TextEncoder().encode(
              "export function one() { return 1; }\n",
            ),
          },
        ];
        const policy = {
          ...PublicationPolicy.defaultValue(),
          authority: authority.authority,
        };
        const run = (bound = source) =>
          readOutlines(input, bound, undefined, (run) => run(1), false, policy);
        expect((await run()).context("one.ts").kind).toBe(
          stable ? "available" : "unavailable",
        );
        const retained = payloads(join(root, "shared-outlines-v4"));
        expect(retained).toHaveLength(1);
        const filename = retained[0]!;
        const initial = readFileSync(filename);
        for (let n = 0; n < 4; n++) {
          expect((await run()).context("one.ts").kind).toBe(
            stable ? "available" : "unavailable",
          );
          expect(payloads(join(root, "shared-outlines-v4"))).toHaveLength(1);
          if (stable) expect(readFileSync(filename)).toEqual(initial);
          else
            expect(payloads(join(root, "shared-outlines-v4"))[0]).not.toBe(
              filename,
            );
        }
        if (stable) {
          const next = join(root, "next-engine");
          copyFileSync(source.executable, next);
          appendFileSync(next, "\n");
          process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = next;
          expect(
            (await run(captureOutlineSource())).context("one.ts").kind,
          ).toBe("available");
          expect(payloads(join(root, "shared-outlines-v4"))).toHaveLength(1);
          // Too large to publish: the holder keeps its outline, and nothing is stored.
          const unpublished = await readOutlines(
            [
              {
                path: "large.ts",
                bytes: new TextEncoder().encode(
                  Array.from(
                    { length: 40 },
                    (_, i) => `export function named${i}() { return ${i}; }`,
                  ).join("\n"),
                ),
              },
            ],
            captureOutlineSource(),
            undefined,
            (run) => run(1),
            false,
            { ...policy, maximumBytes: 2048 },
          );
          expect(unpublished.context("large.ts").kind).toBe("available");
          expect(payloads(join(root, "shared-outlines-v4"))).toHaveLength(1);
        } else {
          const current = payloads(join(root, "shared-outlines-v4"))[0];
          if (!current) throw new Error("No retryable publication");
          const stored = deserialize(
            readFileSync(current).subarray(PUBLICATION_MAGIC.length),
          );
          stored.value.outcome.value.future = true;
          const newer = Buffer.concat([PUBLICATION_MAGIC, serialize(stored)]);
          await Bun.write(current, newer);
          expect((await run()).context("one.ts").kind).toBe("unavailable");
          expect(readFileSync(current)).toEqual(newer);
        }
      } finally {
        authority.host.close();
        if (priorDirectory === undefined)
          delete process.env.NEUVE_BUDGET_DIRECTORY;
        else process.env.NEUVE_BUDGET_DIRECTORY = priorDirectory;
        if (priorEngine === undefined)
          delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
        else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = priorEngine;
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
