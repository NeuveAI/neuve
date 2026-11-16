// Keys are unique across kinds, so every capture namespace must refuse other event kinds at append.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { Log, mintUlid } from "../src/index.ts";
import {
  commitEvent,
  freshLocation,
  runOn,
  removeTemporaryDirectories,
} from "./support.ts";
afterAll(removeTemporaryDirectories);
for (const kind of ["filed", "sealed", "marked"] as const)
  test(`Log.append reserves capture.${kind} keys across event kinds`, async () => {
    await runOn(
      freshLocation(),
      Effect.gen(function* () {
        const event = {
          ...commitEvent("a".repeat(40)),
          idempotencyKey: `capture.${kind}:synthetic`,
        };
        const first = yield* Log.append([event]).pipe(Effect.result);
        expect(first).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "InvalidEvent",
            message:
              "capture idempotency namespaces require the matching capture event kind",
          },
        });
        expect(yield* Log.history({})).toHaveLength(0);
        const ordinary = {
          ...event,
          id: mintUlid(),
          idempotencyKey: "ordinary-key",
        };
        expect((yield* Log.append([ordinary]))[0]?.status).toBe("appended");
      }),
    );
  });
