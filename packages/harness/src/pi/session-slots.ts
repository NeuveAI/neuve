import { canonicalJson, sha256Hex } from "@neuve/records-core";
import type { ContinuationIdentity } from "@neuve/runtime";
import { Effect, Semaphore } from "effect";
import { acquireGrant } from "../budget/acquire.ts";
import type { Budget } from "../budget/scheduler.ts";

export const continuationAccountKey = (identity: ContinuationIdentity) =>
  sha256Hex(canonicalJson(identity));

/** One semaphore per run, shared by its contract contexts and finder children. */
export function contractSessionSlots(
  budget: Budget,
  limit: number,
  owner: string,
) {
  const local = Semaphore.makeUnsafe(limit);
  return {
    acquire: (identity: ContinuationIdentity) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.interruptible(local.take(1)),
          (permits) => local.release(permits),
        );
        return yield* Effect.acquireRelease(
          Effect.interruptible(
            acquireGrant(budget, {
              owner,
              priority: {
                class: "interactive",
                position: "continuation",
                stage: 0,
              },
              resource: {
                kind: "provider",
                account: continuationAccountKey(identity),
              },
            }),
          ),
          (grant) =>
            Effect.promise(async () => {
              await grant.release();
            }),
        );
      }),
  };
}
export type ContractSessionSlots = ReturnType<typeof contractSessionSlots>;
