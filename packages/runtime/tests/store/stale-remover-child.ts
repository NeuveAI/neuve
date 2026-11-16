import fs from "node:fs";
import { mock } from "bun:test";

// Intercept only in this child. The parent replaces the generation while stdin
// holds the exact filesystem call that used to mutate a shared name.
const home = process.argv[2];
const operation = process.argv[3];
if (home === undefined || (operation !== "drop" && operation !== "state"))
  throw new Error("scratch home and drop/state operation required");
const unlink = fs.unlinkSync;
const rename = fs.renameSync;
let armed = false;
function barrier(path: fs.PathLike, phase: "drop" | "state") {
  if (
    armed &&
    operation === phase &&
    String(path).includes("/records/work/") &&
    String(path).endsWith(phase === "drop" ? ".removing.json" : ".active.json")
  ) {
    armed = false;
    console.log("paused");
    if (fs.readSync(0, new Uint8Array(1), 0, 1, null) !== 1)
      throw new Error("parent closed the barrier without releasing it");
  }
}
mock.module("node:fs", () => ({
  ...fs,
  unlinkSync: (path: fs.PathLike) => {
    barrier(path, "drop");
    return unlink(path);
  },
  renameSync: (source: fs.PathLike, destination: fs.PathLike) => {
    barrier(source, "state");
    return rename(source, destination);
  },
}));
const { Effect } = await import("effect");
const { AccountName } = await import("../../src/index.ts");
const { AccountStore, RuntimeRegistry, provideRegistry, fakeRuntime } =
  await import("./fixtures.ts");
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* AccountStore.make(home);
      armed = true;
      yield* Effect.gen(function* () {
        yield* store.remove(AccountName.parse("work"), yield* RuntimeRegistry);
        if (armed)
          throw new Error("removal did not reach the expected filesystem call");
        console.log("removed");
      }).pipe(
        Effect.provide(provideRegistry(store, [fakeRuntime({ calls: [] })])),
      );
    }),
  ),
);
