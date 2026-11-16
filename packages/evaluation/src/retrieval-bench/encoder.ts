import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Data, Effect } from "effect";
import { COUNTER, type ModelEntry } from "./models.ts";

/**
 * The client side of the one long-lived model process (proposal, section 7). Requests are answered
 * in order over stdio. Weights are fetched from the pinned revision into the work directory, checked
 * against the registry's hashes, and removed by `deleteWeights` once a model's encodings are stored
 * (9.22). Only the counting tokenizer stays.
 */

export class EncoderFailed extends Data.TaggedError("EncoderFailed")<{
  readonly message: string;
}> {}

const ENCODER = resolve(import.meta.dir, "encoder/encoder.py");
/** Lower priority and bounded threads for the model process (6.10). */
export const ENCODER_NICE = 10;
export const ENCODER_THREADS = 4;

export const sha256File = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const snapshotDir = (work: string, hfId: string, revision: string) =>
  join(work, "models", `${hfId.replace("/", "--")}@${revision}`);

const download = async (url: string, target: string) => {
  await mkdir(dirname(target), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null)
    throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${target}.partial`;
  const writer = Bun.file(partial).writer();
  for await (const chunk of response.body) writer.write(chunk);
  await writer.end();
  await Bun.$`mv ${partial} ${target}`.quiet();
};

export interface FetchReport {
  readonly snapshot: string;
  readonly bytes: number;
  readonly seconds: number;
  readonly downloaded: boolean;
}

/** Fetches a model's pinned files and verifies every weight file's SHA-256. */
export const fetchModel = (work: string, model: ModelEntry) =>
  Effect.tryPromise({
    try: async (): Promise<FetchReport> => {
      const snapshot = snapshotDir(work, model.hfId, model.revision);
      const started = performance.now();
      let downloaded = false;
      for (const file of model.files) {
        const target = join(snapshot, file);
        if (existsSync(target)) continue;
        downloaded = true;
        await download(
          `https://huggingface.co/${model.hfId}/resolve/${model.revision}/${file}`,
          target,
        );
      }
      let bytes = 0;
      for (const file of model.files)
        bytes += (await stat(join(snapshot, file))).size;
      for (const [file, expected] of Object.entries(model.weights)) {
        const actual = await sha256File(join(snapshot, file));
        if (actual !== expected)
          throw new Error(
            `${model.hfId} ${file}: sha256 ${actual}, expected ${expected}`,
          );
      }
      return {
        snapshot,
        bytes,
        seconds: (performance.now() - started) / 1000,
        downloaded,
      };
    },
    catch: (cause) => new EncoderFailed({ message: String(cause) }),
  });

/** Removes a model's downloaded files (9.22). */
export const deleteWeights = (work: string, model: ModelEntry) =>
  Effect.promise(() =>
    rm(snapshotDir(work, model.hfId, model.revision), {
      recursive: true,
      force: true,
    }),
  );

/** The counting tokenizer: one small file, kept for the whole benchmark. */
export const fetchCounter = (work: string) =>
  Effect.tryPromise({
    try: async () => {
      const target = join(
        work,
        "tokenizer",
        `${COUNTER.id}-${COUNTER.sha256.slice(0, 12)}.json`,
      );
      if (!existsSync(target))
        await download(
          `https://huggingface.co/${COUNTER.hfId}/resolve/${COUNTER.revision}/${COUNTER.file}`,
          target,
        );
      const actual = await sha256File(target);
      if (actual !== COUNTER.sha256)
        throw new Error(`counting tokenizer sha256 ${actual}`);
      return target;
    },
    catch: (cause) => new EncoderFailed({ message: String(cause) }),
  });

type Reply = Record<string, unknown> & { kind: string };

export interface Encoded {
  readonly vectors: Float32Array;
  readonly dim: number;
  readonly tokens: ReadonlyArray<number>;
  readonly millis: number;
}

