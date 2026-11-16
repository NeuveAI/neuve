"""One long-lived model process for the M4 benchmark arms (B2).

Reads one JSON request per line on stdin and writes one JSON response per line on stdout. It
holds at most one model at a time, loaded from a snapshot directory the caller has already
downloaded and pinned; it never downloads. The caller formats every input (prefixes, titles),
so this process only tokenizes, runs the model and pools. Vectors are float32, L2-normalised,
little-endian and base64-encoded.

Requests:
  {"op": "counter", "path": <tokenizer.json>, "sha256": <hex>}      token counting tokenizer
  {"op": "count", "id": n, "texts": [...]}                            token counts
  {"op": "load", "model": <registry entry>, "snapshot": <dir>, "adapter": <dir>|null}
  {"op": "encode", "id": n, "texts": [...]}                           vectors
  {"op": "rerank", "id": n, "query": str, "documents": [...]}         relevance scores
  {"op": "unload"}
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import sys
import time
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

MAX_LINE_BYTES = 64 * 1024 * 1024


def emit(value: object) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")
    sys.stdout.flush()


def sha256_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1 << 20):
            value.update(chunk)
    return value.hexdigest()


class Refusal(ValueError):
    pass


def weights_identity(snapshot: Path) -> dict[str, str]:
    """SHA-256 of every safetensors file, so a registry pin covers sharded checkpoints."""
    files = sorted(p for p in snapshot.glob("*.safetensors"))
    if not files:
        raise Refusal("no-weights")
    return {p.name: sha256_file(p) for p in files}


def combined(hashes: dict[str, str]) -> str:
    return hashlib.sha256("".join(f"{k}\0{v}\n" for k, v in sorted(hashes.items())).encode()).hexdigest()


def voyage_class():
    """voyage-4-nano's modeling_qwen3_bidirectional.py (revision 433ece5e, 91 lines, Apache 2.0),
    reimplemented here after review so no downloaded code is executed: Qwen3 with every layer
    non-causal and a final linear projection to 2,048 dimensions."""
    import inspect

    import torch
    from torch import nn
    from transformers import PreTrainedModel, Qwen3Config, Qwen3Model
    from transformers.masking_utils import create_causal_mask

    params = inspect.signature(create_causal_mask).parameters

    def bidirectional(attention_mask):
        def inner(batch_idx, head_idx, q_idx, kv_idx):
            if attention_mask is None:
                return torch.ones((), dtype=torch.bool)
            return attention_mask[batch_idx, kv_idx].to(torch.bool)

        return inner

    class Qwen3BidirectionalModel(PreTrainedModel):
        config_class = Qwen3Config
        _supports_sdpa = True

        def __init__(self, config):
            super().__init__(config)
            self.model = Qwen3Model(config)
            self.linear = nn.Linear(config.hidden_size, config.num_labels, bias=False)
            self.post_init()

        def post_init(self):
            super().post_init()
            for layer in self.model.layers:
                layer.self_attn.is_causal = False

        def forward(self, input_ids=None, attention_mask=None):
            embeds = self.model.embed_tokens(input_ids)
            kwargs = {
                "config": self.config,
                "attention_mask": attention_mask,
                "past_key_values": None,
                "position_ids": None,
                "or_mask_function": bidirectional(attention_mask),
            }
            kwargs["inputs_embeds" if "inputs_embeds" in params else "input_embeds"] = embeds
            if "cache_position" in params:
                kwargs["cache_position"] = torch.arange(embeds.shape[1], device=embeds.device, dtype=torch.long)
            mask = {"full_attention": create_causal_mask(**kwargs)}
            out = self.model(inputs_embeds=embeds, attention_mask=mask, use_cache=False)
            return self.linear(out.last_hidden_state)

    return Qwen3BidirectionalModel


class Loaded:
    def __init__(self, request: dict):
        import torch
        import transformers

        self.torch = torch
        spec = request["model"]
        self.spec = spec
        snapshot = Path(request["snapshot"]).resolve(strict=True)
        hashes = weights_identity(snapshot)
        if hashes != spec["weights"]:
            raise Refusal(f"weights-mismatch:{json.dumps(hashes)}")
        self.device = spec["device"]
        self.dtype = getattr(torch, spec["dtype"])
        self.max_tokens = int(spec["maxTokens"])
        self.kind = spec["kind"]
        self.pooling = spec.get("pooling")
        torch.set_num_threads(int(spec.get("threads", 8)))
        torch.manual_seed(0)
        started = time.monotonic()
        adapter = request.get("adapter")
        self.adapter_sha = None
        if self.kind == "sentence-transformer":
            from sentence_transformers import SentenceTransformer

            config_kwargs = {"vision_config": None, "audio_config": None} if spec.get("textOnly") else {}
            self.model = SentenceTransformer(
                str(snapshot),
                local_files_only=True,
                trust_remote_code=False,
                device=self.device,
                model_kwargs={"dtype": self.dtype},
                config_kwargs=config_kwargs,
                tokenizer_kwargs={"padding_side": spec.get("paddingSide", "right")},
            )
            self.model.max_seq_length = self.max_tokens
            if adapter is not None:
                from peft import PeftModel

                adapter_dir = Path(adapter["path"]).resolve(strict=True)
                if sha256_file(adapter_dir / "adapter_model.safetensors") != adapter["sha256"]:
                    raise Refusal("adapter-mismatch")
                self.model[0].model = PeftModel.from_pretrained(
                    self.model[0].model, str(adapter_dir), is_trainable=False, autocast_adapter_dtype=True
                )
                self.adapter_sha = adapter["sha256"]
            self.model.eval()
            self.tokenizer = self.model.tokenizer
        elif self.kind == "bidirectional-mean":
            from transformers import AutoTokenizer

            cls = voyage_class()
            self.model = cls.from_pretrained(str(snapshot), dtype=self.dtype, local_files_only=True).to(self.device).eval()
            self.tokenizer = AutoTokenizer.from_pretrained(str(snapshot), local_files_only=True)
        elif self.kind == "yes-no-reranker":
            from transformers import AutoModelForCausalLM, AutoTokenizer

            self.tokenizer = AutoTokenizer.from_pretrained(str(snapshot), padding_side="left", local_files_only=True)
            self.model = AutoModelForCausalLM.from_pretrained(str(snapshot), dtype=self.dtype, local_files_only=True).to(self.device).eval()
            self.no_id = self.tokenizer.convert_tokens_to_ids("no")
            self.yes_id = self.tokenizer.convert_tokens_to_ids("yes")
            if [self.no_id, self.yes_id] != spec["yesNoTokenIds"]:
                raise Refusal("yes-no-token-ids")
            self.prefix = self.tokenizer.encode(spec["rerank"]["prefix"], add_special_tokens=False)
            self.suffix = self.tokenizer.encode(spec["rerank"]["suffix"], add_special_tokens=False)
        else:
            raise Refusal("unknown-kind")
        self.load_ms = round((time.monotonic() - started) * 1000, 3)
        self.identity = {
            "id": spec["id"],
            "hfId": spec["hfId"],
            "revision": spec["revision"],
            "weightsSha256": combined(hashes),
            "weightFiles": hashes,
            "adapterSha256": self.adapter_sha,
            "device": self.device,
            "dtype": spec["dtype"],
            "torch": torch.__version__,
            "transformers": transformers.__version__,
            "python": platform.python_version(),
            "encoderSha256": sha256_file(Path(__file__)),
        }

    def token_counts(self, texts: list[str]) -> list[int]:
        return [len(ids) for ids in self.tokenizer(texts, add_special_tokens=True, truncation=False)["input_ids"]]

    def sync(self):
        if self.device == "mps":
            self.torch.mps.synchronize()

    def encode(self, texts: list[str]):
        import numpy as np

        torch = self.torch
        counts = self.token_counts(texts)
        if self.kind == "sentence-transformer":
            with torch.inference_mode():
                out = self.model.encode(
                    texts,
                    prompt="",
                    batch_size=len(texts),
                    normalize_embeddings=False,
                    convert_to_numpy=True,
                    show_progress_bar=False,
                )
            array = np.asarray(out, dtype=np.float32)
        else:
            batch = self.tokenizer(texts, padding=True, truncation=True, max_length=self.max_tokens, return_tensors="pt").to(self.device)
            with torch.inference_mode():
                hidden = self.model(input_ids=batch["input_ids"], attention_mask=batch["attention_mask"]).float()
                mask = batch["attention_mask"].unsqueeze(-1).float()
                pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
            array = pooled.cpu().numpy().astype(np.float32)
        self.sync()
        if not np.isfinite(array).all():
            raise Refusal("non-finite")
        norms = np.linalg.norm(array, axis=1, keepdims=True)
        if np.any(norms <= 0):
            raise Refusal("zero-norm")
        array = (array / norms).astype("<f4")
        return array, counts

    def rerank(self, query: str, documents: list[str]):
        torch = self.torch
        task = self.spec["rerank"]["instruction"]
        body_max = self.max_tokens - len(self.prefix) - len(self.suffix)
        scores, counts, truncated = [], [], []
        for document in documents:
            formatted = f"<Instruct>: {task}\n<Query>: {query}\n<Document>: {document}"
            raw = self.tokenizer.encode(formatted, add_special_tokens=False)
            counts.append(len(raw))
            truncated.append(len(raw) > body_max)
            ids = self.prefix + raw[:body_max] + self.suffix
            tensor = torch.tensor([ids], device=self.device)
            with torch.inference_mode():
                logits = self.model(input_ids=tensor, attention_mask=torch.ones_like(tensor), logits_to_keep=1, use_cache=False).logits[0, -1, [self.no_id, self.yes_id]].float()
                score = float(logits.log_softmax(dim=0)[1].exp().cpu())
            scores.append(score)
        self.sync()
        return scores, counts, truncated


def main() -> None:
    import numpy as np  # noqa: F401  (fail early when the environment is incomplete)

    loaded: Loaded | None = None
    counter = None
    counter_identity = None
    emit({"kind": "hello", "python": platform.python_version(), "pid": os.getpid()})
    while True:
        raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not raw:
            break
        request_id = None
        try:
            request = json.loads(raw)
            op = request.get("op")
            request_id = request.get("id")
            if op == "counter":
                from tokenizers import Tokenizer

                path = Path(request["path"]).resolve(strict=True)
                if sha256_file(path) != request["sha256"]:
                    raise Refusal("counter-mismatch")
                counter = Tokenizer.from_file(str(path))
                counter.no_truncation()
                counter.no_padding()
                counter_identity = request["sha256"]
                emit({"kind": "counter", "sha256": counter_identity})
            elif op == "count":
                if counter is None:
                    raise Refusal("no-counter")
                encodings = counter.encode_batch(request["texts"], add_special_tokens=False)
                emit({"kind": "counted", "id": request_id, "counts": [len(e.ids) for e in encodings]})
            elif op == "load":
                if loaded is not None:
                    raise Refusal("already-loaded")
                loaded = Loaded(request)
                emit({"kind": "loaded", "identity": loaded.identity, "loadMillis": loaded.load_ms})
            elif op == "unload":
                loaded = None
                import gc

                gc.collect()
                try:
                    import torch

                    if torch.backends.mps.is_available():
                        torch.mps.empty_cache()
                except Exception:
                    pass
                emit({"kind": "unloaded"})
            elif op == "encode":
                if loaded is None or loaded.kind == "yes-no-reranker":
                    raise Refusal("no-encoder")
                started = time.monotonic()
                array, counts = loaded.encode(request["texts"])
                emit({
                    "kind": "encoded",
                    "id": request_id,
                    "dim": int(array.shape[1]),
                    "vectors": base64.b64encode(array.tobytes()).decode(),
                    "tokens": counts,
                    "millis": round((time.monotonic() - started) * 1000, 3),
                })
            elif op == "rerank":
                if loaded is None or loaded.kind != "yes-no-reranker":
                    raise Refusal("no-reranker")
                started = time.monotonic()
                scores, counts, truncated = loaded.rerank(request["query"], request["documents"])
                emit({
                    "kind": "reranked",
                    "id": request_id,
                    "scores": scores,
                    "tokens": counts,
                    "truncated": truncated,
                    "millis": round((time.monotonic() - started) * 1000, 3),
                })
            else:
                raise Refusal("unknown-op")
        except Refusal as refusal:
            emit({"kind": "refusal", "id": request_id, "reason": str(refusal)})
        except Exception as error:  # a model failure is reported, never swallowed
            emit({"kind": "refusal", "id": request_id, "reason": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()
