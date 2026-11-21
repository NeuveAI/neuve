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
