// Findings for tests that are not about looking for the agent programs, so none is started.
import { AGENT_PROGRAMS, type Finding } from "../../src/agent-programs.ts";

/** Every program in the list found, or only those named. */
export const found = async (
  ids: ReadonlyArray<string> = AGENT_PROGRAMS.map((program) => program.id),
): Promise<ReadonlyArray<Finding>> =>
  AGENT_PROGRAMS.map((program) => ({
    program,
    ...(ids.includes(program.id)
      ? { found: { path: `/test/bin/${program.id}`, how: "found on the PATH" } }
      : {}),
    lines: [],
    strangers: [],
  }));
