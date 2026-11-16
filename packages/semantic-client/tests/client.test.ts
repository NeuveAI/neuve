import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  BASE_REVISION,
  BASE_WEIGHTS_SHA256,
  RERANKER_WORKER_SHA256,
  WORKER_SHA256,
  fingerprintBaseIdentity,
  fingerprintBaseRole,
  formatSemanticInput,
  matchesDeclaredVectorPair,
  qualifySupportedBaseEvidencePair,
  qualifySupportedBasePair,
  scorePool,
  SemanticClient,
  validateRegisteredBasePairRef,
  validateRecordedBaseVector,
  validateSupportedBasePair,
  type BaseIdentity,
  type Encoded,
  type RegisteredBasePairRef,
} from "../src/index.ts";
const workerPath = fileURLToPath(new URL("../src/worker.py", import.meta.url));

const identity: BaseIdentity = {
  modelId: "google/embeddinggemma-2",
  revision: BASE_REVISION,
  weightsSha256: BASE_WEIGHTS_SHA256,
  tokenizerSha256:
    "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
  tokenizerConfigSha256:
    "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874",
  configSha256:
    "b8f1e9931b57fbc054acdb445c41765d55b0074c58d145fa82839941ad1b5bb3",
  sentenceTransformerConfigSha256:
    "031e56a498d33c349ab489a21885bcfe25b4fcba841149dc99e1e90d4a7c28f5",
  sentenceBertConfigSha256:
    "b1bcd9f2dce3ae863b359e87d0710b5dbc3314a59ecb4e2f97c7778fc8e4b228",
  processorConfigSha256:
    "168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c",
  preprocessorConfigSha256:
    "ea2ae257e901064abdd98dceb19f2b0da06af600bed15e0f99f5c85c37ee9d78",
  poolingConfigSha256:
    "8759bdf7c77efc7df7723f64856a593c8943b71ee38baf2a88771fbaf78438f9",
  normalizeConfigSha256:
    "cdb09dfca347a56aa2d691744e38d5ad3c7cbc2834e7181272b9a15328b82524",
  modulesSha256:
    "3d02572a0455b832de67fb8e63a54981bc7e8b46e337c95e917bd8122a533bfd",
  workerSha256: WORKER_SHA256,
  python: "3.13.5",
  numpy: "2.5.3",
  torch: "2.14.1",
  transformers: "5.19.0",
  sentenceTransformers: "6.1.0",
  device: "cpu",
  dtype: "float32",
  dimension: 768,
  maxTokens: 8192,
  recipe: "embeddinggemma2-text-prefix-v1",
};

function vector(
  role: Encoded["role"],
  value: number,
  fingerprint = fingerprintBaseIdentity(identity),
): Encoded {
  const values = Array.from({ length: 768 }, (_, index) =>
    index === value ? 1 : 0,
  );
  return {
    kind: "base-vector",
    role,
    formattedSha256: "0".repeat(64),
    encoderFingerprint: fingerprint,
    identity,
    tokenCount: 4,
    values,
  };
}

