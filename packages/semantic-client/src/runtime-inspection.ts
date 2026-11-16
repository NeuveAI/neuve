import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { Schema } from "effect";
import {
  BASE_REVISION,
  BASE_WEIGHTS_SHA256,
  WORKER_SHA256,
  fingerprintBaseIdentity,
  type BaseIdentity,
} from "./index.ts";

const versionsSchema = Schema.Struct({
  python: Schema.Literal("3.13.5"),
  numpy: Schema.Literal("2.5.3"),
  torch: Schema.Literal("2.14.1"),
  transformers: Schema.Literal("5.19.0"),
  sentenceTransformers: Schema.Literal("6.1.0"),
});

const fileDigest = async (path: string, signal: AbortSignal) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path, { signal }))
    hash.update(bytes);
  return hash.digest("hex");
};

const pythonVersions = async (python: string, signal: AbortSignal) => {
  const code = [
    "import importlib.metadata as m,json,platform",
    'print(json.dumps({"python":platform.python_version(),"numpy":m.version("numpy"),"torch":m.version("torch"),"transformers":m.version("transformers"),"sentenceTransformers":m.version("sentence-transformers")}))',
  ].join("\n");
  return await new Promise<typeof versionsSchema.Type>((resolve, reject) => {
    const child = spawn(python, ["-I", "-c", code], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "";
    let bytes = 0;
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes > 4096) {
        fail(new Error("Semantic runtime metadata exceeds its limit."));
        return;
      }
      output += part.toString("utf8");
    });
    child.stderr.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes > 4096)
        fail(new Error("Semantic runtime diagnostics exceed their limit."));
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) {
        fail(new Error("Semantic runtime metadata could not be inspected."));
        return;
      }
      try {
        resolve(Schema.decodeUnknownSync(versionsSchema)(JSON.parse(output)));
      } catch (error) {
        fail(error);
      }
    });
  });
};

export const inspectBaseRuntime = async (input: {
  pythonExecutable: string;
  snapshotPath: string;
  workerPath: string;
  signal: AbortSignal;
}) => {
  if (basename(input.snapshotPath) !== BASE_REVISION)
    throw new Error("Semantic snapshot revision does not match BASE.");
  const timeout = AbortSignal.any([input.signal, AbortSignal.timeout(30000)]);
  const versions = await pythonVersions(input.pythonExecutable, timeout);
  const files = {
    weightsSha256: "model.safetensors",
    tokenizerSha256: "tokenizer.json",
    tokenizerConfigSha256: "tokenizer_config.json",
    configSha256: "config.json",
    sentenceTransformerConfigSha256: "config_sentence_transformers.json",
    sentenceBertConfigSha256: "sentence_bert_config.json",
    processorConfigSha256: "processor_config.json",
    preprocessorConfigSha256: "preprocessor_config.json",
    poolingConfigSha256: "1_Pooling/config.json",
    normalizeConfigSha256: "2_Normalize/config.json",
    modulesSha256: "modules.json",
  };
  const digests = new Map<string, string>();
  for (const [key, path] of Object.entries(files))
    digests.set(key, await fileDigest(join(input.snapshotPath, path), timeout));
  const digest = (key: keyof typeof files) => {
    const value = digests.get(key);
    if (!value) throw new Error("Semantic artifact metadata is incomplete.");
    return value;
  };
  if (digest("weightsSha256") !== BASE_WEIGHTS_SHA256)
    throw new Error("Semantic model weights do not match BASE.");
  const workerSha256 = await fileDigest(input.workerPath, timeout);
  if (workerSha256 !== WORKER_SHA256)
    throw new Error("Semantic worker does not match the production worker.");
  const identity: BaseIdentity = {
    modelId: "google/embeddinggemma-2",
    revision: BASE_REVISION,
    weightsSha256: BASE_WEIGHTS_SHA256,
    tokenizerSha256: digest("tokenizerSha256"),
    tokenizerConfigSha256: digest("tokenizerConfigSha256"),
    configSha256: digest("configSha256"),
    sentenceTransformerConfigSha256: digest("sentenceTransformerConfigSha256"),
    sentenceBertConfigSha256: digest("sentenceBertConfigSha256"),
    processorConfigSha256: digest("processorConfigSha256"),
    preprocessorConfigSha256: digest("preprocessorConfigSha256"),
    poolingConfigSha256: digest("poolingConfigSha256"),
    normalizeConfigSha256: digest("normalizeConfigSha256"),
    modulesSha256: digest("modulesSha256"),
    workerSha256,
    ...versions,
    device: "cpu",
    dtype: "float32",
    dimension: 768,
    maxTokens: 8192,
    recipe: "embeddinggemma2-text-prefix-v1",
  };
  return {
    encoderFingerprint: fingerprintBaseIdentity(identity),
    identity,
  };
};
