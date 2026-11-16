"""Local Qwen3-Reranker-0.6B worker for Neuve's hybrid leads (10.117).

It scores documents against a query exactly as the benchmark's R arm did
(packages/evaluation/src/retrieval-bench/encoder/encoder.py, `Loaded.rerank`): the
model card's prompt with the review-context instruction, one document per forward
pass, and the softmax over the last position's no/yes logits. The process reads
bounded JSON lines from stdin and writes one JSON line per request. Model files must
already exist locally; this process never downloads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import sys
import time


REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
WEIGHTS_SHA256 = "27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b"
YES_NO_TOKEN_IDS = [2152, 9693]
MAX_TOKENS = 8192
INSTRUCTION = "Given a code change, retrieve the code and documentation a reviewer needs to judge it"
PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the "
    'Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
)
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
MAX_LINE_BYTES = 4 * 1024 * 1024
MAX_DOCUMENTS = 64
MAX_TEXT_BYTES = 512 * 1024


def digest_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fail(reason: str) -> None:
    raise ValueError(reason)


def emit(value: object) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def max_rss_bytes() -> int:
    # macOS reports bytes, Linux kilobytes.
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform == "darwin" else peak * 1024)


def main() -> None:
    start = time.monotonic()
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    args = parser.parse_args()
    snapshot = Path(args.snapshot).resolve(strict=True)
    if not snapshot.is_dir() or snapshot.name != REVISION:
        fail("wrong-model-revision")
    if digest_file(snapshot / "model.safetensors") != WEIGHTS_SHA256:
        fail("wrong-model-weights")

    import torch
    import transformers
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.set_num_threads(4)
    torch.manual_seed(0)
    if args.device == "mps" and not torch.backends.mps.is_available():
        fail("device-unavailable")
    tokenizer = AutoTokenizer.from_pretrained(str(snapshot), padding_side="left", local_files_only=True)
    model = (
        AutoModelForCausalLM.from_pretrained(str(snapshot), dtype=torch.float32, local_files_only=True)
        .to(args.device)
        .eval()
    )
    no_id = tokenizer.convert_tokens_to_ids("no")
    yes_id = tokenizer.convert_tokens_to_ids("yes")
    if [no_id, yes_id] != YES_NO_TOKEN_IDS:
        fail("yes-no-token-ids")
    prefix = tokenizer.encode(PREFIX, add_special_tokens=False)
    suffix = tokenizer.encode(SUFFIX, add_special_tokens=False)
    body_max = MAX_TOKENS - len(prefix) - len(suffix)
    identity = {
        "modelId": "Qwen/Qwen3-Reranker-0.6B",
        "revision": REVISION,
        "weightsSha256": WEIGHTS_SHA256,
        "tokenizerSha256": digest_file(snapshot / "tokenizer.json"),
        "configSha256": digest_file(snapshot / "config.json"),
        "workerSha256": digest_file(Path(__file__)),
        "instructionSha256": digest_text(INSTRUCTION),
        "prefixSha256": digest_text(PREFIX),
        "suffixSha256": digest_text(SUFFIX),
        "python": platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "device": args.device,
        "dtype": "float32",
        "maxTokens": MAX_TOKENS,
    }
    emit({
        "kind": "ready",
        "identity": identity,
        "loadMillis": round((time.monotonic() - start) * 1000, 3),
        "maxRssBytes": max_rss_bytes(),
    })

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
            if not isinstance(request, dict) or request.get("op") != "rerank":
                fail("invalid-operation")
            request_id = request.get("id")
            if not isinstance(request_id, int) or request_id < 0:
                fail("invalid-request-id")
            query, documents = request.get("query"), request.get("documents")
            if not isinstance(query, str) or not query or len(query.encode("utf-8")) > MAX_TEXT_BYTES:
                fail("invalid-query")
            if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_DOCUMENTS:
                fail("invalid-batch-size")
            if any(not isinstance(document, str) or len(document.encode("utf-8")) > MAX_TEXT_BYTES for document in documents):
                fail("invalid-document")
            started = time.monotonic()
            scores, counts, truncated = [], [], []
            for document in documents:
                formatted = f"<Instruct>: {INSTRUCTION}\n<Query>: {query}\n<Document>: {document}"
                body = tokenizer.encode(formatted, add_special_tokens=False)
                counts.append(len(body))
                truncated.append(len(body) > body_max)
                ids = prefix + body[:body_max] + suffix
                tensor = torch.tensor([ids], device=args.device)
                with torch.inference_mode():
                    logits = model(
                        input_ids=tensor,
                        attention_mask=torch.ones_like(tensor),
                        logits_to_keep=1,
                        use_cache=False,
                    ).logits[0, -1, [no_id, yes_id]].float()
                    score = float(logits.log_softmax(dim=0)[1].exp().cpu())
                scores.append(score)
            if args.device == "mps":
                torch.mps.synchronize()
                torch.mps.empty_cache()
            emit({
                "kind": "reranked",
                "id": request_id,
                "scores": scores,
                "tokenCounts": counts,
                "truncated": truncated,
                "rerankMillis": round((time.monotonic() - started) * 1000, 3),
                "maxRssBytes": max_rss_bytes(),
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
