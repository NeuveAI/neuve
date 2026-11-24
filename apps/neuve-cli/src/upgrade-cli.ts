import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isCompiled } from "@neuve/harness/compiled";
import { RELEASE_TARGETS, releaseVersionSchema } from "./release-metadata.ts";

export { releaseVersionSchema };

declare global {
  const NEUVE_BUILD_VERSION: string | undefined;
}

export const UPGRADE_HELP = `Usage: neuve upgrade [--version vX.Y.Z]
Upgrade to the latest release, or the --version tag, through its checksum-checked install script.`;

const validTag = (tag: string) =>
  tag.startsWith("v") && releaseVersionSchema.safeParse(tag.slice(1)).success;

export const releaseSchema = z.object({
  schemaVersion: z.literal(1),
  version: releaseVersionSchema,
  target: z.enum(RELEASE_TARGETS),
  cliSha256: z.string().regex(/^[a-f0-9]{64}$/),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
});

export const verifyChecksum = (
  bytes: Uint8Array,
  sums: string,
  name: string,
) => {
  const matches = sums
    .split(/\r?\n/)
    .filter((line) => line.slice(66) === name && /^[a-f0-9]{64}  /.test(line));
  if (matches.length !== 1)
    throw new Error(
      `SHA256SUMS doesn't list ${name} exactly once, so it can't be checked.`,
    );
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    matches[0]?.slice(0, 64)
  )
    throw new Error(`${name} doesn't match SHA256SUMS, so it wasn't run.`);
};

const download = async (url: string): Promise<Uint8Array> => {
  const parsed = URL.parse(url);
  if (parsed?.protocol === "file:")
    return readFile(parsed).catch(() => {
      throw new Error(
        "Could not read the release files. Check --version and NEUVE_DOWNLOAD_BASE.",
      );
    });
  if (parsed?.protocol !== "https:")
    throw new Error("NEUVE_DOWNLOAD_BASE must start with https:// or file://.");
  const response = await fetch(parsed).catch(() => {
    throw new Error(
      "Could not reach the release server. Check NEUVE_DOWNLOAD_BASE.",
    );
  });
  if (!response.ok)
    throw new Error(
      `Could not download the release files (HTTP ${response.status}). Check that --version names an available release.`,
    );
  return new Uint8Array(await response.arrayBuffer());
};

export const runUpgradeCli = async (
  args: readonly string[],
): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    options: { version: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) {
    await Bun.write(Bun.stdout, `${UPGRADE_HELP}\n`);
    return 0;
  }
  if (
    values.version !== undefined &&
    values.version !== "latest" &&
    !validTag(values.version)
  )
    throw new Error(
      "--version must be latest or a release tag such as v0.1.0.",
    );
  const prefix = resolve(dirname(await realpath(process.execPath)), "..");
  if (!isCompiled() || typeof NEUVE_BUILD_VERSION !== "string")
    throw new Error(
      "This neuve was built from source. Update it with git pull, then bun run install:cli.",
    );
  const releasePath = join(prefix, "lib/neuve/release.json");
  const releaseEntry = await lstat(releasePath).catch(() => null);
  if (releaseEntry !== null && !releaseEntry.isFile())
    throw new Error(
      "This install's release.json is invalid. Reinstall it with the install script.",
    );
  const release = await readFile(releasePath, "utf8").catch(() => null);
  if (release === null)
    throw new Error(
      "This neuve was built from source. Update it with git pull, then bun run install:cli.",
    );
  let value: unknown;
  try {
    value = JSON.parse(release);
  } catch {
    value = null;
  }
  const parsed = releaseSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "This install's release.json is invalid. Reinstall it with the install script.",
    );
  const metadata = parsed.data;
  if (
    metadata.version !== NEUVE_BUILD_VERSION ||
    createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex") !== metadata.cliSha256
  )
    throw new Error(
      "This neuve was built from source. Update it with git pull, then bun run install:cli.",
    );
  const base = (
    process.env.NEUVE_DOWNLOAD_BASE ??
    `https://github.com/${metadata.repository}/releases`
  ).replace(/\/$/, "");
  const version = values.version ?? process.env.NEUVE_VERSION ?? "latest";
  if (version !== "latest" && !validTag(version))
    throw new Error(
      "--version must be latest or a release tag such as v0.1.0.",
    );
  const location =
    version === "latest" ? "latest/download" : `download/${version}`;
  const [script, sums] = await Promise.all([
    download(`${base}/${location}/install.sh`),
    download(`${base}/${location}/SHA256SUMS`),
  ]);
  verifyChecksum(script, new TextDecoder().decode(sums), "install.sh");
  const temporary = await mkdtemp(join(tmpdir(), "neuve-upgrade-"));
  try {
    const path = join(temporary, "install.sh");
    await writeFile(path, script, { mode: 0o600 });
    const child = Bun.spawn(
      [
        "sh",
        path,
        "--prefix",
        prefix,
        ...(version === "latest" ? [] : ["--version", version]),
      ],
      {
        env: {
          ...process.env,
          NEUVE_REPO: metadata.repository,
          NEUVE_VERSION: version,
          NEUVE_NO_MODIFY_PATH: "1",
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const stop = () => child.kill("SIGTERM");
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
      return await child.exited;
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
