// The declarations' third state crosses two boundaries with a real built index: the cross-process
// publication (a strict schema parse) and the snapshot file (v8 serialization, then a strict read).
// Either copy must answer `testStatusOf` exactly as the builder does, and the builder's own call must
// succeed. Needs the real engine (`NEUVE_GRAPH_OUTLINE_EXECUTABLE`).
import { existsSync } from "node:fs";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deserialize } from "node:v8";
import { Effect } from "effect";
import { Computations, storeLocationIn } from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { safeRead } from "@neuve/records-schema";
import { testStatusOf, type ReadDeclarations } from "../src/declarations.ts";
import {
  captureOutlineSource,
  outlineExecutable,
} from "../src/graph-outline.ts";
import { IndexSnapshot, knownIndexSnapshot } from "../src/index-snapshot.ts";
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
  } catch {
    return [];
  }
};

/** The four answers the lift asks for, from one copy of the declarations. */
const answers = (declarations: unknown) => {
  const read = declarations as ReadDeclarations;
  return Object.fromEntries(
    ["tests/a.test.ts", "lib/b.test.ts", "src/x.ts", "nowhere/y.ts"].map(
      (path) => [path, testStatusOf(read, path)],
    ),
  );
};

// Why: since `undecided` and `asked` joined the declarations result, every tree-index publication
// failed on the snapshot's strict schema (`unrecognized_keys`), and a copy without them would read
// undecided and unasked paths as not-test; a copy must answer as the builder does, through both the
// publication and the snapshot file, and the builder's own call must succeed.
// These cases read declarations from the built Graph engine; without it every structure is
// unavailable, so they need it (`bun run build:graph`).
const graphPrerequisite = graphTestPrerequisite({
  available: existsSync(outlineExecutable()),
  message:
    "Graph engine is missing at apps/neuve-graph/entire-graph. Run `bun run build:graph` from the workspace root.",
});

test.skipIf(graphPrerequisite.skip)(
  "undecided and asked survive the publication and the snapshot file",
  async () => {
    graphPrerequisite.require();
    const root = mkdtempSync(join(tmpdir(), "declarations-snapshot-"));
    const prior = process.env.NEUVE_BUDGET_DIRECTORY,
      original = SharedWork.prototype.run;
    const directory = join(root, "budget");
    const authority = publicationHost(directory);
    let publication: string | undefined;
    let readPublished: Parameters<typeof original>[0]["crossProcess"];
    try {
      process.env.NEUVE_BUDGET_DIRECTORY = directory;
      const git = (...args: string[]) => {
        const child = Bun.spawnSync(["git", "-C", root, ...args], {
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        });
        if (child.exitCode !== 0) throw new Error(child.stderr.toString());
        return child.stdout.toString().trim();
      };
      git("init", "-q");
      for (const [path, body] of Object.entries({
        "package.json": JSON.stringify({
          scripts: { test: "bun test ./tests" },
        }),
        "tests/a.test.ts": "export const a = 1;\n",
        "lib/b.test.ts": "export const b = 2;\n",
        "src/x.ts": "export const x = 3;\n",
      })) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      git("add", ".");
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "f",
      );
      const tree = git("rev-parse", "HEAD^{tree}");
      const location = storeLocationIn(join(root, "records"));
      SharedWork.prototype.run = new Proxy(original, {
        apply(target, receiver, args) {
          const options: Parameters<typeof original>[0] = args[0];
          if (!options.key.startsWith("tree-index@") || !options.crossProcess)
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
      };
      // The builder's own call: it must succeed even though it is the one that publishes.
      // The snapshot file lives only while the code-work actor holds it (the last release removes
      // the snapshots it understands), so it is read inside the same `withCodeWork`.
      const { built, snapshot } = value(
        await runIn(location)(
          withCodeWork(
            location,
            false,
            Effect.gen(function* () {
              const built = yield* treeIndex(
                root,
                tree,
                captureOutlineSource(),
              );
              const snapshot = yield* Effect.promise(async () => {
                const written = files(root).filter((name) =>
                  name.endsWith(".index"),
                );
                expect(written.length).toBe(1);
                const path = written[0] ?? "";
                return {
                  bytes: readFileSync(path),
                  known: await knownIndexSnapshot(path),
                };
              });
              return { built, snapshot };
            }),
          ).pipe(
            Effect.provide(Computations.layer),
            Effect.provideService(PublicationPolicy, policy),
          ),
        ),
      );
      const expected = answers(built.index.declarations);
      expect(expected).toEqual({
        "tests/a.test.ts": "test",
        "lib/b.test.ts": {
          undecided:
            "test-conventions: named like a Bun test (Bun's test-file rule), and no followed script declares it a test",
        },
        "src/x.ts": "not-test",
        "nowhere/y.ts": {
          undecided: "not among the paths the declarations were read for",
        },
      });
      // The publication, as another process reads it.
      expect(publication).toBeDefined();
      const delivered = await readPublished?.read(publication);
      expect(delivered?.outcome.kind).toBe("succeeded");
      if (delivered?.outcome.kind !== "succeeded")
        throw new Error("not published");
      const published = (
        delivered.outcome.value as { index: { declarations: unknown } }
      ).index;
      expect(answers(published.declarations)).toEqual(expected);
      // The snapshot file, as a later run reads it, and one cleanup understands (so can remove).
      expect(snapshot.known).toBe(true);
      const stored = safeRead(IndexSnapshot, deserialize(snapshot.bytes), {
        notice: false,
      });
      expect(stored.success).toBe(true);
      if (!stored.success) throw stored.error;
      expect(stored.droppedKeys).toEqual([]);
      expect(stored.data.declarations.asked).toBeInstanceOf(Set);
      expect(stored.data.declarations.undecided).toBeInstanceOf(Map);
      expect(answers(stored.data.declarations)).toEqual(expected);
    } finally {
      SharedWork.prototype.run = original;
      authority.host.close();
      if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
      else process.env.NEUVE_BUDGET_DIRECTORY = prior;
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
