import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { readGraphSymbols } from "@neuve/graph-client";
import { Manifest } from "./manifest.ts";
import { SPLITS, splitCases } from "./split.ts";
import { benchmarkRoot, refuseCommittedOutput } from "./stage-paths.ts";
import { lsTree, readBlobs } from "./git.ts";
import { pathExclusion, contentExclusion } from "./views.ts";
const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    work: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.executable || !values.work || !values.out)
  throw new Error("--executable, --work and --out required");
const effectRepository = process.env["NEUVE_EFFECT_REPOSITORY"];
if (!effectRepository) throw new Error("NEUVE_EFFECT_REPOSITORY is required");
const work = resolve(values.work),
  out = resolve(values.out);
refuseCommittedOutput(work);
refuseCommittedOutput(out);
const manifest = Manifest.parse(
  await Bun.file(resolve(benchmarkRoot, "manifest.json")).json(),
);
const repositories = {
  neuve: resolve(import.meta.dir, "../../../.."),
  neuve_effect: resolve(effectRepository),
};
const seen = new Set<string>(),
  sizes: number[] = [],
  failures: unknown[] = [];
let files = 0;
const bases = [
  ...new Map(
    splitCases(manifest.cases, SPLITS.dev).map((c) => [
      `${c.repository}:${c.base}`,
      c,
    ]),
  ).values(),
];
for (const base of bases) {
  const repo = repositories[base.repository];
  const entries = (await Effect.runPromise(lsTree(repo, base.base))).filter(
    (e) => pathExclusion(e) === undefined && !seen.has(`${e.path}:${e.oid}`),
  );
  const blobs = await Effect.runPromise(
    readBlobs(repo, [...new Set(entries.map((e) => e.oid))]),
  );
  const inputs = entries.flatMap((e) => {
    seen.add(`${e.path}:${e.oid}`);
    const bytes = blobs.get(e.oid);
    if (!bytes) return [];
    let text: string | undefined;
    try {
      text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    } catch {}
    return contentExclusion(bytes, text) === undefined
      ? [{ path: e.path, bytes }]
      : [];
  });
  const observed = await readGraphSymbols({
    executable: values.executable,
    temporaryParent: work,
    files: inputs,
  });
  sizes.push(...(observed.batchOutputBytes ?? []));
  files += inputs.length;
  for (const [path, file] of observed.files)
    if (file.partialFailure)
      failures.push({
        repository: base.repository,
        base: base.base,
        path,
        reason: file.partialFailure,
      });
  console.error(
    `${base.repository}:${base.base.slice(0, 8)}: ${inputs.length} files, largest batch ${Math.max(0, ...(observed.batchOutputBytes ?? []))} bytes`,
  );
}
await Bun.write(
  out,
  JSON.stringify(
    {
      split: "dev",
      files,
      batches: sizes.length,
      maxBytes: Math.max(0, ...sizes),
      sizes,
      failures,
    },
    null,
    2,
  ) + "\n",
);
