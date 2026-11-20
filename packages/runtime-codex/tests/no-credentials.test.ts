import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { redact } from "../src/redact.ts";
import type { Recording } from "../src/recorder.ts";
import { trim } from "../scripts/trim.ts";

const folder = new URL("./fixtures/", import.meta.url);
const fixture = async (name: string) =>
  (await Bun.file(new URL(name, folder)).json()) as Recording;

/**
 * The fixture guard, as a list of what a fixture fails. The first line of defence: a fixture is
 * what the redactor and the allow-list make of it, so neither has anything left to change. The
 * second: patterns of what must never appear, whatever the allow-list lets through.
 */
const guard = (recording: Recording): Array<string> => {
  const text = JSON.stringify(recording, null, 2);
  const failed: Array<string> = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failed.push(name);
  };
  check("redaction", Bun.deepEquals(redact(recording, []), recording));
  check("allow-list", Bun.deepEquals(trim(recording), recording));
  check("email", !/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text));
  check("jwt", !/eyJ[\w-]{8,}\./.test(text));
  check("token", !/\b(sk|rt|pk)[-_][\w-]{8,}/.test(text));
  check(
    "path",
    !/\/(Users|private|var|tmp|Applications|Volumes|home)\//.test(text),
  );
  check("app bundle", !text.includes(".app/"));
  check("home", !text.includes(homedir()));
  check("host", !text.includes(hostname()));
  for (const [, value] of text.matchAll(
    /"\w*(?:token|secret|email|user_?id|account_?id|installation_?id|server_?name|plan_?type)": ("[^"]*"|null)/gi,
  ))
    check("identity", /^("<redacted>"|null)$/.test(value!));
  return failed;
};

// Fixtures are committed: none may carry a credential, who the person is, what they have set up,
// or where things are on the machine that recorded them.
test("each fixture passes the guard", async () => {
  const names = readdirSync(folder);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) expect(guard(await fixture(name))).toEqual([]);
});

/** A copy of a fixture with one incoming message changed. */
const planted = async (
  name: string,
  match: (message: Record<string, any>) => boolean,
  change: (message: Record<string, any>) => void,
) => {
  const recording = structuredClone(await fixture(name));
  const entry = recording.entries.find(
    (entry) =>
      entry.direction === "in" && match(entry.message as Record<string, any>),
  );
  if (entry === undefined) throw new Error("nothing to plant into");
  change(entry.message as Record<string, any>);
  return recording;
};
/** Codex's answer to the request the fixture sent with this method. */
const answerTo = (recording: Recording, method: string) => {
  const sent = recording.entries.find(
    (entry) =>
      entry.direction === "out" &&
      (entry.message as Record<string, unknown>).method === method,
  )!.message as Record<string, unknown>;
  return (message: Record<string, any>) =>
    message.method === undefined && message.id === sent.id;
};

// A re-recording on another machine must not commit a described setup with the guard green: each
// of these is what a person's own configuration or account can put in a recording. The planted
// value must fail the guard and must be gone from what the allow-list makes of it.
describe("the guard catches what a person's setup plants", async () => {
  const readOnly = await fixture("read-only.json");
  const cases: Array<[string, string, Promise<Recording>]> = [
    [
      "a hook command",
      "notify-me --loud",
      planted("read-only.json", answerTo(readOnly, "hooks/list"), (m) => {
        m.result.data[0].hooks.push({
          key: "user:pre:0",
          eventName: "preToolUse",
          handlerType: "command",
          command: "notify-me --loud",
          enabled: true,
          isManaged: false,
        });
      }),
    ],
    [
      "an administrator's requirements",
      "Acme security policy",
      planted(
        "read-only.json",
        answerTo(readOnly, "configRequirements/read"),
        (m) => {
          m.result.requirements = {
            allowedApprovalPolicies: ["never"],
            enterpriseName: "Acme security policy",
          };
        },
      ),
    ],
    [
      "an app name",
      "Acme CRM",
      planted("read-only.json", answerTo(readOnly, "app/list"), (m) => {
        m.result.data.push({
          id: "connector_acme",
          name: "Acme CRM",
          isAccessible: true,
          isEnabled: false,
        });
      }),
    ],
    [
      "an organisation name",
      "Acme Corporation",
      planted("read-only.json", answerTo(readOnly, "account/read"), (m) => {
        m.result.organizationName = "Acme Corporation";
      }),
    ],
    [
      "an MCP tool name",
      "acme_deploy_production",
      planted(
        "read-only.json",
        answerTo(readOnly, "mcpServerStatus/list"),
        (m) => {
          m.result.data[0].tools = {
            acme_deploy_production: { name: "acme_deploy_production" },
          };
        },
      ),
    ],
    [
      "an environment id",
      "env-7f3a9c",
      planted(
        "handshake.json",
        (m) => m.method === "remoteControl/status/changed",
        (m) => {
          m.params.environmentId = "env-7f3a9c";
        },
      ),
    ],
    [
      "another backend origin",
      "acme.example.com",
      planted("read-only.json", answerTo(readOnly, "account/read"), (m) => {
        m.result.workspaceRouting.backendOrigin = "https://acme.example.com";
      }),
    ],
  ];
  for (const [name, value, recording] of cases)
    test(name, async () => {
      const plantedRecording = await recording;
      expect(JSON.stringify(plantedRecording)).toContain(value);
      expect(guard(plantedRecording)).not.toEqual([]);
      expect(JSON.stringify(trim(plantedRecording))).not.toContain(value);
    });

  // A recording of a request Codex refused: the allow-list keeps the code and Codex's reason,
  // never its text, and does not stop at it.
  test("an error response", async () => {
    const recording = await planted(
      "read-only.json",
      answerTo(readOnly, "app/list"),
      (m) => {
        delete m.result;
        m.error = {
          code: -32600,
          message: "no apps for Acme Corporation",
          data: { type: "appsUnavailable", detail: "Acme" },
        };
      },
    );
    const trimmed = trim(recording);
    expect(JSON.stringify(trimmed)).not.toContain("Acme");
    expect(
      trimmed.entries.find(
        (entry) =>
          answerTo(
            readOnly,
            "app/list",
          )(entry.message as Record<string, unknown>) &&
          entry.direction === "in",
      )?.message,
    ).toMatchObject({
      error: {
        code: -32600,
        message: "<message>",
        data: { type: "appsUnavailable" },
      },
    });
    expect(trim(trimmed)).toEqual(trimmed);
  });
});

