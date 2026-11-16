import fs from "node:fs";
import { basename, dirname } from "node:path";
import { mock } from "bun:test";

const home = process.argv[2];
const mode = process.argv[3];
const schedule = process.argv[4];
const name = process.argv[5] ?? "other";
if (home === undefined || (mode !== "adder" && mode !== "sweeper"))
  throw new Error("scratch home and adder/sweeper mode required");

// Only pause real filesystem calls in this child. Stdin fixes their order
// across processes without changing their arguments or results.
function barrier(event: string) {
  console.log(event);
  if (fs.readSync(0, new Uint8Array(1), 0, 1, null) !== 1)
    throw new Error("parent closed the barrier without releasing it");
}
const rename = fs.renameSync;
const write = fs.writeFileSync;
const remove = fs.rmSync;
const open = fs.openSync;
const close = fs.closeSync;
let attempts = 0;
let taken = false;
let held: number | undefined;
mock.module("node:fs", () => ({
  ...fs,
  writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (
      mode === "adder" &&
      schedule === "writing" &&
      String(args[0]).endsWith(".adding.json")
    )
      barrier(`writing:${++attempts}`);
    return write(...args);
  },
  renameSync: (source: fs.PathLike, destination: fs.PathLike) => {
    if (mode === "adder" && String(destination).endsWith("/records/work")) {
      if (schedule !== "writing") barrier(`publishing:${++attempts}`);
      const result = rename(source, destination);
      barrier("published");
      return result;
    }
    if (
      mode === "sweeper" &&
      !taken &&
      basename(String(destination)).startsWith(".swept-") &&
      fs.statSync(source).isDirectory()
    ) {
      taken = true;
      if (schedule === "publisher-wins") barrier("taking");
      const result = rename(source, destination);
      if (schedule === "held") {
        held = open(destination, "r");
        barrier("taken");
      }
      return result;
    }
    return rename(source, destination);
  },
  rmSync: (path: fs.PathLike, options?: fs.RmOptions) => {
    if (
      mode === "sweeper" &&
      options?.recursive &&
      basename(dirname(String(path))) === "records" &&
      fs.existsSync(path)
    ) {
      if (!basename(String(path)).startsWith(".swept-"))
        throw new Error("sweep traversed a claim still owned by a publisher");
      console.log("deleting-tombstone");
    }
    return remove(path, options);
  },
}));

const { Effect } = await import("effect");
const { AccountStore } = await import("./fixtures.ts");
try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AccountStore.make(home);
        const result = yield* store
          .add("claude", mode === "adder" ? "work" : name)
          .pipe(Effect.result);
        console.log(
          JSON.stringify(
            result._tag === "Success"
              ? { _tag: "Success", success: result.success }
              : {
                  _tag: "Failure",
                  failure: {
                    _tag: result.failure._tag,
                    message: result.failure.message,
                  },
                },
          ),
        );
      }),
    ),
  );
} finally {
  if (held !== undefined) close(held);
}