/** One model process. Requests are serialised: each waits for its own reply line. */
export class EncoderProcess {
  private readonly child: ReturnType<
    typeof Bun.spawn<"pipe", "pipe", "inherit">
  >;
  private readonly lines: AsyncIterator<string>;
  private next = 1;
  private queue: Promise<unknown> = Promise.resolve();
  loaded: string | undefined;

  private constructor(python: string) {
    // Politeness (6.10): the model process runs at lower priority; thread counts come from the
    // registry entry (torch) and are capped here for the tokenizer and BLAS pools.
    this.child = Bun.spawn(
      ["nice", "-n", String(ENCODER_NICE), python, "-I", "-u", ENCODER],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: {
          ...process.env,
          PYTHONHASHSEED: "0",
          OMP_NUM_THREADS: String(ENCODER_THREADS),
          MKL_NUM_THREADS: String(ENCODER_THREADS),
          VECLIB_MAXIMUM_THREADS: String(ENCODER_THREADS),
        },
      },
    );
    this.lines = (async function* (stream: ReadableStream<Uint8Array>) {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          yield buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
    })(this.child.stdout);
  }

  static start = (python: string) =>
    Effect.tryPromise({
      try: async () => {
        const process = new EncoderProcess(python);
        const hello = await process.read();
        if (hello.kind !== "hello")
          throw new Error(`encoder said ${JSON.stringify(hello)}`);
        return process;
      },
      catch: (cause) => new EncoderFailed({ message: String(cause) }),
    });

  private async read(): Promise<Reply> {
    const next = await this.lines.next();
    if (next.done) throw new Error("encoder process exited");
    return JSON.parse(next.value) as Reply;
  }

  private request(body: Record<string, unknown>, expect: string) {
    const run = this.queue.then(async () => {
      const id = this.next++;
      this.child.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
      await this.child.stdin.flush();
      const reply = await this.read();
      if (reply.kind !== expect)
        throw new Error(
          `${String(body["op"])}: ${JSON.stringify(reply).slice(0, 400)}`,
        );
      return reply;
    });
    this.queue = run.catch(() => undefined);
    return Effect.tryPromise({
      try: () => run,
      catch: (cause) => new EncoderFailed({ message: String(cause) }),
    });
  }

  counter = (path: string) =>
    this.request({ op: "counter", path, sha256: COUNTER.sha256 }, "counter");

  count = (texts: ReadonlyArray<string>) =>
    Effect.map(
      this.request({ op: "count", texts }, "counted"),
      (reply) => reply["counts"] as ReadonlyArray<number>,
    );

  load = (model: ModelEntry, snapshot: string, root: string) =>
    Effect.map(
      this.request(
        {
          op: "load",
          model: { ...model, format: undefined },
          snapshot,
          adapter:
            model.adapter === undefined
              ? null
              : {
                  path: resolve(root, model.adapter.path),
                  sha256: model.adapter.sha256,
                },
        },
        "loaded",
      ),
      (reply) => {
        this.loaded = model.id;
        return reply as Reply & {
          identity: Record<string, unknown>;
          loadMillis: number;
        };
      },
    );

  unload = () =>
    Effect.map(this.request({ op: "unload" }, "unloaded"), () => {
      this.loaded = undefined;
    });

  encode = (texts: ReadonlyArray<string>) =>
    Effect.flatMap(
      this.request({ op: "encode", texts }, "encoded"),
      (reply) => {
        const bytes = Buffer.from(reply["vectors"] as string, "base64");
        const vectors = new Float32Array(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ),
        );
        const dim = reply["dim"] as number;
        return vectors.length === dim * texts.length
          ? Effect.succeed<Encoded>({
              vectors,
              dim,
              tokens: reply["tokens"] as ReadonlyArray<number>,
              millis: reply["millis"] as number,
            })
          : Effect.fail(
              new EncoderFailed({
                message: `encoder returned ${vectors.length} floats for ${texts.length} texts`,
              }),
            );
      },
    );

  rerank = (query: string, documents: ReadonlyArray<string>) =>
    Effect.map(
      this.request({ op: "rerank", query, documents }, "reranked"),
      (reply) => ({
        scores: reply["scores"] as ReadonlyArray<number>,
        tokens: reply["tokens"] as ReadonlyArray<number>,
        truncated: reply["truncated"] as ReadonlyArray<boolean>,
        millis: reply["millis"] as number,
      }),
    );

  close = () =>
    Effect.promise(async () => {
      this.child.stdin.end();
      await this.child.exited;
    });
}

