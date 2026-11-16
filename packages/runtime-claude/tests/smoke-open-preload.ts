import { mock } from "bun:test";
import { Layer } from "effect";
import { ClaudeSdk } from "../src/services.ts";
import { openFixture } from "./smoke-open-fixture.ts";
const fixture = openFixture(Bun.argv.at(-1) ?? "logging");
// The combined fake layers provide executable resolution and forbid auth processes.
mock.module("../src/production.ts", () => ({
  sdkLayer: Layer.succeed(ClaudeSdk, fixture.sdk),
  executableLayer: fixture.layers,
  processLayer: Layer.empty,
}));
