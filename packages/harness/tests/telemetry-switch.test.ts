import { captureOutlineSource } from "../src/graph-outline.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Metric, Option, Tracer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultManifestSettings, rangeManifest } from "../src/manifest.ts";
import {
  openAdmissionLog,
  openRunLog,
  readRunLog,
  runLogTracer,
} from "../src/run-log.ts";
import { Settings, telemetryMode, tracerLayer } from "../src/settings.ts";
import { withAttemptMetrics } from "../src/telemetry.ts";
import { startLogSpan } from "../src/log-span.ts";
import { openHybridLog, withHybridLog } from "../src/commit-hybrid.ts";
import { stackJobLog } from "../src/stack/handler.ts";
import { modelCallCounts } from "../src/receipt.ts";
import { JOURNAL_FILE, openCaptureJournal } from "../src/pi/capture/journal.ts";

const root = mkdtempSync(join(tmpdir(), "telemetry-switch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A real manifest writes spans and metrics. Off must preserve the records the receipt and desk read.
for (const enabled of [false, true]) {
  test(`telemetry ${enabled ? "logs" : "off"} preserves receipt records and session capture without contacting OTLP`, async () => {
    let requests = 0;
    const collector = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json({});
      },
    });
    const previousEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = collector.url.toString();
    try {
      const directory = join(root, String(enabled));
      const repository = join(directory, "repo");
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", "-C", repository, ...args], {
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      };
      const init = Bun.spawnSync(["git", "init", "-q", repository]);
      expect(init.exitCode).toBe(0);
      const commit = (value: number) => {
        writeFileSync(
          join(repository, "value.ts"),
          `export const value = ${value};\n`,
        );
        git("add", "value.ts");
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "-qm",
          "value",
        );
        return git("rev-parse", "HEAD");
      };
      const base = commit(1);
      const head = commit(2);
      const settings = Option.some(
        Settings.parse({
          version: 1,
          telemetry: {
            enabled,
            ...(!enabled
              ? { otlp: { baseUrl: collector.url.toString() } }
              : {}),
          },
        }),
      );
      const mode = telemetryMode(settings);
      expect(mode).toBe(enabled ? "logs" : "off");
      const location = storeLocationIn(join(directory, "store"));
      const log = openRunLog(location, "run", mode !== "off");
      const registry: Metric.MetricRegistry = new Map();
      const controls = [
        "run.started",
        "model.call",
        "tool.call",
        "stage",
        "gap",
        "budget.receipt",
        "budget.floor",
        "preflight",
        "assemble.grouping",
        "model.native-attempt",
        "estimate",
        "run.admitted",
        "run.close-failed",
      ];
      for (const type of controls) log.write({ type, fixture: true });
      const journal = openCaptureJournal(join(directory, "capture"), "run", {
        log,
      });
      journal.close();
      const finish = startLogSpan(log, "harness.manual");
      await Effect.runPromise(
        Effect.gen(function* () {
          const tracer = yield* Effect.tracer;
          expect(tracer === Tracer.nativeTracer).toBe(!enabled);
          yield* Store.prepareForWrite;
          return yield* rangeManifest(
            repository,
            { baseOid: base, headOid: head },
            defaultManifestSettings(1_000_000),
            captureOutlineSource(),
          );
        }).pipe(
          Effect.provide(
            Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
          ),
          Effect.provide(Store.layer(location, { create: true })),
          Effect.provide(BunFileSystem.layer),
          withAttemptMetrics(log, registry),
          Effect.provide(tracerLayer(log, settings, registry)),
          Effect.scoped,
        ),
      );
      finish();
      // Exercise the direct stage-span writer as well as Effect's tracer and the async sink.
      log.write({
        type: "span",
        name: "harness.stage.fixture",
        events: [{ name: "harness.fixture" }],
      });
      await log.flush?.();
      const records = readRunLog(log.path);
      expect(
        records
          .filter((record) => record["fixture"])
          .map((record) => record.type),
      ).toEqual(controls);
      expect(modelCallCounts(records)).toEqual({
        modelCalls: 1,
        failedModelCalls: 0,
        abortedModelCalls: 0,
      });
      const observations = records.filter((record) =>
        ["span", "span.start", "metric"].includes(record.type),
      );
      if (enabled) {
        expect(
          observations.some(
            (record) =>
              record.type === "span" &&
              record["name"] === "harness.precompute.manifest",
          ),
        ).toBe(true);
        expect(
          observations.some(
            (record) =>
              record.type === "metric" &&
              record["name"] === "harness.leads.hunk.duration",
          ),
        ).toBe(true);
        expect(
          observations.some(
            (record) => record["name"] === "harness.journal.append",
          ),
        ).toBe(true);
      } else expect(observations).toEqual([]);
      const journalLines = readFileSync(
        join(directory, "capture", JOURNAL_FILE),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journalLines.map((line) => line.event.type)).toEqual([
        "journal.open",
        "journal.close",
      ]);
      expect(requests).toBe(0);
    } finally {
      if (previousEndpoint === undefined)
        delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
      else process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = previousEndpoint;
      await collector.stop(true);
    }
  }, 60_000);
}

test("off gates admission, hybrid and stack writers before telemetry can reach disk", async () => {
  const location = storeLocationIn(join(root, "other-logs"));
  const logs = [
    openAdmissionLog(location, "request", false),
    openHybridLog(location.directory, "commit", false),
    stackJobLog(location, "fetch", 1, false),
  ];
  for (const log of logs) {
    log.write({ type: "run.started" });
    log.write({ type: "span.start" });
    log.write({ type: "span" });
    log.write({ type: "metric" });
    startLogSpan(log, "harness.manual")();
    await Effect.runPromise(
      withHybridLog(
        log,
        Metric.update(Metric.counter("harness.graph.calls"), 1).pipe(
          Effect.withSpan("harness.graph.search"),
        ),
      ),
    );
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.withSpan("harness.admission"),
        Effect.withTracer(runLogTracer(log)),
      ),
    );
    await log.flush?.();
    expect(readRunLog(log.path).map((record) => record.type)).toEqual([
      "run.started",
    ]);
  }
});
