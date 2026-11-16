"""The M4 benchmark's encoders on Modal GPUs.

The remote side runs the benchmark's own encoder (src/retrieval-bench/encoder/encoder.py, class
`Loaded`), unchanged, on CUDA. It does not reimplement it, so the request and response match the
local stdio contract: the caller formats inputs, the encoder verifies every weight file against the
registry's SHA-256 before loading, and vectors come back as little-endian float32, L2-normalised and
base64-encoded, with the encoder's identity (revision, weight hashes, adapter, torch, encoder hash).

Weights live in the Modal Volume `neuve-m4-weights`, fetched once per pinned revision by a CPU
function. Chunk texts travel only inside encode requests; nothing from the repository is stored on
Modal. Returned values are plain JSON types, so the local control environment needs no torch.

Local entrypoints (run from this directory):
  uv run modal run bench_gpu.py::hello_main --gpu L4
  uv run modal run bench_gpu.py::fetch_main --model E2
  uv run modal run bench_gpu.py::encode_main --model E2 --gpu L4 --limit 500
  uv run modal run bench_gpu.py::rerank_main --gpu L4
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import modal

APP_NAME = "neuve-m4-bench"
WEIGHTS = Path("/weights")
REMOTE_ENCODER_DIR = "/root/bench"

HERE = Path(__file__).resolve().parent
ENCODER = HERE.parent / "src" / "retrieval-bench" / "encoder" / "encoder.py"

weights = modal.Volume.from_name("neuve-m4-weights", create_if_missing=True)

# The fetch image needs only the standard library; downloads are plain HTTPS from the pinned revision.
fetch_image = modal.Image.debian_slim(python_version="3.13")

# The GPU image installs the lockfile's `gpu` group (the local encoder's pins). The encoder source is
# added at container start, not baked in, so an edited encoder does not rebuild the image; its SHA-256
# is part of every response's identity.
gpu_image = (
    modal.Image.debian_slim(python_version="3.13")
    .uv_sync(str(HERE), groups=["gpu"])
    .env({"HF_HUB_DISABLE_TELEMETRY": "1", "TOKENIZERS_PARALLELISM": "false"})
    .add_local_file(str(ENCODER), f"{REMOTE_ENCODER_DIR}/encoder.py")
)

app = modal.App(APP_NAME, tags={"project": "neuve", "purpose": "m4-benchmark"})


def _plain(value):
    """JSON types only: torch.__version__ is a str subclass that the local side cannot unpickle."""
    return json.loads(json.dumps(value))


def snapshot_dir(model: dict) -> Path:
    return WEIGHTS / "models" / f"{model['hfId'].replace('/', '--')}@{model['revision']}"


def adapter_dir(sha256: str) -> Path:
    return WEIGHTS / "adapters" / sha256


# --------------------------------------------------------------------------------------------- remote


@app.function(gpu="L4", image=gpu_image, timeout=300, retries=0, max_containers=1, scaledown_window=2)
def hello() -> dict:
    """Hardware check: the GPU, CUDA and a finite fp32 matrix product."""
    import torch

    started = time.perf_counter()
    a = torch.randn(4096, 4096, device="cuda", dtype=torch.float32)
    product = a @ a.T
    torch.cuda.synchronize()
    return _plain({
        "gpu": torch.cuda.get_device_name(),
        "capability": list(torch.cuda.get_device_capability()),
        "memoryBytes": torch.cuda.get_device_properties(0).total_memory,
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "finite": bool(torch.isfinite(product).all().item()),
        "matmulSeconds": time.perf_counter() - started,
        "python": sys.version.split()[0],
    })


@app.function(image=fetch_image, volumes={WEIGHTS: weights}, cpu=2, memory=2048, timeout=3600, retries=0)
def fetch_weights(model: dict) -> dict:
    """Fetches a registry entry's pinned files into the Volume and verifies every weight file.

    Mirrors fetchModel in src/retrieval-bench/encoder.ts: same URLs, same files, same hash check.
    Files already present are kept, but weight files are always re-hashed."""
    import urllib.request

    snapshot = snapshot_dir(model)
    started = time.perf_counter()
    downloaded: list[str] = []
    for name in model["files"]:
        target = snapshot / name
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://huggingface.co/{model['hfId']}/resolve/{model['revision']}/{name}"
        partial = target.with_name(target.name + ".partial")
        with urllib.request.urlopen(url, timeout=600) as response, partial.open("wb") as out:
            while chunk := response.read(1 << 22):
                out.write(chunk)
        partial.rename(target)
        downloaded.append(name)
    fetched = time.perf_counter() - started
    actual = {}
    for name, expected in model["weights"].items():
        value = hashlib.sha256()
        with (snapshot / name).open("rb") as stream:
            while chunk := stream.read(1 << 22):
                value.update(chunk)
        actual[name] = value.hexdigest()
        if actual[name] != expected:
            (snapshot / name).unlink()
            weights.commit()
            raise ValueError(f"{model['hfId']} {name}: sha256 {actual[name]}, expected {expected}")
    weights.commit()
    return {
        "snapshot": str(snapshot),
        "downloaded": downloaded,
        "bytes": sum((snapshot / name).stat().st_size for name in model["files"]),
        "fetchSeconds": fetched,
        "verifySeconds": time.perf_counter() - started - fetched,
        "weights": actual,
    }


_LOADED: dict = {}


def _loaded(model: dict, adapter: dict | None):
    """The container's model, loaded once and kept across inputs while the container is warm."""
    key = json.dumps({"model": model, "adapter": adapter}, sort_keys=True)
    if _LOADED.get("key") == key:
        return _LOADED["value"], 0.0
    _LOADED.clear()
    import torch

    # fp32 stays fp32: no TF32 in matrix products or convolutions.
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.set_float32_matmul_precision("highest")
    if REMOTE_ENCODER_DIR not in sys.path:
        sys.path.insert(0, REMOTE_ENCODER_DIR)
    import encoder  # the benchmark's encoder.py, unchanged

    weights.reload()
    started = time.perf_counter()
    request = {
        "model": model,
        "snapshot": str(snapshot_dir(model)),
        "adapter": None
        if adapter is None
        else {"path": str(adapter_dir(adapter["sha256"])), "sha256": adapter["sha256"]},
    }
    value = encoder.Loaded(request)
    _LOADED.update(key=key, value=value)
    return value, time.perf_counter() - started


