// Why: a failed or interrupted real Vite build must never become a reusable artifact.
import { expect, test, spyOn } from "bun:test";
import { SharedWork } from "@neuve/records-core/shared-work";
import { existsSync } from "node:fs";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../scripts/pi-storage.ts";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildReviewWeb,
  reviewSourceKey,
} from "../src/workspace-review-build.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "review-build-failed-"));
  const webRoot = join(directory, "apps/neuve-web/apps/web");
  await mkdir(webRoot, { recursive: true });
  const environment = {
    PATH: process.env.PATH,
    HOME: directory,
    NEUVE_BUDGET_DIRECTORY: join(directory, "budget"),
    TMPDIR: directory,
    BUN_TMPDIR: tmpdir(),
  };
  const initialized = Bun.spawnSync(["git", "init", "-q", directory], {
    env: environment,
  });
  if (initialized.exitCode) throw new Error(initialized.stderr.toString());
  await writeFile(
    join(directory, ".gitignore"),
    "node_modules\nbuilds/\ncache/\ntmp/\n",
  );
  await mkdir(join(webRoot, "node_modules"));
  await symlink(
    dirname(
      Bun.resolveSync(
        "vite/package.json",
        resolve(import.meta.dir, "../../neuve-web/apps/web"),
      ),
    ),
    join(webRoot, "node_modules/vite"),
    "dir",
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      workspaces: ["packages/*", "apps/neuve-web/apps/web"],
    }),
  );
  await writeFile(
    join(webRoot, "package.json"),
    JSON.stringify({ name: "web", dependencies: { vite: "*" } }),
  );
  return {
    directory,
    webRoot,
    options: {
      source: directory,
      base: `/review/${"a".repeat(64)}/`,
      builds: join(directory, "builds"),
      cache: join(directory, "cache"),
      temporary: tmpdir(),
      executable: process.execPath,
      environment,
      log: join(directory, "build.log"),
    },
  };
}