describe("semantic input and pool boundary", () => {
  test("decodes retained BASE vectors only after pinned identity and value checks", () => {
    const original = vector("document", 0);
    const stored: unknown = JSON.parse(JSON.stringify(original));
    expect(validateRecordedBaseVector(stored)).toEqual(original);
    const refused: unknown[] = [
      null,
      { ...original, kind: "tuned-vector" },
      { ...original, role: "unknown-role" },
      { ...original, formattedSha256: "not-a-sha" },
      { ...original, encoderFingerprint: "f".repeat(64) },
      { ...original, identity: { ...identity, revision: "changed" } },
      {
        ...original,
        identity: { ...identity, tokenizerSha256: "f".repeat(64) },
      },
      { ...original, tokenCount: 0 },
      { ...original, tokenCount: 8193 },
      { ...original, tokenCount: 1.5 },
      { ...original, values: [1] },
      { ...original, values: [Number.NaN, ...original.values.slice(1)] },
      { ...original, values: [2, ...original.values.slice(1)] },
      { ...original, values: ["1", ...original.values.slice(1)] },
      { ...original, unrecorded: "extra" },
    ];
    for (const candidate of refused)
      expect(validateRecordedBaseVector(candidate)).toBeNull();
  });

  test("derives only product-supported BASE role pairs from pinned observations", () => {
    const observedDocument = vector("document", 0);
    const code = qualifySupportedBasePair({
      observedDocument,
      queryRole: "code-query",
    });
    const document = qualifySupportedBasePair({
      observedDocument,
      queryRole: "document-query",
    });
    expect(code.kind).toBe("supported-base-pair");
    expect(document.kind).toBe("supported-base-pair");
    if (code.kind === "refusal" || document.kind === "refusal") return;
    expect(code.pairId).not.toBe(document.pairId);
    expect(code.queryRoleFingerprint).not.toBe(document.queryRoleFingerprint);
    expect(code.documentRoleFingerprint).toBe(document.documentRoleFingerprint);
    expect(code.queryRoleFingerprint).toBe(
      fingerprintBaseRole(identity, "code-query"),
    );
    expect(code.documentRoleFingerprint).toBe(
      fingerprintBaseRole(identity, "document"),
    );
    expect(validateSupportedBasePair(code)).toEqual(code);
    expect(
      validateSupportedBasePair({ ...code, pairId: "f".repeat(64) }),
    ).toBeNull();
    expect(
      validateSupportedBasePair({
        ...code,
        documentRoleFingerprint: "f".repeat(64),
      }),
    ).toBeNull();
    expect(
      validateSupportedBasePair({
        ...code,
        compatibilityBasis: "caller-says-compatible",
      }),
    ).toBeNull();
    expect(
      validateSupportedBasePair({
        ...code,
        queryRole: "classification",
      }),
    ).toBeNull();
    const registered: RegisteredBasePairRef = {
      kind: "records-registered-base-pair",
      artifactId: "synthetic-records-pair-artifact",
      recordId: "synthetic-records-pair-event",
      pair: code,
    };
    expect(validateRegisteredBasePairRef(registered)).toEqual(registered);
    expect(
      validateRegisteredBasePairRef({
        ...registered,
        pair: { ...code, pairId: "f".repeat(64) },
      }),
    ).toBeNull();
    expect(
      qualifySupportedBasePair({
        observedDocument: vector("classification", 0),
        queryRole: "code-query",
      }),
    ).toEqual({
      kind: "refusal",
      reason: "unqualified-base-document-observation",
    });
    const evidence = qualifySupportedBaseEvidencePair(
      vector("classification", 0),
    );
    expect(evidence.kind).toBe("supported-base-pair");
    if (evidence.kind !== "refusal") {
      expect(evidence.operation).toBe("evidence-role");
      expect(evidence.queryRole).toBe("classification");
      expect(evidence.documentRole).toBe("classification");
      expect(evidence.pairId).not.toBe(code.pairId);
    }
  });

  test("checks a synthetic unequal pair mechanically without authorizing it", () => {
    const declaration = {
      queryRole: "code-query" as const,
      documentRole: "document" as const,
      queryRoleFingerprint: "synthetic-query-fingerprint",
      documentRoleFingerprint: "synthetic-document-fingerprint",
      dimension: 3,
      normalization: "synthetic-l2-unit",
    };
    const query = {
      role: "code-query" as const,
      fingerprint: "synthetic-query-fingerprint",
      dimension: 3,
      normalization: "synthetic-l2-unit",
    };
    const document = {
      role: "document" as const,
      fingerprint: "synthetic-document-fingerprint",
      dimension: 3,
      normalization: "synthetic-l2-unit",
    };
    expect(matchesDeclaredVectorPair(declaration, query, document)).toBe(true);
    expect(
      matchesDeclaredVectorPair(declaration, query, {
        ...document,
        fingerprint: query.fingerprint,
      }),
    ).toBe(false);
    expect(
      matchesDeclaredVectorPair(declaration, query, {
        ...document,
        dimension: 4,
      }),
    ).toBe(false);
    expect(
      matchesDeclaredVectorPair(declaration, query, {
        ...document,
        normalization: "different-normalization",
      }),
    ).toBe(false);
    expect(
      matchesDeclaredVectorPair(
        declaration,
        { ...query, role: "document-query" },
        document,
      ),
    ).toBe(false);
  });

  test("uses the documented asymmetric and symmetric text recipes", () => {
    expect(
      formatSemanticInput({ role: "code-query", text: "Find callers" }),
    ).toBe("task: code retrieval | query: Find callers");
    expect(
      formatSemanticInput({ role: "document-query", text: "Review policy" }),
    ).toBe("task: search result | query: Review policy");
    expect(
      formatSemanticInput({
        role: "document",
        title: "contract.ts",
        text: "export const x = 1",
      }),
    ).toBe("title: contract.ts | text: export const x = 1");
    expect(formatSemanticInput({ role: "document", text: "No title" })).toBe(
      "title: none | text: No title",
    );
    expect(formatSemanticInput({ role: "classification", text: "risk" })).toBe(
      "task: classification | query: risk",
    );
    expect(
      formatSemanticInput({ role: "similarity", text: "same meaning" }),
    ).toBe("task: sentence similarity | query: same meaning");
    expect(() =>
      formatSemanticInput({
        role: "code-query",
        text: "query",
        title: "wrong",
      }),
    ).toThrow("unexpected-title");
  });

  test("retains each occurrence and reports deterministic omitted leads", () => {
    const query = vector("code-query", 0);
    const document = vector("document", 0);
    const result = scorePool({
      query,
      candidates: [
        {
          occurrenceId: "b",
          reference: { source: "path-b", work: "unit-2" },
          encoded: document,
        },
        {
          occurrenceId: "a",
          reference: { source: "path-a", work: "unit-1" },
          encoded: document,
        },
        {
          occurrenceId: "c",
          reference: { source: "path-c", work: "unit-3" },
          encoded: vector("document", 1),
        },
      ],
      limit: 1,
    });
    expect(result.kind).toBe("ranked");
    if (result.kind !== "ranked") return;
    expect(result.selected.map((item) => item.occurrenceId)).toEqual(["a"]);
    expect(result.omitted.map((item) => item.occurrenceId)).toEqual(["b", "c"]);
    expect(result.omitted[0]?.reference).toEqual({
      source: "path-b",
      work: "unit-2",
    });
    expect(result.population).toBe(3);
    expect(result.interpretation).toBe("pool-local-cosine-only");
  });

  test("refuses incompatible spaces, roles, dimensions and duplicates", () => {
    const query = vector("code-query", 0);
    const candidate = {
      occurrenceId: "one",
      reference: "source",
      encoded: vector("document", 0),
    };
    expect(
      scorePool({
        query,
        candidates: [{ ...candidate, encoded: vector("document", 0, "other") }],
        limit: 1,
      }),
    ).toEqual({ kind: "refusal", reason: "invalid-candidate-vector" });
    expect(
      scorePool({
        query,
        candidates: [{ ...candidate, encoded: vector("classification", 0) }],
        limit: 1,
      }),
    ).toEqual({ kind: "refusal", reason: "incompatible-vector-space" });
    expect(
      scorePool({
        query,
        candidates: [
          { ...candidate, encoded: { ...candidate.encoded, values: [1] } },
        ],
        limit: 1,
      }),
    ).toEqual({ kind: "refusal", reason: "invalid-candidate-vector" });
    expect(
      scorePool({ query, candidates: [candidate, candidate], limit: 1 }),
    ).toEqual({ kind: "refusal", reason: "duplicate-occurrence" });
    expect(
      scorePool({
        query: vector("classification", 0),
        candidates: [{ ...candidate, encoded: vector("classification", 0) }],
        limit: 1,
      }).kind,
    ).toBe("ranked");
  });

  test("refuses a changed encoder identity even when its fingerprint string is reused", () => {
    const query = vector("code-query", 0);
    const document = vector("document", 0);
    const mutations: readonly (readonly [
      keyof BaseIdentity,
      string | number,
    ])[] = [
      ["modelId", "different-model"],
      ["revision", "DIFFERENT"],
      ["configSha256", "different-config"],
      ["workerSha256", "different-worker"],
      ["torch", "different-runtime"],
      ["dimension", 512],
      ["recipe", "different-recipe"],
    ];
    for (const [field, replacement] of mutations) {
      const changedIdentity = { ...document.identity };
      Object.defineProperty(changedIdentity, field, {
        value: replacement,
        enumerable: true,
      });
      const changed = { ...document, identity: changedIdentity };
      expect(changed.encoderFingerprint).toBe(query.encoderFingerprint);
      expect(
        scorePool({
          query,
          candidates: [
            {
              occurrenceId: "same-fingerprint",
              reference: "source",
              encoded: changed,
            },
          ],
          limit: 1,
        }),
      ).toEqual({ kind: "refusal", reason: "invalid-candidate-vector" });
    }
    const changedQueryIdentity = { ...query.identity };
    Object.defineProperty(changedQueryIdentity, "revision", {
      value: "DIFFERENT",
      enumerable: true,
    });
    expect(
      scorePool({
        query: { ...query, identity: changedQueryIdentity },
        candidates: [
          { occurrenceId: "document", reference: "source", encoded: document },
        ],
        limit: 1,
      }),
    ).toEqual({ kind: "refusal", reason: "invalid-query-vector" });
  });

  test("cancellation before work does not start the native worker", async () => {
    const client = new SemanticClient({
      pythonExecutable: "/missing/python",
      snapshotPath: "/missing/snapshot",
      workerPath,
      variant: { kind: "base" },
    });
    const cancellation = new AbortController();
    cancellation.abort();
    expect(
      await client.encodeBatch(
        [{ role: "code-query", text: "find" }],
        cancellation.signal,
      ),
    ).toEqual({ kind: "refusal", reason: "semantic-request-aborted" });
    expect(client.stats().loads).toBe(0);
    await client.close();
    expect(
      await client.encodeBatch([{ role: "code-query", text: "find" }]),
    ).toEqual({ kind: "refusal", reason: "semantic-client-closed" });
  });
});

