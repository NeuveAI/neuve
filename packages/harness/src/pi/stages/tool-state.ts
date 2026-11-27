import type { readingBudget } from "../../readings/tool-budget.ts";
import type { HandleRegistry } from "../../lookups.ts";
import type { ToolStateHolder } from "./agent.ts";

/**
 * The tool state of a context: its handle registry and, where it has them, its reading budget and head
 * reads. A prepared context starts from its initial state on its first call.
 */
export const toolState = (parts: {
  readonly handles: HandleRegistry;
  readonly reading?: Pick<ReturnType<typeof readingBudget>, "save" | "restore">;
}): ToolStateHolder => {
  const save = () => ({
    handles: parts.handles.toJSON(),
    ...(parts.reading === undefined ? {} : { reading: parts.reading.save() }),
  });
  const initial = save();
  return {
    save,
    load: (state, turn) => {
      const from = state ?? initial;
      parts.handles.restore(from.handles ?? initial.handles);
      parts.handles.turn = turn;
      parts.reading?.restore(from.reading ?? initial.reading ?? { used: 0 });
    },
  };
};
