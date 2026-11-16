// Why: the full test moves records between Records stores outside Records' own commands: phase A's
// Understand into later phases' stores as a bundle file (once A's clone is deleted under the disk
// rule), and proof records with their artefact bytes from the store that holds them into each
// known case's clone (FT15). A bundle that dropped or altered an entry would let a later phase
// recompute Understand silently, and a proof copied without its bytes would be refused by the log
// or leave no proof to read. Each test spawns the harness side several times, so it has a longer
// limit than bun's default. This runs the harness side's commands as the runner does, on two
// scratch repositories, and reads the results back through Records.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  Log,
  Store,
  mintUlid,
  resolveStoreLocation,
  sha256Hex,
  type StoreLocation,
} from "@neuve/records-core";

const scratch = mkdtempSync(join(tmpdir(), "full-test-stores-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const side = join(import.meta.dir, "../src/harness-compare/harness-side.ts");

const sh = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0)
    throw new Error(`${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};

const repository = (name: string) => {
  const dir = join(scratch, name);
  sh(scratch, "git", "init", "-q", dir);
  sh(dir, "git", "commit", "-q", "--allow-empty", "-m", "c");
  return dir;
};

const layer = (location: StoreLocation) =>
  Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(Store.layer(location, { create: true })),
    Layer.provideMerge(BunFileSystem.layer),
  );

const inStore = <A, E, R>(repo: string, program: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    Effect.flatMap(
      resolveStoreLocation(repo),
      (location) =>
        Effect.andThen(Store.prepareForWrite, program).pipe(
          Effect.provide(layer(location)),
        ) as Effect.Effect<A, unknown, never>,
    ),
  );

test("phase A's shared computations travel by bundle under their own keys; scope-only takes the snapshot alone", async () => {
  const from = repository("a");
  const to = repository("c");
  const scopeOnly = repository("u");
  const specs = [
    { op: "harness.understand", opVersion: 1, inputs: { part: "p1" } },
    { op: "harness.understand-merge", opVersion: 1, inputs: { parts: ["p1"] } },
    {
      op: "harness.scope-snapshot",
      opVersion: 1,
      inputs: { cycle: "cycle:x" },
    },
    { op: "harness.partition-plan", opVersion: 1, inputs: { map: "m" } },
  ];
  const keys = await inStore(
    from,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const out: Array<string> = [];
      for (const spec of specs) {
        const result = yield* store.run(
          Computations.ComputationSpec.parse(spec),
          Effect.succeed({
            bytes: new TextEncoder().encode(JSON.stringify({ of: spec.op })),
            mediaType: "application/json",
          }),
        );
        out.push(result.computation.key);
      }
      return out;
    }),
  );
  const bundle = join(scratch, "bundle.json");
  sh(
    scratch,
    process.execPath,
    side,
    "export",
    "--ops",
    "understand",
    "--from",
    from,
    "--out",
    bundle,
  );
  const held = JSON.parse(readFileSync(bundle, "utf8")) as {
    entries: ReadonlyArray<{ op: string }>;
  };
  // The plan depends on the leads' store, so it never travels.
  expect(held.entries.map((entry) => entry.op).sort()).toEqual([
    "harness.scope-snapshot",
    "harness.understand",
    "harness.understand-merge",
  ]);
  const report = join(scratch, "copied.json");
  sh(
    scratch,
    process.execPath,
    side,
    "import",
    "--ops",
    "understand",
    "--bundle",
    bundle,
    "--to",
    to,
    "--out",
    report,
  );
  sh(
    scratch,
    process.execPath,
    side,
    "import",
    "--ops",
    "scope-only",
    "--bundle",
    bundle,
    "--to",
    scopeOnly,
    "--out",
    report,
  );
  const lookup = (repo: string) =>
    inStore(
      repo,
      Effect.gen(function* () {
        const store = yield* Computations.ComputationStore;
        const blobs = yield* Blobs.BlobStore;
        const out: Array<string | null> = [];
        for (const key of keys.slice(0, 3)) {
          const found = yield* store.lookup(key);
          if (Option.isNone(found)) {
            out.push(null);
            continue;
          }
          const read = yield* blobs.get(found.value.outputHash);
          out.push(
            read._tag === "Present"
              ? new TextDecoder().decode(read.bytes)
              : "pruned",
          );
        }
        return out;
      }),
    );
  expect(await lookup(to)).toEqual([
    JSON.stringify({ of: "harness.understand" }),
    JSON.stringify({ of: "harness.understand-merge" }),
    JSON.stringify({ of: "harness.scope-snapshot" }),
  ]);
  expect(await lookup(scopeOnly)).toEqual([
    null,
    null,
    JSON.stringify({ of: "harness.scope-snapshot" }),
  ]);
}, 60_000);

test("proof records copy with their artefact bytes, only those of the range's commits, and copying twice adds nothing", async () => {
  const source = repository("proof-source");
  const target = repository("proof-target");
  const commit = sh(source, "git", "rev-parse", "HEAD");
  const actor = sha256Hex("neuve-actor/1\u0000test\u0000session");
  const bytes = new TextEncoder().encode("3 pass\n0 fail\n");
  const proof = (revision: string, hash: string) => ({
    id: mintUlid(),
    kind: "proof.recorded@1",
    idempotencyKey: `proof:${mintUlid()}`,
    actor,
    occurredAt: "2026-10-19T10:00:00.000Z",
    attribution: {
      range: { baseRef: "main", baseOid: "b".repeat(40), headOid: revision },
      sessionId: "session-1",
    },
    refs: [{ ref: `blob:${hash}`, role: "artefact" }],
    payload: {
      kind: "test-run",
      revision,
      claim: "The suite passes.",
      requirement: { text: "Tests pass" },
      artefact: {
        mediaType: "text/plain; charset=utf-8",
        bytes: bytes.byteLength,
      },
      worktree: { head: revision, scope: "tracked-tree", dirty: false },
    },
  });
  const wanted = await inStore(
    source,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const stored = yield* blobs.put({
        bytes,
        mediaType: "text/plain; charset=utf-8",
        retention: "raw-capture",
      });
      const inRange = proof(commit, stored.blob.hash);
      const elsewhere = proof("e".repeat(40), stored.blob.hash);
      yield* Log.append([inRange, elsewhere]);
      return inRange.id;
    }),
  );
  const commits = join(scratch, "commits.txt");
  await Bun.write(commits, `${commit}\n`);
  const bundle = join(scratch, "proofs.json");
  sh(
    scratch,
    process.execPath,
    side,
    "export-proofs",
    "--source",
    source,
    "--commits",
    commits,
    "--out",
    bundle,
  );
  const report = join(scratch, "proofs-report.json");
  sh(
    scratch,
    process.execPath,
    side,
    "import-proofs",
    "--bundle",
    bundle,
    "--to",
    target,
    "--out",
    report,
  );
  expect(
    JSON.parse(readFileSync(report, "utf8")) as Array<{
      id: string;
      status: string;
    }>,
  ).toEqual([{ id: wanted, status: "appended" }]);
  sh(
    scratch,
    process.execPath,
    side,
    "import-proofs",
    "--bundle",
    bundle,
    "--to",
    target,
    "--out",
    report,
  );
  expect(
    (JSON.parse(readFileSync(report, "utf8")) as Array<{ status: string }>)[0]
      ?.status,
  ).not.toBe("appended");
  const copied = await inStore(
    target,
    Effect.gen(function* () {
      const event = yield* Log.get(wanted);
      const blobs = yield* Blobs.BlobStore;
      if (Option.isNone(event) || event.value.event.kind !== "proof.recorded@1")
        return null;
      const read = yield* blobs.get(
        event.value.event.refs[0].ref.slice("blob:".length),
      );
      return read._tag === "Present"
        ? new TextDecoder().decode(read.bytes)
        : "pruned";
    }),
  );
  expect(copied).toBe("3 pass\n0 fail\n");
}, 60_000);
