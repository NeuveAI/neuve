import { Option } from "effect";
import { isCompiled as sharedIsCompiled } from "@neuve/harness/compiled";
import { telemetryMode } from "../../../../packages/harness/src/settings.ts";
import { isCompiled } from "../../src/version-skew.ts";
import { installedManifestPath } from "../../src/installed-copy.ts";

console.log(
  JSON.stringify({
    compiled: isCompiled(),
    sharedDefinition: isCompiled === sharedIsCompiled,
    mode: telemetryMode(Option.none()),
    enabled: telemetryMode(
      Option.some({ version: 1, telemetry: { enabled: true } }),
    ),
    disabled: telemetryMode(
      Option.some({
        version: 1,
        telemetry: {
          enabled: false,
          otlp: { baseUrl: "http://127.0.0.1:4318" },
        },
      }),
    ),
    manifest: installedManifestPath(),
  }),
);