/**
 * The Modal transport (9.34): the same encoder (`encoder.py`, class `Loaded`) runs on Modal GPUs,
 * driven through packages/evaluation/modal/bench_gpu.py. Inputs are formatted here and written to
 * a local temporary directory that is removed after each call; only the request carries chunk
 * texts to Modal, and nothing is stored there but public weights and the adapter. Vectors come back
 * here and are stored by the caller under the registry entry's keys (device "cuda", float32).
 */
export const MODAL_DIR = resolve(import.meta.dir, "../../modal");

export interface ModalOptions {
  readonly gpu: string;
  readonly containers: number;
  readonly scratch: string;
  /** Padded tokens per GPU batch; 16,384 keeps the 4B model in fp32 within an L40S's 48 GB. */
  readonly batchTokens?: number;
}

export interface ModalReceipt {
  readonly items?: number;
  readonly pools?: number;
  readonly wallSeconds: number;
  readonly identity: Record<string, unknown> | null;
  readonly environment: Record<string, unknown> | null;
  readonly [key: string]: unknown;
}

const modalRun = async (entrypoint: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(
    ["uv", "run", "modal", "run", `bench_gpu.py::${entrypoint}`, ...args],
    {
      cwd: MODAL_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `modal ${entrypoint} exited ${code}: ${(stderr || stdout).slice(-1500)}`,
    );
};

const modalEntry = (model: ModelEntry) => {
  if (model.device !== "cuda")
    throw new Error(`${model.id} is not a cuda registry entry`);
  return { ...model, format: undefined };
};

/**
 * Checks what the remote encoder reports against the registry entry the vectors will be stored
 * under: revision, every weight file's hash, the adapter, device and dtype, and on the hardware
 * side the GPU class and TF32 off. Any difference refuses the whole response.
 */
export const checkModalIdentity = (
  model: ModelEntry,
  receipt: ModalReceipt,
  gpu: string,
) => {
  // Every container's identity and hardware, not only the last response's.
  const identities = receipt["identities"] as
    ReadonlyArray<Record<string, unknown>> | undefined;
  const environments = receipt["environments"] as
    ReadonlyArray<Record<string, unknown>> | undefined;
  const problems: Array<string> = [];
  if (identities === undefined || identities.length === 0)
    problems.push("no per-container identities");
  if (environments === undefined || environments.length === 0)
    problems.push("no per-container environments");
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  for (const identity of identities ?? []) {
    if (identity["hfId"] !== model.hfId)
      problems.push(`hfId ${String(identity["hfId"])}`);
    if (identity["revision"] !== model.revision)
      problems.push(`revision ${String(identity["revision"])}`);
    const files = identity["weightFiles"] as Record<string, string> | undefined;
    if (
      files === undefined ||
      !same(Object.keys(files).sort(), Object.keys(model.weights).sort()) ||
      Object.entries(model.weights).some(([file, hash]) => files[file] !== hash)
    )
      problems.push(`weight files ${JSON.stringify(files)}`);
    if ((identity["adapterSha256"] ?? null) !== (model.adapter?.sha256 ?? null))
      problems.push(`adapter ${String(identity["adapterSha256"])}`);
    if (identity["device"] !== model.device)
      problems.push(`device ${String(identity["device"])}`);
    if (identity["dtype"] !== model.dtype)
      problems.push(`dtype ${String(identity["dtype"])}`);
  }
  for (const environment of environments ?? []) {
    if (environment["tf32"] !== false)
      problems.push(`tf32 ${String(environment["tf32"])}`);
    if (!String(environment["gpu"] ?? "").includes(gpu))
      problems.push(`gpu ${String(environment["gpu"])}`);
  }
  if (problems.length > 0)
    throw new Error(
      `${model.id}: the Modal response does not match the registry entry: ${problems.join("; ")}`,
    );
};

export const modalEncode = (
  model: ModelEntry,
  items: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  options: ModalOptions,
) =>
  Effect.tryPromise({
    try: async () => {
      const directory = await mkdtemp(join(options.scratch, "modal-encode-"));
      try {
        const modelFile = join(directory, "model.json");
        const input = join(directory, "items.jsonl");
        const output = join(directory, "vectors.jsonl");
        await Bun.write(modelFile, JSON.stringify(modalEntry(model)));
        await Bun.write(
          input,
          `${items.map((item) => JSON.stringify(item)).join("\n")}\n`,
        );
        await modalRun("encode_items_main", [
          "--model-file",
          modelFile,
          "--items",
          input,
          "--out",
          output,
          "--gpu",
          options.gpu,
          "--containers",
          String(options.containers),
          "--batch-tokens",
          String(options.batchTokens ?? 65536),
        ]);
        const vectors = new Map<string, Float32Array>();
        for (const line of (await Bun.file(output).text()).split("\n")) {
          if (line === "") continue;
          const row = JSON.parse(line) as { id: string; vector: string };
          const bytes = Buffer.from(row.vector, "base64");
          vectors.set(
            row.id,
            new Float32Array(
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ),
            ),
          );
        }
        if (vectors.size !== items.length)
          throw new Error(
            `modal returned ${vectors.size} vectors for ${items.length} items`,
          );
        const receipt = JSON.parse(
          await Bun.file(`${output}.receipt.json`).text(),
        ) as ModalReceipt;
        checkModalIdentity(model, receipt, options.gpu);
        return { vectors, receipt };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    catch: (cause) => new EncoderFailed({ message: String(cause) }),
  });

export const modalRerank = (
  model: ModelEntry,
  pools: ReadonlyArray<{
    readonly id: string;
    readonly query: string;
    readonly documents: ReadonlyArray<string>;
  }>,
  options: ModalOptions,
) =>
  Effect.tryPromise({
    try: async () => {
      const directory = await mkdtemp(join(options.scratch, "modal-rerank-"));
      try {
        const modelFile = join(directory, "model.json");
        const input = join(directory, "pools.jsonl");
        const output = join(directory, "scores.jsonl");
        await Bun.write(modelFile, JSON.stringify(modalEntry(model)));
        await Bun.write(
          input,
          `${pools.map((pool) => JSON.stringify(pool)).join("\n")}\n`,
        );
        await modalRun("rerank_items_main", [
          "--model-file",
          modelFile,
          "--items",
          input,
          "--out",
          output,
          "--gpu",
          options.gpu,
          "--containers",
          String(options.containers),
        ]);
        const scores = new Map<
          string,
          {
            scores: ReadonlyArray<number>;
            tokens: ReadonlyArray<number>;
            truncated: ReadonlyArray<boolean>;
            seconds: number;
          }
        >();
        for (const line of (await Bun.file(output).text()).split("\n")) {
          if (line === "") continue;
          const row = JSON.parse(line) as {
            id: string;
            scores: Array<number>;
            tokens: Array<number>;
            truncated: Array<boolean>;
            seconds: number;
          };
          scores.set(row.id, row);
        }
        const receipt = JSON.parse(
          await Bun.file(`${output}.receipt.json`).text(),
        ) as ModalReceipt;
        checkModalIdentity(model, receipt, options.gpu);
        return { scores, receipt };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    catch: (cause) => new EncoderFailed({ message: String(cause) }),
  });
