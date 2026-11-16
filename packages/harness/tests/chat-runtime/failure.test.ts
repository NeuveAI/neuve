import { expect, test } from "bun:test";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { failureStream, terminalText } from "../../src/chat-runtime/failure.ts";
import { account, fixture } from "./fixture.ts";

const now = Date.parse("2026-11-10T12:00:00Z");
for (const { label, resetsAt, options } of [
  {
    label: "under a day",
    resetsAt: "2026-11-11T11:59:59Z",
    options: { hour: "2-digit", minute: "2-digit" } as const,
  },
  {
    label: "exactly a day",
    resetsAt: "2026-11-11T12:00:00Z",
    options: { hour: "2-digit", minute: "2-digit", weekday: "short" } as const,
  },
  { label: "missing reset" },
]) {
  // Match the desk's local time and preserve terminal failure behavior at both pi heuristics.
  test(`usage limit with ${label} matches desk copy and never retries or compacts`, async () => {
    const text = terminalText(
      {
        _tag: "UsageLimitReached",
        account: account().name,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
      now,
    );
    expect(text).toBe(
      resetsAt === undefined
        ? "Usage limit reached for subscription."
        : `Usage limit reached for subscription. Resets at ${new Date(resetsAt).toLocaleTimeString(undefined, options)}.`,
    );
    const run = await fixture();
    try {
      const model = run.models.getModel("subscription", "sonnet")!;
      const message = await failureStream(model, text).result();
      expect(message.errorMessage).toBe(text);
      expect(message.stopReason).toBe("error");
      expect(isRetryableAssistantError(message)).toBe(false);
      expect(isContextOverflow(message)).toBe(false);
      expect(run.fake.opened).toEqual([]);
    } finally {
      await run.close();
    }
  });
}
