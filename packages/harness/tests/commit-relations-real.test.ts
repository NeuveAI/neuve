// Commit preparation's relations step on the real engine, through the worker's own preparation
// children (`neuve worker prepare-commit` and `prepare-code`), with the user's settings in a home of
// the test's own. It runs only where the engine is built (`bun run build:graph`).
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Logger, References } from "effect";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { hostBudget } from "../src/budget/local.ts";
import { commitHunksSpec, prepareCommitArgs } from "../src/commit-prepare.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { graphClone } from "../src/graph-search.ts";
import { workerParentArgs } from "../src/heavy-child.ts";
import {
  isRelationsGap,
  readRelationsIndex,
  relationsGraphDirectory,
  relationsReadsInFlight,
  relationsRound,
} from "../src/relations.ts";
import { settingsPath } from "../src/settings.ts";

const cli = resolve(import.meta.dir, "../../../apps/neuve-cli/src/cli.ts");
const source = captureOutlineSource();
const capable = (() => {
  if (!("sha256" in source.key)) return false;
  const result = Bun.spawnSync([source.executable, "capabilities", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (
    result.exitCode === 0 &&
    result.stdout.toString().includes('"exact_commit_bulk_streams":true')
  );
})();
const graphPrerequisite = graphTestPrerequisite({
  available: capable,
  message:
    "Graph engine is missing or stale: apps/neuve-graph/entire-graph must declare exact_commit_bulk_streams. Run `bun run build:graph` from the workspace root.",
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A repository with `main` at `base` and `feature` one commit ahead at `head`, checked out. */
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "commit-relations-real-"));
  roots.push(root);
  const repository = join(root, "repo");
  mkdirSync(repository);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-C",
        repository,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(repository, path, ".."), { recursive: true });
    writeFileSync(join(repository, path), text);
  };
  git("init", "-q", "-b", "main");
  write(
    "src/paths.ts",
    'export function home(): string {\n  return "/home";\n}\n',
  );
  write(
    "src/use.ts",
    'import { home } from "./paths";\nexport function where() {\n  return home() + "/x";\n}\n',
  );
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  write(
    "src/paths.ts",
    'export function home(): string {\n  return "/users";\n}\n',
  );
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");
  /** The user's settings, in a home of this fixture's own. */
  const home = (settings: object) => {
    const directory = join(root, "home");
    mkdirSync(dirname(settingsPath(directory)), { recursive: true });
    writeFileSync(settingsPath(directory), JSON.stringify(settings));
    return directory;
  };
  const run = (args: ReadonlyArray<string>, settings: object) => {
    const child = Bun.spawnSync([process.execPath, cli, ...args], {
      env: { ...process.env, HOME: home(settings) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    expect(child.exitCode, output).toBe(0);
    return output;
  };
  const prepareCommit = (oid: string, settings: object) =>
    run(
      prepareCommitArgs(repository, {
        oid,
        parents: oid === base ? [] : [base],
        tree: git("rev-parse", `${oid}^{tree}`),
      }),
      settings,
    );
  /** Relations attempts in the store: one per engine run, whatever its outcome. */
  const attempts = async () => {
    const location = await Effect.runPromise(resolveStoreLocation(repository));
    if (!existsSync(location.database)) return 0;
    const database = new Database(location.database, { readonly: true });
    try {
      return (
        database
          .query(
            "SELECT count(*) AS n FROM computation_attempts WHERE op = 'harness.graph-relations'",
          )
          .get() as { n: number }
      ).n;
    } finally {
      database.close();
    }
  };
  return {
    root,
    repository,
    git,
    base,
    head,
    run,
    prepareCommit,
    attempts,
  };
};

const READINGS_ON = { version: 1, review: { sectionReadings: "probe" } };

// Why: the coordinator's test. A review's readings decide in their first seconds whether relations
// are stored; prepared at commit time, a review started after finds both sides stored, starts no
// engine and makes no clone.
test.skipIf(graphPrerequisite.skip)(
  "a review started after preparation finds both sides stored without starting a read",
  async () => {
    graphPrerequisite.require();
    const s = fixture();
    // The base, prepared while it was main's tip (feature is checked out; main still points at it).
    const first = s.prepareCommit(s.base, READINGS_ON);
    expect(first).toContain(
      `commit.prepare relations ${s.base.slice(0, 12)}: commit ${s.base.slice(0, 12)} read in`,
    );
    expect(first).toContain(
      "merge base skipped: the commit is on refs/heads/main",
    );
    const second = s.prepareCommit(s.head, READINGS_ON);
    expect(second).toContain(`commit ${s.head.slice(0, 12)} read in`);
    expect(second).toContain(
      `merge base ${s.base.slice(0, 12)} already stored`,
    );
    expect(await s.attempts()).toBe(2);
    const location = await Effect.runPromise(
      resolveStoreLocation(s.repository),
    );
    // The children read the store's one Graph clone, the review's. Taken away here, so a clone
    // made by the review's round below would show.
    const graphDirectory = relationsGraphDirectory(location);
    expect(existsSync(join(graphDirectory, "clones"))).toBe(true);
    rmSync(join(graphDirectory, "clones"), { recursive: true, force: true });
    const round = await Effect.runPromise(
      relationsRound({
        repository: s.repository,
        graphDirectory,
        base: s.base,
        head: s.head,
        source,
      }).pipe(
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
        Effect.provide(Store.layer(location, { create: false })),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    expect(round.outcomes).toEqual({ base: "stored", head: "stored" });
    expect(Effect.runSync(relationsReadsInFlight)).toBe(0);
    expect(await s.attempts()).toBe(2);
    expect(existsSync(join(graphDirectory, "clones"))).toBe(false);
    if (isRelationsGap(round.head)) throw new Error("no head");
    expect(round.head.coverage.commit).toBe(s.head);
    // Measured for the report: one stored index of this fixture.
    console.info(
      JSON.stringify({
        fixtureIndexBytes: new TextEncoder().encode(JSON.stringify(round.head))
          .byteLength,
        repoKey: round.head.coverage.repoKey,
      }),
    );
  },
  300_000,
);

// Why: a relations read is a whole-tree read; a range preparation (up to 58 commits) must never
// gain one, whether it prepares a range or each of its commits.
test.skipIf(graphPrerequisite.skip)(
  "a range preparation reads no relations, for the range or any of its commits",
  async () => {
    graphPrerequisite.require();
    const s = fixture();
    const location = await Effect.runPromise(
      resolveStoreLocation(s.repository),
    );
    for (const input of [
      {
        kind: "commit",
        commit: {
          oid: s.head,
          tree: s.git("rev-parse", `${s.head}^{tree}`),
          parents: [s.base],
        },
      },
      { kind: "range", range: { baseOid: s.base, headOid: s.head } },
    ])
      s.run(
        [
          "worker",
          "prepare-code",
          "--repo",
          s.repository,
          "--store",
          location.directory,
          "--input",
          JSON.stringify(input),
          ...workerParentArgs(),
        ],
        READINGS_ON,
      );
    expect(await s.attempts()).toBe(0);
    expect(existsSync(relationsGraphDirectory(location))).toBe(false);
  },
  300_000,
);

// Why: the stored index is one per commit whichever Graph folder's clone the engine read, so the
// preparation child and the review must get the same answer from either; `repoKey` is compared
// across sides by the slices. The repository has a GitHub remote; the clones' origin is the
// repository's path, so each clone's key is `local/` and its folder's name, the same in both.
test.skipIf(graphPrerequisite.skip)(
  "the worker's and the preparation child's clones give the same index, repoKey included",
  async () => {
    graphPrerequisite.require();
    const s = fixture();
    s.git("remote", "add", "origin", "https://github.com/example/r.git");
    const location = await Effect.runPromise(
      resolveStoreLocation(s.repository),
    );
    const read = (folder: string) =>
      Effect.runPromise(
        graphClone(s.repository, {
          executable: source.executable,
          workDirectory: join(location.directory, folder),
        }).pipe(
          Effect.flatMap((clone) =>
            Effect.promise(() =>
              readRelationsIndex({
                repository: clone,
                revision: s.head,
                profile: "full",
                executable: source.executable,
              }),
            ),
          ),
        ),
      );
    const worker = await read("graph");
    const child = await read("graph-commit");
    expect(worker.coverage.repoKey).toMatch(/^local\//);
    expect(child.coverage.repoKey).toBe(worker.coverage.repoKey);
    expect(JSON.stringify(child)).toBe(JSON.stringify(worker));
  },
  300_000,
);

// Why: when the commit's hunks are held by another caller, the preparation returns before the
// relations step, on purpose: that other holder is a review, whose own relations task reads the
// same keys. This pins it: no relations attempt at preparation on that path.
test.skipIf(graphPrerequisite.skip)(
  "with the commit's hunks held by another caller, the preparation reads no relations",
  async () => {
    graphPrerequisite.require();
    const s = fixture();
    const directory = join(s.root, "budget");
    mkdirSync(directory, { mode: 0o700 });
    const host = await hostBudget({ directory, threads: 2, fixed: 4 });
    if (!host) throw new Error("no budget host");
    await host.claims.ready;
    const previous = process.env.NEUVE_BUDGET_DIRECTORY;
    process.env.NEUVE_BUDGET_DIRECTORY = directory;
    const gate = Promise.withResolvers<void>();
    try {
      const location = await Effect.runPromise(
        resolveStoreLocation(s.repository),
      );
      // This process holds the commit's hunks key, as a review's Precompute would.
      const held = Promise.withResolvers<void>();
      const holding = Effect.runPromise(
        Effect.exit(
          Computations.ComputationStore.use((store) =>
            store.run(
              commitHunksSpec(
                s.git("rev-parse", `${s.base}^{tree}`),
                s.git("rev-parse", `${s.head}^{tree}`),
                source,
              ),
              Effect.andThen(
                Effect.promise(() => gate.promise),
                Effect.fail("released" as const),
              ),
            ),
          ),
        ).pipe(
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(
            Logger.layer([
              Logger.make(({ message }) => {
                if (
                  [message]
                    .flat()
                    .some(
                      (item) =>
                        typeof item === "object" &&
                        item !== null &&
                        "role" in item &&
                        item.role === "holder",
                    )
                )
                  held.resolve();
              }),
            ]),
          ),
          Effect.provide(
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
          Effect.provide(
            Layer.effectDiscard(Store.prepareForWrite).pipe(
              Layer.provideMerge(Store.layer(location, { create: true })),
            ),
          ),
          Effect.provide(BunFileSystem.layer),
        ),
      );
      await held.promise;
      const home = join(s.root, "home");
      mkdirSync(dirname(settingsPath(home)), { recursive: true });
      writeFileSync(settingsPath(home), JSON.stringify(READINGS_ON));
      const child = Bun.spawn(
        [
          process.execPath,
          cli,
          ...prepareCommitArgs(s.repository, {
            oid: s.head,
            parents: [s.base],
            tree: s.git("rev-parse", `${s.head}^{tree}`),
          }),
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            NEUVE_BUDGET_DIRECTORY: directory,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = `${stdout}${stderr}`;
      expect(code, output).toBe(0);
      expect(output).toContain(
        "commit.prepare: hunks held by another caller; skipped",
      );
      expect(output).not.toContain("relations");
      expect(await s.attempts()).toBe(0);
      expect(existsSync(relationsGraphDirectory(location))).toBe(false);
      gate.resolve();
      await holding;
    } finally {
      gate.resolve();
      if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
      else process.env.NEUVE_BUDGET_DIRECTORY = previous;
      await host.close();
    }
  },
  300_000,
);
