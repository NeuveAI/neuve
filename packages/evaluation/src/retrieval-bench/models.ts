/**
 * The model registry for the dense and rerank arms (proposal, section 7). Every entry pins a Hugging
 * Face revision and the SHA-256 of each weight file as published at that revision, so the encoder
 * refuses any other bytes and every stored encoding names exactly what produced it. Inputs are
 * formatted here, not in the encoder, with each model's documented prefixes (proposal, section 4,
 * "held fixed"). Weights are downloaded for one model at a time and deleted after use (9.22).
 */

/**
 * 9.34: every model runs on Modal on one hardware class, in full precision with TF32 off, so the
 * vectors are reproducible across hardware. Device and dtype are part of every encoding's key;
 * vectors stored earlier on this machine (E0 on CPU float32, part of E3 on MPS bfloat16) keep
 * their own keys and are used only for parity checks.
 */
export const HARDWARE = {
  gpu: "L40S",
  precision: "float32",
  tf32: false,
} as const;

export type ModelKind =
  "sentence-transformer" | "bidirectional-mean" | "yes-no-reranker";

export interface ModelEntry {
  /** The arm, or the reranker, this entry serves. */
  readonly id: string;
  readonly label: string;
  readonly hfId: string;
  readonly revision: string;
  readonly license: string;
  readonly kind: ModelKind;
  /** Files fetched from the revision; weight files are verified against `weights`. */
  readonly files: ReadonlyArray<string>;
  /** SHA-256 of each weight file, from the revision's LFS pointers. */
  readonly weights: Readonly<Record<string, string>>;
  readonly dimensions: number;
  readonly pooling: string;
  readonly maxTokens: number;
  /**
   * Where the vectors are computed. It is part of every encoding's key, so vectors from another
   * backend (for example a GPU host importing through `import-encodings`) are stored under that
   * backend's own entry and never mixed with these.
   */
  readonly device: "cpu" | "mps" | "cuda";
  readonly dtype: "float32" | "bfloat16";
  readonly threads: number;
  readonly paddingSide?: "left" | "right";
  /** EmbeddingGemma 2 loads text-only, without its vision and audio towers. */
  readonly textOnly?: boolean;
  readonly adapter?: {
    /** Repository-relative directory holding adapter_model.safetensors and adapter_config.json. */
    readonly path: string;
    readonly sha256: string;
    readonly configSha256: string;
  };
  /** How queries and documents become model input; part of every encoding's key. */
  readonly format: {
    readonly recipe: string;
    readonly query: (query: string) => string;
    readonly document: (path: string, text: string) => string;
  };
  readonly yesNoTokenIds?: readonly [number, number];
  readonly rerank?: {
    readonly instruction: string;
    readonly prefix: string;
    readonly suffix: string;
  };
}

const GEMMA = {
  hfId: "google/embeddinggemma-2",
  revision: "914f7f89142e33e77833254d9c9b90c3cef7303b",
  license: "apache-2.0",
  kind: "sentence-transformer",
  files: [
    "config.json",
    "config_sentence_transformers.json",
    "modules.json",
    "sentence_bert_config.json",
    "1_Pooling/config.json",
    "2_Normalize/config.json",
    "preprocessor_config.json",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "model.safetensors",
  ],
  weights: {
    "model.safetensors":
      "197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79",
  },
  dimensions: 768,
  pooling: "mean (sentence-transformers modules), normalised",
  maxTokens: 8192,
  device: "cuda",
  dtype: "float32",
  threads: 4,
  textOnly: true,
  // The worker's documented prefixes (packages/semantic-client/src/worker.py, line 53).
  format: {
    recipe: "embeddinggemma2-code-retrieval-title-path-v1",
    query: (query: string) => `task: code retrieval | query: ${query}`,
    document: (path: string, text: string) => `title: ${path} | text: ${text}`,
  },
} as const;

/** Qwen3's documented query form is `Instruct: {task}\nQuery:{query}`; documents take no prefix. */
const QWEN_TASK =
  "Given a code change, retrieve the code and documentation a reviewer needs to judge it";
const qwenFormat = {
  recipe: "qwen3-instruct-review-context-path-first-line-v1",
  query: (query: string) => `Instruct: ${QWEN_TASK}\nQuery:${query}`,
  document: (path: string, text: string) => `${path}\n${text}`,
};
const QWEN_FILES = [
  "config.json",
  "config_sentence_transformers.json",
  "modules.json",
  "1_Pooling/config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json",
  "merges.txt",
] as const;