def _environment() -> dict:
    import torch

    return {
        "gpu": torch.cuda.get_device_name(),
        "cuda": torch.version.cuda,
        "tf32": bool(torch.backends.cuda.matmul.allow_tf32),
        "matmulPrecision": torch.get_float32_matmul_precision(),
        "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
    }


_TEMPLATE = re.compile(r"\{(path|text|query)\}")


def _apply(template: str, values: dict) -> str:
    return _TEMPLATE.sub(lambda match: values[match.group(1)], template)


@app.function(gpu="L4", image=gpu_image, volumes={WEIGHTS: weights}, timeout=3600, startup_timeout=900,
              retries=0, max_containers=4, scaledown_window=20)
def encode(request: dict) -> dict:
    """Encodes one request: {model, adapter?, items: [{id, text} | {id, path, text}], format?, batchTokens}.

    `format` is null when the caller already formatted each text (the local contract), or "document" /
    "query" to apply the registry entry's template here. Items are batched by model tokens, longest
    batches bounded by `batchTokens` padded tokens, and returned in request order."""
    loaded, load_seconds = _loaded(request["model"], request.get("adapter"))
    items = request["items"]
    kind = request.get("format")
    template = None if kind is None else request["model"]["format"][kind]
    texts = [
        item["text"] if template is None
        else _apply(template, {"path": item.get("path", ""), "text": item["text"], "query": item["text"]})
        for item in items
    ]
    started = time.perf_counter()
    counts = loaded.token_counts(texts)
    order = sorted(range(len(texts)), key=lambda index: (counts[index], index))
    budget = int(request.get("batchTokens", 65536))
    batches: list[list[int]] = []
    current: list[int] = []
    for index in order:
        width = min(counts[index], loaded.max_tokens)
        if current and width * (len(current) + 1) > budget:
            batches.append(current)
            current = []
        current.append(index)
    if current:
        batches.append(current)
    import numpy as np

    out = None
    for batch in batches:
        array, _ = loaded.encode([texts[index] for index in batch])
        if out is None:
            out = np.zeros((len(texts), array.shape[1]), dtype="<f4")
        out[batch] = array
    seconds = time.perf_counter() - started
    return _plain({
        "ids": [item["id"] for item in items],
        "dim": int(out.shape[1]),
        "vectors": base64.b64encode(out.tobytes()).decode(),
        "tokens": counts,
        "batches": len(batches),
        "identity": loaded.identity,
        "loadSeconds": load_seconds,
        "encodeSeconds": seconds,
        "environment": _environment(),
    })


