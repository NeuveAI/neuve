import { expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import {
  CredentialDetectors,
  CredentialEpochId,
  CredentialJson,
  DEFAULT_INSPECTION_LIMITS,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { refusalEvidence } from "../../../src/pi/providers/credential-evidence.ts";

const epoch = CredentialEpochId.parse("historical");
const budget = () => new InspectionBudget();
const registered = async (headers: Headers) => {
  const engine = CredentialDetectors.empty(randomBytes(32));
  expect(await engine.register({ epoch, headers, budget: budget() })).toEqual({
    status: "registered",
    epoch,
  });
  return engine;
};
const encoded = (value: string, encoding: "utf8" | "utf16le" | "utf16be") => {
  const bytes = Buffer.from(value, encoding === "utf8" ? "utf8" : "utf16le");
  return encoding === "utf16be" ? bytes.swap16() : bytes;
};

test("the live production oracle and durable detector agree on generated header, JSON, escape and mutation cases", async () => {
  for (const key of [
    "Q",
    "ab",
    "synthetic-40-" + "k".repeat(28),
    'synthetic-"-\\-value',
    "K".repeat(2048),
    "L".repeat(8192),
  ]) {
    const headers = new Headers({
      authorization: `Bearer ${key}`,
      cookie: "one=synthetic-cookie; two=other-value",
    });
    const engine = await registered(headers);
    const bodies = [
      "unrelated harmless body",
      `before ${key} after`,
      JSON.stringify({ value: key }),
      JSON.stringify({ [key]: "safe" }),
      JSON.stringify({ value: JSON.stringify({ key }) }),
      JSON.stringify(key),
      JSON.stringify({ value: key }).replace(
        /[a-zA-Z]/g,
        (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
      "synthetic-cookie",
      key.slice(0, -1) + "§",
    ];
    for (const body of bodies) {
      const expected = refusalEvidence(body, headers).bodyRedactions.length > 0;
      const result = await engine.inspectText({ text: body, budget: budget() });
      expect(result.status).toBe("complete");
      if (result.status === "complete")
        expect(result.matches.length > 0).toBe(expected);
    }
    expect(JSON.stringify(engine)).toBe('"[Private credential detectors]"');
    expect(inspect(engine)).toBe("[Private credential detectors]");
    engine.destroy();
  }
});

test("invalid JSON remains literal text but operational parser failure cannot certify absence or disclose source", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-parser-secret" }),
  );
  expect(
    await engine.inspectText({ text: '{"broken":', budget: budget() }),
  ).toEqual({ status: "complete", epochs: [epoch], matches: [] });
  expect(() => CredentialJson.parse('{"synthetic-parser-secret":')).toThrow(
    "Credential JSON source is invalid",
  );
  const parse = JSON.parse;
  try {
    JSON.parse = () => {
      throw new RangeError("synthetic-parser-secret operational failure");
    };
    expect(
      await engine.inspectText({
        text: '{"safe":"ordinary"}',
        budget: budget(),
      }),
    ).toEqual({
      status: "unavailable",
      reason: "unsupported",
      exposedEpochs: [],
    });
    expect(() => CredentialJson.parse('{"safe":"ordinary"}')).toThrow(
      "Credential JSON validation unavailable",
    );
  } finally {
    JSON.parse = parse;
  }
});

test("all late and overlapping intervals retain every equal-material epoch and role", async () => {
  const engine = await registered(
    new Headers({ authorization: "Bearer aba", "x-api-key": "aba" }),
  );
  const next = CredentialEpochId.parse("rotated");
  expect(
    (
      await engine.register({
        epoch: next,
        headers: new Headers({ "x-api-key": "aba" }),
        budget: budget(),
      })
    ).status,
  ).toBe("registered");
  const result = await engine.inspectText({
    text: "prefix ababa aba",
    budget: budget(),
  });
  expect(result.status).toBe("complete");
  if (result.status === "complete") {
    expect(
      result.matches
        .filter((match) => match.epoch === epoch)
        .map((match) => [match.start, match.end]),
    ).toEqual([
      [7, 10],
      [9, 12],
      [13, 16],
    ]);
    expect(
      result.matches
        .filter((match) => match.epoch === next)
        .map((match) => [match.start, match.end]),
    ).toEqual([
      [7, 10],
      [9, 12],
      [13, 16],
    ]);
    expect(
      result.matches.find((match) => match.epoch === epoch)?.roles.toSorted(),
    ).toEqual(["authorization-token", "header"]);
  }
});

test("nested JSON reports decoded intervals and their complete quoted container path", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-key" }),
  );
  const result = await engine.inspectText({
    text: JSON.stringify({
      value: JSON.stringify({ value: "synthetic-key twice synthetic-key" }),
    }),
    budget: budget(),
  });
  expect(result.status).toBe("complete");
  if (result.status === "complete")
    expect(
      result.matches.some(
        (match) =>
          match.jsonPath.length >= 2 && match.start === 0 && match.end === 13,
      ),
    ).toBe(true);
});

