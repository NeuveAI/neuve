// Why: E0 reads the benchmark's Records store, which the labelling side owns and never migrates
// (the owner's ruling), while this checkout's Records schema moves on (9 today, 10 with stack
// sources). The reader must read any schema version that has the tables and columns a lookup uses,
// never write, and refuse clearly when they are missing; a vector whose bytes do not match their
// hash, or that was pruned, must read as absent rather than rank.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Computations, storeLocationIn } from "@neuve/records-core";
import {
  E0_DIMENSIONS,
  VectorStoreReader,
  benchChunkSpec,
  storedVector,
} from "../src/e0.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-vectors-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const vectorBytes = (seed: number) => {
  const values = new Float32Array(E0_DIMENSIONS).fill(0);
  values[seed % E0_DIMENSIONS] = 1;
  return new Uint8Array(values.buffer);
};
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A store laid out as Records lays it out, at a schema version this checkout does not know. */
const fixture = (name: string, blobColumns: string) => {
  const root = join(directory, name);
  const location = storeLocationIn(root);
  mkdirSync(location.blobs, { recursive: true });
  const database = new Database(location.database, { create: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run(
    "CREATE TABLE store_versions (schema_version INTEGER, projector_version INTEGER)",
  );
  database.run("INSERT INTO store_versions VALUES (99, 99)");
  database.run(
    "CREATE TABLE computations (key TEXT PRIMARY KEY, op TEXT, output_hash TEXT, extra_future_column TEXT)",
  );
  database.run(`CREATE TABLE blobs (${blobColumns})`);
  return { root, location, database };
};

const put = (
  store: ReturnType<typeof fixture>,
  spec: Computations.ComputationSpec,
  bytes: Uint8Array,
  options: {
    readonly inline: boolean;
    readonly pruned?: boolean;
    readonly corrupt?: boolean;
  },
) => {
  const hash = sha(bytes);
  store.database.run(
    "INSERT INTO computations (key, op, output_hash) VALUES (?, ?, ?)",
    [Computations.computationKey(spec).key, spec.op, hash],
  );
  const stored = options.corrupt === true ? vectorBytes(999) : bytes;
  store.database.run(
    "INSERT INTO blobs (hash, placement, content, pruned_at) VALUES (?, ?, ?, ?)",
    [
      hash,
      options.inline ? "inline" : "file",
      options.inline ? stored : null,
      options.pruned === true ? "2026-10-20T00:00:00.000Z" : null,
    ],
  );
  if (!options.inline) {
    const folder = join(store.location.blobs, "sha256", hash.slice(0, 2));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, hash.slice(2)), stored);
  }
};

test("the reader reads a store of another schema version, read-only, and only whole vectors", () => {
  const store = fixture(
    "v99",
    "hash TEXT PRIMARY KEY, size INTEGER, placement TEXT, content BLOB, pruned_at TEXT",
  );
  const specs = [0, 1, 2, 3].map((seed) =>
    benchChunkSpec(sha(vectorBytes(seed)), `src/file-${seed}.ts`),
  );
  put(store, specs[0]!, vectorBytes(0), { inline: true });
  put(store, specs[1]!, vectorBytes(1), { inline: false });
  put(store, specs[2]!, vectorBytes(2), { inline: true, pruned: true });
  put(store, specs[3]!, vectorBytes(3), { inline: false, corrupt: true });
  store.database.close();
  const before = {
    database: readFileSync(store.location.database),
    mode: statSync(store.location.database).mode,
  };
  const reader = new VectorStoreReader(store.root);
  expect(storedVector(reader, specs[0]!)?.[0]).toBe(1);
  expect(storedVector(reader, specs[1]!)?.[1]).toBe(1);
  expect(storedVector(reader, specs[2]!)).toBeUndefined();
  expect(storedVector(reader, specs[3]!)).toBeUndefined();
  expect(
    storedVector(reader, benchChunkSpec("f".repeat(64), "absent.ts")),
  ).toBeUndefined();
  reader.close();
  // Nothing about the store changed: not its bytes, not its permissions.
  expect(readFileSync(store.location.database).equals(before.database)).toBe(
    true,
  );
  expect(statSync(store.location.database).mode).toBe(before.mode);
});

test("a store without the tables and columns a lookup needs is refused, saying what is missing", () => {
  const store = fixture("no-content", "hash TEXT PRIMARY KEY, placement TEXT");
  store.database.close();
  expect(() => new VectorStoreReader(store.root)).toThrow(
    "lacks blobs.content, blobs.pruned_at, which reading its vectors needs",
  );
  expect(() => new VectorStoreReader(join(directory, "nowhere"))).toThrow(
    "no Records store at",
  );
});
