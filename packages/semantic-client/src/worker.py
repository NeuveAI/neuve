"""Local, text-only EmbeddingGemma 2 worker for the Neuve semantic client.

The process reads bounded JSON lines from stdin and writes one JSON line per
request. Model files must already exist locally; this process never downloads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import time


REVISION = "914f7f89142e33e77833254d9c9b90c3cef7303b"
WEIGHTS_SHA256 = "197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79"
MAX_LINE_BYTES = 512 * 1024
MAX_ITEMS = 32
MAX_TEXT_BYTES = 32 * 1024
MAX_BATCH_BYTES = 256 * 1024
MAX_TOKENS = 8192


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def fail(reason: str) -> None:
    raise ValueError(reason)


def formatted(item: object) -> str:
    if not isinstance(item, dict):
        fail("invalid-item")
    role, text, title = item.get("role"), item.get("text"), item.get("title")
    if not isinstance(text, str) or not text or len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        fail("invalid-text")
    if role == "document":
        if title is not None and (not isinstance(title, str) or not title or len(title.encode("utf-8")) > 1024 or "\n" in title):
            fail("invalid-title")
        return f"title: {title if title is not None else 'none'} | text: {text}"
    if title is not None:
        fail("unexpected-title")
    prefix = {
        "code-query": "task: code retrieval | query: ",
        "document-query": "task: search result | query: ",
        "classification": "task: classification | query: ",
        "similarity": "task: sentence similarity | query: ",
    }.get(role)
    if prefix is None:
        fail("unsupported-role")
    return prefix + text


def emit(value: object) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    start = time.monotonic()
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    # cpu, or Apple's GPU (10.117: chunk vectors on this machine, within the measured drift).
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    args = parser.parse_args()
    snapshot = Path(args.snapshot).resolve(strict=True)
    if not snapshot.is_dir() or snapshot.name != REVISION:
        fail("wrong-model-revision")
    config_path = snapshot / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config.get("model_type") != "embedding_gemma2":
        fail("wrong-model-type")
    weights_path = snapshot / "model.safetensors"
    if digest_file(weights_path) != WEIGHTS_SHA256:
        fail("wrong-model-weights")

    import numpy as np
    import sentence_transformers
    import torch
    import transformers
    from sentence_transformers import SentenceTransformer
    from transformers import AutoTokenizer

    torch.set_num_threads(4)
    if args.device == "mps" and not torch.backends.mps.is_available():
        fail("device-unavailable")
    model = SentenceTransformer(
        str(snapshot),
        local_files_only=True,
        device=args.device,
        model_kwargs={"torch_dtype": torch.float32},
        config_kwargs={"vision_config": None, "audio_config": None},
    )
    model.max_seq_length = MAX_TOKENS
    tokenizer = AutoTokenizer.from_pretrained(str(snapshot), local_files_only=True)
    identity = {
        "modelId": "google/embeddinggemma-2",
        "revision": REVISION,
        "weightsSha256": WEIGHTS_SHA256,
        "tokenizerSha256": digest_file(snapshot / "tokenizer.json"),
        "tokenizerConfigSha256": digest_file(snapshot / "tokenizer_config.json"),
        "configSha256": digest_file(config_path),
        "sentenceTransformerConfigSha256": digest_file(snapshot / "config_sentence_transformers.json"),
        "sentenceBertConfigSha256": digest_file(snapshot / "sentence_bert_config.json"),
        "processorConfigSha256": digest_file(snapshot / "processor_config.json"),
        "preprocessorConfigSha256": digest_file(snapshot / "preprocessor_config.json"),
        "poolingConfigSha256": digest_file(snapshot / "1_Pooling" / "config.json"),
        "normalizeConfigSha256": digest_file(snapshot / "2_Normalize" / "config.json"),
        "modulesSha256": digest_file(snapshot / "modules.json"),
        "workerSha256": digest_file(Path(__file__)),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "sentenceTransformers": sentence_transformers.__version__,
        "device": args.device,
        "dtype": "float32",
        "dimension": 768,
        "maxTokens": MAX_TOKENS,
        "recipe": "embeddinggemma2-text-prefix-v1",
    }
    emit({"kind": "ready", "identity": identity, "loadMillis": round((time.monotonic() - start) * 1000, 3)})

    while True:
        raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not raw:
            break
        if len(raw) > MAX_LINE_BYTES:
            emit({"kind": "fatal", "reason": "request-too-large"})
            return
        request_id = None
        try:
            request = json.loads(raw)
            if not isinstance(request, dict) or request.get("op") != "encode":
                fail("invalid-operation")
            request_id = request.get("id")
            if not isinstance(request_id, int) or request_id < 0:
                fail("invalid-request-id")
            items = request.get("items")
            if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
                fail("invalid-batch-size")
            inputs = [formatted(item) for item in items]
            if sum(len(value.encode("utf-8")) for value in inputs) > MAX_BATCH_BYTES:
                fail("batch-too-large")
            tokenized = tokenizer(inputs, add_special_tokens=True, truncation=False)
            counts = [len(ids) for ids in tokenized["input_ids"]]
            if any(count > MAX_TOKENS for count in counts):
                fail("token-limit-exceeded")
            start = time.monotonic()
            output = model.encode(
                inputs,
                prompt="",
                batch_size=min(len(inputs), 16),
                normalize_embeddings=False,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            encode_millis = round((time.monotonic() - start) * 1000, 3)
            if args.device == "mps":
                # Apple's GPU keeps its cache between requests otherwise, and long batches then
                # grow it past the machine's memory.
                torch.mps.empty_cache()
            array = np.asarray(output, dtype=np.float32)
            if array.shape != (len(inputs), 768) or not np.isfinite(array).all():
                fail("invalid-model-output")
            norms = np.linalg.norm(array, axis=1)
            if not np.isfinite(norms).all() or np.any(norms <= 0):
                fail("unnormalizable-model-output")
            array /= norms[:, None]
            if not np.isfinite(array).all() or any(abs(float(np.linalg.norm(row)) - 1) > 0.0001 for row in array):
                fail("unnormalizable-model-output")
            emit({
                "kind": "encoded",
                "id": request_id,
                "vectors": array.tolist(),
                "formattedSha256": [hashlib.sha256(value.encode("utf-8")).hexdigest() for value in inputs],
                "tokenCounts": counts,
                "encodeMillis": encode_millis,
            })
        except Exception as error:
            reason = str(error) if isinstance(error, ValueError) else "native-inference-failed"
            emit({"kind": "refusal", "id": request_id, "reason": reason})


if __name__ == "__main__":
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        main()
    except Exception as error:
        emit({"kind": "fatal", "reason": str(error) if isinstance(error, ValueError) else "native-load-failed"})
        sys.exit(1)
