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
// only get tools that preserve its access limits. The plan writer uses a host-chosen file and
// the answer tool writes to a comment thread in the chat's session state.
// The runtime must hear which tools were withheld because its prompt still describes them.
test("an unattended runtime with its own sandbox is served only the tools that cannot widen it, and told which are withheld", () => {
  const offered = conversation(["plan_write", "plan_comment_answer", ...ace]);
  const own = policy(offered, handle, undefined, {
    folder: "/work",
    ownTools: true,
  });
  expect(own.approvalPolicy).toBe("allow");
  expect(own.tools.map((t) => t.name)).toEqual([
    "question",
    "plan_write",
    "plan_comment_answer",
  ]);
  const attended = policy(offered, handle, undefined, {
    ownTools: true,
    approvals: true,
    attended: true,
  });
  expect(attended.approvalPolicy).toBe("ask");
  expect(attended.tools.map((t) => t.name)).toEqual(
    own.tools.map((t) => t.name),
  );
  expect(attended.systemPrompt).toBe(own.systemPrompt);
  expect(
    policy(offered, handle, undefined, { ownTools: true, attended: true })
      .approvalPolicy,
  ).toBe("allow");
  expect(own.systemPrompt).toStartWith("prompt\n\n");
  for (const name of ace) expect(own.systemPrompt).toContain(name);
  expect(own.systemPrompt).not.toContain("bash");
  const other = policy(offered, handle, undefined, {
    ownTools: false,
    approvals: true,
    attended: true,
  });
  expect(other.approvalPolicy).toBe("allow");
  expect(other.tools.map((t) => t.name)).toEqual([
    ...coding,
    "question",
    "plan_write",
    "plan_comment_answer",
    ...ace,
  ]);
  expect(other.systemPrompt).toBe("prompt");
});

// A runtime may silently lose a channel tool even though Pi registered the checked handler.
test("channel agent tools reach runtimes with or without their own tools", () => {
  const buildTools = ["agent_start", "agent_message", "set_agent_model"];
  const offered = conversation([...buildTools, "lane"]);
  const own = policy(offered, handle, undefined, { ownTools: true });
  expect(own.tools.map((tool) => tool.name)).toEqual([
    "question",
    ...buildTools,
  ]);
  expect(own.systemPrompt).toContain("Neuve withholds them: lane.");
  const other = policy(offered, handle, undefined, { ownTools: false });
  expect(other.tools.map((tool) => tool.name)).toEqual([
    ...coding,
    "question",
    ...buildTools,
    "lane",
  ]);
});

// A read-only runtime can see the writer and still assume saving requires its own file tools.
test("a read-only planning session is served the plan writer and told how to save", () => {
  const planning = {
    role: "system" as const,
    content: "",
    timestamp: 1,
    toolsRemoved: [...coding, RUNTIME_WORK_TOOL].map((name) => ({ name })),
  };
  Object.defineProperty(planning, Symbol.for("neuve.chat.plan-request"), {
    value: true,
  });
  const session = policy(
    [...conversation(["plan_write", "explore"]), planning],
    handle,
    undefined,
    { folder: "/work", ownTools: true, approvals: true, attended: true },
  );
  expect(session.approvalPolicy).toBe("allow");
  expect(session.tools.map((tool) => tool.name)).toEqual([
    "question",
    "plan_write",
  ]);
  expect(session.systemPrompt).toContain(
    "outside your sandbox, so Neuve withholds them: explore.",
  );
  expect(session.systemPrompt).toContain(
    "Save the plan with Neuve's MCP tool `plan_write`. It works in a read-only workspace.",
  );
  expect(session.systemPrompt).not.toContain("with your own tools instead");
});
