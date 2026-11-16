import { expect, test } from "bun:test";
import { Option } from "effect";
import {
  Settings,
  otlpTarget,
  telemetryMode,
  type TelemetryMode,
} from "../src/settings.ts";

// The owner's defaults and endpoint compatibility must not invert between source and builds.
const cases: ReadonlyArray<{
  telemetry?: Settings["telemetry"];
  compiled: TelemetryMode;
  source: TelemetryMode;
}> = [
  { compiled: "off", source: "logs" },
  { telemetry: {}, compiled: "off", source: "logs" },
  { telemetry: { enabled: false }, compiled: "off", source: "off" },
  { telemetry: { enabled: true }, compiled: "logs", source: "logs" },
  {
    telemetry: { otlp: { baseUrl: "http://127.0.0.1:4318" } },
    compiled: "otlp",
    source: "otlp",
  },
  {
    telemetry: { enabled: true, otlp: { baseUrl: "http://127.0.0.1:4318" } },
    compiled: "otlp",
    source: "otlp",
  },
  {
    telemetry: { enabled: false, otlp: { baseUrl: "http://127.0.0.1:4318" } },
    compiled: "off",
    source: "off",
  },
];
for (const [index, entry] of cases.entries()) {
  for (const compiled of [false, true]) {
    test(`owner's telemetry defaults and endpoint compatibility: row ${index}, compiled ${compiled}`, () => {
      const settings = Option.some(
        Settings.parse({ version: 1, telemetry: entry.telemetry }),
      );
      const mode = telemetryMode(settings, compiled);
      expect(mode).toBe(compiled ? entry.compiled : entry.source);
      expect(Option.getOrUndefined(otlpTarget(settings, mode))).toBe(
        mode === "otlp" ? "http://127.0.0.1:4318" : undefined,
      );
    });
  }
}
test("an absent settings file uses the owner's source and compiled defaults", () => {
  expect(telemetryMode(Option.none(), false)).toBe("logs");
  expect(telemetryMode(Option.none(), true)).toBe("off");
});

test("the strictly parsed owner file accepts enabled and refuses unknown keys and non-booleans", () => {
  expect(Settings.parse({ version: 1, telemetry: { enabled: false } })).toEqual(
    { version: 1, telemetry: { enabled: false } },
  );
  for (const settings of [
    { version: 1, extra: true },
    { version: 1, telemetry: { enabled: true, extra: true } },
    { version: 1, telemetry: { enabled: "false" } },
    {
      version: 1,
      telemetry: { otlp: { baseUrl: "http://localhost:4318", extra: true } },
    },
  ])
    expect(() => Settings.parse(settings)).toThrow();
});
