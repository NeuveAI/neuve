import { expect } from "bun:test";
import type {
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assistant, result, SESSION_ID } from "./frames.ts";
import { inbound, out, type Entry } from "./replay.ts";

export function diagnoseFixture(mode: string) {
  const normal = assistant(undefined, "private-fixture-response");
  normal.uuid = "00000000-0000-4000-8000-000000000019";
  normal.message.id = "private-normal-request";
  normal.message.model = "private-fixture-model";
  normal.message.usage.input_tokens = 918273;
  const final = assistant(undefined, "private-final-response");
  final.uuid = "00000000-0000-4000-8000-000000000020";
  final.message.id = "private-final-request";
  final.message.model = normal.message.model;
  const start: SDKPartialAssistantMessage = {
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000021",
    session_id: SESSION_ID,
    event: {
      type: "message_start",
      message: { ...normal.message, stop_reason: null },
    },
  };
  const privateValues = [
    SESSION_ID,
    normal.uuid,
    final.uuid,
    start.uuid,
    normal.message.id,
    final.message.id,
    normal.message.model,
    "private-fixture-response",
    "private-final-response",
    "918273",
    "Reply briefly.",
    "Return ok as true.",
    "private-probe-description",
  ];
  const stamped: SDKMessage = {
    ...normal,
    user_message_uuid: "00000000-0000-4000-8000-000000000022",
  };
  privateValues.push(stamped.user_message_uuid!);
  const badUsage: SDKMessage = JSON.parse(JSON.stringify(start));
  if (
    badUsage.type === "stream_event" &&
    badUsage.event.type === "message_start"
  ) {
    // Deliberately invalid wire input, beyond the SDK's declared shape.
    Object.assign(badUsage.event.message.usage, {
      cache_creation: "private-invalid-usage",
    });
  }
  privateValues.push("private-invalid-usage");
  const thirdStart: SDKPartialAssistantMessage = {
    ...start,
    event: {
      type: "message_start",
      message: {
        ...final.message,
        id: "private-third-request",
        stop_reason: null,
      },
    },
  };
  privateValues.push("private-third-request");
  const end = result({ uuid: "00000000-0000-4000-8000-000000000023" });
  const finalEnd = result({
    uuid: "00000000-0000-4000-8000-000000000024",
    structured_output: { ok: true },
  });
  privateValues.push(end.uuid, finalEnd.uuid);
  const retry: SDKMessage = {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 2,
    retry_delay_ms: 0,
    error_status: 500,
    error: "server_error",
    uuid: "00000000-0000-4000-8000-000000000025",
    session_id: SESSION_ID,
  };
  privateValues.push(retry.uuid);
  const badRate: SDKMessage = Object.assign(
    {
      type: "rate_limit_event",
      uuid: "00000000-0000-4000-8000-000000000026",
      session_id: SESSION_ID,
      rate_limit_info: { status: "allowed" },
    } satisfies SDKMessage,
    {
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "seven_day_oauth_apps",
      },
    },
  );
  privateValues.push(
    badRate.uuid,
    "seven_day_oauth_apps",
    "private-observer-error",
    "private-start-error",
    "private failure tag!",
    "private failure reason!",
    "private failure message!",
  );
  const startFails = [
    "startFail",
    "startTimeout",
    "startInterrupt",
    "unsafeFailure",
  ].includes(mode);
  const finalStartFails = startFails || mode === "finalStartFail";
  const skipFinal =
    mode === "retry" ||
    mode === "third" ||
    mode === "normalRetry" ||
    mode === "normalOverBudget" ||
    mode === "observerEventThrow";
  const open = () =>
    out({
      type: "query.open",
      models: [
        {
          value: "default",
          resolvedModel: normal.message.model,
          displayName: "fixture",
          description: "private-probe-description",
        },
      ],
    });
  const close = () => out({ type: "query.close" });
  const entries: Entry[] = [open(), close()];
  if (mode === "probeFail") return { entries: [], privateValues };
  if (mode === "openFail") return { entries, privateValues };
  entries.push(open(), close());
  if (!finalStartFails) entries.push(open(), close());
  entries.push(open(), close()); // schemaOnly never offers a message.
  if (mode === "freshFail") return { entries, privateValues };
  entries.push(open());
  if (!startFails) {
    entries.push(
      out({
        type: "prompt.offer",
        message: "Reply briefly.",
        check: (message) => {
          privateValues.push(message.uuid!);
        },
      }),
    );
    if (
      [
        "normalRetry",
        "normalOverBudget",
        "observerEventThrow",
        "retry",
      ].includes(mode)
    )
      entries.push(inbound(retry));
    if (mode === "normalOverBudget") entries.push(inbound(retry));
    entries.push(
      ...(mode === "rateWindow"
        ? [inbound(badRate)]
        : mode === "stamp"
          ? [inbound(stamped)]
          : mode === "usage"
            ? [inbound(badUsage)]
            : [
                inbound(start),
                inbound(normal),
                ...(mode === "third" ? [inbound(thirdStart)] : []),
                inbound(end),
              ]),
    );
  }
  const broken = ["stamp", "usage", "rateWindow", "third", "retry"].includes(
    mode,
  );
  if (broken) entries.push(close());
  if (!skipFinal && !startFails && mode !== "missingFinish") {
    entries.push(open(), close()); // resumeOnly.
    if (!["stamp", "usage", "rateWindow", "third"].includes(mode))
      entries.push(open(), close()); // resumeAtOnly needs a recorded point.
  }
  if (!broken) entries.push(close());
  if (
    !skipFinal &&
    !startFails &&
    !broken &&
    mode !== "missingFinish" &&
    mode !== "finalStartFail"
  )
    entries.push(open(), close());
  return { entries, privateValues };
}
