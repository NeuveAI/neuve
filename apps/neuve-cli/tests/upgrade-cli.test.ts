import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  releaseVersionSchema,
  runUpgradeCli,
  verifyChecksum,
} from "../src/upgrade-cli.ts";

const script = new TextEncoder().encode("echo verified\n");
const digest = createHash("sha256").update(script).digest("hex");
describe("release upgrade boundary", () => {
  // Versions become release tags, so ambiguous numeric identifiers and empty parts must refuse.
  test("accepts semantic versions and rejects malformed identifiers", () => {
    for (const version of ["0.1.0", "1.2.3-dev.abcdef", "1.2.3+001.0"])
      expect(releaseVersionSchema.safeParse(version).success).toBe(true);
    for (const version of ["01.2.3", "1.2.3-01", "1.2.3-alpha..beta", "v1.2.3"])
      expect(releaseVersionSchema.safeParse(version).success).toBe(false);
  });
  // Only a single matching digest authorizes executing a downloaded script.
  test("accepts the named script and refuses changed, missing or ambiguous bytes", () => {
    expect(() =>
      verifyChecksum(script, `${digest}  install.sh\n`, "install.sh"),
    ).not.toThrow();
    expect(() =>
      verifyChecksum(
        new TextEncoder().encode("changed"),
        `${digest}  install.sh\n`,
        "install.sh",
      ),
    ).toThrow("install.sh doesn't match SHA256SUMS, so it wasn't run.");
    expect(() =>
      verifyChecksum(script, `${digest}  other.sh\n`, "install.sh"),
    ).toThrow(
      "SHA256SUMS doesn't list install.sh exactly once, so it can't be checked.",
    );
    expect(() =>
      verifyChecksum(
        script,
        `${digest}  install.sh\n${digest}  install.sh\n`,
        "install.sh",
      ),
    ).toThrow(
      "SHA256SUMS doesn't list install.sh exactly once, so it can't be checked.",
    );
  });
  // Source runs must give the source-update instructions before any download.
  test("refuses a source invocation", async () => {
    await expect(runUpgradeCli([])).rejects.toThrow(
      "This neuve was built from source. Update it with git pull, then bun run install:cli.",
    );
  });
  // latest must reach the same source-copy guard as an invocation without a version.
  test("accepts latest as a version selection", async () => {
    await expect(runUpgradeCli(["--version", "latest"])).rejects.toThrow(
      "This neuve was built from source. Update it with git pull, then bun run install:cli.",
    );
  });
  // A version is a tag, never an unvalidated part of a download URL.
  test("refuses an invalid tag", async () => {
    await expect(
      runUpgradeCli(["--version", "../../anything"]),
    ).rejects.toThrow(
      "--version must be latest or a release tag such as v0.1.0.",
    );
  });
});
