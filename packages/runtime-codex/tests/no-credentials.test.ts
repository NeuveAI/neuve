import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { redact } from "../src/redact.ts";
import type { Recording } from "../src/recorder.ts";
import { trim } from "../scripts/trim.ts";

const folder = new URL("./fixtures/", import.meta.url);

// Fixtures are committed: none may carry a credential, who the person is, what they have set up,
// or where things are on the machine that recorded them. The first line of defence: a fixture
// is what the redactor and the allow-list make of it, so neither has anything left to change.
test("each fixture is a fixed point of redaction and the allow-list", async () => {
  const names = readdirSync(folder);
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const fixture = (await Bun.file(new URL(name, folder)).json()) as Recording;
    expect(redact(fixture, [])).toEqual(fixture);
    expect(trim(fixture)).toEqual(fixture);
  }
});

// The second line: patterns of what must never appear, whatever the allow-list lets through.
test("fixtures hold no credential, email, identity or machine path", async () => {
  for (const name of readdirSync(folder)) {
    const text = await Bun.file(new URL(name, folder)).text();
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(text).not.toMatch(/eyJ[\w-]{8,}\./);
    expect(text).not.toMatch(/\b(sk|rt|pk)[-_][\w-]{8,}/);
    expect(text).not.toMatch(
      /\/(Users|private|var|tmp|Applications|Volumes|home)\//,
    );
    expect(text).not.toContain(".app/");
    expect(text).not.toContain(homedir());
    expect(text).not.toContain(hostname());
    for (const [, value] of text.matchAll(
      /"\w*(?:token|secret|email|user_?id|account_?id|installation_?id|server_?name|plan_?type)": ("[^"]*"|null)/gi,
    ))
      expect(value).toMatch(/^("<redacted>"|null)$/);
  }
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
