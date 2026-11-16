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
import { SharedWork } from "@neuve/records-core/shared-work";
import { indexOf } from "../src/retrievers.ts";
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
test("shared tree materialization serves an index from its keyed engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "outer-source-"));
  const a = resolve(import.meta.dir, "../../../apps/neuve-graph/entire-graph"),
    b = join(root, "b"),
    engine = join(root, "engine");
  const previous = process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
  const original = SharedWork.prototype.run;
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
    const source = captureOutlineSource();
    const expected = indexRecipe(source);
    let heldKey = "";
    SharedWork.prototype.run = new Proxy(original, {
      apply(target, receiver, args) {
        const options: Parameters<typeof original>[0] = args[0];
        if (!String(options.key).startsWith("tree-index@1"))
          return Reflect.apply(target, receiver, args);
        heldKey = options.key;
        unlinkSync(engine);
        symlinkSync(b, engine);
        return Reflect.apply(target, receiver, args).finally(() => {
          unlinkSync(engine);
          symlinkSync(a, engine);
        });
      },
    });
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
    const value = await Effect.runPromise(
      indexOf(root, tree, source).pipe(
        Effect.provideService(CpuWork, {
          budget: new Scheduler(1),
          priority: { class: "interactive", position: "understand", stage: 0 },
          inherited: true,
        }),
        Effect.provide(layer),
      ),
    ).then(
      (value) => ({ kind: "success" as const, value }),
      (error) => ({ kind: "refused" as const, error: String(error) }),
    );
    console.info(
      JSON.stringify({
        keyedSource: JSON.parse(heldKey.split("\0")[2] ?? "{}").chunker.source,
        expectedKey: heldKey.includes(JSON.stringify(expected)),
        outcome: value.kind,
        symbol:
          value.kind === "success"
            ? value.value.index.chunks[0]?.symbol
            : undefined,
      }),
    );
    expect(heldKey.includes(JSON.stringify(expected))).toBe(true);
    if (value.kind === "success")
      expect(value.value.index.chunks[0]?.symbol).toBe("correctFromA");
    SharedWork.prototype.run = original;
    const next = await Effect.runPromise(
      indexOf(root, tree, captureOutlineSource()).pipe(
        Effect.provideService(CpuWork, {
          budget: new Scheduler(1),
          priority: { class: "interactive", position: "understand", stage: 0 },
          inherited: true,
        }),
        Effect.provide(layer),
      ),
    );
    expect(next.index.chunks[0]?.symbol).toBe("correctFromA");
  } finally {
    SharedWork.prototype.run = original;
    if (previous === undefined)
      delete process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE;
    else process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
