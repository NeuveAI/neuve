import { afterEach, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Exit } from "effect";
import {
  declareGraphCache,
  observeGraphProvider,
  prepareGraphSnapshot,
  type GraphInspectionEvidence,
} from "../src/index.ts";
import {
  fakeExecutable,
  fixtureRepository,
  removeRoots,
} from "./graph-client-support.ts";

afterEach(removeRoots);

const failure = async (effect: Effect.Effect<unknown, { reason: string }>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
  const error = exit.cause.toString();
  return error;
};

// Why: full-profile prepared reads (the benchmark's G-fork arm) serve whatever snapshot was prepared
// for a commit. A HEAD that is not the requested commit, or a receipt naming another commit or tree,
// would silently serve another tree's graph, so preparation must refuse both and report the reuse.
test("prepares a full-profile snapshot only when HEAD is the commit and the receipt matches it", async () => {
  const repository = await fixtureRepository();
  const executable = await fakeExecutable("refresh-hit");
  const prepared = await Effect.runPromise(
    prepareGraphSnapshot({
      executable,
      repository: repository.root,
      revision: repository.second,
    }),
  );
  expect(String(prepared.source.revision)).toBe(repository.second);
  expect(prepared.profile).toBe("full");
  expect(prepared.cache.status).toBe("hit");
  expect(prepared.provider.name).toBe("entire-graph");

  expect(
    await failure(
      prepareGraphSnapshot({
        executable,
        repository: repository.root,
        revision: repository.first,
      }),
    ),
  ).toContain("HEAD to be the requested commit");
  expect(
    await failure(
      prepareGraphSnapshot({
        executable: await fakeExecutable("refresh-wrong-tree"),
        repository: repository.root,
        revision: repository.second,
      }),
    ),
  ).toContain("receipt failed qualification");
  expect(
    await failure(
      prepareGraphSnapshot({
        executable: await fakeExecutable("refresh-unreported"),
        repository: repository.root,
        revision: repository.second,
      }),
    ),
  ).toContain("receipt failed qualification");
});

// Why: callers record which engine produced their answers from this observation instead of running
// the executable and reading its JSON themselves (the graph-client boundary).
test("observes the provider through a frozen copy of the executable", async () => {
  const provider = await Effect.runPromise(
    observeGraphProvider({ executable: await fakeExecutable("default") }),
  );
  expect(provider.name).toBe("entire-graph");
  expect(provider.version).toBe("fixture");
  expect(provider.executable.sha256).toMatch(/^[0-9a-f]{64}$/);
});

// Why: the bounded Graph store reports its size, cap and evictions on every index, and the harness
// records them; an absent block must stay absent, and a present malformed one must be refused
// rather than recorded as a size.
test("a snapshot carries the store's cache block when Graph reports it", async () => {
  const repository = await fixtureRepository();
  const prepare = async (mode: string) =>
    Effect.runPromise(
      prepareGraphSnapshot({
        executable: await fakeExecutable(mode),
        repository: repository.root,
        revision: repository.second,
      }),
    );
  expect((await prepare("refresh-hit")).store).toBeUndefined();
  expect((await prepare("refresh-store")).store).toStrictEqual({
    bytes: 3221225472,
    capBytes: 4294967296,
    minFreeBytes: 10737418240,
    freeBytes: 53687091200,
    declaredBytes: 1048576,
    pinnedBytes: 0,
    families: { "search-snapshot": 2147483648, executables: 114488248 },
    evictedBytes: 0,
    evictedEntries: 0,
    measuredAt: "2026-10-24T00:00:00Z",
  });
  expect(
    (await prepare("refresh-store-free-unknown")).store,
  ).not.toHaveProperty("freeBytes");
  expect(
    await failure(
      prepareGraphSnapshot({
        executable: await fakeExecutable("refresh-store-malformed"),
        repository: repository.root,
        revision: repository.second,
      }),
    ),
  ).toContain("receipt failed qualification");
});