@app.function(gpu="L4", image=gpu_image, volumes={WEIGHTS: weights}, timeout=3600, startup_timeout=900,
              retries=0, max_containers=4, scaledown_window=20)
def rerank(request: dict) -> dict:
    """Scores one pool: {model, query, documents}, with the encoder's yes/no reranker, unchanged."""
    loaded, load_seconds = _loaded(request["model"], None)
    started = time.perf_counter()
    scores, counts, truncated = loaded.rerank(request["query"], request["documents"])
    return _plain({
        "scores": scores,
        "tokens": counts,
        "truncated": truncated,
        "identity": loaded.identity,
        "loadSeconds": load_seconds,
        "rerankSeconds": time.perf_counter() - started,
        "environment": _environment(),
    })


# ---------------------------------------------------------------------------------------------- local


def _registry() -> dict:
    import subprocess

    output = subprocess.run(["bun", str(HERE / "registry.ts")], check=True, capture_output=True, text=True)
    return json.loads(output.stdout)


def _remote_model(model: dict, dtype: str | None) -> dict:
    """A registry entry for CUDA. dtype defaults to float32 (proposal section 6: fp32 where feasible)."""
    return {**model, "device": "cuda", "dtype": dtype or "float32"}


def _run_dir(name: str) -> Path:
    path = HERE / ".runs" / f"{time.strftime('%Y%m%dT%H%M%S')}-{name}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _upload_adapter(adapter: dict) -> dict:
    """Uploads a registry adapter (two small files) to the Volume under its SHA-256, after checking both."""
    local = HERE.parents[2] / adapter["path"]
    model_file, config_file = local / "adapter_model.safetensors", local / "adapter_config.json"
    if _sha256(model_file) != adapter["sha256"] or _sha256(config_file) != adapter["configSha256"]:
        raise SystemExit(f"adapter at {local} does not match the registry")
    with weights.batch_upload(force=True) as batch:
        batch.put_file(str(model_file), f"/adapters/{adapter['sha256']}/adapter_model.safetensors")
        batch.put_file(str(config_file), f"/adapters/{adapter['sha256']}/adapter_config.json")
    return {"sha256": adapter["sha256"], "configSha256": adapter["configSha256"]}


@app.local_entrypoint()
def hello_main(gpu: str = "L4"):
    started = time.perf_counter()
    result = hello.with_options(gpu=gpu).remote()
    result["clientSeconds"] = time.perf_counter() - started
    _write(_run_dir(f"hello-{gpu}") / "receipt.json", result)
    print(json.dumps(result, indent=2))


@app.local_entrypoint()
def fetch_main(model: str = "E2"):
    entry = _registry()[model]
    result = fetch_weights.remote(entry)
    print(json.dumps(result, indent=2))


