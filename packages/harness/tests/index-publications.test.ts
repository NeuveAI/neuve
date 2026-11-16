// Reproduces B1 through real Git, Records, index materialization, serialization and actor cleanup.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { deserialize } from "node:v8";
import { Effect } from "effect";
import { Computations, storeLocationIn } from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { treeIndex } from "../src/search-index.ts";
import { PublicationPolicy } from "../src/shared-publication.ts";
import { withCodeWork } from "../src/code-work.ts";
import { runIn, value } from "./pi/capture/fixture.ts";
import { publicationHost } from "./fixtures/publication-host.ts";

const files = (folder: string): string[] => {
  try {
    return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(folder, entry.name))
        : [join(folder, entry.name)],
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
};

const payloads = (folder: string) =>
  files(folder).filter(
    (name) =>
      name.includes("/shared-indexes-v4/") &&
      /^[0-9a-f-]{36}$/.test(basename(name)),
  );

// Why (the oversized case, round 12i): an index too large to publish is still a valid index, so the
// call that built it keeps and returns it (it failed before 12i), while a subscriber in another
// process still reads the one bounded failure, as before, and nothing is stored.
for (const oversized of [false, true])
  test(
    oversized
      ? "an oversized shared index records one bounded failure for its subscribers and the builder keeps its index"
      : "warm shared indexes write nothing and source changes replace superseded copies",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "index-publications-"));
      const prior = process.env.NEUVE_BUDGET_DIRECTORY,
        original = SharedWork.prototype.run;
      const directory = join(root, "budget");
      const authority = publicationHost(directory);
      let publication: string | undefined;
      let readPublished: Parameters<typeof original>[0]["crossProcess"];
      try {
        process.env.NEUVE_BUDGET_DIRECTORY = directory;
        const git = (args: string[], input?: string) => {
          const child = Bun.spawnSync(["git", "-C", root, ...args], {
            ...(input === undefined
              ? {}
              : { stdin: new TextEncoder().encode(input) }),
          });
          if (child.exitCode !== 0) throw new Error(child.stderr.toString());
          return child.stdout.toString().trim();
        };
        git(["init", "-q"]);
        const makeTree = (text: string) => {
          const blob = git(["hash-object", "-w", "--stdin"], text);
          return git(["mktree"], `100644 blob ${blob}\tREADME.md\n`);
        };
        const tree = makeTree(
          oversized
            ? "# Large\n\n" + "index content ".repeat(2000)
            : "# Small\n\nSome text.\n",
        );
        const location = storeLocationIn(join(root, "records"));
        const source = (name: string) => ({
          executable: join(root, name),
          key: { unavailable: join(root, name) },
        });
        SharedWork.prototype.run = new Proxy(original, {
          apply(target, receiver, args) {
            const options: Parameters<typeof original>[0] = args[0];
            if (
              !options.key.startsWith("tree-index@1") ||
              !options.crossProcess
            )
              return Reflect.apply(target, receiver, args);
            const crossProcess = {
              ...options.crossProcess,
              transport: authority.transport,
            };
            readPublished = crossProcess;
            return Reflect.apply(target, receiver, [
              {
                ...options,
                crossProcess,
                run: async (signal: AbortSignal) => {
                  const stored = await options.run(signal);
                  if ("publication" in stored) publication = stored.publication;
                  return stored;
                },
              },
            ]);
          },
        });
        const policy = {
          ...PublicationPolicy.defaultValue(),
          authority: authority.authority,
          ...(oversized ? { maximumBytes: 2048 } : {}),
        };
        const run = (revision: string, engine: ReturnType<typeof source>) =>
          runIn(location)(
            withCodeWork(
              location,
              false,
              treeIndex(root, revision, engine),
            ).pipe(
              Effect.provide(Computations.layer),
              Effect.provideService(PublicationPolicy, policy),
            ),
          );
        if (oversized) {
          // The builder keeps its index (round 12i: was a `PublicationTooLarge` failure).
          const kept = value(await run(tree, source("engine-a")));
          expect(kept.cached).toBe(false);
          expect(kept.index.tree).toBe(tree);
          expect(publication).toBeDefined();
          const delivered = await readPublished?.read(publication);
          expect(delivered?.outcome.kind).toBe("failed");
          if (delivered?.outcome.kind === "failed") {
            expect(delivered.outcome.error).toBeInstanceOf(
              Computations.SharedAttemptFailed,
            );
            if (
              delivered.outcome.error instanceof
              Computations.SharedAttemptFailed
            )
              expect(delivered.outcome.error.tag).toBe("PublicationTooLarge");
          }
          const retained = payloads(directory);
          expect(retained).toHaveLength(0);
        } else {
          const first = value(await run(tree, source("engine-a")));
          expect(first.cached).toBe(false);
          const initial = files(directory).reduce(
            (sum, name) => sum + statSync(name).size,
            0,
          );
          expect(payloads(directory)).toHaveLength(1);
          for (let n = 0; n < 5; n++) {
            expect(value(await run(tree, source("engine-a"))).cached).toBe(
              true,
            );
            expect(
              files(directory).reduce(
                (sum, name) => sum + statSync(name).size,
                0,
              ),
            ).toBe(initial);
            expect(payloads(directory)).toHaveLength(1);
            expect(
              readdirSync(
                join(location.directory, "code-work", "indexes"),
              ).filter((n) => n.endsWith(".index")),
            ).toEqual([]);
          }
          value(await run(tree, source("engine-b")));
          expect(payloads(directory)).toHaveLength(1);
          const otherTree = makeTree("# Another tree\n\nOther content.\n");
          value(await run(otherTree, source("engine-b")));
          expect(payloads(directory)).toHaveLength(1);
          value(await run(tree, source("engine-c")));
          expect(payloads(directory)).toHaveLength(1);
          for (let n = 0; n < 8; n++) {
            value(
              await run(
                makeTree(`# Tree ${n}\n\nUnique ${n}\n`),
                source("engine-c"),
              ),
            );
            expect(payloads(directory)).toHaveLength(1);
          }
        }
      } finally {
        SharedWork.prototype.run = original;
        authority.host.close();
        if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
        else process.env.NEUVE_BUDGET_DIRECTORY = prior;
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
