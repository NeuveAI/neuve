import { Blobs, Computations } from "@neuve/records-core";
import { Effect, Option } from "effect";

type Spec = Parameters<typeof Computations.computationKey>[0];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A stored computation's output bytes, if it has one (5.4: look up before computing). */
export const readStored = (spec: Spec) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const held = yield* store.lookup(Computations.computationKey(spec).key);
    if (Option.isNone(held)) return Option.none<Uint8Array>();
    const read = yield* (yield* Blobs.BlobStore).get(held.value.outputHash);
    return read._tag === "Present"
      ? Option.some(read.bytes)
      : Option.none<Uint8Array>();
  });

export const readStoredJson = <T>(spec: Spec) =>
  Effect.map(
    readStored(spec),
    Option.map((bytes) => JSON.parse(decoder.decode(bytes)) as T),
  );

/** Runs `compute` only when the computation has no stored output, and returns the JSON value. */
export const storedJson = <T, E, R>(
  spec: Spec,
  compute: Effect.Effect<T, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    let computed: T | undefined;
    const result = yield* store.run(
      spec,
      Effect.map(compute, (value) => {
        computed = value;
        return {
          bytes: encoder.encode(JSON.stringify(value)),
          mediaType: "application/json",
        };
      }),
    );
    return {
      value: computed ?? (JSON.parse(decoder.decode(result.output)) as T),
      status: result.status,
    };
  });

export const asFloats = (bytes: Uint8Array) =>
  new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

export const floatBytes = (vectors: Float32Array) =>
  new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