// Why: compiler failure must publish no usable output and source edits must invalidate its key.
test("a real Vite failure leaves neither a publication nor an attempt, and changed source changes the key", async () => {
  const { directory, webRoot, options } = await fixture();
  try {
    const config = join(webRoot, "vite.config.ts");
    await writeFile(
      config,
      'throw new Error("deliberate build failure"); export default {};',
    );
    const firstKey = await reviewSourceKey(directory);
    await expect(
      buildReviewWeb({ ...options, signal: new AbortController().signal }),
    ).rejects.toThrow(options.log);
    expect(await Bun.file(options.log).text()).toContain(
      "deliberate build failure",
    );
    const builds = join(options.builds, "workspace-web-v5");
    expect(
      await Array.fromAsync(
        new Bun.Glob("**/attempt-*").scan({ cwd: builds, onlyFiles: false }),
      ),
    ).toEqual([]);
    expect(
      await Array.fromAsync(new Bun.Glob("**/complete").scan(builds)),
    ).toEqual([]);
    await writeFile(
      config,
      'throw new Error("another failure"); export default {};',
    );
    expect(await reviewSourceKey(directory)).not.toBe(firstKey);
    // A removed asset must differ even when its bytes matched the old deletion marker.
    const asset = join(webRoot, "asset.txt");
    await writeFile(asset, "deleted");
    const staged = Bun.spawnSync(["git", "-C", directory, "add", asset]);
    if (staged.exitCode) throw new Error(staged.stderr.toString());
    const present = await reviewSourceKey(directory);
    await rm(asset);
    expect(await reviewSourceKey(directory)).not.toBe(present);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// Why: stop must end the compiler and clean its attempt before returning.
test("stopping the workspace interrupts a real build and removes its unpublished output", async () => {
  const { directory, webRoot, options } = await fixture();
  const controller = new AbortController();
  const pid = join(directory, "build.pid");
  await writeFile(
    join(webRoot, "vite.config.ts"),
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pid)},String(process.pid)); process.kill(${process.pid},"SIGUSR2"); await Bun.sleep(60000); export default {};`,
  );
  // A signal from Vite proves it entered its config before cancellation.
  const entered = Promise.withResolvers<void>();
  const onEntry = () => entered.resolve();
  process.once("SIGUSR2", onEntry);
  const timeout = setTimeout(
    () => entered.reject(new Error("Build did not start")),
    10_000,
  );
  try {
    const building = buildReviewWeb({ ...options, signal: controller.signal });
    // Attach rejection before signalling, so cancellation cannot become unhandled.
    const stopped = building.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    controller.abort();
    const failure = await stopped;
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("Expected a cancelled build");
    expect(failure.message).toContain(options.log);
    const processId = Number(await Bun.file(pid).text());
    expect(() => process.kill(processId, 0)).toThrow();
    const builds = join(options.builds, "workspace-web-v5");
    expect(
      await Array.fromAsync(
        new Bun.Glob("**/attempt-*").scan({ cwd: builds, onlyFiles: false }),
      ),
    ).toEqual([]);
    expect(
      await Array.fromAsync(new Bun.Glob("**/complete").scan(builds)),
    ).toEqual([]);
  } finally {
    controller.abort();
    clearTimeout(timeout);
    process.off("SIGUSR2", onEntry);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

// Why: workspace source and installed dependency changes must never reopen a stale client.
test("the key follows workspace dependencies, their manifests and newly reached packages", async () => {
  const { directory, webRoot } = await fixture();
  const addPackage = async (name: string, dependencies = {}) => {
    const root = join(directory, "packages", name);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: `@cache/${name}`, dependencies }),
    );
    await mkdir(join(directory, "node_modules/@cache"), { recursive: true });
    await symlink(root, join(directory, "node_modules/@cache", name));
    return root;
  };
  try {
    const schema = await addPackage("records-schema");
    await writeFile(
      join(webRoot, "package.json"),
      JSON.stringify({
        dependencies: { vite: "*", "@cache/records-schema": "workspace:*" },
      }),
    );
    const envelope = join(schema, "src/envelope.ts");
    await writeFile(envelope, 'export const Ulid = "original";');
    const first = await reviewSourceKey(directory);
    await writeFile(envelope, 'export const Ulid = "MARKER_XYZ";');
    const changed = await reviewSourceKey(directory);
    expect(changed).not.toBe(first);
    const extra = await addPackage("new-dependency");
    await writeFile(
      join(schema, "package.json"),
      JSON.stringify({
        name: "@cache/records-schema",
        dependencies: { "@cache/new-dependency": "workspace:*" },
      }),
    );
    const reached = await reviewSourceKey(directory);
    expect(reached).not.toBe(changed);
    await writeFile(join(extra, "src/index.ts"), "export const value = 42;");
    expect(await reviewSourceKey(directory)).not.toBe(reached);
    const beforeManifest = await reviewSourceKey(directory);
    await writeFile(
      join(extra, "package.json"),
      JSON.stringify({
        name: "@cache/new-dependency",
        exports: "./src/index.ts",
      }),
    );
    expect(await reviewSourceKey(directory)).not.toBe(beforeManifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// Why: Git lists directory links and nested repositories as entries too, and links must stay opaque.
test("the key hashes links and directories without following them outside the repository", async () => {
  const { directory, webRoot, options } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "review-outside-"));
  try {
    await writeFile(
      join(webRoot, "vite.config.ts"),
      'throw new Error("link fixture reached Vite"); export default {};',
    );
    await writeFile(join(outside, "private.txt"), "first");
    await symlink(outside, join(webRoot, "linkdir"));
    const nested = join(webRoot, "nested");
    await mkdir(nested);
    const init = Bun.spawnSync(["git", "init", "-q", nested]);
    expect(init.exitCode).toBe(0);
    await writeFile(join(nested, "file.txt"), "nested");
    // An embedded repository with an index is enough for Git's trailing-slash entry.
    expect(
      Bun.spawnSync(["git", "-C", nested, "add", "file.txt"]).exitCode,
    ).toBe(0);
    const key = await reviewSourceKey(directory);
    await writeFile(join(outside, "private.txt"), "second");
    expect(await reviewSourceKey(directory)).toBe(key);
    await rm(join(webRoot, "linkdir"));
    await symlink(tmpdir(), join(webRoot, "linkdir"));
    expect(await reviewSourceKey(directory)).not.toBe(key);
    await expect(
      buildReviewWeb({ ...options, signal: new AbortController().signal }),
    ).rejects.toThrow(options.log);
    expect(await Bun.file(options.log).text()).toContain(
      "link fixture reached Vite",
    );
    // Tracked children whose parent is replaced by a link are opaque too.
    await rm(join(webRoot, "linkdir"));
    await mkdir(join(webRoot, "parent"));
    await writeFile(join(webRoot, "parent/private.txt"), "tracked");
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        directory,
        "add",
        "apps/neuve-web/apps/web/parent",
      ]).exitCode,
    ).toBe(0);
    await rm(join(webRoot, "parent"), { recursive: true });
    await symlink(outside, join(webRoot, "parent"));
    const parentKey = await reviewSourceKey(directory);
    await writeFile(join(outside, "private.txt"), "third");
    expect(await reviewSourceKey(directory)).toBe(parentKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}, 60_000);

// Why: source-key failures must name the log just like compiler failures.
test("a source-key failure names the build log", async () => {
  const { directory, options } = await fixture();
  try {
    await expect(
      buildReviewWeb({
        ...options,
        source: join(directory, "missing"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(options.log);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

async function successfulFixture() {
  const result = await fixture();
  await writeFile(
    join(result.webRoot, "index.html"),
    '<script type="module" src="/entry.js"></script>',
  );
  await writeFile(
    join(result.webRoot, "entry.js"),
    'document.title = "fixture";',
  );
  await writeFile(
    join(result.webRoot, "vite.config.ts"),
    `export default {plugins:[{name:"server-entry-fixture",generateBundle(){this.emitFile({type:"asset",fileName:"server/server.js",source:'export default {fetch(){return new Response("fixture")}}'});this.emitFile({type:"asset",fileName:"client/late.txt",source:"retained asset"})}}]};`,
  );
  return result;
}

// Why: a lockfile update before install must not poison the post-install build cache.
test("a real build keys installed dependencies even when the lockfile is ahead", async () => {
  const { directory, webRoot, options } = await successfulFixture();
  const dependency = join(webRoot, "node_modules/cache-installed");
  const lifetime = new AbortController();
  try {
    await mkdir(dependency);
    await writeFile(
      join(webRoot, "package.json"),
      JSON.stringify({
        dependencies: { vite: "*", "cache-installed": "2.0.0" },
      }),
    );
    // Model a pull changing the lockfile to v2 while node_modules still contains v1.
    await writeFile(
      join(directory, "bun.lock"),
      '{"packages":{"cache-installed":["cache-installed@2.0.0"]}}',
    );
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "cache-installed",
        version: "1.0.0",
        main: "index.js",
      }),
    );
    await writeFile(
      join(dependency, "index.js"),
      'export default "INSTALLED_OLD_MARKER";',
    );
    await writeFile(
      join(webRoot, "entry.js"),
      'import value from "cache-installed"; document.title = value;',
    );
    const beforeInstall = await reviewSourceKey(directory);
    const first = await buildReviewWeb({
      ...options,
      lifetime: lifetime.signal,
      signal: AbortSignal.timeout(10000),
    });
    const contents = async (dist: string) =>
      (
        await Promise.all(
          (await readdir(join(dist, "assets")))
            .filter((name) => name.endsWith(".js"))
            .map((name) => Bun.file(join(dist, "assets", name)).text()),
        )
      ).join("\n");
    expect(await contents(first)).toContain("INSTALLED_OLD_MARKER");
    // Model bun install replacing the installed package without another lockfile edit.
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "cache-installed",
        version: "2.0.0",
        main: "index.js",
      }),
    );
    await writeFile(
      join(dependency, "index.js"),
      'export default "INSTALLED_NEW_MARKER";',
    );
    expect(await reviewSourceKey(directory)).not.toBe(beforeInstall);
    const second = await buildReviewWeb({
      ...options,
      signal: AbortSignal.timeout(10000),
    });
    expect(second).not.toBe(first);
    expect(await contents(second)).toContain("INSTALLED_NEW_MARKER");
    expect(await contents(second)).not.toContain("INSTALLED_OLD_MARKER");
  } finally {
    lifetime.abort();
    await rm(directory, { recursive: true, force: true });
  }
}, 25000);

// Why: dependency discovery must follow newly introduced workspace edges.
test("a newly added transitive workspace dependency enters the key", async () => {
  const { directory, webRoot } = await fixture();
  try {
    const schema = join(directory, "packages/records-schema");
    const added = join(directory, "packages/new-dependency");
    await mkdir(schema, { recursive: true });
    await mkdir(join(directory, "node_modules/@cache"), { recursive: true });
    await symlink(schema, join(directory, "node_modules/@cache/schema"));
    await writeFile(
      join(schema, "package.json"),
      JSON.stringify({ name: "@cache/schema" }),
    );
    await writeFile(
      join(webRoot, "package.json"),
      JSON.stringify({
        dependencies: { vite: "*", "@cache/schema": "workspace:*" },
      }),
    );
    const before = await reviewSourceKey(directory);
    await mkdir(added);
    await symlink(added, join(directory, "node_modules/@cache/added"));
    await writeFile(
      join(added, "package.json"),
      JSON.stringify({ name: "@cache/added" }),
    );
    await writeFile(join(added, "index.ts"), "export const added = true;");
    await writeFile(
      join(schema, "package.json"),
      JSON.stringify({
        name: "@cache/schema",
        dependencies: { "@cache/added": "workspace:*" },
      }),
    );
    const reached = await reviewSourceKey(directory);
    expect(reached).not.toBe(before);
    await writeFile(join(added, "index.ts"), "export const added = false;");
    expect(await reviewSourceKey(directory)).not.toBe(reached);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// Why: package exports may redirect package.json to a module marker with no dependency declarations.
test("an exported nested package.json cannot hide transitive installed dependencies", async () => {
  const { directory, webRoot } = await fixture();
  try {
    const dependency = join(webRoot, "node_modules/redirected-manifest");
    const transitive = join(dependency, "node_modules/transitive");
    await mkdir(join(dependency, "dist/esm"), { recursive: true });
    await mkdir(transitive, { recursive: true });
    await writeFile(
      join(webRoot, "package.json"),
      JSON.stringify({
        dependencies: { vite: "*", "redirected-manifest": "1.0.0" },
      }),
    );
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({
        name: "redirected-manifest",
        version: "1.0.0",
        exports: { "./*": "./dist/esm/*" },
        dependencies: { transitive: "1.0.0" },
      }),
    );
    await writeFile(
      join(dependency, "dist/esm/package.json"),
      '{"type":"module"}',
    );
    await writeFile(
      join(transitive, "package.json"),
      JSON.stringify({ name: "transitive", version: "1.0.0" }),
    );
    const before = await reviewSourceKey(directory);
    await writeFile(
      join(transitive, "package.json"),
      JSON.stringify({ name: "transitive", version: "2.0.0" }),
    );
    expect(await reviewSourceKey(directory)).not.toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// Process fixtures gate the real Vite compiler on pushed socket messages.
import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { hostBudget } from "../../../packages/harness/src/budget/local.ts";
import { z } from "zod";

const LauncherEvent = z.object({
  event: z.string(),
  path: z.string().optional(),
  message: z.string().optional(),
});
function notifications() {
  const listeners = new Set<() => void>();
  return {
    push() {
      for (const listener of listeners) listener();
    },
    until(predicate: () => boolean) {
      if (predicate()) return Promise.resolve();
      const expired = new Error("Process fixture event deadline");
      return new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          listeners.delete(inspect);
          reject(expired);
        }, 20000);
        const inspect = () => {
          if (predicate()) {
            clearTimeout(deadline);
            listeners.delete(inspect);
            resolve();
          }
        };
        listeners.add(inspect);
      });
    },
  };
}

async function sharedFixture(hosted = true, failing = false) {
  const fixture = await successfulFixture();
  const budget = await mkdtemp("/tmp/n123-");
  const host = hosted
    ? await hostBudget({ directory: budget, threads: 2, fixed: 4 })
    : undefined;
  if (hosted && !host) throw new Error("Missing test host");
  await host?.claims.ready;
  const options = {
    ...fixture.options,
    environment: {
      ...fixture.options.environment,
      NEUVE_BUDGET_DIRECTORY: budget,
    },
  };
  const notices = notifications();
  const requests: string[] = [];
  if (host) {
    const message = host.claims.message.bind(host.claims);
    host.claims.message = (connection, request) => {
      message(connection, request);
      if (request.kind === "claim") {
        requests.push(request.key);
        notices.push();
      }
    };
  }
  const compilers: {
    socket: Socket;
    pid: number;
    key: string;
    closed: boolean;
  }[] = [];
  const peers = new Set<Socket>();
  const gatePath = join(budget, "compiler.sock");
  const gate = createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => {
      peers.delete(socket);
      notices.push();
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (!text.includes("\n")) return;
      const event = z
        .object({ pid: z.number(), key: z.string() })
        .parse(JSON.parse(text.trim()));
      const compiler = { socket, ...event, closed: false };
      compilers.push(compiler);
      socket.once("close", () => {
        compiler.closed = true;
        notices.push();
      });
      notices.push();
    });
  });
  await new Promise<void>((resolve, reject) => {
    gate.once("error", reject);
    gate.listen(gatePath, resolve);
  });
  await writeFile(
    join(fixture.webRoot, "vite.config.ts"),
    `
    import {createConnection} from "node:net";
    import {openSync,closeSync,unlinkSync,appendFileSync} from "node:fs";
    import {dirname,basename,join} from "node:path";
    const config = process.argv[process.argv.indexOf("--config")+1];
    const key = basename(dirname(dirname(config)));
    const active = join(${JSON.stringify(fixture.directory)}, "active-"+key${hosted ? "" : '+"-"+process.pid'});
    closeSync(openSync(active,"wx"));
    process.on("exit",()=>{try{unlinkSync(active)}catch{}});
    process.on("SIGTERM",()=>process.exit(143));
    appendFileSync(${JSON.stringify(join(fixture.directory, "compiles"))}, key+"\\n");
    const peer=createConnection(${JSON.stringify(gatePath)});
    peer.on("error",()=>{});
    await new Promise((resolve,reject)=>{
      peer.once("connect",()=>peer.write(JSON.stringify({pid:process.pid,key})+"\\n"));
      peer.once("data",()=>resolve()); peer.once("error",reject);
    });
    peer.unref();
    ${failing ? 'throw new Error("recorded compiler failure fixture");' : ""}
    export default {plugins:[{name:"entry",generateBundle(){this.emitFile({type:"asset",fileName:"server/server.js",source:'export default {fetch(){return new Response("fixture")}}'});this.emitFile({type:"asset",fileName:"client/late.txt",source:"retained asset"})}}]};
  `,
  );
  const helper = resolve(import.meta.dir, "../src/workspace-review-build.ts");
  const children: {
    child: Bun.Subprocess;
    send: (command: string) => void;
    end: () => Promise<void>;
  }[] = [];
  function launcher(
    id: string,
    extra: Partial<Parameters<typeof buildReviewWeb>[0]> = {},
    workspace = false,
  ) {
    const events: z.infer<typeof LauncherEvent>[] = [];
    const changed = notifications();
    const buildScript = `
      import {buildReviewWeb} from ${JSON.stringify(helper)};
      const stop=new AbortController(), lifetime=new AbortController(), processStop=new AbortController();
      const emit=(event)=>process.stdout.write(JSON.stringify(event)+"\\n");
      const commands=(async()=>{for await(const chunk of process.stdin){
        for(const command of new TextDecoder().decode(chunk).trim().split("\\n")){
          if(command==="stop") {stop.abort();emit({event:"stopped"});}
          if(command==="end") {processStop.abort();lifetime.abort();stop.abort();emit({event:"ended"});return;}
        }
      }})();
      const open=()=>buildReviewWeb({...${JSON.stringify({ ...options, log: join(fixture.directory, `${id}.log`), ...extra })},signal:stop.signal,lifetime:lifetime.signal,processSignal:processStop.signal});
      try {
        const path=await open();
        emit({event:"result",path});
      } catch(error){emit({event:"error",message:error.message});}
      await commands;
    `;
    const source = resolve(import.meta.dir, "../../..");
    const workspaceScript = `
      import {spyOn} from "bun:test";
      import {writeFile} from "node:fs/promises";
      import * as storage from ${JSON.stringify(join(source, "scripts/pi-storage.ts"))};
      import * as build from ${JSON.stringify(helper)};
      const fixture=${JSON.stringify(fixture.directory)};
      const source=${JSON.stringify(source)};
      const volume={mountPoint:${JSON.stringify(existsSync(PI_TRANSITION_STORAGE_PROFILE.volume.mountPoint) ? PI_TRANSITION_STORAGE_PROFILE.volume.mountPoint : "/")},volumeUuid:"fixture-volume"};
      const paths={canonicalClone:source,worktrees:fixture+"/worktrees",state:fixture+"/state",captures:fixture+"/captures",cache:fixture+"/cache",bunCache:fixture+"/bun-cache",tmp:fixture+"/tmp",builds:fixture+"/builds"};
      const profile=fixture+"/profile.json";
      await writeFile(profile,JSON.stringify({volume,paths}));
      // DiskManagement is outside the sandbox. All path and Git validation remains real.
      const validate=storage.validateStorageProfile;
      spyOn(storage,"validateStorageProfile").mockImplementation((profile,options)=>validate(profile,{...options,probe:async()=>volume}));
      // Keep the real workspace lifecycle and compile a small, gated Vite application.
      const compile=build.buildReviewWeb;
      spyOn(build,"buildReviewWeb").mockImplementation(options=>compile({...options,...${JSON.stringify({ ...options, log: join(fixture.directory, `${id}.log`), ...extra })},repository:undefined,signal:options.signal,processSignal:options.processSignal,lifetime:options.lifetime}));
      const tailnet=await import(${JSON.stringify(join(source, "apps/neuve-host/src/tailnet.ts"))});
      spyOn(tailnet,"identity").mockReturnValue({});
      const {runWorkspaceCli}=await import(${JSON.stringify(join(source, "apps/neuve-cli/src/workspace-cli.ts"))});
      process.exitCode=await runWorkspaceCli(["--repo",fixture,"--profile",profile,"--user","fixture","--loopback","--port","0","--web-port","0"]);
    `;
    const script = workspace ? workspaceScript : buildScript;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        ...options.environment,
        NEUVE_BUDGET_DIRECTORY: budget,
        ACE_CONFIG_HOME: join(fixture.directory, "ace-settings"),
        XDG_CONFIG_HOME: join(fixture.directory, "config"),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const errors = new Response(child.stderr).text();
    const output = (async () => {
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += new TextDecoder().decode(chunk);
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          const ready = z
            .object({ "neuve-host": z.literal("ready"), web: z.string() })
            .safeParse(value);
          const parsed = LauncherEvent.safeParse(value);
          if (ready.success)
            events.push({ event: "ready", path: ready.data.web });
          else if (parsed.success) events.push(parsed.data);
          changed.push();
        }
      }
    })();
    const wait = async (name: string) => {
      await Promise.race([
        changed.until(() =>
          events.some(
            (event) =>
              event.event === name ||
              (name === "result" && event.event === "error"),
          ),
        ),
        child.exited.then(async (code) => {
          await output;
          if (!events.some((event) => event.event === name))
            throw new Error(`Launcher ${id} exited ${code}: ${await errors}`);
        }),
      ]);
      const event = events.find((event) => event.event === name);
      if (!event && name === "result") {
        const error = events.find((event) => event.event === "error");
        if (error) throw new Error(error.message);
      }
      if (!event) throw new Error(`Missing ${name}`);
      return event;
    };
    const send = (command: string) => {
      child.stdin.write(`${command}\n`);
      child.stdin.flush();
    };
    const result = {
      child,
      events,
      wait,
      send,
      log: join(fixture.directory, `${id}.log`),
      errors,
      end: async () => {
        if (child.exitCode === null) {
          if (workspace) child.kill("SIGTERM");
          else send("end");
        }
        await child.exited;
        await output;
      },
    };
    children.push(result);
    return result;
  }
  return {
    ...fixture,
    options,
    host,
    budget,
    compilers,
    launcher,
    compiled: (count: number) => notices.until(() => compilers.length >= count),
    closed: (index: number) =>
      notices.until(() => compilers[index]?.closed === true),
    requested: (key: string, count: number) => {
      const digest = createHash("sha256").update(key).digest("hex");
      return notices.until(
        () => requests.filter((request) => request === digest).length >= count,
      );
    },
    subscribed: async (count: number, base = options.base) => {
      const source = await reviewSourceKey(
        fixture.directory,
        options.environment,
      );
      const key = createHash("sha256")
        .update(source)
        .update(base)
        .digest("hex");
      const digest = createHash("sha256")
        .update(`review-build:${key}`)
        .digest("hex");
      await notices.until(
        () => requests.filter((request) => request === digest).length >= count,
      );
    },
    release: (index: number) => {
      const compiler = compilers[index];
      if (!compiler) throw new Error("Missing compiler");
      compiler.socket.write("finish\n");
    },
    close: async () => {
      for (const next of children)
        if (next.child.exitCode === null) next.send("stop");
      await Promise.all(children.map((next) => next.end()));
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => gate.close(() => resolve()));
      await host?.close();
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(budget, { recursive: true, force: true });
    },
  };
}

// Why: process-local sharing cannot prove twelve independent launchers compile once.
test("twelve launchers share one key and one real compiler", async () => {
  const fixture = await sharedFixture();
  try {
    await mkdir(fixture.options.builds, { recursive: true });
    const alias = join(fixture.directory, "build-alias");
    await symlink(fixture.options.builds, alias);
    const launchers = Array.from({ length: 12 }, (_, index) =>
      fixture.launcher(`launcher-${index}`, index % 2 ? { builds: alias } : {}),
    );
    await fixture.compiled(1);
    await fixture.subscribed(12);
    expect(fixture.compilers).toHaveLength(1);
    fixture.release(0);
    const paths = await Promise.all(
      launchers.map(async (next) => (await next.wait("result")).path),
    );
    expect(new Set(paths).size).toBe(1);
    expect(
      await Bun.file(join(paths[0] ?? "", "server/server.js")).exists(),
    ).toBe(true);
    expect(
      (await Bun.file(join(fixture.directory, "compiles")).text())
        .trim()
        .split("\n"),
    ).toHaveLength(1);
    const logs = await Promise.all(
      launchers.map((next) => Bun.file(next.log).text()),
    );
    expect(logs.filter((log) => log.includes('"role":"holder"'))).toHaveLength(
      1,
    );
    expect(logs.filter((log) => log.includes('"role":"waiter"'))).toHaveLength(
      11,
    );
  } finally {
    await fixture.close();
  }
}, 60000);

// Why: process death must transfer the claim to its first subscriber.
test("holder killed transfers to first waiter without overlapping compilers", async () => {
  const fixture = await sharedFixture();
  try {
    const owner = fixture.launcher("owner");
    await fixture.compiled(1);
    const first = fixture.launcher("first");
    await fixture.subscribed(2);
    const second = fixture.launcher("second");
    await fixture.subscribed(3);
    owner.child.kill("SIGKILL");
    await owner.child.exited;
    await fixture.closed(0);
    await fixture.compiled(2);
    expect(await Bun.file(first.log).text()).toContain('"role":"takeover"');
    expect(second.events).toEqual([]);
    fixture.release(1);
    expect((await first.wait("result")).path).toBe(
      (await second.wait("result")).path,
    );
    expect(fixture.compilers).toHaveLength(2);
    expect(
      (await readdir(join(fixture.options.builds, "workspace-web-v5"))).length,
    ).toBe(1);
    expect(
      await Array.fromAsync(
        new Bun.Glob("**/attempt-*").scan({
          cwd: fixture.options.builds,
          onlyFiles: false,
        }),
      ),
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 60000);

// Why: leaving a local subscription must preserve the helper's remaining remote demand.
test("cancelling one open preserves the compiler for remote waiters", async () => {
  const fixture = await sharedFixture();
  try {
    const owner = fixture.launcher("owner");
    await fixture.compiled(1);
    const waiter = fixture.launcher("waiter");
    await fixture.subscribed(2);
    owner.send("stop");
    fixture.release(0);
    await owner.wait("error");
    expect((await waiter.wait("result")).path).toContain("ready/dist");
    expect(fixture.compilers).toHaveLength(1);
    expect(await Bun.file(waiter.log).text()).not.toContain(
      '"role":"takeover"',
    );
  } finally {
    await fixture.close();
  }
}, 60000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // Why: workspace shutdown must drain pending opens without waiting for remote demand to finish.
  test(`a holder workspace stopping with ${signal} exits promptly and its remote waiter publishes`, async () => {
    const fixture = await sharedFixture();
    try {
      const owner = fixture.launcher("workspace", {}, true);
      const ready = await owner.wait("ready");
      const request = fetch(
        new URL(
          `/review/${createHash("sha256").update(fixture.directory).digest("hex")}/`,
          ready.path,
        ),
      ).catch(() => undefined);
      await fixture.compiled(1);
      const waiter = fixture.launcher("waiter");
      await fixture.subscribed(2);
      const before = performance.now();
      owner.child.kill(signal);
      const deadline = setTimeout(() => owner.child.kill("SIGKILL"), 5000);
      try {
        const code = await owner.child.exited;
        if (code !== 0)
          throw new Error(`Workspace exited ${code}: ${await owner.errors}`);
        expect(code).toBe(0);
        expect(performance.now() - before).toBeLessThan(5000);
      } finally {
        clearTimeout(deadline);
      }
      const compiler = fixture.compilers[0];
      if (!compiler) throw new Error("Missing holder compiler");
      expect(() => process.kill(compiler.pid, 0)).toThrow();
      await fixture.closed(0);
      await fixture.compiled(2);
      expect(await Bun.file(waiter.log).text()).toContain('"role":"takeover"');
      fixture.release(1);
      expect((await waiter.wait("result")).path).toContain("ready/dist");
      expect(fixture.compilers).toHaveLength(2);
      await request;
    } finally {
      await fixture.close();
    }
  }, 60000);
}

// Why: the first local caller owns its subscription, not the shared compiler's signal.
test("cancelling the first local subscriber preserves the second", async () => {
  const fixture = await sharedFixture();
  const firstStop = new AbortController();
  const secondStop = new AbortController();
  const log = join(fixture.directory, "second-local.log");
  await writeFile(log, "");
  const joined = Promise.withResolvers<void>();
  const original = SharedWork.prototype.run;
  const observing = spyOn(SharedWork.prototype, "run").mockImplementation(
    function (this: SharedWork<unknown, unknown>, options) {
      return original.call(this, {
        ...options,
        onEvent(event) {
          options.onEvent?.(event);
          if (options.signal === secondStop.signal && event.role === "waiter")
            joined.resolve();
        },
      });
    },
  );
  try {
    const first = buildReviewWeb({
      ...fixture.options,
      signal: firstStop.signal,
    }).catch((error: unknown) => error);
    await fixture.compiled(1);
    const second = buildReviewWeb({
      ...fixture.options,
      log,
      signal: secondStop.signal,
    });
    await joined.promise;
    observing.mockRestore();
    firstStop.abort(new Error("first subscriber left"));
    fixture.release(0);
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toContain("ready/dist");
    expect(fixture.compilers).toHaveLength(1);
  } finally {
    observing.mockRestore();
    firstStop.abort();
    secondStop.abort();
    await fixture.close();
  }
}, 60000);

// Why: each subscriber must receive the failed attempt's message and log, and retry is a new open.
test("recorded failure reaches every waiter and a later launcher retries", async () => {
  const fixture = await sharedFixture(true, true);
  try {
    const owner = fixture.launcher("owner");
    await fixture.compiled(1);
    const waiters = [
      fixture.launcher("waiter-1"),
      fixture.launcher("waiter-2"),
    ];
    await fixture.subscribed(3);
    fixture.release(0);
    for (const next of [owner, ...waiters]) {
      const error = await next.wait("error");
      expect(error.message).toContain("Review app build exited 1");
      expect(error.message).toContain(owner.log);
    }
    expect(fixture.compilers).toHaveLength(1);
    expect(await Bun.file(owner.log).text()).toContain(
      "recorded compiler failure fixture",
    );
    const retry = fixture.launcher("retry");
    await fixture.compiled(2);
    fixture.release(1);
    expect((await retry.wait("error")).message).toContain(
      "Review app build exited 1",
    );
    expect(fixture.compilers).toHaveLength(2);
  } finally {
    await fixture.close();
  }
}, 60000);

// Why: different source keys for one project must run concurrently rather than queue by project.
test("different keys of one project build concurrently", async () => {
  const fixture = await sharedFixture();
  try {
    const first = fixture.launcher("first");
    await fixture.compiled(1);
    await writeFile(
      join(fixture.webRoot, "entry.js"),
      'document.title="changed";',
    );
    const second = fixture.launcher("second");
    await fixture.compiled(2);
    expect(fixture.compilers[0]?.closed).toBe(false);
    expect(fixture.compilers[0]?.key).not.toBe(fixture.compilers[1]?.key);
    fixture.release(0);
    fixture.release(1);
    expect((await first.wait("error")).message).toContain(
      "Review sources changed",
    );
    expect((await second.wait("result")).path).toContain("ready/dist");
  } finally {
    await fixture.close();
  }
}, 60000);

// Why: a departing subscriber owns only its subscription, not the holder or remaining waiter.
test("a stopping waiter leaves the holder and another waiter running", async () => {
  const fixture = await sharedFixture();
  try {
    const owner = fixture.launcher("owner");
    await fixture.compiled(1);
    const leaving = fixture.launcher("leaving");
    await fixture.subscribed(2);
    const staying = fixture.launcher("staying");
    await fixture.subscribed(3);
    leaving.send("stop");
    await leaving.wait("error");
    expect(fixture.compilers).toHaveLength(1);
    fixture.release(0);
    expect((await owner.wait("result")).path).toBe(
      (await staying.wait("result")).path,
    );
  } finally {
    await fixture.close();
  }
}, 60000);

for (const end of ["ended", "killed"] as const) {
  // Why: pins follow the serving connection, and pruning must leave older floor layouts alone.
  test(`a pinned build survives pruning until its launcher is ${end}`, async () => {
    const fixture = await sharedFixture();
    try {
      const first = fixture.launcher("first");
      await fixture.compiled(1);
      fixture.release(0);
      const path = (await first.wait("result")).path ?? "";
      const legacy = join(
        fixture.options.builds,
        "workspace-web/legacy/ready/asset",
      );
      await mkdir(dirname(legacy), { recursive: true });
      await writeFile(legacy, "pre-host publication");
      const v4 = join(
        fixture.options.builds,
        "workspace-web-v4",
        createHash("sha256").update(fixture.options.base).digest("hex"),
        "legacy/ready/asset",
      );
      await mkdir(dirname(v4), { recursive: true });
      await writeFile(v4, "v4 floor publication");
      await writeFile(
        join(fixture.webRoot, "entry.js"),
        'document.title="second";',
      );
      const second = fixture.launcher("second");
      await fixture.compiled(2);
      fixture.release(1);
      await second.wait("result");
      expect(await Bun.file(join(path, "client/late.txt")).text()).toBe(
        "retained asset",
      );
      if (end === "ended") await first.end();
      else {
        first.child.kill("SIGKILL");
        await first.child.exited;
      }
      const third = fixture.launcher("third");
      await third.wait("result");
      expect(await Bun.file(join(path, "server/server.js")).exists()).toBe(
        false,
      );
      expect(fixture.compilers).toHaveLength(2);
      expect(await Bun.file(legacy).text()).toBe("pre-host publication");
      expect(await Bun.file(v4).text()).toBe("v4 floor publication");
    } finally {
      await fixture.close();
    }
  }, 60000);
}

// Why: without a host, undiscoverable pins must never be pruned and duplicate work must be disclosed.
test("an unreachable host builds at the disclosed floor without pruning", async () => {
  const fixture = await sharedFixture(false);
  try {
    const first = fixture.launcher("floor");
    await fixture.compiled(1);
    fixture.release(0);
    const path = (await first.wait("result")).path ?? "";
    await writeFile(
      join(fixture.webRoot, "entry.js"),
      'document.title="floor-two";',
    );
    const second = fixture.launcher("floor-two");
    await fixture.compiled(2);
    fixture.release(1);
    await second.wait("result");
    const log = await Bun.file(second.log).text();
    expect(log).toContain('"role":"floor","floor":"unreachable"');
    expect(log).toContain('"pruning":"skipped","reason":"floor"');
    expect(await Bun.file(join(path, "server/server.js")).exists()).toBe(true);
  } finally {
    await fixture.close();
  }
}, 60000);

// Why: a real starter returns before its worker elects the budget host on a cold open.
test("a cold open claims through the repository worker it starts", async () => {
  const fixture = await sharedFixture(false);
  try {
    const owner = fixture.launcher("cold-owner", {
      repository: fixture.directory,
    });
    await fixture.compiled(1);
    fixture.release(0);
    expect((await owner.wait("result")).path).toContain("ready/dist");
    const log = await Bun.file(owner.log).text();
    expect(log).toContain('"worker":"spawned"');
    expect(log).toContain('"role":"holder"');
    expect(log).not.toContain('"role":"floor"');
    await owner.end();
  } finally {
    try {
      const stop = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--no-macros",
          "--no-install",
          resolve(import.meta.dir, "../src/cli.ts"),
          "worker",
          "stop",
          "--repo",
          fixture.directory,
        ],
        {
          env: { ...process.env, ...fixture.options.environment },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = new Response(stop.stdout).text();
      const error = new Response(stop.stderr).text();
      expect(await stop.exited).toBe(0);
      expect(await output).toContain("Worker stopped.");
      expect(await error).toBe("");
    } finally {
      await fixture.close();
    }
  }
}, 60000);

for (const end of ["alive", "killed", "ended"] as const) {
  // Why: host discovery and pruning must preserve floor assets until their serving lifetime ends.
  test(`a floor publication survives a later hosted pruner while launcher is ${end}`, async () => {
    const fixture = await sharedFixture(false);
    let host: Awaited<ReturnType<typeof hostBudget>>;
    try {
      const owner = fixture.launcher("floor-owner");
      await fixture.compiled(1);
      fixture.release(0);
      const path = (await owner.wait("result")).path ?? "";
      expect(path).toContain("workspace-web-v5/floor/launcher-");
      if (end === "killed") {
        owner.child.kill("SIGKILL");
        await owner.child.exited;
      } else if (end === "ended") await owner.end();
      else {
        owner.send("stop");
        await owner.wait("stopped");
      }
      host = await hostBudget({
        directory: fixture.budget,
        threads: 2,
        fixed: 4,
      });
      await host?.claims.ready;
      await writeFile(
        join(fixture.webRoot, "entry.js"),
        'document.title="hosted";',
      );
      const pruner = fixture.launcher("hosted");
      await fixture.compiled(2);
      fixture.release(1);
      await pruner.wait("result");
      expect(await Bun.file(join(path, "client/late.txt")).exists()).toBe(
        end !== "ended",
      );
      expect(await Bun.file(owner.log).text()).toContain(
        '"crash":"may-retain-directory"',
      );
    } finally {
      await fixture.close();
      await host?.close();
    }
  }, 60000);
}

// Why: floor launchers own their output separately so neither pruning nor another launcher can remove it.
test("two floor launchers racing on one key keep separate complete publications", async () => {
  const fixture = await sharedFixture(false);
  try {
    const first = fixture.launcher("floor-first");
    await fixture.compiled(1);
    const second = fixture.launcher("floor-second");
    await fixture.compiled(2);
    expect(fixture.compilers[0]?.key).not.toBe(fixture.compilers[1]?.key);
    expect(fixture.compilers[0]?.closed).toBe(false);
    fixture.release(0);
    const path = (await first.wait("result")).path ?? "";
    const complete = Bun.file(resolve(path, "../complete"));
    const before = await complete.stat();
    const bytes = await complete.text();
    fixture.release(1);
    const secondPath = (await second.wait("result")).path ?? "";
    expect(secondPath).not.toBe(path);
    expect(
      await Bun.file(join(secondPath, "server/server.js")).text(),
    ).toContain("fixture");
    expect((await complete.stat()).mtimeMs).toBe(before.mtimeMs);
    expect(await complete.text()).toBe(bytes);
    expect(await Bun.file(join(path, "server/server.js")).exists()).toBe(true);
    expect(
      await Array.fromAsync(
        new Bun.Glob("**/complete").scan(fixture.options.builds),
      ),
    ).toHaveLength(2);
    expect(
      await Array.fromAsync(
        new Bun.Glob("**/attempt-*").scan({
          cwd: fixture.options.builds,
          onlyFiles: false,
        }),
      ),
    ).toEqual([]);
    expect(await Bun.file(second.log).text()).toContain('"role":"floor"');
  } finally {
    await fixture.close();
  }
}, 60000);

// Why: an unsuccessful atomic publication must close without waking waiters with a result.
test("a failed publication transfers the claim instead of settling", async () => {
  const fixture = await sharedFixture();
  try {
    const owner = fixture.launcher("owner");
    await fixture.compiled(1);
    const waiter = fixture.launcher("waiter");
    await fixture.subscribed(2);
    const project = join(
      fixture.options.builds,
      "workspace-web-v5",
      createHash("sha256").update(fixture.options.base).digest("hex"),
    );
    const keyDirectory = join(project, fixture.compilers[0]?.key ?? "missing");
    const ready = join(keyDirectory, "ready");
    // A nonempty destination makes the actual rename fail, including under root.
    await mkdir(ready);
    await writeFile(join(ready, "blocker"), "publication fixture");
    fixture.release(0);
    expect((await owner.wait("error")).message).toContain(
      "Cannot publish review build",
    );
    expect(
      await Array.fromAsync(
        new Bun.Glob("**/outcome-*.json").scan(fixture.options.builds),
      ),
    ).toEqual([]);
    // Takeover clears unpublished output. Remove the artificial external obstacle.
    await rm(ready, { recursive: true, force: true });
    await fixture.compiled(2);
    expect(await Bun.file(waiter.log).text()).toContain('"role":"takeover"');
    fixture.release(1);
    expect((await waiter.wait("result")).path).toContain("ready/dist");
    expect(fixture.compilers).toHaveLength(2);
  } finally {
    await fixture.close();
  }
}, 60000);

if (process.platform === "darwin") {
  // Why: a real deletion error must leave the desk open and still prune other obsolete builds.
  test("pruning an immutable old build fails without stopping open or other cleanup", async () => {
    const fixture = await sharedFixture();
    let locked: string | undefined;
    try {
      const first = fixture.launcher("first");
      await fixture.compiled(1);
      fixture.release(0);
      const path = (await first.wait("result")).path ?? "";
      const project = resolve(path, "../../..");
      locked = join(project, "old/ready/locked");
      await mkdir(dirname(locked), { recursive: true });
      await writeFile(locked, "immutable fixture");
      expect(Bun.spawnSync(["chflags", "uchg", locked]).exitCode).toBe(0);
      await mkdir(join(project, "removable"));
      const second = fixture.launcher("second");
      expect((await second.wait("result")).path).toBe(path);
      expect(await Bun.file(locked).text()).toBe("immutable fixture");
      expect(await readdir(project)).not.toContain("removable");
      await second.end();
      expect(await second.errors).toContain("Cannot prune review build");
    } finally {
      if (locked) Bun.spawnSync(["chflags", "nouchg", locked]);
      await fixture.close();
    }
  }, 60000);
}

if (process.getuid?.() !== 0) {
  // Why: a project directory that cannot be listed must not turn cache reuse into a failed open.
  test("a project-level prune read failure preserves the published desk", async () => {
    const fixture = await sharedFixture();
    let project: string | undefined;
    try {
      const first = fixture.launcher("first");
      await fixture.compiled(1);
      fixture.release(0);
      const path = (await first.wait("result")).path ?? "";
      project = resolve(path, "../../..");
      await chmod(project, 0o300);
      const second = fixture.launcher("second");
      expect((await second.wait("result")).path).toBe(path);
      await second.end();
      expect(await second.errors).toContain("Cannot prune review build");
      expect(await second.errors).toContain("EACCES");
    } finally {
      if (project) await chmod(project, 0o700);
      await fixture.close();
    }
  }, 60000);
}

// Why: a pin arriving during deletion must wait until pruning ends, then rebuild the removed output.
test("pin registration waits for an in-progress prune before reading ready", async () => {
  const fixture = await sharedFixture();
  const deleting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const first = fixture.launcher("first");
    await fixture.compiled(1);
    fixture.release(0);
    const path = (await first.wait("result")).path ?? "";
    await first.end();
    const directory = resolve(path, "../..");
    const key = createHash("sha256").update(`pin:${directory}`).digest("hex");
    if (!fixture.host) throw new Error("Missing real host");
    const message = fixture.host.claims.message.bind(fixture.host.claims);
    fixture.host.claims.message = (connection, request) => {
      if (
        request.kind === "claim" &&
        request.key === key &&
        request.insideGrant
      ) {
        const write = connection.write.bind(connection);
        connection.write = (line) => {
          const reply = z.object({ kind: z.string() }).parse(JSON.parse(line));
          if (reply.kind === "claimed") {
            // Delay delivery of the real host reply, after it owns both deletion claims.
            deleting.resolve();
            void release.promise.then(() => write(line));
            return;
          }
          return write(line);
        };
      }
      message(connection, request);
    };
    await writeFile(
      join(fixture.webRoot, "entry.js"),
      'document.title="newer";',
    );
    const newer = fixture.launcher("newer");
    await fixture.compiled(2);
    fixture.release(1);
    await deleting.promise;
    await writeFile(
      join(fixture.webRoot, "entry.js"),
      'document.title = "fixture";',
    );
    const returning = fixture.launcher("returning");
    await fixture.requested(`pin-change:${directory}`, 3);
    expect(returning.events).toEqual([]);
    expect(fixture.compilers).toHaveLength(2);
    release.resolve();
    await newer.wait("result");
    await fixture.compiled(3);
    expect(await Bun.file(join(path, "server/server.js")).exists()).toBe(false);
    fixture.release(2);
    expect((await returning.wait("result")).path).toBe(path);
    expect(await Bun.file(join(path, "server/server.js")).exists()).toBe(true);
  } finally {
    release.resolve();
    await fixture.close();
  }
}, 60000);

import * as filesystem from "node:fs/promises";
import { announcedChild, closeChild } from "../src/workspace-child.ts";
// Why: a hosted prune already committed to deletion must not remove a floor server's assets.
test("review probe: floor pin arriving after the pruning check preserves serving assets", async () => {
  const f = await successfulFixture();
  const budget = await mkdtemp("/tmp/n123-marker-");
  const host = await hostBudget({ directory: budget, threads: 2, fixed: 4 });
  await host?.claims.ready;
  const options = {
    ...f.options,
    environment: { ...f.options.environment, NEUVE_BUDGET_DIRECTORY: budget },
  };
  const lifetime = new AbortController();
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const original = filesystem.rm;
  let target = "",
    held = false;
  const intercepted = spyOn(filesystem, "rm").mockImplementation(
    async (path, options) => {
      if (String(path) === target && !held) {
        held = true;
        reached.resolve();
        await resume.promise;
      }
      return original(path, options);
    },
  );
  let pruner;
  let server;
  try {
    const initial = await buildReviewWeb({
      ...options,
      signal: new AbortController().signal,
    });
    target = resolve(initial, "../..");
    await writeFile(join(f.webRoot, "entry.js"), 'document.title="newer";');
    pruner = buildReviewWeb({
      ...options,
      signal: new AbortController().signal,
    });
    await reached.promise;
    await writeFile(join(f.webRoot, "entry.js"), 'document.title = "fixture";');
    // Make new connections fail while the pruner retains its established claims.
    await chmod(join(budget, "budget.sock"), 0o000);
    const serving = await buildReviewWeb({
      ...options,
      signal: new AbortController().signal,
      lifetime: lifetime.signal,
    });
    expect(serving).not.toBe(initial);
    expect(serving).toContain("workspace-web-v5/floor/launcher-");
    const sourceStat = await filesystem.stat(join(initial, "client/late.txt"));
    const floorStat = await filesystem.stat(join(serving, "client/late.txt"));
    expect(floorStat.ino).toBe(sourceStat.ino);
    expect(floorStat.nlink).toBeGreaterThanOrEqual(2);
    expect(await Bun.file(join(serving, "client/late.txt")).exists()).toBe(
      true,
    );
    server = await announcedChild({
      command: [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../../neuve-web/apps/web/serve.ts"),
        serving,
      ],
      cwd: f.directory,
      env: { ...options.environment, NEUVE_REVIEW_BASE: options.base },
      base: options.base,
      log: join(f.directory, "server.log"),
      signal: lifetime.signal,
    });
    const assetBefore = await (await fetch(server.url + "late.txt")).text();
    expect(assetBefore).toBe("retained asset");
    await chmod(join(budget, "budget.sock"), 0o600);
    resume.resolve();
    await pruner;
    const retained = await Bun.file(join(serving, "client/late.txt")).exists();
    expect(retained).toBe(true);
    expect(await Bun.file(join(initial, "client/late.txt")).exists()).toBe(
      false,
    );
    expect(server.child.exitCode).toBe(null);
    expect(lifetime.signal.aborted).toBe(false);
    expect(await (await fetch(server.url + "late.txt")).text()).toBe(
      "retained asset",
    );
  } finally {
    resume.resolve();
    await pruner?.catch(() => {});
    intercepted.mockRestore();
    if (server) await closeChild(server.child);
    lifetime.abort();
    await chmod(join(budget, "budget.sock"), 0o600).catch(() => {});
    await host?.close();
    await rm(budget, { recursive: true, force: true });
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60000);

// Why: pruning can remove an asset before enumeration while leaving the completion marker intact.
test("a publication missing an inventoried file builds privately before serving", async () => {
  const fixture = await successfulFixture();
  const budget = await mkdtemp("/tmp/n123-inventory-");
  const host = await hostBudget({ directory: budget, threads: 2, fixed: 4 });
  await host?.claims.ready;
  const options = {
    ...fixture.options,
    environment: {
      ...fixture.options.environment,
      NEUVE_BUDGET_DIRECTORY: budget,
    },
    signal: new AbortController().signal,
  };
  const lifetime = new AbortController();
  let server;
  try {
    const shared = await buildReviewWeb(options);
    const inventory = JSON.parse(
      await Bun.file(resolve(shared, "../files.json")).text(),
    );
    expect(inventory).toEqual(
      (
        await Array.fromAsync(
          new Bun.Glob("dist/**/*").scan({
            cwd: resolve(shared, ".."),
            onlyFiles: true,
          }),
        )
      ).sort(),
    );
    expect(inventory).toContain("dist/client/late.txt");
    await rm(join(shared, "client/late.txt"));
    expect(await Bun.file(resolve(shared, "../complete")).exists()).toBe(true);
    const serving = await buildReviewWeb({
      ...options,
      environment: {
        ...options.environment,
        NEUVE_BUDGET_DIRECTORY: join(budget, "absent"),
      },
      lifetime: lifetime.signal,
    });
    expect(serving).not.toBe(shared);
    expect(await Bun.file(join(serving, "client/late.txt")).text()).toBe(
      "retained asset",
    );
    expect(await Bun.file(options.log).text()).toContain(
      '"floorOutput":"build"',
    );
    expect(await readdir(resolve(serving, "../.."))).toEqual(["ready"]);
    server = await announcedChild({
      command: [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../../neuve-web/apps/web/serve.ts"),
        serving,
      ],
      cwd: fixture.directory,
      env: { ...options.environment, NEUVE_REVIEW_BASE: options.base },
      base: options.base,
      log: join(fixture.directory, "server.log"),
      signal: lifetime.signal,
    });
    const response = await fetch(server.url + "late.txt");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("retained asset");
  } finally {
    if (server) await closeChild(server.child);
    lifetime.abort();
    await host?.close();
    await rm(budget, { recursive: true, force: true });
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 60000);

for (const code of ["ENOENT", "EXDEV", "EPERM", "ENOTSUP"]) {
  // Why: a pruned source or unavailable hard links must produce a complete private build.
  test(`a floor copy interrupted by ${code} builds privately and cleans up on server exit`, async () => {
    const fixture = await successfulFixture();
    const budget = await mkdtemp("/tmp/n123-link-");
    const host = await hostBudget({ directory: budget, threads: 2, fixed: 4 });
    await host?.claims.ready;
    const options = {
      ...fixture.options,
      environment: {
        ...fixture.options.environment,
        NEUVE_BUDGET_DIRECTORY: budget,
      },
    };
    const lifetime = new AbortController();
    const original = filesystem.link;
    let count = 0;
    let unlink: ReturnType<typeof spyOn> | undefined;
    try {
      const shared = await buildReviewWeb({
        ...options,
        signal: new AbortController().signal,
      });

      unlink = spyOn(filesystem, "link").mockImplementation(
        async (source, destination) => {
          if (++count === 2)
            throw Object.assign(new Error("link fixture"), { code });
          return original(source, destination);
        },
      );
      const privatePath = await buildReviewWeb({
        ...options,
        environment: {
          ...options.environment,
          NEUVE_BUDGET_DIRECTORY: join(budget, "absent"),
        },
        signal: new AbortController().signal,
        lifetime: lifetime.signal,
      });
      unlink.mockRestore();
      expect(count).toBe(2);
      expect(privatePath).toContain("workspace-web-v5/floor/launcher-");
      expect(await Bun.file(join(privatePath, "client/late.txt")).text()).toBe(
        "retained asset",
      );
      expect(
        await Bun.file(join(privatePath, "server/server.js")).text(),
      ).toContain("fixture");
      expect(
        (await filesystem.stat(join(privatePath, "client/late.txt"))).ino,
      ).not.toBe((await filesystem.stat(join(shared, "client/late.txt"))).ino);
      expect(
        await Bun.file(resolve(privatePath, "../complete")).text(),
      ).toHaveLength(64);
      const removed = Promise.withResolvers<void>();
      const remove = filesystem.rm;
      const observing = spyOn(filesystem, "rm").mockImplementation(
        async (path, options) => {
          await remove(path, options);
          if (String(path) === resolve(privatePath, "../..")) removed.resolve();
        },
      );
      try {
        lifetime.abort();
        await removed.promise;
        expect(
          await Bun.file(join(privatePath, "server/server.js")).exists(),
        ).toBe(false);
        expect(await Bun.file(join(shared, "client/late.txt")).text()).toBe(
          "retained asset",
        );
      } finally {
        observing.mockRestore();
      }
    } finally {
      unlink?.mockRestore();
      lifetime.abort();
      await chmod(join(budget, "budget.sock"), 0o600).catch(() => {});
      await host?.close();
      await rm(budget, { recursive: true, force: true });
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }, 60000);
}
