import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SOL_ROUTE } from "../../../src/route.ts";
import { REVIEW_SETTINGS } from "../../../src/pi/host.ts";
import type { ModelCaptureEvent } from "../../../src/pi/capture/types.ts";
import { createAgentRouteProvider } from "../../../src/pi/providers/agent-route-provider.ts";
import {
  nativeRetryAdmission,
  NativeAttemptsDoc,
  retryAfterAt,
} from "../../../src/pi/providers/retry-admission.ts";
import {
  completed,
  created,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "./fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "native-retry-"));
const token = tokenCommand(directory, "lease");
const endpoint = openEndpoint();
afterAll(() => {
  endpoint.stop();
  rmSync(directory, { recursive: true, force: true });
});
const capture: Array<ModelCaptureEvent> = [];
const requests: Array<number> = [];
const refuse = (header: string | undefined) => () => {
  requests.push(Date.now());
  return Response.json(
    { error: { code: "rate_limit_exceeded", message: "fixture throttle" } },
    {
      status: 429,
      headers: header === undefined ? {} : { "retry-after": header },
    },
  );
};
const answer = () => {
  requests.push(Date.now());
  return sse([
    created("retry-answer"),
    ...messageItem(0, "retry-message", "final_answer", "Done."),
    completed("retry-answer"),
  ]);
};
let databases = 0;
const open = async (path: string) => {
  const models = createModels();
  const retry = nativeRetryAdmission(REVIEW_SETTINGS);
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    {
      models,
      registry: createRegistry(),
      settings: retry.settings,
    },
    context,
  );
  const root = await harness.root(context);
  const binding = {
    runId: "retry-fixture",
    stage: "frame",
    agent: "frame",
    conversationId: root.id,
    logicalProvider: "retry-route",
    physicalProvider: SOL_ROUTE.provider,
    physicalModel: SOL_ROUTE.model,
    mode: { kind: "normal" },
  } as const;
  models.setProvider(
    retry.provider(
      createAgentRouteProvider({
        credentialInspection: "ephemeral" as const,
        route: SOL_ROUTE,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture: (event) => capture.push(event),
        logicalProvider: binding.logicalProvider,
        readBinding: async () => binding,
      }),
      { harness, conversationId: root.id },
    ),
  );
  await root.configure(
    {
      model: {
        provider: binding.logicalProvider,
        modelId: binding.physicalModel,
      },
    },
    context,
  );
  return { harness, root };
};
const until = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error("fixture did not reach the native retry wait");
    await Bun.sleep(5);
  }
};

test("Retry-After parses seconds and HTTP dates at the response boundary", () => {
  expect(retryAfterAt("30", 1_000)).toBe(31_000);
  expect(retryAfterAt("Thu, 01 Jan 1970 00:00:30 GMT", 1_000)).toBe(30_000);
  expect(retryAfterAt("Thu, 01 Jan 1970 00:00:00 GMT", 1_000)).toBe(1_000);
  expect(retryAfterAt("not a deadline", 1_000)).toBeUndefined();
  expect(retryAfterAt("9".repeat(400), 1_000)).toBe(Number.MAX_SAFE_INTEGER);
});

test("native retries honor the real Retry-After 30 second floor", async () => {
  capture.length = 0;
  requests.length = 0;
  endpoint.respond(refuse("30"), answer);
  const { harness, root } = await open(
    join(directory, `floor-${++databases}.sqlite`),
  );
  try {
    const result = await (
      await root.submit({ type: "input", content: "Review." }, context)
    ).wait(context);
    const elapsed = requests[1]! - requests[0]!;
    console.log(
      "NATIVE_RETRY_FLOOR",
      JSON.stringify({
        elapsed,
        requests: requests.length,
        status: result.status,
      }),
    );
    expect(result.status).toBe("done");
    expect(requests).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(30_000);
    expect(elapsed).toBeLessThan(35_000);
    expect(
      capture.some(
        (event) =>
          event.type === "model.event" &&
          event.name === "http_error" &&
          typeof event.data === "object" &&
          event.data !== null &&
          "retryAfter" in event.data &&
          event.data.retryAfter === "30",
      ),
    ).toBe(true);
  } finally {
    await harness.close(context);
  }
}, 40_000);

