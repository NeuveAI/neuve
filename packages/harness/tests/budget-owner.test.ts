import { oneBatchPlanMap } from "./fixtures/readings.ts";
// Why: a budget caps a request's or a lease's owner at 128 characters, and callers pass the
// repository path as the owner, so a review in a deeper folder lost its CPU grants. Each owner must
// reach every budget, an older host included, under one bounded name, and a lease and its calls must
// stay one owner.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import { CpuWork } from "../src/budget/cpu.ts";
import { hostBudget, localBudget } from "../src/budget/local.ts";
import {
  Scheduler,
  budgetOwner,
  type Budget,
  type Grant,
  type Request,
} from "../src/budget/scheduler.ts";
import { defaultConfig } from "../src/config.ts";
import {
  captureOutlineSource,
  readOutlinesWithBudget,
} from "../src/graph-outline.ts";
import { defaultManifestSettings, frontManifest } from "../src/manifest.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { reviewPriority } from "../src/pi/priority.ts";
import { stageRunner } from "../src/pi/stages/services.ts";
import { DEFAULT_READING_BOUNDS } from "../src/reading-groups.ts";
import { storePlan } from "../src/readings/collect.ts";
import { frozenHost } from "./fixtures/budget-host-v1.ts";

const root = mkdtempSync(join(tmpdir(), "budget-owner-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const account = "a".repeat(64);
const source = captureOutlineSource();

/** A path of exactly `length` characters under this file's root, in folders of 39 characters. */
const pathOfLength = (length: number) => {
  const prefix = join(root, `r${length}-`);
  let rest = "x".repeat(length - prefix.length);
  const parts: string[] = [];
  while (rest.length > 40) {
    parts.push(rest.slice(0, 39));
    rest = rest.slice(40);
  }
  const path = `${prefix}${[...parts, rest].join("/")}`;
  if (path.length !== length) throw new Error(`built ${path.length}`);
  return path;
};
const cpu = (owner: string): Request => ({
  owner,
  priority: { class: "interactive", position: "new", stage: 0 },
  resource: { kind: "cpu", permits: 1 },
});
/** A budget host in its own directory, recording each request it admits as it reads it. */
const withHost = async <A>(
  run: (budget: Budget, admitted: Request[]) => Promise<A>,
) => {
  const directory = mkdtempSync(join(root, "budget-"));
  const host = await hostBudget({ directory, threads: 2, fixed: 8 });
  if (!host) throw new Error("Fixture budget did not start");
  const admitted: Request[] = [];
  const admit = host.scheduler.admit.bind(host.scheduler);
  host.scheduler.admit = (request, signal) => {
    admitted.push(request);
    return admit(request, signal);
  };
  try {
    return await run(localBudget(directory), admitted);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
};
const owners = [128, 129, 4_000].map(pathOfLength);

// Why: the defect itself, on both kinds of budget; an owner that fits must arrive unchanged.
test("a CPU grant is admitted for owners of 128, 129 and 4,000 characters, through the socket and in process", async () => {
  for (const owner of owners) {
    await withHost(async (budget, admitted) => {
      const grant = await budget.admit(cpu(owner));
      await grant.release();
      expect(admitted.map((request) => request.owner)).toEqual([
        owner.length <= 128 ? owner : budgetOwner(owner),
      ]);
    });
    const grant = await new Scheduler(2).admit(cpu(owner));
    await grant.release();
  }
  expect(budgetOwner(owners[0]!)).toBe(owners[0]!);
});

// Why: every build must name one owner alike, two folders must stay two owners, and a client's
// short form must pass a host's mapping unchanged; the tail must stay well-formed on the wire.
test("the short form is deterministic, distinct, bounded and maps to itself", () => {
  const long = pathOfLength(300),
    other = `${long.slice(0, 150)}y${long.slice(151)}`,
    short = budgetOwner(long);
  expect(budgetOwner(long)).toBe(short);
  expect(budgetOwner(other)).not.toBe(short);
  expect(budgetOwner(short)).toBe(short);
  expect(short.length).toBeLessThanOrEqual(128);
  expect(short).toMatch(
    new RegExp(`^…${long.slice(-40).replaceAll("/", "\\/")}#[a-f0-9]{32}$`),
  );
  const wide = budgetOwner(`${root}/${"📁".repeat(100)}`);
  expect(wide.length).toBeLessThanOrEqual(128);
  expect(wide.isWellFormed()).toBe(true);
  expect(() => new Scheduler(1).admit(cpu(""))).toThrow();
});

/**
 * A review's lease on `leased`, one of its turns in flight, then eight readings of `owner`: the
 * readings granted. A leased owner with a turn in flight keeps 4 - 1 of the 8 slots from readings.
 */
const readingsBeside = async (
  budget: Budget,
  leased: string,
  owner: string,
) => {
  const provider = { kind: "provider", account } as const;
  const end = await budget.activate!(account, leased);
  const turn = await budget.admit({
    owner,
    priority: reviewPriority("find", false),
    resource: provider,
  });
  const waiting = new AbortController(),
    granted: Grant[] = [];
  const readings = Array.from({ length: 8 }, () =>
    budget
      .admit(
        {
          owner,
          priority: reviewPriority("assess", false),
          resource: provider,
        },
        waiting.signal,
      )
      .then(
        (grant) => void granted.push(grant),
        () => {},
      ),
  );
  for (;;) {
    const numbers = await budget.observe();
    if ((numbers.readingsWaiting ?? 0) + (numbers.readingsHeld ?? 0) === 8)
      break;
    await Bun.sleep(5);
  }
  const held = (await budget.observe()).readingsHeld;
  waiting.abort();
  await Promise.all(readings);
  for (const grant of granted) await grant.release();
  await turn.release();
  end();
  return held;
};

// Why: the reserve is keyed by owner, so a lease and the calls of one long owner must share a name;
// the control, a lease on a long owner differing only in the middle, keeps nothing for these calls.
test("a lease and the calls of one long owner are one owner, in process and through the socket", async () => {
  const owner = pathOfLength(200),
    other = `${owner.slice(0, 100)}y${owner.slice(101)}`;
  for (const [leased, held] of [
    [owner, 4],
    [other, 7],
  ] as const) {
    expect(await readingsBeside(new Scheduler(8, 8, 8), leased, owner)).toBe(
      held,
    );
    expect(
      await withHost((budget) => readingsBeside(budget, leased, owner)),
    ).toBe(held);
  }
});

// Why: hosts built before this change still cap the owner; the client must shorten it first.
test("a strict host from before 10 November admits a request whose owner was long", async () => {
  const directory = mkdtempSync(join(root, "frozen-"));
  const host = await frozenHost(directory, "strict");
  try {
    const owner = owners[2]!;
    const grant = await localBudget(directory).admit(cpu(owner));
    await grant.release();
    expect(host.exchanges).toEqual(["admit"]);
    expect(host.admitted.map((request) => request.owner)).toEqual([
      budgetOwner(owner),
    ]);
  } finally {
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A two-commit repository at `repository`: Graph outlines `src/watch.ts` and the readings plan it. */
const repositoryAt = (repository: string) => {
  mkdirSync(join(repository, "src"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repository]);
  const git = (...args: Array<string>) =>
    Bun.spawnSync(["git", "-C", repository, ...args])
      .stdout.toString()
      .trim();
  const commit = (text: string) => {
    writeFileSync(join(repository, "src", "watch.ts"), text);
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "c",
    );
    return git("rev-parse", "HEAD");
  };
  const baseOid = commit(
    'export function watch(target: EventTarget) {\n  const onKey = () => {};\n  target.addEventListener("keydown", onKey);\n  return () => {\n    target.removeEventListener("keydown", onKey);\n  };\n}\n',
  );
  const headOid = commit(
    'export function ready() {\n  return true;\n}\nexport function watch(target: EventTarget) {\n  const onKey = () => {};\n  target.addEventListener("keydown", onKey);\n  return () => {};\n}\n',
  );
  return { baseOid, headOid };
};

// Why: the two places the release retest saw a 129-character repository path lose work, through a
// real host: Precompute's outline read fell back to "unavailable", and the readings' plan failed.
test.skipIf(!("sha256" in source.key))(
  "a 129-character repository path keeps its outline read and its readings' plan",
  async () => {
    const repository = pathOfLength(129),
      range = repositoryAt(repository);
    const directory = mkdtempSync(join(root, "budget-")),
      previous = process.env.NEUVE_BUDGET_DIRECTORY;
    // Outline reads publish and share their work through this host.
    process.env.NEUVE_BUDGET_DIRECTORY = directory;
    const host = await hostBudget({ directory, threads: 2, fixed: 8 });
    if (!host) throw new Error("Fixture budget did not start");
    const scope = await Effect.runPromise(Scope.make());
    try {
      const local = localBudget(directory);
      const outlines = await Effect.runPromise(
        readOutlinesWithBudget(
          [
            {
              path: "src/watch.ts",
              bytes: new TextEncoder().encode("export const a = 1;\n"),
            },
          ],
          repository,
          source,
        ).pipe(
          Effect.provideService(CpuWork, {
            budget: local,
            priority: reviewPriority("frame", false),
            inherited: false,
          }),
        ),
      );

      const location = storeLocationIn(join(root, "store"));
      const records = await Effect.runPromise(
        Layer.buildWithScope(
          Computations.layer.pipe(
            Layer.provideMerge(Blobs.layer(location)),
            Layer.provideMerge(Store.layer(location, { create: true })),
            Layer.provideMerge(BunFileSystem.layer),
          ),
          scope,
        ),
      );
      await Effect.runPromise(Effect.provide(Store.prepareForWrite, records));
      const clients = Context.get(
        await Effect.runPromise(
          Layer.buildWithScope(
            mcpClientsLayer({ status: "absent", path: "(none)" }),
            scope,
          ),
        ),
        McpClients,
      );
      const ctx = {
        location,
        repository,
        runId: mintUlid(),
        runKey: "f".repeat(64),
        range: { baseRef: "main", ...range },
        cycleId: mintUlid(),
        config: defaultConfig(),
        log: { path: "(memory)", write: () => {}, read: () => [] },
        startedAt: Date.now(),
        reconciliationId: mintUlid(),
        records,
      };
      const run = stageRunner(ctx, clients, local);
      const manifest = await run(
        frontManifest(
          repository,
          range,
          defaultManifestSettings(1_000_000),
          source,
        ),
      );
      const plan = await run(
        Effect.exit(
          storePlan(ctx, {
            manifestKey: manifest.key,
            bounds: DEFAULT_READING_BOUNDS,
            map: oneBatchPlanMap(manifest),
            manifest: manifest.value,
          }),
        ),
      );
      // Both in one check, so a failure shows each step's outcome.
      expect({
        outline: outlines.context("src/watch.ts").kind,
        plan: Exit.isSuccess(plan)
          ? "stored"
          : Cause.pretty(plan.cause).slice(0, 400),
      }).toEqual({ outline: "available", plan: "stored" });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await host.close();
      if (previous === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
      else process.env.NEUVE_BUDGET_DIRECTORY = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
