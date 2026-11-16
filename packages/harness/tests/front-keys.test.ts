// Why (NEU-148): what the review's front path stores must be keyed by exactly what it reads. The
// leads retriever's work moved to the range's leads, so Precompute's and the manifest's keys must
// not change with it, while the leads' key must; the one part of it an agent reads (the `search`
// tool's BM25) stays in the manifest, so the finders' keys still change with it.
import { expect, test } from "bun:test";
import { Computations } from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  defaultManifestSettings,
  frontSettings,
  leadSettings,
  manifestSpec,
  rangeLeadsSpec,
  type ManifestSettings,
} from "../src/manifest.ts";
import { precomputeKey, type RunContext } from "../src/pipeline.ts";
import { DEFAULT_RETRIEVER, type RetrieverConfig } from "../src/retriever.ts";

const range = { baseOid: "a".repeat(40), headOid: "b".repeat(40) };
const source = captureOutlineSource();
const frozen = (sha: string): RetrieverConfig => ({
  id: "frozen",
  candidate: "R(H3-E0)",
  sha256: sha.repeat(64),
  fallback: DEFAULT_RETRIEVER,
});
const settingsWith = (retriever: RetrieverConfig): ManifestSettings => ({
  ...defaultManifestSettings(400_000),
  retriever,
});
const keyOf = (spec: Computations.ComputationSpec) =>
  Computations.computationKey(spec).key;
const precompute = (settings: ManifestSettings) =>
  precomputeKey({
    range: { baseRef: "main", ...range },
    cycleId: "cycle",
    config: { ...defaultConfig(), precompute: settings },
  } as unknown as RunContext["Service"]);

test("the manifest's and Precompute's keys hold no leads retriever; the leads' key does", () => {
  const a = settingsWith(frozen("a"));
  const b = settingsWith(frozen("b"));
  const bm25 = settingsWith(DEFAULT_RETRIEVER);
  expect(keyOf(manifestSpec(range, "m", a, source))).toBe(
    keyOf(manifestSpec(range, "m", b, source)),
  );
  expect(keyOf(manifestSpec(range, "m", a, source))).toBe(
    keyOf(manifestSpec(range, "m", bm25, source)),
  );
  expect(precompute(a)).toBe(precompute(b));
  expect(precompute(a)).toBe(precompute(bm25));
  expect(frontSettings(a)).not.toHaveProperty("retriever");
  expect(keyOf(rangeLeadsSpec("k", leadSettings(a), source))).not.toBe(
    keyOf(rangeLeadsSpec("k", leadSettings(b), source)),
  );
});

// Why: the CLI and coverage key a manifest from the request's settings or from a stored manifest's;
// both must name the same computation, with the search tool's BM25 in it.
test("a manifest's own settings key it as the request's settings do", () => {
  const request = settingsWith(frozen("a"));
  expect(frontSettings(request).search).toEqual(DEFAULT_RETRIEVER);
  expect(keyOf(manifestSpec(range, "m", frontSettings(request), source))).toBe(
    keyOf(manifestSpec(range, "m", request, source)),
  );
});
