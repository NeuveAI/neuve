import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const schema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  let result: unknown;
  if (message.method === "initialize")
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "local-planning-fixture", version: "1" },
    };
  else if (message.method === "tools/list")
    result = message.params?.cursor
      ? {
          tools: [
            {
              name: "write_issue",
              inputSchema: schema,
              annotations: { readOnlyHint: false },
            },
          ],
        }
      : {
          tools: [
            {
              name: "read_issue",
              inputSchema: schema,
              annotations: { readOnlyHint: true },
            },
          ],
          nextCursor: "second",
        };
  else if (message.method === "tools/call") {
    if (message.params.arguments.id === "fail") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message:
              "Bearer fixture-secret-canary https://auth.test/?code=canary",
          },
        }) + "\n",
      );
      continue;
    }
    if (message.params.arguments.id === "wait") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: message.params.arguments.id,
            uuid: "fixture-uuid",
            pid: process.pid,
            title: "Fixture",
            description: "Dated scope",
            url: "https://linear.app/neuve/issue/NEU-59",
          }),
        },
      ],
    };
  } else result = {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n",
  );
}
