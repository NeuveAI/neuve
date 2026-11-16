import { appendFileSync, existsSync } from "node:fs";
import { Effect } from "effect";
import { CodeWork, codeCheckpoint } from "../../src/code-work.ts";
const [directory, started, finish] = Bun.argv.slice(2);
if (!directory || !started || !finish)
  throw new Error("Missing fixture arguments");
appendFileSync(started, `${process.pid}\n`);
await Effect.runPromise(
  Effect.gen(function* () {
    while (!existsSync(finish)) {
      yield* codeCheckpoint;
      yield* Effect.sleep(5);
    }
  }).pipe(Effect.provideService(CodeWork, { directory, background: true })),
);
