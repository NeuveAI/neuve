import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  JobQueue,
  Log,
  ReviewOrigins,
  Store,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core";
import {
  GitHubExternalRefSchema,
  type ReviewOrigin,
} from "@neuve/records-schema";
import { requestReview } from "../src/request.ts";
import {
  reviewSnapshot,
  selectedExternalContext,
  snapshotSpec,
} from "../src/scope.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { externalScopeText, parseGitHubSource } from "../src/github-scope.ts";

const root = mkdtempSync(join(tmpdir(), "neuve-external-review-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
git("init", "-q");
git("config", "user.email", "fixture@example.com");
git("config", "user.name", "Fixture");
writeFileSync(join(root, "work.txt"), "before\n");
git("add", "work.txt");
git("commit", "-qm", "Before");
const base = git("rev-parse", "HEAD");
writeFileSync(join(root, "work.txt"), "after\n");
git("commit", "-qam", "After");
const head = git("rev-parse", "HEAD");
const location = storeLocationIn(join(root, ".git"));
const item = GitHubExternalRefSchema.parse({
  provider: "github",
  repo: "githubnext/ace",
  kind: "pull-request",
  number: 711,
  url: "https://github.com/githubnext/ace/pull/711",
});
// The body is the real public GitHub REST response read on 30 October 2026, with unrelated fields removed.
const response: unknown = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures/github-pr-body-711.json"),
    "utf8",
  ),
);
const source = parseGitHubSource(item, response, "2026-10-30T10:00:00.000Z");
const origin: ReviewOrigin = {
  kind: "channel",
  host: "fixture",
  channel: "channel-one",
  chat: 1,
  lane: "fix",
  items: [item],
};
const integrations = {
  status: "absent" as const,
  path: "fixture-no-integrations",
};
const args = {
  repository: root,
  location,
  range: `${base}..${head}`,
  requester: { _tag: "Unresolved" as const },
  search: {},
  stack: undefined,
  deadline: undefined,
  scopeIntegrations: integrations,
};
const program = () =>
  Effect.gen(function* () {
    yield* Store.prepareForWrite;
    const first = yield* requestReview({
      ...args,
      origin,
      externalSources: [source],
    });
    const retry = yield* requestReview({
      ...args,
      origin,
      externalSources: [
        {
          ...source,
          fetchedAt: "2026-10-30T10:05:00.000Z",
          version: "2026-10-30T10:04:00.000Z",
        },
      ],
    });
    const other = yield* requestReview({
      ...args,
      origin: { ...origin, channel: "channel-two" },
      externalSources: [source],
    });
    const context = yield* selectedExternalContext(first.cycleId);
    const snapshot = yield* reviewSnapshot(
      {
        repository: root,
        location,
        cycleId: first.cycleId,
        range: first.range,
        integrations,
      },
      undefined,
    );
    const associations = yield* ReviewOrigins.list({ item });
    const selected = yield* Log.history({
      kind: "cycle.external-context-selected@1",
      limit: 10,
    });
    const origins = yield* Log.history({
      kind: "review.origin-recorded@1",
      limit: 10,
    });
    const events = yield* Log.history({
      kind: "disposition.recorded@1",
      limit: 10,
    });
    const queue = yield* JobQueue.JobQueue;
    const jobs = yield* queue.list({ states: ["waiting"], limit: 100 });
    return {
      first,
      retry,
      other,
      context,
      snapshot,
      associations,
      selected,
      origins,
      events,
      jobs,
    };
  });
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem
    | SqlClient
    | McpClients
    | JobQueue.JobQueue
    | Blobs.BlobStore
    | Computations.ComputationStore
  >,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(mcpClientsLayer(integrations)),
      Effect.provide(JobQueue.layer),
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );

test("real provider body pins once; repeated admission and channel recovery reuse Records work", async () => {
  const result = await run(program());
  expect(result.retry.cycleId).toBe(result.first.cycleId);
  expect(result.retry.runKey).toBe(result.first.runKey);
  expect(result.retry.association).toBe(result.first.association);
  expect(result.other.association).not.toBe(result.first.association);
  expect(result.associations).toHaveLength(2);
  expect(result.selected).toHaveLength(1);
  expect(result.origins).toHaveLength(2);
  expect(result.events).toEqual([]);
  expect(
    result.jobs.filter((job) =>
      ["review.run", "review.run@2"].includes(job.kind),
    ),
  ).toHaveLength(1);
  expect(result.context?.sources[0]?.sha256).toBe(
    sha256Hex(externalScopeText(source)),
  );
  expect(
    result.snapshot.value.sources.find((value) => value.id === "E1"),
  ).toMatchObject({
    kind: "pull-request",
    ref: { external: item },
    status: "fetched",
    complete: true,
    sha256: sha256Hex(externalScopeText(source)),
  });
  expect(result.snapshot.value.gaps).not.toContain(
    "The pull request's description wasn't read: Neuve doesn't read code hosts yet.",
  );
  expect(result.snapshot.value.gaps).toContain(
    "The discussion of https://github.com/githubnext/ace/pull/711 was not pinned as review context.",
  );
  expect(snapshotSpec(result.first.cycleId).config).toEqual({
    recipe: "neuve-scope-v1",
  });
  expect(
    snapshotSpec(result.first.cycleId, result.context?.identity).config,
  ).toMatchObject({ recipe: "neuve-scope-github-v1" });
});

test("changed source on the same immutable range cannot replace a pinned cycle, and implicit HEAD is refused", async () => {
  await expect(
    run(
      requestReview({
        ...args,
        origin,
        externalSources: [
          { ...source, text: `${source.text}\nChanged acceptance` },
        ],
      }),
    ),
  ).rejects.toThrow("different external context");
  await expect(
    run(requestReview({ ...args, range: `${base}..`, origin })),
  ).rejects.toThrow();
  await expect(
    run(
      requestReview({ ...args, range: `${base}..${"f".repeat(40)}`, origin }),
    ),
  ).rejects.toThrow();
  expect(
    await run(ReviewOrigins.list({ channel: "channel-one" })),
  ).toHaveLength(1);
});

test("provider body identity must match its selected repository and item", () => {
  expect(source.title).toBe(
    "feat(host): add ace demo with scripted teammates and mocked data",
  );
  expect(source.version).toBe("2026-10-27T22:55:55Z");
  expect(source.text).toContain("Adds `ace demo`");
  expect(() =>
    parseGitHubSource(
      {
        ...item,
        number: 710,
        url: "https://github.com/githubnext/ace/pull/710",
      },
      response,
      source.fetchedAt,
    ),
  ).toThrow("different item");
  expect(() =>
    GitHubExternalRefSchema.parse({
      ...item,
      url: "https://github.com/other/project/pull/711",
    }),
  ).toThrow();
});