@app.local_entrypoint()
def encode_main(
    model: str = "E2",
    gpu: str = "L4",
    dtype: str = "",
    limit: int = 500,
    repository: str = "neuve",
    stored: str = "",
    request_size: int = 256,
    batch_tokens: int = 65536,
    containers: int = 1,
    offset: int = 0,
):
    """Encodes `limit` encoding units from the benchmark store and writes vectors and a receipt.

    --stored device:dtype (for example cpu:float32) selects only units that already have a stored
    local vector for that model setup, and reports the cosine difference to it."""
    import numpy as np

    from bench_store import Store

    entry = _registry()[model]
    adapter = _upload_adapter(entry["adapter"]) if "adapter" in entry else None
    store = Store()
    units = store.units({repository} if repository else None)
    reference = {}
    if stored:
        device, stored_dtype = stored.split(":")
        reference = store.stored_vectors(entry["hfId"], device, stored_dtype)
        units = [unit for unit in units if (unit.hash, unit.path) in reference]
    units = units[offset : offset + limit]
    texts = [_apply(entry["format"]["document"], {"path": u.path, "text": store.text(u.hash)}) for u in units]
    run = _run_dir(f"encode-{model}-{gpu}-{len(units)}")
    with (run / "items.jsonl").open("w") as stream:
        for unit, text in zip(units, texts):
            stream.write(json.dumps({"id": f"{unit.hash}:{unit.path}", "hash": unit.hash, "path": unit.path,
                                     "repository": unit.repository, "text": text}) + "\n")
    remote_model = _remote_model(entry, dtype)
    requests = [
        {
            "model": remote_model,
            "items": [{"id": f"{u.hash}:{u.path}", "text": t} for u, t in zip(units[i : i + request_size], texts[i : i + request_size])],
            "format": None,
            "adapter": adapter,
            "batchTokens": batch_tokens,
        }
        for i in range(0, len(units), request_size)
    ]
    function = encode.with_options(gpu=gpu, max_containers=containers)
    started = time.perf_counter()
    first = None
    results = []
    for result in function.map(requests):
        if first is None:
            first = time.perf_counter() - started
        results.append(result)
    wall = time.perf_counter() - started
    vectors = np.concatenate(
        [np.frombuffer(base64.b64decode(r["vectors"]), dtype="<f4").reshape(-1, r["dim"]) for r in results]
    )
    np.save(run / "vectors.npy", vectors)
    tokens = [count for r in results for count in r["tokens"]]
    receipt = {
        "model": model,
        "hfId": entry["hfId"],
        "gpu": gpu,
        "requested": {"dtype": remote_model["dtype"], "requestSize": request_size, "batchTokens": batch_tokens,
                      "containers": containers, "repository": repository, "offset": offset},
        "items": len(units),
        "charsSent": sum(len(t) for t in texts),
        "modelTokens": int(sum(tokens)),
        "wallSeconds": wall,
        "firstResultSeconds": first,
        "loadSeconds": [r["loadSeconds"] for r in results if r["loadSeconds"] > 0],
        "encodeSeconds": sum(r["encodeSeconds"] for r in results),
        "chunksPerEncodeSecond": len(units) / max(sum(r["encodeSeconds"] for r in results), 1e-9),
        "tokensPerEncodeSecond": sum(tokens) / max(sum(r["encodeSeconds"] for r in results), 1e-9),
        "identity": results[0]["identity"],
        "environment": results[-1]["environment"],
        "norms": {"min": float(np.linalg.norm(vectors, axis=1).min()), "max": float(np.linalg.norm(vectors, axis=1).max())},
        "sha256": hashlib.sha256(vectors.tobytes()).hexdigest(),
    }
    if reference:
        local = np.stack([store.vector(reference[(u.hash, u.path)]) for u in units])
        cosine = np.sum(local.astype(np.float64) * vectors.astype(np.float64), axis=1)
        receipt["parity"] = {
            "against": f"stored {stored}",
            "maxCosineDifference": float((1 - cosine).max()),
            "meanCosineDifference": float((1 - cosine).mean()),
            "minCosine": float(cosine.min()),
            "maxAbsComponentDifference": float(np.abs(local - vectors).max()),
        }
    _write(run / "receipt.json", receipt)
    print(json.dumps({**receipt, "identity": {k: receipt["identity"][k] for k in ("hfId", "revision", "weightsSha256", "dtype", "device", "torch", "encoderSha256")}, "run": str(run)}, indent=2))


@app.local_entrypoint()
def rerank_main(gpu: str = "L4", pool: int = 50, dtype: str = ""):
    """Times the reranker on one pool: the first development query and `pool` chunks of its base."""
    from bench_store import Store, SETTINGS

    registry = _registry()
    entry = registry["R"]
    queries = json.loads((HERE / SETTINGS["queries"]).read_text())
    query = next(q for q in queries["queries"] if q["repository"] == "neuve")
    store = Store()
    units = [u for u in store.units({"neuve"})][:pool]
    documents = [_apply(entry["format"]["document"], {"path": u.path, "text": store.text(u.hash)}) for u in units]
    started = time.perf_counter()
    result = rerank.with_options(gpu=gpu).remote({
        "model": _remote_model(entry, dtype),
        "query": _apply(entry["format"]["query"], {"query": query["text"]}),
        "documents": documents,
    })
    result["wallSeconds"] = time.perf_counter() - started
    result["pool"] = len(documents)
    result["hunkId"] = query["hunkId"]
    _write(_run_dir(f"rerank-{gpu}-{pool}") / "receipt.json", result)
    print(json.dumps({k: v for k, v in result.items() if k not in ("scores", "tokens", "truncated")}, indent=2))


# ------------------------------------------------------------------------ transport for encoder.ts
#
# The TypeScript benchmark (src/retrieval-bench/encoder.ts, ModalTransport) calls these with files it
# writes in a local temporary directory and deletes afterwards. It formats every input itself, owns
# every store write, and passes the registry entry it keys the vectors under (device "cuda", dtype
# float32), so the identity the encoder reports is checked against the same entry on both sides.


def _read_jsonl(path: str) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line]


