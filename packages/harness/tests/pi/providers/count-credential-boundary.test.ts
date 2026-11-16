import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPUS_ROUTE } from "../../../src/route.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import type { CaptureEvent } from "../../../src/pi/capture/types.ts";
import {
  credentialInspection,
  credentialRefusal,
} from "../../../src/pi/capture/safety.ts";
import { createCountTokens } from "../../../src/pi/providers/count-tokens.ts";
import { openEndpoint } from "./fixture.ts";

const VARIABLE = "NEUVE_TEST_WHOLE_COUNT_CREDENTIAL";
const KEY = "synthetic-whole-copy-key";
for (const status of [200, 401]) {
  test(`count HTTP ${status} excludes active credentials from complete persisted copies and preserves wire semantics`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "count-copy-"));
    const endpoint = openEndpoint();
    const captured: CaptureEvent[] = [];
    const journal = openCaptureJournal(
      join(directory, "journal"),
      "whole-count",
    );
    process.env[VARIABLE] = KEY;
    const detail = {
      [KEY]: "keep key's value",
      nested: JSON.stringify({ active: KEY, normal: "keep nested" }),
    };
    endpoint.respond(() =>
      Response.json(
        {
          ...(status === 200
            ? { input_tokens: 71 }
            : {
                error: { type: "authentication_error", message: "no access" },
              }),
          detail,
        },
        {
          status,
          headers: { "request-id": `prefix-${KEY}-suffix`, "x-private": KEY },
        },
      ),
    );
    const count = createCountTokens({
      credentialInspection: "ephemeral" as const,
      route: { ...OPUS_ROUTE, credentialVariable: VARIABLE },
      capture(event) {
        captured.push(event);
        journal.capture(event);
      },
      runId: "whole-count",
      baseUrl: endpoint.server.url.origin,
    });
    const request = {
      label: `label-${KEY}`,
      system: `system-${KEY}`,
      user: JSON.stringify({ original: KEY }),
      tools: [],
    };
    try {
      const result = await count(request).catch((error: unknown) => error);
      if (status === 200) expect(result).toBe(71);
      else
        expect(result).toMatchObject({
          _tag: "PreflightFailed",
          status: 401,
          retryable: false,
        });
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect(endpoint.received).toHaveLength(1);
      expect(endpoint.received[0]!.headers.get("x-api-key")).toBe(KEY);
      expect(endpoint.received[0]!.body).toMatchObject({
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      });
      const outcome = captured.find(
        (event) =>
          event.type === "artifact" && event.name.endsWith("/outcome.json"),
      );
      expect(outcome?.type).toBe("artifact");
      if (outcome?.type !== "artifact") throw new Error("outcome missing");
      expect(JSON.parse(new TextDecoder().decode(outcome.bytes))).toMatchObject(
        {
          status,
          requestId: "prefix-[REDACTED]-suffix",
          body: {
            detail: {
              "[REDACTED]": "keep key's value",
              nested: JSON.stringify({
                active: "[REDACTED]",
                normal: "keep nested",
              }),
            },
          },
        },
      );
      expect(
        captured.some(
          (event) =>
            event.type === "artifact" &&
            event.name.endsWith("/outcome.json.redactions.json"),
        ),
      ).toBe(true);
      expect(captured.some((event) => event.type.startsWith("model."))).toBe(
        false,
      );
      journal.close();
      expect(readCaptureJournal(journal.directory)._tag).toBe("Read");
      const read = readCaptureJournal(journal.directory);
      if (read._tag !== "Read") throw new Error("journal unreadable");
      expect(credentialRefusal(read.lines)).not.toBeNull();
      expect(
        captured
          .filter((event) => event.type === "credential.guard")
          .map((event) =>
            event.type === "credential.guard" ? event.status : undefined,
          ),
      ).toEqual(["pending", "exposed"]);
      const files = [
        join(journal.directory, "events.jsonl"),
        ...readdirSync(join(journal.directory, "objects")).map((name) =>
          join(journal.directory, "objects", name),
        ),
      ];
      for (const file of files)
        expect(readFileSync(file, "utf8")).not.toContain(KEY);
      console.log(
        JSON.stringify({
          proof: "count-http-journal",
          status,
          requests: endpoint.received.length,
          persistedFilesInspected: files.length,
          everyCapturedByteExcludesCredential: true,
          originalWireRequestVerified: true,
          nativeModelEvents: 0,
        }),
      );
    } finally {
      endpoint.stop();
      delete process.env[VARIABLE];
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("a normal count retains its entire request ID and response metadata", async () => {
  const endpoint = openEndpoint();
  const captured: CaptureEvent[] = [];
  process.env[VARIABLE] = KEY;
  const requestId = `req-${"unchanged".repeat(100)}`;
  const body = {
    input_tokens: 23,
    metadata: {
      original: "keep",
      nested: JSON.stringify({ text: "keep all" }),
    },
  };
  endpoint.respond(() =>
    Response.json(body, { headers: { "request-id": requestId } }),
  );
  try {
    const count = createCountTokens({
      credentialInspection: "ephemeral" as const,
      route: { ...OPUS_ROUTE, credentialVariable: VARIABLE },
      capture: (event) => captured.push(event),
      runId: "normal-count",
      baseUrl: endpoint.server.url.origin,
    });
    expect(
      await count({ label: "normal", system: "", user: "count", tools: [] }),
    ).toBe(23);
    const outcome = captured.find(
      (event) =>
        event.type === "artifact" && event.name.endsWith("/outcome.json"),
    );
    if (outcome?.type !== "artifact") throw new Error("outcome missing");
    expect(JSON.parse(new TextDecoder().decode(outcome.bytes))).toEqual({
      status: 200,
      requestId,
      body,
    });
    expect(captured.filter((event) => event.type === "artifact")).toHaveLength(
      3,
    );
  } finally {
    endpoint.stop();
    delete process.env[VARIABLE];
  }
});

test("a clean count registers source inspection for later native tool or artifact echoes without model events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "count-source-guard-"));
  const journal = openCaptureJournal(
    join(directory, "journal"),
    "count-source",
  );
  const endpoint = openEndpoint();
  process.env[VARIABLE] = KEY;
  endpoint.respond(() => Response.json({ input_tokens: 3 }));
  try {
    const count = createCountTokens({
      credentialInspection: "ephemeral" as const,
      route: { ...OPUS_ROUTE, credentialVariable: VARIABLE },
      capture: journal.capture,
      runId: "count-source",
      baseUrl: endpoint.server.url.origin,
    });
    expect(
      await count({ label: "clean", system: "", user: "count", tools: [] }),
    ).toBe(3);
    journal.close();
    const read = readCaptureJournal(journal.directory);
    if (read._tag !== "Read") throw new Error("journal unreadable");
    expect(
      read.lines.some(({ event }) => event.type.startsWith("model.")),
    ).toBe(false);
    const inspection = credentialInspection("count-source", read.lines, [
      "a".repeat(64),
    ]);
    expect(inspection.status).toBe("inspect");
    if (inspection.status !== "inspect")
      throw new Error("count source was not admitted to inspection");
    const { InspectionBudget } =
      await import("../../../src/pi/capture/credential-detectors.ts");
    const exposed = await inspection.inspect(
      { kind: "text", text: JSON.stringify({ nativeToolOutput: KEY }) },
      new InspectionBudget(),
    );
    expect(exposed.status === "complete" && exposed.matches.length > 0).toBe(
      true,
    );
    const safe = await inspection.inspect(
      {
        kind: "text",
        text: JSON.stringify({ artifact: "safe original text" }),
      },
      new InspectionBudget(),
    );
    expect(safe.status === "complete" && safe.matches.length === 0).toBe(true);
    expect(credentialRefusal(read.lines)).not.toBeNull();
    for (const missing of ["all", "pending", "observed"] as const) {
      const stripped = read.lines.filter(
        ({ event }) =>
          event.type !== "credential.guard" ||
          (missing !== "all" && event.status !== missing),
      );
      expect(credentialRefusal(stripped, [])).toContain(
        "required guard facts are missing",
      );
    }
  } finally {
    endpoint.stop();
    delete process.env[VARIABLE];
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a count transport echo whose exposure cannot be recorded fails closed", async () => {
  process.env[VARIABLE] = KEY;
  const count = createCountTokens({
    credentialInspection: "ephemeral" as const,
    route: { ...OPUS_ROUTE, credentialVariable: VARIABLE },
    runId: "count-exposure-failure",
    capture(event) {
      if (event.type === "credential.guard" && event.status === "exposed")
        throw new Error(`guard write failed ${KEY}`);
    },
    fetch: Object.assign(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => {
        throw new Error(`transport echoed ${KEY}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  });
  try {
    const failure = await count({
      label: "count",
      system: "",
      user: "count",
      tools: [],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      _tag: "PreflightFailed",
      retryable: false,
      message: expect.stringContaining(
        "capture failed: guard write failed [REDACTED]",
      ),
    });
    expect(JSON.stringify(failure)).not.toContain(KEY);
  } finally {
    delete process.env[VARIABLE];
  }
});
