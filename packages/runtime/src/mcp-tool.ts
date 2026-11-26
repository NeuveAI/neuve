import type { ToolDefinition } from "./contract.ts";
/**
 * A tool definition as an MCP tool, the form both runtimes that serve Neuve's tools to an agent
 * program list them in; each adds what its program needs on top.
 */
export const mcpTool = (definition: ToolDefinition) => ({
  name: definition.name,
  description: definition.description,
  inputSchema: definition.inputSchema,
  annotations: {
    readOnlyHint: definition.hints.readOnly,
    destructiveHint: definition.hints.destructive,
    idempotentHint: definition.hints.idempotent,
    openWorldHint: definition.hints.openWorld,
  },
});

export function unknownTool(
  name: string,
  tools: ReadonlyArray<{ name: string }>,
) {
  const served = tools.map((tool) => tool.name).join(", ");
  return {
    content: [
      {
        type: "text" as const,
        text: `Neuve has no tool ${JSON.stringify(name)}. This chat's tools are: ${served}.`,
      },
    ],
    isError: true,
  };
}

export const TOOL_USE_ID_INPUT = "__neuve_tool_use_id";
export function declaresToolUseId(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  if (Array.isArray(schema)) return schema.some(declaresToolUseId);
  return Object.entries(schema).some(
    ([key, value]) =>
      (key === "properties" &&
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, TOOL_USE_ID_INPUT)) ||
      (key === "required" &&
        Array.isArray(value) &&
        value.includes(TOOL_USE_ID_INPUT)) ||
      declaresToolUseId(value),
  );
}
