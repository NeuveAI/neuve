import "./startup-settings.ts";

import { spyOn } from "bun:test";
import * as ChildProcess from "node:child_process";
import { Effect } from "effect";
import { Starter, Worker } from "@neuve/records-core";
import { requestRangeReview, runReviewCli } from "../../src/review-cli.ts";
if (process.env.STARTUP_NATURAL_EXIT !== "1")
  process.once("disconnect", () => process.exit(process.exitCode ?? 0));

const spawn = ChildProcess.spawn;
spyOn(ChildProcess, "spawn").mockImplementation(
  new Proxy(spawn, {
    apply(target, receiver, args) {
      const child: ReturnType<typeof spawn> = Reflect.apply(
        target,
        receiver,
        args,
      );
      process.send?.({ event: "spawned", pid: child.pid });
      return child;
    },
  }),
);

const ensure = Starter.ensureWorker;
spyOn(Starter, "ensureWorker").mockImplementation((options) =>
  Effect.gen(function* () {
    const result = yield* ensure({
      ...options,
      command: [process.execPath, `${import.meta.dir}/startup-worker.ts`],
    });
    if (
      process.env.STARTUP_OBSERVE_READY === "1" &&
      result.status === "spawned" &&
      result.ready
    ) {
      const ready = result.ready;
      return {
        ...result,
        ready: Effect.suspend(() => {
          process.send?.("awaiting-startup");
          return ready;
        }),
      };
    }
    return result;
  }),
);
const subscribe = Worker.subscribeJob;
spyOn(Worker, "subscribeJob").mockImplementation(async (...args) => {
  const subscription = await subscribe(...args);
  subscription.close();
  process.send?.("subscribed");
  throw new Error("subscription reached");
});
if (Bun.argv[4] === "--public-cli") {
  const cli = `${import.meta.dir}/../../src/cli.ts`;
  const [repository, range] = Bun.argv.slice(2);
  Bun.argv.splice(
    0,
    Bun.argv.length,
    process.execPath,
    cli,
    "review",
    range!,
    "--repo",
    repository!,
    "--route",
    "anthropic",
  );
  try {
    await import(cli);
  } finally {
    process.disconnect?.();
  }
} else
  try {
    if (Bun.argv[4] === "--admit-only") {
      await requestRangeReview(Bun.argv[2]!, Bun.argv[3]!, {
        route: "anthropic",
      });
      process.exitCode = 0;
    } else
      process.exitCode = await runReviewCli([
        Bun.argv[3]!,
        "--repo",
        Bun.argv[2]!,
        "--route",
        "anthropic",
        ...Bun.argv.slice(4),
      ]);
  } catch (error) {
    if (!String(error).includes("subscription reached")) {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 2;
    }
  } finally {
    process.disconnect?.();
  }
