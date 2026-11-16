import {
  type OutlineSource,
  readOutlines,
  assertOutlineSource,
  GRAPH_SOURCE_BINDING,
} from "../graph-outline.ts";
import { StackIndexMeta as Meta, knownStackIndex } from "./index-meta.ts";
import { safeRead } from "@neuve/records-schema";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chunkFile,
  CHUNK_RECIPE,
  splitLines,
  retryableFallback,
} from "../chunker.ts";
import { BM25, INDEX_BOUNDS, blobText, terms } from "../search-index.ts";
import {
  directoryBytes,
  listTree,
  readStoreBlobs,
  type StoreGit,
} from "./git-store.ts";
import { removeReadOnly, storeLayout, withStoreLock } from "./store.ts";
import { STACK_LIMITS } from "./settings.ts";

/**
 * The store-level search index (proposal SC6), outside Records: one persisted index per tree, built
 * in the background from the same chunker and BM25 parameters as the repository's own index, under
 * `index/<tree OID>/`. A search over a stack state sums the persisted document counts, lengths and
 * term frequencies of its distinct trees, each counted once, which is one BM25 over their union
 * without building a union index. At most 32 distinct query terms are read, and only their postings:
 * a tree's postings are one binary file of (document, term frequency, document length) triples, and
 * 16 dictionary buckets give each term's offset and count in it, so a search reads the buckets its
 * terms fall in and then only those terms' byte ranges. A search's memory does not grow with the
 * stack.
 */

export const STACK_INDEX_RECIPE = () => ({
  id: "neuve-stack-index-v2",
  chunker: { recipe: CHUNK_RECIPE, sourceBinding: GRAPH_SOURCE_BINDING },
  bounds: INDEX_BOUNDS,
  bm25: BM25,
  postings: "u32le-doc-tf-length-16-dictionary-buckets-v1",
});

export const stackIndexRecipeKey = () =>
  createHash("sha256")
    .update(JSON.stringify(STACK_INDEX_RECIPE()))
    .digest("hex")
    .slice(0, 32);

/** One document: a chunk of a file. */
export interface StackDoc {
  readonly path: string;
  readonly blob: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: "symbol" | "section" | "window";
  readonly symbol: string | null;
  readonly capability: string;
  readonly fallback: string | null;
}

type Meta = z.infer<typeof Meta>;

const stackIndexSource = (
  outline: OutlineSource,
): NonNullable<Meta["source"]> => {
  const source = outline.key;
  return "sha256" in source
    ? { kind: "available", sha256: source.sha256 }
    : { kind: "unavailable", path: source.unavailable };
};

const indexSnapshot = async (folder: string) => {
  const text = await readFile(join(folder, "meta.json"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    },
  );
  return { text, known: await knownStackIndex(folder, stackIndexRecipeKey()) };
};

type IndexBuild = {
  readonly docs: number;
  readonly bytes: number;
  readonly excluded: Readonly<Record<string, number>>;
};

const bucketOf = (term: string) =>
  createHash("sha1").update(term).digest("hex").slice(0, 1);

/**
 * Builds the index of one tree from its store repository and writes it under `index/<tree>/`.
 * Left out and counted, as the repository's index does: links, submodules, files over 1 MiB, binary
 * content, and blobs the upstream filter omitted.
 */
