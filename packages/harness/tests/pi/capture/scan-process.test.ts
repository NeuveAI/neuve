// The parent's clock must stop and join a blocked child's event loop before returning.
import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Latch } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { JOB_POLICIES, Worker, storeLocationIn } from "@neuve/records-core";
import { captureFiledEvent } from "../../../src/pi/capture/records.ts";
import {
  runScanProcess,
  ScanMachineBudget,
} from "../../../src/pi/capture/process.ts";
import {
  availableInspectionMemory,
  readMachineInspectionInputs,
  macAvailableMemory,
  scanMemoryGrant,
  machineInspectionInputs,
} from "../../../src/pi/capture/inspection-pool.ts";

test("a synchronous stuck child is killed, joined and its private work removed on no progress", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-process-"));
  const script = join(root, "stuck.ts");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs"; import {join} from "node:path"; writeFileSync(join(process.argv[process.argv.indexOf("--work")+1], "pid"), String(process.pid)); while(true) {}`,
  );
  const location = storeLocationIn(root);
  let pid = 0;
  try {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runScanProcess({
            location,
            command: [process.execPath, "--no-env-file", script],
            event: captureFiledEvent({
              rawCapture: "a".repeat(64),
              runId: "synthetic",
              checkpoint: null,
              counts: { records: 100000, bytes: 1, calls: 0, frames: 1 },
              sizes: { total: 1, largest: 1 },
            }),
          }).pipe(Effect.result),
        );
        yield* Effect.promise(async () => {
          for (let i = 0; i < 200; i++) {
            try {
              const folder = readdirSync(
                join(location.directory, "capture-jobs"),
              )[0];
              if (folder) {
                pid = Number(
                  readFileSync(
                    join(location.directory, "capture-jobs", folder, "pid"),
                    "utf8",
                  ),
                );
                if (pid) break;
              }
            } catch {}
            await Bun.sleep(10);
          }
          if (!pid) throw new Error("synthetic child never started");
        });
        yield* TestClock.adjust("38 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.scoped,
        Effect.provide(TestClock.layer()),
        Effect.provideService(ScanMachineBudget, (sizes) =>
          scanMemoryGrant(sizes, {
            ...machineInspectionInputs(),
            available: 8 * 1024 ** 3,
          }),
        ),
      ),
    );
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure")
      expect(outcome.failure).toMatchObject({ _tag: "ScanNoProgress" });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readdirSync(join(location.directory, "capture-jobs"))).toEqual([]);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test("scan width reserves a CPU and falls to one or holds when peak memory does not fit", () => {
  const inputs = {
    ...machineInspectionInputs(),
    available: 8 * 1024 ** 3,
    cpuMax: null,
    memoryMax: null,
  };
  expect(
    [1, 2, 3, 4, 8].map(
      (parallelism) =>
        scanMemoryGrant({ total: 1, largest: 1 }, { ...inputs, parallelism })
          .width,
    ),
  ).toEqual([1, 1, 2, 3, 4]);
  expect(
    scanMemoryGrant(
      { total: 1, largest: 1 },
      { ...inputs, available: 1600 * 1024 ** 2 },
    ),
  ).toMatchObject({ admitted: true, width: 1 });
  expect(
    scanMemoryGrant(
      { total: 1024 ** 3, largest: 1024 ** 3 },
      { ...inputs, available: 1600 * 1024 ** 2 },
    ).admitted,
  ).toBe(false);
}, 120000);

test("reclaimable cache remains available to the cgroup admission calculation", () => {
  const GiB = 1024 ** 3;
  expect(availableInspectionMemory(16 * GiB, 8 * GiB, 7 * GiB, 4 * GiB)).toBe(
    5 * GiB,
  );
  expect(availableInspectionMemory(16 * GiB, null, 7 * GiB, 4 * GiB)).toBe(
    16 * GiB,
  );
  expect(availableInspectionMemory(2 * GiB, 8 * GiB, 7 * GiB, 4 * GiB)).toBe(
    2 * GiB,
  );
  expect(availableInspectionMemory(16 * GiB, 8 * GiB, 10 * GiB, 0)).toBe(0);
}, 120000);

