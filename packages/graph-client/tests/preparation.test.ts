import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  planGraphPreparation,
  prepareGraphGeneration,
  type GraphCommandReceipt,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const fixture = async (repositoryName?: string) => {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-preparation-client-")),
  );
  roots.push(parent);
  const root =
    repositoryName === undefined ? parent : join(parent, repositoryName);
  if (repositoryName !== undefined) await mkdir(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "--quiet");
  git("config", "user.name", "Preparation fixture");
  git("config", "user.email", "fixture@example.test");
  await Bun.write(join(root, "source"), "first\n");
  git("add", "source");
  git("commit", "--quiet", "-m", "First");
  const revision = git("rev-parse", "HEAD");
  await Bun.write(join(root, "source"), "second\n");
  git("commit", "--quiet", "-am", "Second");
  await Bun.write(join(root, "source"), "dirty\n");
  const executable = join(root, "provider");
  const mode = join(root, "mode");
  const ready = join(root, "ready");
  await Bun.write(mode, "valid");
  await Bun.write(
    executable,
    `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs";
const mode=readFileSync(${JSON.stringify(mode)},"utf8");
const ready=${JSON.stringify(ready)};
const argv=process.argv.slice(2);
const option=name=>argv[argv.indexOf(name)+1];
const git=(...args)=>Bun.spawnSync(["git","-C",option("--repo"),...args],{stdout:"pipe",stderr:"pipe"}).stdout.toString().trim();
const build=createHash("sha256").update(readFileSync(import.meta.path)).digest("hex");
if(argv[0]==="version")console.log(JSON.stringify({version:"fixture",provider:"entire-graph",identity_revision:"fixture",build_identity:build}));
else if(argv[0]==="capabilities")console.log(JSON.stringify({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[],supported_languages:[],semantic_languages:[],inventory_only_languages:[],supported_relation_types:["DEFINES","CONTAINS"],relation_support_by_language:{},relation_support_by_profile:{"syntax-only":["DEFINES","CONTAINS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{incremental_preparation_plan:mode!=="unsupported"},features_requiring_network_access:{}}));
else if(argv[0]==="index"){
 if(mode==="mutate-frozen"){chmodSync(import.meta.path,0o700);writeFileSync(import.meta.path,readFileSync(import.meta.path,"utf8")+"\\n// mutated frozen copy\\n")}
 if(mode==="mismatch"||mode==="hostile"){console.error(mode==="mismatch"?"incremental preparation unavailable: generation-mismatch":"incremental preparation unavailable: generation-mismatch PRIVATE_VALUE");process.exit(1)}
 const generation=mode==="foreign-generation"?"c".repeat(64):"b".repeat(64);
 const selection={artifact_family:mode==="search-family"?"search-snapshot":"syntax-generation",generation_id:generation,policy_id:"a".repeat(64),producer_build_id:mode==="foreign-producer"?"d".repeat(64):build,source:{common_dir:mode==="foreign-owner"?"/foreign":git("rev-parse","--path-format=absolute","--git-common-dir"),scope:mode==="foreign-scope"?"foreign":""},external_policy_origin:"serving-directory-captured",gitignore_origin:"target-commit"};
 const commit=option("--commit");
 const common={format_version:1,provider:"entire-graph",provider_version:"fixture",repo_root:option("--repo"),commit:mode==="foreign-commit"?"f".repeat(40):commit,tree:git("rev-parse",commit+"^{tree}"),profile:mode==="foreign-profile"?"full":"syntax-only",prepared_read:selection};
 const service=mode!=="service"?{}:{service:{answered:true,rss_bytes:73400320,max_rss_bytes:73400320,cpu_user_ms:argv.includes("--plan")?40:640,cpu_system_ms:argv.includes("--plan")?10:80,queue_wait_ms:3,...(argv.includes("--plan")?{}:{cache_bytes:1048576,cache_cap_bytes:4294967296}),lane:"prepare",class:"background"}};
 if(argv.includes("--plan"))console.log(JSON.stringify({...common,preparation_plan:{availability:mode==="invalid-availability"?"unknown":existsSync(ready)?"ready":"absent"},...(mode==="fake-work"?{index_cache_hit:false}:{}),...service}));
 else{const hit=existsSync(ready);writeFileSync(ready,"ready");console.log(JSON.stringify({...common,index_cache_hit:hit,warnings:[],partial_failures:[],completeness:{health:{status:"complete"}},incremental_preparation:{generation_id:generation,extracted_files:hit?0:2,reused_files:0,uncacheable_files:0,supported_relation_types:["DEFINES","CONTAINS"],relationship_resolution:"none",unchanged_content_identification:"sha256-content-read",source_enumeration:"target-tree"},...service}))}
} else process.exit(2);
`,
  );
  await chmod(executable, 0o700);
  const commands: GraphCommandReceipt[] = [];
  return {
    request: { executable, repository: root, revision },
    run: {
      onCommand: (receipt: GraphCommandReceipt) => commands.push(receipt),
    },
    commands,
    mode: (value: string) => Bun.write(mode, value),
    ready,
  };
};

