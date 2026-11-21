// Why: what each runtime is given. A runtime with tools of its own (Codex) uses its own shell and
// file editor inside its sandbox, so pi's must never be served to it beside them; the pass-through
// that records its work is served to no runtime; and any other runtime keeps every tool.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  policy,
  RUNTIME_WORK_TOOL,
} from "../../src/chat-runtime/transcript.ts";

const tool = (name: string) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});
const coding = (CodingTools.tools ?? []).map((t) => t.name);
const messages = [
  {
    role: "system" as const,
    content: "prompt",
    toolsAdded: [...coding, "question", RUNTIME_WORK_TOOL].map(tool) as never,
    timestamp: 0,
  },
];
const handle = () => Effect.succeed({ text: "" });

test("pi's shell and file tools and the pass-through are kept from a runtime with its own tools", () => {
  expect(coding).toEqual(
    expect.arrayContaining(["bash", "read", "edit", "write"]),
  );
  const own = policy(messages, handle, undefined, {
    folder: "/work",
    ownTools: true,
  });
  expect(own.tools.map((t) => t.name)).toEqual(["question"]);
  expect(own.folder).toBe("/work");
  const other = policy(messages, handle, undefined, { ownTools: false });
  expect(other.tools.map((t) => t.name)).toEqual([...coding, "question"]);
  expect(other.folder).toBeUndefined();
});
