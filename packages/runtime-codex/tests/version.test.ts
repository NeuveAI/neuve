// Why: the version is read from text Codex writes, and the table decides whether a session may
// start at all; only a release marked broken is refused, an older one runs with advice.
import { expect, test } from "bun:test";
import { RELEASE } from "../src/generated/methods.ts";
import { judge, versionOf } from "../src/version.ts";

test("the release is read from the user agent, after the client's own name", () => {
  expect(
    versionOf("neuve/0.171.0-alpha.13 (<system>) unknown (neuve; 0.1.0)"),
  ).toBe("0.171.0-alpha.13");
  expect(versionOf("neuve/0.172.0 (Mac OS; arm64)")).toBe("0.172.0");
  expect(versionOf("not codex")).toBeUndefined();
});

test("broken is refused, older gets advice, the built release and newer run", () => {
  expect(judge("0.172.0", ["0.172.0"])).toEqual({
    kind: "broken",
    version: "0.172.0",
  });
  expect(judge("0.160.0")).toMatchObject({
    kind: "unsupported",
    version: "0.160.0",
  });
  expect(judge(undefined)).toMatchObject({
    kind: "unsupported",
    version: "unknown",
  });
  expect(judge(RELEASE)).toEqual({ kind: "supported", version: RELEASE });
  expect(judge("0.180.1")).toEqual({ kind: "supported", version: "0.180.1" });
});
