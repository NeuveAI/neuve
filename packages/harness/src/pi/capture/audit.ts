import { Effect, Option } from "effect";
import type { z } from "zod";
import type { CaptureFiled } from "@neuve/records-schema";
import { Log, captureMarkBasis, type StoreLocation } from "@neuve/records-core";
import { repairMark, markFor, DETECTOR_VERSION } from "./records.ts";
import { runScanProcess } from "./process.ts";

/** Default audits observe. Explicit repairs append a new mark with the old mark as superseded. */
export const auditCapture = (input: {
  location: StoreLocation;
  event: z.infer<typeof CaptureFiled>;
  command: readonly string[];
  repair?: boolean;
}) =>
  Effect.gen(function* () {
    const rawCapture = input.event.payload.rawCapture;
    const mark = yield* markFor(rawCapture);
    if (input.repair === true && Option.isNone(yield* Log.get(input.event.id)))
      yield* Log.append([input.event]);
    const verdict = yield* runScanProcess({
      ...input,
      observe: input.repair !== true,
    });
    const basis = verdict.basis ?? "source-scan";
    const disagrees =
      mark === undefined ||
      verdict.outcome !== mark.payload.outcome ||
      verdict.reason !== mark.payload.reason ||
      verdict.record !== mark.payload.record ||
      captureMarkBasis(mark) !== basis;
    const repair =
      input.repair === true && disagrees
        ? yield* repairMark(
            {
              rawCapture,
              detectorVersion: DETECTOR_VERSION,
              outcome: verdict.outcome,
              record: verdict.record,
              ...(verdict.reason === undefined
                ? {}
                : { reason: verdict.reason }),
            },
            mark?.id,
            basis,
          )
        : { repaired: false };
    return {
      rawCapture,
      mark: mark?.payload.outcome ?? "unmarked",
      observed: verdict.outcome,
      basis,
      markBasis: mark === undefined ? "unmarked" : captureMarkBasis(mark),
      disagrees,
      ...repair,
    };
  });