test("closing and reopening retains the remaining retry floor and a later turn has no inherited wait", async () => {
  requests.length = 0;
  endpoint.respond(refuse("3"), answer, answer);
  const path = join(directory, `reopen-${++databases}.sqlite`);
  const first = await open(path);
  const submission = await first.root.submit(
    { type: "input", content: "Review." },
    context,
  );
  await until(async () =>
    (await first.root.entries({}, 20, undefined, context)).items.some(
      (entry) => entry.kind === "pi.assistant",
    ),
  );
  await first.harness.close(context);
  await Bun.sleep(1_000);
  const second = await open(path);
  try {
    const resumed = await second.harness.submission(submission.id, context);
    const result = await resumed?.wait(context);
    const elapsed = requests[1]! - requests[0]!;
    const at = Date.now();
    const next = await (
      await second.root.submit(
        { type: "input", content: "Next turn." },
        context,
      )
    ).wait(context);
    console.log(
      "NATIVE_RETRY_REOPEN",
      JSON.stringify({
        elapsed,
        nextTurnMs: Date.now() - at,
        requests: requests.length,
        status: result?.status,
      }),
    );
    expect(result?.status).toBe("done");
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThan(4_000);
    expect(next.status).toBe("done");
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(requests).toHaveLength(3);
    const attempts = await second.harness.snapshot(NativeAttemptsDoc, context);
    expect(Object.values(attempts?.generations ?? {})).toEqual([[1, 2], [1]]);
    await second.harness.close(context);
    const third = await open(path);
    try {
      expect(await third.harness.snapshot(NativeAttemptsDoc, context)).toEqual(
        attempts,
      );
      expect(requests).toHaveLength(3);
    } finally {
      await third.harness.close(context);
    }
  } finally {
    await second.harness.close(context);
  }
}, 10_000);

test("aborting a native retry wait sends no retry request", async () => {
  requests.length = 0;
  endpoint.respond(refuse("30"));
  const { harness, root } = await open(
    join(directory, `abort-${++databases}.sqlite`),
  );
  try {
    const submission = await root.submit(
      { type: "input", content: "Review." },
      context,
    );
    await until(async () =>
      (await root.entries({}, 20, undefined, context)).items.some(
        (entry) => entry.kind === "pi.assistant",
      ),
    );
    const at = Date.now();
    await root.abort(context);
    const result = await submission.wait(context);
    expect(result.status).toBe("unanswered");
    expect(Date.now() - at).toBeLessThan(1_000);
    expect(requests).toHaveLength(1);
  } finally {
    await harness.close(context);
  }
});

test("native pi still owns the four-attempt limit and exponential jittered waits", async () => {
  requests.length = 0;
  endpoint.respond(
    refuse(undefined),
    refuse(undefined),
    refuse(undefined),
    refuse(undefined),
  );
  const { harness, root } = await open(
    join(directory, `exhausted-${++databases}.sqlite`),
  );
  try {
    const result = await (
      await root.submit({ type: "input", content: "Review." }, context)
    ).wait(context);
    const delays = requests.slice(1).map((at, index) => at - requests[index]!);
    console.log(
      "NATIVE_RETRY_EXHAUSTED",
      JSON.stringify({
        delays,
        requests: requests.length,
        status: result.status,
      }),
    );
    expect(result.status).toBe("unanswered");
    expect(requests).toHaveLength(4);
    for (const [index, delay] of delays.entries()) {
      expect(delay).toBeGreaterThanOrEqual(1_600 * 2 ** index);
      expect(delay).toBeLessThan(2_400 * 2 ** index + 500);
    }
  } finally {
    await harness.close(context);
  }
}, 25_000);
