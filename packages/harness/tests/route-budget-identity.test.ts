import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openRouteAdmission,
  providerAccountKey,
} from "../src/pi/providers/route-admission.ts";
import { SOL_ROUTE } from "../src/route.ts";
test("provider capacity shares models while persisted Retry-After remains route-specific", async () => {
  const directory = mkdtempSync(join(tmpdir(), "route-budget-identity-"));
  const input = {
    path: join(directory, "deadline.json"),
    route: SOL_ROUTE,
    auth: { directory },
  };
  const other = { ...input, route: { ...SOL_ROUTE, model: "another-model" } };
  try {
    expect(providerAccountKey(input)).toBe(providerAccountKey(other));
    openRouteAdmission(input).observe("1", Date.now());
    await expect(
      openRouteAdmission(other).wait(AbortSignal.timeout(10)),
    ).resolves.toBeUndefined();
    await expect(
      openRouteAdmission(input).wait(AbortSignal.timeout(10)),
    ).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Persisted gates written before the shared account limiter must survive the upgrade unchanged.
test("the original model-specific persisted gate key remains readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "route-budget-legacy-")),
    path = join(directory, "deadline.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        key: "3152a32cfaac265bc9c7314895750ea9c86e7fb956a29ad1205aacad3a9e5563",
        until: Date.now() + 1000,
      }),
    );
    await expect(
      openRouteAdmission({
        path,
        route: { ...SOL_ROUTE, model: "fixture-model" },
        baseUrl: "https://provider.invalid/v1",
        auth: { directory: "/fixture/account-source" },
      }).wait(AbortSignal.timeout(10)),
    ).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