test("a forced private prefilter collision cannot substitute for complete HMAC", async () => {
  const key = randomBytes(32);
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-target" }),
  );
  const other = CredentialDetectors.empty(key);
  await other.register({
    epoch,
    headers: new Headers({ "x-api-key": "synthetic-other!" }),
    budget: budget(),
  });
  const encodedState = new TextDecoder().decode(other.encodePrivate());
  const digest = /"digest":"([a-f0-9]{64})"/.exec(
    new TextDecoder().decode(engine.encodePrivate()),
  )?.[1];
  if (digest === undefined) throw new Error("fixture lacks full digest");
  const changed = encodedState.replace(
    /"digest":"[a-f0-9]{64}"/g,
    `"digest":"${digest}"`,
  );
  const stateBytes = changed.slice(
    '{"state":'.length,
    changed.lastIndexOf(',"mac":'),
  );
  const signature = createHmac("sha256", key)
    .update("credential-detector-state-v1\0")
    .update(stateBytes)
    .digest("hex");
  const sealed = changed.replace(
    /"mac":"[a-f0-9]{64}"/,
    `"mac":"${signature}"`,
  );
  const collision = CredentialDetectors.restorePrivate(
    key,
    new TextEncoder().encode(sealed),
  );
  const result = await collision.inspectText({
    text: "synthetic-other!",
    budget: budget(),
  });
  expect(result).toEqual({ status: "complete", epochs: [epoch], matches: [] });
});

test("exact UTF-16 code units do not alias lone surrogates to replacement characters", async () => {
  const headers = new Headers({ "x-api-key": "synthetic-ascii" });
  const engine = await registered(headers);
  for (const text of [
    "\ud800synthetic-ascii",
    "\udc00synthetic-ascii",
    "\ufffdsynthetic-ascii",
    "😀synthetic-ascii",
  ]) {
    const result = await engine.inspectText({ text, budget: budget() });
    expect(result.status).toBe("complete");
    if (result.status === "complete")
      expect(
        result.matches.some((match) => match.end - match.start === 15),
      ).toBe(true);
  }
});

test("UTF8 and both UTF16 byte orders retain raw and declared-text match coordinates", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-encoded" }),
  );
  for (const encoding of ["utf8", "utf16le", "utf16be"] as const) {
    const body = JSON.stringify({ value: "prefix synthetic-encoded suffix" });
    const result = await engine.inspectArtifact({
      bytes: encoded(body, encoding),
      mediaType: `application/json; charset=${encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : "utf-16be"}`,
      budget: budget(),
    });
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.matches.some((match) => match.view === "raw")).toBe(true);
      expect(
        result.matches.some(
          (match) =>
            match.view === "declared-text" && match.jsonPath.length > 0,
        ),
      ).toBe(true);
    }
  }
  expect(
    await engine.inspectArtifact({
      bytes: Buffer.from("safe"),
      mediaType: "text/plain; charset=shift-jis",
      budget: budget(),
    }),
  ).toEqual({
    status: "unavailable",
    reason: "unsupported",
    exposedEpochs: [],
  });
});