@app.local_entrypoint()
def encode_items_main(
    model_file: str,
    items: str,
    out: str,
    gpu: str = "L40S",
    containers: int = 8,
    request_size: int = 128,
    batch_tokens: int = 65536,
):
    """items: JSONL {id, text} (text already formatted). out: JSONL {id, vector} plus out + '.receipt.json'."""
    entry = json.loads(Path(model_file).read_text())
    if entry.get("device") != "cuda":
        raise SystemExit("the transport encodes only registry entries with device cuda")
    adapter = _upload_adapter(entry["adapter"]) if entry.get("adapter") else None
    fetched = fetch_weights.remote(entry)
    rows = _read_jsonl(items)
    requests = [
        {
            "model": entry,
            "items": [{"id": row["id"], "text": row["text"]} for row in rows[i : i + request_size]],
            "format": None,
            "adapter": adapter,
            "batchTokens": batch_tokens,
        }
        for i in range(0, len(rows), request_size)
    ]
    function = encode.with_options(gpu=gpu, max_containers=containers)
    started = time.perf_counter()
    load_seconds, encode_seconds, tokens, identity, environment = [], 0.0, 0, None, None
    # Every response's identity and hardware, deduplicated, so the caller checks each container.
    identities: dict[str, dict] = {}
    environments: dict[str, dict] = {}
    with Path(out).open("w") as stream:
        for result in function.map(requests, order_outputs=False):
            vectors = base64.b64decode(result["vectors"])
            width = result["dim"] * 4
            for index, item_id in enumerate(result["ids"]):
                chunk = vectors[index * width : (index + 1) * width]
                stream.write(json.dumps({"id": item_id, "vector": base64.b64encode(chunk).decode()}) + "\n")
            if result["loadSeconds"] > 0:
                load_seconds.append(result["loadSeconds"])
            encode_seconds += result["encodeSeconds"]
            tokens += sum(result["tokens"])
            identity, environment = result["identity"], result["environment"]
            identities[json.dumps(identity, sort_keys=True)] = identity
            environments[json.dumps({k: environment[k] for k in ("gpu", "cuda", "tf32", "matmulPrecision")}, sort_keys=True)] = environment
    _write(
        Path(out + ".receipt.json"),
        {
            "items": len(rows),
            "requests": len(requests),
            "gpu": gpu,
            "containers": containers,
            "wallSeconds": time.perf_counter() - started,
            "loadSeconds": load_seconds,
            "encodeSeconds": encode_seconds,
            "modelTokens": tokens,
            "identity": identity,
            "environment": environment,
            "identities": list(identities.values()),
            "environments": list(environments.values()),
            "weights": fetched["weights"],
        },
    )


@app.local_entrypoint()
def rerank_items_main(model_file: str, items: str, out: str, gpu: str = "L40S", containers: int = 4):
    """items: JSONL {id, query, documents} (formatted). out: JSONL {id, scores, tokens, truncated}."""
    entry = json.loads(Path(model_file).read_text())
    if entry.get("device") != "cuda":
        raise SystemExit("the transport reranks only registry entries with device cuda")
    fetched = fetch_weights.remote(entry)
    rows = _read_jsonl(items)
    function = rerank.with_options(gpu=gpu, max_containers=containers)
    started = time.perf_counter()
    requests = [{"model": entry, "query": row["query"], "documents": row["documents"]} for row in rows]
    identity, environment, seconds = None, None, []
    identities: dict[str, dict] = {}
    environments: dict[str, dict] = {}
    with Path(out).open("w") as stream:
        for row, result in zip(rows, function.map(requests)):
            stream.write(json.dumps({"id": row["id"], "scores": result["scores"], "tokens": result["tokens"],
                                     "truncated": result["truncated"], "seconds": result["rerankSeconds"]}) + "\n")
            identity, environment = result["identity"], result["environment"]
            identities[json.dumps(identity, sort_keys=True)] = identity
            environments[json.dumps({k: environment[k] for k in ("gpu", "cuda", "tf32", "matmulPrecision")}, sort_keys=True)] = environment
            seconds.append(result["rerankSeconds"])
    _write(
        Path(out + ".receipt.json"),
        {"pools": len(rows), "gpu": gpu, "containers": containers, "wallSeconds": time.perf_counter() - started,
         "rerankSeconds": seconds, "identity": identity, "environment": environment,
         "identities": list(identities.values()), "environments": list(environments.values()), "weights": fetched["weights"]},
    )
