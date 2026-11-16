import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { linearMcpSession, type LinearMcpCall } from "../src/linear-planning";
import { IntegrationServer } from "../src/integrations";

test("real SDK lists all pages, refuses a writer, captures definition hashes and masks thrown errors before truncation", async () => {
  const definition = IntegrationServer.parse({
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "linear-planning-server.ts")],
    },
    variables: [],
    tools: ["read_issue", "write_issue"],
    identifiers: {},
  });
  const client = linearMcpSession({
    status: "configured",
    path: "fixture",
    file: { version: 1, servers: { linear: definition } },
  });
  let childPid: number | undefined;
  try {
    const connection = await client.connection("linear");
    expect(connection.tools.map(({ name }) => name)).toEqual(["read_issue"]);
    expect(connection.refused).toEqual([
      {
        tool: "write_issue",
        reason: "the server marks it as writing (readOnlyHint: false)",
      },
    ]);
    expect(connection.tools[0]?.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    const processResult = await client.call("linear", "read_issue", {
      id: "pid",
    });
    const pidResult = JSON.parse(processResult.text);
    if (typeof pidResult.pid !== "number")
      throw new Error("Fixture did not return its process identity");
    childPid = pidResult.pid;
    expect(
      (await client.call("linear", "read_issue", { id: "NEU-59" })).text,
    ).toContain('"id":"NEU-59"');
    try {
      await client.call("linear", "read_issue", { id: "fail" });
      throw new Error("Expected failure");
    } catch (error) {
      expect(String(error)).not.toContain("fixture-secret-canary");
      expect(String(error)).not.toContain("code=canary");
    }
    const controller = new AbortController();
    const pending = client.call(
      "linear",
      "read_issue",
      { id: "wait" },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  } finally {
    await client.close();
  }
  if (childPid === undefined) throw new Error("Missing fixture process");
  expect(() => process.kill(childPid, 0)).toThrow();
});

const rpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const issueInput = z.object({
  arguments: z.object({ id: z.string() }),
});
const httpDefinition = (url: string) =>
  IntegrationServer.parse({
    transport: { type: "http", url },
    variables: [],
    tools: ["read_issue"],
    identifiers: {},
  });
const issueTool = {
  name: "read_issue",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
function protocolResult(request: z.infer<typeof rpcRequest>) {
  if (request.method === "initialize")
    return {
      protocolVersion: z
        .object({ protocolVersion: z.string() })
        .parse(request.params).protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "local-recovery-fixture", version: "1" },
    };
  if (request.method === "tools/list") return { tools: [issueTool] };
  const { id } = issueInput.parse(request.params).arguments;
  return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
}

test("same-session acquisition recovery preserves concurrent reads and bounded healthy reuse with the real HTTP SDK", async () => {
  let available = false;
  const requests: { path: string; method: string }[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const request = rpcRequest.parse(await req.json());
      const path = new URL(req.url).pathname;
      requests.push({ path, method: request.method });
      if (path === "/flaky" && !available)
        return new Response("temporary fixture outage", { status: 503 });
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (
        path === "/healthy" &&
        request.method === "tools/call" &&
        issueInput.parse(request.params).arguments.id === "held"
      ) {
        started.resolve();
        await release.promise;
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: protocolResult(request),
      });
    },
  });
  const captures: LinearMcpCall[] = [];
  const client = linearMcpSession(
    {
      status: "configured",
      path: "local-recovery-fixture",
      file: {
        version: 1,
        servers: {
          flaky: httpDefinition(new URL("flaky", upstream.url).href),
          healthy: httpDefinition(new URL("healthy", upstream.url).href),
        },
      },
    },
    { capture: (call) => captures.push(call) },
  );
  try {
    const held = client.call("healthy", "read_issue", { id: "held" });
    await started.promise;
    const failures = await Promise.allSettled([
      client.connection("flaky"),
      client.call("flaky", "read_issue", { id: "initial" }),
    ]);
    expect(failures.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(requests.filter((entry) => entry.path === "/flaky")).toEqual([
      { path: "/flaky", method: "initialize" },
    ]);
    available = true;
    const recovered = await Promise.all([
      client.call("flaky", "read_issue", { id: "NEU-59" }),
      client.call("flaky", "read_issue", { id: "NEU-60" }),
    ]);
    expect(recovered.map((result) => result.text)).toEqual([
      '{"id":"NEU-59"}',
      '{"id":"NEU-60"}',
    ]);
    release.resolve();
    expect((await held).text).toBe('{"id":"held"}');
    expect(
      (await client.call("healthy", "read_issue", { id: "reuse" })).text,
    ).toBe('{"id":"reuse"}');
    expect(
      (await client.call("flaky", "read_issue", { id: "reuse" })).text,
    ).toBe('{"id":"reuse"}');
    expect(requests.filter((entry) => entry.method === "initialize")).toEqual([
      { path: "/healthy", method: "initialize" },
      { path: "/flaky", method: "initialize" },
      { path: "/flaky", method: "initialize" },
    ]);
    expect(
      requests.filter((entry) => entry.method === "tools/list"),
    ).toHaveLength(2);
    expect(captures.map((call) => call.outcome).sort()).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "failed",
    ]);
  } finally {
    release.resolve();
    await client.close();
    await upstream.stop(true);
  }
});

test("close joins owned calls and their captures and refuses new work", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const captures: LinearMcpCall[] = [];
  let requestCount = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      requestCount++;
      const request = rpcRequest.parse(await req.json());
      if (request.id === undefined) return new Response(null, { status: 202 });
      if (request.method === "tools/call") {
        started.resolve();
        await release.promise;
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: protocolResult(request),
      });
    },
  });
  const client = linearMcpSession(
    {
      status: "configured",
      path: "close-fixture",
      file: {
        version: 1,
        servers: { linear: httpDefinition(upstream.url.href) },
      },
    },
    { capture: (call) => captures.push(call) },
  );
  try {
    const pending = client.call("linear", "read_issue", { id: "held" });
    const settled = Promise.allSettled([pending]);
    await started.promise;
    const closing = client.close();
    expect(client.close()).toBe(closing);
    await closing;
    expect((await settled)[0]?.status).toBe("rejected");
    expect(captures).toHaveLength(1);
    expect(captures[0]?.outcome).toBe("failed");
    const closedCount = requestCount;
    await expect(
      client.call("linear", "read_issue", { id: "refused" }),
    ).rejects.toThrow("planning:disconnected");
    await expect(client.connection("linear")).rejects.toThrow(
      "planning:disconnected",
    );
    expect(requestCount).toBe(closedCount);
    expect(captures).toHaveLength(1);
  } finally {
    release.resolve();
    await client.close();
    await upstream.stop(true);
  }
});