test("unit, complete-HMAC, match, parse and cancellation limits never certify an unfinished scan", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-budget" }),
  );
  for (const override of [
    { units: 1 },
    { fullChecks: 0 },
    { fullBytes: 0 },
    { matches: 0 },
  ]) {
    const result = await engine.inspectText({
      text: "synthetic-budget twice synthetic-budget",
      budget: new InspectionBudget({
        ...DEFAULT_INSPECTION_LIMITS,
        ...override,
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "budget",
      exposedEpochs: "matches" in override ? [epoch] : [],
    });
  }
  expect(
    await engine.inspectText({
      text: JSON.stringify({ value: "safe" }),
      budget: new InspectionBudget({
        ...DEFAULT_INSPECTION_LIMITS,
        parseValueUnits: 3,
      }),
    }),
  ).toEqual({
    status: "unavailable",
    reason: "unsupported",
    exposedEpochs: [],
  });
  expect(
    await engine.inspectArtifact({
      bytes: Buffer.from("safe"),
      mediaType: "text/plain",
      budget: new InspectionBudget({
        ...DEFAULT_INSPECTION_LIMITS,
        decodeUnits: 0,
      }),
    }),
  ).toEqual({ status: "unavailable", reason: "budget", exposedEpochs: [] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1);
  expect(
    await engine.inspectText({
      text: "x".repeat(1024 * 1024),
      budget: budget(),
      signal: controller.signal,
    }),
  ).toEqual({ status: "unavailable", reason: "cancelled", exposedEpochs: [] });
  engine.destroy();
  expect(await engine.inspectText({ text: "safe", budget: budget() })).toEqual({
    status: "unavailable",
    reason: "closed",
    exposedEpochs: [],
  });
});

test("Bun scans 10MiB normal content and caps adversarial full-HMAC work while yielding", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "a".repeat(8191) + "b" }),
  );
  const normal = await engine.inspectText({
    text: "x".repeat(10 * 1024 * 1024),
    budget: budget(),
  });
  expect(normal).toEqual({ status: "complete", epochs: [epoch], matches: [] });
  let yielded = false;
  setTimeout(() => {
    yielded = true;
  }, 0);
  const constrained = new InspectionBudget({
    ...DEFAULT_INSPECTION_LIMITS,
    fullChecks: 32,
    fullBytes: 1024 * 1024,
    yieldUnits: 1,
  });
  expect(
    await engine.inspectText({
      text: "a".repeat(10 * 1024 * 1024),
      budget: constrained,
    }),
  ).toEqual({ status: "unavailable", reason: "budget", exposedEpochs: [] });
  expect(yielded).toBe(true);
}, 45_000);

test("raw numeric material is protected even where the older JSON-aware oracle reports no string exposure", async () => {
  const headers = new Headers({ "x-api-key": "42" });
  expect(refusalEvidence('{"value":42}', headers).bodyRedactions).toEqual([]);
  const engine = await registered(headers);
  const result = await engine.inspectText({
    text: '{"value":42}',
    budget: budget(),
  });
  expect(result.status).toBe("complete");
  if (result.status === "complete")
    expect(
      result.matches.map((match) => [match.start, match.end]),
    ).toContainEqual([9, 11]);
});

test("ordinary accumulated JSON is explicit at the parse ceiling and escape-hidden material is never certified above it", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-history" }),
  );
  const small = JSON.stringify({
    messages: Array.from({ length: 1800 }, () => ({
      role: "assistant",
      text: "safe ".repeat(100),
    })),
  });
  const cap = DEFAULT_INSPECTION_LIMITS.parseValueUnits;
  expect(small.length).toBeLessThan(cap);
  const permitted = new InspectionBudget({
    ...DEFAULT_INSPECTION_LIMITS,
    parseValueUnits: cap,
  });
  expect(
    (await engine.inspectText({ text: small, budget: permitted })).status,
  ).toBe("complete");
  const large = JSON.stringify({
    messages: Array.from({ length: 2000 }, () => ({
      role: "assistant",
      text: "safe ".repeat(100),
    })),
    hidden: "synthetic-history",
  }).replace("synthetic-history", "\\u0073ynthetic-history");
  expect(
    await engine.inspectText({
      text: large,
      budget: new InspectionBudget({
        ...DEFAULT_INSPECTION_LIMITS,
        parseValueUnits: cap,
      }),
    }),
  ).toEqual({
    status: "unavailable",
    reason: "unsupported",
    exposedEpochs: [],
  });
});

