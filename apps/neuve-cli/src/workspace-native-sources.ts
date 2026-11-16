import type { NativeSources } from "@ace/host/native-source-lifecycle";
import { dirname } from "node:path";
import {
  SourceOwnership,
  privateInspectionDirectory,
} from "@neuve/harness/coding";
import { prepareNativeSourceImport } from "@neuve/harness/native-source-authority";
import type { ValidatedStorage } from "../../../scripts/pi-storage.ts";

/** Only the host's trusted pre-creation path may enroll an imported native source. */
export function workspaceNativeSources(
  storage: Pick<ValidatedStorage, "paths">,
): NativeSources {
  return {
    async prepare(input) {
      const owner = SourceOwnership.acquire(input.stateDirectory);
      try {
        const authority = await prepareNativeSourceImport({
          ownership: owner,
          runId: input.channel,
          source: input.stateDirectory,
          directory: privateInspectionDirectory(
            input.stateDirectory,
            dirname(storage.paths.state),
          ),
          excludedRoots: [
            storage.paths.state,
            storage.paths.captures,
            storage.paths.tmp,
          ],
          nativeDatabase: input.nativeDatabase,
          origin: input.origin,
        });
        let closed = false;
        return {
          close() {
            if (closed) return;
            authority.close();
            owner.release();
            closed = true;
          },
        };
      } catch (error) {
        try {
          owner.release();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Native source enrollment and ownership cleanup failed",
          );
        }
        throw error;
      }
    },
  };
}
