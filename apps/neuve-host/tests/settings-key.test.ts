import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// A pasted subscription must never cross either external boundary: HTTP or Keychain storage.
test("Settings refuses pasted subscription credentials before fetching or saving, while API keys still work", () => {
	const fixture = new URL("./fixtures/memory-secrets.ts", import.meta.url);
	const script = `
import assert from "node:assert/strict";
import {calls} from ${JSON.stringify(fixture.href)};
import {setKey, checkKey} from ${JSON.stringify(new URL("../src/settings.ts", import.meta.url).href)};
import {isRejected} from ${JSON.stringify(new URL("../src/keys.ts", import.meta.url).href)};
import {config} from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
import {ClaudeSubscriptionTokenRefused} from ${JSON.stringify(new URL("../../../packages/harness/src/subscription-token.ts", import.meta.url).href)};
let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => {
  requests++;
  return Response.json({data: []});
}, originalFetch);
try {
  const subscription = "sk-ant-oat01-fake-settings";
  const message = "ANTHROPIC_API_KEY contains a Claude subscription token. A Claude subscription runs only through Claude Code; this route needs an Anthropic API key. To use a Claude subscription, sign in to Claude Code itself.";
  const saves = calls.set;
  await assert.rejects(() => setKey("anthropic", "  " + subscription + "  "), error =>
    error instanceof ClaudeSubscriptionTokenRefused && error.message === message && !error.message.includes(subscription));
  assert.equal(requests, 0);
  assert.equal(calls.set, saves);
  assert.equal(await Bun.secrets.get({service: config.keychain, name: "ANTHROPIC_API_KEY"}), null);
  assert.equal(isRejected("ANTHROPIC_API_KEY"), false);
  const apiKey = "sk-ant-api03-fake-settings";
  await setKey("anthropic", apiKey);
  assert.equal(requests, 1);
  assert.equal(calls.set, saves + 1);
  assert.ok((await Bun.secrets.get({service: config.keychain, name: "ANTHROPIC_API_KEY"})) === apiKey);
  await checkKey("anthropic", () => {});
  assert.equal(requests, 2);
  assert.equal(calls.set, saves + 1);
  assert.equal(isRejected("ANTHROPIC_API_KEY"), false);
} finally {
  globalThis.fetch = originalFetch;
}
`;
	const result = Bun.spawnSync([
		process.execPath, "--no-env-file", "--preload", fileURLToPath(fixture), "--eval", script,
	], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BUN_TMPDIR: process.env.BUN_TMPDIR },
		stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
});
