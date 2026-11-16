import { Effect } from "effect";
import type { BaseCorpus } from "./corpus.ts";
import {
  encodeUnits,
  encodeUnitId,
  importChunkVector,
  modelInput,
  pendingUnits,
} from "./dense.ts";
import {
  EncoderProcess,
  fetchCounter,
  modalEncode,
  type ModalOptions,
} from "./encoder.ts";
import type { ModelEntry } from "./models.ts";
import { chunkTokens } from "./tokens.ts";

/**
 * 9.34: encodes on Modal every chunk unit of `bases` the model has no stored vector for, and stores
 * the vectors here under the registry entry's keys. Units are counted with the shared token counter
 * and sent in shards of `shard` units, each shard's vectors stored before the next is sent. Shared
 * by `bench:m4:arms modal-encode` and the leads mode (leads.ts).
 */
export const encodePendingChunks = (input: {
  readonly model: ModelEntry;
  readonly bases: ReadonlyArray<BaseCorpus>;
  readonly python: string;
  readonly work: string;
  readonly options: ModalOptions;
  readonly shard: number;
  readonly label: string;
  readonly log: (line: string) => void;
}) =>
  Effect.gen(function* () {
    const { model, bases, options, shard, label, log } = input;
    const counter = yield* EncoderProcess.start(input.python);
    yield* counter.counter(yield* fetchCounter(input.work));
    const tokens = new Map<string, ReadonlyArray<number>>();
    for (const base of bases) yield* chunkTokens(base, counter, tokens);
    yield* counter.close();
    const units = encodeUnits(bases, tokens);
    const pending = yield* pendingUnits(model, units);
    log(
      `${label}: ${bases.length} bases, ${units.length} units, ${pending.length} pending; ${JSON.stringify(options)}`,
    );
    const shards: Array<unknown> = [];
    let done = 0;
    for (let offset = 0; offset < pending.length; offset += shard) {
      const part = pending.slice(offset, offset + shard);
      const items: Array<{ id: string; text: string }> = [];
      for (const unit of part)
        items.push({
          id: encodeUnitId(unit),
          text: yield* modelInput(model, unit),
        });
      const { vectors, receipt } = yield* modalEncode(model, items, options);
      for (const unit of part)
        yield* importChunkVector(
          model,
          unit.hash,
          unit.path,
          vectors.get(encodeUnitId(unit)) as Float32Array,
        );
      done += part.length;
      shards.push({ ...receipt, identity: undefined });
      log(
        `${label}: ${done}/${pending.length} stored; shard wall ${receipt.wallSeconds.toFixed(0)} s, ${JSON.stringify(receipt.environment)}`,
      );
      if (shards.length === 1)
        log(`${label}: identity ${JSON.stringify(receipt.identity)}`);
    }
    return { units: units.length, encoded: pending.length, shards };
  });

/** Round-2 E0 observation on L40S, used only for no-model planning. */
export const E0_UNITS_PER_SECOND = 75_686 / 811;
