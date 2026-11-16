import { expect, test, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { SharedWork } from "@neuve/records-core/shared-work";
import {
  sharedPublication,
  PublicationTooLarge,
  PublicationCapacity,
  createPublicationFailure,
  inlinePublicationFailure,
  publicationIdentity,
  PublicationHostGone,
} from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";
const Schema = z.object({
  publication: z.uuid(),
  outcome: z.object({ kind: z.literal("succeeded"), value: z.number() }),
});
const allFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(root, e.name)) : [join(root, e.name)],
  );
const payloads = (root: string) =>
  allFiles(root).filter((name) => /^[0-9a-f-]{36}$/.test(basename(name)));

// B3: a failure is immutable in the push; a different source key remains pinned without a clock.
for (const mode of [
  "retry",
  "superseded",
  "host-lost",
  "source",
  "cancelled-originator",
] as const)
  test(`a delayed publication reader survives ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "publication-reader-")),
      prior = process.env.NEUVE_BUDGET_DIRECTORY;
    process.env.NEUVE_BUDGET_DIRECTORY = root;
    const authority = publicationHost(root),
      controller = new AbortController();
    const copy = (key: string) =>
      sharedPublication({
        namespace: "shared-indexes-v4",
        scope: "s",
        key,
        group: "tree",
        schema: Schema,
        reusable: () => false,
        authority: authority.authority,
      });
    const a = copy("a"),
      b = mode === "retry" || mode === "superseded" ? a : copy("b");
    const started = Promise.withResolvers<void>(),
      build = Promise.withResolvers<void>(),
      waiting = Promise.withResolvers<void>(),
      reading = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    let builds = 0;
    const run = (
      store: typeof a,
      key: string,
      delay = false,
      signal?: AbortSignal,
    ) =>
      new SharedWork<number, string>().run({
        scope: "s",
        key,
        ...(signal ? { signal } : {}),
        onEvent: (e) => {
          if (delay && e.role === "waiter") waiting.resolve();
        },
        crossProcess: {
          store: "s",
          transport: authority.transport,
          acceptDeliveryFailure: true,
          read: async (publication) => {
            if (!publication) return undefined;
            if (delay) {
              reading.resolve();
              await resume.promise;
            }
            const failure = inlinePublicationFailure(publication, key);
            if (failure)
              return {
                publication,
                outcome: { kind: "failed" as const, error: failure.message },
              };
            try {
              return await store.read(publication);
            } catch (error) {
              if (!(error instanceof PublicationHostGone)) throw error;
              return {
                publication,
                outcome: { kind: "failed" as const, error: error.message },
              };
            }
          },
        },
        run: async () => {
          const number = ++builds;
          if (number === 1) {
            started.resolve();
            await build.promise;
          }
          if (
            number === 1 &&
            mode !== "source" &&
            mode !== "superseded" &&
            mode !== "host-lost"
          )
            return {
              publication: createPublicationFailure(
                randomUUID(),
                "Fixture",
                key,
                "first-attempt-failure",
              ).publication,
              outcome: {
                kind: "failed" as const,
                error: "first-attempt-failure",
              },
            };
          return store.publish({
            publication: randomUUID(),
            outcome: { kind: "succeeded", value: number },
          });
        },
      });
    try {
      const producer = run(a, "a", false, controller.signal).then(
        (v) => v.outcome,
        () => "cancelled" as const,
      );
      await started.promise;
      const subscriber = run(a, "a", true);
      await waiting.promise;
      if (mode === "cancelled-originator") controller.abort();
      build.resolve();
      await reading.promise;
      setSystemTime(new Date(Date.now() + 24 * 60 * 60_000));
      if (mode === "host-lost") authority.replace();
      expect(
        (await run(b, mode === "retry" || mode === "superseded" ? "a" : "b"))
          .outcome,
      ).toEqual({
        kind: "succeeded",
        value: 2,
      });
      expect(builds).toBe(2);
      expect(payloads(root)).toHaveLength(mode === "source" ? 2 : 1);
      resume.resolve();
      const first =
        mode === "source" || mode === "superseded" || mode === "host-lost"
          ? { kind: "succeeded" as const, value: 1 }
          : { kind: "failed" as const, error: "first-attempt-failure" };
      expect((await subscriber).outcome).toEqual(
        mode === "superseded"
          ? { kind: "succeeded", value: 2 }
          : mode === "host-lost"
            ? {
                kind: "failed",
                error: "Publication host ended before delivery",
              }
            : first,
      );
      expect(await producer).toEqual(
        mode === "cancelled-originator" ? "cancelled" : first,
      );
      expect(authority.host.size).toBe(0);
      expect((await run(a, "a")).outcome).toEqual({
        kind: "succeeded",
        value: 3,
      });
      expect(payloads(root)).toHaveLength(1);
    } finally {
      setSystemTime();
      build.resolve();
      resume.resolve();
      authority.host.close();
      if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
      else process.env.NEUVE_BUDGET_DIRECTORY = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

test("publication writes and reads accept the exact byte cap and reject one byte above it", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-cap-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root),
    options = {
      namespace: "shared-indexes-v4" as const,
      scope: "s",
      key: "cap",
      group: "tree",
      schema: Schema,
      reusable: () => true,
      authority: host.authority,
    };
  const stored = {
    publication: randomUUID(),
    outcome: { kind: "succeeded" as const, value: 42 },
  };
  try {
    const result = await sharedPublication(options).publish(stored);
    const filename = payloads(root)[0];
    if (!filename) throw new Error("No payload");
    const bytes = readFileSync(filename),
      inode = statSync(filename).ino;
    const exact = sharedPublication({ ...options, maximumBytes: bytes.length });
    await exact.publish(stored);
    expect(statSync(filename).ino).toBe(inode);
    expect(await exact.read(result.publication)).toEqual(result);
    const small = sharedPublication({
      ...options,
      maximumBytes: bytes.length - 1,
    });
    await expect(small.publish(stored)).rejects.toBeInstanceOf(
      PublicationTooLarge,
    );
    await expect(small.read(result.publication)).rejects.toBeInstanceOf(
      PublicationTooLarge,
    );
    expect(payloads(root)).toHaveLength(1);
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

// Only genuinely live distinct keys consume capacity; elapsed time is irrelevant.
test("concurrent publications stay within the record and byte bounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-capacity-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root),
    maximumBytes = 2048,
    maximumRecords = 2,
    release = Promise.withResolvers<void>();
  let finished = 0;
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, n) => {
        const key = `key-${n}`,
          store = sharedPublication({
            namespace: "shared-indexes-v4",
            scope: "s",
            key,
            group: "tree",
            schema: Schema,
            reusable: () => false,
            maximumBytes,
            maximumRecords,
            authority: host.authority,
          });
        return new SharedWork<number>().run({
          scope: "s",
          key,
          crossProcess: {
            store: "s",
            transport: host.transport,
            read: () => Promise.resolve(undefined),
          },
          run: async () => {
            let value: Awaited<ReturnType<typeof store.publish>> | undefined,
              error: unknown;
            try {
              value = await store.publish({
                publication: randomUUID(),
                outcome: { kind: "succeeded", value: n },
              });
            } catch (cause) {
              error = cause;
            }
            if (++finished === 12) release.resolve();
            await release.promise;
            if (error) throw error;
            if (!value) throw new Error("No result");
            return value;
          },
        });
      }),
    );
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(
      maximumRecords,
    );
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(PublicationCapacity);
    expect(payloads(root)).toHaveLength(maximumRecords);
    expect(
      allFiles(root).reduce((sum, p) => sum + statSync(p).size, 0),
    ).toBeLessThanOrEqual(maximumRecords * (maximumBytes + 16 * 1024));
  } finally {
    release.resolve();
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent completed publications retain one immutable keyed copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-completed-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root),
    work = new SharedWork<number>();
  const store = sharedPublication({
    namespace: "shared-indexes-v4",
    scope: "s",
    key: "same",
    group: "tree",
    schema: Schema,
    reusable: () => true,
    authority: host.authority,
  });
  let producers = 0;
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        work.run({
          scope: "s",
          key: "same",
          crossProcess: {
            store: "s",
            transport: host.transport,
            read: (publication) => store.read(publication),
          },
          run: async () => {
            producers++;
            return store.publish({
              publication: randomUUID(),
              outcome: { kind: "succeeded", value: 7 },
            });
          },
        }),
      ),
    );
    expect(producers).toBe(1);
    expect(results.map((v) => v.outcome)).toEqual(
      Array.from({ length: 12 }, () => ({ kind: "succeeded", value: 7 })),
    );
    expect(payloads(root)).toHaveLength(1);
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

// No unrelated engine/tree is used after host loss: the keyed reference records a delivery failure.
test("a retired host reference has a recorded host-loss failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-host-loss-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root);
  const copy = (key: string) =>
    sharedPublication({
      namespace: "shared-indexes-v4",
      scope: "s",
      key,
      group: "tree",
      schema: Schema,
      reusable: () => true,
      authority: host.authority,
    });
  try {
    const a = copy("a"),
      stored = await a.publish({
        publication: randomUUID(),
        outcome: { kind: "succeeded", value: 1 },
      });
    host.replace();
    await copy("b").publish({
      publication: randomUUID(),
      outcome: { kind: "succeeded", value: 2 },
    });
    await expect(a.read(stored.publication)).rejects.toBeInstanceOf(
      PublicationHostGone,
    );
    const unreachable = sharedPublication({
      namespace: "shared-indexes-v4",
      scope: "s",
      key: "a",
      group: "tree",
      schema: Schema,
      reusable: () => true,
      authority: (scope) => ({
        ...host.authority(scope),
        status: async () => undefined,
      }),
    });
    await expect(unreachable.read(stored.publication)).rejects.toBeInstanceOf(
      PublicationHostGone,
    );
    expect(publicationIdentity(stored.publication)).toBeDefined();
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent publication writes at the exact cap and rejects one byte below it", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-cold-cap-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root);
  const options = {
    namespace: "shared-indexes-v4" as const,
    scope: "s",
    key: "cold",
    group: "tree",
    schema: Schema,
    reusable: () => true,
    authority: host.authority,
  };
  const value = {
    publication: randomUUID(),
    outcome: { kind: "succeeded" as const, value: 42 },
  };
  try {
    await sharedPublication(options).publish(value);
    const filename = payloads(root)[0];
    if (!filename) throw new Error("No seed");
    const limit = statSync(filename).size;
    const cold = join(root, "cold"),
      small = join(root, "small");
    process.env.NEUVE_BUDGET_DIRECTORY = cold;
    const accepted = await sharedPublication({
      ...options,
      maximumBytes: limit,
    }).publish(value);
    expect(payloads(cold)).toHaveLength(1);
    expect(statSync(payloads(cold)[0]!).size).toBe(limit);
    expect(
      (
        await sharedPublication({ ...options, maximumBytes: limit }).read(
          accepted.publication,
        )
      )?.outcome,
    ).toEqual(value.outcome);
    process.env.NEUVE_BUDGET_DIRECTORY = small;
    await expect(
      sharedPublication({ ...options, maximumBytes: limit - 1 }).publish(value),
    ).rejects.toBeInstanceOf(PublicationTooLarge);
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
