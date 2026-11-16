import { createHash } from "node:crypto";
import { Blobs } from "@neuve/records-core";
import { Effect, Option } from "effect";
import { chunkText, type BaseCorpus } from "./corpus.ts";
import type { EncoderProcess } from "./encoder.ts";
import { COUNTER } from "./models.ts";
import { readStoredJson, storedJson } from "./stored.ts";

/**
 * Token counts in the counting tokenizer (models.ts, COUNTER), stored as computations so nothing is
 * counted twice (5.4): one per B1 chunk computation for chunk regions, and one per region text for
 * regions that are not shared chunks (Graph regions).
 */

const COUNTER_CONFIG = { tokenizer: COUNTER.id, sha256: COUNTER.sha256 };

const chunkTokensSpec = (chunkKey: string) => ({
  op: "bench.chunk-tokens",
  opVersion: 1,
  inputs: { chunks: `computation:${chunkKey}` },
  config: COUNTER_CONFIG,
});

const textTokensSpec = (hash: string) => ({
  op: "bench.text-tokens",
  opVersion: 1,
  inputs: { text: `blob:${hash}` },
  config: COUNTER_CONFIG,
});

const needCounter = (counter: EncoderProcess | undefined, what: string) =>
  counter === undefined
    ? Effect.die(new Error(`${what} is not stored and no counter is running`))
    : Effect.succeed(counter);

/** Counts every file's chunks once; fills `known`, keyed by chunk computation key. */
export const chunkTokens = (
  base: BaseCorpus,
  counter: EncoderProcess | undefined,
  known: Map<string, ReadonlyArray<number>>,
) =>
  Effect.gen(function* () {
    for (const file of base.files) {
      if (known.has(file.chunkKey)) continue;
      const spec = chunkTokensSpec(file.chunkKey);
      const stored = yield* readStoredJson<ReadonlyArray<number>>(spec);
      if (Option.isSome(stored)) {
        known.set(file.chunkKey, stored.value);
        continue;
      }
      const running = yield* needCounter(
        counter,
        `chunk tokens for ${file.path}`,
      );
      const texts: Array<string> = [];
      for (const hash of file.hashes) texts.push(yield* chunkText(hash));
      const { value } = yield* storedJson(spec, running.count(texts));
      known.set(file.chunkKey, value);
    }
    return known;
  });

/** Token count of an arbitrary region text, stored once per text (the text is kept as a blob). */
export const textTokens = (text: string, counter: EncoderProcess | undefined) =>
  Effect.gen(function* () {
    const hash = createHash("sha256").update(text).digest("hex");
    const stored = yield* readStoredJson<number>(textTokensSpec(hash));
    if (Option.isSome(stored)) return stored.value;
    const running = yield* needCounter(counter, "region tokens");
    yield* (yield* Blobs.BlobStore).put({
      bytes: new TextEncoder().encode(text),
      mediaType: "text/plain; charset=utf-8",
      retention: "durable",
    });
    const { value } = yield* storedJson(
      textTokensSpec(hash),
      Effect.map(running.count([text]), (counts) => counts[0] ?? 0),
    );
    return value;
  });