const python = process.env.NEUVE_SEMANTIC_TEST_PYTHON;
const snapshot = process.env.NEUVE_SEMANTIC_TEST_SNAPSHOT;
const native = python && snapshot ? test : test.skip;
const clients: SemanticClient[] = [];
afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
});

native(
  "real pinned BASE inference batches once, reuses vectors, and refuses TUNED",
  async () => {
    if (!python || !snapshot)
      throw new Error("native test requires a configured runtime");
    const client = new SemanticClient({
      pythonExecutable: python,
      snapshotPath: snapshot,
      workerPath,
      variant: { kind: "base" },
      startupTimeoutMs: 180_000,
      requestTimeoutMs: 120_000,
    });
    clients.push(client);
    const inputs = [
      {
        role: "code-query" as const,
        text: "Find code that computes a SHA256 content hash.",
      },
      {
        role: "document" as const,
        title: "hash.go",
        text: "func digest(data []byte) string { return sha256(data) }",
      },
      {
        role: "document" as const,
        title: "sort.ts",
        text: "export const sorted = values => values.sort()",
      },
    ];
    const first = await client.encodeBatch(inputs);
    expect(first.kind).toBe("encoded");
    if (first.kind !== "encoded") return;
    expect(first.items).toHaveLength(3);
    expect(first.usage).toMatchObject({
      cacheHits: 0,
      generated: 3,
      encodeCalls: 1,
      nativeForwardCalls: null,
    });
    expect(first.usage.encodeMillis).toBeGreaterThan(0);
    for (const item of first.items) {
      expect(item.values).toHaveLength(768);
      expect(item.values.every(Number.isFinite)).toBe(true);
      expect(Math.abs(Math.hypot(...item.values) - 1)).toBeLessThan(0.0001);
      expect(item.identity.revision).toBe(BASE_REVISION);
      expect(item.identity.weightsSha256).toBe(BASE_WEIGHTS_SHA256);
      expect(item.identity.device).toBe("cpu");
      expect(item.identity.dtype).toBe("float32");
    }
    const second = await client.encodeBatch(inputs);
    expect(second.kind).toBe("encoded");
    if (second.kind === "encoded") {
      expect(second.usage).toMatchObject({
        cacheHits: 3,
        generated: 0,
        encodeCalls: 0,
        nativeForwardCalls: null,
        encodeMillis: null,
        loadMillis: null,
      });
      expect(second.items.map((item) => item.formattedSha256)).toEqual(
        first.items.map((item) => item.formattedSha256),
      );
    }
    const query = first.items[0];
    const document = first.items[1];
    if (!query || !document) throw new Error("actual vectors missing");
    const ranked = scorePool({
      query,
      candidates: [
        {
          occurrenceId: "source-a",
          reference: { source: "a", unit: "first" },
          encoded: document,
        },
        {
          occurrenceId: "source-b",
          reference: { source: "b", unit: "second" },
          encoded: document,
        },
      ],
      limit: 1,
    });
    expect(ranked.kind).toBe("ranked");
    if (ranked.kind === "ranked") {
      expect(ranked.selected[0]?.reference).toEqual({
        source: "a",
        unit: "first",
      });
      expect(ranked.omitted[0]?.reference).toEqual({
        source: "b",
        unit: "second",
      });
    }
    expect(client.stats()).toMatchObject({
      loads: 1,
      encodeCalls: 1,
      nativeForwardCalls: null,
      cacheHits: 3,
      generated: 3,
    });
    expect(
      await client.encodeBatch([
        { role: "code-query", text: "a ".repeat(9000) },
      ]),
    ).toEqual({ kind: "refusal", reason: "token-limit-exceeded" });
    expect(client.stats().encodeCalls).toBe(1);

    const tuned = new SemanticClient({
      pythonExecutable: python,
      snapshotPath: snapshot,
      workerPath,
      variant: {
        kind: "tuned",
        artifactReference: "research-adapter-present-unqualified",
      },
    });
    clients.push(tuned);
    expect(await tuned.encodeBatch(inputs)).toEqual({
      kind: "refusal",
      reason: "tuned-artifact-unqualified-for-production",
    });
    expect(tuned.stats().loads).toBe(0);
  },
  60_000,
);

