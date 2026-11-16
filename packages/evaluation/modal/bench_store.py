"""Read-only access to the M4 benchmark Records store, for the local side of the Modal runner.

Reads the store and base views configured in bench_store.json without writing to them. The
TypeScript benchmark owns writes (src/retrieval-bench/stored.ts). It resolves the same encoding
units the dense arms use, one per distinct (chunk text hash, path) pair, and reads stored chunk
vectors for parity. The configured inputs are kept in the private archive.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import numpy as np

DIRECTORY = Path(__file__).resolve().parent
SETTINGS = json.loads((DIRECTORY / "bench_store.json").read_text())
STORE = (DIRECTORY / SETTINGS["store"]).resolve()
BASE_VIEWS = (DIRECTORY / SETTINGS["base-views"]).resolve()


def open_read_only(path: Path) -> sqlite3.Connection:
    """A WAL file with no WAL may have closed cleanly or lost it, and read-only SQLite either writes
    the sidecars beside it or refuses it, by library. Read its bytes instead and say so. That read
    takes no locks, so `blob` checks every hash in case the benchmark writes while this runs."""
    uri = "file:" + quote(str(path), safe="/")
    with path.open("rb") as file:
        header = file.read(20)
    if header[18:19] == b"\x02" and not os.path.exists(f"{path}-wal"):
        print(f"read {path} as it stands: it has no WAL beside it, so nothing shows its last commits are in it", file=sys.stderr)
        return sqlite3.connect(uri + "?immutable=1", uri=True)
    return sqlite3.connect(uri + "?mode=ro", uri=True)


@dataclass(frozen=True)
class Unit:
    """One distinct encoding unit: chunk text (by hash) and the path in its title."""

    hash: str
    path: str
    repository: str
    tokens: int  # counting-tokenizer tokens (qwen3-bpe), without prefixes


class Store:
    def __init__(self, store: Path = STORE, base_views: Path = BASE_VIEWS):
        self.root = store
        self.base_views = base_views
        self.db = open_read_only(store / "records.sqlite")

    def blob(self, digest: str) -> bytes:
        row = self.db.execute(
            "select placement, content, pruned_at from blobs where hash = ?", (digest,)
        ).fetchone()
        if row is None:
            raise KeyError(f"blob {digest} missing")
        placement, content, pruned = row
        if pruned is not None:
            raise KeyError(f"blob {digest} pruned")
        held = bytes(content) if placement == "inline" else (self.root / "blobs" / "sha256" / digest[:2] / digest[2:]).read_bytes()
        if hashlib.sha256(held).hexdigest() != digest:
            raise KeyError(f"blob {digest} corrupt")
        return held

    def output(self, key: str) -> bytes:
        row = self.db.execute("select output_hash from computations where key = ?", (key,)).fetchone()
        if row is None:
            raise KeyError(f"computation {key} missing")
        return self.blob(row[0])

    def token_counts(self) -> dict[str, list[int]]:
        """Chunk computation key -> counting-tokenizer tokens per chunk (bench.chunk-tokens)."""
        rows = self.db.execute(
            "select json_extract(material, '$.inputs.chunks'), output_hash from computations "
            "where op = 'bench.chunk-tokens'"
        ).fetchall()
        return {chunks.removeprefix("computation:"): json.loads(self.blob(out)) for chunks, out in rows}

    def units(self, repositories: set[str] | None = None) -> list[Unit]:
        """Every distinct (hash, path) unit across the case bases, sorted like dense.ts."""
        views = json.loads(self.base_views.read_text())
        tokens_by_chunk_key = self.token_counts()
        found: dict[tuple[str, str], Unit] = {}
        for base in views["bases"]:
            if repositories is not None and base["repository"] not in repositories:
                continue
            view = json.loads(self.output(base["viewKey"]))
            for file in view["files"]:
                chunked = json.loads(self.output(file["chunkKey"]))
                counts = tokens_by_chunk_key.get(file["chunkKey"])
                for position, chunk in enumerate(chunked.get("chunks") or []):
                    key = (chunk["hash"], file["path"])
                    if key not in found:
                        found[key] = Unit(
                            hash=chunk["hash"],
                            path=file["path"],
                            repository=base["repository"],
                            tokens=counts[position] if counts else 512,
                        )
        return [found[key] for key in sorted(found, key=lambda k: f"{k[0]}\0{k[1]}")]

    def text(self, digest: str) -> str:
        return self.blob(digest).decode("utf-8")

    def stored_vectors(self, hf_id: str, device: str, dtype: str, adapter: bool = False) -> dict[tuple[str, str], str]:
        """(hash, path) -> output blob hash of each stored bench.encode-chunk for one model setup."""
        rows = self.db.execute(
            "select json_extract(material, '$.inputs.chunk'), json_extract(material, '$.inputs.path'), output_hash "
            "from computations where op = 'bench.encode-chunk' "
            "and json_extract(material, '$.config.model.hfId') = ? "
            "and json_extract(material, '$.config.model.device') = ? "
            "and json_extract(material, '$.config.model.dtype') = ? "
            "and (json_extract(material, '$.config.model.adapter') is not null) = ?",
            (hf_id, device, dtype, 1 if adapter else 0),
        ).fetchall()
        return {(chunk.removeprefix("blob:"), path): out for chunk, path, out in rows}

    def vector(self, output_hash: str) -> np.ndarray:
        return np.frombuffer(self.blob(output_hash), dtype="<f4")