test("exact historical plan stays absent until guarded preparation, then ready and zero retry work", async () => {
  const f = await fixture();
  const plan = await Effect.runPromise(planGraphPreparation(f.request, f.run));
  expect(plan.availability).toBe("absent");
  expect(plan.selection.generationId).toBe("b".repeat(64));
  expect(String(plan.source.revision)).toBe(f.request.revision);
  expect(plan).not.toHaveProperty("preparedRead");
  expect(await Bun.file(f.ready).exists()).toBe(false);
  const request = {
    ...f.request,
    expectedGeneration: plan.selection.generationId,
  };
  const prepared = await Effect.runPromise(
    prepareGraphGeneration(request, f.run),
  );
  expect(prepared.work).toMatchObject({
    alreadyPublished: false,
    extractedFiles: 2,
    reusedFiles: 0,
  });
  expect(prepared.work.relationshipResolution).toBe("none");
  expect(
    (await Effect.runPromise(planGraphPreparation(request, f.run)))
      .availability,
  ).toBe("ready");
  expect(
    (await Effect.runPromise(prepareGraphGeneration(request, f.run))).work,
  ).toMatchObject({
    alreadyPublished: true,
    extractedFiles: 0,
    reusedFiles: 0,
  });
  expect(
    f.commands.filter(
      (c) => c.argv.includes("worktree") || c.stage === "query",
    ),
  ).toEqual([]);
  expect(
    f.commands
      .filter((c) => c.stage === "index")
      .map((c) => c.argv.includes("--plan")),
  ).toEqual([true, false, true, false]);
  // Alone 1.03-1.13 s; 10x slowest, at least 30 s; child processes and disk I/O under load.
}, 30_000);

// Why: with the service setting on, Graph reports a plan's and a preparation's account as the
// receipt's last field (a plan's never with the cache's size), and the harness takes their CPU from
// it; an older engine reports none. Both must run from the build's one engine copy, since the
// service, which runs preparations in a lane of their own, is one per executable path.
test("a plan and a preparation carry the service's block, from the build's one engine copy", async () => {
  const f = await fixture();
  expect(
    (await Effect.runPromise(planGraphPreparation(f.request, f.run))).service,
  ).toBeUndefined();
  await f.mode("service");
  const plan = await Effect.runPromise(planGraphPreparation(f.request, f.run));
  expect(plan.service).toStrictEqual({
    answered: true,
    lane: "prepare",
    class: "background",
    queueWaitMs: 3,
    cpuUserMs: 40,
    cpuSystemMs: 10,
    rssBytes: 73400320,
    maxRssBytes: 73400320,
  });
  const prepared = await Effect.runPromise(
    prepareGraphGeneration(
      { ...f.request, expectedGeneration: plan.selection.generationId },
      f.run,
    ),
  );
  expect(prepared.service).toMatchObject({
    answered: true,
    lane: "prepare",
    cpuUserMs: 640,
    cpuSystemMs: 80,
    cacheBytes: 1048576,
    cacheCapBytes: 4294967296,
  });
  const engines = new Set(
    f.commands.filter((c) => c.stage === "index").map((c) => c.argv[0]),
  );
  expect(engines.size).toBe(1);
  expect(
    [...engines][0]!.startsWith(
      `${await realpath(join(f.request.repository, ".git/neuve/graph/cache"))}/executables/`,
    ),
  ).toBe(true);
  // Alone 0.80-1.03 s; 10x slowest, at least 30 s; child processes and disk I/O under load.
}, 30_000);

