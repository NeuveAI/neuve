import {
  SCOPE_CHANGE_VERSION,
  ScopeChangeSubmission,
  scopeChangeSystem,
  scopeChangeTask,
  type ChangeToJudge,
} from "../../freshness.ts";
import { DATA_NOTE, READER_PROSE } from "../../lookups.ts";
import { dataBlock } from "../../data-block.ts";
import {
  ScopeChangeStored,
  contextNote,
  type RunContext,
} from "../../pipeline.ts";
import type { AgentStep } from "./agent.ts";

export const scopeChangeStep = (
  ctx: RunContext["Service"],
  change: ChangeToJudge,
) => {
  const step: AgentStep<ScopeChangeSubmission, ScopeChangeStored> = {
    spec: {
      stage: "frame",
      agent: `frame.scope-change.${change.source}`,
      turnLimit: 2,
      system: scopeChangeSystem(DATA_NOTE, READER_PROSE),
      task: scopeChangeTask(change, dataBlock),
      tools: [],
      submit: {
        description:
          "Submit whether the ticket's change bears on the code change. Ends the call.",
        schema: ScopeChangeSubmission,
        name: "submit_scope_change",
      },
      backstop: () => ({ matters: true, reason: "-" }),
    },
    op: "harness.scope-change",
    opVersion: SCOPE_CHANGE_VERSION,
    inputs: { from: `sha256:${change.fromSha}`, to: `sha256:${change.toSha}` },
    compose: (result) => ({
      judgement:
        result.status === "backstop" || result.output === undefined
          ? null
          : result.output,
    }),
    schema: ScopeChangeStored,
    note: (stored, context) =>
      `ticket change from line ${change.region.line}: ${stored.judgement === null ? "no judgement; kept as a change" : stored.judgement.matters ? "matters" : "does not matter"}; ${contextNote(context)}`,
  };
  return step;
};
