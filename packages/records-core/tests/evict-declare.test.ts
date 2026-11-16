// Why (design `records-evictable-outputs`, decision 12.45): declaring a kind recomputable is the
// switch that makes its rows evictable, so declaring the wrong kind must be refused where it can be
// seen: a kind with an output a model produced, or one an event names. Declaring is called by its
// producer on every run, so a repeated declaration must write nothing, and a new cap is an update.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { Computations } from "../src/index.ts";
import {
  OP,
  count,
  eventNaming,
  outputOf,
  specOf,
  withStores,
} from "./evict-support.ts";
import { freshLocation, removeTemporaryDirectories } from "./support.ts";

afterAll(removeTemporaryDirectories);

test("a declaration is idempotent, a new cap updates it, and a model-produced or event-named kind is refused", async () => {
  const location = freshLocation();
  const result = await withStores(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.run(specOf(OP, "one"), outputOf("one"));
      const first = yield* store.declareKind({ op: OP, capBytes: 1_000 });
      const again = yield* store.declareKind({ op: OP, capBytes: 1_000 });
      const raised = yield* store.declareKind({ op: OP, capBytes: 2_000 });

      yield* store.run(
        specOf("test.modelled", "one"),
        Effect.succeed({ ...(yield* outputOf("m")), model: "a-model" }),
      );
      const modelled = yield* Effect.flip(
        store.declareKind({ op: "test.modelled", capBytes: 0 }),
      );
      const named = yield* store.run(
        specOf("test.named", "one"),
        outputOf("n"),
      );
      yield* eventNaming(`computation:${named.computation.key}`);
      const eventNamed = yield* Effect.flip(
        store.declareKind({ op: "test.named", capBytes: 0 }),
      );
      const invalid = yield* Effect.flip(
        store.declareKind({ op: "Not An Op", capBytes: 0 }),
      );
      const negative = yield* Effect.flip(
        store.declareKind({ op: OP, capBytes: -1 }),
      );
      return {
        first,
        again,
        raised,
        modelled: { tag: modelled._tag, message: modelled.message },
        eventNamed: { tag: eventNamed._tag, message: eventNamed.message },
        invalid: invalid._tag,
        negative: negative._tag,
        declarations: yield* store.kinds,
        rows: yield* count("SELECT count(*) AS n FROM computation_kinds"),
      };
    }),
  );
  expect(result.first).toMatchObject({
    op: OP,
    capBytes: 1_000,
    status: "declared",
  });
  // Unchanged: nothing written, so the declaration time is the first one's.
  expect(result.again).toEqual({ ...result.first, status: "unchanged" });
  expect(result.raised).toMatchObject({ capBytes: 2_000, status: "updated" });
  expect(result.modelled).toEqual({
    tag: "KindNotRecomputable",
    message:
      "test.modelled cannot be declared recomputable: a model produced one of its stored outputs, which stay permanent",
  });
  expect(result.eventNamed).toEqual({
    tag: "KindNotRecomputable",
    message:
      "test.named cannot be declared recomputable: an event names one of its stored outputs, which stay permanent",
  });
  expect(result.invalid).toBe("InvalidKindDeclaration");
  expect(result.negative).toBe("InvalidKindDeclaration");
  expect(result.declarations).toEqual([
    {
      op: OP,
      recomputable: true,
      capBytes: 2_000,
      declaredAt: result.raised.declaredAt,
    },
  ]);
  expect(result.rows).toBe(1);
}, 30_000);
