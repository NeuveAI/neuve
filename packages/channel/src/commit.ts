import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { git, quote } from "./git";
import { LanesDoc } from "./lanes";

function refusal(text: string): ToolExecutionResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function commitTool(project: string) {
  return defineExtension({
    name: "neuve-commit",
    tools: [
      defineTool({
        name: "neuve_commit",
        description:
          "Commit all changes in this chat's work lane with the given message. Use this when asked to commit and your sandbox cannot write Git's shared folder.",
        parameters: Type.Object(
          {
            message: Type.String({ pattern: "^[^\\u0000]+$" }),
          },
          { additionalProperties: false },
        ),
        replay: "unsafe",
        executionMode: "sequential",
        async execute({ message }, api, context) {
          const { cwd } = await api.agent(context);
          const state = await api.snapshot(LanesDoc, context);
          if (
            !cwd ||
            cwd === project ||
            !Object.values(state?.lanes ?? {}).some(
              (lane) => lane.path === cwd && lane.chat === api.conversationId,
            )
          ) {
            return refusal("This chat is outside its recorded work lane.");
          }
          const { env } = api;
          if (!env) return refusal("This turn has no writable environment.");

          const run = (args: string) => git(env, args, context, { cwd });
          try {
            // Git can discover the project checkout above a lane that has lost its Git metadata.
            if ((await run("rev-parse --show-prefix")).trim()) {
              return refusal("This chat is outside its recorded work lane.");
            }
            await run("add -A");
            if (
              !(await run(
                "diff --cached --name-only --ignore-submodules=none --",
              ))
            ) {
              return refusal("There is nothing to commit.");
            }
            await run(`commit -m ${quote(message)}`);
            const [hash, subject] = (await run("log -1 --format=%h%x00%s HEAD"))
              .replace(/\n$/, "")
              .split("\0");
            const branch = (await run("branch --show-current")).trim();
            return {
              content: [
                {
                  type: "text",
                  text: `Committed ${hash} on ${branch || "detached HEAD"}\n${subject}`,
                },
              ],
            };
          } catch (error) {
            context.abortSignal?.throwIfAborted();
            return refusal(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      }),
    ],
  });
}
