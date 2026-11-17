import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// Why: native, cached and fallback harness reads must never ask a real promisor for missing blobs.
for (const partial of [false, true])
  for (const supported of [false, true]) {
    test(`harness stays offline in a ${partial ? "partial" : "full"} clone with ${supported ? "supported" : "old"} Git`, async () => {
      const root = mkdtempSync(join(tmpdir(), "harness-offline-"));
      roots.push(root);
      const source = join(root, "source");
      mkdirSync(source);
      const executable = Bun.which("git");
      if (!executable) throw new Error("Git unavailable");
      const command = (repository: string, ...args: string[]) => {
        const result = Bun.spawnSync([executable, "-C", repository, ...args]);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      };
      command(source, "init", "-q");
      writeFileSync(join(source, "file"), "offline content\n");
      command(source, "add", "file");
      command(
        source,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-qm",
        "fixture",
      );
      const commit = command(source, "rev-parse", "HEAD");
      const oid = command(source, "rev-parse", "HEAD:file");
      const remoteLog = join(root, "remote.log");
      writeFileSync(remoteLog, "");
      let repository = source;
      if (partial) {
        command(source, "config", "uploadpack.allowFilter", "true");
        const uploadpack = join(root, "uploadpack");
        writeFileSync(
          uploadpack,
          `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(remoteLog)}, "invoked\\n");
process.exit(Bun.spawnSync([${JSON.stringify(executable)}, "upload-pack", ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode);
`,
          { mode: 0o755 },
        );
        const clone = (name: string) => {
          const destination = join(root, name);
          command(
            source,
            "clone",
            "--quiet",
            "--no-checkout",
            "--filter=blob:none",
            `file://${source}`,
            destination,
          );
          command(
            destination,
            "config",
            "remote.origin.uploadpack",
            "'" + uploadpack.replaceAll("'", "'\\''") + "'",
          );
          return destination;
        };
        repository = clone("partial");
        // A separate clone proves the remote sentinel observes a real lazy fetch.
        const control = clone("control");
        command(control, "cat-file", "-e", oid);
        expect(readFileSync(remoteLog, "utf8")).toBe("invoked\n");
        writeFileSync(remoteLog, "");
        expect(
          Bun.spawnSync([
            executable,
            "--no-lazy-fetch",
            "-C",
            repository,
            "cat-file",
            "-e",
            oid,
          ]).exitCode,
        ).not.toBe(0);
      }
      const tools = join(root, "tools");
      mkdirSync(tools);
      const selectedGit = join(tools, "git");
      writeFileSync(
        selectedGit,
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--no-lazy-fetch") && !${supported}) process.exit(129);
if (args.at(-1) === "version") { console.log("git version 2.39.5 (Apple Git-154)"); process.exit(0); }
process.exit(Bun.spawnSync([${JSON.stringify(executable)}, ...args], { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode);
`,
        { mode: 0o755 },
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--eval",
          `
      import { Effect } from "effect";
      import { git, gitMeasured, gitWithInput } from "./src/git.ts";
      import { lsTree, readBlobs } from "./src/git-objects.ts";
      import { blobSizes } from "./src/hunks.ts";
      import { withGitReadSnapshot } from "./src/git-read-snapshot.ts";
      const repository = ${JSON.stringify(repository)}, oid = ${JSON.stringify(oid)}, commit = ${JSON.stringify(commit)};
      const reads = [];
      const original = Bun.spawn;
      Bun.spawn = new Proxy(original, { apply(target, self, args) {
        if (args[0].some(a => ["cat-file", "ls-tree", "show", "grep"].includes(a))) reads.push({
          executable: args[0][0], flag: args[0].includes("--no-lazy-fetch"),
          configKey: args[1]?.env?.GIT_CONFIG_KEY_0, noLazyFetch: args[1]?.env?.GIT_NO_LAZY_FETCH,
        });
        return Reflect.apply(target, self, args);
      }});
      const flow = Effect.gen(function* () {
        const results = [];
        for (const op of [
          lsTree(repository, commit), blobSizes(repository, [oid]), readBlobs(repository, [oid]),
          gitMeasured(repository, ["show", oid]), gitMeasured(repository, ["show", oid], { ...process.env }),
          gitWithInput(repository, ["cat-file", "--batch-check"], oid + "\\n"),
          git(repository, ["grep", "-F", "offline", commit]),
        ]) results.push(yield* op.pipe(Effect.match({
          onFailure: error => ({ error: error.message }),
          onSuccess: value => ({ size: value instanceof Map ? value.size : undefined }),
        })));
        return results;
      });
      const unscoped = await Effect.runPromise(flow);
      const scoped = await Effect.runPromise(withGitReadSnapshot(repository, 1024 * 1024)(flow));
      const foreign = await Effect.runPromise(withGitReadSnapshot(${JSON.stringify(partial ? source : root)}, 1024 * 1024)(flow));
      const expired = await Effect.runPromise(withGitReadSnapshot(repository, 1024 * 1024)(Effect.context()));
      const closed = await Effect.runPromiseWith(expired)(flow);
      console.log(JSON.stringify({ unscoped, scoped, foreign, closed, reads }));
    `,
        ],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            PATH: tools + ":" + process.env.PATH,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "remote.origin.promisor",
            GIT_CONFIG_VALUE_0: "false",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      const result = JSON.parse(stdout);
      if (partial && !supported) {
        expect(result.reads).toEqual([]);
        for (const flow of [
          result.unscoped,
          result.scoped,
          result.foreign,
          result.closed,
        ])
          for (const outcome of flow) {
            expect(outcome.error).toContain("git version 2.39.5");
            expect(outcome.error).toContain(
              "this repository is a partial clone",
            );
            expect(outcome.error).toContain("brew install git");
          }
      } else {
        for (const flow of [
          result.unscoped,
          result.scoped,
          result.foreign,
          result.closed,
        ]) {
          expect(flow[1]).toEqual({ size: partial ? 0 : 1 });
          expect(flow[2]).toEqual({ size: partial ? 0 : 1 });
          if (!partial)
            for (const outcome of flow) expect(outcome.error).toBeUndefined();
        }
        expect(result.reads.length).toBeGreaterThan(15);
        for (const read of result.reads)
          expect(read).toEqual({
            executable: selectedGit,
            flag: partial,
            configKey: "core.fsmonitor",
            noLazyFetch: "1",
          });
      }
      expect(readFileSync(remoteLog, "utf8")).toBe("");
      if (partial)
        expect(
          Bun.spawnSync([
            executable,
            "--no-lazy-fetch",
            "-C",
            repository,
            "cat-file",
            "-e",
            oid,
          ]).exitCode,
        ).not.toBe(0);
    }, 60000);
  }
