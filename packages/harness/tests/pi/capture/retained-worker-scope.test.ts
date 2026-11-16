import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { withRetainedSdk } from "../../../src/pi/capture/retained-sdk.ts";
import { sdkContextSnapshot } from "../../../src/pi/capture/retained-context.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { CallRecord } from "../../../src/pi/capture/dump.ts";
import { Json, SdkInvocationEnd } from "../../../src/pi/capture/types.ts";
import {
  DEFAULT_INSPECTION_LIMITS,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";

const native = { conversations: [], session: [] };
const call = (id: string, serviceTier?: "flex"): Omit<CallRecord, "role"> => {
  const model = {
    id,
    name: id,
    api: "openai-responses" as const,
    provider: "openai",
    baseUrl: "https://capture.invalid/v1",
    reasoning: false,
    input: ["text" as const],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 2 },
  };
  const context = normalizeContext({
    messages: [{ role: "user", content: `${id} original input`, timestamp: 1 }],
  });
  const frames = [
    { type: "response.created", response: { id, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      delta: `${id} answer`,
    },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  return {
    callId: id,
    scope: { runId: "offline" },
    route: "synthetic",
    provider: "openai",
    model: id,
    api: "openai-responses",
    headerNames: [],
    credentialCoverage: "none",
    body: { status: "sent", json: { stream: true } },
    requestedAt: 0,
    response: null,
    end: null,
    sdkContext: sdkContextSnapshot(id, model, context, {
      version: 1,
      api: "openai-responses",
      options: {
        cacheRetention: "none",
        ...(serviceTier === undefined ? {} : { serviceTier }),
      },
    }),
    events: [
      ...frames.map((frame) => ({
        at: 0,
        name: frame.type,
        data: Json.parse(frame),
      })),
      {
        at: 0,
        name: "sdk_invocation_end",
        data: {
          version: 1,
          callId: id,
          callbacks: frames.length,
          abort: { status: "not-aborted" },
        },
      },
    ],
  };
};
const Input = z.object({ call: z.object({ callId: z.string() }) });
const tracked = async (use: (workers: Worker[]) => Promise<void>) => {
  const workers: Worker[] = [];
  const original = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (
    this: Worker,
    ...args: Parameters<typeof original>
  ) {
    const input = Input.safeParse(args[0]);
    if (input.success && input.data.call.callId.startsWith("scope-"))
      workers.push(this);
    return original.apply(this, args);
  };
  try {
    await use(workers);
  } finally {
    Worker.prototype.postMessage = original;
  }
};

test("one inspection reuses one worker without retaining another call's strings, model or usage", async () => {
  await tracked(async (workers) => {
    await withRetainedSdk(async (run) => {
      for (const id of ["scope-first", "scope-second", "scope-first"]) {
        const strings: string[] = [];
        const result = await run(call(id), native, (text) =>
          strings.push(text),
        );
        expect(result).toMatchObject({
          model: id,
          responseId: id,
          content: [{ type: "text", text: `${id} answer` }],
          usage: { input: 10, output: 5 },
        });
        expect(strings).toContain(`${id} original input`);
        expect(strings).toContain(`${id} answer`);
        expect(
          strings.some((text) =>
            text.includes(
              id === "scope-first" ? "scope-second" : "scope-first",
            ),
          ),
        ).toBe(false);
      }
    });
    expect(workers).toHaveLength(3);
    expect(new Set(workers).size).toBe(1);
    await withRetainedSdk(async (run) => {
      await run(call("scope-third"), native);
    });
    expect(new Set(workers).size).toBe(2);
  });
});

test("caught SDK failure still poisons the inspection", async () => {
  await expect(
    withRetainedSdk(async (run) => {
      const invalid = call("scope-invalid");
      invalid.events = [];
      try {
        await run(invalid, native);
      } catch {}
      return "not certified";
    }),
  ).rejects.toBeDefined();
});

test("late job output outside a replay refuses scope completion", async () => {
  await tracked(async (workers) => {
    await expect(
      withRetainedSdk(async (run) => {
        await run(call("scope-late"), native);
        workers[0]?.emit("message", { type: "scalar", id: 1, value: "late" });
      }),
    ).rejects.toThrow("outside a job");
  });
});

test("wrong job identity cannot return a valid result", async () => {
  await tracked(async (workers) => {
    await expect(
      withRetainedSdk(async (run) => {
        const pending = run(call("scope-wrong"), native);
        workers[0]?.emit("message", {
          type: "done",
          id: 2,
          value: {},
          usage: {
            units: 0,
            fullChecks: 0,
            fullBytes: 0,
            matches: 0,
            parseUnits: 0,
            decodeUnits: 0,
          },
        });
        await pending;
      }),
    ).rejects.toThrow("identity");
  });
});

test("overlap rejects both jobs and the scope", async () => {
  await expect(
    withRetainedSdk(async (run) => {
      const jobs = [
        run(call("scope-one"), native),
        run(call("scope-two"), native),
      ];
      expect(
        (await Promise.allSettled(jobs)).every(
          (job) => job.status === "rejected",
        ),
      ).toBe(true);
    }),
  ).rejects.toThrow("overlap");
});

test("aggregate cancellation refuses and cannot be swallowed", async () => {
  const controller = new AbortController();
  await expect(
    withRetainedSdk(async (run) => {
      try {
        await run(
          call("scope-cancel"),
          native,
          () => controller.abort(),
          new InspectionBudget(DEFAULT_INSPECTION_LIMITS, controller.signal),
        );
      } catch {}
    }),
  ).rejects.toBeDefined();
});

test("worker exit is a failed inspection", async () => {
  await tracked(async (workers) => {
    await expect(
      withRetainedSdk(async (run) => {
        const pending = run(call("scope-exit"), native);
        await workers[0]?.terminate();
        await pending;
      }),
    ).rejects.toThrow("exited");
  });
});

test("caught invalid original context still poisons the inspection", async () => {
  await expect(
    withRetainedSdk(async (run) => {
      const invalid = call("scope-context");
      delete invalid.sdkContext;
      try {
        await run(invalid, native);
      } catch {}
    }),
  ).rejects.toBeDefined();
});

test("an undefined callback exception cannot turn failed inspection into success", async () => {
  const outcome = await withRetainedSdk(async (run) => {
    try {
      await run(call("scope-undefined"), native, () => {
        throw undefined;
      });
    } catch {}
  }).then(
    () => "fulfilled",
    () => "rejected",
  );
  expect(outcome).toBe("rejected");
});

test("scope completion cannot leave an active replay running", async () => {
  await expect(
    withRetainedSdk(async (run) => {
      void run(call("scope-active"), native).catch(() => {});
    }),
  ).rejects.toThrow("active replay");
});

test("requested service-tier pricing does not leak between jobs", async () => {
  await withRetainedSdk(async (run) => {
    const prices: number[] = [];
    for (const tier of [undefined, "flex", undefined] as const) {
      const output = z
        .object({ usage: z.object({ cost: z.object({ total: z.number() }) }) })
        .parse(await run(call("scope-price", tier), native));
      prices.push(output.usage.cost.total);
    }
    expect(prices[0]).toBeCloseTo(0.00004, 12);
    expect(prices[1]).toBeCloseTo(0.00002, 12);
    expect(prices[2]).toBeCloseTo(0.00004, 12);
  });
});

test("reuse does not reset the caller's aggregate work budget", async () => {
  const probe = new InspectionBudget();
  const original = call("scope-budget");
  await withRetainedSdk(async (run) => {
    await run(original, native, undefined, probe);
  });
  const budget = new InspectionBudget({
    ...DEFAULT_INSPECTION_LIMITS,
    units: probe.usage.units,
  });
  await expect(
    withRetainedSdk(async (run) => {
      await run(original, native, undefined, budget);
      await run(original, native, undefined, budget);
    }),
  ).rejects.toBeDefined();
  expect(budget.usage.units).toBe(probe.usage.units);
});

const keepaliveBurst = (offset = 0) => {
  const original = call("scope-burst");
  const ending = original.events.at(-1);
  if (ending?.name !== "sdk_invocation_end")
    throw new Error("fixture end missing");
  const data = SdkInvocationEnd.parse(ending.data);
  return {
    ...original,
    events: [
      ...original.events.slice(0, 1),
      ...Array.from({ length: 4096 }, () => ({
        at: 0,
        name: "keepalive",
        data: Json.parse({ type: "keepalive" }),
      })),
      ...original.events.slice(1, -1),
      {
        ...ending,
        data: Json.parse({
          ...data,
          callbacks: data.callbacks + 4096 + offset,
        }),
      },
    ],
  };
};

test("a keepalive burst completes within a stricter deadline while retaining every SDK observation", async () => {
  const strings: string[] = [];
  const budget = new InspectionBudget(
    DEFAULT_INSPECTION_LIMITS,
    AbortSignal.timeout(5000),
  );
  const result = await withRetainedSdk((run) =>
    run(keepaliveBurst(), native, (text) => strings.push(text), budget),
  );
  expect(result).toMatchObject({
    stopReason: "stop",
    responseId: "scope-burst",
    content: [{ type: "text", text: "scope-burst answer" }],
  });
  expect(strings).toContain("scope-burst original input");
  expect(strings).toContain("scope-burst answer");
  expect(budget.usage.units).toBeGreaterThan(4096);
}, 10000);

test("scheduling a burst still refuses a contradictory callback count", async () => {
  await expect(
    withRetainedSdk((run) => run(keepaliveBurst(1), native)),
  ).rejects.toMatchObject({
    message: "isolated SDK replay unavailable",
    diagnostic: {
      reason: "SDK callback count contradicts original invocation",
    },
  });
}, 10000);

// Why: a later SDK call must not receive a fresh full close allowance, and failed work is charged.
test("SDK replay receives only the remaining shared counters and charges failed folds", async () => {
  const budget = new InspectionBudget();
  budget.charge("parseUnits", budget.limits.parseUnits - 1);
  await expect(
    withRetainedSdk((run) =>
      run(call("remaining-cap"), native, undefined, budget),
    ),
  ).rejects.toThrow("budget");
  expect(budget.exhausted).toBe("parseUnits");
  expect(budget.usage.parseUnits).toBe(budget.limits.parseUnits);
  const invalid = keepaliveBurst(1);
  const failed = new InspectionBudget();
  await expect(
    withRetainedSdk((run) => run(invalid, native, undefined, failed)),
  ).rejects.toThrow();
  expect(failed.usage.parseUnits).toBeGreaterThan(0);
});
