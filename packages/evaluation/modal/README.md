# M4 encoders on Modal

This runs the M4 benchmark's encoders on Modal GPUs. The remote side imports the benchmark's own [encoder](../src/retrieval-bench/encoder/encoder.py) (`Loaded`) unchanged, so a Modal request has the same contract as the local stdio encoder:

- The caller formats inputs with the [registry](../src/retrieval-bench/models.ts) templates.
- Every weight file is checked against the registry's SHA-256 before loading.
- Vectors come back as little-endian float32, L2-normalised and base64-encoded, with the encoder's identity (revision, weight hashes, adapter, torch version, encoder hash, device `cuda`, dtype).

Writing vectors into the benchmark store stays on the TypeScript side. Ruling [9.34](../../../process/decisions.md) moved the benchmark's GPU work here: one hardware class (L40S), fp32 with TF32 off.

## Transport for the benchmark

The benchmark drives this app through [encoder.ts](../src/retrieval-bench/encoder.ts) (`modalEncode`, `modalRerank`), from the benchmark's arms command (`packages/evaluation/src/retrieval-bench/arms.ts`, kept in the private archive). They call two file-based entrypoints, `encode_items_main` and `rerank_items_main`, with the registry entry, the formatted inputs and an output path, all in a local temporary directory that is removed after each call. The TypeScript side stores every vector under the same computation key a local encode would use (model, revision, weight hashes, recipe, device `cuda`, dtype `float32`).

## Setup

```sh
cd packages/evaluation/modal
uv sync                        # Python 3.13, modal 1.6.1 and numpy only; no torch locally
uv run modal setup             # browser login; writes ~/.modal.toml
uv run modal profile current   # expect: webcloud
uv run modal app list          # a table, not "Token has expired"
```

Always call Modal through `uv run modal …` from this directory. Common uv pitfalls:

- **`modal` is not on PATH.** It is installed in this project's `.venv`, not globally.
- **Running from the wrong directory.** `uv run` from another directory picks up a different environment.
- **Python 3.14.** It is the default `python3` here and the GPU image targets 3.13, so `.python-version` pins 3.13.
- **Returning library objects.** A remote function that returns a torch value fails locally with `DeserializationError: … 'torch' module is not available`, because the local side has no torch. Everything returned here is plain JSON.
- **Agent sandboxes.** The Modal client talks gRPC to `api.modal.com`, which a filtering proxy can block: `Could not connect to the Modal server` while HTTPS to the same host works.

Tokens default to the workspace's maximum member-token lifetime. `uv run modal token new --expires-in 90d` sets a longer one, up to that maximum. `uv run modal token info` shows when the token expires.

## Commands

```sh
uv run modal run bench_gpu.py::hello_main --gpu L4                      # GPU, CUDA, fp32 matmul check
uv run modal run bench_gpu.py::fetch_main --model E3                    # pinned weights into the Volume, hash-verified
uv run python local_reference.py --run .runs/<run> --model E2 \
    --python <venv with the encoder's requirements> --snapshot <local snapshot dir>
uv run modal billing report --for today -r h --show-resources --json    # cost per app run
```

### Files

- **`bench_gpu.py`:** the Modal app.
  - Remote functions: `hello`, `fetch_weights` (CPU), `encode`, `rerank`.
  - Local entrypoints: `hello_main`, `fetch_main`, `encode_main`, `rerank_main`, `encode_items_main`, `rerank_items_main`.
- **`bench_store.py`:** the public benchmark store reader. The `encode_main` and `rerank_main` entrypoints in `bench_gpu.py` read through it and need the archived store and base views. Their default locations are settings in `bench_store.json`. From this directory in an archive checkout, run `uv run modal run bench_gpu.py::encode_main --model E2 --gpu L4 --limit 500` or `uv run modal run bench_gpu.py::rerank_main --gpu L4`.
- **`registry.ts`:** prints the TypeScript model registry as JSON, with each input format turned into a template, so no pin is restated in Python.
- **`local_reference.py`:** encodes a sample of a run's items with the local encoder, for parity checks.
- **`.runs/`** (gitignored): each run's items (chunk texts), vectors and receipt.

The Volume `neuve-m4-weights` holds public weights only: `/models/<hfId>@<revision>` and `/adapters/<sha256>`. Delete it with `uv run modal volume delete neuve-m4-weights`.

## What travels to Modal

Only the formatted chunk texts inside each encode request, and only for the repository chosen with `--repository`. Nothing from the repository is stored on Modal. Weights download from Hugging Face inside Modal.

`neuve_effect` is private; send its chunks only after the owner allows it. The GPU image, built from `uv.lock`, carries no repository content except the encoder source.

## Determinism

- **fp32 is portable.** CUDA fp32 (TF32 disabled) matches CPU fp32 to about 1e-7 cosine, and different GPUs match each other to the same level. It is not bit-identical, so record the device in the computation identity: `modelIdentity` already includes device and dtype.
- **bf16 is not portable.** CUDA bf16, MPS bf16 and fp32 differ by up to about 7e-4 cosine, which changes about 1.6% of top-10 neighbours.
