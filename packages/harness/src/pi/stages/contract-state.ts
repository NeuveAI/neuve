import { copyJson, type Context } from "@earendil-works/chord";
import type { TaskId, Tx, DocumentReader } from "@earendil-works/pi-durable";
import { readData } from "@neuve/records-core";
import { preserveUnknown } from "@neuve/records-schema";
import { transcriptFacts } from "./agent.ts";
import { ContractContextDoc } from "./docs.ts";
import { ContractState, contractUsage } from "./contract-schema.ts";

export { ContractState, contractUsage } from "./contract-schema.ts";

export class ContractWriteRefused extends Error {
  constructor(cause: unknown) {
    super(
      "This update cannot preserve newer fields; leave it to a newer build",
      {
        cause,
      },
    );
  }
}

/** Main's helper has no typed refusal. Validate outside its catch so ordinary errors still fail. */
export function preserveContractState(stored: unknown, next: ContractState) {
  readData(ContractState, stored, { source: "neuve.contract-context" });
  ContractState.parse(next);
  try {
    return preserveUnknown(ContractState, stored, next, {
      source: "neuve.contract-context",
      arrayKeys: { rounds: ["id"] },
    });
  } catch (cause) {
    throw new ContractWriteRefused(cause);
  }
}

/** The task adapter keeps all document mutations on pi's existing commit line. */
export interface ContractStore {
  readonly refusal: ContractWriteRefused | undefined;
  readonly read: () => Promise<ContractState>;
  readonly subscribe: (listener: (state: ContractState) => void) => () => void;
  readonly update: (
    change: (state: ContractState, tx: Tx) => void | Promise<void>,
  ) => Promise<void>;
}
export const contractStore = (
  port: {
    readonly taskId: TaskId;
    readonly snapshot: DocumentReader["snapshot"];
    readonly commit: (
      change: (tx: Tx) => Promise<undefined>,
      context: Context,
    ) => Promise<void>;
  },
  context: Context,
): ContractStore => {
  const listeners = new Set<(state: ContractState) => void>();
  let refused: ContractWriteRefused | undefined;
  return {
    get refusal() {
      return refused;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: async () =>
      readData(
        ContractState,
        (await port.snapshot(ContractContextDoc, port.taskId, context))?.data,
        { source: "neuve.contract-context" },
      ),
    update: async (change) => {
      if (refused !== undefined) throw refused;
      let committed: ContractState | undefined;
      await port.commit(async (tx) => {
        if (refused !== undefined) throw refused;
        const doc = await tx.doc(ContractContextDoc, port.taskId);
        const state = readData(ContractState, doc.data, {
          source: "neuve.contract-context",
        });
        await change(state, tx);
        try {
          doc.data = copyJson(preserveContractState(copyJson(doc.data), state));
        } catch (error) {
          if (error instanceof ContractWriteRefused) refused = error;
          throw error;
        }
        committed = state;
        return undefined;
      }, context);
      // Publish only after SQLite has committed. Waiters share this parsed snapshot.
      if (committed !== undefined)
        for (const listener of listeners) listener(committed);
    },
  };
};

export const contractFacts = (state: ContractState) =>
  transcriptFacts({
    engine: "contract",
    messages: state.events.filter((e) => e.type === "message.finished"),
    usage: contractUsage(state),
    eligibleCalls: new Set(
      Object.entries(state.calls)
        .filter(([, call]) => call.eligible)
        .map(([id]) => id),
    ),
  });