// Why: with the service setting on, Graph runs an index in the shared service's preparation lane
// and reports its account as the receipt's last field; the harness records it and takes the
// preparation's CPU from it. An answered block, one run in the caller's own process and an older
// engine's receipt with none must all parse, a malformed block must be refused rather than recorded,
// and the index must run from the build's one engine copy (the service is one per executable path,
// so a temporary copy per call would start a service per preparation), at the default class.
test("a snapshot carries the service's preparation block from the build's one engine copy", async () => {
  const repository = await fixtureRepository();
  const prepare = async (mode: string, run: GraphInspectionEvidence = {}) => {
    const executable = await fakeExecutable(mode);
    const prepared = await Effect.runPromise(
      prepareGraphSnapshot(
        {
          executable,
          repository: repository.root,
          revision: repository.second,
        },
        run,
      ),
    );
    return { prepared, executable };
  };
  const { prepared: answered, executable } = await prepare(
    "refresh-service-answered",
    // An inspection's options, typed wider: a preparation still asks for no class or deadline.
    { serviceClass: "interactive", serviceDeadlineMs: 1_000 },
  );
  expect(answered.service).toStrictEqual({
    answered: true,
    lane: "prepare",
    class: "background",
    queueWaitMs: 7,
    cpuUserMs: 1500,
    cpuSystemMs: 250,
    rssBytes: 314572800,
    maxRssBytes: 314572800,
    cacheBytes: 3221225472,
    cacheCapBytes: 4294967296,
  });
  const call = JSON.parse(
    await Bun.file(join(dirname(executable), "index-call")).text(),
  ) as { engine: string; class: string | null; deadline: string | null };
  expect(call.class).toBeNull();
  expect(call.deadline).toBeNull();
  expect(
    call.engine.startsWith(
      `${await realpath(join(repository.root, ".git/neuve/graph/cache"))}/executables/`,
    ),
  ).toBe(true);
  expect((await prepare("refresh-service-own")).prepared.service).toStrictEqual(
    {
      answered: false,
      reason: "busy",
      lane: "prepare",
      queueWaitMs: 0,
      cpuUserMs: 900,
      cpuSystemMs: 100,
      rssBytes: 52428800,
      maxRssBytes: 104857600,
      cacheBytes: 3221225472,
      cacheCapBytes: 4294967296,
    },
  );
  expect((await prepare("refresh-hit")).prepared).not.toHaveProperty("service");
  expect(
    await failure(
      prepareGraphSnapshot({
        executable: await fakeExecutable("refresh-service-malformed"),
        repository: repository.root,
        revision: repository.second,
      }),
    ),
  ).toContain("receipt failed qualification");
});

// Why: `cache declare` replaces the store's whole declared set, so what it reports declared must be
// exactly what was asked for; a receipt naming other commits would leave the asked-for bases
// unprotected while looking declared.
test("declares the store's bases and refuses a receipt naming others", async () => {
  const repository = await fixtureRepository();
  const executable = await fakeExecutable("declare");
  const declared = await Effect.runPromise(
    declareGraphCache({
      executable,
      repository: repository.root,
      commits: [repository.first, repository.second, repository.first],
    }),
  );
  expect(declared.commits.map(String)).toEqual([
    repository.first,
    repository.second,
  ]);
  expect(declared.usage.capBytes).toBe(4294967296);
  const args = JSON.parse(
    await Bun.file(join(dirname(executable), "declare-args")).text(),
  ) as string[];
  expect(args.slice(0, 3)).toEqual([
    "declare",
    "--cache-dir",
    join(repository.root, ".git/neuve/graph/cache"),
  ]);
  expect(args).toContain("--repo");
  expect(
    await failure(
      declareGraphCache({
        executable: await fakeExecutable("declare-other"),
        repository: repository.root,
        commits: [repository.first],
      }),
    ),
  ).toContain("receipt failed qualification");
  expect(
    await failure(
      declareGraphCache({
        executable,
        repository: repository.root,
        commits: ["HEAD"],
      }),
    ),
  ).toContain("exact lowercase commit OIDs");
});

// Why: background work must never reach the service's interactive queue ahead of reviews, and an
// options object built for an inspection (typed wider, so no excess-property check stops it) may
// still be handed to a declaration: only an inspection asks for a class.
test("a declaration asks for no queue class, whatever its options carry", async () => {
  const repository = await fixtureRepository();
  const executable = await fakeExecutable("declare");
  const inspectionOptions: GraphInspectionEvidence = {
    service: "auto",
    serviceClass: "interactive",
    serviceDeadlineMs: 1_000,
  };
  await Effect.runPromise(
    declareGraphCache(
      { executable, repository: repository.root, commits: [] },
      inspectionOptions,
    ),
  );
  expect(
    await Bun.file(join(dirname(executable), "declare-class")).text(),
  ).toBe("");
});

// Why: preparation, declaration and provider observation run with no queue class or service
// deadline, so their options must not offer one. Checked by the type checker only.
export const preparationTakesNoDeadline = () => [
  prepareGraphSnapshot(
    { executable: "entire-graph", repository: ".", revision: "a".repeat(40) },
    // @ts-expect-error a preparation has no service deadline
    { serviceDeadlineMs: 1_000 },
  ),
  declareGraphCache(
    { executable: "entire-graph", repository: ".", commits: [] },
    // @ts-expect-error a declaration has no queue class
    { serviceClass: "interactive" },
  ),
  observeGraphProvider(
    { executable: "entire-graph" },
    // @ts-expect-error observing the provider has no service deadline
    { serviceDeadlineMs: 1_000 },
  ),
];