export const MODELS = {
  E0: { id: "E0", label: "EmbeddingGemma 2 base", ...GEMMA },
  E1: {
    id: "E1",
    label: "EmbeddingGemma 2 + phase 3 broader adapter",
    ...GEMMA,
    adapter: {
      path: "validation/benchmarks/m4/adapters/phase3-broader-f7039598",
      sha256:
        "f7039598b4a567b736eeb12000dae4fd3764e0191f47d5861d81f03ef1d3b230",
      configSha256:
        "486c0aa54d0b21e4997b21c9534b634156950b53ca9d03de0dd27b3094fcfe3a",
    },
  },
  E2: {
    id: "E2",
    label: "Qwen3-Embedding-0.6B",
    hfId: "Qwen/Qwen3-Embedding-0.6B",
    revision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
    license: "apache-2.0",
    kind: "sentence-transformer",
    files: [...QWEN_FILES, "model.safetensors"],
    weights: {
      "model.safetensors":
        "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd",
    },
    dimensions: 1024,
    pooling: "last token (sentence-transformers modules), normalised",
    maxTokens: 8192,
    device: "cuda",
    dtype: "float32",
    threads: 4,
    paddingSide: "left",
    format: qwenFormat,
  },
  E3: {
    id: "E3",
    label: "Qwen3-Embedding-4B",
    hfId: "Qwen/Qwen3-Embedding-4B",
    revision: "5cf2132abc99cad020ac570b19d031efec650f2b",
    license: "apache-2.0",
    kind: "sentence-transformer",
    files: [
      ...QWEN_FILES,
      "model.safetensors.index.json",
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
    ],
    weights: {
      "model-00001-of-00002.safetensors":
        "e70bfe3c970523fb7ef4eddffed2254ce3f1e7150c3de2af4342de129dd756f8",
      "model-00002-of-00002.safetensors":
        "ed1b87c8e9eb7e535a1a155e4fd00d9f4dba80e58a6db48a4c9f82cede7079c1",
    },
    dimensions: 2560,
    pooling: "last token (sentence-transformers modules), normalised",
    maxTokens: 8192,
    device: "cuda",
    dtype: "float32",
    threads: 4,
    paddingSide: "left",
    format: qwenFormat,
  },
  E4: {
    id: "E4",
    label: "voyage-4-nano (Voyage, open weights)",
    hfId: "voyageai/voyage-4-nano",
    revision: "433ece5e27a1611e9360dd7134ecaaf79fb3681d",
    license: "apache-2.0",
    kind: "bidirectional-mean",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "vocab.json",
      "merges.txt",
      "model.safetensors",
    ],
    weights: {
      "model.safetensors":
        "3dae0c63c81dcab79ac213af331940a1bf2b8a53ec8646be878552890291ad30",
    },
    dimensions: 2048,
    pooling:
      "mean over all tokens after the 2,048-dimension projection, normalised",
    maxTokens: 8192,
    device: "cuda",
    dtype: "float32",
    threads: 4,
    format: {
      // The model card's query and document prompts (config_sentence_transformers.json).
      recipe: "voyage4-retrieval-prompts-path-first-line-v1",
      query: (query: string) =>
        `Represent the query for retrieving supporting documents: ${query}`,
      document: (path: string, text: string) =>
        `Represent the document for retrieval: ${path}\n${text}`,
    },
  },
  R: {
    id: "R",
    label: "Qwen3-Reranker-0.6B",
    hfId: "Qwen/Qwen3-Reranker-0.6B",
    revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
    license: "apache-2.0",
    kind: "yes-no-reranker",
    files: [
      "config.json",
      "generation_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "vocab.json",
      "merges.txt",
      "model.safetensors",
    ],
    weights: {
      "model.safetensors":
        "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b",
    },
    dimensions: 0,
    pooling: "softmax over the last position's no/yes logits",
    maxTokens: 8192,
    device: "cuda",
    dtype: "float32",
    threads: 4,
    format: {
      recipe: "qwen3-reranker-model-card-v1",
      query: (query: string) => query,
      document: (path: string, text: string) => `${path}\n${text}`,
    },
    yesNoTokenIds: [2152, 9693],
    // The model card's prompt (revision e61197ed, README), with a review-context instruction.
    rerank: {
      instruction: QWEN_TASK,
      prefix:
        '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n',
      suffix: "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
    },
  },
} as const satisfies Record<string, ModelEntry>;

export type ModelId = keyof typeof MODELS;
export const DENSE_IDS = ["E0", "E1", "E2", "E3", "E4"] as const;
export type DenseId = (typeof DENSE_IDS)[number];

/**
 * The tokenizer every arm's token counts use: Qwen3's, pinned by hash, because no Claude tokenizer
 * runs locally. It is a code-aware byte-level BPE; budgets in B4 are read in these tokens.
 */
export const COUNTER = {
  id: "qwen3-bpe",
  hfId: "Qwen/Qwen3-Embedding-0.6B",
  revision: "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
  file: "tokenizer.json",
  sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a",
} as const;

/** What identifies a model's output, for computation keys: everything except local paths. */
export const modelIdentity = (model: ModelEntry) => ({
  hfId: model.hfId,
  revision: model.revision,
  weights: model.weights,
  adapter:
    model.adapter === undefined
      ? null
      : {
          sha256: model.adapter.sha256,
          configSha256: model.adapter.configSha256,
        },
  recipe: model.format.recipe,
  pooling: model.pooling,
  dimensions: model.dimensions,
  maxTokens: model.maxTokens,
  device: model.device,
  dtype: model.dtype,
  ...(model.rerank === undefined ? {} : { rerank: model.rerank }),
});
