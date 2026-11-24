import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_TARGETS } from "../src/release-metadata.ts";
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

  // A missing release asset needs its filesystem cause. The download base and version can be private.
  test("keeps the release-file diagnostic without printing the supplied location", async () => {
    const root = await mkdtemp(join(tmpdir(), "neuve-upgrade-cli-"));
    try {
      const version = "1.0.0";
      const tag = "v1.2.3-private";
      const prefix = join(root, "prefix");
      const binary = join(prefix, "bin", "neuve");
      await mkdir(join(prefix, "bin"), { recursive: true });
      const build = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../scripts/build.ts"),
          "--version",
          version,
          "--outfile",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      await Bun.write(
        join(prefix, "lib", "neuve", "release.json"),
        JSON.stringify({
          schemaVersion: 1,
          version,
          target: RELEASE_TARGETS[0],
          cliSha256: createHash("sha256")
            .update(await Bun.file(binary).bytes())
            .digest("hex"),
          repository: "example/neuve",
        }),
      );
      const releases = join(root, "private mirror");
      await Bun.write(join(releases, "download", tag, "SHA256SUMS"), "");
      const result = Bun.spawnSync([binary, "upgrade", "--version", tag], {
        env: {
          ...process.env,
          NEUVE_DOWNLOAD_BASE: pathToFileURL(releases).href,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const error = result.stderr.toString();
      expect(result.exitCode).toBe(2);
      expect(error).toMatch(
        /ENOENT: no such file or directory, open install\.sh for --version/i,
      );
      expect(error).not.toContain(tag);
      expect(error).not.toContain(releases);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
