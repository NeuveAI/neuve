import {
  cpSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  initTreeRepository,
  writePackageTree,
  resolveGitBinary,
} from "../../../src/stack/git-store.ts";
import { scrubbedEnvironment } from "../../../src/stack/transport.ts";
import {
  buildTreeIndex,
  isIndexed,
  searchTrees,
} from "../../../src/stack/index-store.ts";
import { storeLayout } from "../../../src/stack/store.ts";
import {
  captureOutlineSource,
  outlineExecutable,
} from "../../../src/graph-outline.ts";
const [root, replacement, link] = Bun.argv.slice(2);
if (!root || !replacement || !link)
  throw new Error("Missing fixture arguments");
const gitPath = resolveGitBinary();
if (!gitPath) throw new Error("git required");
const git = {
  gitPath,
  env: scrubbedEnvironment({ gitPath, home: join(root, "home") }),
};
const files = join(root, "files");
mkdirSync(files);
writeFileSync(join(files, "one.ts"), "export const one = 1;\n");
const seed = join(root, "seed.git");
await initTreeRepository(git, seed);
const { tree } = await writePackageTree(
  git,
  seed,
  files,
  ["one.ts"],
  "fixture",
);
const store = join(root, "store");
mkdirSync(join(store, "trees"), { recursive: true });
cpSync(seed, storeLayout(store).treeRepository(tree), { recursive: true });
const firstKey = captureOutlineSource().key;
const firstExecutable = outlineExecutable();
const built = await buildTreeIndex(git, store, tree, captureOutlineSource());
const first = await searchTrees(
  store,
  [tree],
  "one",
  1,
  captureOutlineSource(),
);
const meta = JSON.parse(
  readFileSync(join(storeLayout(store).indexFolder(tree), "meta.json"), "utf8"),
);
unlinkSync(link);
symlinkSync(replacement, link);
const secondKey = captureOutlineSource().key;
const indexedAfterReplacement = await isIndexed(
  store,
  tree,
  captureOutlineSource(),
);
const stale = await searchTrees(
  store,
  [tree],
  "one",
  1,
  captureOutlineSource(),
);
console.log(
  JSON.stringify({
    firstKey,
    secondKey,
    firstExecutable,
    built,
    capability: first.hits[0]?.capability,
    metaSource: meta.source,
    indexedAfterReplacement,
    staleHits: stale.hits.length,
    notIndexed: stale.notIndexed,
    tree,
  }),
);