// The recorder is the one place a live conversation becomes a fixture; this is its contract.
test("redaction keeps field names and replaces values", () => {
  expect(
    redact(
      {
        cwd: "/work/codex-proof-x/sub",
        account: { email: "a@b.co", userId: "u-1" },
        note: "token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q and /opt/tool/bin and https://chatgpt.com/a/b",
        mcp: { env: { KEY: "v" }, args: ["--key", "v"] },
      },
      [["/work/codex-proof-x", "<cwd>"]],
    ),
  ).toEqual({
    cwd: "<cwd>/sub",
    account: { email: "<redacted>", userId: "<redacted>" },
    note: "token <token> and <path> and https://chatgpt.com/a/b",
    mcp: { env: "<redacted>", args: "<redacted>" },
  });
});

// Free text, such as the standard-error tail or Codex's own error message, can hold any secret a
// program prints: each shape is replaced, and the machine's name only where it is a word.
test("redaction replaces secrets in free text", () => {
  const short = hostname().split(".")[0]!;
  const text = String(
    redact(
      [
        "key sk-proj-abcdefgh12345678",
        "refresh rt_abcdefgh12345678",
        "Authorization: Bearer abc.def-ghi",
        "mail a.person@example.org",
        `home ${homedir()}/notes and ~/notes/today.md`,
        `on ${hostname()} also ${short}`,
        `word pre${short}post`,
      ].join("\n"),
      [],
    ),
  );
  expect(text).toBe(
    [
      "key <token>",
      "refresh <token>",
      "Authorization: Bearer <token>",
      "mail <email>",
      "home <home>/notes and <path>",
      "on <host> also <host>",
      `word pre${short}post`,
    ].join("\n"),
  );
});

// A secret-named field can hold a list or an object as well as a string: all of it goes. A
// boolean or null says nothing and stays, so a request's `refreshToken: false` is kept, and so do
// counts named after tokens, such as a turn's usage.
// A name that reads as a count is exempt only while it holds numbers: plural names can hold the
// secrets themselves.
test("redaction keeps counts named after tokens, and nothing else under those names", () => {
  expect(
    redact(
      {
        accessTokens: ["eyJ-not-a-count"],
        refresh_tokens: "opaque-refresh-value",
        idTokens: { primary: "opaque-id-value" },
        tokenUsage: {
          total: { inputTokens: 5, outputTokens: 2 },
          modelContextWindow: null,
        },
      },
      [],
    ),
  ).toEqual({
    accessTokens: "<redacted>",
    refresh_tokens: "<redacted>",
    idTokens: "<redacted>",
    tokenUsage: {
      total: { inputTokens: 5, outputTokens: 2 },
      modelContextWindow: null,
    },
  });
});

test("redaction replaces a secret-named field whatever it holds", () => {
  expect(
    redact(
      {
        tokens: ["a", "b"],
        apiKey: { value: "x" },
        accountId: 1234,
        refreshToken: false,
        userId: null,
        tokenUsage: { total: { inputTokens: 5 } },
      },
      [],
    ),
  ).toEqual({
    tokens: "<redacted>",
    apiKey: "<redacted>",
    accountId: "<redacted>",
    refreshToken: false,
    userId: null,
    tokenUsage: { total: { inputTokens: 5 } },
  });
});
