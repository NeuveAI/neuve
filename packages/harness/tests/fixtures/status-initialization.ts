import { expect, test } from "bun:test";
import { unreadableFirstSnapshot } from "./readiness-recovery.ts";

// Why: exercise the real lazy process service, before any snapshot has been read successfully.
test("an unreadable initial status holds rather than failing admission", async () => {
  expect(await unreadableFirstSnapshot()).toEqual({
    ready: false,
    held: [
      {
        provider: "claude",
        credential:
          "Account claude couldn't be checked; run `neuve auth status claude --check`",
      },
    ],
    probes: 0,
    opens: 0,
  });
});