test.each([
  "foreign-producer",
  "foreign-owner",
  "foreign-scope",
  "foreign-generation",
  "foreign-commit",
  "foreign-profile",
  "search-family",
  "invalid-availability",
  "fake-work",
])("plan refuses incompatible receipt %s", async (mode) => {
  const f = await fixture();
  await f.mode(mode);
  const error = await Effect.runPromise(
    planGraphPreparation(
      { ...f.request, expectedGeneration: "b".repeat(64) },
      f.run,
    ).pipe(Effect.catch((error) => Effect.succeed(error))),
  );
  expect(error).toMatchObject({
    _tag: "GraphPreparationError",
    reason: "invalid-receipt",
  });
  expect(await Bun.file(f.ready).exists()).toBe(false);
});

test("unsupported and invalid selectors dispatch no preparation", async () => {
  const f = await fixture();
  await f.mode("unsupported");
  const unsupported = await Effect.runPromise(
    planGraphPreparation(f.request, f.run).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    ),
  );
  expect(unsupported).toMatchObject({ reason: "unsupported-provider" });
  expect(f.commands.some((c) => c.stage === "index")).toBe(false);
  f.commands.length = 0;
  const invalid = await Effect.runPromise(
    planGraphPreparation({ ...f.request, revision: "HEAD" }, f.run).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    ),
  );
  expect(invalid).toMatchObject({ reason: "input" });
  expect(f.commands).toEqual([]);
});

test.each([
  ["mismatch", "generation-mismatch"],
  ["hostile", "command"],
])(
  "native refusal %s preserves bounded error classification",
  async (mode, reason) => {
    const f = await fixture();
    await f.mode(mode);
    const error = await Effect.runPromise(
      prepareGraphGeneration(
        { ...f.request, expectedGeneration: "b".repeat(64) },
        f.run,
      ).pipe(Effect.catch((error) => Effect.succeed(error))),
    );
    expect(error).toMatchObject({ reason });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_VALUE");
    expect(await Bun.file(f.ready).exists()).toBe(false);
  },
);

test("pre-aborted preparation writes nothing", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  const error = await Effect.runPromise(
    prepareGraphGeneration(
      { ...f.request, expectedGeneration: "b".repeat(64) },
      { ...f.run, signal: controller.signal },
    ).pipe(Effect.catch((error) => Effect.succeed(error))),
  );
  expect(error).toMatchObject({ reason: "cancelled" });
  expect(f.commands).toEqual([]);
  expect(await Bun.file(f.ready).exists()).toBe(false);
});

test("failed evidence observer prevents preparation dispatch", async () => {
  const f = await fixture();
  const observed: GraphCommandReceipt[] = [];
  const error = await Effect.runPromise(
    prepareGraphGeneration(
      { ...f.request, expectedGeneration: "b".repeat(64) },
      {
        onCommand: (receipt) => {
          observed.push(receipt);
          throw new Error("Observer fixture failure");
        },
      },
    ).pipe(Effect.catch((error) => Effect.succeed(error))),
  );
  expect(error).toMatchObject({ reason: "observer" });
  expect(observed.some((receipt) => receipt.stage === "index")).toBe(false);
  expect(await Bun.file(f.ready).exists()).toBe(false);
});

test("plan rejects a frozen executable that mutates after identity reporting", async () => {
  const f = await fixture();
  await f.mode("mutate-frozen");
  const configuredSource = await Bun.file(f.request.executable).text();
  const error = await Effect.runPromise(
    planGraphPreparation(f.request, f.run).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    ),
  );
  expect(error).toMatchObject({ reason: "invalid-receipt" });
  expect(await Bun.file(f.request.executable).text()).toBe(configuredSource);
  expect(await Bun.file(f.ready).exists()).toBe(false);
});

test("repository suffix cannot attribute an exact-commit probe as a tree probe", async () => {
  const f = await fixture("repository^{tree}");
  await Effect.runPromise(planGraphPreparation(f.request, f.run));
  const commit = f.commands.find((receipt) =>
    receipt.argv.includes(`${f.request.revision}^{commit}`),
  );
  expect(commit?.stage).toBe("git_revision");
  expect(commit?.argv).toContain(f.request.repository);
  const tree = f.commands.find((receipt) =>
    receipt.argv.includes(`${f.request.revision}^{tree}`),
  );
  expect(tree?.stage).toBe("git_tree");
});

