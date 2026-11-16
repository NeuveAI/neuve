import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Metric } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { z } from "zod";
import { safeRead } from "@neuve/records-schema";
import { Store, storeLocationIn } from "@neuve/records-core";
import { openRunLog, runLogTracer } from "../src/run-log.ts";
import { withAttemptMetrics } from "../src/telemetry.ts";

const root = mkdtempSync(join(tmpdir(), "compatibility-capture-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const enabled of [true, false]) {
  test(`refusal inside a real store and run captures metadata with telemetry ${enabled ? "on" : "off"}`, async () => {
    const location = storeLocationIn(join(root, String(enabled)));
    const log = openRunLog(location, "run-14", enabled);
    const registry: Metric.MetricRegistry = new Map();
    const codec = z.codec(z.unknown(), z.strictObject({ used: z.number() }), {
      decode: (value) => z.looseObject({ used: z.number() }).parse(value),
      encode: (value) => value,
    });
    const schema = z.strictObject({ rows: z.record(z.string(), codec) });
    const input = {
      rows: { "secret-entry-key": { used: 1, future: "private-payload" } },
    };
    await Effect.runPromise(
      Effect.sync(() =>
        safeRead(schema, input, {
          readingBuild: "reader-14",
          writingBuild: "writer-15",
        }),
      ).pipe(
        Effect.withSpan("harness.compatibility.capture-test"),
        Effect.withTracer(runLogTracer(log)),
        withAttemptMetrics(log, registry),
        Effect.provide(Store.layer(location, { create: true })),
        Effect.provide(BunFileSystem.layer),
        Effect.scoped,
      ),
    );
    await log.flush?.();
    const records = log.read();
    const refusals = records.filter(
      (record) => record.type === "compatibility.refused",
    );
    expect(refusals).toHaveLength(1);
    const record = refusals[0]!;
    expect(record["source"]).toBe(location.database);
    expect(record["path"]).toBe("rows.[entry]");
    expect(record["kind"]).toBe("codec");
    expect(record["readingBuild"]).toBe("reader-14");
    expect(record["writingBuild"]).toBe("writer-15");
    expect(Object.keys(record).sort()).toEqual([
      "at",
      "kind",
      "path",
      "readingBuild",
      "source",
      "type",
      "writingBuild",
    ]);
    expect(JSON.stringify(records)).not.toContain("secret-entry-key");
    expect(JSON.stringify(records)).not.toContain("private-payload");
    const metrics = records.filter(
      (record) =>
        record.type === "metric" &&
        record["name"] === "harness.compatibility.refusals",
    );
    const spans = records.filter((record) => record.type === "span");
    if (enabled) {
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!["state"]).toEqual({ count: 1, incremental: false });
      expect(spans).toHaveLength(1);
      expect(spans[0]!["events"]).toEqual([
        expect.objectContaining({
          name: "harness.compatibility.refused",
          attributes: {
            "harness.compatibility.kind": "codec",
            "harness.compatibility.path": "rows.[entry]",
            "harness.compatibility.source": location.database,
            "harness.compatibility.reading_build": "reader-14",
            "harness.compatibility.writing_build": "writer-15",
          },
        }),
      ]);
    } else {
      expect(metrics).toHaveLength(0);
      expect(
        records.filter((record) =>
          ["span", "span.start", "metric"].includes(record.type),
        ),
      ).toHaveLength(0);
    }
  });
}

test("native tasks retain each run's capture across awaits and concurrent runs", async () => {
  const { withCompatibilityRun } = await import("../src/telemetry.ts");
  const codec = z.codec(z.unknown(), z.strictObject({ used: z.number() }), {
    decode: (value) => z.looseObject({ used: z.number() }).parse(value),
    encode: (value) => value,
  });
  const logs = [true, false].map((enabled) => ({
    log: openRunLog(
      storeLocationIn(join(root, `native-${enabled}`)),
      "native-14",
      enabled,
    ),
    enabled,
  }));
  await Promise.all(
    logs.map(({ log, enabled }) =>
      withCompatibilityRun(log, `native-store-${enabled}`, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        safeRead(
          codec,
          { used: 1, future: "private-payload" },
          { readingBuild: "reader-14" },
        );
      }),
    ),
  );
  for (const { log, enabled } of logs) {
    await log.flush?.();
    const records = log.read();
    expect(
      records.filter((record) => record.type === "compatibility.refused"),
    ).toEqual([
      expect.objectContaining({
        type: "compatibility.refused",
        kind: "codec",
        path: "$",
        source: `native-store-${enabled}`,
        readingBuild: "reader-14",
        writingBuild: "unknown",
      }),
    ]);
    expect(records.filter((record) => record.type === "metric")).toHaveLength(
      enabled ? 1 : 0,
    );
    expect(records.filter((record) => record.type === "span")).toHaveLength(
      enabled ? 1 : 0,
    );
    expect(JSON.stringify(records)).not.toContain("private-payload");
  }
});
