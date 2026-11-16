import { captureOutlineSource } from "../src/graph-outline.ts";
import { test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { commitHunks } from "../src/commit-prepare.ts";
import { indexRecipe } from "../src/search-index.ts";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
test("stored commit hunks use the source identity in their key", async () => {
  const root = mkdtempSync(join(tmpdir(), "outer-source-"));
  const a = resolve(import.meta.dir, "../../../apps/neuve-graph/entire-graph"),
    b = join(root, "b"),
    engine = join(root, "engine");
  const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
  try {
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(["git", "-C", root, ...args]);
      if (p.exitCode) throw Error(p.stderr.toString());
      return p.stdout.toString().trim();
    };
    git("init", "-q");
    const blob = Bun.spawnSync(
      ["git", "-C", root, "hash-object", "-w", "--stdin"],
      {
        stdin: new TextEncoder().encode(
          "export function correctFromA(){return 1;}\n",
        ),
      },
    )
      .stdout.toString()
      .trim();
    const tree = Bun.spawnSync(["git", "-C", root, "mktree"], {
      stdin: new TextEncoder().encode(`100644 blob ${blob}\tunit.ts\n`),
    })
      .stdout.toString()
      .trim();
    writeFileSync(
      b,
      `#!${process.execPath}
import{createHash}from'node:crypto';import{readFileSync}from'node:fs';const args=Bun.argv.slice(2),emit=x=>console.log(JSON.stringify(x));
if(args[0]==='version')emit({provider:'entire-graph',version:'outer-fixture',identity_revision:'4',build_identity:createHash('sha256').update(readFileSync(import.meta.path)).digest('hex')});
else if(args[0]==='capabilities')emit({schema_version:'1.3',provider:'entire-graph',supported_file_extensions:['.ts'],supported_languages:['TypeScript'],semantic_languages:['TypeScript'],inventory_only_languages:[],supported_relation_types:['DEFINES','CONTAINS'],relation_selection_modes:['exact'],relation_families:{},relation_support_by_language:{},relation_support_by_profile:{'syntax-only':['DEFINES','CONTAINS']},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{symbols_outline:true},features_requiring_network_access:{}});
else if(args[0]==='symbols'){emit({schema_version:'1.3',provider:'entire-graph',provider_version:'outer-fixture',identity_revision:'4',repo_root:args[args.indexOf('--repo')+1],profile:'syntax-only'});emit({record_type:'symbol',id:'b',kind:'function',name:'badFromB',qualified_name:'badFromB',file_path:'unit.ts',start_line:1,end_line:1,language:'TypeScript'});emit({record_type:'file_outline',file_path:'unit.ts',language:'TypeScript',top_level:[{start_line:1,end_line:1,type:'function_declaration'}],identifiers:[[1,'badFromB']]});emit({record_type:'summary',partial_failures:[]});}
`,
    );
    chmodSync(b, 0o700);
    symlinkSync(a, engine);
    process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = engine;
    const oldTree = Bun.spawnSync(["git", "-C", root, "mktree"], {
      stdin: new Uint8Array(),
    })
      .stdout.toString()
      .trim();
    const source = captureOutlineSource();
    const sourceAtKey = indexRecipe(source).chunker;
    const task = commitHunks(root, oldTree, tree, source);
    unlinkSync(engine);
    symlinkSync(b, engine);
    const location = storeLocationIn(join(root, "records"));
    const layer = Computations.layer.pipe(
      Layer.provideMerge(Blobs.layer(location)),
      Layer.provideMerge(
        Layer.effectDiscard(Store.prepareForWrite).pipe(
          Layer.provideMerge(Store.layer(location, { create: true })),
        ),
      ),
      Layer.provideMerge(BunFileSystem.layer),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Effect.result(task);
        unlinkSync(engine);
        symlinkSync(a, engine);
        const second = yield* commitHunks(
          root,
          oldTree,
          tree,
          captureOutlineSource(),
        );
        return {
          firstStatus: first._tag,
          secondStatus: second.status,
          sameKey: first._tag === "Success" && first.success.key === second.key,
          firstSymbols:
            first._tag === "Success"
              ? first.success.value.hunks[0]?.query?.symbols
              : undefined,
          secondSymbols: second.value.hunks[0]?.query?.symbols,
        };
      }).pipe(
        Effect.provideService(CpuWork, {
          budget: new Scheduler(1),
          priority: { class: "interactive", position: "understand", stage: 0 },
          inherited: true,
        }),
        Effect.provide(layer),
      ),
    );
    console.log(
      JSON.stringify({
        sourceAtKey,
        currentSource: indexRecipe(captureOutlineSource()).chunker,
        ...result,
      }),
    );
    expect(result.firstSymbols ?? ["correctFromA"]).toContain("correctFromA");
    expect(result.secondSymbols).toContain("correctFromA");
    expect(result.secondStatus).toBe("computed");
    const third = await Effect.runPromise(
      commitHunks(root, oldTree, tree, captureOutlineSource()).pipe(
        Effect.provide(layer),
      ),
    );
    expect(third.status).toBe("reused");
    expect(third.value.hunks[0]?.query?.symbols).toContain("correctFromA");
  } finally {
    if (previous === undefined)
      delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
