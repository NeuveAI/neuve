import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  initTreeRepository,
  writePackageTree,
  resolveGitBinary,
} from "../src/stack/git-store.ts";
import { scrubbedEnvironment } from "../src/stack/transport.ts";
import {
  buildTreeIndex,
  isIndexed,
  searchTrees,
} from "../src/stack/index-store.ts";
import { storeLayout } from "../src/stack/store.ts";
import { treeIndex } from "../src/search-index.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";

const root = mkdtempSync(join(tmpdir(), "graph-source-binding-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const engineA = resolve(
  import.meta.dir,
  "../../../apps/neuve-graph/entire-graph",
);
const gitPath = resolveGitBinary();
if (!gitPath) throw new Error("Git required");

for (const kind of ["stack", "snapshot"] as const)
  for (const phase of ["before-graph", "freeze-ABA"] as const)
    test(`${kind} discards an engine change ${phase} and the next request rebuilds`, async () => {
      const directory = join(root, `${kind}-${phase}`);
      const files = join(directory, "files");
      mkdirSync(files, { recursive: true });
      writeFileSync(
        join(files, "unit.ts"),
        `export function correctFromA() { return 1; } // ${kind}-${phase}\n`,
      );
      const git = {
        gitPath,
        env: scrubbedEnvironment({ gitPath, home: join(directory, "home") }),
      };
      const repository = join(directory, "seed.git");
      await initTreeRepository(git, repository);
      const { tree } = await writePackageTree(
        git,
        repository,
        files,
        ["unit.ts"],
        "fixture",
      );
      const store = join(directory, "store");
      mkdirSync(join(store, "trees"), { recursive: true });
      const { cpSync } = await import("node:fs");
      cpSync(repository, storeLayout(store).treeRepository(tree), {
        recursive: true,
      });
      const engine = join(directory, "engine");
      symlinkSync(engineA, engine);
      const engineB = join(directory, "engine-b");
      const marker = join(directory, "b-ran");
      // A second validated provider records its execution and returns visibly different symbols.
      writeFileSync(
        engineB,
        `#!${process.execPath}
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,unlinkSync,symlinkSync} from "node:fs";
const args=Bun.argv.slice(2), emit=x=>console.log(JSON.stringify(x));
if(args[0]==="version") emit({provider:"entire-graph",version:"binding-fixture",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if(args[0]==="capabilities") emit({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["DEFINES","CONTAINS"],relation_selection_modes:["exact"],relation_families:{},relation_support_by_language:{},relation_support_by_profile:{"syntax-only":["DEFINES","CONTAINS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{symbols_outline:true},features_requiring_network_access:{}});
else if(args[0]==="symbols") {
 writeFileSync(${JSON.stringify(marker)},"B");
 emit({schema_version:"1.3",provider:"entire-graph",provider_version:"binding-fixture",identity_revision:"4",repo_root:args[args.indexOf("--repo")+1],profile:"syntax-only"});
 emit({record_type:"symbol",id:"b",kind:"function",name:"badFromB",qualified_name:"badFromB",file_path:"unit.ts",start_line:1,end_line:1,language:"TypeScript"});
 emit({record_type:"file_outline",file_path:"unit.ts",language:"TypeScript",top_level:[{start_line:1,end_line:1,type:"function_declaration"}],identifiers:[[1,"badFromB"]]});
 emit({record_type:"summary",partial_failures:[]});
 if(${phase === "freeze-ABA"}) { unlinkSync(${JSON.stringify(engine)}); symlinkSync(${JSON.stringify(engineA)},${JSON.stringify(engine)}); }
}
`,
      );
      chmodSync(engineB, 0o700);
      const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
      process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = engine;
      const originalSpawn = Bun.spawn,
        originalFile = Bun.file;
      let swapped = false;
      const swap = () => {
        unlinkSync(engine);
        symlinkSync(engineB, engine);
        swapped = true;
      };
      const swapMarker = join(directory, "swapped");
      const wrapper = join(directory, "git-swap");
      writeFileSync(
        wrapper,
        `#!${process.execPath}\nimport {existsSync,unlinkSync,symlinkSync,writeFileSync} from "node:fs"; if(!existsSync(${JSON.stringify(swapMarker)})) { unlinkSync(${JSON.stringify(engine)}); symlinkSync(${JSON.stringify(engineB)},${JSON.stringify(engine)}); writeFileSync(${JSON.stringify(swapMarker)},"B"); } const child=Bun.spawn([${JSON.stringify(gitPath)},...Bun.argv.slice(2)],{stdin:"inherit",stdout:"inherit",stderr:"inherit"}); process.exitCode=await child.exited;\n`,
      );
      chmodSync(wrapper, 0o700);
      if (phase === "before-graph" && kind === "snapshot") {
        // The first tree listing is after the index key's fingerprint, before any outline read.
        Bun.spawn = new Proxy(originalSpawn, {
          apply(target, receiver, args) {
            const argv = args[0];
            if (!swapped && Array.isArray(argv) && argv.includes("ls-tree"))
              swap();
            return Reflect.apply(target, receiver, args);
          },
        });
      } else if (phase === "freeze-ABA") {
        // Graph-client checks existence after the caller's fingerprint, before freezing its file.
        Bun.file = new Proxy(originalFile, {
          apply(target, receiver, args) {
            const file = Reflect.apply(target, receiver, args);
            if (args[0] !== engine || swapped) return file;
            return new Proxy(file, {
              get(target, key) {
                if (key === "exists")
                  return async () => {
                    const exists = await target.exists();
                    if (!swapped) swap();
                    return exists;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        });
      }
      const location = storeLocationIn(join(directory, "records"));
      const layer = Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(
          Layer.effectDiscard(Store.prepareForWrite).pipe(
            Layer.provideMerge(Store.layer(location, { create: true })),
          ),
        ),
        Layer.provideMerge(BunFileSystem.layer),
      );
      const snapshot = () =>
        Effect.runPromise(
          treeIndex(repository, tree, captureOutlineSource()).pipe(
            Effect.provideService(CpuWork, {
              budget: new Scheduler(1),
              priority: {
                class: "interactive",
                position: "understand",
                stage: 0,
              },
              inherited: true,
            }),
            Effect.provideService(CodeWork, {
              directory: location.directory,
              background: false,
            }),
            Effect.provide(layer),
          ),
        );
      const attempt = () =>
        kind === "stack"
          ? buildTreeIndex(
              phase === "before-graph" ? { ...git, gitPath: wrapper } : git,
              store,
              tree,
              captureOutlineSource(),
            )
          : snapshot();
      try {
        const source = captureOutlineSource().key;
        const outcome = await attempt().then(
          () => "published",
          (error) => String(error),
        );
        Bun.spawn = originalSpawn;
        Bun.file = originalFile;
        swapped ||= existsSync(swapMarker);
        const published =
          kind === "stack"
            ? existsSync(storeLayout(store).indexFolder(tree))
            : existsSync(join(location.directory, "code-work/indexes")) &&
              readdirSync(join(location.directory, "code-work/indexes")).some(
                (name) => name.endsWith(".index"),
              );
        console.info(
          JSON.stringify({
            kind,
            phase,
            source,
            outcome,
            swapped,
            engineBProducedChunks: existsSync(marker),
            published,
          }),
        );
        expect(swapped).toBe(true);
        if (phase === "freeze-ABA") expect(existsSync(marker)).toBe(true);
        expect(outcome).not.toBe("published");
        expect(published).toBe(false);
        unlinkSync(engine);
        symlinkSync(engineA, engine);
        if (kind === "stack") {
          expect(await isIndexed(store, tree, captureOutlineSource())).toBe(
            false,
          );
          expect(
            (await buildTreeIndex(git, store, tree, captureOutlineSource()))
              .status,
          ).toBe("built");
          expect(await isIndexed(store, tree, captureOutlineSource())).toBe(
            true,
          );
          const search = await searchTrees(
            store,
            [tree],
            "correctFromA",
            1,
            captureOutlineSource(),
          );
          expect(search.hits[0]?.capability).toBe("graph-symbols");
          const meta = JSON.parse(
            readFileSync(
              join(storeLayout(store).indexFolder(tree), "meta.json"),
              "utf8",
            ),
          );
          expect(meta.source).toEqual({ kind: "available", ...source });
        } else {
          const rebuilt = await snapshot();
          expect(rebuilt.cached).toBe(false);
          expect(rebuilt.index.chunks[0]?.symbol).toBe("correctFromA");
          expect((await snapshot()).cached).toBe(true);
        }
      } finally {
        Bun.spawn = originalSpawn;
        Bun.file = originalFile;
        if (previous === undefined)
          delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
        else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
      }
    }, 30_000);
