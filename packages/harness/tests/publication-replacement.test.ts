import { expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SharedWork } from "@neuve/records-core/shared-work";
import { sharedPublication } from "../src/shared-publication.ts";
import { publicationHost } from "./fixtures/publication-host.ts";

const schema = z.object({
  publication: z.uuid(),
  outcome: z.object({ kind: z.literal("succeeded"), value: z.number() }),
});

for (const namespace of ["shared-indexes-v4", "shared-outlines-v4"] as const)
  test(`a joined ${namespace} reader finds a replacement after its stale listing`, async () => {
    const root = mkdtempSync(join(tmpdir(), "publication-replacement-")),
      prior = process.env.NEUVE_BUDGET_DIRECTORY;
    process.env.NEUVE_BUDGET_DIRECTORY = root;
    const host = publicationHost(root),
      hostId = host.host.hostId,
      copy = sharedPublication({
        namespace,
        scope: "store",
        key: "same-key",
        group: "tree",
        schema,
        reusable: () => false,
        authority: host.authority,
      });
    const started = Promise.withResolvers<void>(),
      produce = Promise.withResolvers<void>(),
      joined = Promise.withResolvers<void>(),
      enumerated = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    let armed = false,
      builds = 0;
    const original = filesystem.readdir,
      spy = spyOn(filesystem, "readdir").mockImplementation(
        new Proxy(original, {
          async apply(target, receiver, args: unknown[]) {
            const names: unknown = await Reflect.apply(target, receiver, args);
            const [path] = args;
            if (
              armed &&
              typeof path === "string" &&
              /\/key-[a-f0-9]{64}$/.test(path)
            ) {
              armed = false;
              enumerated.resolve();
              await resume.promise;
            }
            return names;
          },
        }),
      );
    const run = (subscriber = false) =>
      new SharedWork<number>().run({
        scope: "store",
        key: "same-key",
        onEvent: (event) => {
          if (subscriber && event.role === "waiter") joined.resolve();
        },
        crossProcess: {
          store: "store",
          transport: host.transport,
          read: async (reference) => {
            if (!reference) return undefined;
            if (subscriber) armed = true;
            return copy.read(reference);
          },
        },
        run: async () => {
          const value = ++builds;
          if (value === 1) {
            started.resolve();
            await produce.promise;
          }
          return copy.publish({
            publication: randomUUID(),
            outcome: { kind: "succeeded", value },
          });
        },
      });
    const pending: Promise<unknown>[] = [];
    try {
      const owner = run();
      pending.push(owner);
      await started.promise;
      const subscriber = run(true);
      pending.push(subscriber);
      void subscriber.catch(() => {});
      await joined.promise;
      produce.resolve();
      await enumerated.promise;
      expect((await owner).outcome).toEqual({ kind: "succeeded", value: 1 });
      expect((await run()).outcome).toEqual({ kind: "succeeded", value: 2 });
      resume.resolve();
      expect((await subscriber).outcome).toEqual({
        kind: "succeeded",
        value: 2,
      });
      expect(builds).toBe(2);
      expect(host.host.hostId).toBe(hostId);
      expect(host.host.size).toBe(0);
    } finally {
      armed = false;
      resume.resolve();
      produce.resolve();
      await Promise.allSettled(pending);
      spy.mockRestore();
      host.host.close();
      if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
      else process.env.NEUVE_BUDGET_DIRECTORY = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

// C5: the parent adapts the failed child's connection to the real host; disk work runs in the child.
test("one same-key takeover recovers an interrupted install and delivers to both joined callers", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-takeover-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root),
    hostId = host.host.hostId,
    signal = new AbortController().signal,
    owner = await host.transport.claim({
      store: "store",
      key: "same-key",
      insideGrant: false,
      redeclare: false,
      signal,
    });
  if (owner.kind !== "connected")
    throw new Error("Expected claimed connection");
  const joined = [Promise.withResolvers<void>(), Promise.withResolvers<void>()],
    subscribers: Promise<unknown>[] = [];
  let takeoverProducers = 0,
    takeovers = 0;
  const copy = sharedPublication({
    namespace: "shared-indexes-v4",
    scope: "store",
    key: "same-key",
    group: "tree",
    schema,
    reusable: () => false,
    authority: host.authority,
  });
  try {
    expect((await owner.claim.next()).kind).toBe("claimed");
    const run = (waiting: (typeof joined)[number]) =>
      new SharedWork<number>().run({
        scope: "store",
        key: "same-key",
        onEvent: (event) => {
          if (event.role === "waiter") waiting.resolve();
        },
        onTakeover: async () => {
          takeovers++;
        },
        crossProcess: {
          store: "store",
          transport: host.transport,
          read: (reference) => copy.read(reference),
        },
        run: async () => {
          takeoverProducers++;
          return copy.publish({
            publication: randomUUID(),
            outcome: { kind: "succeeded", value: 42 },
          });
        },
      });
    const first = run(joined[0]!),
      second = run(joined[1]!);
    subscribers.push(first, second);
    await Promise.all(joined.map((waiting) => waiting.promise));
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/publication-takeover.ts"),
        hostId,
      ],
      { env: { ...process.env } },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(23);
    expect(child.stdout.toString()).toBe("interrupted-after-ready-write\n");
    expect(await copy.read()).toBeUndefined();
    owner.claim.close();
    expect((await first).outcome).toEqual({ kind: "succeeded", value: 42 });
    expect((await second).outcome).toEqual({ kind: "succeeded", value: 42 });
    expect(takeovers).toBe(1);
    expect(takeoverProducers).toBe(1);
    expect(host.host.hostId).toBe(hostId);
    expect(host.host.size).toBe(0);
    const retained = await filesystem.readdir(root, { recursive: true });
    expect(
      retained.filter(
        (name) =>
          name.includes("/ready-") ||
          name.includes("/retired-") ||
          name.includes("/prepare-"),
      ),
    ).toEqual([]);
    expect(
      retained.filter((name) =>
        /^[0-9a-f-]{36}$/.test(name.split("/").at(-1) ?? ""),
      ),
    ).toHaveLength(1);
  } finally {
    owner.claim.close();
    await Promise.allSettled(subscribers);
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

// Retirement is a new interruption boundary; recovery must not leave its payload behind.
test("a later same-key publication reclaims a killed retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-retired-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root),
    copy = sharedPublication({
      namespace: "shared-indexes-v4",
      scope: "store",
      key: "same-key",
      group: "tree",
      schema,
      reusable: () => false,
      authority: host.authority,
    });
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/publication-takeover.ts"),
        host.host.hostId,
        "retired",
      ],
      { env: { ...process.env } },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(23);
    expect(child.stdout.toString()).toBe("interrupted-after-retirement\n");
    expect(
      (await filesystem.readdir(root, { recursive: true })).some((name) =>
        name.includes("retired-"),
      ),
    ).toBe(true);
    const stored = await copy.publish({
      publication: randomUUID(),
      outcome: { kind: "succeeded", value: 3 },
    });
    expect((await copy.read(stored.publication))?.outcome).toEqual({
      kind: "succeeded",
      value: 3,
    });
    const names = await filesystem.readdir(root, { recursive: true });
    expect(
      names.filter(
        (name) => name.includes("retired-") || name.includes("prepare-"),
      ),
    ).toEqual([]);
    expect(
      names.filter((name) =>
        /^[0-9a-f-]{36}$/.test(name.split("/").at(-1) ?? ""),
      ),
    ).toHaveLength(1);
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement leaves an unrecognized file at its original run path", async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-future-file-")),
    prior = process.env.NEUVE_BUDGET_DIRECTORY;
  process.env.NEUVE_BUDGET_DIRECTORY = root;
  const host = publicationHost(root),
    copy = sharedPublication({
      namespace: "shared-outlines-v4",
      scope: "store",
      key: "same-key",
      group: "tree",
      schema,
      reusable: () => false,
      authority: host.authority,
    });
  try {
    await copy.publish({
      publication: randomUUID(),
      outcome: { kind: "succeeded", value: 1 },
    });
    const names = await filesystem.readdir(root, { recursive: true }),
      run = names.find((name) => /\/run-[0-9a-f-]{36}$/.test(name));
    if (!run) throw new Error("No run directory");
    const future = join(root, run, "future-format-file");
    await filesystem.writeFile(future, "newer-build-bytes");
    const stored = await copy.publish({
      publication: randomUUID(),
      outcome: { kind: "succeeded", value: 2 },
    });
    expect((await copy.read(stored.publication))?.outcome).toEqual({
      kind: "succeeded",
      value: 2,
    });
    expect(await filesystem.readFile(future, "utf8")).toBe("newer-build-bytes");
    expect(
      (await filesystem.readdir(root, { recursive: true })).filter((name) =>
        name.includes("retired-"),
      ),
    ).toEqual([]);
  } finally {
    host.host.close();
    if (prior === undefined) delete process.env.NEUVE_BUDGET_DIRECTORY;
    else process.env.NEUVE_BUDGET_DIRECTORY = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