export const buildTreeIndex = async (
  git: StoreGit,
  root: string,
  tree: string,
  outline: OutlineSource,
  // Called under the existing store lock. Admission, installation and catalog writes stay atomic.
  admit: (
    build: IndexBuild,
    install: () => Promise<void>,
  ) => Promise<boolean> = async (_build, install) => {
    await install();
    return true;
  },
) => {
  git.signal?.throwIfAborted();
  const source = stackIndexSource(outline);
  const folder = storeLayout(root).indexFolder(tree);
  const seen = await indexSnapshot(folder);
  if (!seen.known)
    return { status: "deferred" as const, reason: "newer-build" as const };
  const layout = storeLayout(root);
  const gitDir = layout.treeRepository(tree);
  const entries = await listTree(git, gitDir, tree);
  const excluded: Record<string, number> = {};
  const count = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const wanted = new Map<string, Array<string>>();
  for (const entry of entries) {
    if (entry.type === "commit") count("submodule");
    else if (entry.type !== "blob") count("not-a-blob");
    else if (entry.mode === "120000") count("symlink");
    else {
      const paths = wanted.get(entry.oid) ?? [];
      paths.push(entry.path);
      wanted.set(entry.oid, paths);
    }
  }
  const docs: Array<
    [
      string,
      string,
      number,
      number,
      string,
      string | null,
      string,
      string | null,
    ]
  > = [];
  const postings = new Map<string, Array<number>>();
  let totalLength = 0;
  let retryable = false;
  let pending: {
    path: string;
    oid: string;
    bytes: Uint8Array;
    content: string;
  }[] = [];
  let pendingBytes = 0;
  const flush = async () => {
    const outlines = await readOutlines(pending, outline, git.signal);
    git.signal?.throwIfAborted();
    for (const { path, oid, content } of pending) {
      const lines = splitLines(content);
      const chunked = chunkFile(path, content, outlines.context(path));
      if (retryableFallback(chunked.fallback)) retryable = true;
      for (const chunk of chunked.chunks) {
        const doc = docs.length;
        docs.push([
          path,
          oid,
          chunk.startLine,
          chunk.endLine,
          chunk.kind,
          chunk.symbol ?? null,
          chunked.capability,
          chunked.fallback ?? null,
        ]);
        const body = lines.slice(chunk.startLine - 1, chunk.endLine).join("");
        const list = terms(`${path}\n${body}`);
        totalLength += list.length;
        const counts = new Map<string, number>();
        for (const term of list) counts.set(term, (counts.get(term) ?? 0) + 1);
        for (const [term, tf] of counts) {
          let posting = postings.get(term);
          if (posting === undefined) postings.set(term, (posting = []));
          posting.push(doc, tf, list.length);
        }
      }
    }
    pending = [];
    pendingBytes = 0;
  };
  for await (const { oid, bytes } of readStoreBlobs(git, gitDir, [
    ...wanted.keys(),
  ])) {
    for (const path of wanted.get(oid) ?? []) {
      if (bytes === null) {
        count("filtered");
        continue;
      }
      if (bytes.byteLength > INDEX_BOUNDS.maxFileBytes) {
        count("over-size");
        continue;
      }
      const content = blobText(bytes);
      if (content === undefined) {
        count("binary");
        continue;
      }
      if (pending.length >= 64 || pendingBytes + bytes.byteLength > 256 * 1024)
        await flush();
      pending.push({ path, oid, bytes, content });
      pendingBytes += bytes.byteLength;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  await flush();
  assertOutlineSource(outline);
  const staging = `${folder}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(join(staging, "terms"), { recursive: true });
    const meta: Meta = {
      recipe: stackIndexRecipeKey(),
      source,
      retryable,
      tree,
      docs: docs.length,
      totalLength,
      files: entries.length,
      excluded,
      builtAt: new Date().toISOString(),
    };
    await writeFile(join(staging, "meta.json"), JSON.stringify(meta));
    await writeFile(join(staging, "docs.json"), JSON.stringify(docs));
    // Postings: one binary file; dictionaries: term -> [offset in triples, triples], per bucket.
    let total = 0;
    for (const list of postings.values()) total += list.length;
    const binary = new Uint32Array(total);
    const dictionaries = new Map<string, Record<string, [number, number]>>();
    let offset = 0;
    for (const [term, list] of postings) {
      binary.set(list, offset);
      const bucket = bucketOf(term);
      let dictionary = dictionaries.get(bucket);
      if (dictionary === undefined) dictionaries.set(bucket, (dictionary = {}));
      dictionary[term] = [offset / 3, list.length / 3];
      offset += list.length;
    }
    postings.clear();
    await writeFile(
      join(staging, "postings.bin"),
      new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength),
    );
    for (const [bucket, dictionary] of dictionaries)
      await writeFile(
        join(staging, "terms", `${bucket}.json`),
        JSON.stringify(dictionary),
      );
    const build = {
      docs: docs.length,
      bytes: await directoryBytes(staging),
      excluded,
    };
    return await withStoreLock(
      root,
      async () => {
        git.signal?.throwIfAborted();
        assertOutlineSource(outline);
        const current = await indexSnapshot(folder);
        if (!current.known || current.text !== seen.text)
          return {
            status: "deferred" as const,
            reason: "newer-build" as const,
          };
        const installed = await admit(build, async () => {
          git.signal?.throwIfAborted();
          await removeReadOnly(folder);
          git.signal?.throwIfAborted();
          assertOutlineSource(outline);
          await rename(staging, folder);
        });
        return installed
          ? { status: "built" as const, ...build }
          : { status: "deferred" as const, reason: "admission" as const };
      },
      undefined,
      git.signal,
    );
  } finally {
    await removeReadOnly(staging);
  }
};

const readMeta = async (
  root: string,
  tree: string,
  source: OutlineSource,
  allowRetryable = false,
): Promise<Meta | undefined> => {
  try {
    const parsed = safeRead(
      Meta,
      JSON.parse(
        await readFile(
          join(storeLayout(root).indexFolder(tree), "meta.json"),
          "utf8",
        ),
      ),
      { source: join(storeLayout(root).indexFolder(tree), "meta.json") },
    );
    return parsed.success &&
      parsed.data.recipe === stackIndexRecipeKey() &&
      JSON.stringify(parsed.data.source) ===
        JSON.stringify(stackIndexSource(source)) &&
      (allowRetryable || !parsed.data.retryable)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
};

/** Whether a tree has an index of the current recipe. */
export const isIndexed = async (
  root: string,
  tree: string,
  source: OutlineSource,
) => (await readMeta(root, tree, source)) !== undefined;

export interface StackHit extends StackDoc {
  readonly tree: string;
  readonly score: number;
}

/**
 * BM25 over the union of `trees`, each counted once. Trees without a current index are returned in
 * `notIndexed` and take no part; nothing is indexed here.
 */
export const searchTrees = async (
  root: string,
  trees: ReadonlyArray<string>,
  query: string,
  k: number,
  source: OutlineSource,
) => {
  const distinct = [...new Set(trees)];
  const queryTerms = [...new Set(terms(query))]
    .sort()
    .slice(0, STACK_LIMITS.queryTerms);
  const metas = new Map<string, Meta>();
  const notIndexed: Array<string> = [];
  for (const tree of distinct) {
    const meta = await readMeta(root, tree, source, true);
    if (meta === undefined) notIndexed.push(tree);
    else metas.set(tree, meta);
  }
  let documents = 0;
  let length = 0;
  for (const meta of metas.values()) {
    documents += meta.docs;
    length += meta.totalLength;
  }
  const average = documents === 0 ? 0 : length / documents;
  const postings = new Map<string, Map<string, ReadonlyArray<number>>>();
  const df = new Map<string, number>();
  const byBucket = new Map<string, Array<string>>();
  for (const term of queryTerms) {
    const bucket = bucketOf(term);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), term]);
  }
  for (const [tree] of metas) {
    const folder = storeLayout(root).indexFolder(tree);
    const perTerm = new Map<string, ReadonlyArray<number>>();
    const ranges: Array<{ term: string; at: number; count: number }> = [];
    for (const [bucket, wanted] of byBucket) {
      let dictionary: Record<string, [number, number]>;
      try {
        dictionary = JSON.parse(
          await readFile(join(folder, "terms", `${bucket}.json`), "utf8"),
        ) as Record<string, [number, number]>;
      } catch {
        continue;
      }
      for (const term of wanted) {
        const entry = dictionary[term];
        if (entry !== undefined)
          ranges.push({ term, at: entry[0], count: entry[1] });
      }
    }
    if (ranges.length > 0) {
      const handle = await open(join(folder, "postings.bin"), "r");
      try {
        for (const range of ranges) {
          const bytes = new Uint8Array(range.count * 12);
          await handle.read(bytes, 0, bytes.byteLength, range.at * 12);
          perTerm.set(range.term, Array.from(new Uint32Array(bytes.buffer)));
          df.set(range.term, (df.get(range.term) ?? 0) + range.count);
        }
      } finally {
        await handle.close();
      }
    }
    postings.set(tree, perTerm);
  }
  const scored: Array<{ tree: string; doc: number; score: number }> = [];
  for (const [tree, perTerm] of postings) {
    const scores = new Map<number, number>();
    for (const [term, list] of perTerm) {
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (documents - n + 0.5) / (n + 0.5));
      for (let at = 0; at + 2 < list.length; at += 3) {
        const doc = list[at] ?? 0;
        const tf = list[at + 1] ?? 0;
        const docLength = list[at + 2] ?? 0;
        const norm = 1 - BM25.b + (BM25.b * docLength) / (average || 1);
        scores.set(
          doc,
          (scores.get(doc) ?? 0) +
            (idf * tf * (BM25.k1 + 1)) / (tf + BM25.k1 * norm),
        );
      }
    }
    for (const [doc, score] of scores) scored.push({ tree, doc, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.tree < b.tree ? -1 : a.tree > b.tree ? 1 : a.doc - b.doc),
  );
  const top = scored.slice(0, k);
  const docsOf = new Map<
    string,
    ReadonlyArray<
      [
        string,
        string,
        number,
        number,
        StackDoc["kind"],
        string | null,
        string,
        string | null,
      ]
    >
  >();
  const hits: Array<StackHit> = [];
  for (const hit of top) {
    let docs = docsOf.get(hit.tree);
    if (docs === undefined) {
      docs = JSON.parse(
        await readFile(
          join(storeLayout(root).indexFolder(hit.tree), "docs.json"),
          "utf8",
        ),
      ) as ReadonlyArray<
        [
          string,
          string,
          number,
          number,
          StackDoc["kind"],
          string | null,
          string,
          string | null,
        ]
      >;
      docsOf.set(hit.tree, docs);
    }
    const doc = docs[hit.doc];
    if (doc === undefined) continue;
    hits.push({
      tree: hit.tree,
      score: hit.score,
      path: doc[0],
      blob: doc[1],
      startLine: doc[2],
      endLine: doc[3],
      kind: doc[4],
      symbol: doc[5],
      capability: doc[6],
      fallback: doc[7],
    });
  }
  return { hits, notIndexed, documents, terms: queryTerms };
};
