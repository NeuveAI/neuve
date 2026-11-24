import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { nameDiagnosticPath } from "./records-cli.ts";
import {
  SemanticClient,
  scorePool,
  type Encoded,
  type PoolCandidate,
  type PoolResult,
} from "@neuve/semantic-client";

const inputSchema = z
  .strictObject({
    version: z.literal(1),
    inputs: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(256),
          role: z.enum([
            "code-query",
            "document-query",
            "document",
            "classification",
            "similarity",
          ]),
          text: z.string().min(1),
          title: z.string().min(1).optional(),
        }),
      )
      .min(1)
      .max(32),
    pool: z
      .strictObject({
        queryId: z.string().min(1),
        candidateIds: z.array(z.string().min(1)).min(1).max(31),
        limit: z.number().int().positive().max(31),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const ids = new Set(value.inputs.map((item) => item.id));
    if (ids.size !== value.inputs.length)
      context.addIssue({ code: "custom", message: "Input IDs must be unique" });
    if (
      value.pool &&
      (!ids.has(value.pool.queryId) ||
        value.pool.candidateIds.some(
          (id) => !ids.has(id) || id === value.pool?.queryId,
        ) ||
        new Set(value.pool.candidateIds).size !==
          value.pool.candidateIds.length)
    )
      context.addIssue({
        code: "custom",
        message: "Pool members must name distinct supplied inputs",
      });
  });

export const runSemanticCli = async (
  args: readonly string[],
): Promise<number> => {
  const options = new Map<string, string>();
  const allowed = new Set([
    "--input",
    "--python",
    "--snapshot",
    "--worker",
    "--variant",
    "--artifact-reference",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key ||
      !allowed.has(key) ||
      options.has(key) ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error("Invalid semantic option. See neuve --help.");
    options.set(key, value);
  }
  const required = (key: string): string => {
    const value = options.get(key);
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const variant = z.enum(["BASE", "TUNED"]).parse(required("--variant"));
  if (variant === "BASE" && options.has("--artifact-reference"))
    throw new Error("BASE does not accept a tuned artifact reference.");
  const pythonExecutable = required("--python");
  const snapshotPath = required("--snapshot");
  const workerPath = required("--worker");
  for (const path of [pythonExecutable, snapshotPath, workerPath])
    if (!isAbsolute(path))
      throw new Error("Semantic runtime paths must be absolute.");
  const inputPath = resolve(required("--input"));
  const handle = await open(
    inputPath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    throw new Error(nameDiagnosticPath(error, "--input", inputPath));
  });
  let input: z.infer<typeof inputSchema>;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("Semantic input must be a regular file.");
    const maximumBytes = 512 * 1024;
    if (metadata.size > maximumBytes)
      throw new Error("Semantic input exceeds 512 KiB.");
    const bytes = Buffer.alloc(maximumBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, null);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used > maximumBytes || used !== metadata.size)
      throw new Error("Semantic input changed or exceeds its byte limit.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, used),
    );
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const reason = error.message.replace(
        /(Unexpected (?:identifier|token)|Unrecognized token|Invalid escape character) .+$/s,
        "$1",
      );
      throw new Error(`--input. ${reason}`);
    }
    const parsed = inputSchema.safeParse(payload, {
      error: (issue) =>
        issue.code === "unrecognized_keys" ? "Unrecognized fields" : undefined,
    });
    if (!parsed.success)
      throw new Error(
        `--input has invalid fields.\n${z.prettifyError(parsed.error)}`,
      );
    input = parsed.data;
  } finally {
    await handle.close();
  }
  const controller = new AbortController();
  let interrupted: number | undefined;
  const stop = (code: number) => {
    interrupted ??= code;
    controller.abort();
  };
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  const client = new SemanticClient({
    pythonExecutable,
    snapshotPath,
    workerPath,
    variant:
      variant === "BASE"
        ? { kind: "base" }
        : {
            kind: "tuned",
            artifactReference: required("--artifact-reference"),
          },
    startupTimeoutMs: 60000,
    requestTimeoutMs: 60000,
  });
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const result = await client.encodeBatch(
      input.inputs.map(({ role, text, title }) => ({
        role,
        text,
        ...(title === undefined ? {} : { title }),
      })),
      controller.signal,
    );
    if (controller.signal.aborted) return interrupted ?? 130;
    if (result.kind === "refusal") {
      await Bun.write(
        Bun.stdout,
        `${JSON.stringify({ version: 1, variant, ...result, stats: client.stats() })}\n`,
      );
      return 1;
    }
    const byId = new Map<string, Encoded>();
    input.inputs.forEach((item, index) => {
      const encoded = result.items[index];
      if (!encoded) throw new Error("Semantic encoder omitted an input.");
      byId.set(item.id, encoded);
    });
    let pool: PoolResult<{ inputId: string }> | undefined;
    if (input.pool) {
      const query = byId.get(input.pool.queryId);
      if (!query) throw new Error("Semantic query input is unavailable.");
      const candidates: PoolCandidate<{ inputId: string }>[] =
        input.pool.candidateIds.map((id) => {
          const encoded = byId.get(id);
          if (!encoded)
            throw new Error("Semantic candidate input is unavailable.");
          return { occurrenceId: id, reference: { inputId: id }, encoded };
        });
      pool = scorePool({ query, candidates, limit: input.pool.limit });
    }
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({
        version: 1,
        variant,
        kind: "encoded",
        sourceQualification: "not-established",
        interpretation: "caller-supplied-inputs-and-pool-only",
        inputs: [...byId].map(([id, encoded]) => ({ id, encoded })),
        usage: result.usage,
        stats: client.stats(),
        ...(pool === undefined ? {} : { pool }),
      })}\n`,
    );
    return pool?.kind === "refusal" ? 1 : 0;
  } finally {
    await client.close();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
};