test("cancellation observed after version prevents the next Git probe and Graph dispatch", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const observations: string[] = [];
  const error = await Effect.runPromise(
    planGraphPreparation(f.request, {
      ...f.run,
      signal: controller.signal,
      onGitObservation: (observation) => {
        observations.push(observation.command);
        controller.abort();
      },
    }).pipe(Effect.catch((error) => Effect.succeed(error))),
  );
  expect(error).toMatchObject({ reason: "cancelled" });
  expect(observations).toEqual(["version"]);
  expect(f.commands.some((receipt) => receipt.stage === "index")).toBe(false);
});

test("Git observation callback failure retains process observation and prevents Graph dispatch", async () => {
  const f = await fixture();
  const observations: unknown[] = [];
  const error = await Effect.runPromise(
    planGraphPreparation(f.request, {
      ...f.run,
      onGitObservation: (observation) => {
        observations.push(observation);
        throw new Error("literal Git observation failure");
      },
    }).pipe(Effect.catch((error) => Effect.succeed(error))),
  );
  expect(error).toMatchObject({ reason: "observer" });
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    command: "version",
    termination: { kind: "exit", code: 0 },
    refusal: null,
  });
  expect(f.commands.some((receipt) => receipt.stage === "index")).toBe(false);
});

test.each([
  "\n[core]\nnotes = harmless # \\\n[include]\npath = absent-local-config\n",
  '\n[remote "probe"]\npromisor = true\n',
])(
  "unsupported local config refuses before Git in plan and prepare: %s",
  async (configuration) => {
    const f = await fixture();
    const config = join(f.request.repository, ".git/config");
    await Bun.write(config, (await Bun.file(config).text()) + configuration);
    const planned = await Effect.runPromise(
      planGraphPreparation(f.request, f.run).pipe(
        Effect.catch((error) => Effect.succeed(error)),
      ),
    );
    expect(planned).toMatchObject({ reason: "source-unavailable" });
    const prepared = await Effect.runPromise(
      prepareGraphGeneration(
        { ...f.request, expectedGeneration: "b".repeat(64) },
        f.run,
      ).pipe(Effect.catch((error) => Effect.succeed(error))),
    );
    expect(prepared).toMatchObject({ reason: "source-unavailable" });
    expect(f.commands).toEqual([]);
  },
);

test("missing exact commit keeps Git refusal ahead of an observer failure and dispatches no Graph", async () => {
  const f = await fixture();
  const observations: unknown[] = [];
  const error = await Effect.runPromise(
    planGraphPreparation(
      { ...f.request, revision: "1".repeat(40) },
      {
        ...f.run,
        onGitObservation: (observation) => {
          observations.push(observation);
          if (observation.command === "exact-commit")
            throw new Error("literal observer failure after missing commit");
        },
      },
    ).pipe(Effect.catch((error) => Effect.succeed(error))),
  );
  expect(error).toMatchObject({
    reason: "command",
    cause: { reason: "command", detail: "git-read" },
  });
  expect(observations.at(-1)).toMatchObject({
    command: "exact-commit",
    refusal: "git-read",
    termination: { kind: "exit", code: 128 },
  });
  expect(f.commands.some((receipt) => receipt.stage === "index")).toBe(false);
  expect(
    f.commands.some(
      (receipt) => receipt.stage === "git_revision" && receipt.exitCode === 128,
    ),
  ).toBe(true);
  expect(await Bun.file(f.ready).exists()).toBe(false);
});

test("cancellation while waiting for a launch port is typed cancelled", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let calls = 0;
  const error = await Effect.runPromise(
    prepareGraphGeneration(
      { ...f.request, expectedGeneration: "b".repeat(64) },
      {
        ...f.run,
        signal: controller.signal,
        spawnProcess: async () => {
          calls++;
          controller.abort();
          throw new Error("All fibers interrupted without error");
        },
      },
    ).pipe(Effect.catch((error) => Effect.succeed(error))),
  );
  expect(error).toMatchObject({ reason: "cancelled" });
  expect(calls).toBe(1);
});
