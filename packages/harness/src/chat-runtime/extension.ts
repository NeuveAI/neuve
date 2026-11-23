import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  CompactionTask,
  GenerationTask,
  InboxDoc,
  LiveDoc,
  ToolTask,
  defineExtension,
  defineTool,
  hook,
  type Harness,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { ApprovalStore, ChatRuntimeBridge } from "./bridge.ts";
import { RUNTIME_WORK_TOOL } from "./transcript.ts";
import { newest, pointer } from "./transcript.ts";

export const RECOVERY_ALLOW_TOOLS: readonly string[] = [
  "question",
  "read",
  "ls",
  "grep",
  "find",
];
export const STOP_ENTRY_KIND = "ace.stopped";
export const QUESTIONS_DOC_KIND = "ace.questions";
export const EDIT_ENTRY_KIND = "ace.edit";
export function chatRuntimeExtension(
  bridge: ChatRuntimeBridge,
  owns: (provider: string) => boolean,
  approvals?: (harness: Harness) => ApprovalStore,
) {
  let attached: Harness | undefined;
  let redispatched = Promise.resolve({
    conversations: new Set<ConversationId>(),
    submissions: new Set<string>(),
    tasks: new Set<string>(),
    released: new Set<ConversationId>(),
    answerBlocked: new Set<ConversationId>(),
  });
  const extension = defineExtension({
    name: "neuve-chat-runtime",
    tools: [
      /**
       * Work a runtime with tools of its own already did, recorded in the transcript as a call
       * that already ran so Ace shows it as any other: it runs nothing, and returns the outcome
       * the runtime reported. A call the bridge did not record (a model calling it) is refused.
       */
      defineTool({
        name: RUNTIME_WORK_TOOL,
        description:
          "Records work the account's own program already did. Never call it: it runs nothing.",
        parameters: Type.Object({
          kind: Type.String(),
          input: Type.Unknown(),
          errored: Type.Boolean(),
        }),
        replay: "safe",
        execute: async (_args, api) => {
          const ran = bridge.ran(api.callId);
          return ran === undefined
            ? {
                content: [
                  {
                    type: "text" as const,
                    text: "This records work the account's own program did; it runs nothing.",
                  },
                ],
                isError: true,
              }
            : {
                content: [
                  { type: "text" as const, text: ran.output ?? "(no output)" },
                ],
                isError: ran.errored,
              };
        },
      }),
    ],
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(request, api, context) {
          const agent = await api.snapshot(
            AgentDoc,
            api.conversationId,
            context,
          );
          if (!attached || !agent?.model || !owns(agent.model.provider)) return;
          const recovered = (await redispatched).conversations.has(
            api.conversationId,
          );
          bridge.identify(
            request.messages,
            api.conversationId,
            api.taskId,
            recovered,
            agent.cwd,
          );
          const conversation = await attached.conversation(
            api.conversationId,
            context,
          );
          const view = await conversation?.context(context);
          if (!view) return;
          // pi excludes errors and aborts from model context. Restore only the newest native pointer.
          const edits = new Map(
            view.entries
              .flatMap((entry) => entry.edits ?? [])
              .map((edit) => [edit.target, edit]),
          );
          const raw = view.entries.flatMap((entry) => {
            const edit = edits.get(entry.id);
            return edit?.action === "omit"
              ? []
              : edit?.action === "replace"
                ? [...edit.messages]
                : [...(entry.model ?? [])];
          });
          const latest = newest(raw);
          const message = latest.message;
          if (
            !message ||
            message.role !== "assistant" ||
            !pointer(message) ||
            (message.stopReason !== "error" && message.stopReason !== "aborted")
          )
            return;
          if (
            request.messages.some(
              (item) =>
                item.role === "assistant" &&
                item.responseId === message.responseId,
            )
          )
            return;
          const following = raw.slice(latest.index + 1);
          const at = request.messages.findIndex((item) =>
            following.some(
              (next) => JSON.stringify(item) === JSON.stringify(next),
            ),
          );
          const messages = [...request.messages];
          messages.splice(at < 0 ? messages.length : at, 0, message);
          bridge.identify(
            messages,
            api.conversationId,
            api.taskId,
            recovered,
            agent.cwd,
          );
          return { messages };
        },
      }),
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          if (!attached || RECOVERY_ALLOW_TOOLS.includes(call.name)) return;
          const agent = await api.snapshot(
            AgentDoc,
            api.conversationId,
            context,
          );
          if (!agent?.model || !owns(agent.model.provider)) return;
          const gate = await redispatched;
          if (
            gate.tasks.has(String(api.taskId)) &&
            gate.conversations.has(api.conversationId)
          )
            return { block: "Stopped when Neuve restarted." };
        },
        async afterTool(_call, result, api, context) {
          if (result.control?.handoff === undefined) return;
          const agent = await api.snapshot(
            AgentDoc,
            api.conversationId,
            context,
          );
          if (!agent?.model || !owns(agent.model.provider)) return;
          return {
            ...result,
            control: { terminate: true },
            isError: true,
            content: [
              {
                type: "text",
                text: "This turn could not continue. Start a new chat, or continue on another model.",
              },
            ],
          };
        },
      }),
      hook(CompactionTask, {
        async beforeCompact(_compaction, api, context) {
          const agent = await api.snapshot(
            AgentDoc,
            api.conversationId,
            context,
          );
          if (agent?.model && owns(agent.model.provider))
            return { decline: true };
          return undefined;
        },
      }),
    ],
  });
  const pending = new Set<Promise<void>>();
  const subscriptions = new Set<() => void>();
  async function attach(
    harness: Harness,
    access?: {
      onStop?: (listener: (chat: ConversationId) => Promise<void>) => void;
      onApprovalAnswer?: (send: ChatRuntimeBridge["replyToApproval"]) => void;
    },
  ) {
    if (approvals) await bridge.attachApprovals(approvals(harness));
    access?.onStop?.((chat) => bridge.stopApprovals(chat));
    access?.onApprovalAnswer?.((...args) => bridge.replyToApproval(...args));
    attached = harness;
    // inspect is queued before resume or new submissions. Successors retain the conversation gate.
    const captured = harness.inspect(BACKGROUND_CONTEXT).then(async (view) => {
      const tools = new Map<string, string>();
      const answerBlocked = new Set<ConversationId>();
      for (const id of new Set(
        view.tasks.map(({ record }) => record.conversationId),
      )) {
        const live = await harness.snapshot(LiveDoc, id, BACKGROUND_CONTEXT);
        for (const slot of live?.tools ?? []) {
          if (slot.status === "done") continue;
          if (slot.taskId !== undefined)
            tools.set(String(slot.taskId), slot.name);
          if (slot.name !== "question") answerBlocked.add(id);
        }
      }
      return { ...view, tools, answerBlocked };
    });
    redispatched = captured.then((view) => ({
      conversations: new Set([
        ...view.tasks.map(({ record }) => record.conversationId),
        ...view.submissions
          .filter((record) => record.type === "input")
          .map((record) => record.conversationId),
      ]),
      submissions: new Set(view.submissions.map((record) => String(record.id))),
      tasks: new Set(view.tasks.map(({ record }) => String(record.id))),
      released: new Set<ConversationId>(),
      answerBlocked: view.answerBlocked,
    }));
    const stop = harness.subscribeCommits(({ changes }) => {
      redispatched = redispatched.then(async (gate) => {
        const release = (id: ConversationId) => {
          gate.released.add(id);
          gate.conversations.delete(id);
        };
        for (const change of changes) {
          if (
            change.type === "conversation" &&
            change.value.owner &&
            gate.tasks.has(String(change.value.owner.taskId)) &&
            !gate.released.has(change.value.id)
          )
            gate.conversations.add(change.value.id);
        }
        for (const change of changes) {
          if (change.type !== "submission") continue;
          const record = change.value;
          if (gate.submissions.has(String(record.id))) continue;
          gate.submissions.add(String(record.id));
          if (record.type !== "input") continue;
          // Submissions have no task attribution, including invocation-bound submit.
          // Recognize every channel producer regardless of its task's store or lifetime.
          const request = record.requestId;
          const submission = await harness.submission(
            record.id,
            BACKGROUND_CONTEXT,
          );
          let current = await submission?.status(BACKGROUND_CONTEXT);
          const item =
            current?.entry === undefined
              ? (
                  await harness.snapshot(
                    InboxDoc,
                    record.conversationId,
                    BACKGROUND_CONTEXT,
                  )
                )?.items.find((item) => item.id === record.id)
              : undefined;
          // Placement can move the content from InboxDoc to an entry between these reads.
          if (current?.entry === undefined && !item)
            current = await submission?.status(BACKGROUND_CONTEXT);
          const entryId = current?.entry;
          const entry =
            entryId === undefined
              ? undefined
              : await harness.commit(
                  (tx) => tx.entry(entryId),
                  BACKGROUND_CONTEXT,
                );
          const input =
            item && item.mode !== "write"
              ? item.content
              : entry?.model?.find((message) => message.role === "user")
                  ?.content;
          const body =
            typeof input === "string"
              ? input
              : input?.find((block) => block.type === "text")?.text;
          const agentInput = body?.startsWith("agent@") && body.includes(": ");
          // Queued person inputs acquire the placing generation's byTaskId.
          // That entry attribution says nothing about the submission's origin.
          const automatic =
            input === undefined ||
            agentInput ||
            ["subagent:", "message:", "neuve.review:"].some((prefix) =>
              request?.startsWith(prefix),
            );
          if (!automatic) release(record.conversationId);
          else if (
            !gate.released.has(record.conversationId) &&
            request &&
            ((request.startsWith("subagent:") &&
              gate.tasks.has(request.slice("subagent:".length))) ||
              (request.startsWith("message:") &&
                gate.tasks.has(request.slice(request.lastIndexOf(":") + 1))))
          )
            gate.conversations.add(record.conversationId);
        }
        for (const change of changes) {
          if (
            change.type === "entry" &&
            change.value.kind === EDIT_ENTRY_KIND &&
            change.value.byTaskId === undefined &&
            !changes.some(
              (other) =>
                other.type === "submission" &&
                other.value.entry === change.value.id,
            ) &&
            change.value.data &&
            typeof change.value.data === "object" &&
            !Array.isArray(change.value.data) &&
            typeof change.value.data.author === "string" &&
            !change.value.data.author.startsWith("agent@")
          )
            release(change.value.conversationId);
          // A document has no writer attribution. Restrict this fallback to recovery
          // without potentially writing tools, and reject agent-authored answers.
          if (
            change.type === "document" &&
            change.record.kind === QUESTIONS_DOC_KIND &&
            change.conversationId !== undefined &&
            !gate.answerBlocked.has(change.conversationId) &&
            change.ops.some(
              (op) =>
                op[0] === "s" &&
                op[1].length === 3 &&
                op[1][0] === "questions" &&
                op[1][2] === "answer" &&
                op[2] !== null &&
                typeof op[2] === "object" &&
                !Array.isArray(op[2]) &&
                "author" in op[2] &&
                typeof op[2].author === "string" &&
                !op[2].author.startsWith("agent@"),
            )
          )
            release(change.conversationId);
        }
        // Change order within a commit is unspecified. Close ownership transitively after
        // processing person actions, so a new person's run never inherits an old gate.
        let added: boolean;
        do {
          added = false;
          for (const change of changes) {
            if (change.type !== "task") continue;
            const task = change.value;
            if (
              !gate.tasks.has(String(task.id)) &&
              (gate.conversations.has(task.conversationId) ||
                (task.owner !== undefined &&
                  gate.tasks.has(String(task.owner))))
            ) {
              gate.tasks.add(String(task.id));
              added = true;
            }
          }
        } while (added);
        return gate;
      });
      const conversations = new Set<ConversationId>();
      const resets = new Set<ConversationId>();
      const stopped = new Set<ConversationId>();
      for (const change of changes) {
        if (change.type === "entry" && change.value.kind === "pi.reset")
          resets.add(change.value.conversationId);
        if (change.type === "entry" && change.value.kind === STOP_ENTRY_KIND)
          stopped.add(change.value.conversationId);
        if (
          change.type === "entry" &&
          (change.value.kind === STOP_ENTRY_KIND ||
            change.value.kind === "pi.reset")
        )
          conversations.add(change.value.conversationId);
        if (
          change.type === "task" &&
          change.value.kind === "pi.tool" &&
          change.value.state.status === "terminal"
        ) {
          const outcome = change.value.state.outcome;
          if (
            outcome.status === "completed" &&
            outcome.result &&
            typeof outcome.result === "object" &&
            !Array.isArray(outcome.result) &&
            "control" in outcome.result
          ) {
            const control = outcome.result.control;
            if (
              control &&
              typeof control === "object" &&
              !Array.isArray(control) &&
              (control.terminate === true || control.handoff !== undefined)
            )
              conversations.add(change.value.conversationId);
          }
        }
      }
      for (const id of conversations) {
        const closing = bridge.closeConversation(
          String(id),
          resets.has(id),
          stopped.has(id),
        );
        pending.add(closing);
        void closing.catch(() => {}).finally(() => pending.delete(closing));
      }
    });
    subscriptions.add(stop);
    // Channel.open awaits attach before resume. Commit every abort mark while scheduling
    // is paused, so saved execute intents select ToolTask.abort instead of ToolTask.execute.
    const view = await captured;
    for (const { record } of view.tasks) {
      if (
        record.kind !== ToolTask.definition.name ||
        RECOVERY_ALLOW_TOOLS.includes(view.tools.get(String(record.id)) ?? "")
      )
        continue;
      const agent = await harness.snapshot(
        AgentDoc,
        record.conversationId,
        BACKGROUND_CONTEXT,
      );
      if (
        agent?.model &&
        owns(agent.model.provider) &&
        (await redispatched).conversations.has(record.conversationId)
      )
        await harness.abortTask(record.id, BACKGROUND_CONTEXT);
    }
  }
  return {
    extensions: [extension],
    attach,
    close: async () => {
      for (const stop of subscriptions) stop();
      subscriptions.clear();
      await redispatched;
      await Promise.all([...pending]);
    },
  };
}