test("the unmocked operating system reader reports available memory on this host", async () => {
  const inputs = await readMachineInspectionInputs();
  if (process.platform === "darwin")
    expect(inputs.memorySource).toBe("vm_stat");
  expect(inputs.hostAvailable).toBeGreaterThan(0);
  expect(Number.isSafeInteger(inputs.available)).toBe(true);
}, 120000);

test("memory below the reserve fails a counted attempt after a bounded admission wait", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        runScanProcess({
          location: storeLocationIn("/tmp/synthetic-never-spawn"),
          command: ["must-not-run"],
          event: captureFiledEvent({
            rawCapture: "a".repeat(64),
            runId: "memory",
            checkpoint: null,
            counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
            sizes: { total: 1, largest: 1 },
          }),
        }).pipe(Effect.result),
      );
      yield* TestClock.adjust("65 seconds");
      return yield* Fiber.join(fiber);
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      Effect.provideService(ScanMachineBudget, (sizes) =>
        scanMemoryGrant(sizes, {
          ...machineInspectionInputs(),
          available: 1024 ** 3 - 1,
          memorySource: "freemem-fallback",
        }),
      ),
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      reason: "capture scan memory admission timed out; retry later",
      memorySource: "freemem-fallback",
      availableBytes: 1024 ** 3 - 1,
      retryable: true,
    },
  });
}, 120000);

