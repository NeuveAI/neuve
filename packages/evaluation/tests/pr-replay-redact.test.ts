// Why: a failed cloud call's stderr is kept on the research volume and quoted in the pipeline's log,
// and nothing guarantees it never carries a sign-in token (an auth error, a refresh response, a
// traceback with headers or the environment). Every token shape is planted here as a fake value and
// must not survive; ordinary traceback text must.
import { expect, test } from "bun:test";
import { redactSecrets } from "../src/pr-replay/redact.ts";

const JWT =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJGQUtFLVVTRVItMDAxIn0.FAKEsignatureFAKEsignature0123";
const PLANTED = [
  `{"tokens": {"id_token": "FAKE-ID-0001", "access_token": "FAKE-ACCESS-0002", "refresh_token": "FAKE-REFRESH-0003", "account_id": "FAKE-ACCOUNT-0004"}, "OPENAI_API_KEY": "FAKE-OPENAI-0005"}`,
  "Authorization: Bearer FAKE-BEARER-0006",
  "openai.AuthenticationError: invalid key sk-FAKEFAKEFAKE0007",
  `token rejected: ${JWT}`,
  "env: NEUVE_LEASE_KEY=FAKE-LEASE-KEY-0008 NEUVE_LEASE_SECRET=FAKE-LEASE-SECRET-0009",
  "environ({'NEUVE_LEASE_SECRET': 'FAKE-LEASE-SECRET-0010', 'MODAL_TOKEN_SECRET': 'FAKE-MODAL-0011'})",
  "POST /oauth/token grant_type=refresh_token&refresh_token=FAKE-REFRESH-0012&client_id=app",
  'api_key: "FAKE-API-0013"',
  // Any case of a secret's name, and an opaque refresh token by its prefix alone.
  "ACCESS_TOKEN=FAKE-ACCESS-0014 {\"Refresh_Token\": \"FAKE-REFRESH-0015\"} {'Id_Token': 'FAKE-ID-0016'}",
  "neuve_lease_secret: FAKE-LEASE-SECRET-0017",
  "rotated to rt_FAKEFAKEFAKEFAKEFAKE0018 at 19:30",
].join("\n");

test("every planted token shape is masked, and ordinary traceback text is kept", () => {
  const out = redactSecrets(PLANTED);
  for (const fake of [
    /FAKE-[A-Z-]+-\d{4}/,
    /sk-FAKE/,
    /FAKEsignature/,
    /eyJhbGci/,
    /rt_FAKE/,
  ])
    expect(out).not.toMatch(fake);
  expect(out).toContain('"access_token": "[redacted]"');
  expect(out).toContain("Bearer [redacted]");
  expect(out).toContain("NEUVE_LEASE_SECRET=[redacted]");
  expect(out).toContain("'NEUVE_LEASE_SECRET': '[redacted]'");
  const traceback =
    'File "/opt/label/label_box.py", line 196, in probe\n    write_catalog(request["catalog"])\nKeyError: \'catalog\'\nasyncio/tasks.py, line 519, in wait_for\nTimeoutError';
  expect(redactSecrets(traceback)).toBe(traceback);
});
