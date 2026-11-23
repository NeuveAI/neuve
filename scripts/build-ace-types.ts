import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
} from "@microsoft/api-extractor";
import {
  readStorageProfile,
  StorageProfile,
  prepareStorage,
  spawnEnvironment,
  validateStorageProfile,
} from "./pi-storage.ts";

const source = resolve(import.meta.dirname, "..");
const supplied = process.env.NEUVE_WORKSPACE_PROFILE;
const profile = supplied
  ? StorageProfile.parse(JSON.parse(supplied))
  : await readStorageProfile(source);
const storage = await prepareStorage(
  await validateStorageProfile(profile, { checkout: source }),
);
const build = await mkdtemp(join(storage.paths.builds, "ace-types-"));
const compiler = join(
  source,
  "apps/app/node_modules/@typescript/native-preview/bin/tsgo.js",
);
try {
  for (const path of [
    "packages/records-schema",
    "packages/runtime",
    "services/directory",
    "packages/channel",
    "apps/neuve-host",
  ]) {
    const output = join(build, path);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        compiler,
        "--project",
        join(source, path, "tsconfig.json"),
        "--noEmit",
        "false",
        "--noEmitOnError",
        "--declaration",
        "--emitDeclarationOnly",
        "--rootDir",
        source,
        "--outDir",
        output,
      ],
      {
        cwd: source,
        env: spawnEnvironment(storage, process.env),
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const code = await child.exited;
    if (code !== 0) throw new Error(`${path} declaration build exited ${code}`);
    const target = join(source, path, ".types");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(join(output, path), target, { recursive: true });
    if (path === "packages/channel") {
      const rolled = join(build, "channel-protocol.d.ts");
      const config = ExtractorConfig.prepare({
        configObjectFullPath: join(output, "api-extractor.json"),
        packageJsonFullPath: join(source, path, "package.json"),
        configObject: {
          projectFolder: join(source, path),
          mainEntryPointFilePath: join(target, "src/protocol.d.ts"),
          bundledPackages: ["@earendil-works/pi-ai", "@neuve/review-rules"],
          compiler: { tsconfigFilePath: join(source, path, "tsconfig.json") },
          apiReport: { enabled: false },
          docModel: { enabled: false },
          dtsRollup: { enabled: true, untrimmedFilePath: rolled },
          tsdocMetadata: { enabled: false },
          newlineKind: "lf",
          messages: {
            extractorMessageReporting: {
              default: { logLevel: ExtractorLogLevel.Warning },
              "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
            },
          },
        },
      });
      const result = Extractor.invoke(config, { localBuild: true });
      if (!result.succeeded)
        throw new Error("Channel protocol declaration rollup failed");
      await cp(rolled, join(target, "src/protocol.d.ts"));
    }
  }
} finally {
  await rm(build, { recursive: true, force: true });
}