native("cancels a native load without returning an embedding", async () => {
  if (!python || !snapshot)
    throw new Error("native test requires a configured runtime");
  const client = new SemanticClient({
    pythonExecutable: python,
    snapshotPath: snapshot,
    workerPath,
    variant: { kind: "base" },
    startupTimeoutMs: 180_000,
  });
  clients.push(client);
  const cancellation = new AbortController();
  const pending = client.encodeBatch(
    [{ role: "code-query", text: "Find a caller" }],
    cancellation.signal,
  );
  setTimeout(() => cancellation.abort(), 20);
  expect(await pending).toEqual({
    kind: "refusal",
    reason: "semantic-request-aborted",
  });
  expect(client.stats().loads).toBe(0);
});

// Why: both workers are refused unless their bytes are the ones this build pins, so a pin that
// went stale after an edit would refuse every model call with nothing else failing.
test("the pinned worker hashes are the workers' own", async () => {
  const digest = async (file: string) =>
    new Bun.CryptoHasher("sha256")
      .update(
        await Bun.file(new URL(`../src/${file}`, import.meta.url)).bytes(),
      )
      .digest("hex");
  expect(await digest("worker.py")).toBe(WORKER_SHA256);
  expect(await digest("reranker_worker.py")).toBe(RERANKER_WORKER_SHA256);
});
