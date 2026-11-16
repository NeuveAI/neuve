import { tmpdir } from "node:os";
import { outlineExecutable } from "../../../harness/src/graph-outline.ts";
import {
  observeGraphProvider,
  readGraphSymbols,
  type GraphInspectionEvidence,
  type GraphProviderObservation,
  type GraphFileObservation,
} from "@neuve/graph-client";
import { Effect } from "effect";
import {
  chunkFile,
  chunkerKey,
  splitLines,
} from "../../../harness/src/chunker.ts";
export type Chunk = ReturnType<typeof chunkFile>["chunks"][number] & {
  readonly text: string;
};
export type BenchChunkedFile = Omit<ReturnType<typeof chunkFile>, "chunks"> & {
  readonly chunks: readonly Chunk[];
};
export interface BenchChunkVariant {
  readonly key: ReturnType<typeof chunkerKey>;
  readonly symbolBatchOutputBytes?: number[];
  readonly provider: GraphProviderObservation;
  readonly chunk: (
    files: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
    signal?: AbortSignal,
  ) => Promise<ReadonlyMap<string, BenchChunkedFile>>;
}
export const graphChunkVariant = async (
  executable: string,
  temporaryParent: string,
  evidence: GraphInspectionEvidence = {},
  onChunked?: (
    file: Readonly<{
      path: string;
      text: string;
      observation: GraphFileObservation | undefined;
      chunked: ReturnType<typeof chunkFile>;
    }>,
  ) => void,
  signal?: AbortSignal,
): Promise<BenchChunkVariant> => {
  const provider = await Effect.runPromise(
    observeGraphProvider(
      { executable },
      { ...evidence, temporaryParent, reuseIdentity: true },
    ),
    { signal },
  );
  const symbolBatchOutputBytes: number[] = [];
  return {
    key: chunkerKey(provider),
    provider,
    symbolBatchOutputBytes,
    chunk: async (files, signal) => {
      const observations = await readGraphSymbols(
        {
          executable,
          temporaryParent,
          files,
          ...(signal === undefined ? {} : { signal }),
        },
        evidence,
      );
      if (
        observations.provider.executable.sha256 !== provider.executable.sha256
      )
        throw new Error(
          "Graph provider changed after variant key was computed.",
        );
      symbolBatchOutputBytes.push(...(observations.batchOutputBytes ?? []));
      const result = new Map<string, BenchChunkedFile>();
      for (const file of files) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          file.bytes,
        );
        const lines = splitLines(text);
        const observation = observations.files.get(file.path);
        const chunked = chunkFile(file.path, text, {
          kind: "available",
          provider,
          observation,
        });
        onChunked?.({ path: file.path, text, observation, chunked });
        result.set(file.path, {
          ...chunked,
          chunks: chunked.chunks.map((chunk) => ({
            ...chunk,
            text: lines.slice(chunk.startLine - 1, chunk.endLine).join(""),
          })),
        });
      }
      return result;
    },
  };
};

export const defaultGraphVariant = (signal?: AbortSignal) =>
  graphChunkVariant(
    outlineExecutable(),
    process.env.TMPDIR ?? tmpdir(),
    {},
    undefined,
    signal,
  );
