import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  CredentialDetectors,
  CredentialEpochId,
  CredentialJson,
  InspectionBudget,
  DEFAULT_INSPECTION_LIMITS,
} from "../../../src/pi/capture/credential-detectors.ts";
import {
  inspectInventory,
  inspectionWidth,
} from "../../../src/pi/capture/inspection-pool.ts";
const setup = async () => {
  const key = randomBytes(32);
  const engine = CredentialDetectors.empty(key);
  await engine.register({
    epoch: CredentialEpochId.parse("synthetic-epoch"),
    headers: new Headers({
      authorization: "Bearer synthetic-credential-marker",
    }),
    budget: new InspectionBudget(),
  });
  return { engine, key, state: engine.encodePrivate() };
};
// Why: actual isolated detector workers must preserve whole raw representations and shared refusal limits.
for (const width of [1, 4])
  test(`whole-source inspection with width ${width} preserves duplicate keys and exposures`, async () => {
    const f = await setup();
    const observed = new Set();
    try {
      const results = await inspectInventory({
        ...f,
        budget: new InspectionBudget(),
        width,
        requiredEpochs: ["synthetic-epoch"],
        observe: (epoch) => observed.add(epoch),
        produce: async (consume) => {
          await consume({ kind: "text", text: "ordinary synthetic text" });
          await consume({
            kind: "json",
            json: CredentialJson.parse(
              '{"value":"synthetic-credential-marker","value":"overwritten"}',
            ).source,
          });
          await consume({
            kind: "bytes",
            bytes: Buffer.from("synthetic-credential-marker", "utf16le"),
            mediaType: "application/octet-stream",
          });
        },
      });
      expect(
        results.some(
          (result) => result.status === "complete" && result.matches.length > 0,
        ),
      ).toBe(true);
      expect(results[0]).toMatchObject({ status: "complete", matches: [] });
      expect(results[1]).toMatchObject({
        status: "complete",
        matches: expect.arrayContaining([
          expect.objectContaining({ epoch: "synthetic-epoch", view: "text" }),
        ]),
      });
      if (width === 4)
        expect(results[2]).toMatchObject({
          status: "complete",
          matches: expect.arrayContaining([
            expect.objectContaining({ epoch: "synthetic-epoch", view: "raw" }),
          ]),
        });
      expect([...observed]).toEqual(["synthetic-epoch"]);
    } finally {
      f.engine.destroy();
      f.key.fill(0);
      f.state.fill(0);
    }
  });

test("worker leases together cannot spend more than the parent's remaining parse cap", async () => {
  const f = await setup();
  const budget = new InspectionBudget({
    ...DEFAULT_INSPECTION_LIMITS,
    parseUnits: f.state.byteLength * 4 + 4,
  });
  let exhausted: string | undefined;
  let parseAllowance: number | undefined;
  try {
    const results = await inspectInventory({
      ...f,
      budget,
      width: 4,
      progress: (value) => {
        exhausted = value.exhausted;
        parseAllowance = value.allowance?.parseUnits;
      },
      requiredEpochs: ["synthetic-epoch"],
      observe() {},
      produce: async (consume) => {
        for (let i = 0; i < 4; i++)
          await consume({
            kind: "json",
            json: CredentialJson.parse(
              '{"ordinary":"input that does not fit the remaining allowance"}',
            ).source,
          });
      },
    });
    expect(
      results.some(
        (result) =>
          result.status === "unavailable" && result.reason === "budget",
      ),
    ).toBe(true);
    expect(exhausted).toBe("parseUnits");
    expect(parseAllowance).toBe(f.state.byteLength + 1);
    expect(budget.usage.parseUnits).toBeLessThanOrEqual(
      budget.limits.parseUnits,
    );
  } finally {
    f.engine.destroy();
    f.key.fill(0);
    f.state.fill(0);
  }
});

test("CPU and memory budgets select a serial fallback", () => {
  expect(inspectionWidth(1, 8 * 1024 ** 3)).toBe(1);
  expect(inspectionWidth(4, 512 * 1024 ** 2)).toBe(1);
  expect(inspectionWidth(4, 8 * 1024 ** 3)).toBe(4);
});

test("interrupting the Effect scope terminates and joins pending detector workers", async () => {
  const f = await setup();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await expect(
      inspectInventory({
        ...f,
        budget: new InspectionBudget(
          DEFAULT_INSPECTION_LIMITS,
          controller.signal,
        ),
        width: 4,
        requiredEpochs: ["synthetic-epoch"],
        observe() {},
        produce: async (consume) => {
          for (let index = 0; index < 4; index++)
            await consume({ kind: "text", text: "q".repeat(1024 * 1024) });
        },
      }),
    ).rejects.toThrow("cancelled");
  } finally {
    clearTimeout(timer);
    f.engine.destroy();
    f.key.fill(0);
    f.state.fill(0);
  }
});

// Why: untrusted media-type metadata occupies the same queue budget as a source's body.
test("queued bytes include complete media-type metadata and the job envelope", async () => {
  const f = await setup();
  let peak = 0;
  try {
    const results = await inspectInventory({
      ...f,
      budget: new InspectionBudget(),
      width: 4,
      requiredEpochs: ["synthetic-epoch"],
      observe() {},
      progress: (value) => {
        peak = value.peakQueuedBytes;
      },
      produce: async (consume) => {
        await consume({
          kind: "bytes",
          bytes: new Uint8Array([1, 2, 3, 4]),
          mediaType: "application/octet-stream;name=" + "q".repeat(4000),
        });
      },
    });
    expect(results).toMatchObject([{ status: "complete", matches: [] }]);
    expect(peak).toBe(8576);
  } finally {
    f.engine.destroy();
    f.key.fill(0);
    f.state.fill(0);
  }
});

// Why: recognition views may occupy pooled buffers. Adjacent bytes must never enter a worker.
test("recognition state uses exact private copies of sliced backing buffers", async () => {
  const f = await setup();
  const keyBacking = new Uint8Array(128).fill(7);
  keyBacking.set(f.key, 32);
  const stateBacking = new Uint8Array(f.state.byteLength + 64).fill(9);
  stateBacking.set(f.state, 32);
  try {
    const results = await inspectInventory({
      engine: f.engine,
      key: keyBacking.subarray(32, 64),
      state: stateBacking.subarray(32, 32 + f.state.byteLength),
      budget: new InspectionBudget(),
      width: 4,
      requiredEpochs: ["synthetic-epoch"],
      observe() {},
      produce: async (consume) => {
        await consume({ kind: "text", text: "ordinary isolated input" });
      },
    });
    expect(results).toEqual([
      {
        status: "complete",
        matches: [],
        epochs: [CredentialEpochId.parse("synthetic-epoch")],
      },
    ]);
    expect([...keyBacking.subarray(32, 64)]).toEqual([...f.key]);
  } finally {
    f.engine.destroy();
    f.key.fill(0);
    f.state.fill(0);
    keyBacking.fill(0);
    stateBacking.fill(0);
  }
});

// Why: an interrupted Effect does not await an uncooperative producer's promise.
test("a producer resumed after scope release cannot start detector workers", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./inspection-resume-fixture.ts", import.meta.url)),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({
    refused: true,
    beforeResume: 0,
    afterResume: 0,
  });
});
