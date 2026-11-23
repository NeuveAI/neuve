import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Each child owns its environment and fake Keychain, including the otherwise permanent sealed map.
function isolated(body: string): void {
	const script = `
import assert from "node:assert/strict";
import {key, latest, models, settled, seal, workerEnv} from ${JSON.stringify(new URL("../src/keys.ts", import.meta.url).href)};
const {getEnvApiKey, findEnvKeys} = await import(new URL("./env-api-keys.js", import.meta.resolve("@earendil-works/pi-ai")).href);
const names = [];
const get = Bun.secrets.get;
Bun.secrets.get = async (options) => { names.push(options.name); return get(options); };
const stored = async (name, value) => Bun.secrets.set({service: process.env.ACE_KEYCHAIN_SERVICE, name, value});
const noAnthropic = async () => {
  assert.deepEqual(await models().getAvailable("anthropic"), []);
  assert.deepEqual(await settled().models.getAvailable("anthropic"), []);
};
${body}
`;
	const result = Bun.spawnSync([
		process.execPath, "--no-env-file", "--preload",
		fileURLToPath(new URL("./fixtures/memory-secrets.ts", import.meta.url)), "--eval", script,
	], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BUN_TMPDIR: process.env.BUN_TMPDIR },
		stdout: "pipe", stderr: "pipe", timeout: 30_000,
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
}

// Chat and Settings both build catalogues, so either could expose the unsupported sign-in.
test("both host catalogues offer every built-in provider except legacy Codex", () => {
	isolated(`
const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
const expected = builtinProviders().map(provider => provider.id).filter(id => id !== "openai-codex").sort();
for (const catalogue of [models(), settled().models]) {
  assert.deepEqual(catalogue.getProviders().map(provider => provider.id).sort(), expected);
  assert.equal(catalogue.getModel("openai-codex", "gpt-6-sol"), undefined);
}
`);
});

test("OAuth names never resolve from environment, sealed state or Keychain and never admit coding models", () => {
	isolated(`
for (const name of ["ANTHROPIC_OAUTH_TOKEN", "ACE_ANTHROPIC_OAUTH_TOKEN"]) {
  process.env[name] = "sk-ant-oat01-fake-oauth";
  await stored(name, "sk-ant-oat01-fake-keychain-oauth");
  assert.equal(await key(name), undefined);
  assert.deepEqual(await latest(name), {source: "missing", stored: false});
  assert.deepEqual(await latest(name, true), {source: "missing", stored: false});
}
await noAnthropic();
seal();
for (const name of ["ANTHROPIC_OAUTH_TOKEN", "ACE_ANTHROPIC_OAUTH_TOKEN"]) {
  assert.equal(process.env[name], undefined);
  assert.equal(workerEnv()[name], undefined);
  assert.equal(await key(name), undefined);
  assert.deepEqual(await latest(name), {source: "missing", stored: false});
}
await noAnthropic();
assert.equal(names.some(name => name.includes("ANTHROPIC_OAUTH_TOKEN")), false);
assert.equal(getEnvApiKey("anthropic"), undefined);
assert.equal(findEnvKeys("anthropic"), undefined);
`);
});

test("subscription credentials in every Anthropic environment name are absent from both coding catalogues and show a Settings error", () => {
	isolated(`
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ACE_ANTHROPIC_API_KEY", "ACE_ANTHROPIC_AUTH_TOKEN"]) {
  const canonical = name.replace(/^ACE_/, "");
  process.env[name] = "  sk-ant-oat01-fake-environment  ";
  assert.equal(await key(canonical), undefined);
  await noAnthropic();
  const status = await latest(canonical);
  assert.equal(status.source, "unavailable");
  assert.equal(status.override, name);
  assert.ok(status.error.includes("Claude Code"));
  assert.ok(status.error.includes(name));
  assert.equal(status.error.includes("sk-ant-oat"), false);
  delete process.env[name];
}
process.env.ANTHROPIC_API_KEY = "sk-ant-oat01-fake-sealed";
process.env.ACE_ANTHROPIC_AUTH_TOKEN = "sk-ant-oat01-fake-sealed";
seal();
assert.equal(await key("ANTHROPIC_API_KEY"), undefined);
assert.equal(await key("ANTHROPIC_AUTH_TOKEN"), undefined);
await noAnthropic();
assert.equal((await latest("ANTHROPIC_API_KEY")).source, "unavailable");
assert.equal(getEnvApiKey("anthropic"), undefined);
assert.equal(findEnvKeys("anthropic"), undefined);
`);
});

test("subscription credentials in the fake Keychain never offer Anthropic models and Settings shows unavailable", () => {
	isolated(`
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ACE_ANTHROPIC_API_KEY", "ACE_ANTHROPIC_AUTH_TOKEN"]) {
  await stored(name, "  sk-ant-oat01-fake-stored  ");
  assert.equal(await key(name), undefined);
  await noAnthropic();
  const status = await latest(name, true);
  assert.equal(status.source, "unavailable");
  assert.equal(status.stored, true);
  assert.ok(status.error.includes(name));
  assert.equal(status.error.includes("sk-ant-oat"), false);
  await stored(name, "");
}
`);
});

test("ordinary API keys and auth tokens still admit Anthropic models with the existing environment precedence", () => {
	isolated(`
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ACE_ANTHROPIC_API_KEY", "ACE_ANTHROPIC_AUTH_TOKEN"]) {
  const canonical = name.replace(/^ACE_/, "");
  process.env[name] = "sk-ant-api03-fake-environment";
  assert.equal(await key(canonical), "sk-ant-api03-fake-environment");
  assert.ok((await models().getAvailable("anthropic")).length > 0);
  assert.ok((await settled().models.getAvailable("anthropic")).length > 0);
  assert.equal((await latest(canonical)).source, "environment");
  delete process.env[name];
}
await stored("ANTHROPIC_API_KEY", "sk-ant-api03-fake-stored");
assert.ok((await models().getAvailable("anthropic")).length > 0);
assert.ok((await settled().models.getAvailable("anthropic")).length > 0);
assert.equal((await latest("ANTHROPIC_API_KEY")).source, "keychain");
process.env.ACE_ANTHROPIC_API_KEY = "sk-ant-api03-fake-override";
process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fake-fallback";
assert.equal(await key("ANTHROPIC_API_KEY"), "sk-ant-api03-fake-override");
seal();
assert.equal(await key("ANTHROPIC_API_KEY"), "sk-ant-api03-fake-override");
assert.ok((await models().getAvailable("anthropic")).length > 0);
`);
});

test("empty and whitespace credentials stay missing for coding model admission", () => {
	isolated(`
for (const value of ["", " \\t "]) {
  process.env.ANTHROPIC_API_KEY = value;
  process.env.ANTHROPIC_AUTH_TOKEN = value;
  await stored("ANTHROPIC_API_KEY", value);
  assert.equal(await key("ANTHROPIC_API_KEY"), undefined);
  assert.deepEqual(await latest("ANTHROPIC_API_KEY", true), {source: "missing", stored: false, override: undefined});
  await noAnthropic();
}
`);
});
