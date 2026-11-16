import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { Effect, Layer } from "effect";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler, type Priority } from "../src/budget/scheduler.ts";
import { blobChunks } from "../src/search-index.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";

const root = mkdtempSync(join(tmpdir(), "blob-admission-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const executable = join(root, "unavailable-engine"),
  source = { executable, key: { unavailable: executable } };
const interactive: Priority = {
  class: "interactive",
  position: "understand",
  stage: 0,
};
const layerFor = (name: string) => {
  const location = storeLocationIn(join(root, name));
  return Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
};
const input = (name: string, count: number, extension = "ts") => {
  const contents = new Map<string, Uint8Array>();
  const entries = Array.from({ length: count }, (_, index) => {
    const bytes = new TextEncoder().encode(
        extension === "md"
          ? `# ${name}${index}\n\nText.\n`
          : `export const ${name}${index} = ${index};\n`,
      ),
      oid = createHash("sha1").update(bytes).digest("hex");
    contents.set(oid, bytes);
    return {
      mode: "100644",
      type: "blob",
      oid,
      size: bytes.length,
      path: `${name}${index}.${extension}`,
    };
  });
  return { entries, contents };
};
const admitted = <A, E, R>(
  budget: Scheduler,
  priority: Priority,
  work: Effect.Effect<A, E, R>,
) =>
  work.pipe(
    Effect.provideService(CpuWork, { budget, priority, inherited: false }),
  );

test("a foreground blob request releases CPU after outline and chunk work", async () => {
  let number = 0;
  for (const testSource of [source, captureOutlineSource()]) {
    const budget = new Scheduler(1),
      admit = budget.admit.bind(budget);
    let peak = 0;
    budget.admit = async (request, signal) => {
      const grant = await admit(request, signal);
      peak = Math.max(peak, (await budget.observe()).held ?? 0);
      return grant;
    };
    const { entries, contents } = input("foreground", 1);
    const result = await Effect.runPromise(
      admitted(
        budget,
        interactive,
        blobChunks(root, entries, testSource, contents),
      ).pipe(Effect.provide(layerFor(`single-${number++}`))),
    );
    expect(result.computed).toBe(1);
    expect(
      result.chunks.get(`${entries[0]!.path}\0${entries[0]!.oid}`)?.fallback,
    ).toBe("sha256" in testSource.key ? null : "capability-unavailable");
    expect(peak).toBe(1);
    expect((await budget.observe()).held).toBe(0);
  }
  // Measured 1.279-1.575 s at load 5-17; 10x slowest, at least 30 s, rounded up to 5 s.
}, 30_000);
