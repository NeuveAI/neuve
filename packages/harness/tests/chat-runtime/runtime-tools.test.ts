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
const ace = ["lane", "subagent", "message", "neuve_review_branch", "tab_live"];
const conversation = (names: readonly string[]) => [
  {
    role: "system" as const,
    content: "prompt",
    toolsAdded: [...coding, "question", ...names, RUNTIME_WORK_TOOL].map(
      tool,
    ) as never,
    timestamp: 0,
  },
];
const messages = conversation([]);
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
  expect(own.systemPrompt).toBe("prompt");
  expect(own.folder).toBe("/work");
  const other = policy(messages, handle, undefined, { ownTools: false });
  expect(other.tools.map((t) => t.name)).toEqual([...coding, "question"]);
  expect(other.folder).toBeUndefined();
});

// Why: Neuve runs every chat tool outside the runtime's sandbox, and the bridge hands pi every call
// to a served tool, so serving one is running it. An unattended runtime with its own sandbox must
// get tools that widen its access. A tool that writes only to the host's plan file can be served.
// The runtime must hear which tools were withheld because its prompt still describes them.
test("an unattended runtime with its own sandbox is served only the tools that cannot widen it, and told which are withheld", () => {
  const offered = conversation(["plan_write", ...ace]);
  const own = policy(offered, handle, undefined, {
    folder: "/work",
    ownTools: true,
  });
  expect(own.approvalPolicy).toBe("allow");
  expect(own.tools.map((t) => t.name)).toEqual(["question", "plan_write"]);
  expect(own.systemPrompt).toStartWith("prompt\n\n");
  for (const name of ace) expect(own.systemPrompt).toContain(name);
  expect(own.systemPrompt).not.toContain("bash");
  const other = policy(offered, handle, undefined, {
    ownTools: false,
  });
  expect(other.tools.map((t) => t.name)).toEqual([
    ...coding,
    "question",
    "plan_write",
    ...ace,
  ]);
  expect(other.systemPrompt).toBe("prompt");
});
