import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { storeLocationIn } from "@neuve/records-core";
import { sharedWorkSocket } from "@neuve/records-core/shared-work-socket";
import { turnRecoveryStore } from "../../src/chat-runtime/recovery-store.ts";

const directory = process.env.NEUVE_RETRY_STORE!;
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const driver = await turnRecoveryStore(storeLocationIn(directory), {
  namespace: "channel",
  wake: async () => {},
  log: (event, fields) => send({ event, ...fields }),
  transport: sharedWorkSocket({ directory: process.env.NEUVE_RETRY_HOST! }),
});
send({ event: "ready" });
const release = Promise.withResolvers<void>();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line === "release") release.resolve();
});
const state = (await driver.driver.latest(process.env.NEUVE_RETRY_CHAT!))!;
const controller = new AbortController();
try {
  const result = await driver.driver.execute(
    state,
    controller.signal,
    async (signal, schedule) => {
      const started = await driver.driver.wait(schedule, signal);
      appendFileSync(`${directory}/effects`, "effect\n");
      send({ event: "native-effect" });
      await release.promise;
      return {
        state: await driver.driver.settle({
          turn: state.value.turn,
          expected: started.event,
          state: "recovered",
        }),
      };
    },
  );
  send({
    event: "result",
    state: result.state.value.state,
    reason: result.state.value.reason,
  });
} finally {
  input.close();
  await driver.close();
}
