// The leads key must change with the retriever. The manifest keeps the search tool's BM25 settings.
import { expect, test } from "bun:test";
import { Computations } from "@neuve/records-core";
import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  defaultManifestSettings,
  frontSettings,
  leadSettings,
  manifestSpec,
  rangeLeadsSpec,
  type ManifestSettings,
} from "../src/manifest.ts";
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
test("the leads retriever changes the leads key and leaves the manifest key stable", () => {
  const a = settingsWith(frozen("a"));
  const b = settingsWith(frozen("b"));
  const bm25 = settingsWith(DEFAULT_RETRIEVER);
  expect(keyOf(manifestSpec(range, "m", a, source))).toBe(
    keyOf(manifestSpec(range, "m", b, source)),
  );
  expect(keyOf(manifestSpec(range, "m", a, source))).toBe(
    keyOf(manifestSpec(range, "m", bm25, source)),
  );
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
