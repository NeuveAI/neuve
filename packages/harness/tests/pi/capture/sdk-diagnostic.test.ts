import { expect, test } from "bun:test";
import { inspect } from "node:util";
import {
  credentialSources,
  CredentialSourceUnavailable,
} from "../../../src/pi/capture/safety.ts";
import { JournalLine } from "../../../src/pi/capture/types.ts";
import {
  sdkFailure,
  sdkFrameType,
} from "../../../src/pi/capture/sdk-diagnostic.ts";

for (const dataType of [
  "response.output_text.delta",
  "synthetic-private-value",
]) {
  test(`credential refusal identifies the call and bounds frame labels: ${dataType === "response.output_text.delta" ? "known" : "unknown"}`, async () => {
    const scope = { runId: "synthetic-private-run" };
    const request = (
      callId: string,
      credentialCoverage: "none" | "required",
    ) => ({
      type: "model.request",
      scope,
      callId,
      credentialCoverage,
      route: "synthetic",
      provider: "openai",
      model: "synthetic",
      api: "openai-responses",
      headerNames: [],
      body: { status: "sent", json: {} },
    });
    const events = [
      request("synthetic-private-first", "none"),
      request("synthetic-private-second", "required"),
      {
        type: "model.response",
        scope,
        callId: "synthetic-private-second",
        status: 200,
      },
      {
        type: "model.event",
        scope,
        callId: "synthetic-private-second",
        name: "keepalive",
        data: { type: dataType, content: "synthetic-private-content" },
      },
    ];
    const lines = events.map((event, i) =>
      JournalLine.parse({ v: 1, seq: i + 1, at: i, event }),
    );
    try {
      await credentialSources(
        { conversations: [], session: [] },
        undefined,
        lines,
        [],
      );
      throw new Error("malformed frame accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialSourceUnavailable);
      expect(error).toMatchObject({
        reason: "retained-stream-prefix",
        callIndex: 2,
        diagnostic: {
          reason: "SDK keepalive framing invalid",
          frameIndex: 1,
          expectedFrameType: "keepalive",
          frameType:
            dataType === "response.output_text.delta" ? dataType : "other",
        },
      });
      expect(inspect(error)).not.toContain("synthetic-private-");
      expect(JSON.stringify(error)).not.toContain("synthetic-private-");
    }
  });
}

test("SDK diagnostic labels cannot carry arbitrary exception or provider text", () => {
  expect(sdkFailure(new Error("synthetic-private-value"))).toBe(
    "SDK replay failed",
  );
  expect(sdkFrameType("response.synthetic-private-value")).toBe("other");
});
