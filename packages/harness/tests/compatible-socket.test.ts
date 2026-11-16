// A shared-work host and its caller can run different builds, so additive message keys cannot deny ownership reads.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { hostBudget } from "../src/budget/local.ts";

test("a budget host accepts a directly written newer shared-work message", async () => {
  const directory = mkdtempSync("/tmp/neu130-host-");
  const host = await hostBudget({
    directory,
    threads: 2,
    efficiency: 1,
    fixed: 2,
  });
  if (!host) throw new Error("scratch budget host was already claimed");
  const socket = createConnection(`${directory}/budget.sock`);
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("data", (bytes) => resolve(bytes.toString()));
      socket.once("connect", () =>
        socket.write(
          JSON.stringify({
            version: 1,
            kind: "ownership",
            store: "a".repeat(64),
            key: "b".repeat(64),
            future: true,
          }) + "\n",
        ),
      );
    });
    expect(JSON.parse(reply)).toEqual({ kind: "ownership", live: false });
  } finally {
    socket.destroy();
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
