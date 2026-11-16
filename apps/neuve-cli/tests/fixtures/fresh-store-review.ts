import "./startup-settings.ts";

import { spyOn } from "bun:test";
import { readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { z } from "zod";
import { Starter, Worker } from "@neuve/records-core";
import * as Socket from "../../../../packages/records-core/src/worker-socket.ts";
import { runReviewCli } from "../../src/review-cli.ts";

process.once("disconnect", () => process.exit(process.exitCode ?? 0));

const [repository, range, role, detached] = z
  .tuple([
    z.string(),
    z.string(),
    z.enum(["writer", "reader"]),
    z.enum(["detach", "foreground"]),
  ])
  .parse(Bun.argv.slice(2));
const send = (event: string, detail?: string, pid?: number) =>
  process.send?.({ event, detail, pid });
const requestStarted = performance.now();
const barrier = (event: string) => {
  send(
    event,
    event === "admission" ? `${performance.now() - requestStarted}` : undefined,
  );
  const bytes = Buffer.alloc(1);
  if (readSync(0, bytes, 0, 1, null) !== 1)
    throw new Error(`closed barrier ${event}`);
};
let calls = 0;
let reading = false;
const originalExec = DatabaseSync.prototype.exec;
spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
  this: DatabaseSync,
  sql: string,
) {
  const result = originalExec.call(this, sql);
  if (reading && sql === "BEGIN") {
    reading = false;
    barrier("reading");
  }
  return result;
});
const ensure = Starter.ensureWorker;
spyOn(Starter, "ensureWorker").mockImplementation((options) =>
  Effect.gen(function* () {
    calls++;
    if (calls === 1) {
      barrier("admission");
      reading = process.env.FRESH_STORE_READ_AT_ADMISSION === "1";
    }
    if (calls === 2) {
      barrier("follow");
    }
    const result = yield* ensure({
      ...options,
      command: [process.execPath, `${import.meta.dir}/fresh-store-worker.ts`],
    });
    if (result.status === "spawned") send("spawned", undefined, result.pid);
    send(`ensured-${calls}`);
    if (result.status === "spawned" && result.ready) {
      const ready = result.ready;
      return {
        ...result,
        ready: Effect.suspend(() => {
          barrier("follow");
          return ready;
        }),
      };
    }
    return result;
  }),
);
if (Socket.acceptedCurrentWorker) {
  const accepted = Socket.acceptedCurrentWorker;
  spyOn(Socket, "acceptedCurrentWorker").mockImplementation((...args) => {
    send("acceptance-wait");
    return accepted(...args);
  });
}
const subscribe = Worker.subscribeJob;
spyOn(Worker, "subscribeJob").mockImplementation(async (...args) => {
  const subscription = await subscribe(...args);
  subscription.close();
  send("subscribed");
  throw new Error("reached subscription");
});
try {
  const code = await runReviewCli([
    range,
    "--repo",
    repository,
    "--route",
    "anthropic",
    ...(detached === "detach" ? ["--detach"] : []),
  ]);
  send("returned", String(code));
} catch (error) {
  const message = String(error);
  send(
    message.includes("reached subscription") ? "finished" : "failed",
    message,
  );
}

process.disconnect?.();