test("known unsafe epochs survive cancellation after the first observed match", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-known" }),
  );
  const controller = new AbortController(),
    work = budget();
  const timer = setInterval(() => {
    if (work.usage.matches > 0) controller.abort();
  }, 0);
  try {
    expect(
      await engine.inspectText({
        text: "synthetic-known " + "x".repeat(1024 * 1024),
        budget: work,
        signal: controller.signal,
      }),
    ).toEqual({
      status: "unavailable",
      reason: "cancelled",
      exposedEpochs: [epoch],
    });
  } finally {
    clearInterval(timer);
  }
});

test("split model deltas and storage cells must be reconstructed by the caller before matching", async () => {
  const engine = await registered(
    new Headers({ "x-api-key": "synthetic-reconstructed" }),
  );
  const parts = ["synthetic-", "recon", "structed"];
  for (const text of parts)
    expect(await engine.inspectText({ text, budget: budget() })).toEqual({
      status: "complete",
      epochs: [epoch],
      matches: [],
    });
  const result = await engine.inspectText({
    text: parts.join(""),
    budget: budget(),
  });
  expect(result.status).toBe("complete");
  if (result.status === "complete")
    expect(result.matches.map((match) => [match.start, match.end])).toEqual([
      [0, 23],
    ]);
});

test("an earlier duplicate JSON property with an escape-hidden historical value remains observable", async () => {
  const headers = new Headers({ "x-api-key": "synthetic-duplicate" });
  const text = '{"value":"\\u0073ynthetic-duplicate","value":"safe"}';
  expect(JSON.parse(text)).toEqual({ value: "safe" });
  expect(refusalEvidence(text, headers).bodyRedactions).toEqual(["x-api-key"]);
  const engine = await registered(headers);
  const result = await engine.inspectText({ text, budget: budget() });
  expect(result.status).toBe("complete");
  if (result.status === "complete")
    expect(
      result.matches.some(
        (match) =>
          match.jsonPath[0]?.start === 9 &&
          match.start === 0 &&
          match.end === 19,
      ),
    ).toBe(true);
});

test("raw BLOB and reconstructed TEXT cells are inspected whole across SQLite pages", async () => {
  const { Database } = await import("bun:sqlite");
  const key = "synthetic-cell-value",
    engine = await registered(new Headers({ "x-api-key": key }));
  const database = new Database(":memory:");
  try {
    database.exec(
      "PRAGMA page_size=4096; CREATE TABLE cells (value TEXT, bytes BLOB)",
    );
    database
      .query("INSERT INTO cells VALUES (?, ?)")
      .run(
        "x".repeat(4087) + key + "x".repeat(4096),
        encoded("x".repeat(4087) + key, "utf16be"),
      );
    const row = database.query("SELECT value, bytes FROM cells").get();
    if (
      typeof row !== "object" ||
      row === null ||
      !("value" in row) ||
      typeof row.value !== "string" ||
      !("bytes" in row) ||
      !(row.bytes instanceof Uint8Array)
    )
      throw new Error("fixture cells missing");
    const text = await engine.inspectText({
      text: row.value,
      budget: budget(),
    });
    const blob = await engine.inspectArtifact({
      bytes: row.bytes,
      mediaType: "application/octet-stream",
      budget: budget(),
    });
    expect(text.status).toBe("complete");
    expect(blob.status).toBe("complete");
    if (text.status === "complete")
      expect(text.matches.some((match) => match.start === 4087)).toBe(true);
    if (blob.status === "complete")
      expect(
        blob.matches.some(
          (match) => match.domain === "raw-utf16be" && match.start === 8174,
        ),
      ).toBe(true);
  } finally {
    database.close();
  }
});