test("a blocked scan terminates when its parent is killed", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-parent-death-"));
  const guard = new URL("../../../src/parent-guard.ts", import.meta.url).href;
  const childScript = join(root, "child.ts");
  const parentScript = join(root, "parent.ts");
  writeFileSync(
    childScript,
    `import {monitorParent} from ${JSON.stringify(guard)}; monitorParent(Number(process.argv[2])); process.stdout.write(String(process.pid)+"\\n"); while(true) {}`,
  );
  writeFileSync(
    parentScript,
    `const c=Bun.spawn([process.execPath,"--no-env-file",${JSON.stringify(childScript)},String(process.pid)],{stdout:"inherit",stderr:"ignore",detached:true});setInterval(()=>{},1000);`,
  );
  const parent = Bun.spawn([process.execPath, "--no-env-file", parentScript], {
    stdout: "pipe",
    stderr: "ignore",
  });
  let child = 0;
  try {
    const reader = parent.stdout.getReader();
    const { value } = await reader.read();
    child = Number(new TextDecoder().decode(value).trim());
    expect(child).toBeGreaterThan(1);
    parent.kill("SIGKILL");
    await parent.exited;
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(child, 0);
      } catch {
        alive = false;
        break;
      }
      await Bun.sleep(25);
    }
    expect(alive).toBe(false);
    await reader.cancel();
  } finally {
    parent.kill("SIGKILL");
    if (child)
      try {
        process.kill(child, "SIGKILL");
      } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test("a review starting during memory admission keeps the scan behind the heavy-work gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-memory-gate-"));
  const script = join(root, "child.ts"),
    marker = join(root, "spawned");
  writeFileSync(
    script,
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"spawned");process.stdout.write('{"type":"failure","failureKind":"execution","reason":"capture scan failed; retry later","retryable":true}\\n');`,
  );
  let admitted = false,
    gateEntered = false;
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const free = yield* Latch.make(true);
        const fiber = yield* Effect.forkChild(
          runScanProcess({
            location: storeLocationIn(root),
            command: [process.execPath, "--no-env-file", script],
            event: captureFiledEvent({
              rawCapture: "a".repeat(64),
              runId: "gate",
              checkpoint: null,
              counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
              sizes: { total: 1, largest: 1 },
            }),
          }).pipe(
            Effect.result,
            Effect.provideService(Worker.HeavyWork, {
              child: (prepare, launch, stop) =>
                Effect.uninterruptibleMask(() =>
                  Effect.gen(function* () {
                    const prepared = yield* Effect.interruptible(prepare);
                    gateEntered = true;
                    yield* Effect.interruptible(free.await);
                    const child = yield* Effect.sync(() => launch(prepared));
                    yield* Effect.addFinalizer(() =>
                      Effect.asVoid(stop(child)),
                    );
                    return child;
                  }),
                ),
              spawn: (prepare, launch) =>
                Effect.flatMap(prepare, (prepared) =>
                  Effect.andThen(
                    Effect.sync(() => {
                      gateEntered = true;
                    }),
                    Effect.andThen(
                      free.await,
                      Effect.sync(() => launch(prepared)),
                    ),
                  ),
                ),
              start: (effect) =>
                Effect.andThen(
                  Effect.sync(() => {
                    gateEntered = true;
                  }),
                  Effect.andThen(free.await, effect),
                ),
            }),
          ),
        );
        yield* TestClock.adjust("3 seconds");
        yield* free.close;
        admitted = true;
        yield* TestClock.adjust("5 seconds");
        yield* Effect.promise(async () => {
          for (let i = 0; i < 200 && !gateEntered; i++) await Bun.sleep(10);
          await Bun.sleep(100);
        });
        expect(gateEntered).toBe(true);
        expect(existsSync(marker)).toBe(false);
        yield* free.open;
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect(existsSync(marker)).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(TestClock.layer()),
        Effect.provideService(ScanMachineBudget, (sizes) => ({
          ...scanMemoryGrant(sizes, {
            ...machineInspectionInputs(),
            available: 8 * 1024 ** 3,
          }),
          admitted,
        })),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);

test("macOS admission counts file-backed inactive memory conservatively", () => {
  const text =
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages speculative: 5.\nPages purgeable: 2.\nPages inactive: 100.\nFile-backed pages: 20.\n";
  expect(macAvailableMemory(text)).toBe(37 * 16384);
  expect(() =>
    macAvailableMemory(text.replace("File-backed pages: 20.\n", "")),
  ).toThrow();
}, 120000);

test("memory admission is exact at the reserve plus one-worker peak", () => {
  const MiB = 1024 ** 2;
  const threshold = 1024 * MiB + 384 * MiB + 9;
  const inputs = { ...machineInspectionInputs(), parallelism: 2 };
  expect(
    scanMemoryGrant(
      { total: 1, largest: 1 },
      { ...inputs, available: threshold },
    ).admitted,
  ).toBe(true);
  expect(
    scanMemoryGrant(
      { total: 1, largest: 1 },
      { ...inputs, available: threshold - 1 },
    ).admitted,
  ).toBe(false);
  expect(
    scanMemoryGrant(
      { total: 1, largest: 1 },
      { ...inputs, available: 1024 * MiB - 1 },
    ).admitted,
  ).toBe(false);
}, 120000);

test("the inside-gate memory recheck refuses a grant that disappeared before spawn", async () => {
  let observations = 0;
  const result = await Effect.runPromise(
    runScanProcess({
      location: storeLocationIn("/tmp/synthetic-recheck-never-spawn"),
      command: ["must-not-run"],
      event: captureFiledEvent({
        rawCapture: "a".repeat(64),
        runId: "recheck",
        checkpoint: null,
        counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
        sizes: { total: 1, largest: 1 },
      }),
    }).pipe(
      Effect.result,
      Effect.provideService(ScanMachineBudget, (sizes) =>
        scanMemoryGrant(sizes, {
          parallelism: 4,
          cpuMax: null,
          memoryMax: null,
          memoryCurrent: 0,
          inactiveFile: 0,
          hostAvailable: 8 * 1024 ** 3,
          memorySource: "freemem-fallback",
          available: ++observations === 1 ? 8 * 1024 ** 3 : 512 * 1024 ** 2,
        }),
      ),
    ),
  );
  expect(observations).toBe(2);
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      reason: "capture scan memory admission changed before scan; retry later",
      retryable: true,
    },
  });
}, 120000);

test("legacy overflowing clock counts fail as a public non-retryable attempt", async () => {
  const event = captureFiledEvent({
    rawCapture: "a".repeat(64),
    runId: "overflow",
    checkpoint: null,
    counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
    sizes: { total: 1, largest: 1 },
  });
  event.payload.counts.records = Number.MAX_SAFE_INTEGER;
  const result = await Effect.runPromise(
    runScanProcess({
      location: storeLocationIn("/tmp/overflow-never-spawn"),
      event,
      command: ["must-not-run"],
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      reason: "invalid capture scan counts; export refused",
      retryable: false,
    },
  });
}, 120000);

/**
 * The parent reads the scan child's stdout in a loop with no await in its body, so it asks for the
 * next chunk only after it has handled every complete line before it. A relay with no buffer of its
 * own therefore knows how many progress lines the parent has counted.
 */
const countParentReads = (script: string) => {
  const original = Bun.spawn;
  let delivered = 0,
    handled = 0;
  const spy = spyOn(Bun, "spawn").mockImplementation((...args) => {
    const child = Reflect.apply(original, Bun, args) as ReturnType<
      typeof original
    >;
    if (
      !Array.isArray(args[0]) ||
      !args[0].includes(script) ||
      !(child.stdout instanceof ReadableStream)
    )
      return child;
    const source = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const stdout = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          handled = delivered;
          const next = await source.read();
          if (next.done) return controller.close();
          for (const byte of next.value) if (byte === 10) delivered++;
          controller.enqueue(next.value);
        },
        cancel: (reason) => source.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    Object.defineProperty(child, "stdout", { value: stdout });
    return child;
  });
  return { handled: () => handled, restore: () => spy.mockRestore() };
};

test("memory admission plus the maximum ceiling ends with the scan reason inside its job deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "scan-full-deadline-"));
  const script = join(root, "progress.ts"),
    pidfile = join(root, "pid");
  writeFileSync(
    script,
    `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidfile)},String(process.pid));let counter=0;setInterval(()=>process.stdout.write(JSON.stringify({type:"progress",counter:++counter})+"\\n"),1);`,
  );
  let reads = 0,
    pid = 0;
  const parent = countParentReads(script);
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runScanProcess({
            location: storeLocationIn(root),
            command: [process.execPath, "--no-env-file", script],
            event: captureFiledEvent({
              rawCapture: "a".repeat(64),
              runId: "full-deadline",
              checkpoint: null,
              counts: { records: 600000, bytes: 1, calls: 0, frames: 1 },
              sizes: { total: 1, largest: 1 },
            }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: JOB_POLICIES["capture.scan"].deadline,
              orElse: () => Effect.fail(new Error("generic job timeout")),
            }),
            Effect.result,
          ),
        );
        yield* TestClock.adjust("60 seconds");
        yield* Effect.promise(async () => {
          for (let i = 0; i < 500; i++) {
            if (existsSync(pidfile)) {
              pid = Number(readFileSync(pidfile, "utf8"));
              if (pid) return;
            }
            await Bun.sleep(10);
          }
          throw new Error("fixture scan never spawned");
        });
        // Each 25-second step waits until the parent has counted a progress line since the last
        // step, so the no-progress watchdog sees the healthy child however slowly it runs. After
        // 5 s without one the step goes ahead anyway and leaves the verdict to the watchdog.
        let mark = 0;
        for (let i = 0; i < 72 && fiber.pollUnsafe() === undefined; i++) {
          yield* Effect.promise(async () => {
            for (
              let waited = 0;
              waited < 500 &&
              parent.handled() <= mark &&
              fiber.pollUnsafe() === undefined;
              waited++
            )
              await Bun.sleep(10);
          });
          yield* TestClock.adjust("25 seconds");
          mark = parent.handled();
        }
        return yield* Fiber.join(fiber);
      }).pipe(
        Effect.scoped,
        Effect.provide(TestClock.layer()),
        Effect.provideService(ScanMachineBudget, (sizes) =>
          scanMemoryGrant(sizes, {
            ...machineInspectionInputs(),
            available: ++reads >= 13 ? 8 * 1024 ** 3 : 0,
          }),
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ScanAttemptFailed",
        reason: "capture scan exceeded its 1800000-millisecond ceiling",
      },
    });
    expect(reads).toBeGreaterThanOrEqual(13);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    parent.restore();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
