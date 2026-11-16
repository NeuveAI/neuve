"""Encodes a sample of a Modal run's items with the local encoder, for a local-versus-Modal parity check.

Runs src/retrieval-bench/encoder/encoder.py over stdio exactly as the benchmark does, with a Python
environment and model snapshot that already hold the pinned versions and weights (the encoder
verifies the weight hashes before loading). Never downloads.

  uv run python local_reference.py --run .runs/<run> --model E2 --python <venv python> \
      --snapshot <models dir>/<hfId with -->@<revision> [--every 8] [--device cpu] [--dtype float32]
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ENCODER = HERE.parent / "src" / "retrieval-bench" / "encoder" / "encoder.py"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--every", type=int, default=8)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--dtype", default="float32")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--batch", type=int, default=4)
    args = parser.parse_args()

    run = Path(args.run)
    items = [json.loads(line) for line in (run / "items.jsonl").read_text().splitlines()]
    remote = np.load(run / "vectors.npy")
    rows = list(range(0, len(items), args.every))
    registry = json.loads(subprocess.run(["bun", str(HERE / "registry.ts")], check=True, capture_output=True, text=True).stdout)
    spec = {**registry[args.model], "device": args.device, "dtype": args.dtype, "threads": args.threads}

    child = subprocess.Popen([args.python, "-I", "-u", str(ENCODER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def call(request: dict) -> dict:
        child.stdin.write(json.dumps(request) + "\n")
        child.stdin.flush()
        response = json.loads(child.stdout.readline())
        if response.get("kind") == "refusal":
            raise SystemExit(f"encoder refused: {response['reason']}")
        return response

    json.loads(child.stdout.readline())  # hello
    loaded = call({"op": "load", "model": spec, "snapshot": args.snapshot, "adapter": None})
    started = time.perf_counter()
    vectors = []
    for start in range(0, len(rows), args.batch):
        batch = rows[start : start + args.batch]
        response = call({"op": "encode", "id": start, "texts": [items[i]["text"] for i in batch]})
        vectors.append(np.frombuffer(base64.b64decode(response["vectors"]), dtype="<f4").reshape(len(batch), response["dim"]))
    seconds = time.perf_counter() - started
    child.stdin.close()
    child.wait()
    local = np.concatenate(vectors)
    np.save(run / f"local-{args.device}-{args.dtype}.npy", local)
    cosine = np.sum(local.astype(np.float64) * remote[rows].astype(np.float64), axis=1)
    result = {
        "model": args.model,
        "local": {"device": args.device, "dtype": args.dtype, "identity": loaded["identity"], "seconds": seconds},
        "items": len(rows),
        "maxCosineDifference": float((1 - cosine).max()),
        "meanCosineDifference": float((1 - cosine).mean()),
        "minCosine": float(cosine.min()),
        "maxAbsComponentDifference": float(np.abs(local - remote[rows]).max()),
    }
    (run / f"parity-local-{args.device}-{args.dtype}.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "local"} | {"localSeconds": seconds, "localWeights": loaded["identity"]["weightsSha256"]}, indent=2))


if __name__ == "__main__":
    main()
