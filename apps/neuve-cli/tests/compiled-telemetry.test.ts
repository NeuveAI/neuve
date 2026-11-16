import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../../packages/harness/tests/fixtures/process.ts";

const root = mkdtempSync(join(tmpdir(), "compiled-telemetry-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// One actual build proves the harness, version-skew and installed-copy use the same process test.
test("source and compiled defaults share version-skew and installed-copy's compiled definition", async () => {
  const fixture = join(import.meta.dir, "fixtures/compiled-telemetry.ts");
  const binary = join(root, "bin/neuve");
  const manifest = join(root, "lib/neuve/install.json");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(manifest, ".."), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(manifest, "{}\n");
  const { NEUVE_INSTALL_PREFIX: _prefix, ...inherited } = process.env;
  const env = { ...inherited, HOME: join(root, "home") };
  const build = await runProcess(
    [process.execPath, "build", "--compile", fixture, "--outfile", binary],
    { env, timeout: 60_000 },
  );
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  for (const compiled of [false, true]) {
    const result = await runProcess(
      compiled ? [binary] : [process.execPath, fixture],
      { env, timeout: 30_000 },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      compiled,
      sharedDefinition: true,
      mode: compiled ? "off" : "logs",
      enabled: "logs",
      disabled: "off",
      manifest: compiled
        ? manifest
        : join(root, "home/.local/lib/neuve/install.json"),
    });
  }
}, 100_000);
